// 闸门展示聚合（O1）+ 解包跳过原因（O10）
//
// 命题一：同一个规则在多个文件命中时，界面只需要一张卡；但**计数口径不能变**
//   —— blocking / confirm / digest 仍按逐条命中算，否则确认票据会与界面结论脱节。
// 命题二：解包时被丢掉的条目必须带结构化原因；体积超限意味着包不完整，
//   不能只在响应里留一句无人展示的字符串。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGates, groupIssues, draftDigest } from '../src/harness/forge/gate.js';
import {
  extractZipToDraft, DEFAULT_LIMITS, SKIP_REASONS
} from '../src/harness/forge/forge-tools.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-group-'));
const ctx = { dataRoot: temp, limits: { ...DEFAULT_LIMITS } };

/** 造一个草稿：manifest + 若干 index.js，内容由调用方给。 */
function makeDraft(id, files) {
  const base = path.join(temp, 'plugin-data', 'extension-forge', 'staging', id);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'skill.json'), JSON.stringify({
    id, name: '聚合测试', version: '1.0.0', apiVersion: 1, entry: 'index.js',
    description: 'test', enabledByDefault: false
  }));
  for (const [rel, text] of Object.entries(files)) {
    const fp = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text, 'utf8');
  }
  return base;
}

test('同 code 命中 3 个文件 → 聚合为 1 条，带 3 个命中位置', () => {
  const id = 'group-1';
  makeDraft(id, {
    'index.js': 'export function setup(api) {}\n',
    'lib/history.js': "import fs from 'node:fs';\nexport const a = 1;\n",
    'lib/image.js': "import fs from 'node:fs';\nexport const b = 2;\n",
    'lib/source.js': "import fs from 'node:fs';\nexport const c = 3;\n"
  });
  const gate = runGates(ctx, id);

  // 逐条：三处都要在（提示词回喂 / 自动修复按它处理）
  const raw = gate.issues.filter((i) => i.code === 'dangerous-import');
  assert.equal(raw.length, 3, 'issues 必须保留逐条命中');

  // 聚合：一条，三个位置
  const groups = gate.issueGroups.filter((g) => g.code === 'dangerous-import');
  assert.equal(groups.length, 1, '同一 code 只应出一条展示项');
  assert.equal(groups[0].files.length, 3);
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].files, [
    'lib/history.js:1', 'lib/image.js:1', 'lib/source.js:1'
  ]);
  // 标题用规则本名，文件名只在 files 里出现一次
  assert.equal(groups[0].title, '导入高危 Node 模块（fs / child_process / net / vm 等）');
  assert.ok(groups[0].why.length > 0, 'why 只显示一次，但不能丢');
});

test('聚合不改变 blocking / confirm / notice 计数与 digest', () => {
  const id = 'group-count';
  makeDraft(id, {
    'index.js': 'export function setup(api) {}\n',
    'lib/a.js': "import fs from 'node:fs';\nconst x = eval('1');\nfetch('http://x');\n",
    'lib/b.js': "import fs from 'node:fs';\nconst y = eval('2');\nfetch('http://y');\n",
    'lib/c.js': "import fs from 'node:fs';\nconst z = eval('3');\nfetch('http://z');\n"
  });
  const gate = runGates(ctx, id);

  // 计数口径 = 逐条命中（不是聚合后的组数）
  assert.equal(gate.blocking, gate.issues.filter((i) => i.level === 'block').length);
  assert.equal(gate.confirm, gate.issues.filter((i) => i.level === 'confirm').length);
  assert.equal(gate.notice, gate.issues.filter((i) => i.level === 'notice').length);
  // 三处高危导入 = 3 个 block（若误按组数算会变成 1）
  assert.equal(gate.blocking, 3);
  // 三处 eval + 三处 fetch = 6 个 confirm
  assert.equal(gate.confirm, 6);
  // 聚合后的组数明显更少 —— 这正是"界面变清爽"的量化
  assert.ok(gate.issueGroups.length < gate.issues.length);

  // digest 只由草稿内容决定：与聚合无关，但必须与同一份草稿的独立计算一致
  const base = path.join(temp, 'plugin-data', 'extension-forge', 'staging', id);
  assert.equal(gate.digest, draftDigest(base));
  // 再跑一次结论稳定（聚合结果不能随机序）
  const again = runGates(ctx, id);
  assert.deepEqual(again.issueGroups.map((g) => g.code), gate.issueGroups.map((g) => g.code));
});

