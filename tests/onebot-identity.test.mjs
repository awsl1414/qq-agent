import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { OneBotClient } from '../src/onebot.js';

async function setup(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const client = new OneBotClient({ wsUrl: `ws://127.0.0.1:${server.address().port}` });
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const requests = [];
  let notify;
  client.call = (action) => {
    assert.equal(action, 'get_login_info');
    const pending = Promise.withResolvers();
    requests.push(pending);
    notify?.();
    return pending.promise;
  };
  async function waitForRequest(count) {
    while (requests.length < count) await new Promise((resolve) => { notify = resolve; });
    notify = null;
  }
  await client.connect();
  await waitForRequest(1);
  return { client, requests, waitForRequest };
}

test('重连后的账号身份不能被旧连接迟到的登录响应覆盖', async (t) => {
  const { client, requests, waitForRequest } = await setup(t);
  await client.reconnect();
  await waitForRequest(2);
  requests[1].resolve({ user_id: 222, nickname: 'new' });
  await setImmediate();
  assert.equal(client.selfId, '222');
  requests[0].resolve({ user_id: 111, nickname: 'old' });
  await setImmediate();
  assert.equal(client.selfId, '222');
});

test('关闭连接后迟到的登录响应不得恢复已失效的身份', async (t) => {
  const { client, requests } = await setup(t);
  client.close();
  requests[0].resolve({ user_id: 111 });
  await setImmediate();
  assert.equal(client.connected, false);
  assert.equal(client.selfId, '');
});

test('切换连接时清除旧身份，新账号查询完成前不沿用旧 QQ 号', async (t) => {
  const { client, requests, waitForRequest } = await setup(t);
  requests[0].resolve({ user_id: 111 });
  await setImmediate();
  assert.equal(client.selfId, '111');
  await client.reconnect();
  await waitForRequest(2);
  assert.equal(client.selfId, '');
  requests[1].resolve({ user_id: 222 });
  await setImmediate();
  assert.equal(client.selfId, '222');
});

test('延迟补拉同样绑定连接，迟到的补拉结果不能覆盖重连后的身份', async (t) => {
  const realTimeout = globalThis.setTimeout;
  let refresh;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 15000) { refresh = callback; return null; }
    return realTimeout(callback, ms, ...args);
  });
  const { client, requests, waitForRequest } = await setup(t);
  requests[0].reject(new Error('account starting'));
  await setImmediate();
  assert.equal(typeof refresh, 'function');
  const refreshing = refresh();
  await waitForRequest(2);
  await client.reconnect();
  await waitForRequest(3);
  requests[2].resolve({ user_id: 222 });
  await setImmediate();
  requests[1].resolve({ user_id: 111 });
  await refreshing;
  assert.equal(client.selfId, '222');
});
