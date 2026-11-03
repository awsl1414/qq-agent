// ffmpeg 按需下载安装：下载 → 校验 → 解压 → 验证 → 原子安装。
//
// 为什么不随包分发：旧方案把 79MB 的 runtime/ffmpeg.exe 打进安装包，安装包
// 因此从 166.8MB 涨到 186.3MB，而 ffmpeg 只有「大图压缩 / GIF 转视频 /
// 视频抽帧 / 动态壁纸」四项用得上，纯文字聊天的用户白付这份体积。现在改为
// 设置页「媒体工具」按需下载到 data/runtime/ffmpeg/bin/，不下载也不影响
// 启动与其它功能（各处都降级）。
//
// Windows 上 7z 优先、zip 兜底：同一个 9.0.2 版本，7z 33.8MB，zip 109.5MB，
// 差 3.2 倍。两者都用 Windows 自带的 System32\tar.exe（bsdtar / libarchive）
// 解压（Node 标准库解不了 7z）。极老系统上 bsdtar 可能没有 lzma 支持，
// 所以解压失败时自动改下 zip 重试一次。
//
// ⚠️ 必须写死 System32\tar.exe，不能用裸名 `tar`：装了 Git for Windows 的机器
//    上 `where tar` 先命中 Git 的 GNU tar，它读不了 7z/zip（实测报
//    "This does not look like a tar archive"）。开发机往往正好装了 Git。
//
// Linux 为什么不用 tar：资产是 riedl 的 zip，每个包解出来就是单个无扩展名的
// ffmpeg / ffprobe。Linux 上的 `tar` 绝大多数是 GNU tar，它根本不认识 zip
// 格式；而 bsdtar 在多数发行版里不是默认安装。所以 Linux 分支直接用 Node
// 的 zlib 读 zip 中央目录并解出目标条目，不依赖任何外部解压工具。
//
// 安全：
//   · 下载走 safe-fetch（DNS 校验 / IP 固定 / 逐跳重定向校验），不裸 fetch
//   · 校验值写死在 ffmpeg-resolve.js，不依赖 GitHub API
//   · Windows 只解压 */bin/ffmpeg.exe 与 */bin/ffprobe.exe 两个条目；
//     Linux 只解出 zip 里唯一的那个 ffmpeg / ffprobe，其余不落地
//   · 装完必须真跑 -version 通过才算成功；失败回滚，不留半套
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { execFile, execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import {
  FFMPEG_VERSION, managedBinDir, exeName,
  resolveFfmpeg, invalidateFfmpegCache, probeFfmpeg,
  canAutoInstall, platformAssets
} from './ffmpeg-resolve.js';

// ── 代理 ──────────────────────────────────────────────────────────────
// 34MB 的包走 GitHub Release，在没有代理的网络里往往很慢甚至超时。复用用户
// 在「连接模型」里配的 api.proxy，不另开一个代理设置项，否则用户得在两处
// 各填一遍，且容易只配了一处。
//
// 没配 api.proxy 时读 Windows 的系统代理设置（Internet Settings 的
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
 * 多个镜像并存是有意的，某个站挂掉或限速时，用户换个源就能继续，
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
 * 选出这次下载的实际通道：URL 前缀 + 走不走代理。
 *
 * 镜像和代理是两个正交开关，但组合错了会互相拖后腿：
 *
 *   代理 + 镜像站  = 代理 → 国内镜像站 → GitHub。多绕一跳，通常比单用更慢；
 *   代理 + 官方直连 = 代理 → GitHub，实测 5.5MB/s（最优）；
 *   无代理 + 镜像站 = 镜像站 → GitHub，实测约 700KB/s（次优）；
 *   无代理 + 直连   = 官方，国内经常几十 KB/s 甚至超时（最差）。
 *
 * 所以规则是：有可用代理就走官方直连、不用镜像（镜像的意义就是替代代理）；
 * 没有代理才用镜像加速。用户显式选了「自定义前缀」时尊重他的选择，但同样
 * 在检测到代理时提示，自定义源可能是内网镜像，未必该绕过代理。
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

/**
 * Windows 资产的官方地址（前缀由用户选的镜像拼在前面）。
 *
 * 只服务 win32。这里拼的是 GyanD 的 GitHub Release 地址，镜像前缀也是按
 * 「前缀 + 完整 GitHub 地址」的形态设计的。Linux 的 riedl 资产自带完整
 * `url`（带构建时间戳目录，没有稳定别名），既不能加镜像前缀，也不该让用户
 * 选的下载源影响它，传进来只会拼出一个 404 地址。
 */
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
 *，这正是这个设置项存在的理由。但 Token 是用户凭据，只能交给 GitHub 自己。
 *
 * ⚠️ 不能靠「URL 里含 github.com」判断：镜像站的前缀形态恰好是
 *    `https://镜像站/https://github.com/...`，按字符串匹配会把 Token 发给镜像站。
 *    必须按 URL 的 hostname 精确匹配。
 */export const GITHUB_AUTH_HOSTS = new Set([
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
 * 一律返回 null，一个字节的凭据都不外发。
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
 * Windows 会把自己的 GNU tar 放进 PATH，所以不能用裸名，必须写死 System32。
 *
 * 非 Windows 平台返回裸名，但当前只有 Windows 安装路径会调用它：Linux 的
 * zip 由 extractSingleZipEntry 处理。
 */
export function tarPath() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    try { if (fs.statSync(sys).isFile()) return sys; } catch { /* 落到裸名 */ }
    return 'tar.exe';
  }
  return 'tar';
}

// ── 下载与验证参数 ────────────────────────────────────────────────────
/** 单个压缩包的大小上限。safeFetchBinaryToFile 在 bytes >= limit 时抛错，所以
 *  要用「已知大小 + 余量」而不是恰好等于文件大小，否则「正好下完」会被误杀。 */
const DOWNLOAD_SLACK_BYTES = 16 * 1024 * 1024;
/** 单次下载的网络空闲超时。镜像站偶发卡住时靠它失败退出，而不是挂到天荒地老。 */
const DOWNLOAD_TIMEOUT_MS = 60000;
/** 验证解压出来的 ffmpeg 能跑起来的超时。 */
const PROBE_TIMEOUT_MS = 15000;

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
 * 解压出 ffmpeg.exe / ffprobe.exe（Windows 包）。
 *
 * 用 --include 做选择性解压：包里还有 doc/、presets/、ffplay.exe 等，
 * 全解出来既慢又多写盘。bsdtar 的 --include 是 glob 匹配完整条目名，
 * 包内路径固定形如 `ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe`。
 *
 * 前提是「Windows 包内一定有 bin/ 目录」。Linux 包不是这个结构，
 * 由 extractSingleZipEntry 处理。
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
  walk(destDir, found);
  return found;
}

