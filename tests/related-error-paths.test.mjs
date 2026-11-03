import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'related-errors-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { fetchModelsFrom, testModelChat } = await import('../src/providers.js');
const { listModels } = await import('../src/llm.js');
const { updateConfig } = await import('../src/config.js');
const { detectModelVision } = await import('../src/vision-scan.js');
const { OneBotClient } = await import('../src/onebot.js');
const { publishModule } = await import('../src/market.js');
const { logger } = await import('../src/logger.js');
const searches = await import('../src/web-search.js');
const { refreshPriceFeed, setPriceFeedTestUrl } = await import('../src/price-feed.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const endpoint = { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'test' };
for (const method of ['current-models', 'provider-models', 'chat-test', 'vision', 'onebot', 'publish']) {
  test(`正文读取失败不伪造成功或空内容：${method}`, async (t) => {
    const reason = new Error('body connection reset');
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: true, status: 200,
      text: async () => { throw reason; }, json: async () => { throw reason; }
    }));
    if (method === 'chat-test') {
      const result = await testModelChat(endpoint);
      assert.equal(result.ok, false);
      assert.match(result.note, /body connection reset/);
    } else if (method === 'vision') {
      const result = await detectModelVision(endpoint);
      assert.equal(result.verdict, 'unknown');
      assert.match(result.note, /body connection reset/);
    } else {
      let run;
      if (method === 'current-models') {
        updateConfig({ api: { ...endpoint, protocol: 'openai' } });
        run = () => listModels();
      } else if (method === 'provider-models') run = () => fetchModelsFrom(endpoint.baseUrl, '');
      else if (method === 'onebot') {
        const client = new OneBotClient({ wsUrl: 'ws://localhost', httpUrl: 'http://localhost' });
        run = () => client.call('get_login_info');
      } else {
        // 空目录夹具，不访问或上传用户扩展；fetch 已被本测试替换。
        t.mock.method(fs, 'existsSync', () => true);
        t.mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
        t.mock.method(fs, 'readdirSync', () => []);
        run = () => publishModule({ kind: 'skill', id: 'fixture' });
      }
      await assert.rejects(run(), (error) => error === reason);
    }
  });
}

test('日志裁剪读取失败关闭已打开句柄并保留原文件', (t) => {
  const dir = path.join(temp, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'large.log');
  fs.writeFileSync(file, 'keep');
  const stat = fs.statSync;
  const open = fs.openSync;
  const close = fs.closeSync;
  let opened, closed = false;
  t.mock.method(fs, 'statSync', (p, ...args) => p === file ? { size: 300 * 1024 * 1024, mtimeMs: Date.now() } : stat(p, ...args));
  t.mock.method(fs, 'openSync', (...args) => (opened = open(...args)));
  t.mock.method(fs, 'readSync', () => { throw new Error('read failed'); });
  t.mock.method(fs, 'closeSync', (fd) => { closed = fd === opened; return close(fd); });
  logger.prune();
  try { assert.equal(closed, true); }
  finally { if (!closed) close(opened); }
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

for (const name of ['deepSeekSearch', 'zhipuSearch', 'bochaSearch', 'baiduSearch', 'metasoSearch', 'customSearch', 'price-feed']) {
  for (const syntax of [false, true]) {
    test(`${name} 区分传输错误和 JSON 语法错误（syntax=${syntax}）`, async (t) => {
      const reason = syntax ? new SyntaxError('invalid token') : new Error('body connection reset');
      t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => { throw reason; } }));
      updateConfig({ webSearch: {
        ...Object.fromEntries(['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'].map((id) => [id, { apiKey: 'fixture' }])),
        custom: { baseUrl: 'https://example.invalid/search', type: 'openai' }
      } });
      if (name === 'price-feed') {
        setPriceFeedTestUrl('https://example.invalid/prices');
        try {
          const result = await refreshPriceFeed();
          assert.equal(result.ok, false);
          assert.match(result.error, syntax ? /JSON/ : /body connection reset/);
        } finally { setPriceFeedTestUrl(); }
      } else {
        await assert.rejects(searches[name]('fixture'), (error) => syntax ? /JSON/.test(error.message) : error === reason);
      }
    });
  }
}
