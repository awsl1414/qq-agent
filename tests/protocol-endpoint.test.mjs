// 端口探测目标的解析（用户实测：「工具 → 连接」把收消息 WS 显示成「端口未监听」，
// 而协议端其实在跑）。
//
// 根因：各处探测只从 protocol.wsUrl 取了端口，主机写死 127.0.0.1。协议端跑在
// 局域网另一台机器（ws://192.168.255.209:3001）时，探测打的本机永远没有监听，
// 而 OneBot 客户端按完整 wsUrl 连是通的 —— 界面状态与真实连接长期相反。
//
// 运行：node --test tests/protocol-endpoint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseProbeTarget } = await import('../src/protocol-endpoint.js');

test('远端主机：host 与 port 都取自 wsUrl', () => {
  assert.deepEqual(parseProbeTarget('ws://192.168.255.209:3001'), { host: '192.168.255.209', port: 3001 });
  assert.deepEqual(parseProbeTarget('ws://10.0.0.5:3001/onebot/v11/ws'), { host: '10.0.0.5', port: 3001 });
});

test('没写端口：按协议默认 ws 80 / wss 443，不用 3001', () => {
  assert.deepEqual(parseProbeTarget('ws://example.com/bot'), { host: 'example.com', port: 80 });
  assert.deepEqual(parseProbeTarget('wss://example.com/bot'), { host: 'example.com', port: 443 });
});

test('IPv6：URL.hostname 的方括号要去掉，net.connect 才认', () => {
  // 实测 Node 24：new URL('ws://[::1]:3001').hostname === '[::1]'
  assert.deepEqual(parseProbeTarget('ws://[::1]:3001'), { host: '::1', port: 3001 });
  assert.deepEqual(parseProbeTarget('ws://[fe80::1]:3001'), { host: 'fe80::1', port: 3001 });
});

test('监听地址 0.0.0.0 / :: 换算成回环', () => {
  assert.deepEqual(parseProbeTarget('ws://0.0.0.0:3001'), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(parseProbeTarget('ws://[::]:3001'), { host: '127.0.0.1', port: 3001 });
});

test('配置坏掉 / 为空：兜底 127.0.0.1:3001，不抛异常', () => {
  for (const bad of ['', '   ', null, undefined, 'not a url', 'ws://', 'ws://host:abc', 'ws://host:70000']) {
    assert.deepEqual(parseProbeTarget(bad), { host: '127.0.0.1', port: 3001 }, `输入：${String(bad)}`);
  }
});

test('端口边界 1 / 65535 保留，越界兜底', () => {
  assert.deepEqual(parseProbeTarget('ws://host:1'), { host: 'host', port: 1 });
  assert.deepEqual(parseProbeTarget('ws://host:65535'), { host: 'host', port: 65535 });
  assert.deepEqual(parseProbeTarget('ws://host:0'), { host: '127.0.0.1', port: 3001 });
});