test('不同 code 不合并，即使标题很像', () => {
  const issues = [
    { level: 'block', code: 'a', title: 'X（f.js:1）', why: 'w1', file: 'f.js', line: 1 },
    { level: 'block', code: 'b', title: 'X（f.js:2）', why: 'w1', file: 'f.js', line: 2 }
  ];
  const groups = groupIssues(issues);
  assert.equal(groups.length, 2);
});

test('同 code 不同级别时取最严（block 压过 confirm）', () => {
  const groups = groupIssues([
    { level: 'confirm', code: 'same', title: 'T（a.js:1）', why: 'w', file: 'a.js', line: 1 },
    { level: 'block', code: 'same', title: 'T（b.js:1）', why: 'w', file: 'b.js', line: 1 }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].level, 'block');
  assert.deepEqual(groups[0].files, ['a.js:1', 'b.js:1']);
});

test('无文件位置的问题（结构类）不伪造 files，标题保持原样', () => {
  const groups = groupIssues([
    { level: 'block', code: 'no-manifest', title: '缺少清单文件', why: '必须有一个 skill.json' }
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files, []);
  assert.equal(groups[0].title, '缺少清单文件');
});

// ── O10：解包跳过原因 ──────────────────────────────────────────────────────

/** 假的 parseZip：直接返回给定条目，绕过真 zip 编码（本测试只关心跳过逻辑）。 */
const fakeParse = (entries) => () => entries.map(([name, size]) => ({
  name, data: Buffer.alloc(size, 0x61)
}));

test('单文件超限：skipped 带 path / size / reason=single-file-too-large', () => {
  const id = 'zip-single';
  const out = extractZipToDraft(ctx, id, Buffer.alloc(0), fakeParse([
    ['skill.json', 64],
    ['index.js', 128],
    ['lib/dict.json', 1.5 * 1024 * 1024]     // 1.5MB > 256KB
  ]));
  assert.equal(out.ok, true);
  assert.deepEqual(out.files.sort(), ['index.js', 'skill.json']);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].path, 'lib/dict.json');
  assert.equal(out.skipped[0].reason, SKIP_REASONS.FILE_TOO_LARGE);
  assert.equal(out.skipped[0].size, 1.5 * 1024 * 1024);
});

test('总体积超限：被丢的条目逐个记账（含因 break 而未处理的后续条目）', () => {
  const id = 'zip-total';
  const entries = [['skill.json', 64], ['index.js', 128]];
  // 8 × 200KB = 1.6MB > 1MB 总上限
  for (let i = 1; i <= 8; i++) entries.push([`part${i}.json`, 200 * 1024]);
  const out = extractZipToDraft(ctx, id, Buffer.alloc(0), fakeParse(entries));

  assert.equal(out.ok, true);
  const lost = out.skipped.filter((s) => s.reason === SKIP_REASONS.TOTAL_TOO_LARGE);
  // 1MB 上限、已用 192B → 只放得下 5 个 200KB（=1000KB），剩下 3 个因总量被拒
  assert.equal(lost.length, 3, `实际 skipped：${JSON.stringify(out.skipped)}`);
  assert.deepEqual(lost.map((s) => s.path), ['part6.json', 'part7.json', 'part8.json']);
  // 每个都有 size，界面才能显示"1.5MB"这种量级
  assert.ok(lost.every((s) => s.size === 200 * 1024));
});

test('打包杂质与路径拒绝也带原因，且不混进体积类', () => {
  const id = 'zip-misc';
  const out = extractZipToDraft(ctx, id, Buffer.alloc(0), fakeParse([
    ['skill.json', 64],
    ['index.js', 128],
    ['__MACOSX/._index.js', 32],
    ['notes.exe', 64]                       // 后缀不在白名单 → path-rejected
  ]));
  const byPath = Object.fromEntries(out.skipped.map((s) => [s.path, s.reason]));
  assert.equal(byPath['__MACOSX/._index.js'], SKIP_REASONS.PACKAGING_JUNK);
  assert.equal(byPath['notes.exe'], SKIP_REASONS.PATH_REJECTED);
});

test('跳过项是结构化的（不是拼好的中文串）', () => {
  const out = extractZipToDraft(ctx, 'zip-shape', Buffer.alloc(0), fakeParse([
    ['skill.json', 64],
    ['index.js', 128],
    ['big.bin', 400 * 1024]
  ]));
  for (const s of out.skipped) {
    assert.equal(typeof s, 'object');
    assert.equal(typeof s.path, 'string');
    assert.equal(typeof s.reason, 'string');
    assert.equal(typeof s.size, 'number');
  }
});

