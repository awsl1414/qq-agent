import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-concurrency-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { __testUsageDaily } = await import('../src/app.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('并发统计请求复用同一计算结果，强制刷新也能加入在途请求', async () => {
  const { buildUsageStats, resetUsageStatsCache } = __testUsageDaily();
  resetUsageStatsCache();
  const results = await Promise.all([
    buildUsageStats({ range: 'today' }),
    buildUsageStats({ range: 'today' }),
    buildUsageStats({ range: 'today', force: true })
  ]);
  assert.equal(results[0].range, 'today');
  assert.equal(results[0].totals.totalTokens, 0);
  assert.strictEqual(results[1], results[0]);
  assert.strictEqual(results[2], results[0]);
});
