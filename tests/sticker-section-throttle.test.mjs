// 提示词段滞回最小单测（2026-10-23，识图场景缓存稳定化）。
//
// 为什么单独测这一块：这两个纯函数的输出直接决定【表情包策略】段（在**系统提示**里）
// 和【可用表情包】段（在【过去状态】**之前**）翻不翻字 —— 而这两处每翻一次字，
// 前缀缓存就从翻字处整段重算：策略段翻字实测单次 ~9K tok（命中 98%→21%），
// 清单段翻字实测单次 2~6KB。判错的两个方向都疼：
//   · 该滞回没滞回 → 手机端取消收藏的瞬时抖动、5 分钟 6 张的收藏风暴，
//     每次都按整条前缀的代价计费（这正是用户报"识图时缓存飘雨"的成因）
//   · 不该滞回却滞回 → 库存真的变了她却按旧档位引导（升级必须立即生效），
//     或清单几十分钟不刷新（节流必须有个小上限）
// 所以把边界全钉一遍：升级/持平/降档未满宽限/降档满宽限/观察期中涨回/跳档/
// 读不到库存，以及清单的没变/间隔不足/间隔足够/紧急翻转/at 起算点。
//
// 运行：node --test tests/sticker-section-throttle.test.mjs   （在 resources/app 目录下）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capacityCap, capacityLevel, smoothCapDowngrade, planSectionRender
} from '../plugins/sticker/lib/stickers.js';

const T0 = 1_800_000_000_000;
const GRACE = 10 * 60 * 1000;      // 与 index.js 的 CAP_DOWNGRADE_GRACE_MS 同数量级
const INTERVAL = 3 * 60 * 1000;    // 与 index.js 的 LIST_REFRESH_MS 同数量级

// ── capacityCap / capacityLevel（拆函数后行为必须不变）─────────────────────

test('capacityCap：边界 0/4/10 与读不到', () => {
  assert.equal(capacityCap(0), 0);
  assert.equal(capacityCap(1), 1);
  assert.equal(capacityCap(3), 1);
  assert.equal(capacityCap(4), 2);
  assert.equal(capacityCap(9), 2);
  assert.equal(capacityCap(10), 3);
  assert.equal(capacityCap(999), 3);
  assert.equal(capacityCap(null), null);
  assert.equal(capacityCap(undefined), null);
  assert.equal(capacityCap('abc'), null);
  assert.equal(capacityCap(NaN), null);
});

test('capacityLevel：与配置取 min，读不到不擅自降档', () => {
  assert.equal(capacityLevel(3, 0), 0);
  assert.equal(capacityLevel(3, 5), 2);
  assert.equal(capacityLevel(1, 999), 1);   // 用户要低调，库存再大也高不过配置
  assert.equal(capacityLevel(3, null), 3);  // 读不到库存：按配置档
  assert.equal(capacityLevel(2, 'x'), 2);
});

// ── smoothCapDowngrade：策略档位降档滞回 ─────────────────────────────────

test('首次直接采用当前档', () => {
  const s = smoothCapDowngrade(null, 2, T0, GRACE);
  assert.equal(s.cap, 2);
  assert.equal(s.pendingCap, null);
});

test('升级立即生效（不等宽限）—— 库存变多是模型该知道的好事', () => {
  const s1 = smoothCapDowngrade({ cap: 1, pendingCap: null, pendingSince: 0 }, 2, T0, GRACE);
  assert.equal(s1.cap, 2);
  assert.equal(s1.pendingCap, null);
});

test('升级会作废进行中的降档观察', () => {
  const s1 = smoothCapDowngrade({ cap: 2, pendingCap: null, pendingSince: 0 }, 1, T0, GRACE);
  assert.equal(s1.cap, 2);                       // 降档候选，未生效
  assert.equal(s1.pendingCap, 1);
  const s2 = smoothCapDowngrade(s1, 2, T0 + 60_000, GRACE);
  assert.equal(s2.cap, 2);
  assert.equal(s2.pendingCap, null);             // 涨回来了，观察期作废
});

test('降档必须持续满宽限才落地', () => {
  const s1 = smoothCapDowngrade({ cap: 2, pendingCap: null, pendingSince: 0 }, 1, T0, GRACE);
  assert.equal(s1.cap, 2);
  assert.equal(s1.pendingSince, T0);
  const s2 = smoothCapDowngrade(s1, 1, T0 + GRACE - 1, GRACE);
  assert.equal(s2.cap, 2);                       // 差 1ms 也不翻
  const s3 = smoothCapDowngrade(s2, 1, T0 + GRACE, GRACE);
  assert.equal(s3.cap, 1);                       // 满宽限，落地
  assert.equal(s3.pendingCap, null);
});

test('降档观察期中反复抖动永不落地（pendingSince 每次重新起算）', () => {
  // 手机端"取消-收藏-取消-收藏……"：每次跌到 1 都撑不过 10 分钟
  let s = { cap: 2, pendingCap: null, pendingSince: 0 };
  for (let i = 0; i < 20; i++) {
    s = smoothCapDowngrade(s, 1, T0 + i * 60_000, GRACE);   // 每分钟抖一次
    s = smoothCapDowngrade(s, 2, T0 + i * 60_000 + 30_000, GRACE);
  }
  assert.equal(s.cap, 2);                       // 20 次抖动，零次翻字
});

