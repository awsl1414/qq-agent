// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 托盘常驻、关窗不退出、可选开机自启。
// dialog 只用于 showOpenDialog（选文件等用户主动触发、带父窗口的框）。
// 原生消息框一律走 ./dialog-safe.js 的 showDialog（挂父窗口 + 超时自消）。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog, ipcMain } from 'electron';
// webUtils 绝不能走具名导入：ESM 的具名导入在导出名不存在时是 SyntaxError，
// 整个 main.js 会加载失败，主进程起不来，双击 exe 毫无反应。改成 namespace 导入，
// 缺失时是 undefined，下面再运行时兜底。
import * as electronApi from 'electron';
const webUtils = electronApi.webUtils ?? electronApi.default?.webUtils ?? null;
// screen 同样走命名空间取，理由与 webUtils 一样：具名导入缺失即 SyntaxError。
const screenApi = electronApi.screen ?? electronApi.default?.screen ?? null;
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDirName, describeInstance } from '../src/profile.js';
// 桌宠宿主：透明置顶窗口 / 截图 / 托盘外菜单都在它里面。纯 Node 环境下不会被加载。
import { createDesktopPetHost } from './desktop-pet.js';
// 外链白名单：只用 /^https?:\/\// 判前缀时，`https://evil.com@kondius.cn` 这种
// userinfo 混淆能直接开出去，`file:///C:/x.exe` 更是"直接执行"而非"打开网页"。
// 判据收在 external-link.js 里做成纯函数，就为了这一处能单独跑测试。
import { checkExternalUrl, DEFAULT_ALLOW_HOSTS } from './external-link.js';
import { showDialog, DIALOG_TIMEOUT } from './dialog-safe.js';
// 导出名必须与 crash-dumps.js 完全一致（`pruneCrashDumps`）。写成别名时
// `node --check` 只查语法、查不出"具名导出不存在"这种链接期错误，结果是应用启动即崩。
// 改了跨文件具名导入，必须真跑一次实例。
import { pruneCrashDumps as pruneCrashDumpsImpl, CRASH_DUMP_KEEP } from './crash-dumps.js';
// 窗口几何存档的解析与屏幕可见性校验（纯函数，见 test/window-state-test.mjs）
import {
  parseWindowState, resolveWindowBounds,
  WINDOW_DEFAULT_W, WINDOW_DEFAULT_H, WINDOW_MIN_W, WINDOW_MIN_H
} from './window-state.js';

// 显示名由 productName 决定；内部应用名与存储路径固定，避免改显示名时数据目录漂移。
// 必须在 RENDER_DATA_DIR 等首次读取 userData 之前显式设置，不能依赖默认路径的推导时机。
app.setName('qq-agent');
app.setPath('userData', path.join(app.getPath('appData'), 'qq-agent'));

// ── 数据目录推导（三处共用，见函数注释）────────────────────────────────
function isPortableInstall() {
  // 便携语义只存在于 Windows 的 zip 分发：macOS 的 .app 与 Linux 的 AppImage
  // 都没有"解压到任意目录就能跑"这种形态，把它们判成便携版会让数据落进
  // 只读的 .app 包内或只读的 squashfs 挂载点，启动即失败。
  if (process.platform !== 'win32') return false;
  const exeDir = path.dirname(app.getPath('exe'));
  // NSIS 安装版带卸载器，zip 便携版没有。文件名取打包显示名 QQ Agent，
  // 不能用已钉死为 qq-agent 的 app.getName()，否则安装版会被误判成便携版。
  return !fs.existsSync(path.join(exeDir, 'Uninstall QQ Agent.exe'));
}

/**
 * 不含 env 覆盖的数据目录，与 resolveDataDir 的推导规则逐字一致。
 *
 * 三处共用：RENDER_DATA_DIR（模块顶层）、fallbackLog（pre-ready 兜底日志）、
 * resolveDataDir。NSIS 安装版必须写入 userData：升级会清空整个安装目录，
 * 包括运行时生成的 data/。zip 便携版不经过卸载器，数据可以留在 exe 同级。
 * 共用推导才能让日志与 GPU 标志始终跟随业务数据。便携目录只读时明确报错，
 * 不回退到 userData，否则用户会误以为数据仍在便携目录，实际却写去了别处。
 *
 * 开发态一并在这里处理：原先 RENDER_DATA_DIR 在开发态也按 exe 同级算，
 * 实际落到 node_modules/electron/dist/data，与 resolveDataDir 的项目内 data/
 * 不是同一个目录 —— GPU 回退标志写进去，业务侧永远读不到。
 *
 * 函数声明而非箭头常量：RENDER_DATA_DIR 在模块顶层就调用它，必须靠提升。
 */
function packagedDataDir() {
  if (!app.isPackaged) return path.resolve(fileURLToPath(import.meta.url), '..', '..', dataDirName());
  if (isPortableInstall()) return path.join(path.dirname(app.getPath('exe')), dataDirName());
  return path.join(app.getPath('userData'), dataDirName());
}

// ── GPU 硬件加速：默认启用（壁纸套件）────────────────────────────────────
// 无条件 disableHardwareAcceleration() 时，壁纸毛玻璃 / 视频背景 / 整窗合成全走 CPU，
// 开壁纸必卡（切页、滚动每帧全窗软件合成）。现在默认启用 + 四层安全网：
//   1) data/render-gpu-off.flag 存在 → 本次直接软件模式。手动回退入口：
//      双击安装目录的 wallpaper-gpu-off.bat（它写这个文件），删掉文件恢复 GPU。
//      下面第 3 条也会自动写这个文件。
//   2) 环境变量 QQ_AGENT_ENABLE_GPU / QQ_AGENT_DISABLE_GPU 可强制覆盖（排障用）。
//   3) GPU / 渲染进程 60 秒内崩 ≥3 次 → 自动写 flag + 重启进软件模式，
//      之后每次启动都直接软件模式，好驱动不受牵连。
//   4) 本块位于 whenReady 之前，满足 disableHardwareAcceleration() 的调用时序。
// data 目录此时还没解析（resolveDataDir 在下面），所以用同一套规则先算出来。
// 这条规则与 resolveDataDir 必须逐字一致，否则 GPU 回退标志（render-gpu-off.flag）
// 与启动日志会写到另一个目录：macOS / Linux 上那正是只读的 .app 包内与 AppImage 挂载点，
// 写入失败被 catch 吞掉后，表现为「GPU 反复崩溃却永远不降级」「启动闪退但日志里一行没有」。
// 三处（这里、fallbackLog、resolveDataDir）共用 packagedDataDir()，就是为了不再各抄一份。
const RENDER_DATA_DIR = (() => {
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) return env;
  try { return packagedDataDir(); } catch { return ''; }
})();
const RENDER_GPU_OFF_FLAG = RENDER_DATA_DIR ? path.join(RENDER_DATA_DIR, 'render-gpu-off.flag') : '';

const gpuForce = String(process.env.QQ_AGENT_ENABLE_GPU ?? '').trim();
const gpuDisable = String(process.env.QQ_AGENT_DISABLE_GPU ?? '').trim();
let renderGpuOff;
if (gpuDisable && gpuDisable !== '0') renderGpuOff = true;          // 显式关：优先
else if (gpuForce === '1') renderGpuOff = false;                     // 显式开：其次
else if (gpuForce === '0') renderGpuOff = true;                      // 兼容原开关语义（=1 开，其余关）
else {
  // 默认看 flag：不存在 = 开 GPU
  let flagHit = false;
  try { flagHit = Boolean(RENDER_GPU_OFF_FLAG) && fs.existsSync(RENDER_GPU_OFF_FLAG); } catch { flagHit = false; }
  renderGpuOff = flagHit;
}
if (renderGpuOff) {
  app.disableHardwareAcceleration();
} else {
  // 视频解码默认走 GPU（弱 CPU 软解带不动）。个别"多显卡 + 虚拟显示器"的机器
  // 硬解会输出马赛克坏帧，用安装目录的 video-decode-cpu.bat 切回软解
  // （写 data/render-config.json 的 hwVideoDecode=false），修好驱动再切回来。
  let hwVideoDecode = true;
  try {
    const rcPath = RENDER_DATA_DIR ? path.join(RENDER_DATA_DIR, 'render-config.json') : '';
    if (rcPath) {
      const rc = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
      if (rc && typeof rc.hwVideoDecode === 'boolean') hwVideoDecode = rc.hwVideoDecode;
    }
  } catch { /* 无配置文件：默认 GPU 硬解 */ }
  if (!hwVideoDecode) {
    app.commandLine.appendSwitch('disable-accelerated-video-decode');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
}

// GPU 崩溃自动回退（安全网 3）。只在真的启用了 GPU 时生效。
let gpuCrashCount = 0;
let gpuCrashWindowStart = Date.now();
function noteRenderCrash(kind) {
  if (renderGpuOff) return;   // 已在软件模式：正常崩溃，不归 GPU，不再回退
  const now = Date.now();
  if (now - gpuCrashWindowStart > 60_000) { gpuCrashCount = 0; gpuCrashWindowStart = now; }
  gpuCrashCount += 1;
  try {
    if (RENDER_DATA_DIR) {
      fs.appendFileSync(path.join(RENDER_DATA_DIR, 'boot-diag.log'),
        `${new Date().toISOString()} 渲染相关进程崩溃 kind=${kind} count=${gpuCrashCount}\n`);
    }
  } catch { /* 日志失败不影响回退 */ }
  if (gpuCrashCount >= 3) {
    try {
      if (RENDER_GPU_OFF_FLAG) fs.writeFileSync(RENDER_GPU_OFF_FLAG, `${new Date().toISOString()} kind=${kind}\n`);
    } catch { /* 写不进就只能下次再试 */ }
    console.error('[render] GPU 反复崩溃，已写 render-gpu-off.flag，重启进软件模式');
    app.relaunch();
    app.exit(0);
  }
}
app.on('child-process-gone', (_e, details) => {
  if (details?.type === 'GPU Process') noteRenderCrash('gpu');
});

// ── 渲染进程沙箱：默认开启，按需降级 ──────────────────────────────────────
// 背景：本机安全策略会拦杀沙箱化的子进程。沙箱 GPU 进程启动即 exit_code=1，
// 重试 6 次后 Chromium 判定 "GPU process isn't usable. Goodbye."（FATAL），
// 整个应用自杀；沙箱化的渲染进程同样被杀（reason=killed exitCode=1），窗口定格在
// 最后一帧，表现为"卡在启动画面"，残留"主进程活着但零子进程、零监听端口"的僵尸。
//
// 但这不能用全局 `--no-sandbox` 来解决：命令行开关优先级高于 webPreferences.sandbox，
// 一开就是所有窗口全局关掉，将来任何 <webview> / 弹窗 / iframe 都会继承关闭状态。
// 沙箱是渲染进程被利用后的最后一道纵深：本项目 contextIsolation/nodeIntegration
// 都已正确，现在打不到 RCE，但一旦出现 V8/Chromium CVE 就没有第二层兜底。
//
// 现在的做法：默认不关沙箱；真遇到上面的崩溃，用户/启动器用 QQ_AGENT_NO_SANDBOX=1
// 显式降级（知情选择，不是默认）。webPreferences 里见下方 sandbox 字段的说明。
const NO_SANDBOX_ESCAPE = process.env.QQ_AGENT_NO_SANDBOX === '1';
if (NO_SANDBOX_ESCAPE) {
  app.commandLine.appendSwitch('no-sandbox');
  console.warn('[main] 检测到 QQ_AGENT_NO_SANDBOX=1 —— 渲染进程沙箱已关闭。');
  console.warn('[main] 这会降低安全纵深，仅在"沙箱导致无法启动"时临时使用。');
}

// 软件模式下的两个开关：它们的价值是切断"GPU 不可用 → Chromium 重试 6 次 →
// FATAL 自杀"这条致命链（disableHardwareAcceleration 只把渲染换成软件实现，
// GPU 进程照样会被创建，挡不住这条链）。
// GPU 模式下必须一个都不加：--in-process-gpu 会把 GPU 线程塞进主进程，崩了连带
// 整个应用；真正的独立 GPU 进程才谈得上"崩溃即重启、应用不死"。
// 代价是所有绘制走 CPU 光栅化。本应用的窗口只是控制台页面，没有 canvas/WebGL
// 诉求，实测无差别。
// 一键回退：万一某台机器上这些开关造成了渲染异常，设置 QQ_AGENT_ENABLE_GPU=1 即可。
if (renderGpuOff) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
}


// 崩溃证据链：所有致命事件（未捕获异常 / 未处理 Promise / 渲染进程崩溃 / 无响应 /
// 退出清理）都必须落盘。打包版没有终端接管 stdout，只走 console.error 的话
// data/logs 里一行都不会有，闪退只能变成悬案。
//
// 必须动态 import：src/config.js 在模块求值瞬间就把 DATA_DIR 固化了
// （`process.env.QQ_AGENT_DATA_DIR || ...`），而那个 env 变量是本文件下面
// resolveDataDir() 才写进去的。静态 import 会让它抢跑，日志落去默认目录。
let coreLogger = null;
let coreLoggerBound = false;
async function bindCoreLogger() {
  if (coreLoggerBound) return;
  coreLoggerBound = true;
  try {
    const mod = await import('../src/logger.js');
    coreLogger = mod?.logger ?? null;
  } catch (error) {
    console.error('[log] 绑定 logger 失败（继续退化到 console）:', error?.message ?? error);
  }
}
/**
 * logger 绑定之前的兜底落盘通道。
 *
 * bindCoreLogger() 要等 app ready 才跑，在那之前（以及它失败之后）coreLogger
 * 一直是 null，而打包版没有终端接管 stdout，"启动阶段闪退"在 data/logs 里
 * 一行都没有。现在 pre-ready 的关键事件同步追加到 logs/boot-fallback.log；
 * logger 一旦绑上就自动让位给正式 logger，不会产生重复行。
 *
 * 刻意不缓存路径、也不用 __dirname：__dirname 在本文件下方才声明，
 * 而本函数可能被更早的代码调到（resolveDataDir 的 catch），引用它就是 TDZ ReferenceError。
 */
function fallbackLog(level, module, text) {
  try {
    const base = process.env.QQ_AGENT_DATA_DIR || packagedDataDir();
    const file = path.join(base, 'logs', 'boot-fallback.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] [${module}] ${text}\r\n`, 'utf8');
  } catch { /* 兜底通道自己失败也不许拖累调用方 */ }
}

/** 关键事件：尽量落盘，两者都失败也不许拖累调用方。 */
function logCritical(module, text) {
  if (coreLogger) { try { coreLogger.error(module, text); } catch { /* 落盘失败忽略 */ } }
  else fallbackLog('ERROR', module, text);
  try { console.error(`[${module}] ${text}`); } catch { /* 连 console 都异常就算了 */ }
}

/** 关键生命周期事件（非致命，但事后必须查得出来：它到底是被关掉的还是凭空没的）。 */
function logKey(module, text) {
  if (coreLogger) { try { coreLogger.info(module, text); } catch { /* 忽略 */ } }
  else fallbackLog('INFO', module, text);
  try { console.log(`[${module}] ${text}`); } catch { /* 忽略 */ }
}

/** 把任意 throw 值整理成可落盘的文本（Error 取 stack，其余尽量 JSON 化）。 */
function describeError(error) {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    const s = typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error);
    return String(s || '(空异常)');
  } catch { return String(error); }
}

// ── 数据目录可写性自检 ────────────────────────────────────────────────────
/**
 * 试写一次数据目录：返回 null 表示可写，否则返回失败原因文本。
 *
 * 值得在启动最早期单独测这一下：配置、聊天记录、记忆、用量账本全写在
 * 已解析的数据目录下。这个目录不可写时，后续的写入失败分散在十几个模块里，
 * 表现千奇百怪（有的抛异常被 catch 掉、有的静默跳过、有的在渲染进程里 reject），
 * 用户看到的却是同一件事：双击之后什么都没发生，零提示、零日志。
 * 所以在业务代码之前把"环境问题"和"程序 bug"分开。
 *
 * 已知成因（按现场出现频率排）：
 *   ① 用 QQ_AGENT_DATA_DIR 指向了 Program Files / Windows 之类的受保护目录；
 *   ② 数据目录在 OneDrive / 坚果云等同步盘的"仅在线"位置；
 *   ③ 杀软或企业管控把目录设成只读，或"受控文件夹访问"拦了写入；
 *   ④ 数据目录被一个同名文件占住了。
 *
 * @param {string} dir 已解析出的数据目录（process.env.QQ_AGENT_DATA_DIR）
 * @returns {string|null} 失败原因；可写时返回 null
 */
function probeDataDirWritable(dir) {
  if (!dir) return '数据目录路径为空（QQ_AGENT_DATA_DIR 未解析出来）';
  try {
    // recursive 在目录已存在时是空操作；路径被同名文件占住会抛 EEXIST/ENOTDIR
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return describeError(error);
  }
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, String(Date.now()), 'utf8');
  } catch (error) {
    return describeError(error);
  }
  try { fs.unlinkSync(probe); } catch { /* 删不掉不影响结论：能写就算通过 */ }
  return null;
}

/**
 * 数据目录不可写时的收尾：写诊断文件 → 弹原生错误框 → 退出。
 *
 * 这里刻意用 dialog.showErrorBox（同步阻塞），而不是 ./dialog-safe.js 的 showDialog：
 *   · 此时还没有任何窗口，没有父窗口可挂，showDialog 的优势用不上；
 *   · 这是"马上要退出"的路径，必须保证用户一定看见再走。异步框一旦因为 ready
 *     时序没弹出来，就退化成"双击没反应"的老毛病。同步框在用户点掉之前进程不退。
 *   · Electron 文档明确保证 showErrorBox 可以在 ready 之前调用。
 *
 * 退出码用 2，与 0（正常退出）、1（未捕获异常）区分开，方便启动器判断
 * "是环境问题还是程序崩了"。
 */
