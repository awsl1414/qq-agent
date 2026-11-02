// 小红车（Wallpaper Engine）控制层（内置模块 src/wallpaper/we-control.js）——
// 纯 Node 实现，不依赖 Electron / 本项目的其它模块。原 skills/wallpaper-engine/we.js。
//
// 为什么走命令行，而不是 WE 的 Web API：
//   WE 确实有 Web API（默认 8085 + 需要在设置里手动开启 + 配 PIN），普通用户大概率没开；
//   而 wallpaper32/64.exe 的 `-control` 通道是 WE 自己的进程间命令（内部走
//   \\.\pipe\WPXCMD_ 命名管道），只要 WE 装着就能用，零配置。
//   实测（2026-10-22，WE 当前版本）：
//     wallpaper64.exe -control openWallpaper -file "...\project.json"  → 退出码 0，桌面立刻换图
//     wallpaper64.exe -control getWallpaper                            → 退出码 0，但 stdout 为空
//   后者是因为 WE 是 GUI 子系统程序、没有控制台可回显，所以**不能用它读当前壁纸**；
//   "现在用的是哪张"改为解析 WE 自己写的 config.json（见 readCurrent）。
//
// 只把 WE 当成"有文件系统 + 有一个命令行入口"的黑盒，不猜它的内部状态：
//   · 壁纸库 = 硬盘上的 project.json（创意工坊 / 我的项目 / 官方项目，三个来源同一套解析）
//   · 当前壁纸 = config.json 里 `<用户名>.general.wallpaperconfig.selectedwallpapers.<MonitorN>.file`
//   · 换壁纸 = 发一条 -control 命令，再用 config.json 回读确认（WE 写盘有延迟，所以要轮询）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';

/** 创意工坊里 Wallpaper Engine 的 AppID。所有创意工坊内容都在 .../workshop/content/431960/<物品id>/ */
export const WORKSHOP_APPID = '431960';

const EXE_NAMES = ['wallpaper64.exe', 'wallpaper32.exe'];

// -control 的动作表。左列是给模型/用户看的口径，右列是 WE 认的实参。
// 没在这里列的动作一律拒绝 —— 不能让模型随便拼一个字符串就传给进程命令行。
const CONTROL_ACTIONS = {
  pause: 'pause',
  play: 'play',
  mute: 'mute',
  unmute: 'unmute',
  next: 'nextWallpaper',
  hide_icons: 'hideIcons',
  show_icons: 'showIcons',
  close: 'closeWallpaper'
};

// ── 小工具 ─────────────────────────────────────────────────────────────────

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 统一成 Windows 反斜杠 + 小写比较口径（WE 的 config.json 里是正斜杠且盘符大小写不定）。 */
function normWin(p) {
  return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '');
}

function samePathPrefix(file, dir) {
  const f = normWin(file).toLowerCase();
  const d = normWin(dir).toLowerCase();
  return f === d || f.startsWith(d + '\\');
}

/** 跑一个命令并连同退出码一起返回（永不抛错，失败折成 code=-1）。 */
function run(cmd, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        finish({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || String(error?.message ?? '')
        });
      });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    child.on('error', (error) => finish({ code: -1, stdout: '', stderr: String(error?.message ?? error) }));
  });
}

// ── 安装位置探测 ───────────────────────────────────────────────────────────

/**
 * 从注册表拿 Steam 安装目录。
 * 用 reg.exe 而不是读写注册表原生 API：本项目没有原生模块，reg query 是零依赖的。
 * 只读 HKCU（当前用户装 Steam 时写在这里），拿不到也不影响后面的路径猜测。
 */
function regSteamPath() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    return m ? normWin(m[1].trim()) : '';
  } catch { return ''; }
}

/** 兜底猜几个常见位置（注册表被清理 / 绿色版 / 装在别的盘时的唯一线索）。 */
function defaultSteamRoots() {
  const out = [];
  const drives = ['C', 'D', 'E', 'F', 'G'];
  for (const d of drives) {
    out.push(`${d}:\\Steam`);
    out.push(`${d}:\\SteamLibrary`);
    out.push(`${d}:\\Program Files (x86)\\Steam`);
    out.push(`${d}:\\Program Files\\Steam`);
  }
  const pf = process.env['ProgramFiles(x86)'];
  if (pf) out.push(path.join(pf, 'Steam'));
  return out;
}

