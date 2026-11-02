// 协议端（SnowLuma）配置探测：找到它、读出端点与令牌。
//
// ── 为什么需要这个模块（2026-10-24）──────────────────────────────────────
// 协议端自 2026-10-23 起由用户自行安装、自己启动，令牌不再随包分发：
// SnowLuma 用 `randomBytes(32).toString('base64url')` 给每个账号**首次运行**时
// 随机生成一对（HTTP / WS 各一枚，互不相同），落盘在
// `<SnowLuma>/config/onebot_<QQ号>.json`。
//
// 于是"把 Agent 打包发给别人"这件事卡在一个很蠢的地方：对方要打开 WebUI、
// 找到网络配置、抄两串 43 位随机字符、再粘回 Agent。抄错一位的表现是
// "端口通了但没连上"，页面只能提示"令牌不一致"——用户根本不知道去哪找。
//
// 本模块把这一步自动化：直接读协议端自己的配置文件。它是**只读**的，
// 不改协议端任何文件；令牌只在进程内向上传递，不进日志、不进 /api 响应。
//
// ── 设计约束 ──────────────────────────────────────────────────────────────
//   · 找不到就返回原因，由调用方静默退回手动填写 —— 探测失败不该打扰用户；
//   · 认不出格式（协议端升级改了结构）也只返回 found:false，绝不抛到调用方；
//   · 所有 spawn 都带超时，最坏情况拖 8 秒，不阻塞启动关键路径（调用方异步跑）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本模块所在目录（src/）。ESM 里没有 __dirname，必须从 import.meta.url 取 ——
// 用它去找"Agent 安装目录旁边有没有并排放着 snowluma"。
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 协议端按账号落盘的配置文件名：config/onebot_<QQ号>.json */
const PER_UIN_CONFIG = /^onebot_(\d+)\.json$/i;

/** 扫描磁盘时的目录黑名单：进这些目录只会白白吃 I/O，不可能有协议端。 */
const SKIP_DIRS = new Set([
  'windows', 'windows.old', 'programdata', '$recycle.bin', 'system volume information',
  'recovery', 'perflogs', 'node_modules', '.git', 'appdata', 'intel', 'amd', 'nvidia',
  'msocache', 'config.msi', 'documents and settings', '$windows.~bt', '$windows.~ws'
]);

/** 单盘最多展开多少个子目录（防止在装满项目的大盘上扫到天荒地老）。 */
const MAX_CHILD_DIRS_PER_DRIVE = 120;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * 一个目录像不像 SnowLuma 安装目录。
 *
 * 判据放宽到"有 config 子目录且里面有 onebot_*.json"或"有 index.mjs"：
 * 前者是已经跑起来的（能直接读令牌），后者是装了但还没登录过的（读不到令牌，
 * 但至少能告诉用户"装在这儿了，先启动并登录一次"）。
 */
function looksLikeSnowLuma(dir) {
  if (!dir || !isDir(dir)) return false;
  const cfgDir = path.join(dir, 'config');
  if (isDir(cfgDir) && safeReaddir(cfgDir).some((e) => PER_UIN_CONFIG.test(e.name))) return true;
  return fs.existsSync(path.join(dir, 'index.mjs'));
}

function expandEnv(raw) {
  return String(raw || '').replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m).trim();
}

/**
 * 从事先已知的位置收集候选目录：环境变量 → 安装位置周边 → 各盘根目录。
 *
 * 顺序即优先级：环境变量是用户显式指定，最可信；进程扫描在 detectProtocol
 * 里排在更前面（它给出的是"正在运行的那一份"，比磁盘上躺着的旧副本更准）。
 */
async function candidateDirsFromDisk() {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (v && !out.includes(v)) out.push(path.resolve(v));
  };

  // ① 显式指定（给"装在奇怪位置"的人留一个逃生口，也是 .bat/文档里最好写的）
  for (const key of ['SNOWLUMA_HOME', 'SNOWLUMA_DIR', 'SNOWLUMA_PATH']) push(expandEnv(process.env[key]));

  // ② 常见安装位置
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localApp = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  for (const base of [home, localApp, path.join(localApp, 'Programs'), programFiles, path.join(home, 'Desktop'), path.join(home, 'Downloads')]) {
    if (!base) continue;
    for (const e of safeReaddir(base)) {
      if (e.isDirectory() && /^snowluma/i.test(e.name)) push(path.join(base, e.name));
    }
  }

  // ③ Agent 自己旁边 / 上一级（分发时最常见的放法：同一层目录并排放两个）
  //    src → app → resources → 安装目录 → 安装目录的上一级
  try {
    for (const up of [MODULE_DIR, path.dirname(MODULE_DIR), path.dirname(path.dirname(MODULE_DIR)), path.dirname(path.dirname(path.dirname(MODULE_DIR)))]) {
      for (const e of safeReaddir(up)) {
        if (e.isDirectory() && /^snowluma/i.test(e.name)) push(path.join(up, e.name));
      }
    }
  } catch { /* ignore */ }

  // ④ 各盘根目录 + 一层子目录（用户的 F:\QQA\snowluma 就属于这种）
  for (const drive of listDriveRoots()) {
    const entries = safeReaddir(drive).filter((e) => e.isDirectory());
    for (const e of entries.slice(0, MAX_CHILD_DIRS_PER_DRIVE)) {
      if (/^snowluma/i.test(e.name)) push(path.join(drive, e.name));
    }
    // 根目录下没有就直接看一层子目录（跳过系统目录）
    if (!entries.some((e) => /^snowluma/i.test(e.name))) {
      for (const e of entries.slice(0, MAX_CHILD_DIRS_PER_DRIVE)) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        const kids = safeReaddir(path.join(drive, e.name));
        for (const k of kids) {
          if (k.isDirectory() && /^snowluma/i.test(k.name)) push(path.join(drive, e.name, k.name));
        }
      }
    }
  }
  return out;
}

