// 动态壁纸导入编排 + 内容寻址 LRU 缓存 + 任务表。
// 移植自 zcode-beautify（MIT，https://github.com/Logocceai/zcode-beautify），
// 按本项目改造：数据落在 <dataDir>/wallpaper-dynamic/，任务表在内存
// （重启丢任务不心疼 —— 缓存命中时重导是秒级的）。
//
// 管线：detect → deps → cache 命中? → [视频] 截中段/交叉淡化 → [场景] 开 WE
// 渲染窗 → ddagrab 录 15s → 关窗 → 无缝循环 → poster → 落盘 → LRU 限额
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkFfmpeg, resolveHwEncoder } from './deps.js';
import { makeSeamless, probeDuration, extractPoster } from './loop.js';
import { openSceneWindow, closeSceneWindow, recordSceneWindow } from './we.js';

export class SceneImportError extends Error {}

export const DEFAULTS = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 15,      // 场景录制秒数（循环 = duration - fade）
  fadeSec: 1,        // 首尾交叉淡化
  maxSeconds: 60,    // 视频壁纸超长截中段
  maxCacheBytes: 10 * 1024 ** 3,
  title: 'QQAgent_WE_Render'
};

export function dynRoot(dataDir) { return path.join(dataDir, 'wallpaper-dynamic'); }
export function cachePathOf(dataDir, hash) { return path.join(dynRoot(dataDir), hash, 'loop.mp4'); }
export function posterPathOf(dataDir, hash) { return path.join(dynRoot(dataDir), hash, 'poster.jpg'); }

export function hasCache(dataDir, hash) {
  try {
    const st = fs.statSync(cachePathOf(dataDir, hash));
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

export function touchCache(dataDir, hash) {
  const file = cachePathOf(dataDir, hash);
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch { /* 条目没了：不用摸 */ }
}

/** LRU 限额：按条目内文件最新 mtime 排序（NTFS 默认不更新 atime），最旧先删。 */
export function enforceLimit(dataDir, maxBytes) {
  const root = dynRoot(dataDir);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const sized = entries.filter((e) => e.isDirectory()).map((e) => {
    const dir = path.join(root, e.name);
    try { return { dir, size: dirSize(dir), lru: lastUseMs(dir) }; }
    catch { return { dir, size: 0, lru: 0 }; }
  });
  let total = sized.reduce((s, e) => s + e.size, 0);
  if (total <= maxBytes) return total;
  sized.sort((a, b) => a.lru - b.lru);
  for (const entry of sized) {
    if (total <= maxBytes) break;
    try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch { continue; }
    total -= entry.size;
  }
  return total;
}

// ── 内容寻址 hash：源内容指纹 + 归一化参数 ────────────────────────────────
// 同一张壁纸换个路径/重新下载仍然命中；内容或参数变了才 miss。
// 目录输入用「相对路径+大小」清单（≤16MB 的文件再叠内容 hash），几百 MB
// 的工坊场景也能秒算。
export function computeHash(inputPath, opts) {
  const md5 = crypto.createHash('md5');
  md5.update(fingerprint(inputPath));
  md5.update(JSON.stringify(normalizeOpts(opts)));
  return md5.digest('hex');
}

function normalizeOpts(opts) {
  const sorted = {};
  for (const key of Object.keys(opts).sort()) sorted[key] = opts[key];
  return sorted;
}

function fingerprint(p) {
  let stat;
  try { stat = fs.statSync(p); } catch { return `missing:${p}`; }
  if (stat.isFile()) {
    return `file:${stat.size}:${crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')}`;
  }
  if (stat.isDirectory()) {
    const manifest = [];
    const walk = (abs, rel) => {
      let items;
      try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        const childAbs = path.join(abs, item.name);
        const childRel = rel ? `${rel}/${item.name}` : item.name;
        if (item.isDirectory()) walk(childAbs, childRel);
        else if (item.isFile()) {
          let size = 0;
          try { size = fs.statSync(childAbs).size; } catch { /* 大小记 0，清单仍稳定 */ }
          if (size <= 16 * 1024 * 1024) {
            let content = '';
            try { content = crypto.createHash('md5').update(fs.readFileSync(childAbs)).digest('hex'); }
            catch { content = 'unreadable'; }
            manifest.push(`${childRel}:${size}:${content}`);
          } else {
            manifest.push(`${childRel}:${size}`);
          }
        }
      }
    };
    walk(p, '');
    manifest.sort();
    return `dir:${manifest.length}:${crypto.createHash('md5').update(manifest.join('\n')).digest('hex')}`;
  }
  return `other:${p}`;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const child = path.join(d, item.name);
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) {
        try { total += fs.statSync(child).size; } catch { /* 中途消失 */ }
      }
    }
  };
  walk(dir);
  return total;
}