/**
 * 解析 libraryfolders.vdf，拿到所有 Steam 库目录。
 *
 * 新版格式：  "path"		"D:\\SteamLibrary"
 * 老版格式：  "1"			"D:\\SteamLibrary"
 * 两种都出现过，所以两条正则都走；值里的 \\ 是 VDF 的转义，要还原。
 */
function readLibraryFolders(steamRoot) {
  const files = [
    path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'),
    path.join(steamRoot, 'config', 'libraryfolders.vdf')
  ];
  const libs = [];
  for (const file of files) {
    if (!fileExists(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const push = (raw) => {
      const p = normWin(String(raw ?? '').replace(/\\\\/g, '\\'));
      if (p && /^[A-Za-z]:\\/.test(p) && !libs.includes(p)) libs.push(p);
    };
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/gi)) push(m[1]);
    for (const m of text.matchAll(/"\d+"\s*"([A-Za-z]:[^"]*)"/g)) push(m[1]);
  }
  return libs;
}

/** ...\steamapps\common\wallpaper_engine → 回到库根；不规则安装返回 ''。 */
function libraryOfInstall(installDir) {
  const common = path.dirname(normWin(installDir));            // ...\common
  const steamapps = path.dirname(common);                       // ...\steamapps
  if (path.basename(common).toLowerCase() !== 'common') return '';
  if (path.basename(steamapps).toLowerCase() !== 'steamapps') return '';
  return path.dirname(steamapps);
}

let _detectCache = null;

/**
 * 找到 Wallpaper Engine 本体 + 所有可能的创意工坊目录。
 *
 * @param {{ executable?: string, force?: boolean }} options
 *        executable：用户在技能设置里手填的 wallpaper64.exe 路径（最高优先级）
 * @returns {{
 *   ok: boolean, exe: string, installDir: string, libraries: string[],
 *   workshopDirs: string[], steamRoots: string[], error?: string
 * }}
 */
export function detectInstall({ executable = '', force = false } = {}) {
  const now = Date.now();
  if (!force && !executable && _detectCache && now - _detectCache.at < 60_000) return _detectCache.value;

  const roots = new Set();
  const reg = regSteamPath();
  if (reg) roots.add(reg);
  for (const p of defaultSteamRoots()) if (dirExists(p)) roots.add(p);

  const libraries = new Set();
  for (const root of roots) {
    libraries.add(root);
    for (const lib of readLibraryFolders(root)) libraries.add(lib);
  }

  // 候选 exe：先手填的，再按库目录组合
  const candidates = [];
  if (executable) candidates.push(normWin(executable));
  for (const lib of libraries) {
    for (const name of EXE_NAMES) candidates.push(path.join(lib, 'steamapps', 'common', 'wallpaper_engine', name));
  }

  let exe = '';
  for (const c of candidates) {
    if (fileExists(c)) { exe = c; break; }
  }

  const value = {
    ok: Boolean(exe),
    exe,
    installDir: exe ? path.dirname(exe) : '',
    libraries: [...libraries],
    workshopDirs: [],
    steamRoots: [...roots],
    error: ''
  };

  if (exe) {
    // WE 自己的库也算进来：用户可能把 WE 装在一个库、创意工坊内容在另一个库
    const ownLib = libraryOfInstall(value.installDir);
    if (ownLib && !value.libraries.includes(ownLib)) value.libraries.push(ownLib);
  } else {
    value.error = '没找到 wallpaper64.exe。请在小红车技能设置里填「Wallpaper Engine 安装目录」。';
  }

  for (const lib of value.libraries) {
    const ws = path.join(lib, 'steamapps', 'workshop', 'content', WORKSHOP_APPID);
    if (dirExists(ws) && !value.workshopDirs.includes(ws)) value.workshopDirs.push(ws);
  }
  // 我的项目 / 官方项目在 WE 安装目录里，与库无关
  value.projectDirs = value.installDir
    ? {
      myprojects: path.join(value.installDir, 'projects', 'myprojects'),
      defaultprojects: path.join(value.installDir, 'projects', 'defaultprojects')
    }
    : { myprojects: '', defaultprojects: '' };

  _detectCache = { at: now, value };
  return value;
}

// ── 壁纸库扫描 ─────────────────────────────────────────────────────────────

/** 一个壁纸条目长这样（对模型只暴露 id/title/type/source，其余是内部用的路径）。 */
// { id, source, title, type, tags, rating, dir, projectFile, previewFile, previewBytes, workshopId, mtime }