function reportDataDirFailure(dir, reason) {
  const programDir = (() => {
    try { return path.dirname(app.getPath('exe')); } catch { return '(未知)'; }
  })();
  const detail = [
    `时间：${new Date().toISOString()}`,
    `程序版本：${(() => { try { return app.getVersion(); } catch { return '(未知)'; } })()}`,
    `程序目录：${programDir}`,
    `数据目录：${dir}`,
    `平台：${process.platform} ${process.arch}`,
    `命令行：${process.argv.join(' ')}`,
    '',
    '错误详情：',
    reason
  ].join('\r\n');

  // 诊断文件写到 %APPDATA%\qq-agent\（Electron 自己要在那儿放缓存，一定可写）。
  // data 目录都写不进去的时候，这是唯一还能落盘的地方。
  let diagPath = '';
  try {
    const fallbackDir = app.getPath('userData');
    fs.mkdirSync(fallbackDir, { recursive: true });
    diagPath = path.join(fallbackDir, 'data-dir-error.log');
    fs.appendFileSync(diagPath, `${detail}\r\n${'='.repeat(72)}\r\n`, 'utf8');
  } catch { /* 连这里都写不了就只能靠弹窗了 */ }

  // 同步落一份到 stderr：带 -RedirectStandardError 启动时能直接抓到
  try { console.error(`[data] 数据目录不可写：${dir}\n${reason}`); } catch { /* 忽略 */ }

  const portableDataDir = app.isPackaged && isPortableInstall() && dir === packagedDataDir();
  const guidance = portableDataDir ? [
    '便携版需要可写的安装目录，当前目录不可写：',
    programDir,
    '',
    '请把程序移到用户目录（如 D:\\Tools\\QQ Agent），',
    '或改用安装版（数据会存在 %APPDATA%\\qq-agent）。'
  ] : [
    '程序需要往下面这个目录写文件，但没有写入权限：',
    '',
    dir,
    '',
    '常见原因和解决办法：',
    '1) QQ_AGENT_DATA_DIR 指向了 Program Files 或 Windows 等受保护目录 ——',
    '   请取消该环境变量，使用默认数据目录，或改到当前用户可写的位置。',
    '2) 数据目录在 OneDrive / 坚果云等同步盘的「仅在线」文件夹里 ——',
    '   请在资源管理器里右键该文件夹，选「始终保留在此设备上」。',
    '3) 杀毒软件或公司管控把它设成了只读 —— 解除数据目录的写入限制。',
    '4) 数据目录被一个同名文件占住了 —— 将该文件移开后再启动。'
  ];
  const message = [
    ...guidance,
    '',
    diagPath ? `诊断信息已写入：\n${diagPath}` : '诊断信息未能写入磁盘。'
  ].join('\n');

  try {
    dialog.showErrorBox('QQ Agent 无法启动', message);
  } catch { /* 连原生框都弹不出来时，至少 stderr 里留下了原因 */ }
  app.exit(2);
}

/**
 * 崩溃转储的保留上限。
 *
 * 每个 minidump 约 34MB，不做清理的话崩溃几次就永久占几百 MB。实现抽在
 * electron/crash-dumps.js（main.js import 了 electron，纯 node 下跑不起来，
 * 逻辑塞在这里等于没有测试）；这里只负责接线 + 落日志。
 */
function pruneCrashDumps() {
  try {
    const base = path.join(app.getPath('userData'), 'Crashpad');
    const r = pruneCrashDumpsImpl(base, { keep: CRASH_DUMP_KEEP, log: (m) => logKey('crashpad', m) });
    if (r.total && !r.removed) {
      logKey('crashpad', `崩溃转储 ${r.total} 份（上限 ${CRASH_DUMP_KEEP}），无需清理`);
    }
  } catch (error) {
    logKey('crashpad', `崩溃转储清理失败（不影响启动）：${error?.message ?? error}`);
  }
}

/**
 * 崩溃转储（crashpad）。
 * 打开之后原生崩溃会在 <userData>/Crashpad 下留一份 minidump，下次能直接看到
 * 调用栈死在哪一层。uploadToServer=false + 空 submitURL：只落本地，不外传。
 */
function startCrashReporter() {
  try {
    const cr = electronApi.crashReporter ?? null;
    if (!cr?.start) return;
    cr.start({
      productName: 'QQ Agent',
      submitURL: '',
      uploadToServer: false,
      compress: false,
      // 把"到底是哪个构建 / 哪个运行环境"写进 dump 的注解。定位原生硬崩溃时
      // 最费时间的一步是先确认用户装的是不是同一个构建，注解写进 dump 后
      // 一眼就能排除"版本不一致"这条分支。
      globalExtra: {
        version: app.getVersion?.() ?? 'unknown',
        electron: process.versions?.electron ?? 'unknown',
        node: process.versions?.node ?? 'unknown',
        chrome: process.versions?.chrome ?? 'unknown',
        arch: process.arch,
        dataDir: dataDirName(),
        instance: describeInstance(),
        noSandbox: NO_SANDBOX_ESCAPE ? '1' : '0'
      }
    });
    try { coreLogger?.info('crashpad', '崩溃转储已启用（本地留存，不上传）'); } catch { /* 忽略 */ }
  } catch (error) {
    console.error('[crashpad] 启用失败（不影响启动）:', error?.message ?? error);
  }
}

/**
 * 子进程监护。GPU 进程被杀、Chromium 重试到自杀这条链以前完全看不见，
 * 现在每个非正常退出的子进程都留一行：GPU / Utility / Zygote 谁死、
 * 是被杀还是崩了、退出码多少，一眼就能看出是不是又被系统侧拦了。
 */
function watchChildProcesses() {
  let abnormal = 0;
  app.on('child-process-gone', (_e, details) => {
    const line = `type=${details?.type ?? '?'} reason=${details?.reason ?? '?'} exitCode=${details?.exitCode ?? '?'} pid=${details?.osProcessId ?? '?'}`;
    if (details?.reason && details.reason !== 'clean-exit') {
      abnormal += 1;
      logCritical('child', `[子进程异常退出 #${abnormal}] ${line}`);
    } else {
      try { coreLogger?.info('child', `[子进程退出] ${line}`); } catch { /* 忽略 */ }
    }
  });
}

// 主进程兜底：未捕获异常不应静默吞掉。headless 入口（src/server.js）exit(1)
// 的理由在那里不成立，因为那个有外层守护重启；Electron 没有外层守护，
// 进程挂掉后用户只能看到"托盘图标消失"。"半死不活地挂着"（定时器丢失/连接悬空
// 但窗口还在）是最难排查的状态，宁可死得明明白白。
// 内容从 error.stack 取全文：崩溃就有这一次机会留下证据，不要只给 message。
process.on('unhandledRejection', (error) => {
  logCritical('fatal', `[未处理 Promise] ${describeError(error)}`);
});
process.on('uncaughtException', (error) => {
  logCritical('fatal', `[未捕获异常] ${describeError(error)}`);
  // app.exit 不触发 before-quit/quit 事件：协议端（SnowLuma / NapCat）由用户
  // 自行安装、自行运行，退出 QQ Agent 不该把它一起杀掉。这里只兑现消息存档落盘，
  // 来不及跑的长清理无所谓。
  // 消息存档按会话节流 300ms（store.js 的 M5），这里同步兑现待写内容，
  // 异常退出前不 flush 就等于丢掉最后几百毫秒的聊天记录。
  try { core?.store?.flushPendingSaves?.(); } catch { /* 退出路径上不再抛 */ }
  try {
    // 不能用 dialog.showErrorBox：它是模态同步调用，用户不点掉进程就一直活着，
    // 且无父窗口、独占一个任务栏按钮。showDialog 挂父窗口 + 30 秒超时自消，
    // 超时动作仍是 exit(1)。ready 前没有父窗口可挂，靠超时兜底。
    showDialog({
      type: 'error',
      title: 'QQ Agent 发生未捕获错误',
      message: '程序遇到无法恢复的错误，即将退出。',
      detail: `${String(error?.stack ?? error?.message ?? error)}\n\n完整日志见 data/logs/ 下的当日日志文件。`,
      buttons: ['知道了']
    }, { parent: mainWindow ?? null, autoCloseMs: DIALOG_TIMEOUT.fatal, timeoutAction: () => app.exit(1) })
      .catch(() => {})
      .finally(() => app.exit(1));
  } catch {
    // 弹窗本身失败：不等用户，直接退（原来的语义也是如此）
    app.exit(1);
  }
});

// AppUserModelID：让 Windows 把窗口归到「QQ Agent」身份下（任务栏分组/图标/通知），
// 否则 dev 模式下会被当成裸 electron.exe，钉任务栏变成 electron 图标
app.setAppUserModelId('com.awsl1414.qq-agent');

// ── 数据目录：环境变量 > 便携目录 > userData，开发态留在项目内 ──────────
// NSIS 升级会清空安装目录，安装版必须走 userData；便携版不经过卸载器，可留在 exe 旁。
// QQ_AGENT_DATA_DIR 显式覆盖优先。只读时由启动自检报错，不静默回退，以免数据悄悄换位置。
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  return packagedDataDir();
}

process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连同一个协议端，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 不能静默退出：已有一个实例占着锁时，新实例原来的行为是 app.quit() 后
  // 一声不响地消失。用户看到的是"双击了没反应"，而眼前那个窗口可能是上一次
  // 卡死留下的定格画面，于是反复双击、反复无反应。这里明确告知一句。
  // 这个框无父窗口（此刻主窗口归已运行的实例），是独立顶层窗口，会占一个任务栏
  // 按钮且点掉之前进程不退。加 8 秒超时自消：信息一行字读够，没人看也自己消失。
  app.whenReady().then(() => {
    showDialog({
      type: 'info',
      title: 'QQ Agent',
      message: 'QQ Agent 已经在运行了',
      detail: '已为你唤出正在运行的窗口。\n如果那个窗口一直停在启动画面，请从右下角托盘图标选择「退出」，再重新打开。',
      buttons: ['知道了']
    }, { autoCloseMs: DIALOG_TIMEOUT.alreadyRunning })
      .catch(() => {})
      .finally(() => app.quit());
  }).catch(() => { /* 单实例提示失败也不影响退出 */ });
} else {
  // 第二实例启动时唤出窗口，并顺手把"卡住的自己"救回来：用户再点一次
  // 就是在告诉我们"界面没出来"。
  app.on('second-instance', async () => {
    showWindow();
    // 用户再点一次 = 在告诉我们"界面没出来"。先看清楚是"没起来"还是"起来后卡住了"，
    // 两种情况的救援手段不同（reload 只对前者有效），见 healIfStuck 的注释。
    const probe = await probePage(mainWindow);
    if (probe.state === 'gone') return;                  // showWindow 已经新建过窗口了
    if (probe.state === 'ready') {
      console.log('[window] 用户再次启动：页面正常，仅唤出窗口');
      return;
    }
    // 仍在启动中（boot）的页面不急着重载。首启要加载几十个技能与插件并做
    // 缓存预热，页面头几十秒停在 loading 壳是正常节奏；无条件 reload 会让用户
    // 着急连点两三次就把启动一次次打断重来，这是"卡在会话加载界面出不来"的
    // 重要放大器。只有窗口建起来超过 30 秒还没就绪，才认定真卡了
    // （页面自身还有 45 秒 showBootFailure 兜底，两道闸不重复）。
    if (probe.state === 'boot' && Date.now() - windowBornAt < 30_000) {
      console.log(`[window] 用户再次启动：页面仍在启动中（已 ${Math.round((Date.now() - windowBornAt) / 1000)}s），仅唤出窗口，不重载`);
      return;
    }
    await healIfStuck('用户再次启动', probe.state);
  });
}

/**
 * 页面活性探针。
 *
 * 只问「启动 loading 壳撤了没」是不够的：这两者在启动成功后永久为真，
 * 看门狗对"跑了几小时之后界面冻住"完全无感。
 *
 * 返回四态：
 *   'ready'：JS 有应答且启动已就绪（是否真活着还要再看心跳，见 startBootWatchdog）
 *   'boot' ：JS 有应答，但仍停在 loading 壳上（启动没完成）
 *   'hung' ：JS 在 4 秒内没有应答 → 渲染主线程被占满 / 僵死
 *   'gone' ：窗口或页面已销毁
 *
 * "超时"就是僵死的可靠信号（实测，Electron 33.4.11）：渲染主线程跑同步死循环
 * 期间，executeJavaScript 连续 4 次全部超时，循环一结束立刻恢复应答；
 * 而同一时间内 render-process-gone 触发 0 次（进程活着，只是不干活）。
 *
 * 心跳 __qaBeat 是辅助信号（由 ui/app/00-core.js 每秒递增），能抓到
 * "JS 还能应答、但界面已经冻住"那类僵死。窗口隐藏时 Chromium 会节流定时器，
 * 所以主进程只在窗口可见时才拿它做判定（见 startBootWatchdog）。
 *
 * 返回值的 hidden 是页面自报的 document.visibilityState === 'hidden'。
 * 主进程侧的 isVisible()/isMinimized() 查不到"被别的窗口遮挡"，而被遮挡正是
 * 多数误判的场景。backgroundThrottling:false 已把节流从源头关掉，但遮挡/休眠
 * 恢复期间仍可能出现一次探针超时；hidden 让看门狗知道"此刻不适合下结论"。
 */
async function probePage(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return { state: 'gone', beat: -1 };
  let r;
  // race 的兜底定时器必须清理：executeJavaScript 秒回时也留一个 4s 定时器挂着
  // （看门狗 5s 一问，常态挂 1 个）。
  let raceTimer = null;
  try {
    r = await Promise.race([
      win.webContents.executeJavaScript(
        'String(((typeof __qaBeat !== "undefined" && __qaBeat) || 0) + "|" + ((typeof appReady !== "undefined" && appReady === true) || !document.getElementById("loading-overlay")) + "|" + ((document.visibilityState === "hidden" || document.hidden === true) ? "1" : "0"))'
      ),
      new Promise((res) => { raceTimer = setTimeout(() => res('timeout'), 4000); })
    ]);
  } catch {
    return { state: 'hung', beat: -1, hidden: false };   // 执行本身抛错，与"不回话"同样处理
  } finally {
    if (raceTimer) clearTimeout(raceTimer);
  }
  if (r === 'timeout') return { state: 'hung', beat: -1, hidden: false };
  const [beatRaw, readyRaw, hiddenRaw] = String(r).split('|');
  return {
    state: readyRaw === 'true' ? 'ready' : 'boot',
    beat: Number(beatRaw) || 0,
    // 页面自报的可见性。主进程侧 isVisible()/isMinimized() 查不到"被别的窗口遮挡"，
    // 而 document.visibilityState 是 Chromium 遮挡检测的一手结论。
    // 旧页面（不认识第三段）拿不到时按 false。
    hidden: hiddenRaw === '1'
  };
}

/**
 * 启动卡住时，把「启动画面自己想说的话」捞回主进程日志。
 *
 * 渲染进程的 bootLogs / #loading-status（setLoadingStatus 写的那几条，比如
 * "服务还没响应：xxx"）以前只存在于 DOM 里，群友发来主进程日志时恰恰看不到
 * 这句最关键的失败原因。看门狗重载前捞一次，日志就能自证卡在哪一步。
 */
async function harvestBootDiagnostics(reason) {
  let diagTimer = null;
  try {
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) return;
    // state === 'boot' 意味着渲染主线程能应答，但仍然加 3 秒超时兜底，
    // 免得取证本身把看门狗卡住（任何探针都必须带超时）。
    // 兜底定时器要清，否则 executeJavaScript 秒回时也会留一个 3 秒定时器。
    const info = await Promise.race([
      wc.executeJavaScript(
        'JSON.stringify({status:(document.getElementById("loading-status")||{}).textContent||"",logs:(typeof bootLogs!=="undefined"?bootLogs.slice(-8):[]),overlay:!!document.getElementById("loading-overlay")})'
      ),
      new Promise((res) => { diagTimer = setTimeout(() => res(null), 3000); })
    ]);
    if (info) logCritical('renderer', `[启动画面自述 reason=${reason}] ${info}`);
    else logCritical('renderer', `[启动画面自述 reason=${reason}] 3 秒内渲染进程没有回话`);
  } catch (error) {
    logCritical('renderer', `[启动画面自述失败 reason=${reason}] ${describeError(error)}`);
  } finally {
    if (diagTimer) clearTimeout(diagTimer);
  }
}

// 卡住自救。两类故障的救援手段不能混用：
//   boot：页面没起来，reload() 有效。
//   hung：渲染主线程不回话。reload() 对它完全无效（实测：导航请求排在阻塞的
//         主线程后面，只能干等），必须把窗口整个重建。
// 服务跑在主进程里、一直活着，所以重建窗口即可恢复，不需要动后端。
let bootMisses = 0;
let bootReloads = 0;
let hangMisses = 0;
let windowRebuilds = 0;
let bootWatchdog = null;
let lastBeat = -1;
let rebuilding = false;
// 系统休眠恢复 / 锁屏解锁后的静默期截止时刻（见 suspendWatchdogBriefly）。
// 这两个时刻渲染进程可能还在恢复（定时器被暂停过、合成器重建、页面重排），
// 一次探针超时并不代表界面坏了；据此拆窗重建会让用户看到"睡醒回来窗口自己
// 消失了一下 / 任务栏莫名其妙闪一下"。
let resumeGraceUntil = 0;

