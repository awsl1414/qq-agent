// 控制台壁纸库（内置模块 src/wallpaper/core.js —— 2026-10-23 由「壁纸套件交接包」
// 内置化，原 plugins/wallpaper 插件）：扫描 Wallpaper Engine 的壁纸
// （Steam 创意工坊 + 本地 myprojects），给控制台「壁纸」页提供壁纸列表与文件定位。
//
// 架构角色与 media-download / voice-module 一致：本模块只提供**能力**
// （wallpaper.library / wallpaper.file），HTTP 暴露在 src/routes.js 的
// /api/wallpaper/* 以能力中介方式完成 —— 本模块不碰 HTTP，路由只做能力中介。
//
// 安全边界：wallpaper.file 只按 id 返回**本次扫描登记过**的绝对路径，
// 请求方传来的任何路径字符串都被忽略 —— 浏览器端永远拿不到"任意文件读取"。
//
// 类型策略（决定每张壁纸在控制台里怎么用）：
//   video  → 浏览器能直接播，作为动态背景（kind='video'，返回媒体文件本身）
//   scene  → Wallpaper Engine 专有格式（scene.pkg），浏览器渲染不了 → 只给 preview 静态图
//   web    → 本质是任意网页代码，嵌进控制台等于执行第三方脚本，绝不加载 → 只给 preview 静态图
//   image  → 静态图壁纸：优先用 preview，没有预览时回退原图
//   以上都尽量带 preview.jpg 当缩略图（没有就用页面占位样式）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../config.js';

let config = () => ({});
let log = () => {};

export function setup(api) {
  config = api.config;
  log = api.log || (() => {});
}

// 数据目录：与全站同一口径（config.js：QQ_AGENT_DATA_DIR > PROFILE 后缀 > app/data）。
// 内置化改造说明：插件期这里按 import.meta.url 自己反推（plugins/wallpaper 上两级
// 正好是 app/）；搬到 src/wallpaper/ 后反推结果相同，但那样会有两份 DATA_DIR 逻辑、
// 且绕不过 QQ_AGENT_PROFILE 的多实例后缀 —— 直接复用 config.js 那一份。

// ── 动态壁纸管线（lib/，移植自 zcode-beautify MIT）───────────────────────
// 模块只动态 import 一次并缓存：sceneimport 的任务表在模块里，反复
// ?t= 重导会把跑着的任务表丢掉。改 lib/ 下的文件需要重启 QQ Agent。
let dynLib = null;
async function loadDynLib() {
  if (!dynLib) {
    dynLib = await import('./lib/sceneimport.js');
  }
  return dynLib;
}

// ffmpeg 相关工具（deps 检测 + exec）：给「GIF 预览冻结」用，与导入管线分离
let ffLib = null;
async function loadFfLib() {
  if (!ffLib) {
    ffLib = {
      deps: await import('./lib/deps.js'),
      exec: await import('./lib/exec.js')
    };
  }
  return ffLib;
}

// ── GIF 预览冻结 ─────────────────────────────────────────────────────────
// WE 的动图预览（preview.gif）会同时出现在壁纸页网格缩略图、contain 模式
// 的整屏模糊背板、静态壁纸背景里 —— GIF 没有硬件解码，每帧都是 CPU 解码
// （模糊层还要整屏重栅格化），是滚动/切页卡顿的主源。扫描时用 ffmpeg 抽
// 首帧存成 JPG（按 gif mtime 失效，一次 ~75ms 永久缓存），之后所有「预览」
// 一律伺服静态帧；ffmpeg 缺失时静默退回动图。
const STATIC_ROOT = path.join(DATA_DIR, 'wallpaper-static');
async function staticPreviewOf(id, gifPath) {
  const out = path.join(STATIC_ROOT, `${id}.jpg`);
  try {
    const [g, o] = [fs.statSync(gifPath), fs.statSync(out)];
    if (o.isFile() && o.size > 0 && o.mtimeMs >= g.mtimeMs) return out;
  } catch { /* 还没生成 */ }
  try {
    const lib = await loadFfLib();
    const ff = await lib.deps.checkFfmpeg();
    if (!ff.ok) return '';
    fs.mkdirSync(STATIC_ROOT, { recursive: true });
    await lib.exec.execFileP(ff.path, ['-y', '-loglevel', 'error', '-i', gifPath, '-frames:v', '1', '-q:v', '3', out], { timeout: 30_000 });
    return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : '';
  } catch { return ''; }
}

