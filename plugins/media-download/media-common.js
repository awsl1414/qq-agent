// 媒体插件公共小件——bili.js 与 douyin.js 的重复家族收口（第 3 个媒体插件出现前的防屎山措施）。
// 只收"零业务语义"的小件；各平台的接口协议/打分/报错文案仍留在 bili.js / douyin.js。
// 插件契约不变：bili.js / douyin.js 继续以同名导出转发这些函数。
import fs from 'node:fs';
import path from 'node:path';
import { safeFetchBinaryToFile } from '../../src/safe-fetch.js';

/**
 * 解析插件参数值。
 * configDefaults 用类型化声明（{type,label,default,...}）时，
 * 用户**未保存过**配置的话 params 里放的还是整个声明对象。
 * 这里把声明对象解包成 default；已保存过配置时拿到的就是 UI 写好的真值，原样返回。
 *
 * 没有这个，`Number({type:'number',default:60})` 会得到 NaN —— 时长/字节上限会静默失效。
 */
export function resolveParam(params, key, fallback) {
  const v = params?.[key];
  if (v && typeof v === 'object' && !Array.isArray(v) && 'default' in v) return v.default;
  return (v === undefined || v === null || v === '') ? fallback : v;
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 文件名安全化：去 Windows 非法字符与控制字符、折叠空白、截断、空值兜底。 */
export function safeName(name, maxLen = 80) {
  return String(name || 'video')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'video';
}

/** 清理目录里超过 maxAgeMs 的旧文件（best-effort，任何异常吞掉）。skipNames 用于保留状态文件。 */
export function cleanupDir(dir, maxAgeMs, { skipNames = [] } = {}) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const skip = new Set(skipNames);
    for (const f of fs.readdirSync(dir)) {
      if (skip.has(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不存在等，忽略 */ }
}

/**
 * 失败通知器工厂：把下载错误压成一句人话（briefFailure 由各平台提供自己的文案映射），
 * 同原因 10 分钟内只发一条（防刷屏），通知失败不影响主流程。
 */
export function createFailureNotifier(briefFailure) {
  const notifiedKey = new Map();
  return async function notifyFailure({ sender, chatKey }, e) {
    const key = String(e?.message ?? e ?? '?').slice(0, 80);
    const last = notifiedKey.get(key);
    if (last && Date.now() - last < 10 * 60 * 1000) return;
    // 先淘汰最旧再写入：之前先 set 后 clear，把刚记录的键也一起清掉，
    // 同一错误在 10 分钟窗口内可能再次通知（防刷屏失效）
    if (notifiedKey.size >= 50) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [k, at] of notifiedKey) { if (at < oldestAt) { oldestAt = at; oldestKey = k; } }
      if (oldestKey) notifiedKey.delete(oldestKey);
    }
    notifiedKey.set(key, Date.now());
    try { await sender?.sendTextBatch(chatKey, [briefFailure(e)]); } catch { /* 通知失败忽略 */ }
  };
}

/**
 * 把 OneBot 的 `get_msg` 结果摊平成一段可正则搜索的文本。
 *
 * ⚠️ 2026-10-21：bili.js 与 douyin.js 一直在调 `flattenMessageToText()`，
 *    但这个函数全仓从来没有定义过、也没 import 过 —— 只要模型走
 *    `messageId` 这条路（正是这两个工具**首推**的用法），第一行就抛
 *    `ReferenceError: flattenMessageToText is not defined`，BV 号 / aweme id
 *    永远解析不出来。两处调用点的注释写着"收口在 onebot.js"，实际并没有落下来。
 *    现在收在 media-common.js（bili/douyin 本来就都 import 它），
 *    不从 onebot.js 走是为了避免把 skills/manager.js 那串重依赖拉进插件。
 *
 * 为什么要摊平而不是直接读 raw_message：
 *   QQ 的「B站/抖音分享」是 json / markdown / 未知类型的卡片段，链接藏在
 *   seg.data 里，raw_message 里往往只有 `[CQ:json,data=...]` 这种转义过的壳。
 *
 * 为什么必须先"解一层"再 stringify：
 *   json 段的 `seg.data.data` 是**字符串套 JSON**（里面还有 `\/`、`\"` 转义）。
 *   直接 JSON.stringify(seg.data) 会把这些转义再转义一遍，结果文本里出现
 *   `https:\\/\\/v.douyin.com\\/xxx\\` 这种形态 —— 提取器捞出来的 URL 尾部
 *   会多一个反斜杠，请求直接失败。正确做法是遇到"字符串里装 JSON"就先
 *   JSON.parse 出来（转义在这一步被消化掉），再对解析结果 stringify。
 *
 * @param {object|string} msg get_msg 的返回值，或任意消息形态
 * @returns {string} 可正则搜索的文本；拿不到内容时返回空串（调用方自己决定怎么报错）
 */
