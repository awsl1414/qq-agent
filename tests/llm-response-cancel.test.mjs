import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-response-cancel-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { chatCompletion } = await import('../src/llm.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('响应头已返回、响应体仍在读取时，中止保留原始取消原因', async (t) => {
  const controller = new AbortController();
  const reason = new Error('会话已被用户中止');
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(reason);
    })
  }));
  await assert.rejects(chatCompletion({
    messages: [{ role: 'user', content: 'hello' }],
    signal: controller.signal,
    overrides: { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'test', protocol: 'openai' }
  }), (error) => error === reason);
});
