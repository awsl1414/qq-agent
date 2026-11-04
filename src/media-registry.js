// 会话「已发送」里本地图片的受控地址登记 / 解析。
//
// 背景：控制台要显示"这条消息实际发了什么图"，但本地图（随机图、AI 绘图、表情包）
// 在协议端只能拿到宿主绝对路径，浏览器既读不到 file://，也绝不能拿到任意路径。
// 所以由服务端签发一个**带 keyed 摘要的受限地址**：
//
//   /api/sessions/<id>/image/<payload>.<sig>
//     payload = base64url({ k: kind, p: 相对根目录的路径 })
//     sig     = HMAC-SHA256(secret, "<sessionId>|<kind>|<相对路径>")
//
// 设计取舍：
//   · token 里只放**相对**路径，绝对路径（以及宿主目录名）不出现在 URL、HTTP 响应
//     或 SSE 载荷里；渲染端拿到的永远只是一个同源地址。
//   · 摘要绑定 sessionId：A 会话的地址在 B 会话下验签必然失败，不存在"换个会话号
//     就能读别人的图"。
//   · secret 落数据目录：会话是持久化的，重启后旧缩略图仍然能显示；服务端不用维护
//     内存表，也不用为历史图片额外存一份索引。
//   · kind 决定白名单根目录。取图时按 kind 取根、再用 path.relative() 复核不逃逸，
//     根之外的任何路径（../../、绝对路径、同前缀目录）一律拒绝。
//
// 三个来源的根目录以各自实现为准（改路径时同步这里）：
//   setu     skills/random-image/config.js 的 TMP_DIR
//   generate skills/image-generate/index.js 的 saveLocal()
//   sticker  plugins/sticker/lib/manager.js 的 stickerImagesDir()
//            （plugin-data/sticker/img 是面板缩略图副本，同样纳入白名单）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { detectMime } from './image-type.js';

/** 取图端点允许的单文件上限，与 /api/media-data 同口径。 */
const LOCAL_IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const SECRET_FILE = path.join(DATA_DIR, 'media-secret');
const SECRET_BYTES = 32;
const HMAC_BYTES = 16;
/** 地址前缀：前端据此判定"同源受控地址"，也是路由的唯一来源。 */
const LOCAL_IMAGE_SRC_PREFIX = '/api/sessions/';
/** 已知来源。不在集合里的 kind 不参与签名，也不参与取图。 */
const LOCAL_IMAGE_KINDS = Object.freeze(['setu', 'generate', 'sticker']);

let cachedSecret = null;

function secret() {
  if (cachedSecret) return cachedSecret;
  try {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      cachedSecret = Buffer.from(existing, 'hex');
      return cachedSecret;
    }
  } catch { /* 文件不存在：下面生成 */ }
  try {
    const fresh = crypto.randomBytes(SECRET_BYTES);
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, fresh.toString('hex'), { mode: 0o600 });
    cachedSecret = fresh;
    return cachedSecret;
  } catch {
    // 写不了数据目录时不签发地址（缩略图降级为文字徽标），不影响发送本身
    return null;
  }
}

/** 某个 kind 允许的根目录（真实路径在调用处再解析，便于测试重定向数据目录）。 */
function rootsOf(kind) {
  switch (kind) {
    case 'setu':
      return [path.join(DATA_DIR, 'setu-tmp')];
    case 'generate':
      return [path.join(os.tmpdir(), 'qq-agent-image-generate')];
    case 'sticker':
      return [
        path.join(DATA_DIR, 'sticker-images'),
        path.join(DATA_DIR, 'plugin-data', 'sticker', 'img')
      ];
    default:
      return [];
  }
}

/** 目标是否严格位于 root 之内（root 自身不算）。 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 把绝对路径解析成 { rootIndex, root, rel }；不合法（越界 / 不存在 / 符号链接逃逸）返回 null。
 * rootIndex 进 token：同一 kind 可能有多个白名单根（表情包就是这样），
 * 只存相对路径的话取图时会按第一个根去解析，另一处的图永远读不到。
 */