/** 只读 project.json 里需要的几个字段；整个文件动辄几十 KB（含大量属性定义），能省则省。 */
function parseProject(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    const j = JSON.parse(text);
    return {
      title: String(j.title ?? '').trim(),
      type: String(j.type ?? '').trim(),
      tags: Array.isArray(j.tags) ? j.tags.map(String) : [],
      rating: String(j.contentrating ?? ''),
      preview: String(j.preview ?? '').trim(),
      workshopId: String(j.workshopid ?? '')
    };
  } catch {
    // 极少数工坊包写坏了 JSON：至少把标题抠出来，让它在列表里可见，而不是凭空消失
    const m = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return { title: m ? m[1].replace(/\\"/g, '"') : '', type: '', tags: [], rating: '', preview: '', workshopId: '' };
  }
}

/** 找预览图：project.json 里写的一般是 preview.gif / preview.jpg；写坏了就在目录里兜底找。 */
function resolvePreview(dir, declared) {
  const names = [];
  if (declared) names.push(declared);
  names.push('preview.gif', 'preview.jpg', 'preview.png', 'preview.jpeg', 'preview.webp');
  for (const n of names) {
    const p = path.join(dir, n);
    if (fileExists(p)) return p;
  }
  return '';
}

function readEntry(dir, source, idMap) {
  const projectFile = path.join(dir, 'project.json');
  if (!fileExists(projectFile)) return null;
  const meta = parseProject(projectFile) || {};
  const dirName = path.basename(dir);
  const id = idMap(dirName);
  const previewFile = resolvePreview(dir, meta.preview);
  let previewBytes = 0;
  if (previewFile) { try { previewBytes = fs.statSync(previewFile).size; } catch { /* ignore */ } }
  let mtime = 0;
  try { mtime = fs.statSync(projectFile).mtimeMs; } catch { /* ignore */ }
  return {
    id,
    source,
    title: meta.title || dirName,
    type: meta.type || '',
    tags: meta.tags || [],
    rating: meta.rating || '',
    dir,
    projectFile,
    previewFile,
    previewBytes,
    workshopId: meta.workshopId || (/^\d+$/.test(dirName) ? dirName : ''),
    mtime
  };
}

let _scanCache = null;

/**
 * 扫描全部已安装壁纸。
 *
 * 三个来源合成一个列表（对模型来说"壁纸"就是一维的，不该让它先选来源再选壁纸）：
 *   workshop  创意工坊（.../workshop/content/431960/<id>）
 *   local     我的项目（projects/myprojects）
 *   official  官方自带（projects/defaultprojects）
 *
 * 缓存：默认 45 秒。订阅/取消订阅后不必重启机器人，等一会儿就自动刷新。
 */
export function scanWallpapers(install, { force = false, cacheSeconds = 45 } = {}) {
  const now = Date.now();
  if (!force && _scanCache && install?.exe === _scanCache.exe && now - _scanCache.at < cacheSeconds * 1000) {
    return _scanCache.list;
  }
  const list = [];
  if (install?.ok) {
    for (const ws of install.workshopDirs || []) {
      let names = [];
      try { names = fs.readdirSync(ws); } catch { continue; }
      for (const name of names) {
        const dir = path.join(ws, name);
        if (!dirExists(dir)) continue;
        const entry = readEntry(dir, 'workshop', (n) => `workshop:${n}`);
        if (entry) list.push(entry);
      }
    }
    const roots = install.projectDirs || {};
    const localGroups = [
      [roots.myprojects, 'local', (n) => `local:${n}`],
      [roots.defaultprojects, 'official', (n) => `official:${n}`]
    ];
    for (const [root, source, idMap] of localGroups) {
      if (!root || !dirExists(root)) continue;
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names) {
        const dir = path.join(root, name);
        if (!dirExists(dir)) continue;
        const entry = readEntry(dir, source, idMap);
        if (entry) list.push(entry);
      }
    }
  }
  // 排序：创意工坊排最前（绝大多数人 90% 的壁纸都在工坊里），其次我的项目，官方自带垫底；
  // 工坊内部按 project.json 的 mtime 近似"最近订阅/更新"。
  const rank = { workshop: 0, local: 1, official: 2 };
  list.sort((a, b) => {
    const r = (rank[a.source] ?? 9) - (rank[b.source] ?? 9);
    if (r) return r;
    if (a.source === 'workshop' && b.source === 'workshop') return b.mtime - a.mtime;
    return String(a.title).localeCompare(String(b.title), 'zh-CN');
  });
  _scanCache = { at: now, exe: install?.exe ?? '', list };
  return list;
}

