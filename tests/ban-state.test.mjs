// ban-state 插件单测。
//
// 覆盖 noteMuted / isMuted / noteUnmuted 生命周期与到期失效、muteFromTimestamp
// 的边界、isMuteRejection 的禁言签名、状态变化订阅（缓存穿透的源头），
// 以及 provider 各 action。
//
// 运行：node --test tests/ban-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../plugins/ban-state/index.js';

const {
  noteMuted, noteUnmuted, isMuted, mutedRemainSec, mutedNotedAt, listMuted,
  muteFromTimestamp, isMuteRejection, onBanStateChange, providers
} = plugin;

const BAN = providers['chat.ban-state'];
const KEY = 'group:1098345913';

/** 每个用例前后清空状态 + 退订监听，避免互相污染。 */
function clean() {
  noteUnmuted(KEY);
  noteUnmuted('group:1');
}

test('生命周期：note-muted → isMuted → note-unmuted → 不再禁言', () => {
  clean();
  assert.equal(isMuted(KEY), false);
  assert.equal(mutedNotedAt(KEY), null);
  const t0 = Date.now();
  noteMuted(KEY, 600);
  assert.equal(isMuted(KEY), true);
  assert.ok(mutedRemainSec(KEY) > 590 && mutedRemainSec(KEY) <= 600);
  // notedAt：复检宽限期用（刚记上的禁言不允许被一次滞后查询翻案）
  const noted = mutedNotedAt(KEY);
  assert.ok(noted >= t0 && noted <= Date.now());
  noteUnmuted(KEY);
  assert.equal(isMuted(KEY), false);
  assert.equal(mutedRemainSec(KEY), null);
  assert.equal(mutedNotedAt(KEY), null);
});

test('时长未知（0）保持到明确解禁', () => {
  clean();
  noteMuted(KEY, 0);
  assert.equal(isMuted(KEY), true);
  assert.equal(mutedRemainSec(KEY), null);   // 无明确时长 → null（给人看的）
  noteUnmuted(KEY);
  assert.equal(isMuted(KEY), false);
});

test('到期自动失效（不等解禁通知）', async () => {
  clean();
  noteMuted(KEY, 1);   // 1 秒后到期
  assert.equal(isMuted(KEY), true);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(isMuted(KEY), false);   // isMuted 顺带清理过期条目
  assert.equal(listMuted().length, 0);
});

test('muteFromTimestamp：判据是「到期时刻在未来」，不是「非 0」', () => {
  const now = 1_000_000;
  assert.deepEqual(muteFromTimestamp(now + 600, now), { muted: true, remainSec: 600 });
  assert.deepEqual(muteFromTimestamp(now - 1, now), { muted: false, remainSec: 0 });
  assert.deepEqual(muteFromTimestamp(0, now), { muted: false, remainSec: 0 });
  assert.deepEqual(muteFromTimestamp('', now), { muted: false, remainSec: 0 });
  assert.deepEqual(muteFromTimestamp(null, now), { muted: false, remainSec: 0 });
  assert.deepEqual(muteFromTimestamp(undefined, now), { muted: false, remainSec: 0 });
});

test('isMuteRejection：只认 result=120（errMsg 是空串，没有文案可依）', () => {
  // 本栈实测签名：retcode=100 + message 里带 result=120
  const real = new Error('OneBot send_group_msg 失败: retcode=100 send group message rejected: result=120 err=""');
  real.retcode = 100;
  assert.equal(isMuteRejection(real), true);
  // 聚合成字符串后 retcode 丢了：按 message 判，不误杀
  assert.equal(isMuteRejection('第1条「你好」：OneBot send_group_msg 失败: retcode=100 send group message rejected: result=120 err=""'), true);
  // 其它拒发码（如限频 241）不是禁言
  assert.equal(isMuteRejection(new Error('... result=241 ...')), false);
  // result=120 但 retcode 明确不是 100：不是同一条链路，不认
  const other = new Error('... result=120 ...');
  other.retcode = 200;
  assert.equal(isMuteRejection(other), false);
  // 普通错误
  assert.equal(isMuteRejection(new Error('socket hang up')), false);
  assert.equal(isMuteRejection(null), false);
  assert.equal(isMuteRejection(undefined), false);
});