function locate(kind, filePath) {
  let real;
  try { real = fs.realpathSync(String(filePath ?? '')); } catch { return null; }
  const roots = rootsOf(kind);
  for (let i = 0; i < roots.length; i += 1) {
    let root;
    try { root = fs.realpathSync(roots[i]); } catch { continue; }
    if (!isInside(root, real)) continue;
    return { rootIndex: i, root, rel: path.relative(root, real) };
  }
  return null;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(sessionId, kind, rootIndex, rel) {
  const key = secret();
  if (!key) return null;
  return crypto.createHmac('sha256', key)
    .update(`${sessionId}|${kind}|${rootIndex}|${rel}`)
    .digest('hex')
    .slice(0, HMAC_BYTES * 2);
}

/**
 * 登记一张已落在白名单根目录内的本地图片，返回前端可直接放进 <img src> 的同源地址。
 *
 * 调用方（内置工具与扩展）只负责给自己的绝对路径，**不要自己拼 URL**：
 * 路径校验、相对化、签名都在这里，改地址格式时只有一处要动。
 *
 * @param {string} sessionId 会话 id（参与签名，用于绑定会话）
 * @param {{kind: string, path: string}} input 来源与图片绝对路径
 * @returns {string|null}    受控地址；路径不合规 / 文件不存在时返回 null（降级为无图）
 */
export function registerLocalImage(sessionId, input = {}) {
  const id = String(sessionId ?? '').trim();
  const kind = String(input?.kind ?? '');
  if (!id || !LOCAL_IMAGE_KINDS.includes(kind)) return null;
  const found = locate(kind, input?.path);
  if (!found) return null;
  // 空文件（写入中断留下的残骸）不签发地址：它必然取不出图，界面应直接显示文字徽标
  try {
    const st = fs.statSync(path.join(found.root, found.rel));
    if (!st.isFile() || st.size <= 0) return null;
  } catch { return null; }
  const sig = sign(id, kind, found.rootIndex, found.rel);
  if (!sig) return null;
  const payload = b64url(JSON.stringify({ k: kind, r: found.rootIndex, p: found.rel }));
  return `${LOCAL_IMAGE_SRC_PREFIX}${encodeURIComponent(id)}/image/${payload}.${sig}`;
}

/** 本模块签发地址的严格形状：会话号 + payload.base64url + 32 位 hex 摘要。 */
const LOCAL_IMAGE_SRC_RE = /^\/api\/sessions\/[\w-]+\/image\/[A-Za-z0-9_-]+\.[0-9a-f]{32}$/;

/**
 * 对外输出 `sent[].src` 的唯一校验处。
 *
 * 只放行两种形态：绝对 http(s) 直链，或本模块签发的同源受控地址。
 * 其它任何字符串（宿主绝对路径、file://、data:、javascript:）一律变成 null ——
 * 这既是"内网/宿主路径不得外泄"的保证，也挡住把协议塞进 <img src> 的注入面。
 *
 * @param {unknown} raw sent 条目里的原始 src
 * @returns {string|null}
 */
export function publicSentSrc(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try { return new URL(value).href; } catch { return null; }
  }
  return LOCAL_IMAGE_SRC_RE.test(value) ? value : null;
}

/**
 * 解析并读取一张受控本地图片。
 *
 * 失败一律返回 null（调用方统一回 404），不区分"签名错 / 越界 / 不是图片"，
 * 避免把宿主路径或校验细节回显给客户端。
 *
 * @param {string} sessionId 路由里的会话 id
 * @param {string} token     地址最后一段（<payload>.<sig>）
 * @returns {{ buffer: Buffer, mime: string } | null}
 */
export function readLocalImage(sessionId, token) {
  const id = String(sessionId ?? '').trim();
  const raw = String(token ?? '');
  if (!/^[\w-]+$/.test(id) || !raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadPart = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // payloadPart 是登记时 JSON 的 base64url；"{" 必在首字节，用它做廉价的前置过滤，
  // 避免把任意垃圾串都送进 JSON.parse。
  let payload;
  try {
    const bytes = Buffer.from(payloadPart, 'base64url');
    if (bytes[0] !== 0x7b) return null;
    payload = JSON.parse(bytes.toString('utf8'));
  } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const kind = String(payload.k ?? '');
  const rel = String(payload.p ?? '');
  const rootIndex = Number(payload.r);
  if (!LOCAL_IMAGE_KINDS.includes(kind) || !rel || rel.includes('\0')) return null;
  if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= rootsOf(kind).length) return null;
  // 相对路径必须真的相对：绝对路径、盘符、反斜杠、任意 .. 段都拒绝
  if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').includes('..')) return null;

  const expected = sign(id, kind, rootIndex, rel);
  if (!expected) return null;
  // 长度先比，再定长比较：timingSafeEqual 长度不等会抛
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const file = path.resolve(rootsOf(kind)[rootIndex], rel);
  const found = locate(kind, file);
  if (!found || found.rootIndex !== rootIndex || found.rel !== rel) return null;

  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size <= 0 || stat.size > LOCAL_IMAGE_MAX_BYTES) return null;

  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return null; }
  const mime = detectMime(buffer);
  if (!mime) return null;
  return { buffer, mime };
}
