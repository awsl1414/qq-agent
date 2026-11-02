// 主题壁纸跟随小红车（内置模块 src/wallpaper/theme.js —— 2026-10-23 由「壁纸套件
// 交接包」内置化，原 plugins/wallpaper-theme 插件）。
//
// 要解决的问题：界面（控制台窗口）的主题背景想用 Wallpaper Engine（小红车）里那张壁纸，
// 而且换壁纸之后要自己跟着换。
//
// 为什么做成内置模块而不是技能：
//   这件事是"满足条件就一定该发生"的 —— 每次开机都该把当前壁纸同步成背景，
//   不需要模型判断要不要做。技能（skills/）是让模型决定调不调，这里不合适。
//
// 它做的三件事（都很轻）：
//   1. 读 WE 自己的 config.json，拿到"现在用的是哪张壁纸"（和 wallpaper-engine 技能同一口径）
//   2. 把那张壁纸的预览图复制进 <数据目录>/ui/ —— /api/ui-bg 只认这个目录 + config.ui.bgImage 里的文件名
//   3. 写 config.ui.bgImage / bgFit / bgSoften
//
// 为什么是"复制预览图"而不是直接引用原文件：
//   /api/ui-bg 的实现刻意只接受「data/ui 下的裸文件名」，不接受路径参数（防目录穿越）。
//   想用壁纸原文件就得改核心路由，而核心每次升级都会被覆盖 —— 复制一份到 data/ui
//   是最不侵入的做法，也让"壁纸被取消订阅"后背景不会突然变白。
//
// 分辨率说明（重要）：
//   工坊壁纸的 preview 是缩略图，一部分只有 160×160（尤其视频壁纸）。直接拉满 1360 宽的
//   窗口会糊成色块。所以这里量一下宽度：<720px 就告诉前端"这张需要柔化"（bgSoften），
//   前端用 canvas 一次性做高斯模糊 —— 结果是一张柔和的氛围底图，比硬拉伸体面得多。
//
// 不抢用户的图：
//   只要 config.ui.bgImage 不是我们自己写的 bg-we-*（也就是用户手动选过图），
//   本模块就什么都不做；用户把背景清掉（变成空）之后才重新接管。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getConfig, updateConfig, DATA_DIR } from '../config.js';

const APPID = '431960';
const BG_PREFIX = 'bg-we-';
const EXE_NAMES = ['wallpaper64.exe', 'wallpaper32.exe'];
const DEFAULT_SETTINGS = { follow: true, allowMature: false, intervalSec: 8, softenSmall: true };

let cfg = () => DEFAULT_SETTINGS;
let timer = null;
let lastError = '';

// ── 小工具 ─────────────────────────────────────────────────────────────────

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function normWin(p) { return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, ''); }

// 日志走宿主注入的 api.log（= logger，落 data/logs 且做脱敏），没有时退回 console。
// 内置化改造：插件期的 console.log 只进 stdout，data/logs/*.log 里一行都看不到。
let logger = null;
function log(...args) {
  // 只在"状态变了"时打日志（见 syncOnce）：每 8 秒一行会把日志淹掉
  try {
    if (logger) logger('[wallpaper-theme]', ...args);
    else console.log('[wallpaper-theme]', ...args);
  } catch { /* ignore */ }
}

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

// ── 找 Wallpaper Engine ────────────────────────────────────────────────────

let _weCache = null;

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

function libraryFolders(steamRoot) {
  const out = [];
  for (const rel of ['steamapps\\libraryfolders.vdf', 'config\\libraryfolders.vdf']) {
    const file = path.join(steamRoot, rel);
    if (!fileExists(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const push = (raw) => {
      const p = normWin(String(raw ?? '').replace(/\\\\/g, '\\'));
      if (/^[A-Za-z]:\\/.test(p) && !out.includes(p)) out.push(p);
    };
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/gi)) push(m[1]);
    for (const m of text.matchAll(/"\d+"\s*"([A-Za-z]:[^"]*)"/g)) push(m[1]);
  }
  return out;
}

/** 找到 wallpaper64.exe 与它的安装目录（结果缓存 60 秒，磁盘变动不需要秒级感知）。 */
function detectWe({ force = false } = {}) {
  if (!force && _weCache && Date.now() - _weCache.at < 60_000) return _weCache.value;

  const roots = new Set();
  const reg = regSteamPath();
  if (reg) roots.add(reg);
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    for (const sub of ['\\Steam', '\\SteamLibrary']) {
      const p = `${d}:${sub}`;
      if (dirExists(p)) roots.add(p);
    }
  }
  const libs = new Set(roots);
  for (const r of roots) for (const l of libraryFolders(r)) libs.add(l);

  let exe = '';
  for (const lib of libs) {
    for (const name of EXE_NAMES) {
      const c = path.join(lib, 'steamapps', 'common', 'wallpaper_engine', name);
      if (fileExists(c)) { exe = c; break; }
    }
    if (exe) break;
  }

  const value = {
    ok: Boolean(exe),
    exe,
    installDir: exe ? path.dirname(exe) : '',
    error: exe ? '' : '没找到 wallpaper64.exe'
  };
  _weCache = { at: Date.now(), value };
  return value;
}