// ── L4：语法 issue 必须带文件位置，聚合不能把多命中压成一条无位置结论 ──────

test('两个文件各有语法错 → 聚合项带两个位置、count=2、titles 全保留', () => {
  const id = 'syntax-two-files';
  makeDraft(id, {
    'index.js': 'export function setup(api) {}\n',
    'lib/a.js': 'export const a = ;\n',
    'lib/b.js': 'export const b = ;\n'
  });
  const gate = runGates(ctx, id);

  const raw = gate.issues.filter((i) => i.code === 'syntax-error');
  assert.equal(raw.length, 2, '逐条命中要保留两处');
  assert.deepEqual(raw.map((i) => i.file).sort(), ['lib/a.js', 'lib/b.js']);
  // node --check 的 stderr 第一行是 [stdin]:N，能解析出行号就该带上
  assert.ok(raw.every((i) => typeof i.line === 'number' || i.line === null));

  const groups = gate.issueGroups.filter((g) => g.code === 'syntax-error');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].files.map((f) => f.replace(/:\d+$/, '')).sort(), ['lib/a.js', 'lib/b.js']);
  assert.equal(groups[0].title, '语法错误', '文件名由 files 承载，标题不再带第一个文件');
  assert.deepEqual(groups[0].titles, ['语法错误（lib/a.js）', '语法错误（lib/b.js）']);
  assert.equal(gate.blocking, 2, '计数口径仍是逐条，不因聚合变 1');
});

test('缓存复用的分支同样带 file（第二次过闸命中内存缓存）', () => {
  const id = 'syntax-cache-file';
  makeDraft(id, {
    'index.js': 'export function setup(api) {}\n',
    'lib/only.js': 'export const broken = ;\n'
  });
  const first = runGates(ctx, id).issues.filter((i) => i.code === 'syntax-error');
  const second = runGates(ctx, id).issues.filter((i) => i.code === 'syntax-error');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(second[0].file, 'lib/only.js', '缓存命中也必须重建文件名');
  assert.equal(typeof second[0].title, 'string');
});

test('多命中但无 file 的聚合项：titles 保留全部逐条结论（展示层据此逐条列出）', () => {
  const groups = groupIssues([
    { level: 'confirm', code: 'missing-requires', title: '硬依赖缺失：cap.a', why: 'w' },
    { level: 'confirm', code: 'missing-requires', title: '硬依赖缺失：cap.b', why: 'w' },
    { level: 'confirm', code: 'missing-requires', title: '硬依赖缺失：cap.c', why: 'w' }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].files, []);
  assert.deepEqual(groups[0].titles, ['硬依赖缺失：cap.a', '硬依赖缺失：cap.b', '硬依赖缺失：cap.c']);
});

test('总量超限后的剩余条目按同一判据分类：垃圾/越界不算 total-too-large', () => {
  const id = 'zip-total-reclassify';
  const entries = [['pkg/skill.json', 64], ['pkg/index.js', 128]];
  for (let i = 1; i <= 6; i++) entries.push([`pkg/part${i}.json`, 200 * 1024]);
  // 总量耗尽（1MB）之后才出现的条目
  entries.push(['__MACOSX/._x.js', 64]);
  entries.push(['README.md', 16]);
  entries.push(['pkg/bin.exe', 64]);
  entries.push(['pkg/part7.json', 200 * 1024]);
  const out = extractZipToDraft(ctx, id, Buffer.alloc(0), fakeParse(entries));
  const byPath = Object.fromEntries(out.skipped.map((s) => [s.path, s.reason]));

  assert.equal(byPath['pkg/part7.json'], SKIP_REASONS.TOTAL_TOO_LARGE, '真被总量挡下的文件才记体积超限');
  assert.equal(byPath['__MACOSX/._x.js'], SKIP_REASONS.PACKAGING_JUNK);
  assert.equal(byPath['README.md'], SKIP_REASONS.OUTSIDE_ROOT);
  assert.equal(byPath['pkg/bin.exe'], SKIP_REASONS.PATH_REJECTED);
  // 红框用的体积类集合里不能出现打包垃圾/越界路径
  const sizeHits = out.skipped.filter((s) => s.reason === SKIP_REASONS.TOTAL_TOO_LARGE || s.reason === SKIP_REASONS.FILE_TOO_LARGE);
  assert.deepEqual(sizeHits.map((s) => s.path), ['pkg/part6.json', 'pkg/part7.json']);
});