// 导入登记表：id → { hash, at }。扫描时据此把已动态化的壁纸当视频壁纸
// 伺服（media = 缓存里的无缝循环 mp4）。LRU 把缓存删了 = 登记失效回静态。
const IMPORTS_FILE = path.join(DATA_DIR, 'wallpaper-imports.json');
let importsReg = null;
function importsLoad() {
  if (importsReg) return importsReg;
  try { importsReg = JSON.parse(fs.readFileSync(IMPORTS_FILE, 'utf8')) || {}; }
  catch { importsReg = {}; }
  return importsReg;
}
function importsSave() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(IMPORTS_FILE, JSON.stringify(importsReg, null, 2));
  } catch (e) { log(`动态壁纸登记表写入失败：${e?.message ?? e}`); }
}
async function dynHashOf(id) {
  const reg = importsLoad()[id];
  if (!reg?.hash) return '';
  const lib = await loadDynLib();
  return lib.hasCache(DATA_DIR, reg.hash) ? reg.hash : '';
}

// ── 壁纸当前状态（控制台与机器人共享的镜像）─────────────────────────────
// 控制台每次保存会 POST /api/wallpaper/state 同步过来；QQ 聊天里的
// 「壁纸管家」技能改壁纸也走这里（能力中介），改完由调用方广播
// wallpaper-changed 让控制台实时跟随。文件只是镜像：删了/坏了 =
// 回到「从未同步」状态，不影响控制台本地 localStorage 的主状态。
function stateLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'wallpaper-state.json'), 'utf8'));
    return j && typeof j === 'object' && j.id ? j : null;
  } catch { return null; }
}

function canonicalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const id = String(cfg.id || '');
  if (!/^[wm][a-zA-Z0-9._-]{0,120}$/.test(id)) return null;
  return {
    id,
    title: String(cfg.title || id).slice(0, 200),
    kind: cfg.kind === 'video' ? 'video' : 'still',
    blur: Math.max(0, Math.min(40, Number(cfg.blur ?? 18) || 0)),
    dim: Math.max(0, Math.min(0.7, Number(cfg.dim ?? 0.25) || 0)),
    monet: cfg.monet !== false,
    fit: ['cover', 'contain', 'smart'].includes(cfg.fit) ? cfg.fit : 'smart',
    panel: Math.max(0.1, Math.min(1, Number(cfg.panel ?? 0.46) || 0.46)),
    text: ['theme', 'white', 'black', 'blue', 'yellow', 'green', 'pink', 'purple'].includes(cfg.text) ? cfg.text : 'theme',
    updatedAt: Date.now()
  };
}

function stateSave(cfg) {
  const c = canonicalize(cfg);
  try {
    const file = path.join(DATA_DIR, 'wallpaper-state.json');
    if (!c) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(c, null, 2));
  } catch (e) {
    log(`壁纸状态写入失败（不影响控制台本地使用）：${e?.message ?? e}`);
  }
  return c;
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);
// Chromium 控制台能直接 <video> 播放的容器（mkv 不认，只能当静态图用）
const BROWSER_VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};

function contentTypeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ── Wallpaper Engine 安装目录发现 ────────────────────────────────────────
// 顺序：设置里手填 > 注册表（HKCU\Software\WallpaperEngine\installPath，指向
// wallpaper64.exe）> 常见 Steam 库路径。自动检测结果缓存：目录还在就不再探测。
let cachedWeDir = '';

function commonWeDirs() {
  return [
    'C:\\Program Files (x86)\\Steam', 'D:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam', 'D:\\Program Files\\Steam',
    'C:\\Steam', 'D:\\Steam', 'E:\\Steam'
  ].map((root) => path.join(root, 'steamapps', 'common', 'wallpaper_engine'));
}

