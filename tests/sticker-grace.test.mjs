// 收尾精细化（P3）最小单测（2026-10-22，表情包排查报告「机制层」项）。
//
// 为什么单独测这一块：`stickerGraceDecision()` 的返回值直接决定"要不要多跑一轮 LLM"，
// 而一轮就是一次全价 prompt（实测约 19K token）。判错的两个方向都疼：
//   · 该宽限没宽限 → 表情继续发不出去，等于 P3 没做
//   · 不该宽限却宽限 → 每条短回应白烧 19K token，把省 token 的机制整个推翻
// 所以把边界全钉一遍：档位、库存、冷却、已发过表情、坏 JSON、最后一轮。
//
// 运行：node --test tests/sticker-grace.test.mjs   （在 resources/app 目录下）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stickerGraceDecision, batchSpokenLength, isStickerTool,
  STICKER_GRACE_COOLDOWN_MS, STICKER_GRACE_SHORT_TEXT_MAX
} from '../src/sticker-grace.js';

const NOW = 1_800_000_000_000;

/** 一批只有 send_message 的调用。 */
const sendCalls = (texts) => [{ function: { name: 'send_message', arguments: JSON.stringify({ messages: texts }) } }];

/** 默认能宽限的现场：短回应 + 库存 5 张 + 生效 2 档 + 从未宽限。 */
const base = (over = {}) => ({
  state: { enabled: true, count: 5, level: 2 },
  toolCalls: sendCalls('乐了'),
  triggerEntries: [{ text: '你咋看' }],
  round: 0,
  maxRounds: 12,
  used: false,
  proactive: false,
  lastGraceAt: 0,
  now: NOW,
  enabled: true,
  ...over
});

test('短回应 + 库里有图 + 档位够 → 宽限', () => {
  const r = stickerGraceDecision(base());
  assert.ok(r, '应当宽限');
  assert.equal(r.why, '短回应');
  assert.match(r.nudge, /不要再把刚才那句话重发一遍/);
});

test('长句、且本轮没人发图 → 不宽限（照旧立刻收尾）', () => {
  const r = stickerGraceDecision(base({
    toolCalls: sendCalls('我觉得这个方案还得再想一想要不要这么改，收益不确定')
  }));
  assert.equal(r, null);
});

test('长句、但本轮有人发了图 → 宽限（接图场景）', () => {
  const r = stickerGraceDecision(base({
    toolCalls: sendCalls('这张图我有点看不懂，是说昨天那件事吗'),
    triggerEntries: [{ text: '', media: [{ kind: 'image' }] }]
  }));
  assert.ok(r);
  assert.equal(r.why, '群友刚发过图');
});

test('短回应边界：10 字算短，11 字不算', () => {
  const ten = '这也太离谱了吧真的';      // 9 字
  const eleven = '这也太离谱了吧真的啊';  // 10 字
  assert.ok(batchSpokenLength(sendCalls(ten)) <= STICKER_GRACE_SHORT_TEXT_MAX);
  assert.ok(stickerGraceDecision(base({ toolCalls: sendCalls(ten) })));
  // 11 字：构造一个确定超阈值的句子
  const long = '这件事我觉得还是得再仔细想一想';
  assert.ok(batchSpokenLength(sendCalls(long)) > STICKER_GRACE_SHORT_TEXT_MAX);
  assert.equal(stickerGraceDecision(base({ toolCalls: sendCalls(long) })), null);
  assert.ok(batchSpokenLength(sendCalls(eleven)) <= 11);
});

test('档位 0/1 不宽限（用户明确要少发，别跟配置对着干）', () => {
  for (const level of [0, 1]) {
    assert.equal(stickerGraceDecision(base({ state: { enabled: true, count: 20, level } })), null);
    assert.ok(stickerGraceDecision(base({ state: { enabled: true, count: 20, level: level + 2 } })));
  }
});

test('库存不足 / 读不到库存 → 不宽限', () => {
  assert.equal(stickerGraceDecision(base({ state: { enabled: true, count: 0, level: 2 } })), null);
  assert.equal(stickerGraceDecision(base({ state: { enabled: true, count: null, level: 2 } })), null);
  assert.equal(stickerGraceDecision(base({ state: null })), null);
  assert.equal(stickerGraceDecision(base({ state: { enabled: false, count: 5, level: 3 } })), null);
});

test('本批已经发过表情 → 不宽限（那是正常路径，立刻收尾最省）', () => {
  const calls = [...sendCalls('乐了'), { function: { name: 'sticker__send_sticker', arguments: '{"id":"1"}' } }];
  assert.equal(stickerGraceDecision(base({ toolCalls: calls })), null);
});

test('一次唤醒只宽限一次 / 主动开话题不宽限 / 最后一轮不宽限', () => {
  assert.equal(stickerGraceDecision(base({ used: true })), null);
  assert.equal(stickerGraceDecision(base({ proactive: true })), null);
  assert.equal(stickerGraceDecision(base({ round: 11, maxRounds: 12 })), null);
});

test('会话冷却：5 分钟内不重复宽限，过了就能再宽限', () => {
  assert.equal(stickerGraceDecision(base({ lastGraceAt: NOW - 60_000 })), null);
  assert.ok(stickerGraceDecision(base({ lastGraceAt: NOW - STICKER_GRACE_COOLDOWN_MS - 1 })));
});

test('开关关掉时一律不宽限', () => {
  assert.equal(stickerGraceDecision(base({ enabled: false })), null);
});

test('字数统计：剥 CQ 码 / markdown / 空白；坏 JSON 与缺字段返回 Infinity', () => {
  assert.equal(batchSpokenLength(sendCalls('[CQ:face,id=13]确实[CQ:face,id=1]')), 2);
  assert.equal(batchSpokenLength(sendCalls('**乐了**')), 2);
  assert.equal(batchSpokenLength(sendCalls(['哈哈', '太真实了'])), 6);
  assert.equal(batchSpokenLength([{ function: { name: 'send_message', arguments: '{messages: broken' } }]), Number.POSITIVE_INFINITY);
  assert.equal(batchSpokenLength([{ function: { name: 'send_message', arguments: JSON.stringify({ replyToMessageId: 3 }) } }]), Number.POSITIVE_INFINITY);
  assert.equal(batchSpokenLength([{ function: { name: 'web_search', arguments: '{}' } }]), 0);
  assert.equal(batchSpokenLength(null), 0);
});

test('表情工具名判定：带前缀与裸名都认，查询类工具不误伤', () => {
  assert.ok(isStickerTool('sticker__send_sticker'));
  assert.ok(isStickerTool('send_sticker'));
  assert.equal(isStickerTool('send_sticker_list'), false);
  assert.equal(isStickerTool('tts_send_voice'), false);
  assert.equal(isStickerTool(''), false);
});
