// ffmpeg 按需下载安装：下载 → 校验 → 解压 → 验证 → 原子安装。
//
// ── 为什么不再随包分发 ────────────────────────────────────────────────
// 旧方案把 79MB 的 runtime/ffmpeg.exe 打进安装包，安装包因此从 166.8MB 涨到
// 186.3MB —— 而 ffmpeg 只有「大图压缩 / GIF 转视频 / 视频抽帧 / 动态壁纸」
// 四项用得上，纯文字聊天的用户白付这份体积。现在改为设置页「媒体工具」按需
// 下载到 data/runtime/ffmpeg/bin/，不下载也不影响启动与其它功能（各处都降级）。
//
// ── 为什么 7z 优先、zip 兜底 ──────────────────────────────────────────
// 同一个 9.0.2 版本：7z 33.8MB，zip 109.5MB，差 3.2 倍。两者都用 Windows
// 自带的 System32\tar.exe（bsdtar / libarchive）解压 —— Node 标准库解不了 7z。
// 极老系统上 bsdtar 可能没有 lzma 支持，所以解压失败时自动改下 zip 重试一次；
// zip 走 store/deflate，bsdtar 的支持面最广。
//
// ⚠️ 必须写死 System32\tar.exe，不能用裸名 `tar`：装了 Git for Windows 的机器
//    上 `where tar` 先命中 Git 的 **GNU tar**，它读不了 7z/zip（实测报
//    "This does not look like a tar archive"）。这条坑很容易在测试机上踩到，
//    因为开发机往往正好装了 Git。
//
// ── 安全 ──────────────────────────────────────────────────────────────
//   · 下载走 safe-fetch（DNS 校验 / IP 固定 / 逐跳重定向校验），不裸 fetch
//   · 校验值写死在 ffmpeg-resolve.js，不依赖 GitHub API（API 限流、挂掉、
//     镜像站被投毒都改不了这里的一个字节）
//   · 只解压 */bin/ffmpeg.exe 与 */bin/ffprobe.exe 两个条目，其余不落地
//   · 装完必须真跑 -version 通过才算成功；失败回滚，不留半套
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import {
  FFMPEG_VERSION, FFMPEG_ASSETS, managedBinDir, exeName,
  resolveFfmpeg, invalidateFfmpegCache, probeFfmpeg
} from './ffmpeg-resolve.js';

// ── 代理 ──────────────────────────────────────────────────────────────
// 34MB 的包走 GitHub Release，在没有代理的网络里往往很慢甚至超时；有代理时
// 能快一个数量级。复用用户在「连接模型」里配的 api.proxy，不另开一个代理
// 设置项 —— 否则用户得在两处各填一遍，且容易只配了一处。
//
// 没配 api.proxy 时**读 Windows 的系统代理设置**（Internet Settings 的
// ProxyEnable / ProxyServer）：Clash / Mihomo 这类工具默认只开系统代理，
// 用户不会想到还要来本应用再填一次。
//
// ⚠️ 刻意不去猜「127.0.0.1:7897 之类常见端口」：端口能连上不代表那是 HTTP
//    代理（可能是任意本地服务），把下载流量往那儿导既不可靠也不安全。
//    系统代理设置是操作系统层面的明确声明，只有它才算数。
const LOCAL_PROXY_PORTS = [];

function configuredProxy() {
  try { return String(getConfig()?.api?.proxy || '').trim(); } catch { return ''; }
}

/** 读 Windows 系统代理（HKCU Internet Settings）。非 Windows / 未开启返回 ''。 */
function systemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enabled = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { timeout: 3000, encoding: 'utf8' });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enabled)) return '';
    const server = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { timeout: 3000, encoding: 'utf8' });
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server);
    if (!m) return '';
    const raw = m[1].trim();
    // ProxyServer 有两种形态：'host:port' 或按协议分列的 'http=h:p;https=h:p'
    let hostPort = raw;
    if (raw.includes('=')) {
      const parts = Object.fromEntries(raw.split(';').filter(Boolean).map((s) => s.split('=')));
      hostPort = parts.https || parts.http || '';
    }
    if (!hostPort) return '';
    if (!/^[a-z]+:\/\//i.test(hostPort)) hostPort = `http://${hostPort}`;
    return /^https?:\/\//i.test(hostPort) ? hostPort : '';
  } catch {
    return '';   // 注册表键不存在 / 没有 reg 命令：当没有系统代理
  }
}