function readRegistryInstallPath() {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn('reg', ['query', 'HKCU\\Software\\WallpaperEngine', '/v', 'installPath'], { windowsHide: true });
    } catch { done(''); return; }
    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', () => done(''));
    child.on('close', () => {
      // 输出形如："    installPath    REG_SZ    D:\...\wallpaper_engine\wallpaper64.exe"
      const m = /installPath\s+REG_SZ\s+(.+)/i.exec(out);
      done(m ? m[1].trim().replace(/^"|"$/g, '') : '');
    });
    // reg 偶发卡住时兜底超时；kill 后 close 事件仍会触发，done 保证只结算一次
    setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } done(''); }, 4000);
  });
}

async function resolveWeDir() {
  const custom = String(config()?.wallpaperEngineDir || '').trim();
  if (custom) {
    if (fs.existsSync(custom)) return custom;
    log(`设置里配置的 Wallpaper Engine 目录不存在：${custom}，改用自动检测`);
  }
  if (cachedWeDir && fs.existsSync(cachedWeDir)) return cachedWeDir;
  const regPath = await readRegistryInstallPath();
  if (regPath) {
    // installPath 指向 wallpaper64.exe，上一级就是 wallpaper_engine 根目录
    const dir = path.dirname(regPath);
    if (fs.existsSync(dir)) { cachedWeDir = dir; return dir; }
  }
  for (const dir of commonWeDirs()) {
    if (fs.existsSync(dir)) { cachedWeDir = dir; return dir; }
  }
  return '';
}

// ── 壁纸库扫描 ───────────────────────────────────────────────────────────
// 结果缓存（60 秒 TTL）：列表页反复刷新不重复扫盘；新装的壁纸最多延迟 1 分钟
// 可见（file() 命中失败会立即重扫，选新装壁纸不受 TTL 影响）。
let cache = { at: 0, result: null };

function parseJsonFile(p) {
  try {
    let text = fs.readFileSync(p, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch { return null; }
}

async function scan() {
  const weDir = await resolveWeDir();
  if (!weDir) {
    return {
      ok: false,
      // 2026-10-24：文案跟着界面走。壁纸页已收进「设置 → 外观与数据 → 界面背景」，
      // 而且空状态页上就摆着目录输入框 —— 不再让用户去猜"控制台「壁纸」页"在哪。
      error: '没有找到 Wallpaper Engine。安装目录留空时，会自动按注册表和常见 Steam 路径探测；都没探到，就在下面手动填一次安装根目录（里面有 wallpaper64.exe）。',
      items: []
    };
  }
  // weDir = <Steam库>\steamapps\common\wallpaper_engine → 上两级就是 steamapps
  const steamApps = path.resolve(weDir, '..', '..');
  const roots = [
    { source: 'workshop', dir: path.join(steamApps, 'workshop', 'content', '431960') },
    { source: 'myprojects', dir: path.join(weDir, 'projects', 'myprojects') }
  ];
  const items = [];
  const fileMap = new Map();
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; }   // 没装创意工坊壁纸/myprojects 为空时跳过，不算失败
    for (const name of names) {
      const dir = path.join(root.dir, name);
      const proj = parseJsonFile(path.join(dir, 'project.json'));
      if (!proj || !proj.title && !proj.type && !proj.file) continue;
      const title = String(proj.title || name).trim() || name;
      const type = String(proj.type || '').toLowerCase();
      const previewAbs = proj.preview ? path.join(dir, String(proj.preview)) : '';
      const hasPreview = !!(previewAbs
        && fs.existsSync(previewAbs)
        && IMAGE_EXT.has(path.extname(previewAbs).toLowerCase()));
      const mediaRel = String(proj.file || '').trim();
      const mediaAbs = mediaRel ? path.join(dir, mediaRel) : '';
      const mediaExt = mediaAbs ? path.extname(mediaAbs).toLowerCase() : '';
      const mediaExists = !!(mediaAbs && fs.existsSync(mediaAbs));
      // kind 只有两种：video（返回媒体文件做动态背景）/ still（返回预览图做静态背景）
      const kind = (mediaExists && BROWSER_VIDEO_EXT.has(mediaExt)) ? 'video' : 'still';
      const id = `${root.source === 'workshop' ? 'w' : 'm'}${name}`;
      // GIF 预览冻结为静态首帧：网格缩略图/模糊背板/静态背景从此不再
      // 逐帧 CPU 解码动图（滚动与切页卡顿的主源之一）；失败退回动图原样。
      const effPreview = hasPreview && previewAbs.toLowerCase().endsWith('.gif')
        ? ((await staticPreviewOf(id, previewAbs)) || previewAbs)
        : previewAbs;
      // 登记绝对路径：wallpaper.file 之后只认这张表里的路径
      const entry = {
        dir,
        mediaAbs: kind === 'video' ? mediaAbs : '',
        previewAbs: hasPreview ? effPreview : (kind === 'still' && mediaExists && IMAGE_EXT.has(mediaExt) ? mediaAbs : ''),
        // 动态化导入的源：视频用原视频文件，场景用 project.json 指的主文件（scene.pkg）
        origMediaAbs: mediaExists ? mediaAbs : '',
        scenePkg: mediaExists ? mediaAbs : path.join(dir, 'scene.pkg')
      };
      // 已动态化（导入过且缓存还在）→ 当视频壁纸伺服：media = 无缝循环 mp4
      const dynHash = await dynHashOf(id);
      if (dynHash) {
        const lib = await loadDynLib();
        entry.mediaAbs = lib.cachePathOf(DATA_DIR, dynHash);
        if (!entry.previewAbs) entry.previewAbs = lib.posterPathOf(DATA_DIR, dynHash);   // poster 兜底
        items.push({
          id, title, kind: 'video', type: type || 'unknown', source: root.source,
          playable: true, hasPreview: hasPreview || fs.existsSync(entry.previewAbs), dyn: true
        });
      } else {
        items.push({
          id, title, kind, type: type || 'unknown', source: root.source,
          playable: kind === 'video', hasPreview
        });
      }
      fileMap.set(id, entry);
    }
  }
  items.sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title, 'zh-CN'));
  return { ok: true, weDir, workshopDir: roots[0].dir, count: items.length, items, fileMap };
}

