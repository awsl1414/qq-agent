import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-vision-write-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, CONFIG_FILE, setRuntimeConfig } = await import('../src/config.js');
const { scanModelsVision } = await import('../src/vision-scan.js');
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('图片能力扫描：定时落盘失败通过扫描 Promise 上报，不能逃出定时器', async (t) => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const diskError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  let flushCallback;
  let cleared = 0;
  let timerRan = false;
  const timer = { unref() {} };
  t.mock.method(globalThis, 'setInterval', (callback) => { flushCallback = callback; return timer; });
  t.mock.method(globalThis, 'clearInterval', (handle) => {
    assert.equal(handle, timer);
    cleared += 1;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: '测试图' } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === CONFIG_FILE) throw diskError;
    return rename(from, to);
  });

  await assert.rejects(scanModelsVision({
    providers: [{ id: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test', models: ['model'] }],
    emit: () => {
      timerRan = true;
      assert.doesNotThrow(() => flushCallback(), 'I/O 故障不能成为 uncaughtException');
    }
  }), (error) => error === diskError);
  assert.equal(timerRan, true, '必须实际覆盖已有待落盘结果的定时器路径');
  assert.ok(cleared >= 1, '落盘失败后必须清理定时器');
});
