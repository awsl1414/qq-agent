// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR, isChatAllowed } from './config.js';
// 版本迁移：跨版本的配置改写与磁盘搬迁（旧插件残留、旧随包二进制、运行时目录调整）。
// 必须在 reloadSkills 之前跑，插件扫描读的就是 config.trustedPlugins。
import { runUpgrades, runtimeDirPath } from './upgrade.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, fetchForwardNodes } from './onebot.js';
// 协议端配置探测：令牌是 SnowLuma 按账号随机生成的，让新用户从 WebUI 手抄两串 43 位
// 字符串是首次配置最容易失败的一步，这里直接读它的配置文件填好端点与令牌。
// 只读，令牌不出进程（publicView 会删掉）。
import { detectProtocol, publicView as protocolDetectView } from './protocol-detect.js';
// isAtMe 是「是否被艾特」的唯一权威实现（含 QQ 号判定，见 prompt.js）。曾就地抄过
// 一份只认名字的版本，群昵称一改就漏判。
import { isAtMe } from './prompt.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { cacheIncomingImages } from './image-cache.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { ReminderStore } from './reminders.js';
import { VideoReader } from './video-reader.js';
import { cacheHitRate } from './llm.js';
import { isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, remoteOverrideCount, UNKNOWN_VENDOR } from './model-prices.js';
import { usageLedgerTotals, listUsageLedgerDays, ledgerDayKey, usageLedgerPrunedRecords } from './usage-ledger.js';
import { initPriceFeed, stopPriceFeed } from './price-feed.js';
import { startTelemetryLoop, stopTelemetryLoop } from './telemetry.js';
import { startCacheWarm, loadPersistedPrefix, seedPrefixFromSessions, warmOnce, markCurrentShapeWarmed } from './cache-warm.js';
import { diskPressure, diskPressureText } from './disk-space.js';
import { runBackup, startBackupOperations, stopBackupOperations } from './backup/index.js';
import { start as startBackupSchedule, stop as stopBackupSchedule } from './backup/schedule.js';
import { loadPlugins, watchPlugins, setOnebotClient, PLUGINS_DIR, SKILLS_DIR } from './plugin-loader.js';
// 工具集批量静默期：重扫期间 N 个插件会逐个注册工具，中间态一律不发给模型，
// 扫描结束一次性生效。详见 tool-registry.js「批量加载静默期」注释。
import { beginToolsetBatch, endToolsetBatch } from './tool-registry.js';
import { registerHarness } from './harness/index.js';
import { skillManager } from './skills/manager.js';
// 插件界面契约（常量 / 路径规则 / URL 拼装 / CSP）只此一份，前端与插件侧 import 同一份。
// 三处各写一遍时，漏改一处表现为"按钮点了白屏"且不报错。
import { PANEL_ROUTE_PREFIX, PANEL_DATA_SEGMENT, PANEL_FILE_TYPES, panelCsp } from './skills/panel.js';
import { extractCandidateUrls, dispatchMediaLinks } from './media-links.js';
import { createRoutes } from './routes.js';
// 桌宠 HTTP 适配器：只处理 /api/desktop-pet/*，且挂在控制台鉴权 + 同源检查之后。
import { handleDesktopPetRequest } from './desktop-pet-api.js';
import * as instanceLockModule from './instance-lock.js';
import { logger } from './logger.js';
import { startCommunitySync, isGloballyBlocked, FIXED_PRICE_FEED_URL } from './community.js';
import { noteMuted, noteUnmuted } from './ban-state-client.js';

