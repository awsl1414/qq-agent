// 禁言复检集成测试（用户实测反馈「识别完禁言之后无法识别解禁」）。
//
// 快路径回答"禁言中"时整条链短路，缓存/查询兜底永远轮不到。而禁言记录有两种
// 翻不动的：时长未知的（发送被拒兜底记的，永不到期）、有时长但被提前解禁且通知
// 丢了的。复检逻辑：对"认为禁言中"的会话每 60s 用协议端查询（no_cache 强制刷新）
// 核一次，查到未禁言且记录够久就清除。
//
// 本测试驱动真实 Orchestrator（#wakeInner 的禁言闸），stub 掉 store/sender，
// 用可变的 shut_up_timestamp 模拟"禁言中/已解禁"，用可控的时钟偏移模拟
// "记录建立了多久 / 距上次查询多久"。
//
// 运行：node --test tests/mute-reverify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据目录指向临时位置（必须在 import config 之前，config.js 在加载期解析）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-mute-reverify-'));
process.env.QQ_AGENT_DATA_DIR = tmpDir;

const { Orchestrator } = await import('../src/orchestrator.js');
const { skillManager } = await import('../src/skills/manager.js');
const { updateConfig, getConfig } = await import('../src/config.js');
const banPlugin = await import('../plugins/ban-state/index.js');

// ── 可控时钟：offset 让"现在"整体平移，用来模拟时间流逝 ──
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

const KEY = 'group:1098345913';

banPlugin.setup({ config: () => ({}), log: () => {} });
skillManager.register({
  manifest: { id: 'ban-state', name: '群禁言状态', version: '1.0.0', apiVersion: 1, kind: 'plugin', enabledByDefault: true, capabilities: ['chat.ban-state'], requires: [] },
  providers: banPlugin.providers,
  loadError: null,
  source: 'plugin'
});
updateConfig(() => ({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:9' },
  allow: { groups: ['1098345913'], private: [] },
  allowAllWhenEmpty: true
}));

/** 造一个 Orchestrator；shutUpTs 可以是值或 getter（每次查询动态求值）。 */
function makeOrch(shutUpTs) {
  const calls = [];
  const markAllReadCalls = [];
  const onebot = {
    selfId: '3930779767',
    call: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_group_member_info') {
        const ts = typeof shutUpTs === 'function' ? shutUpTs() : shutUpTs;
        return { shut_up_timestamp: ts };
      }
      return {};
    }
  };
  const store = {
    markAllRead: (ck) => { markAllReadCalls.push(ck); return 1; },
    peekUnread: () => [],
    listChats: () => [KEY],
    getChatMeta: () => ({ unread: 0, lastTs: 0 }),
    appendIncoming: () => {},
    appendSelf: () => {},
    markRecalled: () => 0
  };
  const orch = new Orchestrator({
    store,
    memory: {},
    sender: { sendTextBatch: async () => ({ sent: [], failed: [] }) },
    sessions: {},
    onebot,
    emit: () => {},
    reminders: null,
    videoReader: null
  });
  return { orch, calls, markAllReadCalls };
}

/** 跑一次唤醒；禁言闸之后的路径（tier 判定等）会因 stub 不全而抛错，无关心。 */
async function wakeOnce(orch) {
  try { await orch.wake(KEY); } catch { /* 禁言闸之后的桩不全，忽略 */ }
}

/** 以"now - ageMs"的时刻记一条禁言（模拟记录建立了多久）。 */
function noteMutedAgo(durationSec, ageMs) {
  clockOffset = -ageMs;
  try { banPlugin.noteMuted(KEY, durationSec); } finally { clockOffset = 0; }
}

