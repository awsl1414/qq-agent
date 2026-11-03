// 图片入库缓存。
//
// QQ(NTQQ) 的图片下载链接带 rkey 签名，几分钟内就会失效：入库时还是好的，
// 模型过几十秒去调 get_message_images 就已经 HTTP 400
// （{"retcode":-5503007,"retmsg":"download url has expired"}），
// 模型只好回"这张读不出来"。
//
// 所以入库时就地下载（那时 url 是新鲜的），落到 data/image-cache/，看图工具
// 优先读本地缓存，url 只作兜底。下载走后台队列（串行、不阻塞 ingest），
// 失败就放弃，不拿过期 url 反复打 CDN。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { logger } from './logger.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { diskPressure } from './disk-space.js';

const MAX_BYTES = 12 * 1024 * 1024;                 // 单图上限（与 safeFetchBinary 默认一致）
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;         // 缓存留 3 天
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;           // 顺手清理的节流
// 总量闸。TTL 之外的第二道防线：活跃大群 3 天窗口内的入库量只受消息量
// 约束，无字节上限时极端场景可到 GB 级。超限按 ts 最旧优先淘汰。
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const dir = () => path.join(DATA_DIR, 'image-cache');
const indexPath = () => path.join(dir(), 'index.json');

let index = null;            // { [`${chatKey}|${mid}|${i}`]: { file, contentType, bytes, ts } }
let dirty = false;
let lastPrune = 0;
const queue = [];            // 待下载任务（串行）
let pumping = false;

function extOf(contentType) {
  const c = String(contentType || '').toLowerCase();
  if (c.includes('png')) return '.png';
  if (c.includes('gif')) return '.gif';
  if (c.includes('webp')) return '.webp';
  if (c.includes('bmp')) return '.bmp';
  return '.jpg';
}

function loadIndex() {
  if (index) return index;
  try { index = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) || {}; } catch { index = {}; }
  return index;
}

function saveIndex() {
  if (!dirty) return;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${indexPath()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(index, null, 1)}\n`);
    fs.renameSync(tmp, indexPath());
    dirty = false;
  } catch (e) {
    logger.warn('image-cache', `索引写入失败：${e?.message || e}`);
  }
}

function keyOf(chatKey, mid, i) { return `${chatKey}|${mid}|${i}`; }

/** 文件名：key 的散列 + 扩展名（不拿原文当文件名，免得奇形怪状的 mid 造出怪路径）。 */
function fileNameOf(key, contentType) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}${extOf(contentType)}`;
}

function enabled() {
  // 磁盘告急时停止写入：图片缓存是"锦上添花"（本地副本，没有它只是多看一次
  // 过期直链），而写一半的图片文件会污染缓存目录。真缺空间时应该把写入让给
  // 会话存档这类不可再生的数据。
  if (diskPressure() === 'critical') return false;
  return getConfig().imageCache?.enabled !== false;
}