test('跳档降级（3→1）持续后直接落地，不逐级过渡', () => {
  const s1 = smoothCapDowngrade({ cap: 3, pendingCap: null, pendingSince: 0 }, 1, T0, GRACE);
  assert.equal(s1.cap, 3);
  const s2 = smoothCapDowngrade(s1, 1, T0 + GRACE, GRACE);
  assert.equal(s2.cap, 1);
});

test('读不到库存原样保留（含观察期），不升不降', () => {
  const prev = { cap: 2, pendingCap: 1, pendingSince: T0 };
  const s = smoothCapDowngrade(prev, null, T0 + 5000, GRACE);
  assert.deepEqual(s, prev);
  // 连状态都没有时返回中性值，调用方按"用配置档"处理
  assert.deepEqual(smoothCapDowngrade(null, null, T0, GRACE), { cap: 0, pendingCap: null, pendingSince: 0 });
});

test('越界值被夹到 0~3', () => {
  assert.equal(smoothCapDowngrade(null, 99, T0, GRACE).cap, 3);
  assert.equal(smoothCapDowngrade(null, -5, T0, GRACE).cap, 0);
});

// ── planSectionRender：清单段最小刷新间隔 ────────────────────────────────

test('首次直接渲染', () => {
  const p = planSectionRender(null, 'v1', T0, INTERVAL);
  assert.equal(p.text, 'v1');
  assert.equal(p.rendered, true);
  assert.equal(p.at, T0);
});

test('内容没变：rendered=false 且 at 不推进', () => {
  const p = planSectionRender({ text: 'v1', at: T0 }, 'v1', T0 + 60_000, INTERVAL);
  assert.equal(p.text, 'v1');
  assert.equal(p.rendered, false);
  assert.equal(p.at, T0);                       // at 停在上一版渲染时间
});

test('间隔不足：继续注入旧文本（节流）', () => {
  const p = planSectionRender({ text: 'v1', at: T0 }, 'v2', T0 + INTERVAL - 1, INTERVAL);
  assert.equal(p.text, 'v1');
  assert.equal(p.rendered, false);
});

test('间隔足够：翻字且 at 推进到本次', () => {
  const p = planSectionRender({ text: 'v1', at: T0 }, 'v2', T0 + INTERVAL, INTERVAL);
  assert.equal(p.text, 'v2');
  assert.equal(p.rendered, true);
  assert.equal(p.at, T0 + INTERVAL);
});

test('紧急翻转（空库↔非空）立即生效，不等间隔', () => {
  const p = planSectionRender({ text: '空库占位', at: T0 }, 'v1', T0 + 1000, INTERVAL, true);
  assert.equal(p.text, 'v1');
  assert.equal(p.rendered, true);
});

test('at 从上次真实渲染起算，不是从上次请求起算', () => {
  // v1 渲染于 T0；之后每 30s 来一次新内容但都被节流 → at 一直是 T0
  let state = { text: 'v1', at: T0 };
  for (let t = 30_000; t < INTERVAL; t += 30_000) {
    const p = planSectionRender(state, 'vX', T0 + t, INTERVAL);
    assert.equal(p.rendered, false);
    state = p.rendered ? { text: p.text, at: p.at } : state;
  }
  // 正好满间隔的那一次必须翻（证明起算点是 T0 而不是某次被节流的请求）
  const p = planSectionRender(state, 'v2', T0 + INTERVAL, INTERVAL);
  assert.equal(p.rendered, true);
});

// ── 场景复刻：2026-10-23 00:03–00:06 的收藏风暴 ─────────────────────────

test('场景：5 分钟 6 张的收藏风暴，清单段从 6 次翻字折叠成 2 次', () => {
  // 实测时间线（seg-fp 记录）：00:03:12 / 00:03:52 / 00:04:37 / 00:04:51 / 00:06:16 / 00:06:35
  const storm = [0, 40, 85, 99, 184, 203].map((s) => s * 1000);   // 相对 T0 的秒
  let state = null;
  let renders = 0;
  storm.forEach((dt, i) => {
    const p = planSectionRender(state, `v${i + 1}`, T0 + dt, INTERVAL);
    if (p.rendered) { renders += 1; state = { text: p.text, at: p.at }; }
  });
  assert.equal(renders, 2);                     // 原逻辑 6 次全价重算 → 现在 2 次
});

test('场景：识图会话里每次收藏后连问三轮，段字节在会话内保持恒定', () => {
  // 一次收藏后模型又跑了好几轮（每轮都过 before-llm-messages）：库没再变，
  // 之后每一轮注入的必须是同一版文本，否则会话内前缀每轮都断
  let state = { text: 'v1', at: T0 };
  const injected = [];
  for (let round = 0; round < 4; round++) {
    const p = planSectionRender(state, 'v1', T0 + 1000 * (round + 1), INTERVAL);
    injected.push(p.text);
    if (p.rendered) state = { text: p.text, at: p.at };
  }
  assert.deepEqual(injected, ['v1', 'v1', 'v1', 'v1']);
});