/** 毁掉当前窗口再建一个。只在"页面彻底不回话"时走这条路（reload 已证明无效）。 */
async function rebuildWindow(reason) {
  if (rebuilding) return true;            // 上一次还没建完
  if (windowRebuilds >= 2) return false;  // 重建也救不回来，交给调用方收尾
  rebuilding = true;
  windowRebuilds += 1;
  logCritical('window', `[渲染进程无应答] reason=${reason}，重建窗口第 ${windowRebuilds} 次`);
  const port = core?.lastPort ?? 3210;
  const old = mainWindow;
  mainWindow = null;
  try {
    // 必须先摘掉 closed 监听再 destroy：closed 是异步触发的，否则它会在
    // createWindow() 之后才到，把刚建好的新窗口置成 null，看门狗随后
    // 以为"没有窗口可管"而停手，重建等于白做。
    old?.removeAllListeners('closed');
    old?.destroy();
  } catch { /* 已经销毁过了 */ }
  try {
    createWindow(port);
  } catch (error) {
    logCritical('window', `[重建窗口失败] ${describeError(error)}`);
    rebuilding = false;
    return false;
  }
  rebuilding = false;
  return true;
}

// 返回值语义：true = "不用管了"（已恢复，或已采取措施）；false = "自愈预算用尽，该告诉用户了"。
// 重载完也返回 false 的话，看门狗第一次动手就把自己关掉并弹错误框，
// 页面还在重载中就被判死刑。
async function healIfStuck(reason, state) {
  if (state === 'boot') {
    if (bootReloads >= 2) return false;
    // 重载之前先把启动画面上的自述捞进日志，否则重载会把现场冲掉
    await harvestBootDiagnostics(reason);
    bootReloads += 1;
    logCritical('window', `[看门狗：页面停在启动画面] reason=${reason}，重载第 ${bootReloads} 次`);
    try { mainWindow?.webContents.reload(); } catch { /* 窗口已销毁 */ }
    return true;
  }
  return await rebuildWindow(reason);
}

/** 自愈预算耗尽：停手并把情况说清楚（后端一直是好的，坏的只有界面这一层）。
 *
 * 不能套"超时退出"：后端可能正在跑会话，退出即丢工作。
 * 折中：挂到 mainWindow 上（模态子对话框不单独占任务栏）；窗口已经没了就退回
 * 无父形态，但日志照旧写全，排查时不能没有痕迹。
 */
function giveUpWatchdog(reason) {
  clearInterval(bootWatchdog);
  bootWatchdog = null;
  logCritical('window', `[看门狗放弃自愈] reason=${reason}`);
  try {
    showDialog({
      type: 'error',
      title: 'QQ Agent 界面没有响应',
      message: '界面已无响应（自动重载 / 重建窗口都试过，仍未恢复）',
      detail: '后端服务是正常运行的，坏的是界面这一层。\n请从右下角托盘选择「退出」后重开；若持续出现，把 data/logs/ 当天的日志发给开发者。',
      buttons: ['知道了']
    }, { parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : null })
      .catch(() => {});
  } catch { /* 弹窗失败不拦退出 */ }
}

/**
 * 给看门狗一段静默期（系统休眠恢复 / 锁屏解锁后调用）。
 *
 * 宽限期内完全不下判断，并把已有计数清零。理由：这两个时刻渲染进程可能正在
 * 恢复（定时器被系统暂停过、合成器要重建、页面要重排），一次探针超时并不代表
 * 界面坏了。旧逻辑会把这次超时累计进 hangMisses，两次后直接 destroy() +
 * createWindow()，用户看到"睡醒回来窗口自己消失了一下"，而界面其实一直是好的。
 *
 * @param {number} ms     静默时长
 * @param {string} reason 记进日志的原因（排错时要能看出是哪一个电源事件）
 */
function suspendWatchdogBriefly(ms, reason) {
  resumeGraceUntil = Date.now() + ms;
  bootMisses = 0; hangMisses = 0; bootReloads = 0; windowRebuilds = 0;
  lastBeat = -1;
  logKey('window', `[看门狗] 静默 ${Math.round(ms / 1000)}s：${reason}`);
}

/** 窗口此刻是否处于"可以下僵死结论"的状态（可见、未最小化、页面未自报隐藏）。 */
function windowJudgeable(probe) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (probe?.hidden) return false;                              // 被遮挡/隐藏：定时器本就可能停摆
  try {
    return mainWindow.isVisible() && !mainWindow.isMinimized();
  } catch {
    return false;
  }
}

function startBootWatchdog() {
  // 每 5 秒自检一次。重建窗口时会再调一次，所以开头必须先把旧的清掉（幂等）。
  // 常驻不解除武装：一就绪就 clearInterval 的话，页面先正常启动、之后再卡死
  // 就再也没人管了。现在只要恢复就绪就把连续失败计数和重载预算一起清零，
  // 看门狗全程在岗，但只在真出事时才动手。
  if (bootWatchdog) clearInterval(bootWatchdog);
  // 重入保护：本 tick 由多段 await 组成（probePage 每段自带 4 秒探测超时，
  // 僵死路径上还有一次 1.2 秒复核 + 第二次 probe），真僵死时单轮最坏可以超过
  // 9 秒，而 interval 只有 5 秒。没有重入标志时下一轮会叠进来，两个 tick 同时
  // 累加 hangMisses、同时调 healIfStuck，最坏是连着重建两次窗口。
  // 跑不完就跳过这一轮；看门狗的判据本来就是"跨多轮累计"，跳一轮不改变判定结果。
  let ticking = false;
  bootWatchdog = setInterval(() => {
    if (ticking) return;
    ticking = true;
    Promise.resolve(watchdogTick())
      .catch(() => { /* 单轮异常由内部各分支自行处理，这里只保证标志复位 */ })
      .finally(() => { ticking = false; });
  }, 5000);

  // 单轮自检。写成函数声明（会提升）所以可以放在 setInterval 之后。
  async function watchdogTick() {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(bootWatchdog); bootWatchdog = null; return; }

    // 休眠恢复/解锁后的静默期：完全不下判断，也不累计任何计数。
    if (Date.now() < resumeGraceUntil) return;

    const probe = await probePage(mainWindow);
    if (probe.state === 'gone') { clearInterval(bootWatchdog); bootWatchdog = null; return; }

    if (probe.state === 'ready') {
      // 心跳只在窗口可见时参与判定：窗口隐藏时 Chromium 会节流甚至暂停定时器，
      // 心跳停摆是正常的（缩到托盘就是这种状态），不能当僵死处理。
      // 可见性判据统一收进 windowJudgeable，除 isVisible/isMinimized 之外，
      // 还看页面自报的 document.visibilityState（能抓到"被别的窗口遮挡"）。
      const visible = windowJudgeable(probe);
      // beat <= 0 表示页面里还没有心跳（旧版页面 / 刚导航完），此时不拿它下判断。
      if (!visible || probe.beat <= 0 || probe.beat !== lastBeat) {
        lastBeat = probe.beat;
        bootMisses = 0; hangMisses = 0; bootReloads = 0; windowRebuilds = 0;
        return;
      }
      // 可见 + JS 有应答 + 心跳不动 → 界面冻住而 JS 还活着（渲染/合成层面的僵死）
      hangMisses += 1;
      if (hangMisses < 3) return;
      // 动手前先复核一次。心跳停摆可能是"渲染主线程正在跑一段长同步任务"
      // （大表全量重绘、GC 长暂停），这类停摆会自己恢复，拆窗属于过度处置。
      // 再问一次，只要回话就放它一马。
      hangMisses = 0;
      await new Promise((res) => setTimeout(res, 1200));
      const confirm = await probePage(mainWindow);
      if (confirm.state !== 'hung' && confirm.state !== 'gone') {
        logKey('window', '[看门狗] 心跳停摆为瞬时抖动（复核已恢复），不重建窗口');
        lastBeat = confirm.beat;
        return;
      }
      if (!(await healIfStuck('看门狗：心跳停摆', 'hung'))) giveUpWatchdog('心跳停摆');
      return;
    }

    if (probe.state === 'hung') {
      // 这是本轮最重要的守卫。不看窗口状态的话，窗口被遮挡、缩在托盘、
      // 或系统刚休眠回来时，一次 executeJavaScript 超时就累计，两次后
      // destroy()+createWindow()。重建出的新窗口会走 ready-to-show 的
      // show()+focus()，于是缩托盘的用户被凭空弹回前台，全屏游戏里的用户
      // 被抢焦点。查不到可见性时保守处理：不动手。
      if (!windowJudgeable(probe)) {
        hangMisses = 0;
        return;
      }
      // 连续 3 次无应答才动手（每轮自带 4 秒探测超时 ≈ 15 秒），避免一次偶发抖动就重建窗口
      hangMisses += 1;
      if (hangMisses < 3) return;
      hangMisses = 0;
      // 同样是"动手前复核"：长同步任务期间的超时会在任务结束后立刻恢复。
      await new Promise((res) => setTimeout(res, 1200));
      const confirm = await probePage(mainWindow);
      if (confirm.state === 'ready' || confirm.state === 'boot') {
        logKey('window', '[看门狗] 页面无应答为瞬时抖动（复核已恢复），不重建窗口');
        lastBeat = confirm.beat;
        return;
      }
      if (!(await healIfStuck('看门狗：页面无应答', 'hung'))) giveUpWatchdog('页面无应答');
      return;
    }

    // 'boot'：启动未就绪，沿用重载策略（reload 对"页面没起来"是有效的）
    bootMisses += 1;
    // 阈值 12（60 秒）。页面自己的启动预算要到 45 秒才渲染 showBootFailure
    // （带"重新加载界面"按钮），看门狗 25 秒就判死刑的话，慢机器会被反复打断重来，
    // 自愈预算耗尽后彻底躺平，启动越慢越容易被判死刑。
    if (bootMisses < 12) return;
    bootMisses = 0;
    if (!(await healIfStuck('看门狗：启动未就绪', 'boot'))) giveUpWatchdog('启动未就绪');
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Windows 优先用 .ico，而不是固定 .png。QQ Agent.exe 是 node stub（自身没有
// 嵌入图标资源），任务栏/托盘图标完全依赖这里的 setIcon，而 .png 在部分 Windows
// 上会被任务栏忽略，表现为"底部任务栏显示一张空白文件图标"。
// assets 里的 icon.ico 含 16~256 全套尺寸，是 Windows 原生格式，兼容性最好；
// 非 Windows（开发机 / mac 包）继续用 png。
const ICON_PNG_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');
const ICON_ICO_PATH = path.resolve(__dirname, '..', 'assets', 'icon.ico');
const ICON_PATH = (process.platform === 'win32' && fs.existsSync(ICON_ICO_PATH))
  ? ICON_ICO_PATH
  : ICON_PNG_PATH;
// macOS 菜单栏托盘图标：单色 template image，16pt 画布，配 @2x 供 Retina。
// 不能直接拿 icon.png（256×256）当托盘图标：macOS 的 NSStatusItem 按图片的
// **点**尺寸原样绘制，不套用系统的小图标度量，256 像素在 1x 下就是 256pt，
// 于是一个图标撑满整条菜单栏。Windows 不同，Shell_NotifyIcon 会按
// SM_CXSMICON 把任意尺寸缩放到托盘槽位，所以同一份 PNG 在 Windows 上看不出问题。
// 另外彩色图标在深色菜单栏里不会反色，template 机制（只看 alpha，由系统染色）
// 才能让深浅色菜单栏都正常显示。
// 只写 trayTemplate.png 一个路径：nativeImage.createFromPath 会按 macOS 约定
// 自动把同目录的 trayTemplate@2x.png 挂成 2x 表示，点尺寸仍是 16pt。
const TRAY_ICON_PT = 16;
const TRAY_ICON_PATH = path.resolve(__dirname, '..', 'assets', 'trayTemplate.png');
// 无边框窗口的窗口控制桥（preload.cjs 而不是 .js，见该文件顶部说明）
const PRELOAD_PATH = path.resolve(__dirname, 'preload.cjs');
// 悬浮小窗自绘菜单的极窄桥（见 electron/widget-preload.cjs 顶部的安全边界）：
// 只需要把"改设置 / 打开主界面 / 展开"递过来，别的一概不开口。
const WIDGET_PRELOAD_PATH = path.resolve(__dirname, 'widget-preload.cjs');

let mainWindow = null;
// 主窗口是否被我们调成过半透明（= 已经吃上 WS_EX_LAYERED + LWA_ALPHA）。
// 这个样式一旦加上，Electron 就不会再摘掉（native_window_views.cc 的
// SetOpacity 里没有 opacity===1 的清理分支）。而 LWA_ALPHA 与"真透明窗口"
// 用的逐像素 alpha 互斥，打上去之后那个窗口只会停在第一帧不再重绘。
// 所以这里记住状态：从没调低过就一次都不打。
let mainWinLayered = false;
let core = null;
// 桌宠宿主（desktop-pet 插件激活后才真正有窗口；未装插件时是空壳，方法全部 no-op）。
let desktopPetHost = null;
let tray = null;
// 托盘菜单的强引用（Windows：菜单在弹出期间被 GC 会让点击回调拿到已回收对象）
let trayMenuRef = null;
let quitting = false;
// 桌面悬浮小窗（设置 → 界面与应用 → 桌面端打开）。设计约束见下方
// 「桌面悬浮小窗」整节的注释：默认不透明、几何落 window-state.json、
// 配置变更走 1 秒轮询比对、页面零 IPC。
let widgetWindow = null;
/**
 * 仅给当前 Electron 控制台窗口的同源 API 请求注入进程内随机凭据。
 * 凭据不进入 DOM、preload 或 renderer JS；外部脚本仍须使用用户配置的 server.token。
 */
function installConsoleRequestAuth(port, token) {
  if (!token) return;
  const origin = `http://127.0.0.1:${Number(port)}`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/api/*`] },
    (details, callback) => {
      const requestHeaders = { ...(details.requestHeaders || {}) };
      try {
        const frameOrigin = new URL(details.frame?.url ?? '').origin;
        const requestOrigin = new URL(details.url).origin;
        // 主控制台窗口与桌面悬浮小窗都放行（小窗页面 ui/widget.html 发的是
        // 同一个占位符，由这里换成进程私有真令牌）。少放行小窗 = 它轮询
        // /api/status 恒 401（配置了 server.token 时），那是"看得到窗口、
        // 永远连接中"的静默故障，所以两个窗口必须一并认。
        const isCurrentConsole = (mainWindow
            && !mainWindow.isDestroyed()
            && details.webContentsId === mainWindow.webContents.id)
          || (widgetWindow
            && !widgetWindow.isDestroyed()
            && details.webContentsId === widgetWindow.webContents.id);
        if (isCurrentConsole && frameOrigin === origin && requestOrigin === origin) {
          for (const key of Object.keys(requestHeaders)) {
            if (key.toLowerCase() === 'x-console-token') delete requestHeaders[key];
          }
          requestHeaders['x-console-token'] = token;
        }
      } catch { /* malformed/non-console requests are left untouched */ }
      callback({ requestHeaders });
    }
  );
}
// 用户主动缩到托盘后窗口应保持隐藏。重载/重建窗口都会触发 ready-to-show
// 与 did-finish-load，无条件 show()+focus() 等于把缩进托盘的窗口又弹出来，
// 任务栏按钮随之消失/出现。
let windowHidden = false;
// 窗口诞生时刻。second-instance 据此区分"正常启动中"与"真卡在启动画面"。
let windowBornAt = 0;
// 本窗口是否已经显示过一次。
// 用途：did-finish-load 里只在"还没显示过"时调 show()，之后的重载不再重复调。
// show() 自带"激活并抢焦点"语义，而重载是看门狗自救、did-fail-load 重试的
// 正常动作，不该有可见副作用：用户在全屏游戏里时，每次重载都抢一次焦点，
// 在 Windows 上就表现为任务栏按钮闪一下。
let windowEverShown = false;
// 本进程是否已经"因首次加载而聚焦过"。
// 必须是模块级、而不是 createWindow() 里的局部量：看门狗重建窗口会再走一次
// createWindow()，局部标志随之复活，重建完成后再抢一次焦点。窗口"可见"
// （windowJudgeable 通过）但用户其实在全屏游戏里时，这一下就是任务栏图标闪一下。
// 现在焦点只在"本进程第一个窗口首次加载完成"时给一次；看门狗重载/重建都不再给。
// 用户主动唤出（托盘双击 / 再次启动）不算，showWindow() 里会置位。
let focusedOnce = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
  checkDuplicateAutoStart(!!cfg.server?.autoStart);
}

/**
 * 开机自启重复项自检。
 *
 * 自动启动只有两个来源：① 本应用自己写的登录项（setLoginItemSettings）
 * ② 用户手动丢进 shell:startup 的快捷方式。安装器只创建桌面 + 开始菜单快捷方式，
 * 不写启动文件夹，所以如果两处同时存在，开机必然启动两次，而第二次只会弹
 * "已经在运行"的提示框。
 *
 * 每次 applyAutoStart 时核对一次，发现重复就 logCritical 点名。修不修让用户
 * 自己决定，删用户的快捷方式不是应用该擅自做的事。
 */
function checkDuplicateAutoStart(openAtLogin) {
  try {
    if (process.platform !== 'win32') return;      // 只处理 Windows 的 shell:startup
    const startupDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (!startupDir || !fs.existsSync(startupDir)) return;
    const exe = path.basename(process.execPath).toLowerCase();
    const hits = [];
    for (const name of fs.readdirSync(startupDir)) {
      if (!/\.lnk$/i.test(name)) continue;
      // 只看名字里带本程序名的（QQ Agent / qq-agent）；解析 .lnk 目标需要额外依赖，
      // 而"名字对得上"已经足够触发告警，误报的代价只是一行日志。
      if (name.toLowerCase().includes('qq')) hits.push(name);
    }
    if (hits.length && openAtLogin) {
      logCritical('boot', `[启动项重复] 登录项已开启，同时启动文件夹里也有 ${hits.length} 个疑似快捷方式`
        + `（${hits.slice(0, 3).join('、')}${hits.length > 3 ? ' 等' : ''}）`
        + ` —— 开机会启动两次，第二次只会弹"已经在运行"。请删除其中一个。`);
    } else if (hits.length && !openAtLogin) {
      logKey('boot', `[启动项] 启动文件夹里有 ${hits.length} 个快捷方式（${hits.slice(0, 3).join('、')}），`
        + `应用内"开机自启"当前为关 —— 实际仍会自启`);
    }
  } catch { /* 自检失败不影响自启功能本身 */ }
}