test('复检翻案：时长未知的禁言（F4 兜底）+ 记录够久 + 查询显示已解禁 → 清除并放行', async () => {
  banPlugin.noteUnmuted(KEY);
  // 记录建于 120 秒前（> 60s 宽限期），时长未知（0 = 永不到期）
  noteMutedAgo(0, 120000);
  assert.equal(banPlugin.isMuted(KEY), true);

  const { orch, calls, markAllReadCalls } = makeOrch(0);   // 协议端：未禁言
  await wakeOnce(orch);

  // 复检真的发生了，而且是强制刷新（no_cache=true）
  const q = calls.find((c) => c.action === 'get_group_member_info');
  assert.ok(q, '应当发起协议端复检查询');
  assert.equal(q.params.no_cache, true, '复检必须强制刷新成员列表');
  // 禁言记录被清除（否则快路径会一直答"禁言中"，每 60s 复查一次永远发现不了）
  assert.equal(banPlugin.isMuted(KEY), false, '复检应清除禁言记录');
  // 放行：没有走"跳过处理"路径（该路径会 markAllRead）
  assert.equal(markAllReadCalls.length, 0, '复检放行后不应标记已读跳过');
  banPlugin.noteUnmuted(KEY);
});

test('宽限期：记录太新（<60s）时查询显示未禁言也不翻案 —— 以通知为准，维持禁言', async () => {
  banPlugin.noteUnmuted(KEY);
  noteMutedAgo(0, 10000);   // 10 秒前刚记上
  assert.equal(banPlugin.isMuted(KEY), true);

  const { orch, calls, markAllReadCalls } = makeOrch(0);   // 协议端：未禁言（可能是滞后的旧数据）
  await wakeOnce(orch);

  assert.equal(calls.find((c) => c.action === 'get_group_member_info')?.params.no_cache, true);
  // 记录还在，且本轮维持禁言判据（机器人不会在禁言中发言）
  assert.equal(banPlugin.isMuted(KEY), true, '宽限期内不应清除记录');
  assert.equal(markAllReadCalls.length, 1, '宽限期内应继续走跳过路径');
  banPlugin.noteUnmuted(KEY);
});

test('复检说仍禁言 → 维持禁言判据', async () => {
  banPlugin.noteUnmuted(KEY);
  noteMutedAgo(600, 120000);   // 600 秒的禁言，建于 120 秒前
  const future = Math.floor(realNow() / 1000) + 300;
  const { orch, calls, markAllReadCalls } = makeOrch(future);
  await wakeOnce(orch);

  assert.equal(calls.find((c) => c.action === 'get_group_member_info')?.params.no_cache, true);
  assert.equal(banPlugin.isMuted(KEY), true);
  assert.equal(markAllReadCalls.length, 1);
  banPlugin.noteUnmuted(KEY);
});

test('复检节流：刚复检过 → 快路径命中，不再打协议端', async () => {
  banPlugin.noteUnmuted(KEY);
  noteMutedAgo(600, 120000);
  const future = Math.floor(realNow() / 1000) + 300;
  const { orch, calls, markAllReadCalls } = makeOrch(future);

  await wakeOnce(orch);         // 第 1 次：复检（no_cache=true）
  assert.equal(calls.filter((c) => c.action === 'get_group_member_info').length, 1);
  await wakeOnce(orch);         // 第 2 次（60s 内）：快路径，零查询
  assert.equal(calls.filter((c) => c.action === 'get_group_member_info').length, 1, '复检节流期内不应再查协议端');
  assert.equal(markAllReadCalls.length, 2, '两次都应走跳过路径');
  banPlugin.noteUnmuted(KEY);
});

test('没有禁言记录时：普通查询 no_cache=false，且不触发额外强制刷新', async () => {
  banPlugin.noteUnmuted(KEY);
  const { orch, calls } = makeOrch(0);   // 未禁言
  await wakeOnce(orch);
  await wakeOnce(orch);
  const qs = calls.filter((c) => c.action === 'get_group_member_info');
  assert.equal(qs.length, 1, '15s TTL 内第二次唤醒应命中缓存');
  assert.equal(qs[0].params.no_cache, false, '普通查询不走强制刷新');
});

test.after(() => {
  Date.now = realNow;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