/** 下载一张图并落盘（成功则登记进索引）。失败静默放弃，过期 url 重试没有意义。 */
async function downloadOne(task) {
  const { key, url } = task;
  try {
    const safeUrl = await validateImageUrl(url);
    const { buffer, contentType } = await safeFetchBinary(safeUrl);
    if (!buffer || !buffer.length) throw new Error('图片内容为空');
    if (buffer.length > MAX_BYTES) throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，不入缓存`);
    const idx = loadIndex();
    const file = fileNameOf(key, contentType);
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), file), buffer);
    idx[key] = { file, contentType: String(contentType || 'image/jpeg').split(';')[0], bytes: buffer.length, ts: Date.now() };
    dirty = true;
    saveIndex();
    logger.info('image-cache', `已缓存 ${key}（${(buffer.length / 1024).toFixed(0)}KB）`);
  } catch (e) {
    // 静默：最常见的失败就是"链接已过期"，重试无意义；看图工具会走 url 兜底再失败一次，
    // 那时的错误信息（download url has expired）就足够诊断了。
    logger.warn('image-cache', `入库缓存失败 ${key}：${String(e?.message || e).slice(0, 100)}`);
  }
}

function pump() {
  if (pumping) return;
  pumping = true;
  (async () => {
    while (queue.length) {
      const task = queue.shift();
      await downloadOne(task);
    }
    pumping = false;
  })().catch(() => { pumping = false; });
}

function prune() {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  const idx = loadIndex();
  let removed = 0;
  for (const [k, v] of Object.entries(idx)) {
    if (now - Number(v.ts || 0) > MAX_AGE_MS) {
      try { fs.unlinkSync(path.join(dir(), v.file)); } catch { /* 已经不在了 */ }
      delete idx[k];
      removed += 1;
    }
  }
  // 总量闸（见 MAX_TOTAL_BYTES 注释）。TTL 删完仍超限就按最旧淘汰。
  let total = Object.values(idx).reduce((n, v) => n + (Number(v.bytes) || 0), 0);
  if (total > MAX_TOTAL_BYTES) {
    const byAge = Object.entries(idx).sort((a, b) => Number(a[1].ts || 0) - Number(b[1].ts || 0));
    for (const [k, v] of byAge) {
      if (total <= MAX_TOTAL_BYTES) break;
      try { fs.unlinkSync(path.join(dir(), v.file)); } catch { /* 已经不在了 */ }
      delete idx[k];
      total -= Number(v.bytes) || 0;
      removed += 1;
    }
    if (removed) logger.info('image-cache', `缓存超过总量上限，已淘汰最旧的 ${removed} 张`);
  }
  if (removed) { dirty = true; saveIndex(); logger.info('image-cache', `清理过期缓存 ${removed} 张`); }
}

/**
 * 入库时调用：把这条消息里的图片排队下载（**不阻塞** ingest，后台串行）。
 * @param {string} chatKey
 * @param {number|string} mid  消息 id（工具调用时用它来查缓存）
 * @param {Array<{kind:string,url:string}>} media
 */
export function cacheIncomingImages(chatKey, mid, media) {
  if (!enabled() || !Array.isArray(media)) return;
  const id = String(mid ?? '');
  if (!chatKey || !id) return;
  let queued = 0;
  (media || []).forEach((m, i) => {
    if (!m || m.kind !== 'image' || !m.url) return;
    const key = keyOf(chatKey, id, i);
    const idx = loadIndex();
    if (idx[key]) return;                        // 已缓存过（转发展开等重复入档）
    queue.push({ key, url: String(m.url) });
    queued += 1;
  });
  if (queued) {
    pump();
    prune();                                     // 内部有节流，不会每次都真清
  }
}

/**
 * 看图工具用：取本地缓存的图片。没有（或文件已被清掉）返回 null，走 url 兜底。
 * @returns {{ buffer: Buffer, contentType: string } | null}
 */
export function lookupCachedImage(chatKey, mid, index_) {
  const key = keyOf(chatKey, String(mid ?? ''), Number(index_) || 0);
  const idx = loadIndex();
  const v = idx[key];
  if (!v) return null;
  try {
    const buffer = fs.readFileSync(path.join(dir(), v.file));
    return { buffer, contentType: v.contentType || 'image/jpeg' };
  } catch {
    delete idx[key];                             // 文件没了（被手动清掉/盘异常）：顺手摘掉索引
    dirty = true;
    saveIndex();
    return null;
  }
}

/** 测试/运维用：当前缓存张数与占用的字节。 */
export function cacheStats() {
  const idx = loadIndex();
  let bytes = 0;
  for (const v of Object.values(idx)) bytes += Number(v.bytes || 0);
  return { count: Object.keys(idx).length, bytes };
}

/** 测试用：清空索引与文件（不影响其它数据）。 */
export function __resetForTest() {
  try { fs.rmSync(dir(), { recursive: true, force: true }); } catch { /* ignore */ }
  index = null;
  dirty = false;
}
