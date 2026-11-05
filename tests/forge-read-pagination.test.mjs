// forge_read_file 分页
//
// 要证明的命题：大文件可以被**确定地分段读完**，而不是只能拿到前 N 行。
//
// 事故现场：自动适配一个 918 行的 index.js，模型反复读了 8 次都只能拿到
// 第 1–44 行与第 331–400 行（后者是它自己写回的部分），中间 640 行永远读不到，
// 11 轮 / 123 秒 / 0 文件改动。根因是 readFileTool 写死 `lines.slice(0, 400)`
// 且没有 offset 参数 —— 把 400 调成 1000 只是把同一件事推给下一个更大的文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readFileTool, READ_PAGE_DEFAULT_LINES, READ_PAGE_MAX_LINES, FORGE_TOOLS
} from '../src/harness/forge/forge-tools.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pagination-'));
const draftId = 'page-test';
const base = path.join(temp, 'plugin-data', 'extension-forge', 'staging', draftId);
fs.mkdirSync(base, { recursive: true });
const ctx = { dataRoot: temp, draftId };

// 918 行：每行带上自己的行号，读到哪一段一眼可验
const TOTAL = 918;
const lines = Array.from({ length: TOTAL }, (_, i) => `const line${i + 1} = ${i + 1};`);
fs.writeFileSync(path.join(base, 'index.js'), `${lines.join('\n')}\n`, 'utf8');

/** 从工具输出里取出正文行号（"  401| const line401 = 401;" 这种）。 */
function shownLineNumbers(text) {
  return [...text.matchAll(/^\s*(\d+)\|/gm)].map((m) => Number(m[1]));
}

test('918 行文件：不传参只回前 400 行，并明确告知还有多少行、下次用哪个 offset', () => {
  const out = readFileTool(ctx, { path: 'index.js' });
  assert.ok(!out.isError, out.content);
  const nums = shownLineNumbers(out.content);
  assert.equal(nums.length, READ_PAGE_DEFAULT_LINES);
  assert.equal(nums[0], 1);
  assert.equal(nums[nums.length - 1], 400);
  assert.match(out.content, /共 918 行，本次显示 1–400/);
  // 关键：必须写出续读指引，否则模型只会用同样的参数重读
  assert.match(out.content, /还有 518 行未显示，用 offset=401 继续读/);
});

test('offset=401&limit=400 能读到 401-800 行（事故里永远拿不到的那一段）', () => {
  const out = readFileTool(ctx, { path: 'index.js', offset: 401, limit: 400 });
  const nums = shownLineNumbers(out.content);
  assert.equal(nums.length, 400);
  assert.equal(nums[0], 401);
  assert.equal(nums[nums.length - 1], 800);
  // 正文内容也要对得上：不是只有行号标对了
  assert.match(out.content, /const line401 = 401;/);
  assert.match(out.content, /const line800 = 800;/);
  assert.match(out.content, /共 918 行，本次显示 401–800/);
  assert.match(out.content, /还有 118 行未显示，用 offset=801 继续读/);
});

test('最后一段读到文件末尾时不再提示续读', () => {
  const out = readFileTool(ctx, { path: 'index.js', offset: 801, limit: 400 });
  const nums = shownLineNumbers(out.content);
  assert.equal(nums[0], 801);
  assert.equal(nums[nums.length - 1], TOTAL);
  assert.equal(nums.length, TOTAL - 801 + 1);
  assert.doesNotMatch(out.content, /未显示/);
  assert.match(out.content, /const line918 = 918;/);
});

test('三段接力能完整覆盖 918 行，无缺口无重复', () => {
  const seen = [];
  for (const offset of [1, 401, 801]) {
    seen.push(...shownLineNumbers(readFileTool(ctx, { path: 'index.js', offset, limit: 400 }).content));
  }
  assert.equal(seen.length, TOTAL);
  assert.deepEqual(seen, Array.from({ length: TOTAL }, (_, i) => i + 1));
});

test('limit 有上限（800），且非法参数退回默认值而不是报错', () => {
  const big = readFileTool(ctx, { path: 'index.js', limit: 5000 });
  assert.equal(shownLineNumbers(big.content).length, READ_PAGE_MAX_LINES);

  // 模型常见的手滑：0 / 负数 / 字符串 / 小数
  for (const bad of [0, -5, 'abc', 1.7]) {
    const out = readFileTool(ctx, { path: 'index.js', limit: bad, offset: bad });
    assert.ok(!out.isError, `limit/offset=${String(bad)} 不该报错：${out.content.slice(0, 80)}`);
    assert.equal(shownLineNumbers(out.content)[0], 1, `offset=${String(bad)} 应退回 1`);
  }
});

test('offset 超出文件末尾时给出可操作的提示，而不是空白', () => {
  const out = readFileTool(ctx, { path: 'index.js', offset: 5000 });
  assert.match(out.content, /共 918 行/);
  assert.match(out.content, /offset=1 从头读/);
});

test('工具 schema 暴露 offset / limit 并在描述里教模型分段读', () => {
  const def = FORGE_TOOLS.find((d) => d.id === 'forge_read_file');
  assert.ok(def);
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ['limit', 'offset', 'path']);
  assert.equal(def.parameters.required.length, 1);
  assert.equal(def.parameters.required[0], 'path');
  assert.match(def.description, /分段读/);
  assert.match(def.description, /offset/);
});