function lastUseMs(dir) {
  // 只看条目内的文件：目录自身的 mtime 是创建时间，会盖住 LRU 依赖的回填 mtime
  let newest = 0;
  const consider = (st) => { if (st?.isFile()) newest = Math.max(newest, st.mtimeMs); };
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const item of items) {
    try {
      consider(fs.statSync(path.join(dir, item.name)));
      if (item.isDirectory()) {
        for (const inner of fs.readdirSync(path.join(dir, item.name), { withFileTypes: true })) {
          try { consider(fs.statSync(path.join(dir, item.name, inner.name))); } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }
  return newest;
}

// ── 任务表：一次只允许一个导入在跑（WE 渲染窗全局只有一个）───────────────
const jobs = new Map();
let jobSeq = 0;
let busy = false;

export function jobOf(id) { return jobs.get(String(id)) || null; }

/**
 * 启动导入任务。
 * @param entry  扫描登记表里的条目 { dir, mediaAbs, kind, ... }
 * @param weExe  wallpaper64.exe 绝对路径（场景导入用）
 * @param dataDir 数据目录
 */
export function startImport(entry, weExe, dataDir, opts = {}) {
  if (busy) {
    return { ok: false, error: '已有一个导入任务在跑（渲染窗口是独占的），等它完成再试。' };
  }
  const o = { ...DEFAULTS, ...opts };
  const job = {
    id: `job${++jobSeq}`,
    stage: 'queued',
    detail: '',
    done: false,
    error: '',
    startedAt: Date.now()
  };
  jobs.set(job.id, job);
  busy = true;

  (async () => {
    try {
      const set = (stage, detail = '') => { job.stage = stage; job.detail = String(detail); };
      const isVideo = entry.kind === 'video';

      set('deps', '检查 ffmpeg');
      const ff = await checkFfmpeg();
      if (!ff.ok) {
        // 把原因码带出去：前端据此决定"给一键去安装"还是"只报错"。
        // 只传中文文案的话，UI 只能靠正则猜，改一句措辞就断。
        const e = new SceneImportError(ff.detail);
        e.code = ff.reason === 'missing' ? 'ffmpeg_missing' : 'ffmpeg_outdated';
        throw e;
      }
      // 编码器选择结果进进度条（NVENC/AMF 硬件编码 or CPU 软编码，一目了然）
      set('deps', `ffmpeg 就绪 · 编码器：${(await resolveHwEncoder(ff.path)).label}`);
      if (!isVideo && (!weExe || !fs.existsSync(weExe))) {
        throw new SceneImportError('找不到 Wallpaper Engine（wallpaper64.exe）');
      }

      const source = isVideo ? entry.mediaAbs : entry.scenePkg;
      if (!source || !fs.existsSync(source)) throw new SceneImportError('找不到源文件');

      const hash = computeHash(source, isVideo
        ? { kind: 'video', maxWidth: 1920, maxSeconds: o.maxSeconds, fadeSec: o.fadeSec }
        : { width: o.width, height: o.height, fps: o.fps, duration: o.duration, fadeSec: o.fadeSec });
      const loopPath = cachePathOf(dataDir, hash);
      const posterPath = posterPathOf(dataDir, hash);

      if (hasCache(dataDir, hash)) {
        set('cache-hit', hash);
        touchCache(dataDir, hash);
        enforceLimit(dataDir, o.maxCacheBytes);
        job.hash = hash;
        job.fromCache = true;
        job.done = true;
        return;
      }

      let raw = source;
      if (isVideo) {
        set('analyzing', '测时长');
        const dur = await probeDuration(source, ff.path);
        const trim = dur > o.maxSeconds ? { startAt: (dur - o.maxSeconds) / 2, seconds: o.maxSeconds } : undefined;
        if (trim) set('truncating', `${dur.toFixed(1)}s → ${o.maxSeconds}s（截中段）`);
        set('processing', `交叉淡化 ${o.fadeSec}s`);
        const tmp = `${loopPath}.tmp.mp4`;
        await makeSeamless(source, tmp, o.fadeSec, ff.path, { startAt: trim?.startAt, seconds: trim?.seconds, maxWidth: 1920 });
        set('poster');
        await extractPoster(tmp, posterPath, ff.path);
        set('saving', hash);
        fs.mkdirSync(path.dirname(loopPath), { recursive: true });
        fs.renameSync(tmp, loopPath);
      } else {
        set('opening', `弹渲染窗 ${o.width}x${o.height}`);
        const handle = await openSceneWindow(source, { width: o.width, height: o.height, title: o.title }, weExe);
        try {
          set('render-ready', '等场景稳定');
          await new Promise((r) => setTimeout(r, 3000));
          const rawPath = path.join(path.dirname(loopPath), `raw-${Date.now()}.mp4`);
          fs.mkdirSync(path.dirname(rawPath), { recursive: true });
          try {
            set('recording', `${o.duration}s @ ${o.fps}fps（窗口已置顶，别抢它前台）`);
            await recordSceneWindow(handle, rawPath, { duration: o.duration, fps: o.fps, outWidth: o.width, outHeight: o.height }, ff.path);
          } finally {
            set('closing', '关渲染窗');
            await closeSceneWindow(handle, weExe).catch(() => undefined);
          }
          raw = rawPath;
          set('processing', `无缝循环 ${o.fadeSec}s`);
          const tmp = `${loopPath}.tmp.mp4`;
          await makeSeamless(raw, tmp, o.fadeSec, ff.path);
          set('poster');
          await extractPoster(tmp, posterPath, ff.path);
          set('saving', hash);
          fs.mkdirSync(path.dirname(loopPath), { recursive: true });
          fs.renameSync(tmp, loopPath);
          fs.rmSync(rawPath, { force: true });
        } finally {
          // 上面任何一步抛了，也要保证渲染窗不残留
          await closeSceneWindow(handle, weExe).catch(() => undefined);
        }
      }

      enforceLimit(dataDir, o.maxCacheBytes);
      job.hash = hash;
      job.done = true;
      set('done', loopPath);
    } catch (e) {
      job.error = String(e?.message ?? e);
      // 原因码透传给前端（见上面 ffmpeg_missing 的说明）。
      if (e?.code) job.errorCode = String(e.code);
      job.done = true;
      // 清理半成品 tmp（导入被重启杀掉/ffmpeg 失败都会留下 0 字节残骸，
      // 占着目录还会让人误以为有缓存）。catch 里拿不到本次的 hash/source
      // （可能在赋值前就抛了），直接扫整个缓存根：所有 *.tmp.mp4 和 raw-
      // 前缀都是中间产物，没有任务在写它们（busy 独占，此刻必然没有）。
      try {
        for (const d of fs.readdirSync(dynRoot(dataDir), { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          for (const f of fs.readdirSync(path.join(dynRoot(dataDir), d.name))) {
            if (f.endsWith('.tmp.mp4') || f.startsWith('raw-')) {
              fs.rmSync(path.join(dynRoot(dataDir), d.name, f), { force: true });
            }
          }
        }
      } catch { /* 清不了就算了 */ }
    } finally {
      busy = false;
      // 任务表只留最近 20 条，防长跑内存里堆尸体
      if (jobs.size > 20) {
        for (const k of [...jobs.keys()].slice(0, jobs.size - 20)) jobs.delete(k);
      }
    }
  })();

  return { ok: true, job: job.id };
}