function showWindow() {
  if (mainWindow) {
    windowHidden = false;
    windowEverShown = true;   // 用户主动唤出 = 已显示过（见 did-finish-load 的守卫）
    focusedOnce = true;       // 用户主动唤出，"该给的那次焦点"已经给过
    mainWindow.show();
    // 缩托盘时曾把窗口从任务栏/切换器注销（见 close 里的 setSkipTaskbar(true)），
    // 这里要注册回来：show 之后立刻恢复，任务栏图标与 Alt+Tab 条目才不会缺席。
    try { mainWindow.setSkipTaskbar(false); } catch { /* 老版本无此 API 时忽略 */ }
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

/**
 * 托盘右键菜单（每次弹出时现建）。
 *
 * 不能"建一次 setContextMenu 完事"：Electron 的静态 context menu 只在
 * Menu.buildFromTemplate 那一刻读 checked。之后「暂停机器人」「开机自启」的真实
 * 状态变了，菜单不会跟着变。右键时现建一次只是多构造一个菜单对象（微秒级），
 * 换来"看到的永远是此刻的真值"。
 *
 * 风格约定：
 *   · 一级动作只用动词短语，不带标点、不带解释性括号；
 *   · 开关一律用 checkbox，label 只写"开关名"，不出现「A / B」这种一个标题两个动作；
 *   · 分隔线只用来分组，顺序固定：动作 → 开关 → 退出（退出永远最后、且单独一组）。
 */
function buildTrayMenu() {
  const cfg = (() => { try { return core?.getConfig() || {}; } catch { return {}; } })();
  const paused = (() => { try { return !!core?.orchestrator?.paused; } catch { return false; } })();
  return Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => { console.log('[tray] 显示主界面'); showWindow(); }
    },
    { type: 'separator' },
    {
      // 勾选 = 当前已暂停。旧标签是「暂停 / 恢复」，一个标题同时表示两个相反动作，
      // 点之前根本不知道会发生什么；checkbox 让"现在到底是暂停还是运行"一眼可见。
      label: '暂停机器人',
      type: 'checkbox',
      checked: paused,
      // 托盘回调里抛异常 = uncaughtException = 闪退，而退出/启动竞态下
      // core / orchestrator 完全可能已经不可用。
      click: (item) => { try { core?.orchestrator?.setPaused(!!item.checked); } catch { /* 竞态忽略 */ } }
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!cfg.server?.autoStart,
      click: (item) => {
        try { core?.updateConfig?.({ server: { autoStart: item.checked } }); } catch { /* 竞态忽略 */ }
        applyAutoStart();
      }
    },
    {
      // 关窗行为以前只能在设置页改（config.server.closeToTray 早就有），托盘里没入口
      label: '关闭窗口时缩到托盘',
      type: 'checkbox',
      checked: cfg.server?.closeToTray !== false,
      click: (item) => {
        try { core?.updateConfig?.({ server: { closeToTray: !!item.checked } }); } catch { /* 竞态忽略 */ }
      }
    },
    {
      // 桌面悬浮小窗。设置页同名控件在「界面与应用 → 桌面端」。
      // 这也是"鼠标穿透开启后"的恢复路径之一（那时小窗自己的右键菜单够不着）。
      label: '桌面悬浮窗',
      type: 'checkbox',
      checked: !!cfg.widget?.enabled,
      click: (item) => {
        try { core?.updateConfig?.({ widget: { enabled: !!item.checked } }); } catch { /* 竞态忽略 */ }
        syncWidget(true);
      }
    },
    { type: 'separator' },
    {
      // 原「退出」与「强制退出（跳过清理）」合并成这一项。旧「强制退出」走
      // app.exit(0)，绕过 before-quit：core.stop() 整条清理链不执行，
      // Electron 自己的 teardown 被打断，实测会留下"1 线程、无窗口、
      // taskkill /F 都报没有此任务"的僵尸。
      // 现在只留一个「退出」：走 before-quit → core.stop()（8 秒超时）。
      // stop 若真的挂住，由 before-quit 里的 8 秒超时 + 4 秒强制兜底自动收尾，
      // 用户不该被要求判断"该温和还是该强杀"。
      label: '退出',
      click: () => { logKey('tray', '点击：退出'); quitting = true; app.quit(); }
    }
  ]);
}

/**
 * 托盘图标按平台取不同资源。
 *
 * macOS：必须用菜单栏专用的 template image（16pt 画布 + @2x）。彩色大图不会
 * 被系统缩小，也不会跟随菜单栏深浅色反色，两个问题都只能靠 template 机制解决。
 * Windows / Linux：沿用 ICON_PATH（Windows 走 icon.ico），行为保持不变。
 */
function resolveTrayIcon() {
  if (process.platform !== 'darwin') return nativeImage.createFromPath(ICON_PATH);
  const template = nativeImage.createFromPath(TRAY_ICON_PATH);
  // 防御而非修复：图标文件缺失时 createFromPath 返回空图，托盘会变成一块
  // 空白。这里退回到缩小后的彩色图标——尺寸正确、颜色不反色，但至少可见。
  // 正常安装包里 assets/** 一定被带上，这条分支不该被走到。
  if (template.isEmpty()) {
    return nativeImage.createFromPath(ICON_PATH).resize({ width: TRAY_ICON_PT, height: TRAY_ICON_PT });
  }
  // 文件名带 Template 时 Electron 会自动标记，这里显式再设一次：
  // 说明意图，且不依赖文件名约定（将来改名不会静默失去反色）。
  template.setTemplateImage(true);
  return template;
}

function createTray() {
  tray = new Tray(resolveTrayIcon());
  tray.setToolTip(describeInstance());
  // 先设一次，保证"右键一定有菜单"（这是原来就验证过的机制，不换）。
  trayMenuRef = buildTrayMenu();
  tray.setContextMenu(trayMenuRef);
  // 再在右键时重建一次：Windows 上 Electron 先发 'right-click' 事件、后弹菜单，
  // 所以在事件里 setContextMenu 能赶在弹出之前生效，勾选状态就是此刻的真值。
  //
  // 不用 popUpContextMenu：它在 Windows 上有已知的坑（菜单不随失焦关闭 /
  // 需要额外保持引用），而 setContextMenu 就够了。就算某些版本上"重建赶不及"，
  // 最差也只是勾选状态落后一拍（纯观感），绝不会变成"右键点不出菜单"。
  tray.on('right-click', () => {
    try {
      trayMenuRef = buildTrayMenu();
      tray.setContextMenu(trayMenuRef);
    } catch (error) {
      logKey('tray', `刷新托盘菜单失败（沿用旧菜单）：${error?.message ?? error}`);
    }
  });
  tray.on('double-click', () => showWindow());
}

// ── 无边框窗口的窗口控制（frame: false）────────────────────────────────────
// 窗口没有系统标题栏，最小化/最大化/关闭只能由页面自绘按钮发起，经 preload 桥到这里。
//
// 用 fromWebContents 反查窗口，而不是记住 mainWindow：事件来源即窗口，天然不会
// 操作到别的窗口；mainWindow 在 closed 之后是 null，而事件可能仍在队列里，
// 反查不会误用悬空引用。所有 handler 都做了空值兜底，窗口已销毁时静默忽略。
const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('win:minimize', (event) => windowOf(event)?.minimize());