// ── 当前壁纸 ───────────────────────────────────────────────────────────────

/** 读 WE 的 config.json：按 Windows 用户名分区，同机取当前用户那一段。 */
function readWeConfig(installDir) {
  const file = path.join(installDir, 'config.json');
  return readJson(file);
}

/**
 * 当前壁纸的元信息。
 * @returns {null | {title, type, dir, previewFile, rating, workshopId, width}}
 */
function currentWallpaper(we) {
  const cfgFile = readWeConfig(we.installDir);
  const sections = Object.keys(cfgFile).filter((k) => !k.startsWith('?') && cfgFile[k] && typeof cfgFile[k] === 'object');
  if (!sections.length) return null;

  const me = String(os.userInfo?.().username || '').toLowerCase();
  const pick = sections.find((s) => s.toLowerCase() === me)
    || sections.find((s) => cfgFile[s]?.general?.wallpaperconfig?.selectedwallpapers)
    || sections[0];

  const selected = cfgFile[pick]?.general?.wallpaperconfig?.selectedwallpapers || {};
  const first = Object.values(selected).find((v) => v && v.file);
  if (!first) return null;

  const dir = path.dirname(normWin(first.file));
  const projectFile = path.join(dir, 'project.json');
  if (!fileExists(projectFile)) return null;

  let meta = {};
  try { meta = readJson(projectFile); } catch { /* 写坏的 project.json 也不该让插件崩 */ }

  const declared = String(meta.preview || '').trim();
  const previewFile = [declared, 'preview.gif', 'preview.jpg', 'preview.png', 'preview.webp']
    .filter(Boolean)
    .map((n) => path.join(dir, n))
    .find((p) => fileExists(p)) || '';

  return {
    title: String(meta.title || path.basename(dir)),
    type: String(meta.type || '').toLowerCase(),
    dir,
    previewFile,
    rating: String(meta.contentrating || ''),
    workshopId: String(meta.workshopid || ''),
    width: previewFile ? imageWidth(previewFile) : 0
  };
}

/** 只读文件头拿宽度（gif/png/jpeg），够用且零依赖。 */
function imageWidth(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, n);
  } catch { return 0; }

  try {
    if (buf.slice(0, 3).toString('ascii') === 'GIF') return buf.readUInt16LE(6);
    if (buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return buf.readUInt16BE(i + 7);
        }
        i += 2 + len;
      }
    }
  } catch { /* 头部异常就当量不到 */ }
  return 0;
}

/** 成人向判断：空值/Everyone 算安全，Questionable/Mature 算不安全。 */
function isSafeRating(rating) {
  const r = String(rating || '').toLowerCase();
  return !r || r === 'everyone' || r === 'none' || r === 'safe';
}

// ── 同步 ───────────────────────────────────────────────────────────────────

function uiDir() {
  return path.join(DATA_DIR, 'ui');
}

