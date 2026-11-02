// 「发言即收尾」的收尾精细化（P3，2026-10-22）—— 纯函数，无 IO、无外部依赖。
//
// 为什么单独一个模块：这段判定决定"要不要多跑一轮 LLM"，一轮就是一次全价 prompt
// （本机实测约 19K token）。逻辑放这里是为了能脱离 electron / OneBot 单测 ——
// 编排器那边只负责取事实（插件能力 + 冷却表）再把结果接上。
//
// 背景见《表情包发送偏少的成因分析与优化计划-2026-10-22》：10-01 上线的
// autoEndAfterSend 会把"纯发送批"直接收尾，于是"先说话、下一轮补表情"这条路
// 物理上不存在。提示词层（P1/P2）只能提高遵从率，模型一旦没同批调用就永久丢失
// 那次表情；这里是机制层的兜底，但**不是无条件宽限**。

/** 同一会话两次宽限的最小间隔。 */
export const STICKER_GRACE_COOLDOWN_MS = 5 * 60 * 1000;

/** 判"短回应"的字数阈值（与提示词层 P1 的 ≤10 字对齐）。 */
export const STICKER_GRACE_SHORT_TEXT_MAX = 10;

// 内置没有表情工具，send_sticker 只可能来自 sticker 插件（带前缀 sticker__）。
// 以 send_sticker 结尾匹配：前缀形式与裸名都认，且不会误伤 send_sticker_list 这类查询工具。
const STICKER_SEND_RE = /(^|__|_)send_sticker$/i;

export function isStickerTool(name) {
  return STICKER_SEND_RE.test(String(name || '').trim());
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
}

/**
 * 这一批一共"说了多少字"（宽限判"短回应"用）。
 *
 * 只认 send_message 的 messages（字符串 / 字符串数组），剥掉 CQ 码、空白与 markdown
 * 修饰符 —— 模型常把 `[CQ:face,id=13]`、`**乐了**`、尾部空格带进来，不剥的话两个字
 * 会被算成十几二十字，短回应永远判不中。
 *
 * 参数解析不出来（坏 JSON / 没有 messages 字段）返回 Infinity（=不是短回应）：
 * 判短是要花钱的，拿不准一律往"不宽限"倒。
 */
export function batchSpokenLength(toolCalls) {
  let total = 0;
  for (const c of Array.isArray(toolCalls) ? toolCalls : []) {
    if (c?.function?.name !== 'send_message') continue;
    const args = safeParse(c?.function?.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || !Object.prototype.hasOwnProperty.call(args, 'messages')) return Number.POSITIVE_INFINITY;
    const raw = args.messages;
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    for (const m of list) {
      total += String(m ?? '')
        .replace(/\[CQ:[^\]]*\]/gi, '')
        .replace(/\s+/g, '')
        .replace(/[*_~`]/g, '')
        .length;
    }
  }
  return total;
}

/**
 * 宽限轮里的提醒文案。明确"不要重发刚才那句话"—— 宽限轮里模型最常见的动作
 * 是把原句再发一遍，群里就会出现重复消息。
 */
export const STICKER_GRACE_NUDGE =
  '【系统提醒】你刚才只发了文字。如果这句适合配一张表情，现在就单独发一张（不要再把刚才那句话重发一遍）；不适合就调用 finish 结束。';

/**
 * 判定这一轮要不要宽限（不设 finish，多给一轮）。
 *
 * 调用方负责提供事实：`state` 来自 sticker 插件的 `sticker.state` 能力，
 * `lastGraceAt` 来自会话冷却表，`enabled` 来自配置开关。
 *
 * @param {object} p
 * @param {{enabled?: boolean, count?: number|null, level?: number}|null} p.state
 *        sticker 插件状态：库里有几张（count）、生效档位（level，0~3）
 * @param {Array} p.toolCalls       本批工具调用（OpenAI tool_calls 形态）
 * @param {Array} p.triggerEntries  本次唤醒收到的消息（带 media 字段）
 * @param {number} p.round          当前轮次（0 起）
 * @param {number} p.maxRounds      本次运行的总轮次上限
 * @param {boolean} p.used          本次唤醒是否已经宽限过
 * @param {boolean} p.proactive     是否主动开话题（那条路径不适用）
 * @param {number} [p.lastGraceAt]  上次宽限的时间戳（0 = 从未）
 * @param {number} [p.now]          当前时间戳（测试注入用）
 * @param {boolean} [p.enabled]     开关 api.autoEndStickerGrace !== false
 * @returns {{why: string, nudge: string}|null} null = 照旧立刻收尾
 */
export function stickerGraceDecision({
  state, toolCalls, triggerEntries, round, maxRounds,
  used, proactive, lastGraceAt = 0, now = Date.now(), enabled = true
} = {}) {
  if (enabled === false) return null;                 // 用户关了
  if (used === true) return null;                     // 一次唤醒最多一次
  if (proactive === true) return null;                // 主动开话题不适用
  if (!(Number(round) + 1 < Number(maxRounds))) return null;   // 没地方宽限了
  if ((Array.isArray(toolCalls) ? toolCalls : []).some((c) => isStickerTool(c?.function?.name))) return null;
  if (!state || state.enabled === false) return null; // 插件不在场
  const count = state.count === null || state.count === undefined ? null : Number(state.count);
  const level = Number(state.level);
  // count=null 表示库还没同步上来。拿不准就别宽限 —— 宁可这次少个表情，
  // 也不要在"其实没图可发"的时候白烧一轮 prompt。
  if (count === null || !Number.isFinite(count) || count <= 0) return null;
  // 0/1 档是用户明确要"少发"，宽限会跟配置对着干。
  if (!Number.isFinite(level) || level < 2) return null;
  if (Number(now) - Number(lastGraceAt) < STICKER_GRACE_COOLDOWN_MS) return null;
  const shortText = batchSpokenLength(toolCalls) <= STICKER_GRACE_SHORT_TEXT_MAX;
  const sawMedia = (Array.isArray(triggerEntries) ? triggerEntries : []).some((m) =>
    Array.isArray(m?.media) && m.media.some((x) => /image|face|emoji|sticker/i.test(String(x?.kind || ''))));
  if (!shortText && !sawMedia) return null;
  return { why: shortText ? '短回应' : '群友刚发过图', nudge: STICKER_GRACE_NUDGE };
}