ipcMain.on('win:toggle-maximize', (event) => {
  const win = windowOf(event);
  if (!win) return;
  // 状态由主进程判断（isMaximized 是权威口径），避免渲染进程与真实状态不同步。
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

// 关闭语义与系统 ✕ 完全一致：走 win.close() 而不是 app.quit()，
// 于是 mainWindow.on('close') 里"缩到托盘"的逻辑照旧生效（关窗不退出是常驻机器人的预期）。
ipcMain.on('win:close', (event) => {
  // 自绘 ✕ 是唯一"要经过渲染进程"的关闭路径，渲染进程一旦僵死这条就是最先
  // 失灵的（Alt+F4 / 托盘退出走主进程）。这一笔日志是区分"渲染僵死"与
  // "缩到托盘"的关键：有这行 = 点击已送达主进程。
  const win = windowOf(event);
  console.log(`[close] 收到渲染进程的 win:close（窗口存在=${!!win}）`);
  win?.close();
});

ipcMain.handle('win:is-maximized', (event) => Boolean(windowOf(event)?.isMaximized()));

// ── 外观个性化 ────────────────────────────────────────────────────────────
// 只有"渲染进程做不到"的三件事才过桥：整窗不透明度、选背景图（原生文件对话框）、
// 清背景图。颜色/底色/透明度那些全是 CSS 变量，留在渲染进程里改，不开桥。
//
// 背景图必须复制进 data/ui/：页面跑在 http://127.0.0.1，file:// 图片会被 Chromium
// 以"跨源本地文件"拦下，CSP 也不放行 file:。复制进来后由 GET /api/ui-bg 同源吐出。
const UI_BG_DIR = () => path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'ui');

ipcMain.handle('win:set-opacity', (event, value) => {
  const win = windowOf(event);
  if (!win) return false;
  const v = Number(value);
  // 夹到 0.3~1：再低窗口基本看不见（用户会以为程序崩了），高过 1 无意义。
  const op = Math.min(1, Math.max(0.3, Number.isFinite(v) ? v : 1));
  // 100% 且从没调低过时一次都不要打。Electron 在 Windows 上的 SetOpacity 无条件
  // 加 WS_EX_LAYERED 并调 SetLayeredWindowAttributes(LWA_ALPHA)，且没有回到 1.0
  // 时摘掉样式的分支。LWA_ALPHA 与真透明窗口的逐像素 alpha 互斥，打上去之后
  // 窗口只画第一帧。渲染进程那边也已改成值不变就不发。
  if (op >= 1 && !mainWinLayered) return true;
  if (op < 1) mainWinLayered = true;
  win.setOpacity(op);
  return true;
});

ipcMain.handle('ui:pick-bg-image', async (event) => {
  const win = windowOf(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择界面背景图',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  const src = filePaths[0];
  const ext = (path.extname(src) || '').toLowerCase().slice(1);
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
    return { ok: false, error: `不支持的图片格式：${ext || '未知'}` };
  }
  const destDir = UI_BG_DIR();
  fs.mkdirSync(destDir, { recursive: true });
  const name = `bg-${Date.now()}.${ext}`;
  fs.copyFileSync(src, path.join(destDir, name));
  // 顺手清掉上一张，避免 data/ui/ 里堆一堆旧背景图
  try {
    for (const f of fs.readdirSync(destDir)) {
      if (f.startsWith('bg-') && f !== name) fs.rmSync(path.join(destDir, f), { force: true });
    }
  } catch { /* 清理失败不影响使用 */ }
  return { ok: true, name };
});

// ── 本地导入技能/插件 ─────────────────────────────────────────────────────
// 两件渲染进程做不到的事：① 弹原生对话框选文件/文件夹；② 把拖进来的 File 反查成
// 磁盘上的真实路径（File.path 自 Electron 32 起废弃，改用 webUtils.getPathForFile）。
//
// 拿到路径后不由主进程复制，转交给后端 POST /api/skills/import 统一处理，
// 这样"拖进窗口"和"点按钮选文件"走同一条校验/落地链路，不会有两套安全规则。
ipcMain.handle('dialog:pick-modules', async (event) => {
  const win = windowOf(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择技能/插件（zip 包或文件夹）',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: '技能/插件包', extensions: ['zip'] }, { name: '所有文件', extensions: ['*'] }]
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, paths: filePaths };
});

// 选一个文件夹，只回路径。
// 壁纸页的「小红车安装目录」是 D:\Steam\steamapps\common\wallpaper_engine 这种长路径，
// 让人对着资源管理器抄一遍既费神又容易错（错一个字符只会得到"目录不存在"）。
// 与 dialog:pick-modules 同口径：主进程只负责弹框、只返回路径字符串，
// 是否采用、写到哪个配置键，全由渲染进程/后端各自决定，这里不开"指哪读哪"的能力面。
ipcMain.handle('dialog:pick-dir', async (event) => {
  const win = windowOf(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
    title: '选择文件夹',
    buttonLabel: '选择此目录',
    properties: ['openDirectory']
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: filePaths[0] };
});

// 拖放反查路径：渲染进程只有 File 对象，拿不到 path（安全沙箱 + File.path 已废弃）。
// webUtils.getPathForFile 是官方替代，只返回路径、不给任何读写能力。
// 老版本 Electron 没有 webUtils 时回退到废弃的 File.path。
ipcMain.handle('file:path-for', (event, file) => {
  try {
    if (webUtils?.getPathForFile) return { ok: true, path: webUtils.getPathForFile(file) };
    const legacy = file?.path;
    if (legacy) return { ok: true, path: legacy, legacy: true };
    return { ok: false, reason: '当前 Electron 版本不支持 webUtils，且 File.path 不可用' };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle('ui:clear-bg-image', () => {
  try {
    const destDir = UI_BG_DIR();
    for (const f of fs.readdirSync(destDir)) {
      if (f.startsWith('bg-')) fs.rmSync(path.join(destDir, f), { force: true });
    }
  } catch { /* 目录不存在 = 本来就没有背景图 */ }
  return { ok: true };
});

// ── 启动失败兜底 ─────────────────────────────────────────────────────────
// 启动画面 45 秒仍连不上后端时，渲染进程会弹出失败卡片（见 ui/app/00-core.js 的
// showBootFailure）。卡片上有「打开日志目录」按钮，以及自动把失败 + 尾部日志上报给
// 主进程落盘，方便用户/开发者远程定位"到底卡在哪一步"。
// 路径与启动失败原生错误框（下方 app.whenReady 的 catch）保持一致：data/logs。

// 「打开日志目录」：在系统文件管理器里打开 data/logs。
ipcMain.handle('boot:open-log-dir', async () => {
  const dir = path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不成也照常尝试打开 */ }
  shell.openPath(dir).catch(() => {});
  return { ok: true, dir };
});

// 「上报启动失败」：渲染进程把 bootLogs 尾部 + 服务是否可达 发过来，写进主进程日志。
ipcMain.on('boot-failure', (_event, payload) => {
  const alive = payload && typeof payload.alive !== 'undefined' ? payload.alive : 'unknown';
  const logs = Array.isArray(payload?.logs) ? payload.logs.join('\n') : String(payload?.logs || '');
  logCritical('boot', `[启动失败卡片] 服务是否可达=${alive}\n${logs}`);
});

/* 打开协议端自带的控制台（WebUI）。SnowLuma / NapCat 装完都要人工去它的 WebUI
   里把 QQ 接进来（注入）、配 OneBot 网络，用户不该自己猜端口。
   外链白名单那条「本机地址不外开」（external-link.js 的 INTERNAL_HOSTS）不放松：
   渲染进程只能传一个枚举键，真正打开的地址在这里写死；除下表之外任何本机地址依然打不开。 */
const PROTOCOL_CONSOLE_URLS = Object.freeze({
  // SnowLuma：默认 WebUI，初始账号 admin，密码在启动日志里
  snowluma: 'http://localhost:5099',
  // NapCat：默认 WebUI；首次启动会打印带 token 的完整地址（config/webui.json 里也有）
  napcat: 'http://127.0.0.1:6099/webui'
});
ipcMain.handle('app:open-protocol-console', async (_event, which) => {
  const url = PROTOCOL_CONSOLE_URLS[String(which || '')];
  if (!url) return { ok: false, error: '未知的控制台' };
  try {
    await shell.openExternal(url);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// ── 窗口位置/尺寸持久化 ─────────────────────────────────────────────────────
// 窗口是 frame:false + 顶栏 -webkit-app-region: drag，本来就能像普通窗口一样拖到
// 屏幕任意位置。只写 new BrowserWindow({ width, height })、不记录 getBounds 也不
// 回填 x/y 的话，位置每次都从零开始，怎么拖都白拖。
//
// 存档放 data/window-state.json（与 config.json 同一个数据目录，用户看得见、可删）：
//   { x, y, width, height, maximized }
// 解析 + 屏幕可见性校验全在 ./window-state.js（纯函数，test/window-state-test.mjs
// 直接跑），这里只负责读文件、问屏幕、写文件。
// 校验不可省：换显示器 / 拔副屏后旧坐标可能指向不存在的区域，窗口会开到
// 看不见的地方，用户会以为程序打不开。不合法就回退默认尺寸 + 系统居中。
const WINDOW_STATE_FILE = () => path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'window-state.json');

function readWindowState() {
  let text;
  try { text = fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'); } catch { return null; }   // 没存过
  const parsed = parseWindowState(text);
  if (!parsed) return null;
  let displays = [];
  try { displays = screenApi?.getAllDisplays?.() ?? []; } catch { displays = []; }
  return resolveWindowBounds(parsed, displays, { minW: WINDOW_MIN_W, minH: WINDOW_MIN_H });
}

/** 把当前窗口几何写入 window-state.json（最大化时存"还原态"尺寸）。
 *  同文件里还有 widget 键（桌面悬浮小窗的位置/尺寸）。
 *  先读旧文件再合并写：看门狗重建主窗口的那一瞬间 mainWindow 为 null，
 *  而小窗 moved/resize 的防抖落盘随时可能到点，直接整体写会把主窗口的
 *  位置抹成默认值（用户"窗口自己跳回中间"就是这么来的）。
 *  @returns {{x:number,y:number,width:number,height:number,maximized:boolean,widget?:object}|null}
 *           实际写盘的内容；拿不到窗口时返回 null（调用方据此如实报"没存上"）。 */
function saveWindowState() {
  try {
    const out = {};
    try {
      const prev = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
      if (prev && typeof prev === 'object' && !Array.isArray(prev)) Object.assign(out, prev);
    } catch { /* 没有旧文件 / 读坏了：就当从零开始写 */ }
    let any = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // getNormalBounds() 给的是"还原后"的尺寸：从最大化退出再启动时，能先把窗口
      // 摆回原来的大小再重新最大化，而不会把默认 1360×860 当成真实尺寸。
      let b;
      try { b = mainWindow.getNormalBounds(); } catch { b = mainWindow.getBounds(); }
      out.x = b.x; out.y = b.y; out.width = b.width; out.height = b.height;
      out.maximized = mainWindow.isMaximized();
      any = true;
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = widgetWindow.getBounds();
      const rec = { x: b.x, y: b.y, width: b.width, height: b.height };
      // 贴边收起态（widget.edgeHide）落盘要存"展开态"坐标 + 标记：重启时先用
      // 正常位置建窗再立刻收起（见 readWidgetBounds）。直接存收起坐标的话，
      // 屏幕上只剩一条缝的窗口会被可见性校验判成"屏幕外"，重启后小窗不知所踪。
      if (widgetEdge && widgetEdge.normal) {
        rec.edgeHidden = 1;
        rec.nx = widgetEdge.normal.x;
        rec.ny = widgetEdge.normal.y;
      }
      out.widget = rec;
      any = true;
    }
    if (!any) return null;
    fs.mkdirSync(path.dirname(WINDOW_STATE_FILE()), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(out), 'utf8');
    return out;
  } catch (error) {
    logCritical('window', `[保存窗口位置失败] ${describeError(error)}`);
    return null;
  }
}

// moved / resize 是逐帧级的频率：防抖 400ms，别每帧写一次盘。
let winStateTimer = null;
function scheduleSaveWindowState() {
  if (winStateTimer) clearTimeout(winStateTimer);
  winStateTimer = setTimeout(() => { winStateTimer = null; saveWindowState(); }, 400);
}
/** 缩托盘/退出前把还没落盘的几何当场写掉（防抖窗口内退出不至于丢） */
function flushWindowState() {
  if (winStateTimer) { clearTimeout(winStateTimer); winStateTimer = null; }
  return saveWindowState();
}

// 设置页「保存当前排布」把窗口几何也一并落盘，与 moved/resize 的防抖写盘
// 共用同一条路径，只是这里不等防抖、当场写，并把结果回给页面显示。
// 无参数（与 preload 既有的安全边界一致：渲染进程指不了任何窗口）。
ipcMain.handle('win:save-geometry', () => {
  const saved = flushWindowState();
  if (!saved) return { ok: false };
  return { ok: true, ...saved };
});


// 本机控制台地址（127.0.0.1 / localhost / [::1] + 端口 + /）。
// 模块级：createWindow（主窗口）与 createWidgetWindow（悬浮小窗）的
// will-navigate 守卫共用同一个口径，避免两处正则各写各的、哪天改一头漏一头。
const isLocalConsole = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));

// 外部链接白名单（外链检查用）。模块级：createWindow（主窗口）与
// createWidgetWindow（悬浮小窗）的导航守卫共用。
const externalAllowHosts = () => {
  try {
    const extra = core?.getConfig()?.security?.externalHosts;
    return Array.isArray(extra) && extra.length
      ? [...DEFAULT_ALLOW_HOSTS, ...extra.map(String)]
      : DEFAULT_ALLOW_HOSTS;
  } catch { return DEFAULT_ALLOW_HOSTS; }
};

function createWindow(port) {
  // 记下窗口诞生时刻。second-instance 据此判断"还在正常启动中"与"真卡住了"。
  windowBornAt = Date.now();
  // 新窗口是干净的：没吃过 WS_EX_LAYERED，标记必须一起归位，否则"从没调低过"
  // 这个判断会被上一个窗口的状态带偏（见 mainWinLayered 的注释）。
  mainWinLayered = false;
  // 位置/尺寸回填。有存档就用存档（含 x/y），首启没有则不传 x/y，交给系统居中。
  const winOpts = { width: WINDOW_DEFAULT_W, height: WINDOW_DEFAULT_H };
  const savedWin = readWindowState();
  if (savedWin) Object.assign(winOpts, {
    x: savedWin.x, y: savedWin.y, width: savedWin.width, height: savedWin.height
  });
  mainWindow = new BrowserWindow({
    ...winOpts,
    minWidth: WINDOW_MIN_W,
    minHeight: WINDOW_MIN_H,
    title: describeInstance(),
    // 保持不透明。透明（分层）窗口只显示第一帧、之后永不更新，页面内部一切正常
    // （DOM/JS/CDP 抓图都好），就是屏幕上永远定格。实测 transparent:true 时
    // 8/10 轮冻结（GPU 开关、禁 DComp、禁遮挡检测全无效），false 时 9/9 轮正常。
    //
    // 真实原因：渲染进程每次启动都会调一次 win:set-opacity（哪怕配置是 100%），
    // 而 Electron 的 SetOpacity 在 Windows 上会无条件给窗口加 WS_EX_LAYERED 并调
    // SetLayeredWindowAttributes(LWA_ALPHA)，且没有"回到 1.0 就摘掉"的分支。
    // LWA_ALPHA（整窗统一 alpha）与真透明窗口用的逐像素 alpha 互斥，打上去之后
    // 透明窗口就只剩第一帧。8/10 与 9/9 的差异只是首帧合成与 setOpacity 的先后竞态。
    // 修复：渲染进程值不变就不发（ui/app/00-core.js 的 lastWinOpacity），
    // 主进程 100% 且从未调低过时直接返回（win:set-opacity 的 mainWinLayered）。
    //
    // 但默认仍然不透明：主窗口是整块画布（html 铺满 --frame-bg，卡片之间没有留白），
    // 真透明等于把整套视觉重做成"悬浮卡片"，不是加个开关的事。
    // 圆角继续交给 Win11 DWM（下面 roundedCorners: true）：真圆角、弧外透出桌面、
    // 不依赖透明窗口。页面自绘的圆角壳已归零（style.css --win-radius: 0），
    // 两层圆角叠加会在角落露出 --frame-bg 深色弧片。
    // Win10（build < 22000）DWM 不给圆角，那时窗口是直角矩形，这是平台限制。
    transparent: false,
    hasShadow: false,
    // 只在页面加载前的一瞬间可见；页面加载后画布被 --frame-bg 接管（跟随主题）。
    backgroundColor: '#141821',
    // Win11 DWM 原生圆角（真圆角）。不支持的平台/系统上窗口为直角矩形，无害回退。
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    // 无边框：去掉系统标题栏，把标题栏并入页面顶部的导航条（与 PCL 启动器一致）。
    // 保留 thickFrame 默认值（true），这样还能有系统 hit-test 边框与 Aero Snap。
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 沙箱：默认开启（不传 --no-sandbox 时 Chromium 的默认行为）。
      // 显式写出来而不是留给默认值：一是意图显式化，将来有人加命令行开关时
      // 能看到"沙箱是被有意决策过的"；二是新增窗口（webview / 弹窗）能独立决策，
      // 不会继承一个全局关闭状态。
      // 真正降级请走 QQ_AGENT_NO_SANDBOX=1（见文件上方），不要写死在这里。
      sandbox: true,
      // 后台节流必须关。窗口被游戏/浏览器全屏遮挡时，Chromium 的原生遮挡检测
      // 会把页面当"隐藏页"，把定时器节流到分钟级，页面里 1 秒一跳的活性心跳
      // （__qaBeat）随之停摆，看门狗据此误判"渲染僵死"→ 拆窗重建。
      // 群友反馈的"自行崩溃""任务栏闪烁"都是重建的副作用。
      backgroundThrottling: false,
      // 仅暴露窗口控制（最小化/最大化/关闭/查询状态），见 electron/preload.cjs
      preload: PRELOAD_PATH
    }
  });
  Menu.setApplicationMenu(null);
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击。
  // 本窗口是新的，"显示过"标志要跟着重置（重建窗口后仍要能正常亮相）。
  windowEverShown = false;
  mainWindow.once('ready-to-show', () => {
    // 缩在托盘时（用户点过 ✕）不亮相，重建/重载窗口也要保持隐藏
    if (windowHidden) return;
    windowEverShown = true;
    mainWindow?.show();
    // 任务栏图标兜底：部分 Windows 上无边框窗口的任务栏图标不吃 BrowserWindow
    // 的 icon 选项（表现为空白页图标）。show 之后显式 setIcon 一次，两条路都喂到。
    try { mainWindow?.setIcon(ICON_PATH); } catch { /* 图标缺失时忽略 */ }
  });
  // 只有首次加载完成才 focus。看门狗重载/失败重试也会触发本事件，此时用户可能
  // 正在全屏游戏或别的窗口里，无条件 focus 会抢焦点。判据用模块级 focusedOnce
  // 而不是局部量：看门狗重建窗口会再走一次 createWindow()，局部标志随之复活。
  // 两个"失败预算"的声明放在事件注册之前：回调里读写它们若靠"事件是异步的、
  // 声明早就求值完"的时序侥幸，谁把 loadURL 往前挪一步就是 TDZ ReferenceError。
  let rendererCrashCount = 0;
  let loadFailRetries = 0;   // 加载失败重试计数，成功后归零
  mainWindow.webContents.on('did-finish-load', () => {
    // 加载成功 = 渲染进程恢复健康，两个"失败预算"一起归零。只增不减的话，
    // 注释写的"连崩 5 次就放弃"会变成"累计崩 5 次就放弃"，长跑实例历史上崩过
    // 5 次后，第 6 次真崩溃没人救。
    rendererCrashCount = 0;
    loadFailRetries = 0;
    // 缩在托盘时不弹回前台；非首次完成不抢焦点
    if (windowHidden) return;
    // 最小化这条路也要一起挡：看门狗重载 / did-fail-load 重试成功后同样会走到
    // 这里，而 show() 会把最小化的窗口恢复并抢焦点，用户看到的是"我明明最小化了，
    // 它自己又跳出来"。
    try { if (mainWindow?.isMinimized()) return; } catch { /* 窗口已销毁 */ }
    // 已显示过的窗口不再重复 show()（show 自带激活语义 = 每次重载抢一次焦点）。
    // 首次亮相仍在这里兜底（万一 ready-to-show 没触发）。
    if (!windowEverShown) {
      windowEverShown = true;
      mainWindow?.show();
    }
    if (!focusedOnce) {
      focusedOnce = true;
      mainWindow?.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logCritical('window', `[页面加载失败] code=${code} desc=${desc} url=${url}`);
    // 固定 2 秒无限重试会变成请求风暴 + 用户永远停在失败页。2s→4s→8s→16s 封顶，
    // 5 次后放弃（放弃时页面自身的 45s showBootFailure 兜底会展示"重新加载界面"按钮）。
    loadFailRetries += 1;
    if (loadFailRetries > 5) {
      logCritical('window', `[页面加载失败] 已重试 5 次仍未恢复，放弃自动重试（请查看启动日志定位服务未就绪的原因）`);
      return;
    }
    const delay = Math.min(2000 * 2 ** (loadFailRetries - 1), 16000);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), delay);
  });
  // 渲染进程崩溃自动重载：renderer 一死窗口就变成"定格的最后一帧"，用户看到的是
  // 应用卡死且没有任何提示。崩溃后 1.5s 重新 loadURL（服务在主进程里、一直活着，
  // 重载即可恢复）。连崩 5 次就放弃重载，避免真有代码级崩溃时陷入死循环。
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logCritical('window', `[渲染进程崩溃] ${JSON.stringify(details)}`);
    if (++rendererCrashCount <= 5) {
      setTimeout(() => {
        try { mainWindow?.webContents.loadURL(`http://127.0.0.1:${port}/`); } catch { /* 窗口已销毁 */ }
      }, 1500);
    }
  });
  // Electron 自带的"无响应"事件。它只在窗口可见且有持续输入事件时才触发，
  // 而且要等约 15 秒，所以不是可靠的探活机制（看门狗的 probePage 才是），
  // 但它是"用户此刻正在点、正在着急"的最强信号，收到了就立刻复核一次。
  mainWindow.webContents.on('unresponsive', () => {
    logCritical('window', '[渲染进程无响应] unresponsive：主线程约 15s 未处理输入');
    probePage(mainWindow).then(async (probe) => {
      logCritical('window', `[unresponsive 复核结果] ${probe.state}`);
      if (probe.state === 'hung' || probe.state === 'boot') await healIfStuck('unresponsive 事件', probe.state);
    }).catch((error) => logCritical('window', `[unresponsive 复核失败] ${describeError(error)}`));
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[window] 渲染进程恢复响应');
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 渲染进程的报错（level 3 = error）直接落盘。只 console.log 的话打包版不落盘，
    // 群友发来的日志里永远看不到"页面这一侧为什么没起来"。
    if (level >= 3) logCritical('renderer', `[渲染进程报错] ${message} (${sourceId}:${line})`);
    else if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  // preload 挂掉时 window.qa 桥整个缺失，页面会永远停在启动画面，
  // 而主进程这侧唯一的痕迹就是看门狗报"启动未就绪"，必须把 preload 的报错接住。
  mainWindow.webContents.on('preload-error', (_e, path, error) => {
    logCritical('renderer', `[preload 失败] ${path} :: ${describeError(error)}`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => logCritical('window', `[loadURL 失败] ${describeError(error)}`));
  // 启动看门狗：后端一直在跑、窗口也活着，但页面可能永远停在 loading 壳上，
  // 用户没有任何反馈也没有任何出路。主进程每 5 秒问一句"你还活着吗"（probePage），
  // 据此分别采取重载 / 重建窗口。
  startBootWatchdog();
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器。
  //
  // 不能只看 /^https?:\/\// 前缀。会被外开的目标有两个来源，都不完全受控：
  //   ① 远端 JSON（金句墙/意见墙/更新提示）里的 <a href>（ui/app/09-community.js 直接渲染）；
  //   ② 模型输出里的网址。
  // 而 shell.openExternal 对非 http 协议是"让系统执行它"，不是"打开一个网页"，
  // file:///C:/x.exe、ms-msdt: 之类等于一键执行。加上 https://trusted@evil.com 这种
  // userinfo 混淆，前缀判断完全挡不住。判据统一走 external-link.js（协议白名单 +
  // 拒绝 userinfo + 拒绝本机地址 + 主机白名单），四条全过才放行。
  // 被拦时一定要留日志：否则用户看到的是"点了链接没反应"，无从判断是白名单拦的。
  const openExternalChecked = (raw, where) => {
    const r = checkExternalUrl(raw, externalAllowHosts());
    if (!r.ok) {
      console.warn(`[外链拦截] ${where}：${r.reason} → ${String(raw ?? '').slice(0, 200)}`);
      return false;
    }
    shell.openExternal(r.url);
    return true;
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalChecked(url, 'window.open');
    return { action: 'deny' };
  });
  // 主窗口只应停留在本机控制台。没有这道拦截时，页面里一个普通 <a href> 或
  // location.href=... 就能把主窗口导航到外部站点（脱离 127.0.0.1 源、
  // 控制台也不再指向本机）。外链改走系统浏览器。
  const guardNavigation = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    openExternalChecked(url, 'will-navigate');
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯。
  // 每一步都记一笔：这条链上原本一行日志都没有，"点了 ✕ 到底走了哪个分支"
  // 事后完全无从查证。
  mainWindow.on('close', (event) => {
    const toTray = !quitting && core?.getConfig().server?.closeToTray !== false;
    console.log(`[close] 收到 close 事件：quitting=${quitting} closeToTray=${core?.getConfig().server?.closeToTray} → ${toTray ? '缩到托盘（阻止关闭）' : '真正关闭'}`);
    flushWindowState();              // 先把几何落盘，再决定是缩托盘还是真退出
    if (toTray) {
      event.preventDefault();
      windowHidden = true;
      // 缩托盘前先把窗口从任务栏/切换器注销（setSkipTaskbar(true)）。
      // 窗口处于"已隐藏但仍注册在切换器"的状态时，Win11 的 DWM 在全屏切换/
      // 桌面切换时有概率把旧条目复制一份成幽灵条目，Alt+Tab 里就会堆出一排
      // QQ Agent。hide 前注销、show 时（showWindow）再注册回来。
      // 这与窗口是否透明无关，只与"隐藏但仍注册"有关。
      try { mainWindow.setSkipTaskbar(true); } catch { /* 老版本无此 API 时忽略 */ }
      mainWindow.hide();
      console.log('[close] 已隐藏到托盘（进程继续运行）');
    }
  });
  mainWindow.on('closed', () => {
    console.log('[close] 窗口已销毁（closed）');
    if (!rebuilding) mainWindow = null;   // 重建窗口期间由 rebuildWindow 自己接管
  });
  // 最大化状态回推：渲染进程据此把右上角按钮的图标切成"还原"。
  // 不只我们点的按钮会改状态，Win+↑、双击拖拽区、Aero Snap 拖到屏幕边缘都会，
  // 所以必须以主进程事件为准，而不是在页面里自己翻转一个布尔值。
  const pushMaximized = (value) => mainWindow?.webContents.send('win:maximized-changed', value);
  mainWindow.on('maximize', () => pushMaximized(true));
  mainWindow.on('unmaximize', () => pushMaximized(false));
  // 窗口几何/最大化状态变化时记一笔（防抖），供下次启动回填。
  mainWindow.on('moved', scheduleSaveWindowState);
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('maximize', scheduleSaveWindowState);
  mainWindow.on('unmaximize', scheduleSaveWindowState);
  // 上次退出时是最大化 → 现在也还原成最大化（先按存档尺寸建好再最大化，
  // 这样"还原"按钮能回到存档的那个大小，而不是默认尺寸）。
  if (savedWin && savedWin.maximized) {
    try { mainWindow.maximize(); } catch { /* 个别平台/时机不支持时忽略 */ }
  }
}

// ── 桌面悬浮小窗 ─────────────────────────────────────────────────────────
// 设置 → 界面与应用 → 桌面端打开后，桌面右下角（默认）出现一张无边框小卡片：
// 今日用量 / 缓存命中率 / 机器人连接状态。设计约束（每条都是踩过的坑）：
//   ① 默认档：真透明（widget.transparent）+ 不透明度 50%，卡片浮在桌面上、能看见
//      桌面。透明分层窗口的呈现链路在本机坏过（只显示第一帧后冻结，见 createWindow
//      的 BrowserWindow 选项注释），所以设置里标「实验」；出问题的用户关掉该项、
//      把不透明度调回 100 即可回到不透明深色卡。
//   ② 几何不写 config.json：与主窗口一起落 window-state.json 的 widget 键。
//      配置里可有密钥，不该每次拖动都整份重写它。
//   ③ 配置变更没有钩子（updateConfig 不通知任何人），主进程轮询比对"设置签名"。
//      签名只含 enabled/置顶/穿透/透明/尺寸/刷新间隔，不含位置，
//      否则"拖一下 → 存几何 → 配置变更 → 又建窗"会自环。
//   ④ 页面零 IPC：整卡 -webkit-app-region:drag 自己拖；右键菜单由页面自绘，
//      动作经极窄 preload 桥回主进程；置顶/穿透/尺寸/关闭/打开主界面全在主进程完成。
//   ⑤ 贴边收起（QQ 式，widget.edgeHide）：只在松开鼠标后判定（'moved'，
//      拖动过程中判定会让窗口跟着光标反复收起/展开）；展开探测用主进程轮询
//      光标位置（不依赖页面定时器，收起态也测得准）。
const WIDGET_SIZES = {
  s: { width: 216, height: 104 },
  m: { width: 264, height: 132 },
  l: { width: 336, height: 168 }
};
const WIDGET_SIZE_ORDER = ['s', 'm', 'l'];
let widgetSettingsSigCache = '';
// 每个小窗自己的加载重试计数（建窗时归零；ESM 是严格模式，必须先声明再赋值）
let widgetLoadRetries = 0;

function widgetCfg() {
  try { return core?.getConfig()?.widget || {}; } catch { return {}; }
}

/** 背景不透明度（百分数，夹到 30~100）。默认 50 = 半透明卡片。 */
function widgetOpacityPct(w) {
  const n = Number(w?.opacity);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(100, Math.max(30, Math.round(n)));
}

/** 设置签名（位置刻意不在内，见上方 ③）。 */
function widgetSettingsSig(w) {
  const size = WIDGET_SIZE_ORDER.includes(w?.size) ? w.size : 'm';
  const ms = Math.min(60000, Math.max(1000, Number(w?.refreshMs) || 2500));
  return [w?.enabled ? 1 : 0, w?.alwaysOnTop === false ? 0 : 1, w?.clickThrough ? 1 : 0,
    w?.transparent ? 1 : 0, size, ms, w?.edgeHide === false ? 0 : 1,
    widgetOpacityPct(w)].join('|');
}

/**
 * 哪些设置变化必须重建窗口（另一类改置顶/穿透/尺寸都能运行时热改）：
 *   ① transparent：透明度建窗时决定，运行期改不了；
 *   ② 不透明度跨 100 这条线：<100 要挂 mica 毛玻璃背板，同样建窗时决定。
 *      100 以下内部调整（55→60）不重建，页面读 /api/config 改 CSS 即可。
 */
function widgetNeedsRebuild(prevSig, w) {
  const prev = prevSig ? String(prevSig).split('|') : [];
  if (prev.length !== 8) return false;              // 首轮 / 签名形状不认识：不重建
  if ((prev[3] === '1') !== !!w?.transparent) return true;
  if (Number(prev[7]) !== widgetOpacityPct(w)) {
    // 只在"跨 100"时重建：两边都 <100（或都 =100，sig 相同根本不会到这）无需重建
    if (Number(prev[7]) === 100 || widgetOpacityPct(w) === 100) return true;
  }
  return false;
}

/** 存档里的小窗几何；没有/不可见（换显示器、拔副屏）时返回 null → 用默认位置。
 *  贴边收起态存档带 edgeHidden:1 + nx/ny（展开态坐标）：调用方拿到后先按
 *  正常位置建窗、再立刻收起，详见 saveWindowState 里的对应注释。 */
function readWidgetBounds(size) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8')); } catch { return null; }
  const w = raw?.widget;
  const dim = WIDGET_SIZES[size] || WIDGET_SIZES.m;
  if (!Number.isFinite(w?.x) || !Number.isFinite(w?.y)) return null;
  const width = Number.isFinite(w?.width) ? Math.max(160, Math.min(600, Math.round(w.width))) : dim.width;
  const height = Number.isFinite(w?.height) ? Math.max(88, Math.min(600, Math.round(w.height))) : dim.height;
  const x = Math.round(w.x);
  const y = Math.round(w.y);
  // 沿用主窗口的判据：与任一块屏幕的工作区有交集才算可见（坐标为负合法：副屏在左/上）
  let displays = [];
  try { displays = screenApi?.getAllDisplays?.() ?? []; } catch { displays = []; }
  const onScreen = (px, py) => (Array.isArray(displays) ? displays : []).some((d) => {
    const a = d?.workArea;
    return a && Number.isFinite(a.x) && Number.isFinite(a.y)
      && Number.isFinite(a.width) && Number.isFinite(a.height)
      && px < a.x + a.width && px + width > a.x && py < a.y + a.height && py + height > a.y;
  });
  // 收起态存档：展开位还看得见就回展开位（建窗后再收起）；展开位丢了（拔副屏、
  // 换分辨率）就当没这档、回默认位置。绝不能拿收起坐标开窗：那样小窗会以
  // "一条缝"的形态开机，widgetEdge 又是 null、没人给它开展开轮询 = 永远消失。
  if (w?.edgeHidden) {
    if (Number.isFinite(w.nx) && Number.isFinite(w.ny)) {
      const nx = Math.round(w.nx);
      const ny = Math.round(w.ny);
      if (onScreen(nx, ny)) return { x: nx, y: ny, width, height, edgeHidden: 1 };
    }
    return null;
  }
  return onScreen(x, y) ? { x, y, width, height } : null;
}

/** 没有存档时的默认位置：主屏工作区右下角（24px 边距，避开任务栏）。 */
function widgetDefaultBounds(size) {
  const dim = WIDGET_SIZES[size] || WIDGET_SIZES.m;
  let area = null;
  try { area = screenApi?.getPrimaryDisplay?.()?.workArea ?? null; } catch { area = null; }
  if (!area || !Number.isFinite(area.width) || !Number.isFinite(area.height)) return { ...dim };
  return {
    x: Math.round(area.x + area.width - dim.width - 24),
    y: Math.round(area.y + area.height - dim.height - 24),
    width: dim.width,
    height: dim.height
  };
}

// ── 贴边收起（QQ 式）──────────────────────────────────────────────────────
// 拖到屏幕工作区边缘 → 当场收起，屏幕内只留一条 6px 细缝；鼠标移到缝附近 →
// 整卡弹回收起前的位置；直接把细缝拖走也会弹回。三条恢复路径与"穿透"对齐：
// 悬停展开、右键菜单「展开悬浮窗」、关掉设置/右键里的同名开关。
// 悬停展开的那一张，鼠标移开卡片就滑回细缝；手动从细缝拖出来 / 菜单展开的保持不动。
const WIDGET_EDGE_THRESHOLD = 6;   // 离工作区边缘多近算"贴边"
const WIDGET_EDGE_SLIVER = 6;      // 收起后留在屏幕内的像素（一条细缝）
const WIDGET_EDGE_REVEAL_PX = 30;  // 鼠标距细缝多近算"要展开"
const WIDGET_EDGE_REVEAL_PY = 64;  // 纵向放宽：不用精确对准细缝的那几十像素
// 贴边判定要等拖动"落定"再做：部分机器上 moved 在拖动过程中连续触发，
// 立刻收起会和光标打架（收了 → 光标还在边上 → 又被判成"拖细缝"弹回来）。
const WIDGET_EDGE_SETTLE_MS = 260;
// 展开后的静默期：只盖住 140ms 滑出动画自身。这不是主要防线，真正的防线是
// 下面 400ms 的 programmatic 窗口：动画帧的 'moved' 全被它吃掉，进不到贴边判定。
// 曾设成 1200ms，结果用户刚展开就拖不回边缘，压到 150ms。
const WIDGET_REVEAL_QUIET_MS = 150;
// 收起后必须先"见过鼠标离开一次"才允许悬停展开。否则用户把卡片拖到边上松手，
// 光标正停在边上的判定区里，收起后 0.1 秒就被自己弹回来。
let widgetEdgeArmed = true;
let widgetEdgeSettleTimer = null;
// 作废挂起的"贴边判定"：展开时若还有一条 260ms 定时器在排队，它会拿展开前的
// 旧坐标去判定，刚展开又收起。与动画定时器一样，紧挨着状态变量声明，
// 避免在 widgetRevealEdge / widgetOnMoved 里引用到尚未初始化的 const。
const widgetCancelEdgeSettle = () => {
  if (widgetEdgeSettleTimer) { clearTimeout(widgetEdgeSettleTimer); widgetEdgeSettleTimer = null; }
};
// 收起态状态机：null = 正常展开；{ side, normal, hidden } = 已贴边收起。
// normal/hidden 各存一份完整 bounds：展开要回得去，收起坐标要比得对。
let widgetEdge = null;
let widgetEdgeTimer = null;        // 光标轮询：收起态探测"移近"，悬停展开后盯着"移开"
let widgetEdgeQuietUntil = 0;      // 展开后的静默期：只盖住滑出动画自身
// 本次展开是不是"鼠标靠近"造成的。只有它才需要"鼠标移开就收回"，
// 用户从细缝里拖出来的、菜单点展开的都保持不动。
let widgetEdgeHoverReveal = false;
// 程序性 setBounds 标记：置位后 400ms 内的 'moved' 是我们自己动的窗，不参与
// "贴边收起"判定，否则改尺寸/透明重建都会让卡片在用户没拖的情况下自己收起。
// setBounds 触发的 moved 与用户拖动的 moved 在事件流上无法区分，只能这样标记。
// 用时间戳而非布尔：位置没变时 setBounds 不发 moved，布尔标志会残留到下一次
// 用户拖动、把那次判定吞掉；时间戳最迟 400ms 后自动失效。
const WIDGET_EDGE_PROG_MS = 400;
let widgetProgrammaticAt = 0;
const widgetProgrammaticMove = (win, b) => {
  widgetProgrammaticAt = Date.now();
  try { win.setBounds(b); } catch { /* 忽略 */ }
};

// 收起/展开的滑动动画：直接 setBounds 一步跳过去太生硬。
//   · 每帧都走 widgetProgrammaticMove，动画自己的 moved 回响不能参与贴边判定；
//   · 新动画开始先掐掉上一条（否则两条动画抢同一个窗口，卡片会左右抽搐）；
//   · 只动位置不动尺寸（收起/展开本来就是同一个窗口整体平移）。
const WIDGET_ANIM_MS = 140;
let widgetAnimTimer = null;
function widgetAnimateBounds(win, from, to) {
  if (widgetAnimTimer) { clearTimeout(widgetAnimTimer); widgetAnimTimer = null; }
  if (!win || win.isDestroyed()) return;
  const t0 = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);        // ease-out：起步快、收尾稳
  const step = () => {
    if (win.isDestroyed()) { widgetAnimTimer = null; return; }
    const t = Math.min(1, (Date.now() - t0) / WIDGET_ANIM_MS);
    const k = ease(t);
    widgetProgrammaticMove(win, {
      x: Math.round(from.x + (to.x - from.x) * k),
      y: Math.round(from.y + (to.y - from.y) * k),
      width: from.width,
      height: from.height
    });
    if (t < 1) { widgetAnimTimer = setTimeout(step, 16); return; }
    widgetAnimTimer = null;
  };
  step();
}
const widgetCancelAnim = () => {
  if (widgetAnimTimer) { clearTimeout(widgetAnimTimer); widgetAnimTimer = null; }
};