/**
 * 本次下载该走哪个代理。返回 '' = 直连。
 * 顺序：api.proxy（用户显式配置）> Windows 系统代理 > 直连。
 */
export async function resolveDownloadProxy() {
  return _proxyProbe();
}

// 测试注入点：代理探测依赖本机环境（注册表 / 配置），单测里换掉它。
// ESM 导出的绑定不可重定义，所以走这一层间接，而不是在测试里改导出属性。
let _proxyProbe = async () => {
  const cfgProxy = configuredProxy();
  if (cfgProxy) return cfgProxy;
  return systemProxy();
};

/** 测试用：替换代理探测实现。 */
export function __setProxyProbeForTest(fn) {
  _proxyProbe = typeof fn === 'function' ? fn : _proxyProbe;
}

/** 测试用：取当前探测实现（用于保存与恢复）。 */
export function __getProxyProbeForTest() {
  return _proxyProbe;
}
/**
 * 镜像前缀表。都采用 gh-proxy 类站点的通用形态：`前缀 + 完整 GitHub 地址`。
 * 多个镜像并存是有意的 —— 某个站挂掉或限速时，用户换个源就能继续，
 * 不用等发版。下载内容一律过 SHA-256，换源不影响安全性。
 */
export const MIRRORS = {
  yylx: 'https://git.yylx.win/',
  'gh-proxy': 'https://gh-proxy.org/',
  direct: ''      // 直连：前缀为空
};

/**
 * 默认下载源。所有「没传 mirror / 配置里没有这个字段 / 值认不出来」的地方
 * 都落到这里，保证只有一处需要改。
 *
 * 选 yylx 而不是 gh-proxy：它按「前缀 + 完整地址」原样转发，实测不限速也不
 * 跳转到二级域名；gh-proxy 会 302 到 cdn.gh-proxy.org，实测只有几百 KB/s。
 */
export const DEFAULT_MIRROR = 'yylx';

/**
 * 选出这次下载的**实际通道**：URL 前缀 + 走不走代理。
 *
 * ── 为什么要把这两件事合在一起决策 ──────────────────────────────────
 * 「镜像」和「代理」是两个正交开关，但组合错了会互相拖后腿：
 *
 *   代理 + 镜像站  = 代理 → 国内镜像站 → GitHub。多绕一跳，通常比单用更慢；
 *   代理 + 官方直连 = 代理 → GitHub，实测 5.5MB/s（最优）；
 *   无代理 + 镜像站 = 镜像站 → GitHub，实测约 700KB/s（次优）；
 *   无代理 + 直连   = 官方，国内经常几十 KB/s 甚至超时（最差）。
 *
 * 所以规则是：**有可用代理就走官方直连、不用镜像**（镜像的意义就是替代代理）；
 * 没有代理才用镜像加速。用户显式选了「自定义前缀」时尊重他的选择，但同样
 * 在检测到代理时提示 —— 自定义源可能是内网镜像，未必该绕过代理。
 *
 * @returns {{ url: string, proxy: string, reason: string }}
 */
export async function resolveDownloadRoute(assetName, { mirror = DEFAULT_MIRROR, customMirror = '' } = {}) {
  const proxy = await resolveDownloadProxy();
  // 自定义源：用户明确指定，按原样拼；代理照旧用（可能是内网镜像 + 公司代理）
  if (mirror === 'custom') {
    return {
      url: assetUrl(assetName, { mirror, customMirror }),
      proxy,
      reason: proxy ? '自定义源（经代理）' : '自定义源'
    };
  }
  if (proxy) {
    // 有代理：官方直连最快。镜像此时是多余的一跳。
    return {
      url: assetUrl(assetName, { mirror: 'direct' }),
      proxy,
      reason: `经代理 ${proxy} 直连 GitHub`
    };
  }
  if (mirror === 'direct') {
    return {
      url: assetUrl(assetName, { mirror: 'direct' }),
      proxy: '',
      reason: '直连 GitHub（未检测到代理，可能较慢）'
    };
  }
  return {
    url: assetUrl(assetName, { mirror }),
    proxy: '',
    reason: `经镜像 ${mirror}（未检测到代理）`
  };
}