/**
 * 递归找目标文件名。两种包结构都适用，所以 Windows（<包名>/bin/xxx.exe）
 * 与 Linux（zip 根就是单个 ffmpeg）共用同一段。
 *
 * 深度上限是为了挡住畸形包把整棵临时目录树走穿；真实包最多两层。
 */
function walk(dir, found, depth = 0) {
  if (depth > 3) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, found, depth + 1); continue; }
    if (e.name === exeName('ffmpeg')) found.ffmpeg = found.ffmpeg || p;
    if (e.name === exeName('ffprobe')) found.ffprobe = found.ffprobe || p;
  }
}

// 单文件解压上限。riedl 的 ffmpeg 解压后约 91MB，留一倍余量；这个值同时
// 兜住「zip 中央目录被篡改成超大 uncompressed size」的膨胀攻击。
const EXTRACT_MAX_FILE_BYTES = 256 * 1024 * 1024;
// EOCD 固定 22 字节，末尾可能跟最多 64KB 注释。只在这段里找，不整文件扫。
const ZIP_EOCD_SIZE = 22;
const ZIP_COMMENT_MAX_BYTES = 65536;
const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_LOCAL = 0x04034b50;

/**
 * 从 zip 里解出唯一的目标文件，写到 destDir/<baseName>。
 *
 * 为什么自己读 zip 而不调 unzip/tar：Linux 上 `tar` 通常是 GNU tar，不支持
 * zip；`unzip` 也不保证存在（最小容器里经常没有）。Node 的 zlib 足够处理
 * riedl 用的 store/deflate 两种压缩方式，且不引入运行时依赖。
 *
 * 只认「包内恰好一个文件且名字等于 baseName」：riedl 的包就是单条目 zip，
 * 多条目或名字对不上说明下载到了别的东西，直接失败而不是猜。
 *
 * @param {string} baseName  期望的条目名（'ffmpeg' / 'ffprobe'）
 * @returns {string} 解出的文件路径
 */