/** 小窗所在屏幕的工作区（窗口中心点落点判定；失败回退主屏）。 */
function widgetWorkArea(win) {
  let displays = [];
  try { displays = screenApi?.getAllDisplays?.() ?? []; } catch { displays = []; }
  const list = Array.isArray(displays) ? displays : [];
  let b = null;
  try { b = win?.getBounds?.() ?? null; } catch { b = null; }
  if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
    const cx = b.x + (b.width || 0) / 2;
    const cy = b.y + (b.height || 0) / 2;
    const hit = list.find((d) => {
      const a = d?.workArea;
      return a && Number.isFinite(a.x) && Number.isFinite(a.width) && Number.isFinite(a.y) && Number.isFinite(a.height)
        && cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height;
    });
    if (hit) return hit.workArea;
  }
  try { return screenApi?.getPrimaryDisplay?.()?.workArea ?? null; } catch { return null; }
}

/** 窗口贴在哪条工作区边上（阈值 6px）；没贴返回 null。 */
function widgetFlushSide(b, area) {
  if (!b || !area || !Number.isFinite(area.x) || !Number.isFinite(area.width)) return null;
  const t = WIDGET_EDGE_THRESHOLD;
  if (Math.abs(b.x + b.width - (area.x + area.width)) <= t) return 'right';
  if (Math.abs(b.x - area.x) <= t) return 'left';
  if (Math.abs(b.y - area.y) <= t) return 'top';
  if (Math.abs(b.y + b.height - (area.y + area.height)) <= t) return 'bottom';
  return null;
}

/** 收起后的坐标：整窗移到工作区外，屏幕内只留 WIDGET_EDGE_SLIVER 一条缝。 */
function widgetSliverBounds(b, area, side) {
  if (side === 'right') return { x: Math.round(area.x + area.width - WIDGET_EDGE_SLIVER), y: b.y, width: b.width, height: b.height };
  if (side === 'left') return { x: Math.round(area.x - b.width + WIDGET_EDGE_SLIVER), y: b.y, width: b.width, height: b.height };
  if (side === 'top') return { x: b.x, y: Math.round(area.y - b.height + WIDGET_EDGE_SLIVER), width: b.width, height: b.height };
  return { x: b.x, y: Math.round(area.y + area.height - WIDGET_EDGE_SLIVER), width: b.width, height: b.height };
}

const widgetBoundsEq = (a, b) => !!a && !!b
  && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * 展开：回收起前的位置（悬停 / 右键菜单 / 关掉开关 / 拖走细缝都会走到这）。
 * @param {string} reason 日志用
 * @param {boolean} [instant] 直接归位、不做动画。用户正在拖窗口时必须这样：
 *   动画每 16ms 一次 setBounds 会和用户的拖动抢同一个窗口，
 *   而且动画期间的 programmatic 标记会把用户的 moved 全部吞掉。
 */
function widgetRevealEdge(reason, instant) {
  if (!widgetEdge) return;
  const normal = widgetEdge.normal;
  widgetEdge = null;
  widgetEdgeQuietUntil = Date.now() + WIDGET_REVEAL_QUIET_MS;
  widgetCancelEdgeSettle();                   // 挂起的"贴边判定"作废，别刚展开又收
  widgetStopEdgePoll();
  // 只有"鼠标靠近"展开的才需要继续盯光标：移开就滑回细缝。
  // 拖细缝 / 页面菜单 / 关开关展开的都保持不动，轮询可以停。
  widgetEdgeHoverReveal = reason === '鼠标靠近';
  if (widgetEdgeHoverReveal) widgetStartEdgePoll();
  const win = widgetWindow;
  if (win && !win.isDestroyed() && normal) {
    if (instant) {
      widgetCancelAnim();
      widgetProgrammaticMove(win, normal);
    } else {
      // 从"此刻真实位置"滑回去：可能正停在收起位，也可能上一条动画还没跑完
      let cur = normal;
      try { cur = win.getBounds(); } catch { /* 用 normal 兜底 */ }
      widgetAnimateBounds(win, cur, normal);
    }
    scheduleSaveWindowState();
  }
  logKey('widget', `悬浮窗已展开（${reason}）`);
}

/** 进入收起态：算边、移窗、开轮询。bounds 是"展开态"坐标；失败返回 false。 */
function widgetEnterEdgeState(bounds) {
  const win = widgetWindow;
  if (!win || win.isDestroyed()) return false;
  const area = widgetWorkArea(win);
  if (!area) return false;
  const side = widgetFlushSide(bounds, area);
  if (!side) return false;
  const hidden = widgetSliverBounds(bounds, area, side);
  widgetEdge = {
    side,
    normal: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    hidden
  };
  widgetEdgeArmed = false;                        // 先不展开：等鼠标离开过一次
  widgetEdgeHoverReveal = false;                  // 新的一次收起，"移开就收回"重新计
  widgetAnimateBounds(win, bounds, hidden);      // 滑出去，不是一步跳走
  widgetStartEdgePoll();
  return true;
}

/** 拖动结束：贴边就收起（开关没开 / 已收起 / 静默期内 / 无工作区时直接返回）。 */
function widgetTryEdgeHide() {
  if (widgetEdge) return;
  let w = {};
  try { w = widgetCfg(); } catch { /* 忽略 */ }
  if (!w.edgeHide) return;
  if (Date.now() < widgetEdgeQuietUntil) return;
  const win = widgetWindow;
  if (!win || win.isDestroyed()) return;
  let b = null;
  try { b = win.getBounds(); } catch { return; }
  if (widgetEnterEdgeState(b)) {
    scheduleSaveWindowState();
    logKey('widget', `悬浮窗已贴边收起（${widgetEdge.side}，鼠标移近即展开）`);
  }
}