// ── 当前壁纸 ───────────────────────────────────────────────────────────────

/** 读 WE 的 config.json。WE 写盘时可能正在写一半（JSON 截断），所以重试几次。 */
function readWeConfig(install) {
  const file = path.join(install.installDir, 'config.json');
  let lastError = null;
  for (let i = 0; i < 3; i++) {
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      // 同步小睡 60ms 再重试（读配置是低频操作，不值得为它铺一条异步链）。
      // Atomics.wait 是唯一不烧 CPU 的同步睡眠；SharedArrayBuffer 在 Node 里始终可用。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); } catch { /* ignore */ }
    }
  }
  throw new Error(`读不了 Wallpaper Engine 的 config.json：${lastError?.message ?? lastError}`);
}

/**
 * 当前正在播放的壁纸。
 *
 * WE 的 config.json 按 Windows 用户分区：{ "?installdirectory": ..., "Administrator": {...} }。
 * 优先取与当前登录用户同名的那段；没有就取第一个带 wallpaperconfig 的段（单用户机器上等价）。
 *
 * @returns {{ username: string, monitors: Array<{monitor: string, file: string, entry: object|null}>,
 *            entry: object|null }}
 */
export function readCurrent(install, list) {
  const cfg = readWeConfig(install);
  const sections = Object.keys(cfg).filter((k) => !k.startsWith('?') && cfg[k] && typeof cfg[k] === 'object');
  if (!sections.length) return { username: '', monitors: [], entry: null };

  const me = String(os.userInfo?.().username || '').toLowerCase();
  const pick = sections.find((s) => s.toLowerCase() === me)
    || sections.find((s) => cfg[s]?.general?.wallpaperconfig?.selectedwallpapers)
    || sections[0];

  const selected = cfg[pick]?.general?.wallpaperconfig?.selectedwallpapers || {};
  const monitors = [];
  for (const [monitor, v] of Object.entries(selected)) {
    const file = normWin(v?.file ?? '');
    if (!file) continue;
    const entry = (list || []).find((e) => samePathPrefix(file, e.dir)) || null;
    monitors.push({ monitor, file, entry });
  }
  return { username: pick, monitors, entry: monitors.find((m) => m.entry)?.entry || null };
}

/** 轮询 config.json，等 WE 把"当前壁纸"落盘成指定条目。 */
async function waitForSelected(install, entry, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      last = readCurrent(install, [entry]);
      if (last.monitors.some((m) => m.entry?.id === entry.id)) return { confirmed: true, state: last };
    } catch { /* 读失败就下一轮 */ }
  }
  return { confirmed: false, state: last };
}

// ── 动作 ───────────────────────────────────────────────────────────────────

/** 发一条 -control 命令。返回 { ok, code, stderr }。 */
export async function runControl(install, action, { playlist = '' } = {}) {
  if (!install?.ok) return { ok: false, code: -1, stderr: install?.error || '没找到 Wallpaper Engine' };
  let args;
  if (action === 'open_playlist') {
    if (!String(playlist || '').trim()) return { ok: false, code: -1, stderr: '没给播放列表名' };
    args = ['-control', 'openPlaylist', '-playlist', String(playlist).trim()];
  } else {
    const real = CONTROL_ACTIONS[action];
    if (!real) return { ok: false, code: -1, stderr: `不支持的动作：${action}` };
    args = ['-control', real];
  }
  const r = await run(install.exe, args);
  // WE 对无法识别的参数也可能返回 0（GUI 程序不做严格参数校验），所以 ok 只代表"命令发出去了"
  return { ok: r.code === 0, code: r.code, stderr: r.stderr };
}

/**
 * 换成一张指定的壁纸。
 *
 * 命令里传的是 project.json 的**绝对路径**（WE 认这个，实测：传 scene.pkg 也行，
 * 但 scene.pkg 只存在于已经解包过的工坊内容里，project.json 才是稳定的入口）。
 * 多显示器时可选 -monitor <MonitorN>。
 */