// undici 默认连接建立超时 10 秒，openrouter.ai 这类海外端点握手慢时会直接报
// "Connect Timeout Error"（不是请求超时，那是 llm.js 的 180 秒 AbortSignal）。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时退回默认超时，不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断：委托给 config.js 的 isChatAllowed（全库唯一实现） ──────────
// 之前 allowed() 与发送侧闸各写一套，移除白名单后"发言"侧没同步。保留本函数名/签名，
// 调用方无需改动。
function allowed(kind, id, cfg) {
  return isChatAllowed(kind, id, cfg);
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 更新源走配置 `config.update.feedUrl`（默认空 = 功能关闭）。由后端代取而不是前端直连：
// 绕过 CORS，失败信息也能统一回给 UI。不指向上游项目的 version.json，本仓库从上游
// fork 后独立维护，上游推的是上游的安装包，见 src/config.js 的 update 段注释。

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/**
 * 逐段数字比较；返回 1 / 0 / -1。非数字段按 0 处理。
 *
 * 段数取两侧的最大值：本项目版本号是四段（如 `0.5.0.0`），而线上 version.json 曾
 * 只有三段。原实现写死 `i < 3`，一旦变化只发生在第四段就比较不出差异，`hasUpdate`
 * 永远 false，用户收不到更新提示。
 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* createApp 产生的所有 appLog 函数（模块级 WeakSet）。
   用于识别"调用方传入的 log 是不是上一次 createApp 留下的 appLog"，
   防止监听器链式递归（见 createApp 内的递归护栏注释）。 */
const appLogFns = new WeakSet();

export function createApp({ log = console.log, desktopPetHost = null } = {}) {
  const cfg = getConfig();

  // 桌面伙伴：能力按"已激活的插件"取用，插件没装/被禁用时返回 null，
  // 整个桌宠链路（API、事件转发、窗口）降级为无操作，不影响群聊。
  function getDesktopPetService() {
    try {
      return skillManager.getCapabilityProviders('desktop.pet.service', {})[0]?.fn?.() || null;
    } catch { return null; }
  }

  // 桌宠「今日用量」卡片：直接复用统计模块，不新开 HTTP 口子，也不把 token 递给渲染进程。
  // 统计本身有缓存（buildUsageStats 内部 TTL），点一下不会每次都全量扫会话文件。
  async function getUsageToday() {
    try { return await buildUsageStats({ range: 'today' }); }
    catch (error) { return { ok: false, error: String(error?.message || error) }; }
  }

  // 桌宠「开发工单」对话框：包装 dev-orders 的只读/发送能力。
  // 只在插件激活时拿得到提供者；未启用时返回 available:false，由界面提示去插件页开启。
  function devApi() {
    const call = (cap, args) => {
      let fn = null;
      try { fn = skillManager.getCapabilityProviders(cap, {})[0]?.fn || null; } catch { fn = null; }
      if (!fn) return { ok: false, available: false, error: '「开发工单」插件未启用（顶部「插件」页 → dev-orders）' };
      try { return { available: true, ...fn(args) }; }
      catch (error) { return { ok: false, available: true, error: String(error?.message || error) }; }
    };
    return {
      snapshot: (selected = '') => call('dev.snapshot', { selected }),
      detail: (id, from = 0) => call('dev.order-detail', { id, from }),
      send: (id, text) => call('dev.send', { id, text }),
      newSession: (text = '') => call('dev.new-session', { text }),
      closeSession: (id) => call('dev.close', { id })
    };
  }
  // Electron 主进程独占此随机凭据，并通过 webRequest 只注入当前控制台窗口的 API 请求。
  // 不写入 HTML / preload / 配置文件，避免把 server.token 暴露给页面或其他本机进程。
  const rendererAuthToken = randomBytes(32).toString('hex');

  // 详尽日志：把 createApp 的 log 接到分级日志系统（落盘 + 内存缓冲 + SSE）。
  // 只写 logger、不再调原 log，logger 的 mirrorConsole 已经会走 console，再调一次
  // 就会在 log 被指回 appLog 时无限递归（selftest 就是这么挂的）。
  const appLog = (...args) => {
    logger.info('app', ...args);
  };
  // 监听器必须持有"调用方原本传入的 log"的独立引用：下面会把形参 `log` 改指
  // appLog，而监听器闭包与形参共享同一个绑定，改指后监听器调到的是 appLog 自己，
  // 日志经 logger 的重入防护被静默丢弃，终端与 Electron 主进程 console 全部收不到
  // （headless 下表现为启动后终端一片空白，连端口都看不到）。
  const forwardLog = log;
  // 把调用方传入的 log 挂到 logger 的监听器上，与 mirrorConsole 解耦：mirrorConsole
  // 管 console，监听器管调用方的 log。
  //
  // 递归护栏（15GB 日志事故根因）：调用方传入的 log 可能本身就是上一次 createApp
  //   留下的 appLog（同进程内二次 createApp：Electron 重启核心 / 测试串行多轮），
  //   监听器链会形成 appLog→logger→监听器→appLog 的无限递归，每轮再包一层 [app]
  //   前缀，几个小时内日志文件就能写到 15GB。这里用 WeakSet 识别并跳过挂载。
  //   （这也是为什么监听器必须用 forwardLog：形参 `log` 马上会被改指 appLog。）
  // 同时持有退订函数：原实现把 logger.onLog 的返回值直接丢掉，同进程二次 createApp
  // 时旧监听器仍在，每条日志广播 N 份，并持有上一个 app 的 log 闭包。
  let unsubscribeAppLog = null;
  if (!appLogFns.has(forwardLog)) {
    unsubscribeAppLog = logger.onLog((entry) => {
      try { forwardLog(`[${entry.module}] ${entry.text}`); } catch { /* ignore */ }
    });
  }
  appLogFns.add(appLog);
  // 关掉 logger 的 console 镜像，避免与上面的监听器重复打印（调用方 log 通常就是 console.log）。
  logger.mirrorConsole = false;
  // 后续内部调用统一指向 appLog（关键事件落盘 + 走调用方 log）
  log = appLog;
  // 启动时清理过期日志文件
  logger.prune();

  // ── 进程单实例锁（防止桌面端 + headless 双开导致重复回复群消息）──
  // 与 Electron 的 requestSingleInstanceLock 互补：那只管 Electron 进程之间，
  // 这里管"同一数据目录下任何形态的 QQ Agent 核心"（含 node src/server.js）。
  const { acquireInstanceLock, releaseInstanceLock } = instanceLockModule;
  const lockResult = acquireInstanceLock();
  if (!lockResult.ok) {
    // 不抛异常上抛让进程退出，创建期的失败应当让整个启动失败。
    throw new Error(`[单实例] ${lockResult.reason}。如需多开测试，请用不同的 QQ_AGENT_DATA_DIR。`);
  }
  /* 抢到锁后立刻注册退出清理：正常 exit / SIGINT / SIGTERM 都会释放锁文件。
     曾经只在 stop() 里释放，进程被直接杀掉时锁文件残留，下次启动要靠"PID 已死"
     探测才能清掉，多一层失败面。 */
  instanceLockModule.registerLockCleanup();
  const sseClients = new Set();

  /**
   * 端口探测（永不 reject，失败一律 resolve(false)）。
   *
   * 这是 OneBot WS 端口就绪轮询的前置探测，端口值来自用户可改的 `config.protocol.wsUrl`。
   * `net.Socket.connect(99999 / -1 / NaN)` 会同步抛 RangeError → Promise reject →
   * 顺着 await 往外冒，轮询回调每 2 秒刷一行异常日志。"端口写坏了"只应等于"没开"，
   * 不该等于"功能全废"。
   */
  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const p = Number(port);
      const h = String(host ?? '').trim();
      if (!Number.isInteger(p) || p < 1 || p > 65535 || !h) { resolve(false); return; }
      const socket = new net.Socket();
      let settled = false;
      let guard = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(result);
      };
      try {
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.once('close', () => { if (guard) clearTimeout(guard); });
        // 双保险：个别异常 socket 状态可能既不 error 也不 timeout（半开连接）。
        // 到点直接判"没开"，探测本身绝不能成为卡住调用方的那一环。
        guard = setTimeout(() => done(false), timeoutMs + 500);
        guard.unref?.();
        socket.connect(p, h);
      } catch {
        done(false);
      }
    });
  }

  let pluginWatcher = null;        // 开发模式热重载 watcher（stop() 时要 close，否则句柄泄漏）
  let obPortPollTimer = null;      // OneBot WS 端口就绪轮询（stop() 时要 clear，start() 里赋值）
  let diskPatrolTimer = null;      // 数据盘空间巡检（stop() 时要 clear，start() 里赋值）

  // ── 便携 QQ 进程管理 ──
  // 便携 QQ 与用户日常 QQ 完全隔离：独立安装目录 + 独立 user-data-dir。
  // 绝不 taskkill QQ.exe 全名，只杀路径匹配 runtime/qq-portable 的进程。
  const qqPortableLogs = [];
  let qqPortableProc = null;
  let qqPortableLaunching = false;   // 便携 QQ 启动互斥标记（防连点「启动 QQ」并发拉起）

  function qqPortableDir() {
    // 运行时内容统一挂在 DATA_DIR/runtime/ 下（见 upgrade.js 文件头）。
    // 迁移项 relocate-portable-qq 会在启动时把程序目录下的那份搬过来；
    // 搬成功之前它还在 ROOT/runtime/ 下，所以解析要两处都看，且先看数据目录。
    // 这不是给旧版本留的兼容分支：迁移失败（便携 QQ 正在运行、文件被占用）
    // 时用户仍必须能正常用便携 QQ，否则一次搬移失败就等于功能消失。
    return runtimeDirPath('qq-portable', { appRoot: ROOT, dataDir: DATA_DIR });
  }

  function qqPortableDataDir() {
    return runtimeDirPath('qq-portable-data', { appRoot: ROOT, dataDir: DATA_DIR });
  }

  function qqPortableExe() {
    return path.join(qqPortableDir(), 'QQ.exe');
  }

  function pushQqLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    qqPortableLogs.push(line);
    if (qqPortableLogs.length > 500) qqPortableLogs.splice(0, qqPortableLogs.length - 500);
    emit('qq-portable-log', line);
  }

  /** 检查便携 QQ 是否已安装 */
  function qqPortableReady() {
    return fs.existsSync(qqPortableExe());
  }

  /**
   * 列出所有 QQ.exe 进程，返回 [{ pid, path }]（Windows only）。
   *
   * 不能退回 `wmic process ... /format:csv`：它按系统 ANSI 代码页（中文系统是 GBK）
   * 输出而 Node 按 UTF-8 读，路径里的中文会变乱码，拿去比对永远比不上（纯英文路径下
   * 完全不暴露），表现为"QQ 明明在跑，界面却说未启动"；CSV 还会被路径里的逗号错位。
   * 而且 wmic 在 Win11 24H2+ 已被移除。
   * 现在用 PowerShell + 显式强制 UTF-8 输出 + JSON。PS 5.1 默认同样按 ANSI 输出，
   * `[Console]::OutputEncoding=[Text.Encoding]::UTF8` 不能去掉。
   */
  // listQqProcesses 的短 TTL 缓存 + 在途共享。
  //
  // /api/status 是秒级轮询，而它每轮要 spawn 一次 PowerShell 查 QQ 进程列表
  // （本机单次 CIM 查询 ~1.5s）。机器一忙就顶穿前端 15 秒超时，连带用量页的
  // Promise.all 一起挂，用户看到"用量页一直加载失败"。
  // 3 秒 TTL：UI 状态允许 3 秒陈旧；在途共享避免并发调用叠出多个 PowerShell
  // （force=true 只给"刚装完 QQ 要立刻看到结果"这类显式场景用）。
  let qqProcListCache = { at: 0, rows: null };
  let qqProcListInFlight = null;
  const QQ_PROC_LIST_TTL = 3000;

  async function listQqProcesses({ force = false } = {}) {
    if (process.platform !== 'win32') return [];
    const now = Date.now();
    if (!force) {
      if (qqProcListCache.rows && now - qqProcListCache.at < QQ_PROC_LIST_TTL) {
        return qqProcListCache.rows;
      }
      if (qqProcListInFlight) return qqProcListInFlight;   // 已在查 → 共用这一次，别叠 spawn
    }
    const p = __listQqProcessesOnce()
      .then((rows) => { qqProcListCache = { at: Date.now(), rows }; return rows; });
    qqProcListInFlight = p;
    try { return await p; } finally { qqProcListInFlight = null; }
  }

  /** 真正干活的单次查询（无缓存）。空结果也缓存 3s，失败的 spawn 同样是慢操作。 */
  async function __listQqProcessesOnce() {
    if (process.platform !== 'win32') return [];
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-CimInstance Win32_Process -Filter "name=\'QQ.exe\'" | '
          // 连 CommandLine 一起取：本机 QQ 模式下机器人的 QQ 和用户自己的 QQ 是同一个
          // exe 路径，靠命令行里的 --user-data-dir 区分。
          + 'Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
      ], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const txt = String(stdout).trim();
      if (!txt) return [];
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : [data];
      return arr
        .map((p) => ({
          pid: Number(p.ProcessId),
          path: String(p.ExecutablePath ?? ''),
          cmd: String(p.CommandLine ?? '')   // 命令行，用于识别「机器人那份 QQ」
        }))
        .filter((p) => p.pid > 0);
    } catch {
      // 查不到就当没有。不要退回 wmic：它给的乱码路径会导致
      // "误判为别的 QQ"或"漏判本机的便携 QQ"，比返回空更糟。
      return [];
    }
  }

  /** 检查便携 QQ 是否在运行（按路径匹配，不碰用户 QQ） */
  async function qqPortableRunningPid() {
    // 1) 本进程拉起过的那个：spawn 时就拿到 pid 了，不用查系统，
    //    最快，也不受任何编码/权限问题影响。
    if (qqPortableProc && !qqPortableProc.killed) {
      try {
        process.kill(qqPortableProc.pid, 0);   // signal 0 = 只探测存活
        return qqPortableProc.pid;
      } catch { /* 已退出，往下走 */ }
    }
    // 2) 查系统：覆盖"上次启动的 QQ 还在跑，但应用重启过"的情况。
    //    我们启动 QQ 时一定带 --user-data-dir=<runtime/qq-portable-data>，命令行里含
    //    这个数据目录的就是机器人那份，与 exe 在哪儿无关（本机 QQ 模式下机器人和
    //    用户的 QQ 是同一个 exe 路径，只按路径匹配会永远显示"未运行"）。
    //    便携模式旧行为（按安装目录前缀匹配）保留为兜底。
    const procs = await listQqProcesses();
    const dataDir = qqPortableDataDir().toLowerCase();
    const byData = procs.find((p) => p.cmd && p.cmd.toLowerCase().includes(dataDir));
    if (byData) return byData.pid;
    const portableDir = qqPortableDir().toLowerCase();
    const byPath = procs.find((p) => p.path.toLowerCase().startsWith(portableDir));
    return byPath?.pid ?? null;
  }

  /**
   * 启动机器人的 QQ。
   *
   * 便携副本优先；没有便携副本时直接用本机已装的 QQ（不强制复制 1~2GB）。
   * 隔离靠 --user-data-dir：不管 exe 在哪儿，登录数据都写进
   * runtime/qq-portable-data，与用户日常 QQ 互不干扰。
   */
  async function launchPortableQQ() {
    // 便携 QQ 的做法是「复制本机 QQNT 目录 + 带 --user-data-dir 启动」，而 QQNT 本身
    // 只有 Windows 版。Linux/macOS 上直接说清楚，别让用户对着 spawn 失败发呆。
    if (process.platform !== 'win32') {
      return { ok: false, error: '「一键便携 QQ」仅支持 Windows —— QQNT 没有 Linux/macOS 版。Linux 上请改用外部 OneBot 协议端（如 NapCat / LLOneBot）。' };
    }
    const target = await resolveQqTarget();
    if (!target.exe) {
      return {
        ok: false,
        error: '没找到可用的 QQ：既没有便携副本，也没在本机检测到已安装的 QQ —— 请先安装新版 QQ（QQNT）'
      };
    }
    if (!fs.existsSync(target.exe)) {
      return { ok: false, error: `QQ 主程序不见了：${target.exe} —— QQ 可能已被卸载或挪走，重装后重试` };
    }
    // 启动互斥：连点「启动 QQ」时，第一次还在 spawn，第二次直接拒绝
    if (qqPortableLaunching) {
      pushQqLog('QQ 正在启动中，忽略重复的启动请求');
      return { ok: true, alreadyRunning: true, launching: true };
    }
    const existingPid = await qqPortableRunningPid();
    if (existingPid) {
      pushQqLog(`机器人的 QQ 已在运行（pid=${existingPid}），无需重复启动`);
      return { ok: true, alreadyRunning: true, pid: existingPid };
    }

    // 本机模式：用户自己的 QQ 可能正在跑。我们不拦（QQ 带不同 --user-data-dir
    // 一般能再开一个实例），但先把话说在前面，免得"没反应"时无从下手。
    if (target.source === 'local') {
      const others = (await listQqProcesses())
        .filter((p) => p.path && p.path.toLowerCase() === target.exe.toLowerCase());
      if (others.length) {
        pushQqLog(
          `注意：你电脑上的 QQ 正在运行（pid=${others.map((o) => o.pid).join(',')}）。`
          + '机器人的 QQ 会**另开一个窗口**登录，和你的 QQ 是两套数据，不会顶掉你。',
          'stdout'
        );
      }
    }

    qqPortableLaunching = true;
    try {
      const exe = target.exe;
      const dataDir = qqPortableDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      try {
        const child = spawn(exe, [`--user-data-dir=${dataDir}`], {
          cwd: target.dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: false, // QQ 需要显示窗口让用户扫码
          detached: true
        });
        qqPortableProc = child;
        child.unref();
        pushQqLog(
          target.source === 'local'
            ? `用你电脑里的 QQ 启动机器人（pid=${child.pid}），登录数据单独放：${dataDir}`
            : `便携 QQ 启动中（pid=${child.pid}），数据目录：${dataDir}`
        );
        child.stdout?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stdout');
          }
        });
        child.stderr?.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushQqLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          qqPortableProc = null;
          pushQqLog(`便携 QQ 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('qq-portable-status', { running: false, pid: null });
        });
        child.on('error', (error) => {
          pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('qq-portable-status', { running: true, pid: child.pid });
        return { ok: true, launched: true, pid: child.pid };
      } catch (error) {
        pushQqLog(`便携 QQ 启动失败：${error?.message ?? error}`, 'stderr');
        return { ok: false, error: String(error?.message ?? error) };
      }
    } finally {
      qqPortableLaunching = false;
    }
  }

  /** 关闭便携 QQ（只杀路径匹配的 PID，绝不碰用户 QQ） */
  async function stopPortableQQ() {
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('便携 QQ 未在运行');
      return { ok: true, stopped: false, reason: 'not_running' };
    }
    try {
      process.kill(pid, 'SIGTERM');
      pushQqLog(`已请求关闭便携 QQ（pid=${pid}）`);
      // 等待进程退出
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const still = await qqPortableRunningPid();
        if (!still) {
          pushQqLog('便携 QQ 已退出');
          emit('qq-portable-status', { running: false, pid: null });
          return { ok: true, stopped: true, pid };
        }
      }
      // 还没退，强制 kill
      process.kill(pid, 'SIGKILL');
      pushQqLog(`便携 QQ 已强制结束（pid=${pid}）`);
      emit('qq-portable-status', { running: false, pid: null });
      return { ok: true, stopped: true, pid, forced: true };
    } catch (error) {
      pushQqLog(`关闭便携 QQ 失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * QQ 内核状态摘要。
   * `ready` = 有能启动的 QQ：便携副本装了，或本机检测到 QQ。
   * `source` 告诉前端当前走的是哪一种（'portable' | 'local' | 'none'）。
   * @param {{force?: boolean}} opts ?force=1 跳过本机 QQ 探测的 30s 缓存
   */
  async function qqPortableStatus(opts = {}) {
    const pid = await qqPortableRunningPid();
    const target = await resolveQqTarget(opts);
    return {
      ready: target.exe !== null,
      // 便携 QQ（含「一键安装独立副本」）依赖 QQNT，只有 Windows 有。
      // 前端据此隐藏/改写这块文案：在 mac/Linux 上点进安装永远只会得到
      // 「没找到本机安装的 QQ」，那是不可达的操作，不是"还没装"。
      supported: process.platform === 'win32',
      running: pid !== null,
      pid,
      dir: target.dir || qqPortableDir(),
      dataDir: qqPortableDataDir(),
      // 一键安装的实时进度（前端轮询 /api/status 读这里显示「复制中 n/m」）
      setup: { ...qqSetupState },
      // 探测到本机 QQ（= 用户日常用的那个 QQ）时的路径
      localQqDir: target.source === 'local' ? target.dir : null,
      // 'portable' 用独立副本 / 'local' 用本机 QQ / 'none' 都没有
      source: target.source,
      // 独立副本装没装，决定 UI 要不要显示「装一份独立副本（可选）」
      portableInstalled: qqPortableReady(),
    };
  }

  /* ── 本机 QQ 探测 + 一键安装便携 QQ ─────────────────────────────── */

  /**
   * 解析「机器人实际要启动的那份 QQ」。
   * 便携副本优先，本机已装的 QQ 直接算通过。
   * @returns {{dir:string|null, exe:string|null, source:'portable'|'local'|'none'}}
   */
  async function resolveQqTarget(opts = {}) {
    if (qqPortableReady()) {
      return { dir: qqPortableDir(), exe: qqPortableExe(), source: 'portable' };
    }
    const local = await detectLocalQqDir(opts);
    if (local) {
      return { dir: local, exe: path.join(local, 'QQ.exe'), source: 'local' };
    }
    return { dir: null, exe: null, source: 'none' };
  }

  const qqSetupState = { running: false, step: '', done: 0, total: 0, error: null, ok: false };

  // /api/status 是秒级轮询，而探测要 spawn 两次 reg query + 若干 existsSync。
  // 30s 内复用上次结果（force 可跳过缓存，给"刚装完 QQ"的场景用）。
  let localQqCache = { at: 0, dir: null };
  const LOCAL_QQ_TTL = 30000;

  /** 定位本机已安装的 QQNT（带 30s 缓存）：注册表 Uninstall\QQ 优先，常见路径兜底 */
  async function detectLocalQqDir(opts = {}) {
    const now = Date.now();
    if (!opts?.force && localQqCache.at && now - localQqCache.at < LOCAL_QQ_TTL) {
      return localQqCache.dir;
    }
    const found = await detectLocalQqDirOnce();
    localQqCache = { at: now, dir: found };
    return found;
  }

  /** 注册表里可能记录 QQNT 安装位置的键（覆盖 64 位 / WOW6432Node / 当前用户三种视图） */
  const QQ_REG_KEYS = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Tencent\\QQNT',
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    'HKCU\\SOFTWARE\\Tencent\\QQNT'
  ];
  const QQ_REG_VALUES = ['InstallLocation', 'DisplayIcon', 'InstallDir', 'InstallPath', 'Path'];

  /** 由环境变量推出的 QQNT 常见目录。
   *  不写死盘符：ProgramFiles / LOCALAPPDATA / SystemDrive 都是运行时取的，
   *  所以系统装在哪个盘、QQ 装的是"全机器"还是"仅当前用户"都能覆盖到。 */
  function envBasedQqDirs() {
    const out = [];
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
      if (root) out.push(path.join(root, 'Tencent', 'QQNT'));
    }
    if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Tencent', 'QQNT'));
    const sysDrive = process.env.SystemDrive || 'C:';
    out.push(path.join(sysDrive, 'Tencent', 'QQNT'));
    return out;
  }

  /** 枚举本机硬盘盘符（如 ['C:\\','D:\\']）。失败返回空数组，探测整体不该因此失败。 */
  async function listFixedDrives() {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
          + 'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root'
      ], { timeout: 6000, windowsHide: true });
      // 只保留盘符形式（如 C:\ 或 D:\）。映射的网络驱动器会被这里滤掉，
      // 对断开的网络盘做 existsSync 可能长时间阻塞。
      return String(stdout).split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => /^[A-Za-z]:[\\/]?$/.test(x));
    } catch { return []; }
  }

  /** 兜底候选目录：环境变量优先，再枚举盘符拼（都不写死盘符）。 */
  async function qqDirFallbacks() {
    const out = envBasedQqDirs();
    for (const drive of await listFixedDrives()) {
      out.push(path.join(drive, 'Program Files', 'Tencent', 'QQNT'));
      out.push(path.join(drive, 'Program Files (x86)', 'Tencent', 'QQNT'));
      out.push(path.join(drive, 'Tencent', 'QQNT'));
    }
    return out;
  }

  /** 探测一次本机 QQNT 安装目录（无缓存）。
   *
   *  不允许出现写死盘符的路径（原实现硬编码了 C:\\ / D:\\ 五条，换台机器或把 QQ
   *  装到别的盘就整个失效）。现在按「注册表 → 环境变量 → 枚举盘符」三级兜底，
   *  只拼相对片段 Tencent\\QQNT。 */
  async function detectLocalQqDirOnce() {
    // QQNT 只有 Windows 版：注册表、Get-PSDrive、%ProgramFiles% 全是 Windows 语义，
    // 非 Windows 上直接短路，别白跑三次 reg query 再返回 null。
    if (process.platform !== 'win32') return null;
    const candidates = [];
    // ── ① 注册表：三种视图都查（只查 WOW6432Node 会漏掉 64 位安装与"仅当前用户"）──
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      for (const key of QQ_REG_KEYS) {
        for (const val of QQ_REG_VALUES) {
          try {
            const { stdout } = await execFileAsync('reg', ['query', key, '/v', val],
              { timeout: 8000, windowsHide: true });
            const m = /REG_SZ\s+(.+)/.exec(String(stdout));
            if (m) candidates.push(m[1].trim());
          } catch { /* 单个键值查不到就继续 */ }
        }
      }
    } catch { /* reg 不可用就走路径探测 */ }
    // ── ② + ③ 环境变量 / 盘符枚举 ──
    for (const base of await qqDirFallbacks()) candidates.push(base);
    for (const raw of candidates) {
      if (!raw) continue;
      // DisplayIcon 形如 "X:\dir\QQ.exe,0" → 取目录；InstallLocation 本就是目录
      let dir = String(raw).replace(/,0$/, '').trim().replace(/^"|"$/g, '');
      if (/QQ\.exe$/i.test(dir)) dir = path.dirname(dir);
      if (dir && fs.existsSync(path.join(dir, 'QQ.exe'))) return dir;
    }
    return null;
  }

  /** 源目录的 QQ.exe 是否在运行（按完整路径匹配，不碰其它 QQ） */
  async function qqRunningFromDir(dir) {
    try {
      const procs = await listQqProcesses();
      const exe = path.join(dir, 'QQ.exe').toLowerCase();
      return procs.find((p) => p.path && p.path.toLowerCase() === exe) || null;
    } catch { return null; }
  }

  /** 顶层逐条复制（fs.promises.cp 无进度回调，按顶层条目打点） */
  async function copyDirWithProgress(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    qqSetupState.total = entries.length;
    let done = 0;
    for (const ent of entries) {
      await fs.promises.cp(path.join(src, ent.name), path.join(dst, ent.name), { recursive: true, force: true });
      done++;
      qqSetupState.done = done;
      qqSetupState.step = ent.name;
      pushQqLog(`[一键安装] ${done}/${entries.length} ${ent.name}`);
    }
  }

  /** 唤起便携 QQ 主窗口（NTQQ 启动后不自动弹窗，新手找不到登录入口）。
   *  按 pid 枚举它名下有标题的顶层窗口（隐藏的也要枚举，NTQQ「关闭窗口」
   *  是 SW_HIDE），最小化的 SW_RESTORE、隐藏的 SW_SHOW，再 SetForegroundWindow 置前。 */
  async function showPortableQQ() {
    if (process.platform !== 'win32') {
      return { ok: false, error: '仅支持 Windows' };
    }
    const pid = await qqPortableRunningPid();
    if (!pid) {
      pushQqLog('便携 QQ 未在运行，无法唤起窗口');
      return { ok: false, error: '便携 QQ 未在运行 —— 请先启动 QQ' };
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const ps = [
      '$target = ' + pid,
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class QQWin {',
      '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '}',
      '"@',
      '$script:found = 0',
      '$cb = [QQWin+EnumProc]{ param($h, $l)',
      '  $wpid = [uint32]0',
      '  [QQWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null',
      '  if ($wpid -eq $target -and [QQWin]::GetWindowTextLength($h) -gt 0) {',
      '    if ([QQWin]::IsIconic($h)) { [QQWin]::ShowWindow($h, 9) | Out-Null }',
      '    elseif (-not [QQWin]::IsWindowVisible($h)) { [QQWin]::ShowWindow($h, 8) | Out-Null }',
      '    [QQWin]::SetForegroundWindow($h) | Out-Null',
      '    $script:found++',
      '  }',
      '  $true',
      '}',
      '[QQWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null',
      'Write-Output "FOUND $($script:found)"'
    ].join('\n');
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', ps
      ], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const m = /FOUND\s+(\d+)/.exec(String(stdout));
      const found = m ? Number(m[1]) : 0;
      if (found > 0) {
        pushQqLog(`已唤起便携 QQ 窗口（pid=${pid}，命中 ${found} 个窗口）`);
        return { ok: true, shown: found, pid };
      }
      pushQqLog(`未找到便携 QQ 的窗口（pid=${pid}）—— 可能还在启动`, 'stderr');
      return { ok: false, error: '没找到 QQ 的窗口 —— 刚启动的话 QQ 可能还在初始化，稍等几秒再试' };
    } catch (error) {
      pushQqLog(`唤起便携 QQ 窗口失败：${error?.message ?? error}`, 'stderr');
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 一键安装便携 QQ：从本机已安装的 QQNT 复制一份。
   * 源目录只读，绝不写用户 QQ 一个字节。
   * @param {{sourceDir?: string}} opts
   */
  async function setupPortableQQFromLocal(opts = {}) {
    if (qqSetupState.running) {
      return { ok: false, error: '正在安装中，请等当前安装完成（看下方日志的复制进度）' };
    }
    if (qqPortableReady()) {
      return { ok: true, alreadyInstalled: true };
    }
    // force：用户刚装完 QQ 就来点安装，别拿 30s 前的"没找到"糊弄他
    const sourceDir = String(opts?.sourceDir || '').trim() || await detectLocalQqDir({ force: true });
    if (!sourceDir) {
      return {
        ok: false,
        error: '没找到本机安装的 QQ（需要装过新版 QQ/QQNT）。也可以看下方日志里的说明手动指定目录'
      };
    }
    if (!fs.existsSync(path.join(sourceDir, 'QQ.exe'))) {
      return { ok: false, error: `这个目录里没有 QQ.exe：${sourceDir}` };
    }
    const busy = await qqRunningFromDir(sourceDir);
    if (busy) {
      return {
        ok: false,
        needExit: true,
        error: `本机 QQ 正在运行（pid=${busy.pid}）：请先完全退出 QQ（包括托盘图标）再点安装`
      };
    }
    qqSetupState.running = true;
    qqSetupState.done = 0; qqSetupState.total = 0;
    qqSetupState.error = null; qqSetupState.ok = false;
    qqSetupState.step = '准备复制';
    pushQqLog(`一键安装：从 ${sourceDir} 复制便携 QQ 到 ${qqPortableDir()}（源目录只读）`);
    try {
      await copyDirWithProgress(sourceDir, qqPortableDir());
      qqSetupState.running = false;
      qqSetupState.ok = true;
      qqSetupState.step = '完成';
      pushQqLog('[一键安装] 便携 QQ 安装完成 ✓ 可点「单独启动 QQ」了');
      return { ok: true, installed: true, dir: qqPortableDir() };
    } catch (error) {
      qqSetupState.running = false;
      qqSetupState.error = String(error?.message ?? error);
      pushQqLog(`一键安装失败：${qqSetupState.error}`, 'stderr');
      const busyHint = /EBUSY|EPERM|EACCES/i.test(qqSetupState.error)
        ? ' —— 多半是 QQ 还在运行或有文件被占用：完全退出 QQ 后重试'
        : '';
      return { ok: false, error: '安装失败：' + qqSetupState.error + busyHint };
    }
  }

  const emit = (type, payload) => {
    // 桌宠只关心"连接状态 / 会话状态"这几类事件（用于状态气泡与成就统计）。
    // 这是直接调用，不是插件 hook，桌宠抛错绝不能影响群聊主链路。
    if (type === 'onebot-status' || type === 'status' || String(type).startsWith('session-')) {
      try { getDesktopPetService()?.onCoreEvent?.(type, payload); } catch { /* 桌宠异常不影响群聊 */ }
    }
    // 这里不设进程内事件总线：全项目没有任何订阅者，真正的消费者只有 SSE。
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：会话一结束轮询就
            // 不再拉详情（只刷 running/waiting），载荷里没有它们的话，"已发送到 QQ"
            // 徽标要等用户手动刷新才看得到。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      // 同步异常 + 已经不可写的连接都要清理，否则集合只增不减、每次都白写
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  // OneBot WS 端口（从 protocol.wsUrl 推导，供端口就绪轮询使用）。
  function protocolWsPort() {
    try {
      const u = new URL(String(getConfig().protocol?.wsUrl || 'ws://127.0.0.1:3001'));
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }
  const onebot = new OneBotClient({
    wsUrl: cfg.protocol?.wsUrl,
    httpUrl: cfg.protocol?.httpUrl,
    accessToken: cfg.protocol?.accessToken,
    httpToken: cfg.protocol?.httpAccessToken || cfg.protocol?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  setOnebotClient(onebot);
  const sender =   new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`),
    log
  });
  const reminders = new ReminderStore();
  const videoReader = new VideoReader(onebot);
  const orchestrator = new Orchestrator({ store, memory, sender, sessions, onebot, emit, reminders, videoReader });

  /**
   * 把协议端（SnowLuma）配置文件里的端点/令牌填进 config，并立即重连。
   *
   * 调用时机：首次启动两个令牌都为空时自动跑一次；连接页「自动读取协议端配置」/
   * 「装好并登录了，重新检测」手动触发。
   *
   * 三条硬约束：
   *   ① 只补空字段（force 除外）：用户手填过令牌就以用户为准，不被探测结果覆盖；
   *   ② 地址只在"当前端口没开、探测到的端口在开"时才改，避免把特意指向另一个实例
   *      （NapCat / 双开 / 改过端口）的地址改回默认；
   *   ③ 返回值不含令牌（要经 /api 回到渲染层），失败只给原因不抛。
   *
   * @param {{force?: boolean, dir?: string}} opts
   */
  async function autoFillProtocol({ force = false, dir = '' } = {}) {
    const cur = getConfig().protocol || {};
    const hit = await detectProtocol({ dir: dir || undefined, isPortOpen });
    if (!hit.found) return { ok: false, found: false, reason: hit.reason };

    const next = {};
    // 当前 WS 端口没开、而探测到的那份在开 → 说明地址也填错了，一并纠正
    const curPortOpen = await isPortOpen('127.0.0.1', protocolWsPort());
    if (!curPortOpen && hit.wsPortOpen) {
      if (hit.wsUrl) next.wsUrl = hit.wsUrl;
      if (hit.httpUrl) next.httpUrl = hit.httpUrl;
    }
    const curWs = String(cur.accessToken || '').trim();
    const curHttp = String(cur.httpAccessToken || '').trim();
    if (hit.accessToken && (force || !curWs)) next.accessToken = hit.accessToken;
    // HTTP 令牌必须单独填：OneBotClient 的兜底 `httpAccessToken || accessToken`
    // 只在两枚恰好相同时成立。SnowLuma 默认两枚不同，拿 WS 那枚顶上照样 401。
    if (hit.httpAccessToken && (force || !curHttp)) next.httpAccessToken = hit.httpAccessToken;

    const view = protocolDetectView(hit);
    if (!Object.keys(next).length) {
      return { ok: true, ...view, applied: false, reason: '端点与令牌已是最新，无需改动' };
    }
    const saved = updateConfig({ protocol: next });
    // 只记路径与账号，不记令牌
    log(`[onebot] 已从协议端配置自动填充端点（账号 ${hit.uin || '未知'}，来源 ${hit.dir}）`);
    try {
      await onebot.setEndpoint({
        wsUrl: saved.protocol?.wsUrl,
        httpUrl: saved.protocol?.httpUrl,
        accessToken: saved.protocol?.accessToken,
        httpToken: saved.protocol?.httpAccessToken
      });
    } catch (error) {
      // 配置已落盘，只是本次重连没跑起来，如实说，别假装成功
      return { ok: true, ...view, applied: false, reason: `已保存，但重连没跑起来：${error?.message ?? error}` };
    }
    return { ok: true, ...view, applied: true, changed: Object.keys(next) };
  }

  // 远程价格表固定为官网公开地址；不从用户配置读取，避免被页面/配置篡改。
  initPriceFeed(FIXED_PRICE_FEED_URL);

  // 云端统一屏蔽名单：启动先用 data 缓存，后台同步；网络失败不影响本地拦截。
  const communitySyncTimer = startCommunitySync(log);
  communitySyncTimer.unref?.();

  // 前缀缓存保活：默认开启（会主动联网，开关改动无需重启）。
  // 保活构造前缀要用到 skillManager 的当前状态，而它晚于本行加载，所以首次 tick
  // 延迟 20 秒兜住。
  const cacheWarm = startCacheWarm(log);

  // 启动即预热：保活只能等"本次运行"构造出前缀才知道要预热什么，于是每个会话的
  // 第一次调用永远赶不上预热。这里在启动时载入上次运行落盘的前缀，直接暖一次。
  // 插件还没加载完，所以延迟 15 秒等 skillManager 就位。
  //
  // 重启后第一条仍然会掉：原因不是没预热，而是预热的前缀形状与真实调用不同。
  // loadPersistedPrefix 载入的是「上次运行」的 system+tools，本次运行的代码/工具集
  // 可能已经变了，于是预热写的是旧形状的缓存、真实调用用的是新形状，必然错位一次。
  // 修法：预热完成后把预热用的形状登记为「已预热形状」，并让 noteRealPrompt 在形状
  // 变化时自动补一次预热（见 cache-warm.js 的 noteShapeChange）。这样重启后的第一枪
  // 落在「上一次真实形状」上，第二枪时形状已对齐。
  {
    const bootWarm = setTimeout(async () => {
      try {
        // 优先用落盘的前缀；没有（首次安装/刚清过数据）就从会话存档里借一份。
        // 少了这条兜底，启动预热在第一次重启后永远没有样本，而第一次调用恰恰最需要它。
        const ok = loadPersistedPrefix() || seedPrefixFromSessions();
        if (!ok) return;
        const r = await warmOnce({ log });
        if (r.ok) {
          markCurrentShapeWarmed();   // 登记"这份形状已预热"，避免重复预热
          if (r.dedup) log(`[cache-warm] 启动预热跳过（${r.reason}）`);
          else log(`[cache-warm] 启动预热完成（${r.prompt} tok，命中 ${r.cached}）`);
        }
      } catch { /* 启动预热失败不影响任何功能 */ }
    }, 15000);
    bootWarm.unref?.();
  }

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      let quoteCap = 120;
      let fwdMid = null;
      if (Array.isArray(msg?.message)) {
        // 以前这里只有 text 段原样透传，其余一律 `[类型名]`，于是引用一条合并转发时
        // 引用块里出现字面量 `[forward]`。模型看不懂这个英文占位，转头拿外层消息的 mid
        // 去调 read_forward（引用块里没有被引用消息的 mid），协议端拉不到 →
        // 「展开失败：OneBot get_forward_msg 失败：retcode=100」。
        // 现在统一走 segmentsToText，占位符与正文同口径：[图片]/[表情]/[合并转发聊天记录]。
        // includeReply:false 是为了不递归（被引用的消息里可能还有引用）。
        text = await segmentsToText(msg.message, { includeReply: false });
        // 被引用的那条本身是合并转发时，只给占位符仍然没用：模型知道这儿有条转发，
        // 却拿不到它的 mid（引用块只带正文），只能拿外层消息去试 read_forward，
        // 试一次失败一次。就地展开塞进引用块，模型直接读到内容，根本不用调工具。
        // 展开不了（转发被服务端丢了）就保留占位符，退路仍是 read_forward。
        if (msg.message.some((s) => String(s?.type ?? '') === 'forward')) {
          try {
            // 4s 上限：这是 ingest 热路径，协议端要是卡住，不能连带把整条入库队列拖死。
            const nodes = await fetchForwardNodes(onebot, messageId, msg.message, 4000);
            const ex = await expandForwardNodes(nodes);
            // 引用块是拼在一行里的（`[引用 名字(QQ:x)：正文]`），换行会把整条消息的行结构
            // 拆散，所以展开出来的多条节点压成一行，用「 / 」隔开。
            if (ex?.text) {
              text = ex.text.replace(/\s*\n\s*/g, ' / ');
              quoteCap = 300;
              // 内容截到 300 字以后，模型看到「共 6 条」还想看全，但它手上只有引用者
              // 那条的 #数字，拿去展开必然"不是合并转发"。把被引用消息自己的 mid 带回
              // 引用块，模型要展开时填这个才对得上。
              fwdMid = String(messageId);
            }
          } catch { /* 保留占位符 */ }
        }
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      // senderId 一并带回：引用块显示为 名字(QQ:xxx)，与发言人标签同口径，
      // 没有它模型分不清引用的是哪个张三
      return { sender: String(senderName), senderId: String(msg?.sender?.user_id ?? ''), mid: fwdMid, text: String(text).slice(0, quoteCap) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃，不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    // 两道屏蔽：全局（所有群+私聊）优先，其次按群。
    if (senderId) {
      const globalBlocked = isGloballyBlocked(senderId);
      if (globalBlocked) return;
      if (kind === 'group' && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    }
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        // 语音转写（`media.transcribe`）要用它去 get_record 取音频
        onebot
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 别退回"只传 message_id"：本机协议端（SnowLuma/NapCat）的 get_forward_msg 只在
    // message_id > 0 时才替我们解析 forward 段 id，负数 id（QQ NT 里很常见）会被原样
    // 当 res_id 去拉 → "payload is empty"，转发全挂。fetchForwardNodes 优先用 forward
    // 段自带的 id（等价于协议端内部解析，不受正负限制），拿不到才退回 message_id。
    // 详见 onebot.js 该函数注释。媒体里的 url 此时是新鲜的，一并收进 media。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    // 判据必须看"这条消息自己的段里有没有 forward"，不能用 `text.includes('[合并转发')`：
    // 引用块会把被引用转发的正文就地内联，于是"引用了一条转发"的普通消息 text 里同样含
    // `[合并转发 共N条]`，用文本判据会让它每次白跑一趟 fetchForwardNodes，再被
    // NOT_FORWARD 守卫拒掉，日志里留一句误导性的"展开合并转发失败"。
    const hasOwnForward = Array.isArray(segments)
      && segments.some((s) => String(s?.type ?? '') === 'forward');
    if (hasOwnForward && event.message_id != null) {
      try {
        const nodes = await fetchForwardNodes(onebot, event.message_id, segments);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        // 两类完全不同的故障不能混成一条日志，否则排查时指不到真原因：
        // ① NOT_FORWARD，我们自己的判据问题（已用 hasOwnForward 修掉，留着分支
        //    是为了万一复发能一眼认出来）；
        // ② retcode=100 / "payload is empty"，上游协议端拿不到长消息内容。合并转发
        //    的长消息在服务器侧有保留期，过期或无权读取就返回空载荷（协议端侧
        //    SsoRecvLongMsg 的 result.payload 为空，我们改不动）。这类失败重试没用，
        //    话术要让用户知道"是这条转发读不了"，而不是"程序坏了"。
        const errMsg = String(e?.message ?? e);
        if (e?.code === 'NOT_FORWARD') {
          log(`[ingest] 展开合并转发被跳过（判据判定为非转发，属预期）: ${errMsg}`);
        } else if (e?.retcode === 100 || /payload is empty/i.test(errMsg)) {
          log(`[ingest] 合并转发内容读不到（协议端返回空载荷：该转发可能已过期或当前账号无权读取）: ${errMsg}`);
        } else {
          log(`[ingest] 展开合并转发失败（保留占位符）: ${errMsg}`);
        }
      }
    }

    if (!text && !media.length) return;

    // ── 图片入库缓存 ──
    // QQ(NTQQ) 的图片下载链接带 rkey 签名，几分钟内就失效（实测入库 48 秒后
    // get_message_images 去下载就 400，官方错误体 "download url has expired"），
    // 模型只能回"这张读不出来"。入库这一刻 url 是新鲜的，所以在这里就地排队下载
    // （image-cache.js 后台串行，不阻塞 ingest），看图工具优先读本地缓存。
    if (media.length) {
      try { cacheIncomingImages(`${kind}:${id}`, event.message_id, media); } catch { /* 缓存失败不影响入库 */ }
    }

    // ── 指令禁言：群内任何人 @机器人 + 发送指定指令 → 该群暂时固定 1 档（仅艾特）──
    // 在存档前处理：指令本身也要留档（让机器人知道被禁言了），但先设置禁言状态。
    if (kind === 'group') {
      maybeTriggerCommandMute(id, text, event);
    }

    store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    // 「收到消息」事件点（onMessage 钩子）：每条消息都经过这里。确定性扩展（反撤回缓存、
    // 开发工单的「开发 xxx」识别）不能依赖"参与度判定放行"这个不确定条件，否则反撤回的
    // onMessage 会一直空转，开发工单的指令也只有在"恰好被唤醒"时才可能被看见。
    // send：把"话筒"递给插件（开发模式的回信直接走统一发送队列：限频/去重/切分/留档）。
    try {
      await skillManager.runHook('onMessage', {
        event,
        chatKey: `${kind}:${id}`,
        senderId,
        senderName,
        text: text || '',
        // 契约字段见 doc/extend_development/skill-reference.md 第 10 节，与 onRecall 同款。
        onebot,
        sender,
        store,
        log,
        sendSegments: sendHookSegments,
        // opts 可选透传（如 { dedupe: false }），给"进度提示"这类本就该重复的内容用。
        // 不传时走默认去重。
        send: (messages, opts) => sender.sendTextBatch(`${kind}:${id}`, Array.isArray(messages) ? messages : [String(messages)], opts || {})
      });
    } catch { /* 单个钩子出错由管理器隔离并记日志，这里不阻断 ingest */ }
    // ── 开发模式让路：由 dev-orders 提供 dev.route 能力表态 ──
    // 这条消息若已被开发会话接走（白名单 + 开发模式中），普通人格不再插嘴：
    // 标记已读、只广播 chat-update（消息照常留档、UI 可见）。
    let handledByDev = false;
    try {
      const ck = `${kind}:${id}`;
      const provs = skillManager.getCapabilityProviders('dev.route', { chatKey: ck, senderId });
      for (const p of provs) {
        try {
          if (p?.fn?.({ chatKey: ck, senderId, senderName, text: text || '', mid: event.message_id })?.handled === true) {
            handledByDev = true;
            break;
          }
        } catch { /* 单个 provider 出错不影响其它 */ }
      }
    } catch { /* 没装插件就无感 */ }
    if (handledByDev) {
      store.markAllRead(`${kind}:${id}`);
      emit('chat-update', `${kind}:${id}`);
      return;
    }
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);

    // 链接媒体转发（确定性）：刻意不 await，百兆级下载/上传不能卡住 ingest 热路径。
    // 内部已把错误全部收口（含 provider 抛错），这里再挂一次 catch 只为防漏网。
    forwardLinkedMedia(kind, id, text).catch((e) => log(`[media] 链接转发失败：${e?.message ?? e}`));
  }

  /**
   * 指令禁言：检测"@机器人 + 指定指令"，命中则把该群响应档位暂时固定为 1 档。
   * 禁言状态写入 config.commandMute.active[群号] = 到期时间戳（0 = 直到手动解除）。
   */
  function maybeTriggerCommandMute(groupId, text, event) {
    const cm = getConfig().commandMute;
    if (!cm || cm.enabled !== true) return;
    const command = String(cm.command || '').trim();
    if (!command) return;
    // 必须同条消息里既 @机器人 又含指令。
    // 走统一的 isAtMe（QQ 号优先）：只比对名字的话，群名片与配置里的 botName /
    // selfNickname 不一致时会漏判，禁言指令失效。
    const atMe = isAtMe(text, {
      selfId: onebot.selfId,
      botName: getConfig().persona?.botName || '',
      selfNickname: getConfig().persona?.selfNickname || onebot.selfNickname || ''
    });
    if (!atMe) return;
    if (!text.includes(command)) return;
    // 设置禁言：durationMin>0 则到期时间戳，否则 0（直到手动解除）
    const durationMs = Math.max(0, Number(cm.durationMin) || 0) * 60000;
    const until = durationMs > 0 ? Date.now() + durationMs : 0;
    // 走 updateConfig 的函数式入口：读当前 active 与写回同一个同步块，结构上不可能被
    // 并发的另一次禁言/解禁覆盖。
    updateConfig((cfg) => ({
      commandMute: { active: { __replace__: { ...(cfg.commandMute?.active || {}), [String(groupId)]: until } } }
    }));
    const untilStr = until ? new Date(until).toLocaleTimeString('zh-CN', { hour12: false }) : '直到手动解除';
    log(`[指令禁言] 群 ${groupId} 已被「${command}」禁言，响应档位临时固定为 1 档（仅艾特），${untilStr} 解除`);
    emit('chat-update', `group:${groupId}`);
  }

  // ── 链接媒体转发（确定性触发） ──────────────────────────────────────────

  /**
   * 确定性触发：消息里出现 B站/抖音链接 → 下载并转发。
   *
   * 与 LLM 型（注册工具）的区别正在这里：插件开着，条件满足就一定会跑，
   * 模型想忽略也忽略不掉，整条链路上没有任何"让模型决定"的环节。
   *
   * 一个提供者都不在（插件未装/未启用）时立刻返回，零网络请求、零副作用。
   * 调度细节（候选链接提取、多提供者协商、失败文案）在 src/media-links.js，
   * 那部分是纯逻辑、可被测试直接驱动；这里只负责从 skillManager 取提供者。
   */
  async function forwardLinkedMedia(kind, id, text) {
    const providers = skillManager.getCapabilityProviders('media.download');
    if (!providers.length) return;
    await dispatchMediaLinks({
      urls: extractCandidateUrls(text),
      providers,
      ctx: { onebot, sender, kind, chatId: id, text },
      log
    });
  }

  async function ingestPoke(event) {    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍自己（send_poke 的 OneBot 回显）不触发处理，与 message_sent 同理（发送时已留档）。
    // 判定用事件自带的 self_id（优先），回落到 onebot.selfId：后者来自连接时的
    // get_login_info，在协议端慢启动/切号期间可能为空或指向别的账号，用错的后果是双向的：
    //   ① 真被拍时文案写成"X 拍了拍 机器人名"而不是"我"，拍一拍召唤识别不到；
    //   ② 若 selfId 恰好是群里某个普通成员的 QQ，群友拍那个人时文案变成"X 拍了拍 我"，
    //     机器人误以为在拍自己、按 1 档响应。
    const evSelfId = String(event.self_id ?? '') || onebot.selfId;
    if (operatorId && operatorId === evSelfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）：全局优先，其次按群
    if (operatorId) {
      if (isGloballyBlocked(operatorId)) return;
      if (isGroup && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    }
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = evSelfId;
    // 拍一拍也要记下真实群名片：硬编码"（拍一拍事件）"会覆盖同一 QQ 在普通消息里的
    // 真实昵称，记忆整理时取名字会拿到这个占位符，变成"某群友的名字叫（拍一拍事件）"。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    // 目标名字同样补齐（被拍者的群名片；解析不到就留 QQ 号，formatEntry 会拼 (QQ:xxx)）
    const targetName = (isGroup && String(targetId) !== String(selfId))
      ? ((await resolveAtName(id, targetId)) || targetId)
      : targetId;
    // 展示名：管理员备注 > 群名片（与消息历史同口径）
    const notes = cfgNow.memberNotes || {};
    const opLabel = notes[operatorId] || operatorName || operatorId;
    // 私聊里"用户拍机器人"没有 target_id 时回落 user_id（= 操作者），文案会变成
    // "拍了拍自己"，1v1 场景下能收到的拍一拍只可能是拍机器人，直接按"拍我"处理。
    const pokeSelf = isGroup ? String(targetId) === String(selfId) : true;
    const tgtLabel = pokeSelf
      ? '我'
      : (notes[targetId] || targetName || targetId);
    // 文案统一为「X 拍了拍 Y」视角（机器人被拍时 Y=我）。旧文案"你拍了拍（来自 张三）"
    // 视角混乱（读起来像"我拍了别人"），是机器人被拍时识别错乱的主因。名字带 QQ 号，
    // 与发言人标签同口径。
    const opWithId = String(operatorId) ? `${opLabel}(QQ:${operatorId})` : opLabel;
    const tgtWithId = (pokeSelf || !String(targetId)) ? tgtLabel : `${tgtLabel}(QQ:${targetId})`;
    // 群内"自己拍自己"（target_id 缺失回落成操作者，或真的自拍）→ "拍了拍自己"；
    // 私聊没有群自拍语义，缺 target_id 时回落值就是操作者，但 1v1 里能收到的
    // 拍一拍只可能是拍机器人，走"拍了拍 我"分支（pokeSelf 已置 true）。
    const text = (operatorId === targetId && isGroup)
      ? `[拍一拍] ${opWithId} 拍了拍自己`
      : `[拍一拍] ${opWithId} 拍了拍 ${tgtWithId}`;
    // 拍一拍是"轻量召唤"信号：作为触发批发给模型（isPoke 标记让档位判定按 1 档响应），
    // 但不进【过去状态】历史，buildPastState 会跳过 isPoke，存档里只留一条轻量记录
    // （聊天记录页仍可见，模型历史里不出现）。
    // 同时落 pokeSelf 真值标记：档位判定（"是不是拍我"）不靠正则猜文本
    // （被拍者名字以"我"开头时会误判），以入库时的身份判定为准。
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: [],
      isPoke: true,
      pokeSelf
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）。
      // 判定优先用事件自带的 self_id（每条事件的权威"这是谁的视角"），回落到
      // onebot.selfId，后者在协议端慢启动/切号期间可能为空或指向别的账号，
      // 用错时机器人的发言会被当群友消息入库、真群友的消息反被丢弃。
      const evSelfId = String(event.self_id ?? '') || onebot.selfId;
      if (String(event.user_id ?? event.sender?.user_id ?? '') === evSelfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 撤回事件：群撤回 group_recall / 好友撤回 friend_recall
    // 用户撤回的消息，后续会话不再发给大模型（从存档里标记/删除）。
    if (event.post_type === 'notice' && (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall')) {
      return handleRecall(event);
    }
    // 群禁言通知（OneBot group_ban）：机器人自己被禁言/解禁的权威事件源。
    // 这条通知曾被当"不关心的事件"直接丢弃，ban-state 插件的两条写入来源（协议层
    // 通知 / 发送被拒兜底）双双落空，唯一的查询兜底又被缓存架空，实测禁言 10 分钟
    // 烧 19.5 万 token。
    if (event.post_type === 'notice' && event.notice_type === 'group_ban' && event.group_id != null) {
      return handleGroupBan(event);
    }
    // 未识别的 notice / request：记一条 debug 落盘（默认级别 info 过滤掉，零噪音；
    // 排障时把日志级别调到 debug 就能看见）。静默丢弃曾是排查最大的障碍，
    // group_ban 被丢了一年都没人发现，同类 bug（通知到了、没人处理、无痕迹）从此
    // 在日志里可见。meta_event（心跳）除外，那条没有排查价值。
    if ((event.post_type === 'notice' || event.post_type === 'request') && event.post_type !== 'meta_event') {
      logger.debug('app',
        `未处理的事件：post_type=${event.post_type}`
        + ` notice_type=${event.notice_type ?? '-'} sub_type=${event.sub_type ?? '-'}`
        + ` group_id=${event.group_id ?? '-'} user_id=${event.user_id ?? '-'}`);
    }
    // meta/心跳等事件忽略
  }

  /**
   * 处理群禁言通知（OneBot v11: notice_type=group_ban）。
   *
   * 协议端（SnowLuma）的转换口径（to-notice.ts convertGroupMute）：
   *   sub_type = duration > 0 ? 'ban' : 'lift_ban'，duration 为禁言秒数。
   *   OneBot v11 原语义里「ban 且 duration=0」也是解禁，一并按解禁处理。
   *
   * 只认 user_id === self_id 的通知：群友被禁言与机器人无关，误把自己标成禁言会让
   * 整个群停止回复。self_id 用事件自带值优先，回落 onebot.selfId（与 message / poke
   * 同口径，慢启动/切号期间 get_login_info 可能为空或指向别的账号）。
   */
  function handleGroupBan(event) {
    const evSelfId = String(event.self_id ?? '') || onebot.selfId;
    const userId = String(event.user_id ?? '');
    if (userId && userId !== evSelfId) {
      logger.debug('app', `群 ${event.group_id} 的禁言通知与机器人无关（user_id=${userId}），忽略`);
      return;
    }
    const chatKey = `group:${String(event.group_id)}`;
    const duration = Number(event.duration) || 0;
    const isBan = event.sub_type === 'ban' && duration > 0;
    try {
      if (isBan) {
        noteMuted(chatKey, duration);
        logger.info('app', `群 ${event.group_id} 机器人被禁言 ${duration} 秒，已记录禁言状态（期间跳过处理）`);
      } else {
        noteUnmuted(chatKey);
        logger.info('app', `群 ${event.group_id} 机器人禁言解除，已恢复正常处理`);
      }
    } catch (error) {
      // ban-state 插件缺失/坏了不该影响事件处理本身（查询兜底仍在）
      logger.warn('app', `禁言状态写入失败（${chatKey}）：${error?.message ?? error}`);
    }
  }

  /** 处理消息撤回：把对应 mid 的存档消息标记为已撤回（后续提示词过滤掉）。 */
  function handleRecall(event) {
    const isGroup = event.notice_type === 'group_recall';
    const chatKey = isGroup ? `group:${String(event.group_id)}` : `private:${String(event.user_id)}`;
    const mid = event.message_id;
    if (mid == null) return;
    const marked = store.markRecalled(chatKey, mid);
    if (marked) {
      log(`[撤回] ${chatKey} 消息 #${mid} 已被撤回，后续不再发给模型`);
      emit('chat-update', chatKey);
    }
    // onRecall 钩子：反撤回插件在这里把撤回的消息原文重发回群。
    // 无论 store 里有没有标记成功都要发，插件的缓存与 store 是两套记录。
    // ctx 必须带齐 onebot/sender/store/log/sendSegments：runHook 原样透传 ctx，
    // 缺任何一项都会让 anti-recall 的 sendSegmentsSafe 三级回退落空（ctx.onebot.call
    // 抛 TypeError 被 catch 吞掉），撤回时机器人毫无反应。见 doc/extend_development/skill-reference.md 第 10 节。
    // 段发送通过 SendQueue，准入、限频、去重与留档口径一致。
    try {
      skillManager.runHook('onRecall', {
        event, chatKey, mid, onebot, sender, store, log,
        sendSegments: sendHookSegments
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  async function sendHookSegments(kind, id, segments) {
    const label = await segmentsToText(segments, { includeReply: false });
    return sender.sendMedia(`${kind}:${id}`, segments, { label, dedupeKey: JSON.stringify(segments) });
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // ── 请求体读取 ──────────────────────────────────────────────────────────
  // 抛出的错误必须是可暴露的 HTTP 错误（带 .expose 标记），由 /api 分发层统一转成
  // 4xx。否则 JSON.parse 异常会冒成 500；"超限直接 throw" 还会让没读完的 socket
  // 变脏，客户端连接池下次复用这条连接就是 ECONNRESET。
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const HARD_BODY_LIMIT = 16 * 1024 * 1024;   // 超此值不再排空，直接断链
  function httpError(status, message) {
    const e = new Error(message);
    e.expose = true;
    e.status = status;
    return e;
  }

  async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        throw httpError(413, '请求体过大');
      }
      if (size > maxBytes) {
        tooLarge = true;          // 继续读干净（内容丢弃），保证连接可复用
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw httpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, '请求体不是合法 JSON');
    }
  }

  // ── 来源校验（CSRF / DNS rebinding 防护）────────────────────────────────
  // 服务只监听回环，但浏览器里的任意网页都能向 127.0.0.1 发简单请求，而 CORS 只挡
  // "读响应"、挡不住"副作用"（改配置、暂停、重置数据…）。所以所有 /api/* 都必须来自
  // 回环 Host；带 Origin/Referer 时必须同源。
  function isLoopbackHostHeader(host) {
    return /^127\.0\.0\.1(:\d+)?$/.test(host)
      || /^localhost(:\d+)?$/.test(host)
      || /^\[::1\](:\d+)?$/.test(host);
  }

  /** 请求是否带了「可归属来源」信息（Origin 或 Referer 或 Sec-Fetch-Site）。 */
  function hasProvenance(req) {
    if (String(req.headers.origin ?? '')) return true;
    if (String(req.headers.referer ?? '')) return true;
    // 本应用自己把 Referer 掐掉了：静态服务器给控制台页面发的是
    // `referrer-policy: no-referrer`，页面里发的同源 fetch 永远不带 Referer，
    // 同源 GET 也不带 Origin。Sec-Fetch-Site 是浏览器强制标注的请求来源类别，
    // 页面脚本改不了、不受 referrer-policy 影响、curl 默认也不发，正好补上
    // "请求确实出自我们自己的页面"。
    // 安全性没有放宽：本机进程本来就能伪造 Referer（Sec-Fetch-Site 同理），
    // 这里仍要再过 originAllowed() 的回环 Host 校验；密钥端点的强凭据是
    // keyEndpointAllowed() 里那个进程私有的渲染进程凭据。
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'same-origin') return true;
    return false;
  }

  /**
   * @param {boolean} [opts.readOnly] 传入 true 时表示这是一个只读请求（GET/HEAD）。
   *   无来源信息时，只读请求放行、有副作用的请求拒绝。
   *
   * 回环绑定只挡远程，不挡本机上的任何进程（非管理员即可）。若对"无来源信息"一律
   * 放行，`curl http://127.0.0.1:3210/api/api-key` 就能读走明文主 API Key，
   * /api/reset-data（删库）、/api/config（改配置）同理。
   * 所以无来源信息（curl / 本机脚本 / 地址栏直达）时只有只读请求放行。
   * 控制台不受影响：页面里的 fetch 虽然是同源，但浏览器会带 Referer 或
   * Sec-Fetch-Site，走的是上面两条正常校验。
   */
  function originAllowed(req, opts = {}) {
    const host = String(req.headers.host ?? '');
    if (!isLoopbackHostHeader(host)) return false;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const u = new URL(origin);
        return isLoopbackHostHeader(u.host) && u.host === host;
      } catch { return false; }
    }
    const referer = String(req.headers.referer ?? '');
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无来源信息（curl / 本机脚本 / 地址栏直达）
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    if (opts.readOnly) return true;
    return false;
  }
  // ── 外部脚本调用口径（常被问"为什么 POST 全 403"）──────────────────────
  // 这是上面的有意设计：回环绑定挡不住本机其它进程，无来源的写请求一律拒绝。
  // 脚本要调写接口，两条正路：
  //   1. 带 `Origin: http://127.0.0.1:<实际端口>` 头（实际端口看 <DATA_DIR>/console-port，
  //      多安装并存时不一定等于 config.server.port）；
  //   2. 配置 server.token 后，外部脚本带 `x-console-token: <token>` 头或 ?token= 参数
  //      （过 authorize；但 originAllowed 仍要求 Origin 同源，两条都要满足）。
  // Electron 控制台的随机凭据由主进程通过 webRequest 注入，不暴露到渲染页面。
  // 纯读取（GET）无来源也放行，脚本探测无需任何头。

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token
      || url.searchParams.get('token') === token
      || req.headers['x-console-token'] === rendererAuthToken;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 字段名命中这些模式的值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
  // cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie 是登录凭据，
  // 曾经 pattern 不认导致 /api/config 明文返回。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // 必须"删除字段"而不是"置为空串"：前端保存设置时会把整个 config 展开成
          // patch 回传（...c.webSearch?.deepseek），留一个空串，deepMerge 就会拿它
          // 覆盖掉服务端保存的真 Key，用户点一次"保存设置"，所有搜索 Key 被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自外部网页冒用浏览器读 127.0.0.1（CSRF / DNS
   * rebinding），所以防线是「校验请求来源」。
   *
   * 历史实现里有一句 `if (req.headers['x-console-token']) return true`：
   * 只看"有没有这个头"、不看值，等于任何人加个头就能读明文密钥。已删除。
   */
  function keyEndpointAllowed(req) {
    // ① 渲染进程凭据：主进程用 webRequest 注入，进程私有（每次启动随机 32 字节）、
    //    不落盘、不进 DOM、不进 preload。这是控制台自己的最强凭据，必须独立判定。
    //    这条判断曾经被写在对 `if (token)` 的分支里，`config.server.token` 为空
    //    （默认值，也是 Electron 控制台的常态）时整段被跳过，最强的凭据从头到尾没被
    //    看过一眼，只能落到 hasProvenance()。而控制台页面带 referrer-policy: no-referrer、
    //    同源 GET 又不带 Origin，于是所有密钥端点恒 403。
    if (rendererAuthToken && req.headers['x-console-token'] === rendererAuthToken) return true;

    // ② 用户自配的 server.token（给外部脚本用；也可放在 ?token= 上）。
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token
        || url.searchParams.get('token') === token) return true;
    }
    // 这里不能退化成 originAllowed 的"无来源即放行"：明文密钥端点全是只读 GET，
    // 跟着放行的话本机任意进程 curl 一下就能读走主 API Key。
    // ①② 已经覆盖了控制台（渲染进程凭据）和脚本（server.token）两条正路；剩下的 ③
    // 只给"没有配置 token、又从浏览器里打开控制台"的兜底，且不能默认生效，
    // Origin / Referer / Sec-Fetch-Site 都是客户端可自由设置的请求头，本机任意进程
    // 伪造一个同源 Origin 就能读走明文凭据。外部浏览器要读密钥：先配 server.token
    // 带 x-console-token，或显式打开 server.allowBrowserKeyRead（默认 false，
    // 自己承担本机其他进程可读的风险）。
    if (getConfig().server?.allowBrowserKeyRead === true) {
      return hasProvenance(req) && originAllowed(req);
    }
    return false;
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // 声明式路由表（src/routes.js）：把所有依赖一次性注入。
  // 路由 handler 通过闭包取用这些依赖，handleHttp 只负责匹配分发。
  const apiRoutes = createRoutes({
    store, memory, sessions, onebot, orchestrator, sender,
    emit, log,
    localVersion, compareSemver,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    showPortableQQ, setupPortableQQFromLocal,
    visionScan, isPortOpen,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills,
    // 协议端配置探测（连接页「自动读取」/ 首次启动兜底）
    autoFillProtocol, detectProtocol
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      if (!originAllowed(req)) return json(res, 403, { error: '请求来源不被信任' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      // 心跳：半开 TCP（拔网线 / NAT 超时，没有 FIN）不会触发 req 'close'，
      // 少了心跳这些客户端会永久留在 sseClients 里，之后每次 emit 都白写一遍。
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面 error/close 会清理 */ }
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      // 异步写错误不会走 try/catch，必须显式兜住，否则会变成 uncaughtException
      res.on('error', cleanup);
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      // 来源校验：挡住"恶意网页借浏览器打 127.0.0.1"（CSRF / DNS rebinding）。
      // 必须在 authorize 之后、路由分发之前。
      if (!originAllowed(req)) {
        return json(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
      }
      const method = req.method;

      // 桌宠接口：必须留在上面 authorize + originAllowed 之后，它复用控制台
      // 鉴权与同源口径，屏幕截图只进桌面上下文，不额外开口子。
      if (pathname.startsWith('/api/desktop-pet/')) {
        try {
          await handleDesktopPetRequest({ req, res, url, readBody, json, desktopHost: desktopPetHost, emit });
        } catch (error) {
          log('[desktop-pet] API 处理失败：', error?.message ?? error);
          if (!res.headersSent) json(res, error?.status || error?.statusCode || 500, { ok: false, error: String(error?.message || '桌宠操作失败') });
          else if (!res.writableEnded) res.end();
        }
        return;
      }

      // 声明式路由分发（路由表在 src/routes.js）
      try {
        for (const route of apiRoutes) {
          if (route.method !== '*' && route.method !== method) continue;
          let match = null;
          if (typeof route.pattern === 'string') {
            if (route.pattern !== pathname) continue;
          } else {
            match = route.pattern.exec(pathname);
            if (!match) continue;
          }
          return await route.handler({ req, res, url, pathname, method, match, json });
        }
      } catch (error) {
        // readBody 等抛出的"可暴露错误"统一转 4xx；其余记日志、返回 500 而不是让连接挂掉
        if (error?.expose && Number.isInteger(error.status)) {
          return json(res, error.status, { error: String(error.message || '请求无效') });
        }
        log(`[api] ${method} ${pathname} 处理失败：${error?.stack ?? error?.message ?? error}`);
        return json(res, 500, { error: '服务器内部错误' });
      }
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }


    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".."（"/....//" 删完仍还原出 ".."），
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      // ── 插件自带页面：/plugin-panel/<id>/…（只读）───────────────────────
      // 这是"插件能在控制台里放自己界面"的唯一出口。完整契约见 src/skills/panel.js；
      // 插件在 plugin.json 的 configSchema 里声明 { type: 'action', panel: 'panel/x.html' }，
      // 加载时被规范成 manifest.panels（含校验好的 URL），设置弹窗据此渲染按钮。
      //
      // 两个根，都只读：
      //   /plugin-panel/<id>/…        → <APP_ROOT>/plugins/<id>/… 或 <APP_ROOT>/skills/<id>/…
      //   /plugin-panel/<id>/@data/…  → <DATA_DIR>/plugin-data/<id>/…
      // 后者是插件运行时数据的出口：api.storage 写进去的东西，页面 fetch 出来用。
      // 没有它，插件想给页面喂数据就只能塞一份静态副本，每次变化都要重新生成。
      //
      // 安全（五道）：
      //   ① 来源校验：只有本机控制台同源 / 无来源的 GET 能过（同 /api 的口径）。
      //      与 /ui 的静态分支不同，那边是应用自身资源，这里可能带插件运行时数据。
      //   ② id 只允许 [A-Za-z0-9._-] 且必须真实存在于 plugins/ 或 skills/ 下。
      //      上面已按 / \ 切过段，所以 id 里不可能带路径分隔符。
      //   ③ 其余段沿用同一套校验（拒 .. / 控制字符）。
      //   ④ 扩展名白名单（PANEL_FILE_TYPES）：不做通用文件下载器。
      //   ⑤ realpath 二次确认，挡符号链接/目录联接指向目录外，这是 path.relative 挡不住的。
      if (clean[0] === PANEL_ROUTE_PREFIX.slice(1) && clean.length >= 3) {
        if (!originAllowed(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        const panelId = clean[1];
        const rest = clean.slice(2);
        const fromData = rest[0] === PANEL_DATA_SEGMENT;
        if (fromData) rest.shift();
        const idOk = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(panelId);
        let root = null;
        if (idOk && rest.length) {
          if (fromData) {
            root = path.join(DATA_DIR, 'plugin-data', panelId);
          } else {
            for (const base of [PLUGINS_DIR, SKILLS_DIR]) {
              const cand = path.join(base, panelId);
              try { if (fs.statSync(cand).isDirectory()) { root = cand; break; } } catch { /* 试下一个 */ }
            }
          }
        }
        // realpath 一把过：既确认存在，又消掉符号链接
        let realRoot = null;
        let realFile = null;
        if (root) {
          try {
            realRoot = fs.realpathSync(root);
            realFile = fs.realpathSync(path.join(root, ...rest));
          } catch { /* 不存在 → 走下面 404 */ }
        }
        const inside = Boolean(realRoot && realFile)
          && (realFile === realRoot || realFile.startsWith(realRoot + path.sep));
        const panelType = inside ? PANEL_FILE_TYPES[path.extname(realFile).toLowerCase()] : null;
        if (!panelType) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        try {
          const data = fs.readFileSync(realFile);
          const headers = { 'content-type': panelType, 'cache-control': 'no-cache' };
          if (panelType.startsWith('text/html')) {
            // CSP 由 panelCsp() 统一给出（见 src/skills/panel.js 的注释：
            // script-src 'self' 禁内联脚本、frame-ancestors 'self' 允许被设置弹窗嵌）。
            headers['content-security-policy'] = panelCsp();
            headers['x-content-type-options'] = 'nosniff';
            headers['referrer-policy'] = 'no-referrer';
          }
          res.writeHead(200, headers);
          res.end(data);
          return;
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
      }

      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
        const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' };
        if (ext === '.html') {
          // CSP 用 HTTP 头再声明一次：header 里的 frame-ancestors 才生效（meta 版本会被
          // 浏览器忽略该指令），同时给不解析 meta 的场景兜底。
          // 口径必须与 index.html 的 meta 版本逐条一致，双份 CSP 取交集执行：人机验证
          // 接入时只改了 meta、漏了这份头，script-src 少了 kondius.cn，SDK 脚本被头拦死，
          // 滑块永远"加载失败"。改 meta 时务必同步这里。
          headers['content-security-policy'] = [
            "default-src 'self'",
            // 桌宠页（/desktop-pet/pet.html）要跑 Live2D：Cubism Core 是 WebAssembly，
            // 必须放行 wasm-unsafe-eval。只对这一个路径开口子，它不等于 JavaScript 的
            // 'unsafe-eval'（那条仍然全线禁止，PixiJS 用随包的替代实现绕开 eval，
            // 见 ui/desktop-pet/vendor/）。
            clean.join('/') === 'desktop-pet/pet.html'
              ? "script-src 'self' 'wasm-unsafe-eval'"
              : "script-src 'self' https://kondius.cn https://o.alicdn.com",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            "media-src 'self' data: blob:",
            "connect-src 'self' https://kondius.cn",
            "font-src 'self' data:",
            // 'self' 不能省：插件自带页面（表情库 viewer.html 等）是同源
            // http://127.0.0.1:port/plugin-panel/... 的 iframe，只写 https: 会让
            // 「查看收藏的表情」等入口直接 ERR_BLOCKED_BY_CSP。
            // 与 ui/index.html 的 meta 版本必须逐条一致（双份 CSP 取交集）。
            "frame-src 'self' https:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          headers['x-content-type-options'] = 'nosniff';
          headers['referrer-policy'] = 'no-referrer';
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // localhost 长连接下 Node 默认 keepAliveTimeout(5s) 比 Chromium 空闲 socket 复用
      // 窗口短，服务端先关了 socket 而渲染进程还拿它复用，触发 ERR_CONNECTION_RESET，
      // 前端表现为"Failed to fetch"（curl 是新连接不受影响）。把服务端保活时间抬到
      // Chromium 空闲超时之上，避免"服务端已关、客户端还在用"的半死 socket。
      server.keepAliveTimeout = 61000;
      server.headersTimeout = 65000;
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // ── 版本迁移（必须排在插件扫描和便携 QQ 路径解析之前）─────────────────
    // 注册表见 upgrade.js 的 UPGRADES。典型场景：老用户升级后，旧版被删掉的插件
    // 目录还在（免安装覆盖路径只写新文件、不删旧文件），config.trustedPlugins 里
    // 指向它的引用也还在，信任闸按目录名直接放行，残留插件就会照常加载、与新插件
    // 抢同名能力。reloadSkills 读的正是这份 trustedPlugins。
    // 同步、开销极小（几次 stat），失败也绝不阻塞启动。
    try {
      runUpgrades({ log });
    } catch (error) {
      log(`[upgrade] ⚠️ 迁移流程异常（不影响启动）：${error?.message ?? error}`);
    }

    // ── 启动顺序 ──────────────────────────────────────────────────────
    // 启动关键路径只余 HTTP → 遥测 → Skill 加载 → OneBot 连接。Skill 与协议端互不依赖，
    // 协议端改由用户自行运行后不再串行等待；会话索引的磁盘对账
    // （reconcileInBackground）在 HTTP 起来后就排上，不占启动关键路径。
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 实际端口落盘：多安装并存时 basePort 起步逐个 +10 试听，实际端口往往 ≠
    // config.server.port，外部脚本/运维无从得知。写到 <DATA_DIR>/console-port（一行数字），
    // 每次启动覆盖；故意不在退出时删除，应用没起时脚本还能读到"上次端口"作为猜测起点。
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'console-port'), String(port), 'utf8');
      log(`[api] 控制台实际端口 ${port} 已写入 ${path.join(DATA_DIR, 'console-port')}`);
    } catch (e) { log(`[api] ⚠️ 端口落盘失败（不影响使用）：${e?.message ?? e}`); }

    // 匿名用量遥测：默认关闭（config.telemetry.enabled），未启用时不装任何定时器。
    // 要自己收数据时在 config.json 填 telemetry.reportUrl 并打开开关。
    startTelemetryLoop(log);

    // 会话索引后台对账：启动读的是毫秒级缓存，这里异步补扫磁盘修正差异
    // （缓存缺失的新文件/外部删除的文件）。不 await，不挡任何启动步骤。
    sessions.reconcileInBackground();

    // 用量档案预热：首次打开用量页的卡顿来自"冷 parse 全部会话文件"
    //（实测 1.3~1.9 秒）。启动后台先预热一次（collectUsageRows 内部分片让步，不阻塞
    // 事件循环），用户点开用量页时档案已就绪。不 await；失败静默（用量页会自己再算）。
    collectUsageRows({ range: '7' }).catch(() => {});

    const skillsReady = (async () => {
      try {
        const pluginResult = await reloadSkills({ reason: 'boot' });
        const okCount = pluginResult.loaded.length;
        const failCount = pluginResult.failed.length;
        if (okCount > 0) log(`[skill] 已加载 ${okCount} 个 Skill`);
        for (const f of pluginResult.failed) {
          log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
        }
        if (failCount > 0) log(`[skill] ${failCount} 个 Skill 加载失败`);

        const toolCount = orchestrator.refreshToolDefs();
        log(`[skill] 工具集已刷新：${toolCount} 个工具`);

        // 热重载日志：reloadSkills({reason:'boot'}) 里已经把 watcher 建好了
        // （默认开 config.extensions.hotReload，QQ_AGENT_DEV=1 可强制打开）
        if (pluginWatcher) {
          // 明确告知"落地的代码会被执行"，让用户知道这个行为的边界
          log('[skill] 热重载已启用：放入 plugins/ 或 skills/ 的目录会自动加载并执行'
            + '（要关闭请设 config.extensions.hotReload=false）');
        } else {
          log('[skill] 热重载未启用（config.extensions.hotReload=false）：改动后需重启');
        }
      } catch (error) {
        log('[skill] 加载失败:', error?.message ?? error);
      }
    })();

    // 出窗不死等 Skill 加载：main.js 是 core.start() 完成后才 createWindow，
    // 而协议端就绪只影响 OneBot 首连，首连失败有现成兜底（connectLoop 退避重试 +
    // 2 秒一次的端口就绪轮询）。启动关键路径只给 Skill 加载留 5 秒宽限，到点继续。
    const SKILL_GRACE_MS = 5000;
    let skillGraceTimer = null;
    const boundedSkillsReady = Promise.race([
      skillsReady,
      new Promise((resolve) => {
        skillGraceTimer = setTimeout(() => {
          log(`[skill] 初始化超过 ${SKILL_GRACE_MS / 1000} 秒，先继续打开控制台；插件加载仍在后台等待。`);
          resolve('skills-grace-timeout');
        }, SKILL_GRACE_MS);
      }),
    ]);
    await boundedSkillsReady;
    if (skillGraceTimer) clearTimeout(skillGraceTimer);

    await onebot.connect();

    // ── 首次启动自动读取协议端配置 ──────────────────────────────────────
    // 令牌是 SnowLuma 按账号随机生成的，让新用户从 WebUI 抄两串 43 位随机字符是首次
    // 配置最容易卡死的一步（现象：端口通了但 401，页面只会说"令牌不一致"）。
    //
    // 只在两个令牌都为空时跑：这是"从没配过"的可靠信号；用户手填过任何一枚，
    // 就说明他会配，此时静默探测反而可能把对的值覆盖成错的。
    // 异步、不 await，探测要 spawn 一次 PowerShell（实测约 0.8 秒），不能挡住开窗。
    const shouldAutoFill = () => {
      const p = getConfig().protocol || {};
      return !String(p.accessToken || '').trim() && !String(p.httpAccessToken || '').trim();
    };
    let lastAutoFillAt = 0;
    const runAutoFill = async (why) => {
      lastAutoFillAt = Date.now();
      try {
        const r = await autoFillProtocol();
        if (r?.applied) log(`[onebot] ${why}：已自动读取协议端配置并重连（账号 ${r.uin || '未知'}）`);
        else if (r?.found) log(`[onebot] ${why}：探测到协议端配置，与当前设置一致`);
        else log(`[onebot] ${why}：${r?.reason || '未找到协议端配置'}`);
      } catch (error) {
        // 探测是"锦上添花"：失败一律不影响连接，用户还能手动填
        log('[onebot] 自动读取协议端配置失败（已忽略）：', error?.message ?? error);
      }
    };
    if (shouldAutoFill()) setTimeout(() => void runAutoFill('首次启动'), 0);

    // ── OneBot 端口就绪轮询 ────────────────────────────────────────────────
    // WS 3001 只有「QQ 登录 → Hook 检出 → OneBot 实例拉起」后才监听。常见时序：
    // QQ Agent 先启动（此时 3001 未开）→ connectLoop 吃 ECONNREFUSED → 退避涨到
    // 30 秒 → 用户在这中间扫码登录 → 3001 开了，但下一次重试可能还要等二十多秒。
    // 这里每 2 秒探一次 WS 端口，端口一开立即触发重连（走 connectLoop 的代际互斥，
    // 不会产生并发连接）。已连接后轮询自动停止；断线时自动恢复，恢复延迟从
    // "最多 30 秒"降到"最多 2 秒 + 一次连接建立"。
    const obWsPort = protocolWsPort();
    // 边沿触发：原实现端口开着就每 2 秒无条件 reconnect()，而 reconnect 会清零
    // onebot 的指数退避，端口已开但连接失败（如 token 未就绪）时退避完全失效，
    // 被钉死在 2 秒一轮，协议端侧日志里全是永不收敛的 unauthorized 尝试。
    // 只在"关→开"的边沿触发一次重连，之后交给 onebot 自己的退避循环。
    let obPortWasOpen = false;
    // 首轮探测只建立基线，不能当成"关→开"边沿：冷启动时进程已经是连接状态、
    // obPortWasOpen 初值为 false，不区分的话第一次探测就会误判为"端口刚开"而白重连一次。
    let obPortEdgePrimed = false;
    obPortPollTimer = setInterval(async () => {
      // 整段兜住异常：这是个 async 定时器回调，抛出的异常没人 await → unhandledRejection。
      // 主进程那条兜底只记日志、不退出，所以一旦这里每 2 秒抛一次，用户看到的就是
      // "窗口还在、但什么都不工作"的半死状态。宁可单轮失败。
      try {
      // ── 已连接时也要更新端口边沿状态 ─────────────────────────────────────
      // 旧写法是 `if (onebot.connected) return;`，obPortWasOpen 只在"未连接"分支里更新。
      // 若协议端在一个轮询周期内快速重启（端口关→开），而 QQ Agent 的 socket 还没收到
      // close（TCP 半开，connected 仍为 true），这次边沿就被永久吞掉。connected 时
      // 顺手探一次端口，成本是一次本机 connect。
      if (onebot.connected) {
        const stillOpen = await isPortOpen('127.0.0.1', obWsPort);
        // 只是"把状态记下来"还不够：端口关过一次又开（协议端重启 / 换端口前的短暂
        // 关闭），说明手里这条 socket 连的已经是上一代进程，边沿必须在这里消费掉，
        // 否则要等 TCP 自己超时才发现断线。reconnect 内部有连接代际互斥，不会双连。
        if (obPortEdgePrimed && stillOpen && !obPortWasOpen) {
          onebot.reconnect();
        }
        obPortWasOpen = stillOpen;
        obPortEdgePrimed = true;
        return;
      }
      // 这里不做「selfId 自动学习 botQQ」：selfId 只是「当前占用 OneBot 端口的账号」，
      // 双号在线时会抓到个人号。botQQ 只有两个可靠来源：
      //   ① 用户在页面「注入目标」显式输入/点选；
      //   ② QQ Agent 自己启动的 QQ 注入成功后，把 probe-login 读到的 uin 记下来
      //     （协议端自行管理账号注入）。
      const open = await isPortOpen('127.0.0.1', obWsPort);
      obPortEdgePrimed = true;   // 未连接分支自己就在处理边沿，从此开始按边沿判定
      if (open && !obPortWasOpen && !onebot.connected) {
        // 端口从关到开：协议端就绪（QQ 登录完成 / 协议端刚拉起）。
        // 若这时还没配令牌（典型时序：先开 Agent，再去装/登录 SnowLuma），先试一次
        // 自动读取，否则只会拿空令牌去撞 401，撞到用户自己去翻配置为止。
        // 30 秒冷却：协议端反复重启时，别每次都 spawn 一遍 PowerShell。
        if (shouldAutoFill() && Date.now() - lastAutoFillAt > 30000) {
          // 探测成功会自己走 setEndpoint → reconnect；失败时下面这条 reconnect
          // 负责恢复，两条路径都有连接代际互斥兜底，不会双连。
          void runAutoFill('检测到协议端启动');
        }
        // 立即重连（reconnect 会重置退避，秒级恢复）。
        onebot.reconnect();
      }
      obPortWasOpen = open;
      } catch (error) {
        try { log('[onebot] 端口轮询异常（已忽略，2 秒后继续）:', error?.message ?? error); } catch { /* ignore */ }
      }
    }, 2000);
    obPortPollTimer.unref?.();

    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点往群里发提醒
    log(`控制台已就绪：http://127.0.0.1:${port}`);

    // ── 用量档案后台预热 ─────────────────────────────────────────────────
    // 首次打开用量页要先把全部会话文件解析一遍（实测 170MB ≈ 3.1 秒）。延迟 8 秒
    // 避开启动高峰（插件加载 / 价格表 / 遥测都挤在头几秒），解析本身分片让步不阻塞
    // 事件循环。
    const usageWarmTimer = setTimeout(() => {
      warmUsageArchive()
        .then((r) => { if (r) log(`[usage] 用量档案已后台预热（${r.files} 个会话，${r.ms}ms）`); })
        .catch((error) => log(`[usage] 后台预热失败（首次打开用量页时会现场重算）：${error?.message ?? error}`));
    }, 8000);
    usageWarmTimer.unref?.();

    // ── 数据盘空间巡检 ───────────────────────────────────────────────────
    // 应用本体原来没有任何磁盘满处理：写不进去时只会看到一串次级错误，真正的"盘满了"
    // 反而不见。这里启动时查一次 + 每小时一次，水位过低就记警告/错误；critical 档另由
    // image-cache.js 的 enabled() 停止写入（见 disk-space.js）。
    const diskCheck = () => {
      // 同步定时器回调必须自己兜异常：这里抛出去没有任何 try/catch 能接住，直接变成
      // uncaughtException → 主进程弹窗后 app.exit(1)。diskPressure() 内部要 statfs /
      // 查盘，权限、卷被卸载、网络盘掉线都可能抛，「磁盘巡检失败」不该等于「整个程序退出」。
      try {
        const level = diskPressure();
        if (level === 'ok') return;
        const text = diskPressureText();
        if (level === 'critical') log(`[disk] 🔴 ${text} —— 已暂停图片缓存写入，请清理空间`);
        else log(`[disk] 🟡 ${text} —— 建议清理（图片缓存 TTL 3 天 + 总量闸 2GB）`);
      } catch (error) {
        // 同上：catch 里也不许再抛（log 失败 → 这里的抛出就是 uncaughtException）
        try { log(`[disk] 磁盘巡检异常（已忽略，不影响运行）: ${error?.message ?? error}`); } catch { /* ignore */ }
      }
    };
    diskCheck();
    // 赋值给外层 let，不能用 const（会遮蔽，stop() 里的 clearInterval 永远清不到）
    diskPatrolTimer = setInterval(diskCheck, 60 * 60 * 1000);
    diskPatrolTimer.unref?.();
    startBackupOperations();
    startBackupSchedule({ runBackup, getConfig });
    log(`OneBot 协议端: ws=${getConfig().protocol?.wsUrl} http=${getConfig().protocol?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  // ── Skill 重扫：UI「刷新」按钮的唯一后端入口 ──────────────────────────
  // 「刷新」只重读内存注册表的话，watcher 丢事件（目录删除重建后 fs.watch 句柄失效、
  // 网络盘、杀毒软件）时点多少次都看不到新插件。这里把"重扫磁盘 + 激活 + 刷工具 +
  // 重建 watcher"做成一个幂等函数，启动流程和手动重扫共用。
  async function reloadSkills({ reason = 'manual', result: preloaded = null } = {}) {
    // ── 批量加载静默期 ───────────────────────────────────────────────────
    // loadSkillRoot 是串行加载（并行 import 时两个 Skill 抢同一 id 顺序不确定），而每个
    // 插件的 setup() 在 import 期间就把工具注册进表。于是 N 个带工具的插件会产生 N 次
    // 工具集增长：35 → 38 → 41 → 44 …，群聊活跃时每一级增长都可能被某个请求看到，
    // 等于一次 17k 全价重算。"新加插件后缓存爆炸"就是这个，不是插件让前缀变大，
    // 是中间态被看见了。
    //
    // 包进 batch 后：中间态一律沿用旧集合，endToolsetBatch() 把所有桶标脏，
    // 下一次请求立即按最终集合重建基线。N 次折叠成 1 次，延迟上限是一次重扫耗时。
    beginToolsetBatch();
    try {
      // watcher 的 runReload 已经 loadPlugins 过一遍（它的 result 通过 onReload 传进来）。
      // 无视入参再扫一遍会让每个插件的 setup() 实跑两遍：日志洪水、插件副作用双跑
      // （计时器/计数/通知）、工具集反复重建导致系统提示重建 → 前缀缓存断裂 ×N。
      // 手动/接口入口没有预载结果，照常全量扫。
      const result = preloaded || await loadPlugins({ log });
      // 内置工具链（自检/修复/锻造台/开发工单）：不走插件目录，由核心直接注册。
      // 放在 loadPlugins 之后、激活循环之前，它同样需要参与 activate 与工具刷新。
      try { registerHarness({ skillManager, log }); } catch (error) { log(`[harness] 注册失败：${error?.message ?? error}`); }
      for (const st of skillManager.list()) {
        if (st.enabled && st.loaded) {
          try { skillManager.activate(st.id); } catch (error) { log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`); }
        }
      }
      try { orchestrator.refreshToolDefs(); } catch { /* 刷新失败不影响主流程 */ }

      // watcher 自愈：fs.watch 监听的目录被删除再重建后收不到任何事件，
      // 这里关掉旧的重新建。热重载关闭时保持关闭（尊重用户配置）。
      const hotReloadOn = process.env.QQ_AGENT_DEV === '1'
        || getConfig().extensions?.hotReload !== false;
      try { pluginWatcher?.close?.(); } catch { /* ignore */ }
      pluginWatcher = null;
      if (hotReloadOn) {
        // 新 watcher 继承一段静默期：重建后 quietUntil=0 的话，重扫自己 import/触碰
        // skill 目录产生的晚到事件会立刻再触发一轮全量重扫。
        pluginWatcher = watchPlugins({ log, quietMs: 2500, onReload: (r) => reloadSkills({ reason: 'watch', result: r }) });
      }

      if (reason !== 'boot') {
        log(`[skill] 重扫完成（${reason}）：${result.loaded.length} 成功，${result.failed.length} 失败`
          + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除的 Skill` : ''));
        emit('status', { configUpdated: true });
      }
      return result;
    } finally {
      // 必须放 finally：加载中途抛异常时也要放开静默期，否则工具集永久冻结
      // （虽然 tool-registry 里还有 30s 超时兜底，但那是最后一道保险）。
      const released = endToolsetBatch();
      // absorbed = 本轮扫描被折叠掉的中间变化次数，每一次原本都是一次全前缀重算
      // （实测 17k tok）。这条日志是"装插件到底省了几次击穿"的凭据。
      if (released && released.absorbed > 0) {
        log(`[tools-batch] 重扫结束：折叠 ${released.absorbed} 次中间工具集变化`
          + `（原本各击穿一次前缀缓存），${released.scopes} 个会话桶待下次请求按最终集合生效`);
      }
    }
  }

  async function stop() {
    stopBackupSchedule();
    await stopBackupOperations();
    // 先停掉热重载 watcher：否则 stop() 之后文件变动仍会触发重载 + 广播
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    // 退订本次 createApp 挂的日志监听器（见上方 onLog 注释）
    try { unsubscribeAppLog?.(); } catch { /* ignore */ }
    unsubscribeAppLog = null;
    await orchestrator.abortAll();
    orchestrator.stopReminderLoop();
    // 主动发言循环也要停：只停 reminderLoop 的话，proactiveTimer 在 stop() 后仍会
    // 继续 tick，headless 下进程不死就一直调度。
    try { orchestrator.stopProactiveLoop(); } catch { /* ignore */ }
    // 回收全部 Skill 实例：插件自己的 setInterval/落盘定时器（health-system 的状态
    // 衰减等）不 dispose 就是句柄泄漏，退出窗口还可能写坏数据文件。
    try { skillManager.disposeAll({ reason: 'shutdown' }); } catch { /* ignore */ }
    if (communitySyncTimer) clearInterval(communitySyncTimer);
    try { cacheWarm?.stop?.(); } catch { /* ignore */ }
    if (obPortPollTimer) clearInterval(obPortPollTimer);
    if (diskPatrolTimer) clearInterval(diskPatrolTimer);
    // 退出前停掉遥测与价格表轮询：headless 模式 stop() 后进程若继续存活，
    // 这两个定时器会照常发起网络请求。
    try { stopTelemetryLoop(); } catch { /* ignore */ }
    try { stopPriceFeed(); } catch { /* ignore */ }
    // 索引缓存立刻落盘：正常运行中靠防抖（5s），退出前必须写一次，
    // 否则最后的会话变动丢失、下次启动要靠后台对账补（慢路径）
    sessions.flushIndexCache();
    // 消息存档的延迟落盘也要立刻兑现：saveChat 按会话节流 300ms，退出前不 flush
    // 就会丢掉"刚看到消息就关程序"那最后几百毫秒的聊天记录。
    try { store.flushPendingSaves(); } catch { /* 退出路径上不再抛 */ }
    // 关闭所有 SSE 长连接，避免 server.close() 一直等它们
    for (const c of [...sseClients]) {
      try { c.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    onebot.close();
    server.close();
    // 便携 QQ：默认保留运行（避免误杀用户登录态），如需清理可在 UI 手动关闭
    // try { await stopPortableQQ(); } catch { /* ignore */ }
    // 释放单实例锁（下次启动才能再抢到）
    releaseInstanceLock();
  }

  return {
    server, onebot, store, memory, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, getRendererAuthToken: () => rendererAuthToken, launchPortableQQ, stopPortableQQ, qqPortableStatus, reloadSkills,
    // 桌宠宿主（electron/desktop-pet.js）要反向调用这三个，必须挂在返回值上：
    // 主进程侧 `core?.xxx?.()` 取不到就是静默失效，表现为桌面上的角色好好的、
    // 控制台永远停在"正在加载"。
    // bindHost 是幂等的，多一条从 reconcileService 来的绑定不会重复。
    getDesktopPetService, getUsageToday, devApi
  };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds，
 * 没有历史汇总文件也能直接扫留档算。
 */

/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  // 前端"全部"按钮：不设起始时间。静默回落"近 7 天"（Number('all')||7）会让用户
  // 以为在看全量历史实际被截断，与"求和一致"的产品口径冲突。
  if (s === 'all') {
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时单次约
// 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。会话文件是"结束写一次、
// 之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原为 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，缓存经常刚好过期，
//      每次都走 200ms 的冷启动（"黑一下"）。用量统计不是实时数据，20 秒够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
//
// 数据量增长后（真实部署 2144 个会话 / 172MB）全量 parse 需要 ~1.9s，TTL 到期后的
// 每次重算都会把主进程 event loop 阻塞近 2 秒，期间 HTTP/SSE/消息处理全部排队，
// 前端表现就是"用量页卡住、整个控制台无响应"。两条治理（同步进 collectUsageRows）：
//   A. 增量解析：目录快照没变时复用上一轮解析结果（sig 相同就复用，只重做时间窗过滤
//      与派生字段），冷启动只在真有新会话落盘时才发生。TTL 仍然保留，兜"内容被改写"。
//   B. 流式分片解析：真要冷启动时，把 172MB 的同步 parse 拆成每 50 个文件一让步
//      （setImmediate）的异步流水线，单次让步前的阻塞 <100ms。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;
// 已解析会话的档案（增量解析的持久层）：sig（目录快照）→ 每会话的展开行/计数。
// 与 usageRowsCache 的区别：后者是"某个时间窗的最终 rows"，前者是"全部会话的原始素材"，
// 换 range 时不必重新读盘。
const usageArchive = { sig: '', at: 0, sessions: null };   // sessions: Map(file -> {rows[], searchCount, toolCounts})
// 让步前最多同步解析的文件数（B 方案的切片粒度）
const USAGE_PARSE_CHUNK = 50;
// 让步前最多同步 stat 的文件数（档案命中时只剩 stat，粒度可以粗一些）
const USAGE_STAT_CHUNK = 400;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs + ':' + files.reduce((a, f) => a + f.length, 0);
  } catch {
    return '';
  }
}

/**
 * 读盘解析单个会话文件 → { rows, searchCount, toolCounts, started }。
 * 纯函数（不含时间窗过滤）：窗口过滤在 collectUsageRows 里做，这样
 * 换 range（今天/7天/全部）时可以完全复用这份解析结果。
 */
function parseUsageSessionFile(dir, f) {
  const out = { rows: [], searchCount: 0, toolCounts: Object.create(null), started: 0, mtime: 0, size: -1 };
  try {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    out.mtime = st.mtimeMs;
    // size 与 mtime 一起当"这个文件没变过"的判据：NTFS 的 mtime 粒度是 100ns，
    // 单独用 mtime 已经够稳；多存一个 size 是白送的保险（同一 mtime 刻度内被改写
    // 且长度恰好相同，概率极低但不是零）。
    out.size = st.size;
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const started = Number(s.startedAt) || 0;
    out.started = started;
    if (!started) return out;
    out.searchCount = Number(s.webSearchCount) || 0;
    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const exactRows = [];
    for (const m of (s.messages || [])) {
      const name = m && m.toolCall && m.toolCall.name;
      if (name) out.toolCounts[String(name)] = (out.toolCounts[String(name)] || 0) + 1;
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      exactRows.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }
    if (exactRows.length) {
      for (const c of exactRows) {
        out.rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (p || c) {
        out.rows.push({
          promptTokens: p,
          completionTokens: c,
          cachedTokens: Number(u.cachedTokens) || 0,
          at: started,
          model: String(s.model || '') || '(未知)',
          chatKey: String(s.chatKey || '(未知)'),
          vendor: String(s.vendor || ''),
          sessionId: s.id,
          exact: false
        });
      }
    }
  } catch { /* 坏文件跳过（与旧行为一致） */ }
  return out;
}

/**
 * （异步）刷新"已解析档案"到当前目录快照。
 * 只重读变化过的文件（新文件 + mtime/size 变了的文件），其余复用，
 * 2144 个文件只有几个新增时，重读量从 172MB 降到几 MB。
 * 解析按 USAGE_PARSE_CHUNK 分片、片间 setImmediate 让步，不长阻塞事件循环。
 *
 * 这里曾经有一行"前置复用条件"：只有目录签名前两段（文件数 : 目录 mtime）完全一致
 * 才肯以旧档案为底，否则 `prev = new Map()`，于是每落一个新会话文件就把已解析的
 * 整份档案全部丢弃、全量重解析。机器人正常运行时新会话每几分钟落一个，等于这个增量
 * 缓存从未生效过（实测：增量解析 5ms，被整体丢弃后 2157ms）。那行条件本来想兜
 * "目录被换掉/清空"，但下面逐文件比对 (mtime, size) 已经覆盖了它：文件被删就不在
 * files 列表里、被改写则 mtime/size 必变。所以现在无条件以现有档案为底。
 */
async function refreshUsageArchive(dir, files, sig) {
  // 这里故意不做 "sig 相同就直接返回" 的短路：sessionsDirSignature 只是
  // 「文件数 : 目录 mtime : 文件名总长」，而会话文件是原地改写的（会话跑完落盘、
  // 运行中节流保存），NTFS 下改写文件内容不会动父目录的 mtime，于是"内容变了但
  // 签名没变"会让档案一直沿用旧的解析结果，而且只要目录没有增删文件，这个错值就永远
  // 不修正。多付的代价只是一次"每文件一次 stat"的扫描（1200 文件 ≈ 5ms）；
  // 真正省钱的判据是下面逐文件的 (mtime, size) 比对，那是零读盘的。
  const prev = usageArchive.sessions || new Map();
  const next = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const old = prev.get(f);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      next.set(f, old);   // 文件没变：复用上次的解析结果（零读盘）
      // 纯 stat 的批次也可能很长（上万文件），同样分片让步
      if ((i + 1) % USAGE_STAT_CHUNK === 0) await new Promise((r) => setImmediate(r));
      continue;
    }
    next.set(f, parseUsageSessionFile(dir, f));
    // 分片让步：单文件最大 ~1MB，50 个一批的同步解析 < 100ms
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  usageArchive.sessions = next;
  usageArchive.sig = sig;
  usageArchive.at = Date.now();
  return next;
}

/**
 * 后台预热用量档案。
 *
 * 用量统计的第一道工序是把全部会话文件 JSON.parse 一遍（实测 1200 文件 /
 * 170MB ≈ 3.1 秒）。不预热的话，每次启动后第一次打开用量页都要等这 3 秒。
 *
 * 由 start() 在启动 8 秒后调用：那时插件加载、价格表、遥测都已就位，档案解析
 * 又是分片让步的，不会长阻塞事件循环。没有任何会话文件（全新安装）直接跳过。
 *
 * @returns {Promise<{files:number, ms:number}|null>}
 */
async function warmUsageArchive() {
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (!files.length) return null;
  const t0 = Date.now();
  const archive = await refreshUsageArchive(dir, files, sessionsDirSignature());
  return { files: archive.size, ms: Date.now() - t0 };
}

/**
 * 历史文件指纹：只统计"已完结"的会话文件（最后写盘时刻早于今天 0 点）。
 *
 * 日快照判据不用目录签名（sessionsDirSignature）：目录签名含目录 mtime，机器人每结束
 * 一个新会话就落一个新文件 → 签名必变，全部历史日快照同时失效 → 每次统计把窗口内
 * 每一天从档案全量重算（每天遍历全部会话行 + 逐行计价，同步无让步），数据量大时
 * 事件循环被阻塞数秒、所有接口排队。
 *
 * 已完结文件（会话写完一次后不再改写）的集合对历史日是稳定的：新增会话只影响"今天"
 * （今天永远实时聚合、不进快照）。指纹不变 → 历史快照持续有效；清理/删除旧会话文件
 * 会改变指纹 → 相关快照正确失效。每天 0 点跨越会让指纹变一次 → 一天仅重算一次。
 *
 * 指纹从已解析档案派生（每文件 mtime 在 refreshUsageArchive 时已 stat），零额外 IO。
 * 格式带 h: 前缀，与旧目录签名天然不同，旧快照首次统计时自动失效重算一遍，
 * 随即迁移成新格式，无需专门迁移代码。
 */
function historySignatureOf(archive, todayStartMs) {
  let count = 0, mtimeSum = 0;
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.mtime || parsed.mtime >= todayStartMs) continue;
    count++;
    mtimeSum += parsed.mtime;
  }
  // h: → h2: 是一次性快照作废：账本补差修好之后（"已知覆盖"不再拿账本总量顶数、
  // 补差改按会话粒度生成），旧快照的口径与新算法不同。改前缀让全部历史日按新算法
  // 重算一遍，随后迁移成新格式；算不出数据的日子会走"保留旧值 + 对齐新签名"的自愈
  // 路径，不会把仅存的快照抹成 0。
  return `h2:${count}:${mtimeSum}`;
}

async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      // 深拷贝：slice() 只是浅拷贝，调用方往行对象上写字段（如 dayKey）会写穿到缓存对象
      rows: usageRowsCache.rows.map((r) => ({ ...r })),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  // ── 数据量治理（见"用量行缓存"注释的 A/B 方案）──
  // 档案层增量解析 + 分片让步；时间窗过滤只对窗口内的素材做。
  const archive = await refreshUsageArchive(dir, files, sig.split('@')[0]);

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 这些是"次数"不是"成本"：搜索通常是资源包或免费的，所以只列数量、不参与成本计算。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    const parsed = archive.get(f);
    if (!parsed || !parsed.started) continue;
    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (parsed.started >= win.start && parsed.started <= win.end) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    // 逐次调用行：窗口内才收进 rows（行自带 at，可精确到调用时刻）
    for (const r of parsed.rows) {
      if (r.at < win.start || r.at > win.end) continue;
      rows.push(r);
    }
  }

  // ── 账本兜底：补回被 keepFiles 裁掉的会话的用量 ──────────────────
  //
  // 会话文件是可裁剪的（config.json 的 store.keepSessionFiles，默认 120），文件一删，
  // 它携带的用量就再也读不到了，统计会被冻结在"最近 N 个会话"上，用户看到的现象是
  // "今日 200 次运行，页面只算 120 次"。
  //
  // 补差分两层，全部以按会话 id 去重为前提：
  //   ① 逐会话补行：账本里"文件已不在"的会话，每条转一行统计行
  //      （带 chatKey/model/vendor/calls，见 ledgerSessionRow），
  //      按会话、按模型、调用次数、成本全部恢复；
  //   ② 按天聚合补差：① 之后与权威真值（账本 / 跨天归档 / usage-today.json
  //      逐字段取最大，见 authoritativeGapForDay）仍有差距的
  //      （账本漏记、账本建立之前的日子），再补一条聚合行。
  {
    const onDiskIds = new Set(files.map((f) => f.replace(/\.json$/, '')));
    const ledgerDayInWin = (dayKey) => {
      const d0 = new Date(`${dayKey}T00:00:00`);
      if (isNaN(d0.getTime())) return false;
      const d1 = new Date(d0.getTime());
      d1.setDate(d1.getDate() + 1);
      return d1.getTime() - 1 >= win.start && d0.getTime() <= win.end;
    };
    // ① 逐会话补行（被裁掉的会话）
    for (const dayKey of listUsageLedgerDays()) {
      if (!ledgerDayInWin(dayKey)) continue;
      for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
        rows.push(ledgerSessionRow(rec));
      }
    }
    // 已进 rows 的覆盖量（按天；runs 按去重后的会话数计，真值侧的 runs 是会话数，
    // 两边必须同口径，否则次数补差永远算不平）
    const coveredByDay = new Map();
    const seenSessions = new Set();
    for (const r of rows) {
      const day = ledgerDayKey(r.at);
      const cur = coveredByDay.get(day) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      cur.promptTokens += Number(r.promptTokens) || 0;
      cur.completionTokens += Number(r.completionTokens) || 0;
      cur.cachedTokens += Number(r.cachedTokens) || 0;
      const sk = `${day}|${String(r.sessionId || '')}`;
      if (r.sessionId && !seenSessions.has(sk)) { seenSessions.add(sk); cur.runs += 1; }
      coveredByDay.set(day, cur);
    }
    // 搜索次数是会话级计数（没有独立时间戳，按会话归属），单独按天记一份
    for (const f of files) {
      const parsed = archive.get(f);
      if (!parsed || !parsed.started) continue;
      if (parsed.started < win.start || parsed.started > win.end) continue;
      const day = ledgerDayKey(parsed.started);
      const cur = coveredByDay.get(day) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      cur.webSearchCount += parsed.searchCount || 0;
      coveredByDay.set(day, cur);
    }
    // ② 按天聚合补差（① 之后仍对不上账的部分）
    const { days: ledgerByDay } = usageLedgerTotals(ledgerDayInWin);
    const doneDays = new Set();
    // 归档日也要进循环：账本是从"启用那一天"起记的，更早的跨天归档只存在于
    // usage-archived-days.json 里，只遍历账本的日就等于永远看不到它们。
    for (const dayKey of new Set([...ledgerByDay.keys(), ...Object.keys(loadArchivedUsageDays())])) {
      if (!ledgerDayInWin(dayKey)) continue;
      const gap = authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey);
      if (!gap) continue;
      rows.push(ledgerGapRow(dayKey, gap));
      searchCount += gap.webSearchCount;
      doneDays.add(dayKey);
    }
    // 账本日里没有今天时（账本刚建立、或跨天后第一段时间），当天权威值仍在
    // usage-today.json 里，单独为它补一次，否则「今日」卡片会一直显示残缺值。
    {
      const todayFile = loadUsageTodayFile();
      if (todayFile && !doneDays.has(todayFile.dayKey) && ledgerDayInWin(todayFile.dayKey)) {
        const gap = authoritativeGapForDay(coveredByDay, new Map(), todayFile.dayKey);
        if (gap) {
          rows.push(ledgerGapRow(todayFile.dayKey, gap));
          searchCount += gap.webSearchCount;
        }
      }
    }
    // ②-b 工具调用计数补回
    //
    // 上面第一圈的 toolCounts 只来自磁盘上还存在的会话文件。keepSessionFiles
    // （默认 120）一裁，调用明细就只剩"最近 120 个会话"， 实测 120 个文件只覆盖
    // 5 小时，弹窗却写"近 7 天共 157 次"，而单日账本里就有上千次调用。
    //
    // 账本记录 toolCounts 后，这里把"文件已不在磁盘上"的会话补回来，与上面 token 的
    // 补差（authoritativeGapForDay）同一口径：文件在的用文件（带逐次明细），
    // 文件不在的用账本（只有计数），两边不重叠。
    {
      const onDiskIds = new Set(files.map((f) => f.replace(/\.json$/, '')));
      for (const [dayKey, dayAgg] of ledgerByDay) {
        if (!ledgerDayInWin(dayKey)) continue;
        // 快路径：该日账本里一条工具计数都没有（全是改造前的老行）→ 直接跳过，
        // 免得为了"补 0 条"去读一遍整天的账本文件。
        if (!dayAgg?.toolCounts || !Object.keys(dayAgg.toolCounts).length) continue;
        for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
          // 以日粒度判断窗口不够精确：同一天里跨窗口边界的会话要按 startedAt 再滤一次
          const st = Number(rec.startedAt) || Number(rec.endedAt) || 0;
          if (st && (st < win.start || st > win.end)) continue;
          const tc = rec.toolCounts;
          if (!tc || typeof tc !== 'object') continue;   // 老账本行没有这个字段
          for (const [name, n] of Object.entries(tc)) {
            const c = Number(n) || 0;
            if (c > 0) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + c;
          }
        }
      }
    }
  }
  // 模型身份 = 渠道 + 模型 id。渠道取会话自己记录的 vendor（创建会话时由当时的配置
  // 派生）。老会话没这个字段就标为「未知渠道」，绝不拿当前配置去倒推历史，
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染。
  // rows 里的对象来自档案层（可能被多个 range 的缓存共享引用），上面 vendor/modelKey
  // 的改写是幂等的，但调用方还会写 dayKey，所以缓存里也存一份浅拷贝行。
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.map((r) => ({ ...r }));
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

// ── 按日快照 ────────────────────────────────────────────────────────
//
// collectUsageRows 即使有档案层缓存，冷启动（2144 文件 / 172MB）仍要全量流式解析；
// "今天之前的每一天"的数据是不可变的（会话结束写一次、之后不改），每次打开用量页
// 都从头统计它们是纯浪费。
//
// 方案：把"已完结自然日"（今天之前）的聚合结果固化到 data/usage-daily.json。
// 读取路径优先快照；只有快照缺失/失效的日才回退到"从档案聚合"。写快照时机：
// 每次统计完顺手补齐（异步、不阻塞响应）。
//
// 有效性判据：每条日快照带生成时的目录快照 sig。sig 没变 → 该日必然没新增会话
// （会话文件不改写），直接用。sig 变了 → 重算该日（分片解析会复用 mtime 相同的
// 旧解析结果，增量代价很小）。"今天"永远不进快照。
//
// 成本口径：快照存 costOfRows 聚合结果。价格表（自定义价/远程价）变化会让历史成本
// 跟着变，快照固定的是"生成当时的计价"。这是刻意取舍：量级收益（秒→毫秒）远大于
// "改价后历史成本不联动"的小误差；想重算任何一天，删掉快照文件对应条目即可。
const USAGE_DAILY_FILE = path.join(DATA_DIR, 'usage-daily.json');
// 跨天归档（sessions.js 的 #archiveDayUsage 写的独立文件）。
// 与 usage-daily.json 是两回事：usage-daily 存"按日聚合快照"，这个存
// usage-today.json 那个单槽文件在跨零点时被顶下来的上一日权威总量。
const USAGE_ARCHIVED_FILE = path.join(DATA_DIR, 'usage-archived-days.json');
const USAGE_DAILY_VERSION = 1;

function loadUsageDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8'));
    if (parsed?.version === USAGE_DAILY_VERSION && parsed.days && typeof parsed.days === 'object') {
      return parsed.days;
    }
  } catch { /* 无文件/坏文件 = 全部重算 */ }
  return {};
}

function saveUsageDaily(days) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_DAILY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: USAGE_DAILY_VERSION, savedAt: Date.now(), days }, null, 1), 'utf8');
    fs.renameSync(tmp, USAGE_DAILY_FILE);
  } catch { /* 快照写失败只是慢一点，绝不能影响统计主流程 */ }
}

/**
 * 已完结自然日列表：从窗口起点（或快照里最早的日）到昨天。
 * 今天永远实时算（数据还在长）。
 */
function completedDayKeys(fromTs) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 昨天的 0 点（今天之前最后一个已完结日）
  d.setDate(d.getDate() - 1);
  const start = new Date(Number(fromTs) || 0);
  start.setHours(0, 0, 0, 0);
  while (d.getTime() >= start.getTime()) {
    out.push(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/**
 * 「数据元年」：最早可能有数据的自然日 0 点。
 *
 * 'all' 范围给 completedDayKeys 传的起点是 0，于是从 1970-01-01 一路枚举到昨天，
 * 实测 20718 个空日。代价有三层：
 *   1. 枚举本身要遍历两万多次（13ms，还算便宜）；
 *   2. 每个空日都会生成一条快照写进 usage-daily.json → 文件被灌到 9.95MB，
 *      而这份文件每次统计都要 JSON.parse 一遍（≈65ms）；
 *   3. days 维度会吐 20718 个数据点，前端折线图直接画两万个点。
 *
 * 取两侧较小值，宁可保守（算早不算晚，绝不把真有数据的日子切掉）：
 *   ① 档案里最早一个会话的开始时刻；
 *   ② 日快照里最早一个"确有数据"（runs 或 token 非零）的日。
 * 两边都拿不到 → 返回 0，等于不做任何下限，安全兜底。
 */
function usageDataFloorMs(archive, snapshotDays) {
  let floorMs = Infinity;
  for (const parsed of archive.values()) {
    const t = Number(parsed?.started) || 0;
    if (t > 0 && t < floorMs) floorMs = t;
  }
  // 账本也要计入数据元年！否则会话文件被裁光后，档案层的最早会话已经是很近的日子，
  // 但账本里还有更早的日子，按档案算出的下限会把那些日子判成"元年之前"并裁掉，
  // 历史数据凭空消失。
  for (const dayKey of listUsageLedgerDays()) {
    const t = new Date(`${dayKey}T00:00:00`).getTime();
    if (Number.isFinite(t) && t < floorMs) floorMs = t;
  }
  // 日键是 YYYY-MM-DD，字典序即时间序，不必逐条 new Date（两万条 Date 解析不便宜）
  let floorKey = '';
  for (const [dayKey, snap] of Object.entries(snapshotDays || {})) {
    const t = snap?.aggregates?.totals;
    if (!t) continue;
    if (!((Number(t.runs) || 0) > 0 || (Number(t.totalTokens) || 0) > 0)) continue;
    if (!floorKey || dayKey < floorKey) floorKey = dayKey;
  }
  if (floorKey) {
    const k = new Date(floorKey + 'T00:00:00').getTime();
    if (!isNaN(k) && k < floorMs) floorMs = k;
  }
  if (!isFinite(floorMs)) return 0;
  const d = new Date(floorMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 裁掉日快照里"数据元年"之前的日（只会是空日）与未来日。
 *
 * 保守三条，确保它永远不会删掉真实数据：
 *   ① 元年拿不到（0 / 非有限数）→ 一条都不裁；
 *   ② 只裁严格早于元年的日，元年当天及以后原样保留；
 *   ③ 只裁字典序比较这一天（不做任何数值猜测）。
 * 被裁掉的日子如果将来真有数据，会作为"快照缺失"被正常重算，不会丢。
 *
 * @returns {number} 实际裁掉的条数（>0 时需要回写快照）
 */
function pruneUsageDaily(snapshotDays, floorMs) {
  if (!floorMs || !isFinite(floorMs)) return 0;
  const floorKey = dayKeyOf(floorMs);
  // 同上：未来日判据用 setDate(+1)，避免夏令时切换日 +24h 落到昨天。
  const tmr = new Date();
  tmr.setDate(tmr.getDate() + 1);
  const tomorrowKey = dayKeyOf(tmr.getTime());
  let removed = 0;
  for (const dayKey of Object.keys(snapshotDays)) {
    if (dayKey < floorKey || dayKey > tomorrowKey) { delete snapshotDays[dayKey]; removed++; }
  }
  return removed;
}

/**
 * 读 data/usage-today.json，当天用量的权威值。
 *
 * 会话文件会被 keepFiles 裁掉、账本只从启用那天起记，所以两者都覆盖不了
 * 「今天早些时候」的历史。而 usage-today.json 是 #bumpTodayUsage 在每次会话结束时
 * 累加写下的当天总量，它永远不被裁剪，是当天唯一完整可信的数。
 *
 * 有了它，即使今天有 85% 的会话文件已被删除，统计也能对齐到真值，
 * 缺的量作为"归档补差"计入，而不是让用户对着一个偏小的数字反复刷新。
 *
 * @returns {null | {dayKey:string, promptTokens:number, completionTokens:number,
 *                   totalTokens:number, cachedTokens:number, runs:number, webSearchCount:number}}
 */
function loadUsageTodayFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
    if (parsed?.dayKey && typeof parsed.dayKey === 'string') {
      return {
        dayKey: parsed.dayKey,
        promptTokens: Number(parsed.promptTokens) || 0,
        completionTokens: Number(parsed.completionTokens) || 0,
        totalTokens: Number(parsed.totalTokens) || 0,
        cachedTokens: Number(parsed.cachedTokens) || 0,
        runs: Number(parsed.runs) || 0,
        webSearchCount: Number(parsed.webSearchCount) || 0,
      };
    }
  } catch { /* 无文件 = 今天还没用量 */ }
  return null;
}

/**
 * 跨天归档的每日权威总量（data/usage-archived-days.json）。
 *
 * 这个文件此前只写不读：sessions.js 的 #archiveDayUsage 把 usage-today.json 被顶下来
 * 的旧槽位按天写进去，而 authoritativeGapForDay 的注释早就把它列为"权威总量来源③"，
 * 代码里却从来没打开过它。这里补上读取：账本没覆盖到的日子，用归档里的权威值补差。
 *
 * 缓存按 (mtimeMs,size) 失效：本函数在补差循环里会被逐日调用，不能每天都读一次盘。
 * 文件不存在是常态（还没发生过跨天归档），不是错误。
 */
let archivedDaysCache = { sig: '', days: {} };

function loadArchivedUsageDays() {
  let sig;
  try {
    const st = fs.statSync(USAGE_ARCHIVED_FILE);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch { return {}; }                       // 没有归档文件 = 没什么可补
  if (archivedDaysCache.sig === sig) return archivedDaysCache.days;
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_ARCHIVED_FILE, 'utf8'));
    const days = parsed?.days && typeof parsed.days === 'object' ? parsed.days : {};
    archivedDaysCache = { sig, days };
    return days;
  } catch { return {}; }                       // 坏文件：当作没有，且不缓存（下次重试）
}

/** 归档里某一天的权威总量；没有该天返回 null。 */
function archivedDayTotals(dayKey) {
  const d = loadArchivedUsageDays()[dayKey];
  if (!d || typeof d !== 'object') return null;
  return {
    promptTokens: Number(d.promptTokens) || 0,
    completionTokens: Number(d.completionTokens) || 0,
    totalTokens: Number(d.totalTokens) || 0,
    cachedTokens: Number(d.cachedTokens) || 0,
    runs: Number(d.runs) || 0,
    webSearchCount: Number(d.webSearchCount) || 0,
  };
}

/**
 * 算出某一天"已经进统计行的量"与权威真值之间还差多少。
 *
 * 三个数据源取逐字段最大值作为真值：
 *   ① 用量账本，按天留档、跨天也准（启用那天起）
 *   ② usage-archived-days.json，跨零点归档的权威总量
 *   ③ usage-today.json，当天总量（仅当天匹配时）
 *
 * "已知覆盖"只认调用方已经放进 rows 的量：coveredByDay 必须已含账本逐会话补行。
 * 曾经的实现把账本当日总量同时当成"已知覆盖"（known = max(文件覆盖, 账本总量)）
 * 和"真值"（truth = 账本总量）→ gap 恒等于 0 → 补差永远不触发。用户报的
 * "今日 200 次运行只算 120 次"就是这么来的。
 *
 * @param {Map<string, object>} coveredByDay 已进 rows 的覆盖量（按天，含 runs=去重会话数）
 * @param {Map<string, object>} ledgerByDay   账本汇总量
 * @param {string} dayKey
 * @returns {{promptTokens:number,completionTokens:number,cachedTokens:number,
 *            webSearchCount:number,runs:number}|null} 无差距返回 null
 */
function authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey) {
  const c = coveredByDay.get(dayKey) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
  const num = (v) => Number(v) || 0;
  const todayFile = loadUsageTodayFile();
  const candidates = [
    ledgerByDay.get(dayKey) || null,
    archivedDayTotals(dayKey),
    (todayFile && todayFile.dayKey === dayKey) ? todayFile : null,
  ].filter(Boolean);
  if (!candidates.length) return null;
  const truth = {
    promptTokens: Math.max(...candidates.map((x) => num(x.promptTokens))),
    completionTokens: Math.max(...candidates.map((x) => num(x.completionTokens))),
    cachedTokens: Math.max(...candidates.map((x) => num(x.cachedTokens))),
    runs: Math.max(...candidates.map((x) => num(x.runs))),
    webSearchCount: Math.max(...candidates.map((x) => num(x.webSearchCount))),
  };
  const gapPrompt = Math.max(0, truth.promptTokens - num(c.promptTokens));
  const gapCompletion = Math.max(0, truth.completionTokens - num(c.completionTokens));
  const gapRuns = Math.max(0, truth.runs - num(c.runs));
  if (!gapPrompt && !gapCompletion && !gapRuns) return null;
  return {
    promptTokens: gapPrompt,
    completionTokens: gapCompletion,
    cachedTokens: Math.max(0, truth.cachedTokens - num(c.cachedTokens)),
    webSearchCount: Math.max(0, truth.webSearchCount - num(c.webSearchCount)),
    runs: gapRuns,
  };
}

/** 构造一条"来自账本/归档"的补差行（at 落在当天末尾，计价按兜底价）。 */
function ledgerGapRow(dayKey, gap) {
  const at = new Date(`${dayKey}T23:59:59`).getTime();
  return {
    promptTokens: gap.promptTokens,
    completionTokens: gap.completionTokens,
    cachedTokens: gap.cachedTokens,
    at: Number.isFinite(at) ? at : Date.now(),
    // 这一行代表的会话数。costOfRows 的 runs 按行的 runs 累加，补差行不带
    // runs 会按 1 计，"调用次数"照样对不上。纯 token 差价的补差行 runs 为 0，
    // 不影响计数。
    runs: Number(gap.runs) || 0,
    model: '(已归档会话)',
    vendor: UNKNOWN_VENDOR,
    chatKey: '(已归档会话)',
    sessionId: '',
    exact: false,
    fromLedger: true,
  };
}

/**
 * 把一条账本记录转成统计行：一个被裁掉的会话 = 一行。
 *
 * 必须逐会话转行而不是按天合成一行：
 *   ① 次数：costOfRows 的 runs 按行累加，按天合成的一行只代表 1 次调用；
 *   ② 归属：chatKey / model / vendor / calls 都在账本记录里，逐会话转行才能让
 *      "按会话 / 按模型"两张表把补回来的量归到真正的群和模型上，而不是全塞进
 *      "(已归档会话) / 未知渠道"这种糊涂账。
 *
 * @param {object} rec 账本记录（usage-ledger.js 的 ledgerRecordOf 产出）
 */
function ledgerSessionRow(rec) {
  return {
    promptTokens: Number(rec?.promptTokens) || 0,
    completionTokens: Number(rec?.completionTokens) || 0,
    cachedTokens: Number(rec?.cachedTokens) || 0,
    at: Number(rec?.endedAt) || Date.now(),
    runs: Number(rec?.calls) || 1,      // 该会话真实的 LLM 调用次数
    model: String(rec?.model || '') || '(未知)',
    vendor: String(rec?.vendor || ''),
    chatKey: String(rec?.chatKey || '(未知)'),
    sessionId: String(rec?.id || ''),
    exact: false,
    fromLedger: true,
  };
}

/**
 * 从档案层聚合出"某一个自然日"的统计（不使用快照，这是重算路径）。
 * 返回与 buildUsageStats 的 days/chats/models 三段同构的聚合体。
 */
function aggregateDayFromArchive(archive, dayKey) {
  const dayStart = new Date(dayKey + 'T00:00:00');
  if (isNaN(dayStart.getTime())) return null;
  // 不能写死 +24h：夏令时切换日会错 1 小时（本地 23h 或 25h 的一天），那一天的尾巴
  // 或开头会被漏掉 / 多算。用 setDate(+1) 让 Date 自己处理日界线。
  const dayEndDate = new Date(dayStart.getTime());
  dayEndDate.setDate(dayEndDate.getDate() + 1);
  const dayEnd = dayEndDate.getTime() - 1;
  if (!isFinite(dayEnd)) return null;
  const rows = [];
  let searchCount = 0;
  const toolCounts = Object.create(null);
  // 会话文件已覆盖的量（按天），供账本补差用
  const coveredByDay = new Map();
  for (const parsed of archive.values()) {
    if (!parsed || !parsed.started) continue;
    if (parsed.started >= dayStart.getTime() && parsed.started <= dayEnd) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts)) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    for (const r of (parsed.rows || [])) {
      if (r.at >= dayStart.getTime() && r.at <= dayEnd) rows.push(r);
    }
  }
  for (const r of rows) {
    const cur = coveredByDay.get(dayKey) || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0 };
    cur.promptTokens += Number(r.promptTokens) || 0;
    cur.completionTokens += Number(r.completionTokens) || 0;
    cur.cachedTokens += Number(r.cachedTokens) || 0;
    coveredByDay.set(dayKey, cur);
  }
  // 搜索次数是会话级计数，上面已经按会话累加过一次，这里按天记一次供补差
  {
    let s = 0;
    for (const parsed of archive.values()) {
      if (parsed?.started >= dayStart.getTime() && parsed.started <= dayEnd) s += parsed.searchCount || 0;
    }
    // 不能直接 coveredByDay.get(dayKey).webSearchCount = s：上面的累加循环只在 rows
    // 非空时才 set(dayKey, …)，所以"这一天没有任何会话记录"（归档为空 / 该日无会话文件）
    // 时 map 里没有这个 key，get() 返回 undefined，赋值直接抛
    // TypeError: Cannot set properties of undefined。而"归档为空"恰恰是会话文件被外部
    // 清空后的常态，于是快照路径每次必抛、被 buildUsageStats 的 catch 回落到实时聚合，
    // 表现为用量页按天只剩今天、下钻 0 行、成本 0。
    const cur = coveredByDay.get(dayKey)
      || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0 };
    cur.webSearchCount = s;
    coveredByDay.set(dayKey, cur);
  }
  // 账本补差：会话文件被 keepFiles 裁掉的会话，其用量在这里补回来。
  // 与 collectUsageRows 同构：先逐会话补行，再按天对账补聚合差。
  {
    // ① 逐会话补行：账本里"文件已不在磁盘"的会话，每条转一行
    const onDiskIds = new Set([...archive.keys()].map((f) => f.replace(/\.json$/, '')));
    const pushed = [];
    for (const rec of usageLedgerPrunedRecords(dayKey, onDiskIds)) {
      const row = ledgerSessionRow(rec);
      rows.push(row);
      pushed.push(row);
    }
    // ② 覆盖量把刚补的行并进去。runs 必须无条件按去重会话数重算（不能只在裁了文件
    //    的日子算）， 真值侧的 runs 是会话数，两边不同口径会让次数补差永远算不平，
    //    没裁文件的日子也会补出幽灵次数。
    {
      const cur = coveredByDay.get(dayKey)
        || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, webSearchCount: 0, runs: 0 };
      // 上面建 coveredByDay 时没有 runs 字段，直接 += 会得到 NaN，
      // 而 num(NaN)=0 → 次数补差把整天的量再补一遍（实测 runs 翻倍）。
      if (!Number.isFinite(Number(cur.runs))) cur.runs = 0;
      const seen = new Set();
      for (const r of rows) {
        if (!r.sessionId || seen.has(r.sessionId)) continue;
        seen.add(r.sessionId);
        cur.runs += 1;
      }
      for (const k of ['promptTokens', 'completionTokens', 'cachedTokens']) {
        cur[k] += pushed.reduce((n, r) => n + (Number(r[k]) || 0), 0);
      }
      coveredByDay.set(dayKey, cur);
    }
    // ③ 与权威真值仍有差距的（账本漏记 / 账本建立之前的日子）再补一条聚合行
    const { days: ledgerByDay } = usageLedgerTotals((d) => d === dayKey);
    const gap = authoritativeGapForDay(coveredByDay, ledgerByDay, dayKey);
    if (gap) {
      rows.push(ledgerGapRow(dayKey, gap));
      searchCount += gap.webSearchCount;
    }
  }
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  const totals = costOfRows(rows);
  const chats = groupBy(rows, 'chatKey', 0);
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return { totals, chats, models, searchCount, toolCounts };
}

/**
 * 把某一天的聚合体摊平成 days 维度的一条记录。
 *
 * 抽成模块级是因为快照路径与回落实时路径都要用，两边的字段约定必须一致。
 *
 * 做两件必须做的事：
 *  ① 重算派生比率 cacheHitRate / peakRatio，它们是「比率」不是「量」，
 *     跨日相加没有意义，聚合时一律先归零再在此处按当天自身重算；
 *  ② 补 key 字段，chats / models 维度都有 key，前端下钻与横向条形图统一按
 *     key 取值；days 只给 day 的话，把 days 接进 usageBars 时 x.key 会是 undefined。
 *
 * @param {string} dayKey  'YYYY-MM-DD'
 * @param {object} aggTotals 该日的聚合体（costOfRows 的返回或 groupBy 的返回）
 */
function withDerived(dayKey, aggTotals) {
  const t = { ...(aggTotals || {}) };
  const prompt = Number(t.promptTokens) || 0;
  const peak = Number(t.peakTokens) || 0;
  const offPeak = Number(t.offPeakTokens) || 0;
  t.cacheHitRate = prompt ? Math.min(1, (Number(t.cachedTokens) || 0) / prompt) : 0;
  t.peakRatio = (peak + offPeak) ? peak / (peak + offPeak) : 0;
  // key 在前：保证不会被 aggTotals 里同名残留字段覆盖
  return { ...t, key: dayKey, day: dayKey };
}

/**
 * 快照加速版统计：days 维度全部走快照 + 今天实时聚合。
 * 其余维度（chats/models/totals）= 各日快照聚合 + 今天实时。
 * 任一需要的日快照缺失/失效 → 重算该日并回写快照。
 *
 * @returns {Promise<{stats: object, usedSnapshotDays: number, recomputedDays: number}>}
 */
async function buildUsageStatsWithSnapshots({ range = '7' } = {}) {
  const win = resolveRange(range);
  const todayKey = dayKeyOf(Date.now());
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const dirSig = sessionsDirSignature();
  const archive = await refreshUsageArchive(dir, files, dirSig);
  // 日快照有效性判据 = 历史文件指纹（不是目录签名，原因见 historySignatureOf 注释）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const historySig = historySignatureOf(archive, todayStart.getTime());

  // 需要的已完结日：窗口起点到昨天；快照里已有的更早日子只在 all 模式需要
  const snapshotDays = loadUsageDaily();
  // 顺序要紧：先读出快照（数据元年的判据之一），再算起点、再枚举日。
  //
  // 起点 = 「窗口起点」与「数据元年」的较晚者。两条同时要满足：
  //   ① 'all' 不能给 0，那会从 1970-01-01 枚举两万多个空日（见元年函数注释）；
  //   ② 元年之前的日子必然是空的，枚举出来只会在快照里写一批空条目、下一次调用
  //      又按"空日裁剪"删掉，一边写一边删，每次统计都重算那几个空日。
  //      枚举与裁剪用同一个下限，"写什么"就等于"留什么"，churn 自然消失。
  // 元年拿不到（= 整份数据里一条会话都没有）：'all' 干脆一天都不枚举，
  // 其他范围退回窗口起点（Math.max(start, 0) 即起点本身）。
  const floorMs = usageDataFloorMs(archive, snapshotDays);
  const fromTs = win.mode === 'all'
    ? (floorMs || Infinity)
    : Math.max(win.start, floorMs);
  const wantedDays = completedDayKeys(fromTs);
  let recomputed = 0;

  // days 维度：每日一条聚合（快照优先，缺失则重算）。
  // 先攒 { dayKey, totals } 原始对，等 totals/withDerived 定义好之后再摊平
  // （摊平时必须重算派生比率、补 key 字段）。
  const byDayRaw = [];
  const needDays = [];
  for (const dayKey of wantedDays) {
    const snap = snapshotDays[dayKey];
    if (snap && snap.sig === historySig && snap.aggregates) {
      byDayRaw.push({ dayKey, totals: snap.aggregates.totals });
    } else {
      needDays.push(dayKey);
    }
  }
  for (const dayKey of needDays) {
    const agg = aggregateDayFromArchive(archive, dayKey);
    // 重算"算不出数据"时不能拿零去覆盖已有快照。触发场景：会话文件被外部清空
    // （用户点了「清空已结束的会话记录」）→ 归档为空 → 所有历史日的 sig 全部失配进
    // needDays → 每个都重算出全零，若照旧写回 snapshotDays 再 saveUsageDaily，
    // 磁盘上那几天的真实聚合值就被永久抹成 0 了。快照本身是这些天唯一的凭据。
    const aggHasData = agg
      && ((Number(agg.totals?.runs) || 0) > 0 || (Number(agg.totals?.totalTokens) || 0) > 0);
    if (!aggHasData) {
      const prev = snapshotDays[dayKey];
      if (prev?.aggregates) {
        byDayRaw.push({ dayKey, totals: prev.aggregates.totals });
        // 把签名一起对齐到当前归档状态，让快照"自愈"。
        //
        // 只保住数据还不够：只要 sig 不更新，这个日子下一轮统计仍会进 needDays、
        // 再算一次、再判定"算不出数据"，陷入每轮都重算的循环，数据是保住了，
        // 但快路径永远回不来。
        //
        // 这样对齐是安全的：
        //   · historySig 是"已完结会话文件的数量: mtime 之和"。归档为空（会话被清空/
        //     删除）时它恒为 `h:0:0`，在归档回到非空前，任何一天都不可能算出数据，
        //     所以"这份快照在当前状态下已是最终值"成立。
        //   · 一旦归档恢复/新增（用户补回文件、或明天又有会话完结），historySig 立刻变
        //     → 快照重新失配 → 正常走重算路径并覆盖。也就是说对齐只推迟重算，不会阻止重算。
        snapshotDays[dayKey] = { sig: historySig, aggregates: prev.aggregates };
      }
      continue;
    }
    byDayRaw.push({ dayKey, totals: agg.totals });
    snapshotDays[dayKey] = { sig: historySig, aggregates: agg };
    recomputed++;
  }

  // 今天（窗口含今天才需要）：实时聚合
  const includesToday = win.end >= new Date(todayKey + 'T00:00:00').getTime();
  let todayAgg = null;
  if (includesToday) {
    todayAgg = aggregateDayFromArchive(archive, todayKey);
  }

  // 把今天补进 days（修复「按天」图表空白）。
  //
  // completedDayKeys() 从昨天 0 点开始往回枚举（见该函数里明写的 `setDate(-1)`），
  // 所以 today 永远不会进 wantedDays，这是设计，今天走实时聚合、不进日快照。
  // 而 days 维度只在 wantedDays 循环里 push，于是今天的数据从来没进过 days 维度。
  //
  // 下面 chats / models / totals 三个维度都合并了 todayAgg，唯独 days 漏了：
  // 顶部卡片（读 totals）数字在动，而「按天」图表（读 days）显示「这段时间没有记录」，
  // 同一份数据两个口径。
  //
  // 曾经这里把展开写在 byDay.sort() 前后两次、且摊平的是聚合体原对象；
  // 现在统一在 withDerived 里做，日期升序也只排一次。
  if (todayAgg) byDayRaw.push({ dayKey: todayKey, totals: todayAgg.totals });

  // 合并各维度：已完结日快照 + 今天实时
  const mergeGroups = (groupsList) => {
    const map = new Map();
    for (const groups of groupsList) {
      for (const g of groups || []) {
        const key = String(g.key ?? '');
        // 建桶时必须把所有被累加的字段归零：旧实现只归零 runs/exactCalls/cost，
        // 而下面累加循环一共加 11 个字段（cost/peakCost/offPeakCost/peakTokens/
        // offPeakTokens/promptTokens/completionTokens/cachedTokens/totalTokens/runs/
        // exactCalls），漏掉的 8 个会随 `{ ...g }` 原样进桶、再被累加循环加第二遍，
        // 导致每个键"首次出现"的日贡献翻倍（实测 7 日模型表虚高 35%、会话表虚高 75%、
        // 单日范围整表翻倍）。总量与"按天"表不走这里，不受影响。
        if (!map.has(key)) map.set(key, {
          key, ...g,
          cost: 0, peakCost: 0, offPeakCost: 0,
          peakTokens: 0, offPeakTokens: 0,
          promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
          runs: 0, exactCalls: 0,
        });
        const t = map.get(key);
        t.cost += Number(g.cost) || 0;
        t.peakCost += Number(g.peakCost) || 0;
        t.offPeakCost += Number(g.offPeakCost) || 0;
        t.peakTokens += Number(g.peakTokens) || 0;
        t.offPeakTokens += Number(g.offPeakTokens) || 0;
        t.promptTokens += Number(g.promptTokens) || 0;
        t.completionTokens += Number(g.completionTokens) || 0;
        t.cachedTokens += Number(g.cachedTokens) || 0;
        t.totalTokens += Number(g.totalTokens) || 0;
        t.runs += Number(g.runs) || 0;
        t.exactCalls += Number(g.exactCalls) || 0;
      }
    }
    let out = [...map.values()];
    out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    return out;
  };

  const snapAggs = [...wantedDays].map((k) => snapshotDays[k]?.aggregates).filter(Boolean);
  const totalsAggs = snapAggs.map((a) => a.totals);
  if (todayAgg) totalsAggs.push(todayAgg.totals);
  // 曾经首元素走 `{ ...t }` 分支（把聚合体的全部字段原样带进来），后续元素才走固定
  // 字段累加。后果：单日范围的 totals 字段集与多日不同（多出来的 cacheHitRate/peakRatio/
  // hasPeakModel 在单日时是原值、多日时被丢弃后重算），前端拿到两种形状的对象。
  // 现在统一形状：先铺一份全零骨架，再逐日累加固定的可加字段。
  const TOTAL_ZERO = {
    cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
    runs: 0, exactCalls: 0, hasPeakModel: false,
    cacheHitRate: 0, peakRatio: 0,
  };
  const totals = totalsAggs.reduce((acc, t) => ({
    cost: acc.cost + (Number(t?.cost) || 0),
    peakCost: acc.peakCost + (Number(t?.peakCost) || 0),
    offPeakCost: acc.offPeakCost + (Number(t?.offPeakCost) || 0),
    peakTokens: acc.peakTokens + (Number(t?.peakTokens) || 0),
    offPeakTokens: acc.offPeakTokens + (Number(t?.offPeakTokens) || 0),
    promptTokens: acc.promptTokens + (Number(t?.promptTokens) || 0),
    completionTokens: acc.completionTokens + (Number(t?.completionTokens) || 0),
    cachedTokens: acc.cachedTokens + (Number(t?.cachedTokens) || 0),
    totalTokens: acc.totalTokens + (Number(t?.totalTokens) || 0),
    runs: acc.runs + (Number(t?.runs) || 0),
    exactCalls: acc.exactCalls + (Number(t?.exactCalls) || 0),
    hasPeakModel: acc.hasPeakModel || Boolean(t?.hasPeakModel),
    cacheHitRate: 0,   // 派生比率，循环后重算
    peakRatio: 0,
  }), { ...TOTAL_ZERO });
  // 派生比率不能相加，重算
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, totals.cachedTokens / totals.promptTokens) : 0;
  totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;

  // byDay 的每一条也是从聚合体摊平的，聚合体里的 cacheHitRate/peakRatio 是
  // 上面那张全零骨架带来的 0，必须在入表前按该日自身的 token 重算，
  // 否则「按天」表的命中率列会整列显示 0%。
  const byDay = byDayRaw
    .map((x) => withDerived(x.dayKey, x.totals))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const chats = mergeGroups([...snapAggs.map((a) => a.chats), ...(todayAgg ? [todayAgg.chats] : [])]);
  const models = mergeGroups([...snapAggs.map((a) => a.models), ...(todayAgg ? [todayAgg.models] : [])])
    .map((m) => {
      const { vendor, model } = splitModelLabel(m.key);
      return { ...m, vendor, model };
    });
  let searchCount = snapAggs.reduce((a, x) => a + (x.searchCount || 0), 0) + (todayAgg?.searchCount || 0);
  const toolCounts = {};
  for (const a of snapAggs) {
    for (const [k, v] of Object.entries(a.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(todayAgg?.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;

  // 快照回写（有新增/失效重算的日子才写）。
  // 顺带裁掉数据元年之前的空日：老版本被 'all' 范围灌进来的两万条空日就靠这一句
  // 自愈（正常运行时每次统计都过一遍，裁剪本身是字符串比较，可忽略）。
  const prunedDays = pruneUsageDaily(snapshotDays, floorMs);
  if (recomputed > 0 || needDays.length > 0 || prunedDays > 0) {
    // 只保留窗口需要的 + 已有的（不清老数据，删掉将来还得重算）
    saveUsageDaily(snapshotDays);
  }

  return {
    stats: {
      range: String(range),
      rangeLabel: win.label,
      mode: win.mode,
      totals,
      searchCount: searchCount || 0,
      toolCounts: toolCounts || {},
      days: byDay,
      chats,
      models
    },
    recomputedDays: recomputed,
    prunedDays,
    usedSnapshotDays: wantedDays.length - recomputed
  };
}

/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查，用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel,
    // runs = 这些行代表的 LLM 调用总数。会话文件行每次调用一行（runs 缺省 1）；
    // 账本补行带真实 calls（见 ledgerSessionRow），不累加它，被裁掉的会话在
    // "模型调用次数"里永远少算。
    runs: rows.reduce((n, r) => n + (Number(r?.runs) || 1), 0)
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。
 * 优先走"按日快照"路径（历史日聚合固化在 data/usage-daily.json，只实时算今天），
 * 快照层出错时自动回落到实时聚合，用量页绝不能白屏。
 *
 * 三道闸（治理"用量页卡死在加载"）：
 *   1. 结果缓存 3 小时（用户要求）：见下方 USAGE_STATS_CACHE_TTL_MS 注释。
 *   2. 微缓存 5 秒：前端轮询 + SSE 事件都会打到这里，5 秒内的重复请求直接复用。
 *      （已被第 1 条覆盖，保留是因为它先于结果缓存判定、命中更快，也兜住
 *        "force 重算后立刻又被轮询打一次"的情况。）
 *   3. 防重入：同一 range 的统计在跑时，后续请求搭同一趟车（共享同一 Promise），
 *      避免多个统计叠加着阻塞事件循环。 */
const USAGE_STATS_MICRO_TTL_MS = 5000;

/**
 * 结果缓存 TTL（用户要求）。
 *
 * 用户原话："用量界面点今日的时候会加载非常久 …… 我认为可以改成 3 小时自动
 * 统计一次，外加用户手动刷新的时候统计。"
 *
 * 为什么值得缓存整个结果：统计本身不贵了（档案增量解析 + 快照），但入口太多，
 * 15 秒轮询、SSE 事件、切页签、来回点时间范围按钮，每个入口都会把
 * 「读目录 → 增量解析 → 逐日聚合 → 逐行计价 → 读 10MB 快照」重走一遍。
 * 缓存整个结果，这些入口全部退化成一次 Map.get。
 *
 * 语义要点：
 *   - 命中时 `computedAt` 保持真正算出来的时刻，前端据此显示"数据更新于 HH:MM"，
 *     新鲜度是可见的，不会假装数字是刚算的。
 *   - force=true（用户点了「刷新」）跳过缓存重新统计并覆盖缓存。
 *   - 想调新鲜度：改这一个常量即可（单位毫秒）。
 */
const USAGE_STATS_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const usageStatsCache = new Map();   // `${range}#${价格指纹}` -> { at, stats }
const usageStatsInflight = new Map(); // 同上 key -> Promise（每个 key 各有各的在途统计）
let usageStatsMicro = { key: '', at: 0, stats: null };

/** 清空统计结果缓存（测试用；也留给将来"重置用量统计"这类操作）。 */
function resetUsageStatsCache() {
  usageStatsCache.clear();
  usageStatsInflight.clear();
  usageStatsMicro = { key: '', at: 0, stats: null };
}

/**
 * 计价输入的价格指纹。
 *
 * 为什么缓存 key 必须带它：3 小时结果缓存的 key 原本只有 range，用户在设置里改了
 * 自定义单价之后，用量页的成本数字 3 小时内纹丝不动，而这恰恰是最需要立刻生效的
 * 场景（用户改价就是想看新口径）。价格指纹一变，缓存 key 就变，缓存自动失效。
 *
 * 取的是真正影响计价的两处：
 *   ① data/config.json 里的自定义价（mtime + 字节长度，够用且便宜）
 *   ② 远程价表 setRemotePrices 的条目数（远程价刷新会改变条目数）
 * 不做深度哈希：config.json 很小，而计价本身只在重算时发生。
 */
function priceSignature() {
  let cfgSig = '';
  try {
    const st = fs.statSync(path.join(DATA_DIR, 'config.json'));
    cfgSig = `${st.mtimeMs}:${st.size}`;
  } catch { cfgSig = 'nocfg'; }
  return `${cfgSig}|${remoteOverrideCount()}`;
}

async function buildUsageStats({ range = '7', force = false } = {}) {
  const rangeKey = String(range);
  // 缓存键带上价格指纹：改单价后旧缓存自动作废（见 priceSignature 注释）
  const key = `${rangeKey}#${priceSignature()}`;
  // force 必须同时绕过两层缓存：微缓存判定写在前面却没看 force 时，"点刷新"在两次
  // 请求间隔 <5 秒时直接吃微缓存，刷新按钮按下去数字纹丝不动，比慢更让人困惑。
  if (!force) {
    // ① 5 秒微缓存（先判，命中最快：轮询 + SSE 事件风暴不再叠加统计）
    if (usageStatsMicro.stats && usageStatsMicro.key === key
        && Date.now() - usageStatsMicro.at < USAGE_STATS_MICRO_TTL_MS) {
      return usageStatsMicro.stats;
    }
    // ② 3 小时结果缓存
    const cached = usageStatsCache.get(key);
    if (cached && Date.now() - cached.at < USAGE_STATS_CACHE_TTL_MS) {
      usageStatsMicro = { key, at: Date.now(), stats: cached.stats };
      return cached.stats;
    }
  }
  // ③ 防重入：同 key 正在算就搭同一趟车。
  // 曾经这里是单个全局槽（let usageStatsInflight），key 不同就直接新开一个 Promise
  // 覆盖掉前一个，于是切 range 时前后两个 range 会同时全量重算，把刚做的缓存优化
  // 全还回去。改成 Map：每个 key 各有各的在途 Promise，互不覆盖。
  const inflight = usageStatsInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    let stats = null;
    try {
      const r = await buildUsageStatsWithSnapshots({ range });
      if (r.stats && r.stats.totals) stats = r.stats;
    } catch (error) {
      console.warn('[usage] 快照统计路径失败，回落实时聚合：', error?.message ?? error);
    }
    if (!stats) {
      const { rows, win, searchCount, toolCounts } = await collectUsageRows({ range });
      const totals = costOfRows(rows);
      // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
      // 按天分桶需要 dayKey 字段
      for (const r of rows) r.dayKey = dayKeyOf(r.at);
      const byDay = win.mode === 'days'
        ? groupBy(rows, 'dayKey')
            // 与快照路径同构：补 key 字段 + 重算派生比率（groupBy 不带 cacheHitRate）
            .map((x) => withDerived(x.key, x))
            .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        : [];
      const chats = groupBy(rows, 'chatKey', 0);
      // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
      // 行数多时由前端滚动容器处理。
      const models = groupBy(rows, 'modelKey', 0).map((m) => {
        const { vendor, model } = splitModelLabel(m.key);
        return { ...m, vendor, model };
      });
      stats = {
        range: String(range),
        rangeLabel: win.label,
        mode: win.mode,
        totals,
        // 次数类统计：只看数量，不参与成本计算
        searchCount: searchCount || 0,
        toolCounts: toolCounts || {},
        days: byDay,
        chats,
        models
      };
    }
    // 真正算出来的时刻：前端靠它显示"数据更新于 HH:MM"。缓存复用时不会被改写。
    stats.computedAt = Date.now();
    return stats;
  })();
  usageStatsInflight.set(key, promise);
  try {
    const stats = await promise;
    usageStatsCache.set(key, { at: Date.now(), stats });
    usageStatsMicro = { key, at: Date.now(), stats };
    // key 里带了价格指纹，用户每改一次价就多一组条目。这里顺手裁掉已过期的，
    // 只保留 range 数量级的条目。
    if (usageStatsCache.size > 32) {
      const now = Date.now();
      for (const [k, v] of usageStatsCache) {
        if (now - v.at >= USAGE_STATS_CACHE_TTL_MS) usageStatsCache.delete(k);
      }
    }
    return stats;
  } finally {
    // 只清自己这一条，别把别的 range 的在途统计误清掉
    if (usageStatsInflight.get(key) === promise) usageStatsInflight.delete(key);
  }
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}

// ── 测试钩子（仅测试 import；生产代码不得依赖）──────────────────────

export function __testUsageDaily() {
  return {
    buildUsageStatsWithSnapshots,
    buildUsageStats,
    buildUsageBreakdown,
    collectUsageRows,
    loadUsageDaily,
    saveUsageDaily,
    completedDayKeys,
    aggregateDayFromArchive,
    // 数据元年下限 / 快照裁剪 / 结果缓存 / 后台预热
    usageDataFloorMs,
    pruneUsageDaily,
    resetUsageStatsCache,
    warmUsageArchive,
    sessionsDirSignature,
    USAGE_STATS_CACHE_TTL_MS,
    USAGE_DAILY_FILE
  };
}