/** 'moved' 事件入口。收起态下坐标变了 = 用户把细缝拖走了，弹回展开态。 */
function widgetOnMoved() {
  // 我们自己 setBounds 的带回响（400ms 窗口内），跳过（否则改尺寸/重建被当成用户拖动）
  if (Date.now() - widgetProgrammaticAt < WIDGET_EDGE_PROG_MS) return;
  const win = widgetWindow;
  if (!win || win.isDestroyed()) return;
  let b = null;
  try { b = win.getBounds(); } catch { return; }
  if (widgetEdge) {
    // 用户正拖着细缝：立刻归位，别用动画（会跟拖动抢窗口）
    if (!widgetBoundsEq(b, widgetEdge.hidden)) widgetRevealEdge('拖动细缝', true);
    return;
  }
  // 拖动中 moved 会连着来：等它停稳 260ms 再判定，避免与光标互相打架。
  // 用户真的在拖窗了，"鼠标移开就收回"那套追踪到此为止（否则拖到一半被收走）。
  // 这一行只在程序性窗口过期后才走得到：收回动画自身的 moved 不会误伤。
  if (widgetEdgeHoverReveal) { widgetEdgeHoverReveal = false; widgetStopEdgePoll(); }
  widgetCancelEdgeSettle();
  widgetEdgeSettleTimer = setTimeout(() => {
    widgetEdgeSettleTimer = null;
    widgetTryEdgeHide();
  }, WIDGET_EDGE_SETTLE_MS);
}

function widgetStopEdgePoll() {
  if (widgetEdgeTimer) { clearInterval(widgetEdgeTimer); widgetEdgeTimer = null; }
}

/** 光标是否落在矩形附近（外扩 margin px），"鼠标移开就收回"的离卡判定用。 */
function widgetCursorNearRect(p, b, margin) {
  if (!p || !b) return false;
  return p.x >= b.x - margin && p.x <= b.x + b.width + margin
      && p.y >= b.y - margin && p.y <= b.y + b.height + margin;
}

/**
 * 光标轮询：120ms 一次读光标（主进程 API，不依赖页面定时器），一个轮询两种状态：
 *   ① 收起态     → 探测"移近"，上膛后展开（基准是细缝露在屏幕里的那条边）；
 *   ② 悬停展开态 → 探测"移开"，光标离开卡片（含 30px 余量）就滑回细缝。
 * 余量是必需的：触发展开的那个光标通常就停在细缝边，而细缝边往往落在卡片
 * 矩形之外（卡片是整只滑出来的），不给余量会刚展开就立刻收回去。
 */
function widgetStartEdgePoll() {
  if (widgetEdgeTimer) return;
  widgetEdgeTimer = setInterval(() => {
    try {
      const win = widgetWindow;
      if (!win || win.isDestroyed()) { widgetStopEdgePoll(); return; }
      const p = screenApi?.getCursorScreenPoint?.();
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      if (widgetEdge) {
        const h = widgetEdge.hidden;
        const s = WIDGET_EDGE_SLIVER;
        // 判定基准是"细缝露在屏幕里的那一条边"，不是窗口露在屏幕外的那一头：
        //   right  收起后 x=右边界-6 → 可见缝在 [h.x, h.x+6]，基准 h.x+6
        //   left   展开后 x=左边界-宽+6 → 可见缝在最右端，基准 h.x+h.width-6
        //   top/bottom 同理（top 可见缝在最下端，bottom 可见缝在最上端）
        let near = false;
        if (widgetEdge.side === 'right') near = p.x >= h.x + s - WIDGET_EDGE_REVEAL_PX;
        else if (widgetEdge.side === 'left') near = p.x <= h.x + h.width - s + WIDGET_EDGE_REVEAL_PX;
        else if (widgetEdge.side === 'top') near = p.y <= h.y + h.height - s + WIDGET_EDGE_REVEAL_PX;
        else near = p.y >= h.y + s - WIDGET_EDGE_REVEAL_PX;
        // 同一段内还要求落在卡片所在区段附近（鼠标在屏幕另一端不该把窗弹出来）
        if (near && (widgetEdge.side === 'right' || widgetEdge.side === 'left')) {
          near = p.y >= h.y - WIDGET_EDGE_REVEAL_PY && p.y <= h.y + h.height + WIDGET_EDGE_REVEAL_PY;
        } else if (near) {
          near = p.x >= h.x - WIDGET_EDGE_REVEAL_PY && p.x <= h.x + h.width + WIDGET_EDGE_REVEAL_PY;
        }
        // 上膛逻辑：收起那一刻光标往往就停在判定区里（刚拖过去的），
        // 必须先见过它离开一次，才认"鼠标靠近"是要展开，否则收了立刻弹回。
        if (!near) { widgetEdgeArmed = true; return; }
        if (!widgetEdgeArmed) return;
        widgetRevealEdge('鼠标靠近');
      } else if (widgetEdgeHoverReveal) {
        // 鼠标移开了 → 收回细缝。卡片若已被拖离边缘，widgetEnterEdgeState 会自己
        // 返回 false，那就说明用户不想让它贴边：停止追踪、保持展开。
        const b = win.getBounds();
        if (widgetCursorNearRect(p, b, WIDGET_EDGE_REVEAL_PX)) return;
        widgetEdgeHoverReveal = false;
        // 开关可能在悬停展开之后又被关掉（设置页 / 右键菜单），那就不能再自动收
        let w = {};
        try { w = widgetCfg(); } catch { /* 忽略：当没配处理 */ }
        if (!w.edgeHide) { widgetStopEdgePoll(); return; }
        if (widgetEnterEdgeState(b)) {
          scheduleSaveWindowState();
          logKey('widget', '悬浮窗已贴边收起（鼠标移开，移近即展开）');
        } else {
          widgetStopEdgePoll();
        }
      } else {
        widgetStopEdgePoll();   // 收起态没了、悬停追踪也没了，轮询没有存在意义
      }
    } catch { /* 轮询回调里不抛 */ }
  }, 120);   // 120ms：加上 140ms 的滑出动画，从"鼠标靠近"到卡片归位约 1/4 秒
  if (typeof widgetEdgeTimer?.unref === 'function') widgetEdgeTimer.unref();
}

/**
 * 自绘菜单（页面画）唯一的参数入口：只认白名单里的键，逐键校验 + 夹取。
 * 渲染进程传什么都改不了白名单之外的东西，这是"页面能改设置"能接受的前提。
 * @returns {object|null} 过滤后的 patch；一个有效键都没有时返回 null（调用方据此不动配置）。
 */
function sanitizeWidgetPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const putBool = (key) => { if (typeof raw[key] === 'boolean') out[key] = raw[key]; };
  ['enabled', 'alwaysOnTop', 'clickThrough', 'edgeHide', 'transparent'].forEach(putBool);
  if (WIDGET_SIZE_ORDER.includes(raw.size)) out.size = raw.size;
  const opa = Number(raw.opacity);
  if (Number.isFinite(opa) && opa > 0) out.opacity = Math.min(100, Math.max(30, Math.round(opa)));
  const ms = Number(raw.refreshMs);
  if (Number.isFinite(ms) && ms > 0) out.refreshMs = Math.min(60000, Math.max(1000, Math.round(ms)));
  return Object.keys(out).length ? out : null;
}

/** 自绘菜单的两个 IPC 入口（页面 → 主进程）。注册一次即可（窗口会重建）。 */
let widgetIpcRegistered = false;
function registerWidgetIpc() {
  if (widgetIpcRegistered) return;
  widgetIpcRegistered = true;
  // 只认小窗自己：即使别处的页面拿到了同名桥（或页面被注入）也用不了这两个口子。
  const fromWidget = (event) => !!widgetWindow && !widgetWindow.isDestroyed()
    && Number(event?.sender?.id) === widgetWindow.webContents.id;
  ipcMain.handle('widget:apply', (event, raw) => {
    if (!fromWidget(event)) return { ok: false, reason: 'not-widget' };
    const patch = sanitizeWidgetPatch(raw);
    if (!patch) return { ok: false, reason: 'empty-patch' };
    applyWidgetOption(patch);
    return { ok: true, patch };
  });
  ipcMain.handle('widget:command', (event, name) => {
    if (!fromWidget(event)) return { ok: false, reason: 'not-widget' };
    if (name === 'open-console') { showWindow(); return { ok: true }; }
    if (name === 'expand') { widgetRevealEdge('页面菜单'); return { ok: true }; }
    return { ok: false, reason: 'unknown-command' };
  });
}
registerWidgetIpc();

/** 右键菜单 / 托盘菜单改设置：写配置（落盘）→ 立刻同步到活窗口（不等轮询）。 */
function applyWidgetOption(patch) {
  try { core?.updateConfig?.({ widget: { ...widgetCfg(), ...patch } }); } catch (error) {
    logKey('widget', `写入配置失败：${error?.message ?? error}`);
  }
  syncWidget(true);
}

/**
 * 创建悬浮小窗。
 * @param {{x:number,y:number,width:number,height:number}} [keepBounds]
 *        重建窗口（改了"真透明"）时传入旧位置：透明度只能建窗时决定，
 *        改了必须重建，但用户拖好的位置不能丢。
 */
function createWidgetWindow(keepBounds) {
  if (!core) return;                              // 服务没起来（启动失败）时不开窗
  if (widgetWindow && !widgetWindow.isDestroyed()) return;
  const port = core?.lastPort ?? 3210;
  const w = widgetCfg();
  const size = WIDGET_SIZE_ORDER.includes(w.size) ? w.size : 'm';
  const saved = keepBounds || readWidgetBounds(size) || widgetDefaultBounds(size);
  // 只取四个几何字段：readWidgetBounds 可能附带 edgeHidden/nx/ny（贴边收起态
  // 的存档），那是给主进程用的，不是 BrowserWindow 的选项。
  const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const transparent = !!w.transparent;
  // 半透明磨砂：opacity<100 且没开实验档 transparent 时，窗口挂 Windows 11
  // 的 mica 系统背板（DWM 合成，页面用半透明卡片色叠上去得到毛玻璃效果）。
  // 刻意绕开 transparent:true：那是"只显示第一帧后冻结"的链路（见 createWindow 注释），
  // mica 是另一条路，窗口仍按不透明窗口建，不碰分层透明。
  // backgroundMaterial 建窗时决定，跨 100 的调整由 syncWidget 重建窗口。
  const frosted = widgetOpacityPct(w) < 100 && !transparent;
  try {
    widgetWindow = new BrowserWindow({
      ...bounds,
      minWidth: 160,
      minHeight: 88,
      // 同主窗口：transparent=true 是本机已知"只显示第一帧后冻结"的档位。
      // 默认档里它是开着的，所以这里不是"永不开启"的守卫，而是出事时的索引：
      // 卡片冻结不刷新 → 关掉设置里的「真·透明背景」。
      transparent,
      // 半透明磨砂档（opacity<100）：Win11 mica 背板。老版本 Electron/老系统
      // 不认识这个选项时会静默忽略，退化为"不透明卡"，不会白屏。
      ...(frosted ? { backgroundMaterial: 'mica' } : {}),
      hasShadow: true,
      backgroundColor: transparent ? '#00000000' : '#141821',
      frame: false,
      alwaysOnTop: w.alwaysOnTop !== false,
      skipTaskbar: true,
      resizable: true,                            // 尺寸同时由右键菜单三档预设决定
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      title: 'QQ Agent 悬浮窗',
      icon: ICON_PATH,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 被游戏/全屏浏览器遮挡时定时器不能节流，状态卡要持续刷新
        // （与主窗口同一个坑：节流会让轮询停摆，卡片变成"假死"）
        backgroundThrottling: false,
        // 极窄桥：只给自绘菜单递动作（apply / command 两个方法，见 widget-preload.cjs）。
        // 不暴露 ipcRenderer 本体，contextIsolation / nodeIntegration 保持与主窗口一致。
        preload: WIDGET_PRELOAD_PATH,
        devTools: false
      }
    });
  } catch (error) {
    logCritical('widget', `[悬浮窗创建失败] ${describeError(error)}`);
    widgetWindow = null;
    return;
  }
  const win = widgetWindow;
  widgetLoadRetries = 0;               // 新窗口的加载重试预算重新计
  // 鼠标穿透（可随时切）：forward:true 让 mousemove 仍然送达页面（卡片照常
  // 刷新显示），点击则穿透到桌面，挂着偷看群状态时不抢焦点。
  try { win.setIgnoreMouseEvents(!!w.clickThrough, { forward: true }); } catch { /* 老版本无此 API */ }
  win.once('ready-to-show', () => {
    try {
      // showInactive：亮相但不抢焦点（用户可能正在全屏游戏里）
      if (typeof win.showInactive === 'function') win.showInactive();
      else win.show();
    } catch { /* 窗口已销毁 */ }
  });
  win.on('closed', () => {
    // 只清理"自己还是当前窗口"的情况：destroyWidgetWindow/重建路径会先把引用
    // 置空，不判等会把新窗口误清成 null（现象：小窗凭空消失）。
    if (widgetWindow === win) widgetWindow = null;
  });
  // 位置/尺寸防抖落盘（与主窗口共用 400ms 防抖 + saveWindowState）
  win.on('move', scheduleSaveWindowState);
  win.on('moved', scheduleSaveWindowState);
  // 贴边收起（QQ 式）：只在松手后判定，拖动中判定会和光标打架（见 ⑤）
  win.on('moved', widgetOnMoved);
  win.on('resize', scheduleSaveWindowState);
  win.on('resized', scheduleSaveWindowState);
  // 右键菜单由页面自绘（卡片内的深色小菜单，与小窗同一套视觉，原生菜单在
  // Windows 上改不了样式）。动作经 widget-preload.cjs 那两个方法回到这里。
  // 刻意不弹原生菜单：样式统一了就只有一条路径。桥加载失败时页面会自行降级。
  win.webContents.on('preload-error', (_e, p, error) => {
    logKey('widget', `[preload 失败] ${p} :: ${describeError(error)}`);
  });
  // 与主窗口同口径：小窗只应停留在本机控制台；被导航走就拉回来
  //（will-navigate 在 setWindowOpenHandler 之外，双保险）
  const guardWidgetNav = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    try {
      const r = checkExternalUrl(url, externalAllowHosts());
      if (r.ok) shell.openExternal(r.url);
      else console.warn(`[外链拦截] widget：${r.reason} → ${String(url).slice(0, 200)}`);
    } catch { /* 拦截失败也不该让导航继续 */ }
  };
  win.webContents.on('will-navigate', guardWidgetNav);
  win.webContents.on('will-redirect', guardWidgetNav);
  // window.open 一律拒绝并经外链检查转系统浏览器（与主窗口 setWindowOpenHandler 同口径）
  win.webContents.setWindowOpenHandler(({ url }) => {
    guardWidgetNav({ preventDefault: () => {} }, url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logKey('widget', `[页面加载失败] code=${code} desc=${desc} url=${url}`);
    // 有界重试（2s → 4s，最多 2 次）：服务就在本进程里，正常必然起得来，
    // 这里只兜"端口刚好被别的东西占了"这类瞬时情况。不学主窗口那样多次重试，
    // 小窗没有"用户盯着看"的负担，两次不成就是环境问题，靠日志定位。
    widgetLoadRetries = (widgetLoadRetries || 0) + 1;
    if (widgetLoadRetries <= 2) {
      const delay = widgetLoadRetries === 1 ? 2000 : 4000;
      setTimeout(() => {
        try { win.loadURL(`http://127.0.0.1:${port}/widget.html`); } catch { /* 窗口已销毁 */ }
      }, delay);
    }
  });
  // 上次退出时就是收起态：启动即以正常位置建窗（上面 bounds），此刻立刻收起。
  // 存档里存的是展开态坐标，直接按收起坐标建窗过不了可见性校验。
  if (saved?.edgeHidden && w.edgeHide && widgetEnterEdgeState(bounds)) {
    scheduleSaveWindowState();
    logKey('widget', '启动即为收起态（上次贴边收起，鼠标移近即展开）');
  }
  win.loadURL(`http://127.0.0.1:${port}/widget.html`)
    .catch((error) => logCritical('widget', `[loadURL 失败] ${describeError(error)}`));
  logKey('widget', `已打开桌面悬浮小窗（size=${size} transparent=${transparent} bounds=${JSON.stringify(bounds)}）`);
}

/** 关闭小窗（关窗即销毁：它没有"缩起来"的中间态，托盘/设置里再开即可）。 */
function destroyWidgetWindow() {
  const win = widgetWindow;
  widgetWindow = null;
  widgetStopEdgePoll();          // 收起态的展开探测轮询跟着窗口一起走
  widgetCancelAnim();            // 别让动画在窗口没了之后还去 setBounds
  // 挂起的 260ms 贴边判定也要撤：否则它会在新窗口建好之后才落地，
  // 把刚重建的卡片（不透明度跨 100% 时会重建）立刻收走。
  widgetCancelEdgeSettle();
  widgetEdge = null;
  widgetEdgeArmed = true;        // 新窗口重新上膛，别继承上一个窗口的"未上膛"状态
  try { win?.close(); } catch { /* 已销毁 */ }
}

/**
 * 把配置同步到活窗口。三种动作：
 *   关 → 销毁；开（没有窗）→ 建；开着 + 签名变 → 改置顶/穿透/尺寸；
 *   transparent 变 / 不透明度跨 100 → 保留位置重建（两项都建窗时决定：
 *   前者是"只显示第一帧"的透明链路，后者要挂卸 mica 毛玻璃背板）。
 * 贴边收起（edgeHide）变关 → 收起态当场展开（否则只剩一条缝，用户找不到窗）。
 * 不透明度在 100 以下内部调整不重建：页面轮询 /api/config 改 CSS 透明度即可。
 */
