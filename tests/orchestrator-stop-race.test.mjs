import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-stop-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { Orchestrator } = await import('../src/orchestrator.js');
const { updateConfig } = await import('../src/config.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('停止提醒循环时，已发出的提醒可收尾，未发送的提醒保留且不重新挂定时器', async (t) => {
  updateConfig({ allowAllWhenEmpty: true });
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const send = Promise.withResolvers();
  const sent = [];
  const fired = [];
  const orch = new Orchestrator({
    store: {}, memory: {}, sessions: {}, onebot: {},
    sender: { sendTextBatch: async (_chat, text) => { sent.push(text); await send.promise; return { sent: [] }; } },
    reminders: {
      due: () => [{ id: 'a', chatKey: 'private:1', text: 'first' }, { id: 'b', chatKey: 'private:1', text: 'second' }],
      markFired: (id) => fired.push(id), prune() {}
    }
  });
  orch.startReminderLoop();
  timers[0].callback();
  assert.equal(sent.length, 1);
  orch.stopReminderLoop();
  let stopped = false;
  const stopping = orch.abortAll().then(() => { stopped = true; });
  await setImmediate();
  const completedEarly = stopped;
  send.resolve();
  await stopping;
  assert.equal(completedEarly, false);
  assert.equal(sent.length, 1);
  assert.deepEqual(fired, ['a']);
  assert.equal(timers.length, 1);
  assert.equal(orch.reminderTimer, null);
});

for (const stop of ['abort', 'pause', 'pause-resume']) {
  test(`唤醒禁言查询等待期间 ${stop}，查询完成后不消费未读或创建会话`, async () => {
    updateConfig({ api: { model: 'test' } });
    const query = Promise.withResolvers();
    let drained = 0;
    const orch = new Orchestrator({
      store: { drainUnread() { drained++; return []; } }, memory: {}, sender: {},
      sessions: { create() { assert.fail('停止后的唤醒不得创建会话'); } },
      onebot: { selfId: '9', call: () => query.promise }
    });
    const wake = orch.wake('group:123', { proactive: true });
    let stopping;
    if (stop === 'abort') stopping = orch.abortAll();
    else {
      orch.setPaused(true);
      if (stop === 'pause-resume') orch.setPaused(false);
    }
    query.resolve({ shut_up_timestamp: 0 });
    await wake;
    await stopping;
    assert.equal(drained, 0);
    assert.deepEqual([...orch.runningChats], []);
  });
}

test('abortAll 必须等在途唤醒收尾后才完成，调用方才能清空或落盘数据', async () => {
  updateConfig({ api: { model: 'test' } });
  const query = Promise.withResolvers();
  const orch = new Orchestrator({
    store: {}, memory: {}, sender: {}, sessions: {},
    onebot: { selfId: '9', call: () => query.promise }
  });
  const wake = orch.wake('group:999');
  let stopped = false;
  const stopping = orch.abortAll().then(() => { stopped = true; });
  await setImmediate();
  const completedEarly = stopped;
  query.resolve({ shut_up_timestamp: 0 });
  await Promise.all([wake, stopping]);
  assert.equal(completedEarly, false);
  assert.equal(orch.startingChats.size, 0);
});

test('abortAll 取消记忆模型请求并等待最后的记忆状态写入完成', async (t) => {
  updateConfig({ api: { model: 'test', baseUrl: 'https://example.invalid/v1' } });
  const started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const writes = [];
  const orch = new Orchestrator({
    store: { recent: () => Array.from({ length: 3 }, () => ({ senderId: '7', senderName: 'friend', text: 'hi' })) },
    memory: {
      members: () => [{ userId: '7', name: 'friend', impressions: [{ content: '喜欢音乐', createdAt: 0 }] }],
      replaceConsolidatedMember() { writes.push('impressions'); },
      markConsolidated() { writes.push('metadata'); }
    },
    sender: {}, sessions: {}, onebot: {}
  });
  const pending = orch.consolidateMemoryForChat('group:123', { userIds: ['7'], force: true });
  await started.promise;
  await orch.abortAll();
  const result = await pending;
  assert.match(result.failed[0].reason, /全局中止/);
  assert.deepEqual(writes, ['metadata']);
  await setImmediate();
  assert.deepEqual(writes, ['metadata']);
});
