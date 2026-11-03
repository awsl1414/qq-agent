import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-allowlist-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const key = 'group:123';
const allow = () => updateConfig({ allow: { groups: ['123'] }, allowAllWhenEmpty: false });
const revoke = () => updateConfig({ allow: { groups: [] }, allowAllWhenEmpty: false });

function queue() {
  const calls = [];
  const records = [];
  const onebot = Object.fromEntries(['sendText', 'sendImage', 'sendSticker', 'sendSegments', 'sendPoke'].map((name) => [name, async () => {
    calls.push(name);
    return { message_id: calls.length };
  }]));
  return { sender: new SendQueue({ onebot, store: { appendSelf: (...args) => records.push(args) } }), calls, records };
}

test('文本入队后撤销白名单，尚未发送的消息被拒绝且不留成功记录', async () => {
  allow();
  const { sender, calls, records } = queue();
  const pending = sender.sendTextBatch(key, ['hello']);
  revoke();
  await assert.rejects(pending, /白名单/);
  assert.deepEqual(calls, []);
  assert.deepEqual(records, []);
});

for (const [name, send] of [
  ['分段文字', (s) => s.sendTextBatch(key, ['first', 'second'])],
  ['图片', (s) => s.sendImage(key, { url: 'https://example.invalid/image.png' })],
  ['表情', (s) => s.sendSticker(key, { id: '1', url: 'file:///missing.png' })],
  ['媒体', (s) => s.sendMedia(key, [{ type: 'video', data: { file: 'movie.mp4' } }])],
  ['拍一拍', (s) => s.poke(key, '456')]
]) {
  test(`${name}发送延迟中撤销白名单，恢复执行后不得调用协议端`, async (t) => {
    allow();
    const { sender, calls, records } = queue();
    let delayed = false;
    t.mock.method(globalThis, 'setTimeout', (callback) => {
      delayed = true;
      revoke();
      queueMicrotask(callback);
      return { unref() {} };
    });
    await assert.rejects(send(sender), /白名单/);
    assert.equal(delayed, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(records, []);
  });
}

test('媒体首发失败期间撤销白名单，不得通过 base64 回退再次发送', async (t) => {
  allow();
  const file = path.join(temp, 'picture.png');
  fs.writeFileSync(file, 'image bytes');
  t.mock.method(globalThis, 'setTimeout', (callback) => { queueMicrotask(callback); return null; });
  let attempts = 0;
  const records = [];
  const sender = new SendQueue({
    onebot: { sendSegments: async () => { attempts++; revoke(); throw new Error('local path unavailable'); } },
    store: { appendSelf: (...args) => records.push(args) }
  });
  await assert.rejects(sender.sendMedia(key, [{ type: 'image', data: { file } }]), /白名单/);
  assert.equal(attempts, 1);
  assert.deepEqual(records, []);
});
