import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-entrypoints-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { createRoutes } = await import('../src/routes.js');
const { createApp } = await import('../src/app.js');
const { skillManager } = await import('../src/skills/manager.js');
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('控制台测试发送也执行统一队列准入，拒绝时不留成功档案', async () => {
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: [], users: [] } });
  let sent = 0, recorded = 0;
  const onebot = { sendText: async () => { sent++; return { message_id: 9 }; } };
  const store = { appendSelf() { recorded++; } };
  const sender = new SendQueue({ onebot, store });
  const routes = createRoutes({ onebot, store, sender, emit() {}, readBody: async () => ({ text: 'test' }) });
  const pathname = '/api/chats/group_123/test-send';
  const route = routes.find((r) => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test(pathname));
  let response;
  await route.handler({ req: {}, res: {}, match: pathname.match(route.pattern), json: (_res, status, data) => { response = { status, data }; } });
  assert.equal(response.status, 502);
  assert.equal(sent, 0);
  assert.equal(recorded, 0);
});

for (const hook of ['onMessage', 'onRecall']) {
  test(`${hook} 的 sendSegments 在钩子等待后仍校验当前准入`, async (t) => {
    t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
    t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
    t.mock.method(globalThis, 'clearTimeout', () => {});
    t.mock.method(globalThis, 'clearInterval', () => {});
    updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], users: [] } });
    const app = createApp();
    let sent = 0;
    t.mock.method(app.onebot, 'sendSegments', async () => { sent++; return { message_id: 9 }; });
    const observed = Promise.withResolvers();
    t.mock.method(skillManager, 'runHook', async (name, ctx) => {
      if (name !== hook) return;
      updateConfig({ allow: { groups: [], users: [] } });
      try {
        await ctx.sendSegments('group', '123', [{ type: 'text', data: { text: 'hook' } }]);
        observed.resolve({ rejected: false });
      } catch (error) { observed.resolve({ rejected: true, error }); }
    });
    try {
      await app.onebot.onEvent(hook === 'onRecall'
        ? { post_type: 'notice', notice_type: 'group_recall', group_id: 123, message_id: 456, user_id: 2, self_id: 1 }
        : { post_type: 'message', message_type: 'group', group_id: 123, message_id: 457, user_id: 2, self_id: 1, raw_message: 'hello', message: 'hello', sender: { user_id: 2, nickname: 'test' } });
      const result = await observed.promise;
      assert.equal(result.rejected, true);
      assert.equal(sent, 0);
    } finally { await app.stop(); }
  });
}