/** 官方资源地址（前缀由用户选的镜像拼在前面）。 */
export function assetUrl(assetName, { mirror = DEFAULT_MIRROR, customMirror = '' } = {}) {
  const official = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${assetName}`;
  const prefix = mirror === 'custom' ? String(customMirror || '').trim() : (MIRRORS[mirror] ?? MIRRORS[DEFAULT_MIRROR]);
  if (!prefix) return official;
  // 前缀统一成「以 / 结尾」，用户填不填尾斜杠都能拼对
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${base}${official}`;
}

/**
 * GitHub 认证只允许发给这些主机。
 *
 * 为什么要按主机收紧，而不是「github.com 系的域都带上」：代理节点是共享出口 IP
 * 时，匿名请求按 IP 限流（60 次/小时），带 Token 后按 Token 计额度（5000 次/小时）
 * —— 这正是这个设置项存在的理由。但 Token 是用户凭据，只能交给 GitHub 自己。
 *
 * ⚠️ 不能靠「URL 里含 github.com」判断：镜像站的前缀形态恰好是
 *    `https://镜像站/https://github.com/...`，按字符串匹配会把 Token 发给镜像站。
 *    必须按 URL 的 hostname 精确匹配。
 */
export const GITHUB_AUTH_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);

/** 用户填的 GitHub Token（未填返回 ''）。 */
export function githubToken() {
  try { return String(getConfig()?.media?.githubAccessToken || '').trim(); } catch { return ''; }
}

/**
 * 本跳该带的额外请求头：仅在目标主机属于 GitHub 自己时给 Token。
 *
 * 下载会被 302 到 `objects.githubusercontent.com` / `release-assets.githubusercontent.com`
 * 这些资产域（仍是 GitHub 的），所以它们也在白名单里；镜像站与自定义前缀
 * 一律返回 null —— 一个字节的凭据都不外发。
 *
 * @param {URL|string} target
 * @param {string} token
 * @returns {{ authorization: string } | null}
 */
export function githubAuthHeaders(target, token) {
  const t = String(token || '').trim();
  if (!t) return null;
  let hostname = '';
  try { hostname = new URL(String(target)).hostname.toLowerCase(); } catch { return null; }
  return GITHUB_AUTH_HOSTS.has(hostname) ? { authorization: `Bearer ${t}` } : null;
}

/** 自定义前缀的合法性（只接受 http(s)://host[:port]/path 形式）。 */
export function isValidMirrorPrefix(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

/** 校验下载文件的 SHA-256。 */
export function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 找解压用的 tar。
 *
 * 只认系统自带的 bsdtar（libarchive）。GNU tar 读不了 7z/zip，而 Git for
 * Windows 会把自己的 GNU tar 放进 PATH —— 所以不能用裸名，必须写死 System32。
 * 非 Windows 平台退回裸名（Linux/macOS 的 bsdtar 通常就在 PATH 里）。
 */
export function tarPath() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.statSync(sys).isFile()) return sys; } catch { /* 落到裸名 */ }
    return 'tar.exe';
  }
  return 'tar';
}

function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 解压出 ffmpeg.exe / ffprobe.exe。
 *
 * 用 --include 做选择性解压：包里还有 doc/、presets/、ffplay.exe 等，
 * 全解出来既慢又多写盘。bsdtar 的 --include 是 glob 匹配完整条目名，
 * 包内路径固定形如 `ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe`。
 */
async function extractBinaries(pkgFile, destDir) {
  const tar = tarPath();
  const args = [
    '-xf', pkgFile, '-C', destDir,
    '--include', `*/bin/${exeName('ffmpeg')}`,
    '--include', `*/bin/${exeName('ffprobe')}`
  ];
  await run(tar, args);
  // bsdtar 把包内目录结构原样铺开，产物在 <destDir>/<包名>/bin/ 下
  const found = { ffmpeg: null, ffprobe: null };
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (e.name === exeName('ffmpeg')) found.ffmpeg = found.ffmpeg || p;
      if (e.name === exeName('ffprobe')) found.ffprobe = found.ffprobe || p;
    }
  };
  walk(destDir);
  return found;
}