test('状态变化订阅：禁言 / 解禁 / 到期三条路径都通知（F1 缓存穿透源头）', async () => {
  clean();
  const seen = [];
  const unsub = onBanStateChange((k, muted) => seen.push([k, muted]));
  noteMuted(KEY, 600);
  noteUnmuted(KEY);
  noteMuted(KEY, 1);          // 1 秒到期
  await new Promise((r) => setTimeout(r, 1100));
  isMuted(KEY);               // 触发过期清理 → 应通知
  unsub();
  noteMuted(KEY, 600);        // 退订后不再收到
  noteUnmuted(KEY);
  assert.deepEqual(seen, [[KEY, true], [KEY, false], [KEY, true], [KEY, false]]);
});

test('provider：check 返回 known/muted/skipRun/markRead', () => {
  clean();
  let r = BAN({ chatKey: KEY, action: 'check' });
  assert.equal(r.muted, false);
  assert.equal(r.known, false);
  assert.equal(r.skipRun, true);
  assert.equal(r.markRead, true);
  noteMuted(KEY, 600);
  r = BAN({ chatKey: KEY, action: 'check' });
  assert.equal(r.muted, true);
  assert.equal(r.known, true);          // 有明确记录 → 答案确定
  assert.equal(r.skipRun, true);
  assert.equal(r.markRead, true);
  assert.ok(r.notedAt > 0);             // 复检宽限期判据
  clean();
});

test('provider：配置开关关掉时 check 如实返回（F5 靠这个分支）', () => {
  clean();
  // 插件未 setup 时 cfg 默认 {}，两个开关默认 true；这里验证读取路径本身：
  // setup 之后 cfg 来自 api.config，跳过/标已读行为由 orchestrator 消费。
  plugin.setup({ config: () => ({ skipRunWhenMuted: false, markReadWhenMuted: false }), log: () => {} });
  const r = BAN({ chatKey: KEY, action: 'check' });
  assert.equal(r.skipRun, false);
  assert.equal(r.markRead, false);
  plugin.setup({ config: () => ({}), log: () => {} });   // 还原默认
  clean();
});

test('provider：note-send-rejected 命中禁言签名才记录', () => {
  clean();
  const banErr = new Error('OneBot send_group_msg 失败: retcode=100 send group message rejected: result=120 err=""');
  banErr.retcode = 100;
  const r1 = BAN({ chatKey: KEY, action: 'note-send-rejected', error: banErr });
  assert.equal(r1.matched, true);
  assert.equal(isMuted(KEY), true);       // 命中即记录（时长未知）
  noteUnmuted(KEY);
  const r2 = BAN({ chatKey: KEY, action: 'note-send-rejected', error: new Error('... result=241 ...') });
  assert.equal(r2.matched, false);
  assert.equal(isMuted(KEY), false);      // 未命中不记录
  clean();
});

test('provider：subscribe 返回退订函数；list 只列禁言中的', () => {
  clean();
  const seen = [];
  const unsub = BAN({ chatKey: '', action: 'subscribe', onChange: (k, m) => seen.push([k, m]) });
  assert.equal(typeof unsub, 'function');
  noteMuted(KEY, 600);
  noteMuted('group:1', 600);
  const list = BAN({ chatKey: '', action: 'list' }).muted;
  assert.equal(list.length, 2);
  assert.ok(list.some((x) => x.chatKey === KEY));
  unsub();
  noteUnmuted(KEY);
  assert.equal(seen.length, 2);           // 退订后不再收到
  clean();
});
