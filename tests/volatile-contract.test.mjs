/**
 * 易变段（volatile）三段契约测试 —— 2026-10-23
 *
 * 背景：把【表情包策略】从系统提示挪进【当前状态说明】需要三个环节同时成立，
 * 任何一环断掉都**没有任何报错**，只能靠 [body-lcp] 事后发现缓存又掉档：
 *
 *   ① 插件声明        plugins/sticker/index.js 的 promptSections 返回 volatile:true
 *   ② 收集期透传      src/skills/manager.js 的动态分支是逐字段重建对象，
 *                     不显式带上 volatile 就会被静默丢弃（本次真踩到的坑）
 *   ③ 渲染期识别      src/prompt.js 的 isVolatileSection + deferVolatile 分支
 *
 * ①② 用静态断言守着（都是几行的对象字面量，改动风险低但要防手滑），
 * ③ 真跑一次 buildSystemPrompt 做行为断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSystemPrompt, renderVolatileSections, isVolatileSection } from '../src/prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const read = (p) => readFileSync(join(APP, p), 'utf8');

// ── ③ 渲染期（行为断言）────────────────────────────────────────────────────

test('volatile:true 的段被拆出系统提示、改由 volatileOut 承接', () => {
  const sections = [
    { id: 'sticker-strategy', title: '表情包', priority: 62, volatile: true, content: '【表情包策略：测试】' },
    { id: 'other', title: '其他', priority: 50, content: '静态内容-不要动' }
  ];
  const volatileOut = { sections: [] };
  const sys = buildSystemPrompt({
    persona: { botName: '测试', roleText: '', participation: 'normal' },
    skillContext: {},
    extraSections: sections,
    deferVolatile: true,
    volatileOut
  });
  assert.equal(sys.includes('【表情包策略'), false, '策略段不该再出现在系统提示里');
  assert.equal(sys.includes('静态内容-不要动'), true, '静态段必须留在系统提示里');
  assert.deepEqual(volatileOut.sections.map((s) => s.id), ['sticker-strategy']);
  const block = renderVolatileSections(volatileOut.sections);
  assert.equal(block.startsWith('【当前状态说明】'), true);
  assert.equal(block.includes('【表情包策略'), true);
});

test('只有严格的 true 才算易变（"false"/1 之类不算）', () => {
  assert.equal(isVolatileSection({ id: 'x', volatile: true }), true);
  assert.equal(isVolatileSection({ id: 'x', volatile: 'true' }), false);
  assert.equal(isVolatileSection({ id: 'x', volatile: 1 }), false);
  assert.equal(isVolatileSection({ id: 'thinking-note' }), true, '白名单仍然有效');
});

test('deferVolatile=false 时策略段留在系统提示（其它调用方不受影响）', () => {
  const sections = [{ id: 'sticker-strategy', title: '表情包', priority: 62, volatile: true, content: '【表情包策略：测试】' }];
  const sys = buildSystemPrompt({
    persona: { botName: '测试', roleText: '', participation: 'normal' },
    skillContext: {}, extraSections: sections, deferVolatile: false
  });
  assert.equal(sys.includes('【表情包策略'), true);
});

// ── ① 插件声明（静态断言）──────────────────────────────────────────────────

test('sticker 插件把策略段声明为 volatile', () => {
  const src = read('plugins/sticker/index.js');
  const at = src.indexOf("id: 'sticker-strategy'");
  assert.ok(at > 0, '找不到 sticker-strategy 段');
  const block = src.slice(at, src.indexOf('}]', at));
  assert.match(block, /volatile:\s*true/, 'sticker-strategy 段必须带 volatile: true');
});

// ── ② 收集期透传（静态断言）────────────────────────────────────────────────

test('manager 的动态片段分支保留 volatile 字段', () => {
  const src = read('src/skills/manager.js');
  const at = src.indexOf('promptSections(context)');
  assert.ok(at > 0, '找不到动态片段分支');
  const block = src.slice(at, src.indexOf('} catch', at));
  assert.match(block, /s\.volatile === true/, '逐字段重建时必须显式带上 volatile');
});
