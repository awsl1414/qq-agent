// 消息来源本地路径的白名单校验（2026-10-16，外部审查 #15）
//
// ── 为什么需要 ──────────────────────────────────────────────────────────
// OneBot 消息段里的 `image.file` / `video.path` 是**协议端转述**的字段，
// 消费侧原来直接 `fs.readFileSync(...)`：
//   · src/tools.js        看图工具"无缓存且无 url"时读 m.file（还专门支持 file:// 解码）
//   · src/video-reader.js #localize 路径 0 直接采用 media.path
// 那等于"消息里写什么路径就读什么文件"——群里一条构造过的消息段就能让机器人
// 读本地任意文件，再经 base64 进模型上下文、由发图能力外发。属纵深防御缺口
// （利用需协议端把攻击者可控内容塞进该字段，常规收图时它是协议端自己的缓存路径）。
//
// ── 口径（与项目里两处现成范式一致）────────────────────────────────────
//   ① app.js 的 plugin-panel 五道闸（path.relative + realpath 二次确认）
//   ② plugins/sticker/lib/manager.js 的 localStickerPath（root 归属校验）
// 具体到本模块是四道：
//   ① 只认**我们自己写下的缓存目录**（image-cache / video-cache）—— 消息里的
//      路径指向别处一律拒绝，调用方按"取不到"降级（url 兜底 / 元信息降级）；
//   ② path.relative 判归属：拒 `..` 逃逸、拒绝对路径改写、拒根目录自身；
//   ③ realpathSync 二次确认：挡符号链接 / 目录联接指向目录外（relative 挡不住）；
//   ④ 文件名必须匹配我们自己的命名规则 —— 防止"同目录内的任意文件"被当参数读。
//
// ⚠️ 取舍（明说）：严格口径下，指向**协议端自己缓存目录**的 file/path 不再被读取。
//    实践中该分支本就很少成功：file 常是裸文件名（readFileSync 按 cwd 解析 → ENOENT），
//    且我们自己写下的缓存由 lookupCachedImage 优先命中、根本走不到这个分支。
//    换来的是"消息不能再指定读哪个文件"。若将来确需放行协议缓存，加一个**可配置**
//    的根目录白名单，不要退回"任意路径"。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** 我们自己的媒体缓存根（按 kind 区分命名规则）。 */
const ROOTS = {
  image: [{ dir: () => path.join(DATA_DIR, 'image-cache'), re: /^[0-9a-z]{1,12}\.(?:png|jpe?g|gif|webp|bmp)$/i }],
  video: [{ dir: () => path.join(DATA_DIR, 'video-cache'), re: /^v_[0-9a-f]{16}\.mp4$/i }]
};

/**
 * 把协议端可能给的各种形态规范成绝对路径：
 *   `file:///C:/a/b.jpg` / `file://host/C:/a/b.jpg` / `C:/a/b.jpg` / `C:\a\b.jpg`
 * 裸文件名（无盘符/无根）返回 null —— 它会被 readFileSync 按进程 cwd 解析，
 * 那是另一条不可控的面，直接拒。
 */
function toAbsolute(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      return null;
    }
    // Windows：URL pathname 形如 `/C:/a/b.jpg`，去掉开头那根斜杠才是真路径
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('/')) return null;
  }
  if (!path.isAbsolute(s)) return null;
  return path.normalize(s);
}

/**
 * 校验一个来自消息段的本地媒体路径。
 * @param {string} raw    消息段里的 file / path 原值
 * @param {object} [opts] { kind: 'image' | 'video' }
 * @returns {{ok:true, path:string} | {ok:false, reason:string}}
 */
export function resolveCachedMediaPath(raw, { kind = 'image' } = {}) {
  const rules = ROOTS[kind] || ROOTS.image;
  const full = toAbsolute(raw);
  if (!full) {
    return { ok: false, reason: '不是可用的本地路径（直链已过期）' };
  }
  for (const rule of rules) {
    const root = rule.dir();
    const rel = path.relative(root, full);
    // 拒：就等于根目录（是目录不是文件）/ 逃出根（..）/ 被规范化成绝对路径
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // realpath 二次确认：既确认存在，又消掉符号链接
    let realRoot = null;
    let realFile = null;
    try {
      realRoot = fs.realpathSync(root);
      realFile = fs.realpathSync(full);
    } catch {
      continue;   // 不存在 → 换下一个根（最终都是"取不到"）
    }
    if (!(realFile === realRoot || realFile.startsWith(realRoot + path.sep))) continue;
    if (!rule.re.test(path.basename(realFile))) {
      return { ok: false, reason: '文件名不符合本地缓存命名规则' };
    }
    try {
      const st = fs.statSync(realFile);
      if (!st.isFile()) return { ok: false, reason: '不是普通文件' };
      if (st.size <= 0) return { ok: false, reason: '文件为空' };
    } catch {
      return { ok: false, reason: '文件不可读' };
    }
    return { ok: true, path: realFile };
  }
  return { ok: false, reason: '不在本地缓存目录内（直链已过期）' };
}

/** 测试用：当前允许的根目录（供断言与排查）。 */
export function mediaCacheRoots() {
  return Object.fromEntries(Object.entries(ROOTS).map(([k, v]) => [k, v.map((r) => r.dir())]));
}