/** 本机固定磁盘根（A/B 软驱跳过）。不存在就 existsSync 一次，比 spawn 便宜。 */
function listDriveRoots() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (let c = 67; c <= 90; c++) {   // C..Z
    const root = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(root)) roots.push(root); } catch { /* ignore */ }
  }
  return roots;
}

/**
 * 从正在运行的进程里找 SnowLuma 目录。
 *
 * 为什么这条最有价值：SnowLuma 是自带 node.exe 启动的（`node.exe index.mjs`），
 * 所以 ExecutablePath 的目录就是安装目录，不依赖用户装在哪、也不依赖我们猜。
 * 实测命令行形如 `F:\QQA\snowluma\node.exe F:\QQA\snowluma\index.mjs`，
 * 相对启动时（`node index.mjs`）ExecutablePath 仍然指向安装目录。
 */
async function dirsFromProcesses() {
  if (process.platform !== 'win32') return [];
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |',
    "  Where-Object { $_.CommandLine -match 'snowluma|index\\.mjs' } |",
    '  Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  ].join(' ');
  const out = [];
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const text = String(stdout || '').trim();
    if (!text) return out;
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      const exe = String(row?.ExecutablePath || '').trim();
      const cmd = String(row?.CommandLine || '');
      if (exe) out.push(path.dirname(exe));
      // 命令行里若带绝对路径的 index.mjs，它的目录也是候选（覆盖"用别处的 node 启动"）
      const m = /(?:^|\s)"?([A-Za-z]:\\[^"]*?index\.mjs)"?/i.exec(cmd);
      if (m) out.push(path.dirname(m[1]));
    }
  } catch { /* PowerShell 不可用 / 超时：交给磁盘扫描 */ }
  return out;
}

function hostOf(server) {
  const h = String(server?.host || '127.0.0.1').trim();
  // 监听 0.0.0.0 / :: 的实例，本机连回环即可
  if (!h || h === '0.0.0.0' || h === '::' || h === '[::]') return '127.0.0.1';
  return h;
}

function urlOf(scheme, server) {
  const port = Number(server?.port);
  if (!Number.isFinite(port) || port <= 0) return '';
  let p = String(server?.path || '/').trim();
  if (!p.startsWith('/')) p = `/${p}`;
  if (p === '/') p = '';
  return `${scheme}://${hostOf(server)}:${port}${p}`;
}

/**
 * 解析一份 onebot_<uin>.json。认不出结构就返回 null（协议端改格式时不炸）。
 *
 * 只取**第一个**带端口的 http/ws server：SnowLuma 默认各建一个，
 * 也就是 Agent 该连的那一对。多 server 的高级用法不猜。
 */
function parseProtocolFile(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const nets = raw?.networks;
  if (!nets || typeof nets !== 'object') return null;

  const wsList = Array.isArray(nets.wsServers) ? nets.wsServers : [];
  const httpList = Array.isArray(nets.httpServers) ? nets.httpServers : [];
  const ws = wsList.find((s) => s && Number(s.port) > 0) || null;
  const http = httpList.find((s) => s && Number(s.port) > 0) || null;
  // 有一种配置是把 WS 挂在 HTTP server 上（enableWebSocket）—— 这时 WS 端口 = HTTP 端口
  const wsOnHttp = !ws && http && http.enableWebSocket === true ? http : null;
  if (!ws && !http) return null;

  const wsServer = ws || wsOnHttp;
  const mm = PER_UIN_CONFIG.exec(path.basename(file));
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }

  return {
    uin: mm ? mm[1] : '',
    configPath: file,
    mtime,
    wsUrl: wsServer ? urlOf('ws', wsServer) : '',
    httpUrl: http ? urlOf('http', http) : '',
    wsPort: wsServer ? Number(wsServer.port) : 0,
    httpPort: http ? Number(http.port) : 0,
    accessToken: wsServer ? String(wsServer.accessToken ?? '') : '',
    httpAccessToken: http ? String(http.accessToken ?? '') : ''
  };
}

/**
 * 列出所有可读的账号配置（不带令牌，供 UI 展示"检测到几个账号"）。
 * 内部用：detectProtocol 需要带令牌的完整记录。
 */
