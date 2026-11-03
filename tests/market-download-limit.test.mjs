import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip } from '../src/zip-build.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'market-limit-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { downloadModuleZip } = await import('../src/market.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

for (const length of [null, '1', String(9 * 1024 * 1024)]) {
  test(`市场下载按实读字节限制并取消超限响应（Content-Length=${length}）`, async (t) => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        reads++;
        if (reads <= 12) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: length === null ? {} : { 'content-length': length } });
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(downloadModuleZip({ code: 'test' }), /8MB/);
    assert.equal(cancelled, true);
    assert.ok(reads <= 9, `不应读取剩余超限响应，实际读取 ${reads}MB`);
  });
}

test('市场下载正常大小的 ZIP 保留原字节并完成结构校验', async (t) => {
  const zip = buildZip([
    { name: 'skill.json', data: '{"id":"test"}' },
    { name: 'index.js', data: 'export const value = 1;' }
  ]);
  t.mock.method(globalThis, 'fetch', async () => new Response(zip));
  const result = await downloadModuleZip({ code: 'test' });
  assert.deepEqual(result.buffer, zip);
});