export async function openWallpaper(install, entry, { monitor = '' } = {}) {
  if (!install?.ok) return { ok: false, error: install?.error || '没找到 Wallpaper Engine' };
  if (!entry?.projectFile || !fileExists(entry.projectFile)) {
    return { ok: false, error: `壁纸文件不见了：${entry?.projectFile || '(空)'}` };
  }
  const args = ['-control', 'openWallpaper', '-file', entry.projectFile];
  if (monitor) args.push('-monitor', monitor);
  const r = await run(install.exe, args, { timeoutMs: 20000 });
  if (r.code !== 0) {
    return { ok: false, error: `换壁纸命令失败（退出码 ${r.code}）：${r.stderr || '无输出'}` };
  }
  const confirmed = await waitForSelected(install, entry);
  return { ok: true, confirmed: confirmed.confirmed, state: confirmed.state };
}

/**
 * 「下一张」。
 *
 * 先发 WE 自己的 nextWallpaper（播放列表模式下它才是对的：会按播放列表顺序走，
 * 还会遵守 WE 的过渡设置）。但如果用户没开播放列表，这条命令什么都不做 ——
 * 所以回读 config.json 确认真的变了，没变就退回"随机换一张不同的"。
 */
export async function nextWallpaper(install, list, currentEntry) {
  const before = currentEntry?.id || '';
  const r = await runControl(install, 'next');
  if (r.ok) {
    // 等 6 秒：有播放列表时 WE 会先做过渡动画、再写 config.json，太快判定"没换"会误判成
    // "没有播放列表"，于是又随机盖掉一张 —— 用户会觉得"让它下一张，它乱换"。
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 400));
      try {
        const st = readCurrent(install, list);
        if ((st.entry?.id || '') && st.entry.id !== before) return { ok: true, via: 'playlist', entry: st.entry };
      } catch { /* ignore */ }
    }
  }
  const pool = (list || []).filter((e) => e.id !== before);
  if (!pool.length) return { ok: false, error: '壁纸库里只有一张壁纸，没得换' };
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const applied = await openWallpaper(install, pick);
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, via: 'random', entry: pick };
}

/** WE 进程在不在（换壁纸其实不要求它先开着：-control 会把 WE 拉起来，但状态文案要说清楚）。 */
export function isRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq wallpaper64.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    if (/wallpaper64\.exe/i.test(out)) return true;
  } catch { /* ignore */ }
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq wallpaper32.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    return /wallpaper32\.exe/i.test(out);
  } catch { return false; }
}

// ── 搜索打分 ───────────────────────────────────────────────────────────────

/** 归一化：去掉空白与常见标点，全角半角不敏感。中文按字匹配，英文按子串。 */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\-_·•:：,，.。;；'"“”‘’`()（）\[\]【】{}<>《》!！?？/\\|~～+*&^%$#@]+/g, '');
}

/**
 * 中文标签 → 创意工坊英文 tag。
 *
 * 为什么要这张表：WE 的 tags 全是英文（Anime / Nature / Pixel art …），
 * 而用户说的都是中文（"二次元""像素""风景"）。不翻译的话，说"来个像素风的"
 * 会一个都匹配不到 —— 明明库里就有 Pixel art 壁纸。
 * 只收常用标签，够覆盖绝大多数据说；匹配不到就退回标题匹配，不会更糟。
 */
const TAG_ALIAS = {
  '二次元': 'anime', '动漫': 'anime', '番剧': 'anime', 'acg': 'anime',
  '人物': 'anime', '女孩': 'girls', '女生': 'girls', '妹子': 'girls', '美少女': 'girls',
  '男孩': 'guys', '男生': 'guys', '帅哥': 'guys',
  '游戏': 'game', '游戏角色': 'game',
  '像素': 'pixel art', '像素风': 'pixel art', '像素画': 'pixel art',
  '风景': 'nature', '自然': 'nature', '山水': 'nature', '森林': 'nature', '海': 'nature',
  '抽象': 'abstract', '几何': 'abstract',
  '赛博朋克': 'cyberpunk', '赛博': 'cyberpunk', '机能风': 'cyberpunk',
  '幻想': 'fantasy', '奇幻': 'fantasy', '魔幻': 'fantasy',
  '音乐': 'music', '音游': 'music', '节奏': 'music',
  '卡通': 'cartoon', '动画': 'cartoon', '动漫风': 'cartoon',
  '动物': 'animal', '猫': 'animal', '狗': 'animal', '小动物': 'animal',
  '中世纪': 'medieval', '骑士': 'medieval',
  '梗': 'memes', '表情包': 'memes', '搞笑': 'memes', '鬼畜': 'memes',
  '放松': 'relaxing', '治愈': 'relaxing', '舒缓': 'relaxing', '唯美': 'relaxing',
  '复古': 'retro', '怀旧': 'retro', '8bit': 'retro',
  '科幻': 'sci-fi', '科幻风': 'sci-fi', '太空': 'sci-fi', '宇宙': 'sci-fi',
  '运动': 'sports', '体育': 'sports',
  '科技': 'technology', '机械': 'technology', '硬核': 'technology',
  '电视': 'television', '影视': 'television', '电影': 'television',
  '车': 'vehicle', '汽车': 'vehicle', '跑车': 'vehicle', '摩托': 'vehicle',
  '未分类': 'unspecified', '其他': 'unspecified',
  '3d': 'cgi', '建模': 'cgi', '渲染': 'cgi',
  'mmd': 'mmd', '舞蹈': 'mmd', '跳舞': 'mmd'
};