function extractSingleZipEntry(zipFile, destDir, baseName) {
  const buf = fs.readFileSync(zipFile);
  // ── 定位 EOCD ──
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - ZIP_EOCD_SIZE - ZIP_COMMENT_MAX_BYTES);
  for (let i = buf.length - ZIP_EOCD_SIZE; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === ZIP_SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到中央目录结尾）');
  const count = buf.readUInt16LE(eocd + 10);
  if (count !== 1) throw new Error(`zip 里应有且只有 1 个文件，实际 ${count} 个`);
  let ptr = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(ptr) !== ZIP_SIG_CENTRAL) throw new Error('zip 中央目录损坏');

  const method = buf.readUInt16LE(ptr + 10);
  const compSize = buf.readUInt32LE(ptr + 20);
  const uncompSize = buf.readUInt32LE(ptr + 24);
  const nameLen = buf.readUInt16LE(ptr + 28);
  const extraLen = buf.readUInt16LE(ptr + 30);
  const commentLen = buf.readUInt16LE(ptr + 32);
  const localOff = buf.readUInt32LE(ptr + 42);
  const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

  if (name !== baseName) throw new Error(`zip 里的文件是 ${name}，期望 ${baseName}`);
  if (uncompSize > EXTRACT_MAX_FILE_BYTES) {
    throw new Error(`解压后体积异常（${uncompSize} 字节），超过上限`);
  }
  if (buf.readUInt32LE(localOff) !== ZIP_SIG_LOCAL) throw new Error('zip 本地头损坏');
  const lNameLen = buf.readUInt16LE(localOff + 26);
  const lExtraLen = buf.readUInt16LE(localOff + 28);
  const dataStart = localOff + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  let data;
  if (method === 0) data = Buffer.from(raw);
  // maxOutputLength 必须给：中央目录里的 uncompSize 是包自报的，可造假。
  else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: EXTRACT_MAX_FILE_BYTES });
  else throw new Error(`不支持的压缩方式（method=${method}）`);

  const dest = path.join(destDir, baseName);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, data);
  // 必须在这里给执行位，不能等到 installBinaries：调用方紧接着要 spawn
  // 这个文件跑 -version 做验证，没有执行位会直接 EACCES，把一次正常安装判成
  // "解压出来的 ffmpeg 无法运行"。zip 条目本身不携带执行位。
  fs.chmodSync(dest, 0o755);
  return dest;
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
 * 返回 { ok, error?, code?, path?, version?, source? }。失败不会抛，调用方是
 * HTTP 路由，抛错会变成 500 且 UI 拿不到分步原因。
 *
 * `code` 用于区分失败类别：'use_package_manager' 表示该平台不支持程序内
 * 下载（macOS），UI 应改为展示包管理器命令，而不是当成下载失败去重试。
 *
 * @param {{ mirror?: string, customMirror?: string }} [opts]
 */