// ── 任务状态（内存态，UI 每秒轮询）──────────────────────────────────────
// 形态与 app.js 的 qqSetupState 对齐：{ running, done, total, step, error, ok }。
// 只保留最近一次任务；同一时刻只允许一个下载在跑（否则两个任务会抢同一个
// 临时目录与同一个安装目标）。
const state = {
  running: false,
  step: '',
  channel: '',      // 本次实际用的通道（镜像 / 代理直连），给 UI 与排障看
  received: 0,
  total: 0,
  error: '',
  ok: false,
  finishedAt: 0
};

/** 供路由读取的任务快照。 */
export function setupStatus() {
  return { ...state };
}

function reset(step) {
  state.running = true;
  state.step = step;
  state.channel = '';
  state.received = 0;
  state.total = 0;
  state.error = '';
  state.ok = false;
  state.finishedAt = 0;
}

function fail(message) {
  state.running = false;
  state.error = String(message || '未知错误');
  state.finishedAt = Date.now();
}

function succeed() {
  state.running = false;
  state.error = '';
  state.ok = true;
  state.finishedAt = Date.now();
}

/**
 * 下载并安装 ffmpeg。
 *
 * 返回 { ok, error?, path?, version?, source? }。失败不会抛 —— 调用方是
 * HTTP 路由，抛错会变成 500 且 UI 拿不到分步原因。
 *
 * @param {{ mirror?: string, customMirror?: string }} [opts]
 */
export async function downloadAndInstallFfmpeg(opts = {}) {
  if (state.running) return { ok: false, error: '已经有一个下载任务在跑，等它结束再试' };

  const cfg = getConfig();
  const mirror = String(opts.mirror || cfg?.media?.downloadMirror || DEFAULT_MIRROR);
  const customMirror = String(opts.customMirror ?? cfg?.media?.customMirror ?? '');
  if (mirror === 'custom' && !isValidMirrorPrefix(customMirror)) {
    return { ok: false, error: '自定义下载源格式不对，应形如 https://git.yylx.win/' };
  }

  // 临时工作目录：与安装目标分开，避免解压到一半被当成已安装
  const work = path.join(os.tmpdir(), `qqa_ffmpeg_${process.pid}_${Date.now().toString(36)}`);
  fs.mkdirSync(work, { recursive: true });

  reset('准备下载');
  // 异步跑，路由立即返回 job；UI 轮询 setupStatus()
  runInstall({ work, mirror, customMirror }).catch((e) => fail(e?.message ?? e));

  return { ok: true, started: true };
}

/** 真正的安装流程（与 downloadAndInstallFfmpeg 分开，便于 await 版测试）。 */
async function runInstall({ work, mirror, customMirror }) {
  const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } };
  try {
    // ① 先试 7z（体积只有 zip 的三分之一）
    let installed = await tryInstallFormat('7z', { work, mirror, customMirror });
    // ② 7z 失败 → 换 zip 再来一次（老版本 bsdtar 可能没有 lzma）
    if (!installed.ok) {
      state.step = '7z 解压失败，改用 zip 重试';
      state.received = 0;
      state.total = 0;
      installed = await tryInstallFormat('zip', { work, mirror, customMirror });
    }
    if (!installed.ok) return fail(installed.error || '安装失败');

    // ③ 装完重新解析一次，确认新装的这份真的能被用上
    invalidateFfmpegCache();
    const resolved = await resolveFfmpeg({ force: true });
    if (!resolved.ok) return fail('安装完成但无法运行，请手动指定 ffmpeg 路径');
    succeed();
    state.step = `已安装 ffmpeg ${resolved.version}`;
  } catch (e) {
    fail(e?.message ?? e);
  } finally {
    cleanup();
  }
}