/** 把壁纸预览复制进 data/ui/，返回 {name, soften}。文件名带内容指纹，天然缓存失效。 */
function copyPreview(entry, { softenSmall }) {
  if (!entry.previewFile) return null;
  let stat;
  try { stat = fs.statSync(entry.previewFile); } catch { return null; }
  const ext = path.extname(entry.previewFile).toLowerCase() || '.jpg';
  const key = crypto.createHash('md5')
    .update(`${entry.previewFile}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 12);
  const name = `${BG_PREFIX}${key}${ext}`;
  const dest = path.join(uiDir(), name);

  // 宽度不足 720 的预览直接拉满会糊成色块 → 让前端柔化（见 00-core.js 的 bgSoften 兜底实现）
  const soften = softenSmall && entry.width > 0 && entry.width < 720 ? 28 : 0;

  if (!fileExists(dest)) {
    fs.mkdirSync(uiDir(), { recursive: true });
    fs.copyFileSync(entry.previewFile, dest);
  }
  return { name, soften };
}

/** 清掉自己以前留下的图（用户手动选的图绝不动）。 */
function cleanup(currentName) {
  let files = [];
  try { files = fs.readdirSync(uiDir()); } catch { return; }
  for (const f of files) {
    if (!f.startsWith(BG_PREFIX) || f === currentName) continue;
    try { fs.rmSync(path.join(uiDir(), f), { force: true }); } catch { /* 占用中也无所谓 */ }
  }
}

/**
 * 同步一次。幂等：状态没变就什么都不做（不写盘、不打日志）。
 * @param {{force?: boolean}} options force=true 时忽略"用户自己选过图"的保护
 * @returns {{ok: boolean, skipped?: string, changed?: boolean, entry?: object, error?: string}}
 */
export async function syncOnce({ force = false } = {}) {
  const conf = { ...DEFAULT_SETTINGS, ...(cfg() || {}) };
  if (!conf.follow && !force) return { ok: false, skipped: 'follow-off' };

  const we = detectWe();
  if (!we.ok) return { ok: false, skipped: 'no-we', error: we.error };

  let entry;
  try {
    entry = currentWallpaper(we);
  } catch (error) {
    return { ok: false, skipped: 'read-failed', error: String(error?.message ?? error) };
  }
  if (!entry) return { ok: false, skipped: 'no-wallpaper' };
  if (!entry.previewFile) return { ok: false, skipped: 'no-preview' };
  if (!conf.allowMature && !isSafeRating(entry.rating)) return { ok: false, skipped: 'mature' };

  const ui = getConfig().ui || {};
  const mine = String(ui.bgImage || '').startsWith(BG_PREFIX);
  if (!force && ui.bgImage && !mine) return { ok: false, skipped: 'user-image' };

  const copied = copyPreview(entry, { softenSmall: conf.softenSmall !== false });
  if (!copied) return { ok: false, skipped: 'copy-failed' };

  const patch = {
    ui: {
      bgImage: copied.name,
      bgFit: 'cover',
      bgSoften: copied.soften,
      bgSrc: 'we'
    }
  };
  // 第一次接管时如果底色还完全不透明，背景图等于白设 —— 顺手调到 62%，
  // 让图透出来。只做这一次，之后用户怎么调都尊重（不再覆盖）。
  if (!ui.bgImage) {
    const alpha = Number(ui.frameAlpha ?? 100);
    if (!Number.isFinite(alpha) || alpha >= 100) patch.ui.frameAlpha = 62;
  }

  const changed = ui.bgImage !== copied.name || Number(ui.bgSoften || 0) !== copied.soften || patch.ui.frameAlpha !== undefined;
  if (!changed) return { ok: true, entry, changed: false };

  updateConfig(patch);
  cleanup(copied.name);
  log(`主题背景 → 《${entry.title}》 (${entry.width || '?'}px${copied.soften ? '，柔化' : ''})`);
  lastError = '';
  return { ok: true, entry, changed: true, file: copied.name, soften: copied.soften };
}

// ── 生命周期 ───────────────────────────────────────────────────────────────

function scheduleNext() {
  const conf = { ...DEFAULT_SETTINGS, ...(cfg() || {}) };
  const sec = Math.min(120, Math.max(5, Number(conf.intervalSec) || 8));
  timer = setTimeout(async () => {
    timer = null;
    try { await syncOnce(); } catch (error) { lastError = String(error?.message ?? error); }
    scheduleNext();
  }, sec * 1000);
  timer.unref?.();   // 不因为一个定时器把进程钉住（退出时不用等它）
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

export function setup(api) {
  if (api && typeof api.config === 'function') cfg = api.config;
  if (api && typeof api.log === 'function') logger = api.log;
}

export async function activate() {
  stop();
  // 启动后 3 秒再干活：避开开屏高峰（技能加载/价格表/遥测都挤在前几秒）
  timer = setTimeout(async () => {
    timer = null;
    try { await syncOnce(); } catch (error) { lastError = String(error?.message ?? error); }
    scheduleNext();
  }, 3000);
  timer.unref?.();
}

export function deactivate() {
  stop();
}

export function dispose() {
  stop();
}

/** 别的模块（技能）想主动同步一次时用它。 */
export const providers = {
  'wallpaper.theme-sync': async ({ force = true } = {}) => {
    try {
      const r = await syncOnce({ force });
      if (r.ok) {
        return {
          ok: true,
          changed: Boolean(r.changed),
          title: r.entry?.title || '',
          skipped: r.skipped || '',
          error: ''
        };
      }
      return { ok: false, skipped: r.skipped || '', error: r.error || '', title: '' };
    } catch (error) {
      return { ok: false, skipped: 'error', error: String(error?.message ?? error), title: '' };
    }
  }
};

/** 供自检/排障读取（不对外暴露成能力）。 */
export const internals = { detectWe, currentWallpaper, imageWidth, lastErrorOf: () => lastError };