function syncWidget(force = false) {
  const w = widgetCfg();
  const sig = widgetSettingsSig(w);
  const alive = !!widgetWindow && !widgetWindow.isDestroyed();
  if (!w.enabled) {
    if (alive) { destroyWidgetWindow(); logKey('widget', '已按配置关闭桌面悬浮小窗'); }
    widgetSettingsSigCache = sig;
    return;
  }
  if (!alive) {
    createWidgetWindow();
    widgetSettingsSigCache = sig;
    return;
  }
  if (!force && sig === widgetSettingsSigCache) return;
  // 必须重建的两类切换（真透明 / 不透明度跨 100 挂卸 mica）走同一条重建路径：
  // 位置照搬、收起态带回去，用户拖好的地方不丢。
  if (widgetNeedsRebuild(widgetSettingsSigCache, w)) {
    let keep = null;
    let wasEdge = false;
    try {
      if (widgetEdge) { keep = { ...widgetEdge.normal }; wasEdge = true; }
      else keep = widgetWindow.getBounds();
    } catch { /* 忽略 */ }
    destroyWidgetWindow();
    createWidgetWindow(keep || undefined);
    if (wasEdge && keep) { try { widgetEnterEdgeState(keep); } catch { /* 忽略 */ } }
    widgetSettingsSigCache = sig;
    return;
  }
  try { widgetWindow.setAlwaysOnTop(w.alwaysOnTop !== false); } catch { /* 忽略 */ }
  try { widgetWindow.setIgnoreMouseEvents(!!w.clickThrough, { forward: true }); } catch { /* 忽略 */ }
  // 开关从"贴边收起"切到不收起：收起态当场弹回，别把用户晾在一条缝上
  if (widgetEdge && w.edgeHide === false) widgetRevealEdge('关闭贴边收起');
  const size = WIDGET_SIZE_ORDER.includes(w.size) ? w.size : 'm';
  const dim = WIDGET_SIZES[size];
  try {
    const b = widgetWindow.getBounds();
    // 以左上角为锚缩放：用户拖动的语义就是左上角（右下角内容随之增减）。
    // 走 widgetProgrammaticMove：这次 moved 是我们动的，不该被误判成"用户
    // 把它拖到边上"而触发贴边收起（窗口本来就可能贴着边停着）。
    widgetProgrammaticMove(widgetWindow, { x: b.x, y: b.y, width: dim.width, height: dim.height });
  } catch { /* 忽略 */ }
  widgetSettingsSigCache = sig;
  // 签名变了说明用户改了偏好（最常见是拖设置页的不透明度滑条）。主动推给活页
  // 一次：不推的话页面要等 2.5 秒状态轮询，而 loadPrefs 的去重会把推送晚到的
  // 那一次补拉吃掉，实测最坏约 4.6 秒小窗才变色，滑条的体感就是"拖了半天没反应"。
  widgetPushPrefs();
}

/**
 * 通知活的小窗"配置变了，去重拉一次"。
 * 只对不需要重建窗口的那类变化有意义：不透明度 100 以下调卡片 alpha、
 * 刷新间隔、置顶/穿透开关。需要重建的两类（transparent / 不透明度跨 100）
 * 走 createWidgetWindow，新页面启动时自己会 loadPrefs，不用推。
 */
function widgetPushPrefs() {
  const win = widgetWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('widget:prefs-changed', { opacity: widgetOpacityPct(widgetCfg()) });
  } catch { /* 页面正在导航 / 已销毁：常态，忽略 */ }
}

/** 300 毫秒扫一次配置（updateConfig 没有变更通知，见 ③）。
 *  这是"设置页改动"到"小窗变色"的唯一链路。每轮只读内存（core.getConfig）
 *  拼一个签名串，成本可忽略。 */
function startWidgetSync() {
  setInterval(() => {
    try { syncWidget(); } catch (error) { logKey('widget', `同步失败：${error?.message ?? error}`); }
  }, 300);
}

app.whenReady().then(async () => {
  try {
    // ── 数据目录可写性自检 ───────────────────────────────────────────
    // 必须排在一切业务之前：数据目录不可写时，失败会散落在十几个模块里，
    // 最终表现成"双击没反应"。在这里一次性判掉，用户能看到原因和解法。
    // 只在拿到单实例锁时检查，第二实例本来就要退出，让它先报"已在运行"更有用。
    if (gotLock) {
      const dataDir = process.env.QQ_AGENT_DATA_DIR;
      const unwritable = probeDataDirWritable(dataDir);
      if (unwritable) {
        reportDataDirFailure(dataDir, unwritable);
        return;
      }
    }
    // 崩溃证据链越早挂上越好：logger 要等 ready（DATA_DIR 此时才定型），
    // crashpad 和子进程监护同理（GUI 子系统就绪后 crashpad handler 才拉得起来）。
    await bindCoreLogger();
    pruneCrashDumps();          // 先清旧的再开转储：本轮崩溃的证据一定留得下
    startCrashReporter();
    watchChildProcesses();
    // 电源事件 → 看门狗静默期。休眠/锁屏期间系统会暂停渲染进程的定时器，
    // 恢复瞬间的那一次探针超时会被当成"页面僵死"，两次后拆窗重建，
    // 用户看到"睡醒回来窗口自己消失了一下"。
    // powerMonitor 必须走命名空间取：ESM 具名导入在导出名不存在时是 SyntaxError，
    // 会把整个 main.js 带走（同 webUtils / screen）。
    try {
      const powerMonitor = electronApi.powerMonitor ?? electronApi.default?.powerMonitor ?? null;
      if (powerMonitor) {
        powerMonitor.on('resume', () => suspendWatchdogBriefly(8000, '系统从睡眠恢复'));
        powerMonitor.on('unlock-screen', () => suspendWatchdogBriefly(4000, '锁屏解锁'));
      } else {
        logKey('window', '[看门狗] 本环境无 powerMonitor，跳过电源事件挂载');
      }
    } catch (error) {
      logKey('window', `[看门狗] powerMonitor 挂载失败（不影响其他功能）：${describeError(error)}`);
    }
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    // 桌宠宿主先建、再注入 core：core 通过它挂 /api/desktop-pet/*，
    // 它通过 getService 反向取插件能力。此刻 core 还是 null，getService 是闭包，
    // 真正取值发生在窗口起来之后，所以顺序安全。
    desktopPetHost = createDesktopPetHost({
      getMainWindow: () => mainWindow,
      showMainWindow: () => showWindow(),
      getService: () => core?.getDesktopPetService?.() || null,
      // 单击桌宠 → 今日用量卡片；双击 → 开发工单对话窗。两者都走进程内能力，
      // 不开新 HTTP 口子。
      getUsageToday: () => core?.getUsageToday?.() ?? null,
      devApi: () => core?.devApi?.() ?? null,
      // 桌宠跑在独立渲染进程里，它的 console、preload 失败、页面加载失败都经由
      // 这个 log 回调出来。只写 stdout 的话打包版没有终端接管，这个功能出问题时
      // 在 data/logs 里一条线索都没有。改成同时落主日志，事后才查得动。
      log: (...args) => logKey('desktop-pet', args.map((value) => (typeof value === 'string' ? value : String(value))).join(' '))
    });
    core = createApp({ log: (...args) => console.log(...args), desktopPetHost });
    // 先启动服务拿到真实端口，再开窗口。反过来的话 lastPort 尚未赋值，窗口恒按
    // 3210 加载；若端口被占用顺延到 3211+，首屏必然加载失败。
    const port = await core.start();
    core.lastPort = port;
    installConsoleRequestAuth(port, core.getRendererAuthToken?.());
    // second-instance 处理器可能在上面 core.start() 的 await 期间就调了 showWindow()，
    // 那时 lastPort 尚未赋值，会按回退端口 3210 建出一个「幽灵窗口」。真实端口
    // 拿到后不再重复建窗：已有窗口就改址复用并聚焦，否则才创建。
    if (mainWindow && !mainWindow.isDestroyed()) {
      windowHidden = false;
      mainWindow.show();
      try { mainWindow.setSkipTaskbar(false); } catch { /* 老版本无此 API 时忽略 */ }
      mainWindow.focus();
      await mainWindow.loadURL(`http://127.0.0.1:${port}/`)
        .catch((error) => logCritical('window', `[loadURL 失败] ${describeError(error)}`));
    } else {
      await createWindow(port);
    }
    // 桌宠窗口必须等 core.start() 拿到真实端口后再起（pet.html 走同源 HTTP，
    // 端口错了就是白屏/404）。放在 if/else 之后而不是 createWindow 内部：
    // 第二实例复用已有窗口那条分支同样要拉起桌宠。
    // 失败只记日志：桌宠起不来不能拖垮主界面（与托盘/悬浮窗同一个兜底口径）。
    try {
      await desktopPetHost.start({ port, consoleToken: core.getConfig().server?.token || '' });
    } catch (error) {
      // 必须落盘：打包版没有终端接管 stdout，只 console.error 的话桌宠起不来
      // 这件事在 data/logs 里一行都没有。
      logCritical('desktop-pet', `桌宠窗口初始化失败：${describeError(error)}`);
    }
    applyAutoStart();
    // 托盘单独兜底：Electron 的 Tray 在 Linux 上依赖 AppIndicator / libappindicator，
    // 不少极简发行版默认没装，new Tray() 会抛异常。它若落在下面的大 try 里，
    // 一抛就会被判成「启动失败」并弹原生错误框，软件等于打不开。
    // 托盘只是「隐藏到后台 + 右键菜单」的便利设施，没资格让主程序起不来：
    // 失败只降级成「无托盘图标」，主界面照常出来。
    try {
      createTray();
    } catch (trayError) {
      logCritical('tray', `[托盘创建失败，已降级为无托盘模式] ${describeError(trayError)}`);
    }
    // 桌面悬浮小窗：先按当前配置同步一次（可能配置里就是开着的），再挂轮询。
    // 放在最后：依赖 core.lastPort / 托盘都已就绪；它自己兜底，失败只影响小窗。
    try {
      syncWidget(true);
      startWidgetSync();
    } catch (widgetError) {
      logCritical('widget', `[悬浮窗初始化失败，不影响其他功能] ${describeError(widgetError)}`);
    }
  } catch (error) {
    logCritical('electron', `[启动失败] ${describeError(error)}`);
    // 启动失败不能静默退出：只写日志就 app.quit() 的话，用户双击没反应、
    // 无窗口、无任何提示，完全无法自救。
    // 弹原生错误框：原因直接可见 + 一键打开日志目录（完整堆栈在里面）。
    const logsDir = path.join(process.env.QQ_AGENT_DATA_DIR || '.', 'logs');

    // 文件锁冲突（app.js 抛 `[单实例] …`）落到这里会被报成红色「启动失败」，
    // 用户以为程序坏了，实际只是"已经开着了"，按消息前缀分流到友好信息框。
    // 真失败给 180s（要留「打开日志目录」的点击时间），锁冲突给 8s（一行话读够）。
    if (/\[单实例\]/.test(String(error?.message ?? describeError(error)))) {
      showDialog({
        type: 'info',
        title: 'QQ Agent 已经在运行了（同一数据目录）',
        message: '已有一个实例占用这个数据目录。',
        detail: '这不是故障，也不需要重装。\n\n'
          + '如需同时开多个（多开测试），请给新实例设置环境变量 '
          + 'QQ_AGENT_PROFILE=2 / 3…（会使用独立数据目录与端口）。',
        buttons: ['知道了']
      }, { autoCloseMs: DIALOG_TIMEOUT.alreadyRunning })
        .catch(() => {})
        .finally(() => app.quit());
      return;
    }

    showDialog({
      type: 'error',
      title: 'QQ Agent 启动失败',
      message: '启动失败了，原因见下方。',
      detail: `${describeError(error)}\n\n详细日志目录：${logsDir}`,
      buttons: ['打开日志目录', '退出'],
      defaultId: 1,
      cancelId: 1,
    }, { autoCloseMs: DIALOG_TIMEOUT.startupFailed }).then(({ response }) => {
      if (response === 0) shell.openPath(logsDir).catch(() => {});
      app.quit();
    }).catch(() => app.quit());
  }
}).catch((error) => {
  // 启动链最外层兜底：正常路径已由内部 try/catch 接住，这里只防"catch 自身抛错 /
  // 回调尾部异常"漏网。主进程的 unhandledRejection 没有别的出口，
  // 一旦漏就是静默停在半启动状态。
  logCritical('boot', `[启动链未捕获异常] ${describeError(error)}`);
});

// 退出清理：core.stop() 是 async（要 abortAll / 关 SSE / 关 server / 释放单实例锁），
// 而 before-quit 是同步事件，直接调它会让进程在 await 让出后就被销毁，清理链跑一半：
// 锁文件可能残留、会话最后一次进度可能丢、消息存档可能没落盘。
// 正确做法：拦下这次退出，等 stop() 真正跑完再 app.quit()。
//
// "等 stop() 跑完"必须有超时兜底：一旦 stop() 里某个 await 不返回，app.quit()
// 就永不执行，进程既不退出也不干活，窗口可能已经没了，用户唯一出路是任务管理器
// （实测过这种僵尸：1 线程、CPU 零增长、taskkill /F 都报"没有此任务"）。
// 现在用 Promise.race 给它 8 秒：超时就记 `[退出清理超时]` 并继续退出。
const STOP_TIMEOUT_MS = 8000;
// 退出收尾的最后一道保险：app.quit() 之后如果 4 秒还没退，直接结束进程。
// 托盘里已经没有「强制退出」入口，所以"温和路径万一卡住"必须由程序自己接管，
// 否则用户唯一的出路就只剩任务管理器。
const QUIT_HARD_LIMIT_MS = 4000;
let shuttingDown = false;

// 协议端（SnowLuma / NapCat）由用户自行安装运行，QQ Agent 不拉起任何子进程，
// 退出时也不该由我们 kill。

app.on('before-quit', (event) => {
  quitting = true;
  flushWindowState();                    // 真退出前把窗口几何落盘
  // 进出都记，并给 core.stop() 计时：万一真的挂住，日志里能直接看出是挂在 stop 上。
  if (shuttingDown || !core) {
    logKey('quit', `before-quit：放行（shuttingDown=${shuttingDown} core=${!!core}）`);
    return;                               // 第二次进入（自己触发的 quit）直接放行
  }
  event.preventDefault();
  shuttingDown = true;
  const t0 = Date.now();
  logKey('quit', 'before-quit：拦下退出，开始 core.stop()');

  let stopTimer = null;
  const stopDone = Promise.resolve()
    // 桌宠先关：它自己的窗口/IPC/屏幕监听必须在 core.stop() 之前拆掉，
    // 否则 stop 关掉 HTTP 服务后桌宠页还在轮询（404 刷屏），窗口也可能残留。
    .then(async () => {
      try { await desktopPetHost?.shutdown?.(); } catch (error) { logCritical('desktop-pet', `桌宠关闭失败：${describeError(error)}`); }
    })
    .then(() => core.stop())
    .then(() => 'ok')
    // 静态检查要求每条 .then 链自带 .catch。这里的 rejection 仍会传给下面的
    // Promise.race(...).catch 统一处理，所以只原样抛出、不吞错误。
    .catch((error) => { throw error; });
  const stopTimedOut = new Promise((resolve) => {
    stopTimer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS);
  });

  Promise.race([stopDone, stopTimedOut])
    .then((how) => {
      if (how === 'timeout') {
        logCritical('quit', `[退出清理超时] core.stop() ${STOP_TIMEOUT_MS}ms 未完成，继续退出（清理可能不完整）`);
      } else {
        logKey('quit', `core.stop() 完成（${Date.now() - t0}ms），继续 quit`);
      }
    })
    .catch((error) => {
      logCritical('quit', `[退出清理失败] ${describeError(error)}`);
    })
    .finally(() => {
      // 无论哪条路先到，都要把超时定时器清掉，否则进程退出被这个未决 timer 拖着
      try { clearTimeout(stopTimer); } catch { /* 已触发就无需清 */ }
      app.quit();
      // 兜住"app.quit() 卡在 will-quit / 某个窗口不配合"的情况。正常退出时进程
      // 已经没了，这个 unref 定时器永远不会触发；真卡住时它保证 4 秒后进程一定结束。
      const hardTimer = setTimeout(() => {
        logCritical('quit', `[退出兜底] app.quit() ${QUIT_HARD_LIMIT_MS}ms 仍未完成，强制结束进程`);
        app.exit(0);
      }, QUIT_HARD_LIMIT_MS);
      hardTimer.unref?.();
    });
});

// 显式注册而不是交给 Electron 默认行为：默认行为一样是退出（非 macOS），
// 但那样就没有任何记录。这条日志是判断"闪退 vs 正常关闭"的分水岭：
// 它出现在日志里，说明进程走完了完整的退出流程；没出现，说明是被杀或原生崩溃。
// rebuildWindow() 会先把旧窗口 destroy，窗口数瞬间归零，本事件照样触发，
// 紧接着 app.quit() 把"重建自救"整个带走。两种时机都要防：
//   ① 同步触发（destroy 时窗口数归零立刻发）：此时 rebuilding=true、新窗口还没建；
//   ② 异步触发（重建完成之后才派发）：此时 rebuilding=false 但 mainWindow 已是新窗口。
// 只要命中其一就说明"关窗"是重建动作的副作用，不是用户真要退出。
app.on('window-all-closed', () => {
  if (rebuilding || (mainWindow && !mainWindow.isDestroyed())) {
    logKey('quit', '所有窗口已关闭 → 正在重建窗口，跳过退出');
    return;
  }
  logKey('quit', '所有窗口已关闭 → 退出（非 macOS 的默认行为）');
  if (process.platform !== 'darwin') app.quit();
});

// 进程退出前最后一笔。落盘是同步 appendFileSync，所以这条一定写得进去：
// 日志里有 `[quit] 进程退出` 说明完整走完了退出流程；没有这一行说明进程是被杀掉
// 或原生崩溃的，直接去看事件查看器和 Crashpad。
app.on('quit', (_event, exitCode) => {
  logKey('quit', `进程退出 exitCode=${Number(exitCode) || 0}`);
});