async function ensureScan() {
  const now = Date.now();
  if (cache.result && now - cache.at < 60000) return cache.result;
  const result = await scan();
  cache = { at: now, result };
  return result;
}

async function file({ id, kind = 'media' } = {}) {
  const key = String(id || '').trim();
  // id 一律是本模块自己生成的 "w<工坊目录名>" / "m<myprojects目录名>"
  if (!/^[wm][a-zA-Z0-9._-]{0,120}$/.test(key)) return { ok: false, error: '非法的壁纸 id' };
  let result = await ensureScan();
  let entry = result.fileMap instanceof Map ? result.fileMap.get(key) : null;
  if (!entry) {
    // 缓存窗口内刚装的新壁纸：立即重扫一次再找
    cache = { at: 0, result: null };
    result = await ensureScan();
    entry = result.fileMap instanceof Map ? result.fileMap.get(key) : null;
  }
  if (!entry) return { ok: false, error: '壁纸不存在或已卸载' };
  const field = kind === 'preview' ? 'previewAbs' : 'mediaAbs';
  const p = entry[field];
  if (!p || !fs.existsSync(p)) {
    return { ok: false, error: field === 'previewAbs' ? '该壁纸没有可用的预览图' : '该壁纸没有可播放的媒体文件' };
  }
  return { ok: true, path: p, contentType: contentTypeOf(p) };
}