export function flattenMessageToText(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return unescapeCqPayload(msg);

  const parts = [];
  const seen = new Set();
  const push = (v) => {
    if (v == null || v === '') return;
    const clean = decodeJsonInString(v);
    let s;
    if (typeof clean === 'string') s = clean;
    else {
      try { s = JSON.stringify(clean); } catch { s = String(clean); }
    }
    if (!s || seen.has(s)) return;   // 纯文本消息的 raw_message 与 text 段内容相同，别让诊断日志重复两遍
    seen.add(s);
    parts.push(s);
  };

  // ① SnowLuma 风格的纯文本字段
  if (typeof msg.message_content === 'string') push(msg.message_content);

  // ② 段数组：text 段取明文，其余段（json/markdown/image/未知）整个 data 都塞进去
  if (Array.isArray(msg.message)) {
    for (const seg of msg.message) {
      if (!seg || typeof seg !== 'object') { push(seg); continue; }
      if (seg.type === 'text' && seg.data && typeof seg.data.text === 'string') push(seg.data.text);
      else push(seg.data ?? seg);
    }
  } else {
    // ③ 字符串形态（部分协议端直接给 CQ 码字符串）
    push(msg.message);
  }

  // ④ raw_message 兜底：前面什么都没捞到时它至少还有一份原文
  if (typeof msg.raw_message === 'string') push(msg.raw_message);

  return unescapeCqPayload(parts.join('\n'));
}

/**
 * 递归把"字符串里装 JSON"的那一层解开。
 * 只解字符串形态的嵌套（`'{"url":"https:\/\/x"}'`），对象/数组原样保留结构。
 * depth 限制防病态自嵌套把栈打爆。
 */
function decodeJsonInString(v, depth = 0) {
  if (typeof v === 'string') {
    if (depth >= 4) return v;
    const s = v.trim();
    // 只对"看起来是 JSON 容器"的字符串尝试解析；普通文本（含 [CQ:...]）解析失败就原样返回
    if (s.length > 1 && (s[0] === '{' || s[0] === '[')) {
      try { return decodeJsonInString(JSON.parse(s), depth + 1); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return depth >= 4 ? v : v.map((x) => decodeJsonInString(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth >= 4) return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = decodeJsonInString(val, depth + 1);
    return out;
  }
  return v;
}

/**
 * 把 CQ 码 / JSON 卡片里的转义还原成可被 URL 正则匹配的形态。
 *   &#91; &#93; &#44; &amp;  —— OneBot 对 [ ] , & 的标准转义
 *   \/  \\/  \\\/  …        —— JSON 卡片里常见 `https:\/\/b23.tv\/xxx`；
 *                              json 段的 data.data 常是"字符串套 JSON"，
 *                              被 JSON.stringify 之后反斜杠会翻倍成 `\\/`，
 *                              所以必须折叠**任意多个**反斜杠，不能只替换一次。
 * 只用于"给正则捞链接"的中间文本，不参与任何回写，放宽一点无副作用。
 */
function unescapeCqPayload(s) {
  return String(s)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
    .replace(/\\+\//g, '/');
}

/**
 * 把远端 URL 下载成本地文件（限量 + 流式落盘 + 失败清理）。
 *
 * 为什么必须走 safe-fetch 而不是裸 fetch：
 *   URL 来自 QQ 群消息，是**攻击者可控**的。裸 fetch 等于把宿主变成 SSRF 跳板
 *   （群友发一条 http://192.168.1.1/... 就能让宿主去探内网）。
 *   safeFetchBinaryToFile 入口与每一跳重定向都过 validateFetchUrl（DNS 全记录
 *   内网拦截 + IP 固定防 rebinding）。
 *
 * 为什么流式（2026-09-19 M8）：旧实现 safeFetchBinary 整读进内存再写盘，
 * 100MB 上限就真的占 100MB 内存；现在边收边写盘，占用与视频大小无关。
 * safeFetchBinaryToFile 已保证"失败删半截文件"，这里不再需要 .part 中转。
 *
 * @param {string} url
 * @param {string} destPath
 * @param {number} maxBytes 体积上限（到达即中止并清理）
 * @param {object} [opts] 透传给 safeFetchBinaryToFile：{ timeoutMs, headers } 等。
 *                        headers 里只允许 Referer/Cookie/User-Agent/Origin/Accept/
 *                        Accept-Language/Range 这类白名单头（safe-fetch 会过滤并强制
 *                        覆盖 Host）—— 2026-10-07 之前这里被静默丢弃，
 *                        于是 B 站 CDN 防盗链 403、抖音 detail 接口（需 ttwid）返回空体。
 * @returns {Promise<{ok:boolean, bytes?:number, contentType?:string, error?:string}>}
 */
export async function safeFetchToFile(url, destPath, maxBytes = 100 * 1024 * 1024, opts = {}) {
  const dest = String(destPath || '');
  if (!dest) return { ok: false, error: '缺少目标路径' };
  const limit = Math.max(1, Number(maxBytes) || 100 * 1024 * 1024);
  try {
    const { bytes, contentType } = await safeFetchBinaryToFile(String(url || ''), dest, limit, {
      timeoutMs: Number(opts?.timeoutMs) || 30000,
      headers: opts?.headers || null
    });
    return { ok: true, bytes, contentType };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