/** 下载 + 校验 + 解压 + 落盘某一个格式。失败返回 { ok:false, error }，不抛。 */
async function tryInstallFormat(fmt, { work, mirror, customMirror }) {
  const asset = FFMPEG_ASSETS[fmt];
  if (!asset) return { ok: false, error: `未知格式 ${fmt}` };
  const pkg = path.join(work, asset.name);

  try {
    // ── 下载 ──
    state.step = `下载 ffmpeg ${FFMPEG_VERSION}（${fmt}，约 ${Math.round(asset.bytes / 1048576)}MB）`;
    state.received = 0;
    state.total = asset.bytes;
    const route = await resolveDownloadRoute(asset.name, { mirror, customMirror });
    state.step = `下载 ffmpeg ${FFMPEG_VERSION}（${fmt}，约 ${Math.round(asset.bytes / 1048576)}MB）· ${route.reason}`;
    state.channel = route.reason;
    // GitHub Token 只发给 GitHub 自己的主机，逐跳判断（见 githubAuthHeaders）。
    // 镜像站是第三方，把 Token 递过去等于把凭据交给它 —— 这也是为什么不能
    // 统一传 headers：safeFetchBinaryToFile 每一跳都会复用同一份请求头。
    const ghToken = githubToken();
    const headersForHost = ghToken ? (u) => githubAuthHeaders(u, ghToken) : null;
    // 上限给 200MB：safeFetchBinaryToFile 在 bytes >= limit 时抛错，
    // 传恰好等于文件大小会误杀「正好下完」的正常情况。
    await safeFetchBinaryToFile(route.url, pkg, 200 * 1024 * 1024, {
      timeoutMs: 60000,
      proxy: route.proxy,
      headersForHost,
      onProgress: (received, declared) => {
        state.received = received;
        // content-length 来自镜像站，可能缺失；缺失时用我们已知的官方大小
        if (declared > 0) state.total = declared;
      }
    });

    // ── 校验 ──
    state.step = '校验文件完整性';
    const actual = await sha256OfFile(pkg);
    if (actual !== asset.sha256) {
      return {
        ok: false,
        error: `下载文件校验失败（SHA-256 不匹配）。可能是下载源返回了错误内容，换个下载源再试。\n期望 ${asset.sha256}\n实际 ${actual}`
      };
    }

    // ── 解压 ──
    state.step = '解压';
    const outDir = path.join(work, `out-${fmt}`);
    fs.mkdirSync(outDir, { recursive: true });
    const found = await extractBinaries(pkg, outDir);
    if (!found.ffmpeg) return { ok: false, error: `解压后没有找到 ${exeName('ffmpeg')}` };

    // ── 验证（先跑一遍，通过才落盘）──
    state.step = '验证可执行文件';
    const v = await probeFfmpeg(found.ffmpeg, 15000);
    if (!v.ok) return { ok: false, error: '解压出来的 ffmpeg 无法运行（可能缺少系统组件）' };

    // ── 原子安装 ──
    state.step = '安装';
    const destDir = managedBinDir();
    const parent = path.dirname(destDir);
    fs.mkdirSync(parent, { recursive: true });
    const staging = `${destDir}.new-${process.pid}-${Date.now().toString(36)}`;
    fs.mkdirSync(staging, { recursive: true });
    fs.copyFileSync(found.ffmpeg, path.join(staging, exeName('ffmpeg')));
    if (found.ffprobe) fs.copyFileSync(found.ffprobe, path.join(staging, exeName('ffprobe')));

    // 旧目录先挪开，成功后删除；失败则挪回 —— 不能让用户从"能用"变成"没有"
    const backup = `${destDir}.old-${process.pid}-${Date.now().toString(36)}`;
    let hadOld = false;
    try {
      if (fs.existsSync(destDir)) { fs.renameSync(destDir, backup); hadOld = true; }
      fs.renameSync(staging, destDir);
    } catch (e) {
      try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
      if (hadOld) { try { fs.renameSync(backup, destDir); } catch { /* ignore */ } }
      return { ok: false, error: `安装失败（无法写入 ${destDir}）：${e?.message ?? e}` };
    }
    if (hadOld) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* ignore */ } }

    return { ok: true, version: v.raw };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 删除已下载的那份（只动 managedBinDir，不碰系统装的）。 */
export function removeManagedFfmpeg() {
  const dir = path.dirname(managedBinDir());   // data/runtime/ffmpeg/
  try {
    if (!fs.existsSync(dir)) return { ok: true, removed: false };
    fs.rmSync(dir, { recursive: true, force: true });
    invalidateFfmpegCache();
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, error: `删除失败：${e?.message ?? e}` };
  }
}

/** 测试用：重置任务状态。 */
export function __resetSetupState() {
  Object.assign(state, { running: false, step: '', channel: '', received: 0, total: 0, error: '', ok: false, finishedAt: 0 });
}