export const providers = {
  // 控制台「壁纸」页的列表（/api/wallpaper/list 能力中介）
  'wallpaper.library': async () => {
    const r = await ensureScan();
    if (!r.ok) return { ok: false, error: r.error, items: [] };
    // fileMap 是内部登记表，不外泄
    const { fileMap, ...rest } = r;
    return rest;
  },
  // 文件定位（/api/wallpaper/file 能力中介）；只按 id 查登记过的路径
  'wallpaper.file': ({ id, kind } = {}) => file({ id, kind }),
  // 当前壁纸状态读写（/api/wallpaper/state 路由 + wallpaper-chat 技能共用）
  'wallpaper.state.get': () => ({ ok: true, cfg: stateLoad() }),
  'wallpaper.state.set': async ({ cfg } = {}) => {
    const saved = stateSave(cfg);
    return { ok: true, cfg: saved };
  },
  // 动态壁纸导入（场景 → WE 渲染窗录制；视频 → 截段 + 无缝循环）
  'wallpaper.import.start': async ({ id } = {}) => {
    const key = String(id || '').trim();
    if (!/^[wm][a-zA-Z0-9._-]{0,120}$/.test(key)) return { ok: false, error: '非法的壁纸 id' };
    const lib = await loadDynLib();
    const result = await ensureScan();
    const entry = result.fileMap instanceof Map ? result.fileMap.get(key) : null;
    if (!entry) return { ok: false, error: '壁纸不存在或已卸载' };
    // 只有场景和视频值得/能动态化；图片与 web 型直接拒绝
    const t = String(result.items.find((it) => it.id === key)?.type || '').toLowerCase();
    if (t === 'web' || (t !== 'scene' && entry.origMediaAbs && IMAGE_EXT.has(path.extname(entry.origMediaAbs).toLowerCase()))) {
      return { ok: false, error: '这个壁纸是图片/网页类型，没有可动的内容' };
    }
    const source = t === 'scene' ? (fs.existsSync(entry.scenePkg) ? entry.scenePkg : entry.dir) : entry.origMediaAbs;
    if (!source || !fs.existsSync(source)) return { ok: false, error: '找不到可导入的源文件' };
    const weDir = await resolveWeDir();
    const weExe = weDir ? path.join(weDir, 'wallpaper64.exe') : '';
    const r = lib.startImport(
      { kind: t === 'scene' ? 'scene' : 'video', mediaAbs: source, scenePkg: source },
      weExe,
      DATA_DIR
    );
    if (!r.ok) return r;
    // 任务结束后落登记表 + 扫描缓存失效（新列表里它就是动态的了）
    const watch = setInterval(async () => {
      const job = lib.jobOf(r.job);
      if (!job || !job.done) return;
      clearInterval(watch);
      if (job.hash) {
        importsLoad()[key] = { hash: job.hash, at: Date.now() };
        importsSave();
        cache = { at: 0, result: null };
      }
    }, 500);
    watch.unref?.();
    return { ok: true, job: r.job };
  },
  'wallpaper.import.status': async ({ job } = {}) => {
    const lib = await loadDynLib();
    const j = lib.jobOf(String(job || ''));
    if (!j) return { ok: false, error: '没有这个导入任务（可能重启过，重新导入即可——缓存命中是秒级的）' };
    return {
      ok: true, job: j.id, stage: j.stage, detail: j.detail,
      done: j.done, error: j.error, fromCache: !!j.fromCache
    };
  },
  // 重新录制：删掉该壁纸的导入登记与缓存循环（比如录制时窗口被动过、
  // 成品是坏的那些），让下一次导入真正重录而不是秒回缓存命中 ——
  // 这是"只能转一次"现象的解药（坏成品被内容哈希缓存永久命中）。
  'wallpaper.import.redo': async ({ id } = {}) => {
    const key = String(id || '').trim();
    if (!/^[wm][a-zA-Z0-9._-]{0,120}$/.test(key)) return { ok: false, error: '非法的壁纸 id' };
    const lib = await loadDynLib();
    const reg = importsLoad()[key];
    let removed = false;
    if (reg?.hash) {
      try {
        fs.rmSync(path.join(lib.dynRoot(DATA_DIR), reg.hash), { recursive: true, force: true });
        removed = true;
      } catch (e) {
        // Windows 上被占用（这张壁纸正在当视频播）删不掉 —— 前端会先切回
        // 静态图释放句柄再重试，这里如实报错。
        return { ok: false, error: `缓存文件被占用（这张壁纸可能正在播放，前端会先切静态再试）：${e?.message ?? e}` };
      }
    }
    if (reg) {
      delete importsReg[key];
      importsSave();
    }
    cache = { at: 0, result: null };   // 列表立即回到"未动态化"
    log(`重新录制：${key} 的缓存已清除（removed=${removed}）`);
    return { ok: true, removed };
  }
};

export function available() { return { ok: true }; }