/**
 * 给"用户说法 → 壁纸标题"打分。
 *
 * 分档（为什么这么设计）：
 *   2000  直接给了创意工坊 id
 *   1000  完全一致
 *   500+  标题里包含查询词（越靠前、越短越好）—— 绝大多数"换张XX"都命中这一档
 *   100+  查询词的每个字都出现在标题里（"初音未来" vs "Miku 初音未来：Fallen"）
 *   420   命中中文标签对应的英文 tag（"像素" → Pixel art）
 *   0~99  部分命中（按覆盖率），只用于"找不到就推荐几个相近的"
 */
export function scoreMatch(query, entry) {
  const q = normalizeText(query);
  if (!q) return 0;
  if (entry.workshopId && String(query).trim() === entry.workshopId) return 2000;

  const title = normalizeText(entry.title);
  const tags = normalizeText((entry.tags || []).join(' '));
  let score = 0;

  if (title === q) score = 1000;
  else {
    const idx = title.indexOf(q);
    if (idx >= 0) score = 500 + Math.max(0, 80 - idx * 4) - Math.min(150, title.length - q.length);
    else {
      // 字符覆盖率：中文查询几乎总能覆盖一部分，所以要求 0.8 以上才算"比较像"
      let hit = 0;
      for (const ch of new Set(q)) if (title.includes(ch)) hit += 1;
      const ratio = hit / new Set(q).size;
      if (ratio >= 0.8) score = 100 + ratio * 50;
      else if (ratio >= 0.5) score = ratio * 60;
    }
  }
  // 标签命中：英文 tag 直接包含，或中文别名翻译后包含
  const alias = TAG_ALIAS[q];
  if (tags && tags.includes(q)) score += 150;
  else if (alias) {
    const aliasKey = normalizeText(alias);
    if (tags.includes(aliasKey)) score = Math.max(score, 420);
  }
  return Math.round(score);
}

/** 按查询词排序，返回 [{entry, score}]，只保留 score>0。 */
export function searchWallpapers(list, query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  return (list || [])
    .map((entry) => ({ entry, score: scoreMatch(q, entry) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.entry.title).localeCompare(String(b.entry.title), 'zh-CN'));
}

/**
 * 这张壁纸是不是"可以安全发进群"的。
 *
 * 创意工坊的 contentrating 分 Everyone / Questionable / Mature 三档；空值（官方项目、
 * 一部分本地项目没写）按安全处理。成人向壁纸**可以换**（那是主人的桌面），
 * 但它的预览图不该发进群 —— 发了是号没了，不是丢面子的问题。
 */
export function isSafeRating(entry) {
  const r = String(entry?.rating ?? '').toLowerCase();
  return !r || r === 'everyone' || r === 'none' || r === 'safe';
}

/** 给模型看的壁纸行：标题（截断）+ 类型 + 来源 + id，当前那张打★，成人向标 18+。 */
export function formatEntry(entry, { current = false } = {}) {
  const title = String(entry.title || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  // type 在 project.json 里大小写不统一（scene / Scene / Scene 都有），统一成小写再展示
  const type = entry.type ? String(entry.type).toLowerCase() : '未知类型';
  const src = entry.source === 'workshop' ? '工坊' : entry.source === 'official' ? '官方' : '本地';
  const adult = isSafeRating(entry) ? '' : '｜18+';
  return `${current ? '★ ' : ''}${title} ｜${type}｜${src}${adult}｜id=${entry.id}`;
}

export const internals = { readWeConfig, waitForSelected, CONTROL_ACTIONS };