export async function downloadAndInstallFfmpeg(opts = {}) {
  // 平台门禁必须排在「已有任务在跑」之前：macOS 上永远不会有任务在跑，
  // 先判平台能让用户直接看到"该怎么做"，而不是先收到一句无关的并发提示。
  if (!canAutoInstall()) {
    return { ok: false, code: 'use_package_manager', error: 'macOS 请用 Homebrew 安装 ffmpeg：brew install ffmpeg（设置页「媒体工具」里有可复制的命令）' };
  }
  if (state.running) return { ok: false, error: '已经有一个下载任务在跑，等它结束再试' };

  const cfg = getConfig();
  const mirror = String(opts.mirror || cfg?.media?.downloadMirror || DEFAULT_MIRROR);
  const customMirror = String(opts.customMirror ?? cfg?.media?.customMirror ?? '');
  // 镜像 / 自定义源只对 Windows 的 GyanD 资产有意义（Linux 的 riedl 地址自带
  // 完整 URL），所以 Linux 上不拿它拦人，否则一个写坏的自定义源会让本来
  // 跟它无关的 Linux 下载也启动不了。
  if (process.platform === 'win32' && mirror === 'custom' && !isValidMirrorPrefix(customMirror)) {
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
    const installed = process.platform === 'linux'
      ? await installLinux({ work })
      : await installWindows({ work, mirror, customMirror });
    if (!installed.ok) return fail(installed.error || '安装失败');

    // 装完重新解析一次，确认新装的这份真的能被用上
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

/** Windows：先试 7z（体积只有 zip 的三分之一），失败再换 zip（老版本 bsdtar 可能没有 lzma）。 */
async function installWindows({ work, mirror, customMirror }) {
  let installed = await tryInstallFormat('7z', { work, mirror, customMirror });
  if (!installed.ok) {
    state.step = '7z 解压失败，改用 zip 重试';
    state.received = 0;
    state.total = 0;
    installed = await tryInstallFormat('zip', { work, mirror, customMirror });
  }
  return installed;
}

/**
 * Linux：ffmpeg 与 ffprobe 是两个独立 zip，必须分两次下载。
 *
 * 不复用 tryInstallFormat 的原因：那里的资产是「同一份内容的两种压缩格式」，
 * 这里是「两个不同的文件」，进度、失败语义（任一失败即整体失败）都不同。
 *
 * 只下 zip 不试 7z：riedl 只提供 zip，且 Linux 上的 GNU tar 解不了 7z。
 */
async function installLinux({ work }) {
  const assets = platformAssets('linux');
  if (!assets) return { ok: false, error: `Linux ${process.arch} 没有可用的下载资产` };

  // 两个文件各自下载 + 校验 + 解压，产物先集中在 out-linux/ 下
  const outDir = path.join(work, 'out-linux');
  fs.mkdirSync(outDir, { recursive: true });
  // 代理只解析一次：两个包同源，没必要每轮重读配置 / 注册表
  const proxy = await resolveDownloadProxy();
  state.channel = proxy ? `经代理 ${proxy} 直连 riedl` : '直连 riedl';
  const parts = [['ffmpeg', assets.ffmpeg], ['ffprobe', assets.ffprobe]];
  const found = { ffmpeg: null, ffprobe: null, version: '' };
  for (let i = 0; i < parts.length; i++) {
    const [kind, asset] = parts[i];
    const label = `第 ${i + 1}/${parts.length} 个文件（${kind}）`;
    const pkg = path.join(work, `${kind}.zip`);

    try {
      // ── 下载 ──
      const mb = Math.round(asset.bytes / 1048576);
      state.step = `下载 ${label}，约 ${mb}MB`;
      state.received = 0;
      state.total = asset.bytes;
      // riedl 的 URL 是完整地址，不走镜像前缀，也没有 GitHub Token 可带
      await safeFetchBinaryToFile(asset.url, pkg, asset.bytes + DOWNLOAD_SLACK_BYTES, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        proxy,
        onProgress: (received, declared) => {
          state.received = received;
          if (declared > 0) state.total = declared;
        }
      });

      // ── 校验 ──
      state.step = `校验 ${label}`;
      const actual = await sha256OfFile(pkg);
      if (actual !== asset.sha256) {
        return {
          ok: false,
          error: `${kind} 下载文件校验失败（SHA-256 不匹配）。可能是下载源返回了错误内容，稍后再试。\n期望 ${asset.sha256}\n实际 ${actual}`
        };
      }

      // ── 解压（单条目 zip，直接解出目标文件）──
      state.step = `解压 ${label}`;
      const exe = extractSingleZipEntry(pkg, outDir, kind);

      // ── 验证（先跑一遍，通过才落盘）──
      state.step = `验证 ${label}`;
      const v = await probeFfmpeg(exe, PROBE_TIMEOUT_MS);
      if (!v.ok) return { ok: false, error: `${kind} 解压出来无法运行（可能缺少系统组件或架构不匹配）` };
      found[kind] = exe;
      if (kind === 'ffmpeg') found.version = v.raw;
    } catch (e) {
      return { ok: false, error: `${kind} 安装失败：${String(e?.message ?? e)}` };
    }
  }

  // ffprobe 在 Linux 上是必需的：它是单独下载的，缺了说明流程本身出了问题，
  // 不能像 Windows 那样"旧包没有就跳过"。
  return installBinaries(found);
}

/** 下载 + 校验 + 解压 + 落盘某一个格式。失败返回 { ok:false, error }，不抛。 */
async function tryInstallFormat(fmt, { work, mirror, customMirror }) {
  const asset = platformAssets('win32')?.[fmt];
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
    // 镜像站是第三方，把 Token 递过去等于把凭据交给它，这也是为什么不能
    // 统一传 headers：safeFetchBinaryToFile 每一跳都会复用同一份请求头。
    const ghToken = githubToken();
    const headersForHost = ghToken ? (u) => githubAuthHeaders(u, ghToken) : null;
    // 上限给 200MB：safeFetchBinaryToFile 在 bytes >= limit 时抛错，
    // 传恰好等于文件大小会误杀「正好下完」的正常情况。
    await safeFetchBinaryToFile(route.url, pkg, 200 * 1024 * 1024, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
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
    const v = await probeFfmpeg(found.ffmpeg, PROBE_TIMEOUT_MS);
    if (!v.ok) return { ok: false, error: '解压出来的 ffmpeg 无法运行（可能缺少系统组件）' };

    // Windows 上 ffprobe 可能不存在（旧包只有 ffmpeg），是可选项；
    // Linux 的必需性在 installLinux 里已保证。
    return installBinaries({ ...found, version: v.raw });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 原子安装：staging 目录 → rename 到 managedBinDir。
 *
 * 两个平台共用：Windows 是「同一包里的 ffmpeg + 可选 ffprobe」，Linux 是
 * 「分两次下载的 ffmpeg + 必需 ffprobe」，落盘形态完全一致。
 *
 * @param {{ ffmpeg: string, ffprobe: string|null, version?: string }} found
 */
function installBinaries(found) {
  if (!found.ffmpeg) return { ok: false, error: `解压后没有找到 ${exeName('ffmpeg')}` };

  state.step = '安装';
  const destDir = managedBinDir();
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });
  const staging = `${destDir}.new-${process.pid}-${Date.now().toString(36)}`;
  // 旧目录先挪开，成功后删除；失败则挪回，不能让用户从"能用"变成"没有"
  const backup = `${destDir}.old-${process.pid}-${Date.now().toString(36)}`;
  let hadOld = false;
  try {
    fs.mkdirSync(staging, { recursive: true });
    const destFfmpeg = path.join(staging, exeName('ffmpeg'));
    fs.copyFileSync(found.ffmpeg, destFfmpeg);
    // zip 条目未必带执行位；Windows 上 chmod 不改变执行权限。
    fs.chmodSync(destFfmpeg, 0o755);
    if (found.ffprobe) {
      const destFfprobe = path.join(staging, exeName('ffprobe'));
      fs.copyFileSync(found.ffprobe, destFfprobe);
      fs.chmodSync(destFfprobe, 0o755);
    }
    if (fs.existsSync(destDir)) { fs.renameSync(destDir, backup); hadOld = true; }
    fs.renameSync(staging, destDir);
  } catch (e) {
    try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    if (hadOld) { try { fs.renameSync(backup, destDir); } catch { /* ignore */ } }
    return { ok: false, error: `安装失败（无法写入 ${destDir}）：${e?.message ?? e}` };
  }
  if (hadOld) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* ignore */ } }

  return { ok: true, version: found.version || '' };
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