function collectAccounts(dirs) {
  const accounts = [];
  for (const dir of dirs) {
    const cfgDir = path.join(dir, 'config');
    if (!isDir(cfgDir)) continue;
    for (const e of safeReaddir(cfgDir)) {
      if (!e.isFile() || !PER_UIN_CONFIG.test(e.name)) continue;
      const rec = parseProtocolFile(path.join(cfgDir, e.name));
      if (rec) accounts.push({ ...rec, dir });
    }
  }
  return accounts;
}

/**
 * 探测协议端配置。
 *
 * @param {object} opts
 * @param {string} [opts.dir]      指定目录（跳过自动查找，供"我知道装在哪"用）
 * @param {Function} [opts.isPortOpen] (host, port) => Promise<boolean>
 *        传了就用"端口真在监听"来挑账号：双开或多账号时，挑正在跑的那个，
 *        而不是单纯看文件 mtime。
 * @returns {Promise<{
 *   found: boolean, reason?: string,
 *   dir?: string, uin?: string, configPath?: string,
 *   wsUrl?: string, httpUrl?: string, wsPort?: number, httpPort?: number,
 *   accessToken?: string, httpAccessToken?: string,
 *   wsPortOpen?: boolean,
 *   accounts?: Array<{uin:string,wsPort:number,httpPort:number,hasWsToken:boolean,hasHttpToken:boolean,mtime:number,portOpen?:boolean,dir:string}>
 * }>}
 *   ⚠️ 返回体含明文令牌，**只允许在进程内使用**；给渲染层前必须过 publicView()。
 */
export async function detectProtocol({ dir = '', isPortOpen = null } = {}) {
  let dirs = [];
  if (dir) {
    dirs = [path.resolve(String(dir))];
  } else {
    const seen = new Set();
    const add = (list) => { for (const d of list) { const v = path.resolve(d); if (!seen.has(v)) { seen.add(v); dirs.push(v); } } };
    add(await dirsFromProcesses());
    add(await candidateDirsFromDisk());
  }
  // 只保留真的像协议端目录的（避免把 node_modules 之类误当候选去读）
  const validDirs = dirs.filter((d) => looksLikeSnowLuma(d));
  const accounts = collectAccounts(validDirs);

  if (!accounts.length) {
    return {
      found: false,
      reason: validDirs.length
        ? '找到 SnowLuma 目录，但里面还没有 config/onebot_<QQ号>.json —— 先启动 SnowLuma 并登录一次机器人 QQ，再点重新检测。'
        : '没找到 SnowLuma 的配置文件。如果你用的是 NapCat，或 SnowLuma 装在非常规位置，请手动填写端点与令牌。'
    };
  }

  // 挑账号：端口在监听 > 文件最新
  if (typeof isPortOpen === 'function') {
    const ports = [...new Set(accounts.map((a) => a.wsPort).filter(Boolean))].slice(0, 6);
    const states = await Promise.all(ports.map((p) => isPortOpen('127.0.0.1', p).catch(() => false)));
    const openSet = new Set(ports.filter((_, i) => states[i]));
    for (const a of accounts) a.portOpen = openSet.has(a.wsPort);
  }
  accounts.sort((a, b) => (Number(b.portOpen) - Number(a.portOpen)) || (b.mtime - a.mtime));
  const best = accounts[0];

  return {
    found: true,
    dir: best.dir,
    uin: best.uin,
    configPath: best.configPath,
    wsUrl: best.wsUrl,
    httpUrl: best.httpUrl,
    wsPort: best.wsPort,
    httpPort: best.httpPort,
    accessToken: best.accessToken,
    httpAccessToken: best.httpAccessToken,
    wsPortOpen: Boolean(best.portOpen),
    accounts: accounts.map((a) => ({
      uin: a.uin,
      wsPort: a.wsPort,
      httpPort: a.httpPort,
      // 只报"有没有"，不报值
      hasWsToken: Boolean(a.accessToken),
      hasHttpToken: Boolean(a.httpAccessToken),
      portOpen: Boolean(a.portOpen),
      mtime: a.mtime,
      dir: a.dir
    }))
  };
}

/**
 * 把探测结果削成"可以回给渲染层"的样子：**删掉两枚令牌**，只留有无标记。
 * 这个函数是令牌不越过 IPC/HTTP 边界的唯一保证 —— 新增字段时务必同步检查。
 */
export function publicView(hit) {
  if (!hit) return { found: false, reason: '探测失败' };
  if (!hit.found) return { found: false, reason: hit.reason };
  return {
    found: true,
    uin: hit.uin || '',
    wsUrl: hit.wsUrl || '',
    httpUrl: hit.httpUrl || '',
    wsPort: hit.wsPort || 0,
    httpPort: hit.httpPort || 0,
    wsPortOpen: Boolean(hit.wsPortOpen),
    hasWsToken: Boolean(hit.accessToken),
    hasHttpToken: Boolean(hit.httpAccessToken),
    accountCount: Array.isArray(hit.accounts) ? hit.accounts.length : 1,
    accounts: (hit.accounts || []).map((a) => ({
      uin: a.uin, wsPort: a.wsPort, httpPort: a.httpPort,
      hasWsToken: a.hasWsToken, hasHttpToken: a.hasHttpToken, portOpen: a.portOpen
    }))
  };
}
