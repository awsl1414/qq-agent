// 内置壁纸模块（src/wallpaper/）冒烟测试 —— 2026-10-23 内置化时补。
//
// 覆盖四件事：
//   1. 能力面完整（plugin.json 声明 == providers 实现，防漂移）；
//   2. 工具注册受 llmControl 控制：默认 0 个，打开后 8 个且带 wallpaper__ 前缀；
//   3. promptSections 默认空、打开后两个段存在且引用的工具名与真实注册名一致；
//   4. 白名单门禁 + 无 WE 环境下的降级路径不抛错。
//
// ⚠️ 2026-10-24：壁纸默认不再进对话（llmControl 默认 false）。原因见
//    src/wallpaper/index.js 的 llmExposed 注释 —— 每轮固定 1358 tok，实测 0 次调用。
//    下面凡是要拿到工具的用例，config 里都必须显式给 llmControl: true。
//
// ⚠️ 数据目录必须指到临时目录：theme.js 的同步/登记表、core.js 的扫描缓存都写
//    DATA_DIR。用动态 import 而不是静态 —— 静态 import 会在设 env 之前就把
//    config.js 求值完，DATA_DIR 会钉死在真实 data/ 上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-wp-test-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const wp = await import('../src/wallpaper/index.js');
const chat = await import('../src/wallpaper/chat.js');
const engine = await import('../src/wallpaper/engine.js');
const manifest = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'wallpaper', 'plugin.json'), 'utf8'));

test('能力面：manifest 声明与 providers 实现一一对应', () => {
  const declared = [...manifest.capabilities].sort();
  const implemented = Object.keys(wp.providers).sort();
  assert.deepEqual(implemented, declared);
  // 9 个能力：库/文件/状态×2/导入×3（core）+ 主题同步（theme）+ 桌面换壁纸（engine）
  assert.equal(implemented.length, 9);
  for (const name of implemented) assert.equal(typeof wp.providers[name], 'function', name);
});

/** 造一个最小 skill api（config 用给定设置）。 */
function makeApi(settings, tools) {
  return {
    config: () => settings,
    log: () => {}, warn: () => {}, error: () => {},
    capability: (name, args) => (wp.providers[name] ? wp.providers[name](args) : undefined),
    registerTool: (def) => { tools.push(def); return `wallpaper__${def.id}`; }
  };
}

test('默认（llmControl=false）：一个工具都不注册', () => {
  const tools = [];
  wp.setup(makeApi(manifest.settings, tools));
  assert.deepEqual(tools.map((t) => t.id), [], '默认不该把壁纸暴露给模型');
  assert.equal(wp.llmToolsEnabled(), false);
});

test('llmControl=true：注册 8 个工具，全部带 wallpaper__ 前缀', () => {
  const tools = [];
  wp.setup(makeApi({ ...manifest.settings, llmControl: true }, tools));
  assert.equal(wp.llmToolsEnabled(), true);
  const ids = tools.map((t) => t.id).sort();
  assert.deepEqual(ids, [
    'adjust', 'list', 'off', 'set',
    'wallpaper_control', 'wallpaper_list', 'wallpaper_set', 'wallpaper_theme'
  ]);
  // 每个工具都有 execute 和 parameters（模型调用契约）
  for (const t of tools) {
    assert.equal(typeof t.execute, 'function', t.id);
    assert.ok(t.parameters && t.parameters.type === 'object', t.id);
    assert.ok(t.name && t.description, t.id);
  }
});

test('promptSections：默认空；打开 llmControl 后两段存在且工具名对得上', () => {
  // 上一个用例已把模块状态置为 true；这里先验"关掉就是空"
  wp.setup(makeApi(manifest.settings, []));
  assert.deepEqual(wp.promptSections(), [], '默认不该往系统提示里塞壁纸段');

  wp.setup(makeApi({ ...manifest.settings, llmControl: true }, []));
  const secs = wp.promptSections();
  assert.deepEqual(secs.map((s) => s.id), ['wallpaper-chat-note', 'wallpaper-engine']);
  const chatSec = secs[0].content;
  const engineSec = secs[1].content;
  // 段里点名的工具必须真的存在（改名前先改段，否则模型调到不存在的函数）
  for (const name of ['wallpaper__set', 'wallpaper__adjust', 'wallpaper__list']) {
    assert.ok(chatSec.includes(name), `壁纸管家段缺少 ${name}`);
  }
  for (const name of ['wallpaper__wallpaper_list', 'wallpaper__wallpaper_set',
    'wallpaper__wallpaper_control', 'wallpaper__wallpaper_theme']) {
    assert.ok(engineSec.includes(name), `小红车段缺少 ${name}`);
  }
  // 静态段：不读配置、无易变标记（前缀缓存要求字节稳定）
  assert.ok(!secs.some((s) => s.volatile));
});

test('白名单门禁：默认上锁，返回 not_allowed 与指引', async () => {
  const tools = [];
  const api = makeApi({ ...manifest.settings, llmControl: true }, tools);
  wp.setup(api);
  const set = tools.find((t) => t.id === 'set');
  const r = await set.execute({ triggerSenderId: '12345' }, { title: '初音' });
  const payload = JSON.parse(r.content);
  assert.equal(payload.not_allowed, true);
  assert.match(r.content, /白名单/);
});

test('白名单放行后能走通（ capability 冒烟 ）', async () => {
  const tools = [];
  const api = makeApi({ ...manifest.settings, llmControl: true, whitelist: '12345' }, tools);
  wp.setup(api);
  const list = tools.find((t) => t.id === 'list');
  // 本机可能没装 WE：两种结果都算通过（不抛错 + 结构正确），有装则 items 是数组
  const r = await list.execute({ triggerSenderId: '12345' }, {});
  // ⚠️（2026-10-24 修）库不可用时工具按本模块约定返回**纯文本 isError**（err()），
  //    不是 JSON —— 原测试无条件 JSON.parse，在没装 WE 的机器上必红。装不装 WE
  //    都该验的是"没被门禁拦"，JSON 结构只在库可用时验。
  if (r.isError) {
    assert.ok(!/白名单/.test(String(r.content)), '白名单内不该被门禁拦');
    return;
  }
  const payload = JSON.parse(r.content);
  assert.ok(!payload.not_allowed, '白名单内不该被门禁拦');
  if (payload.count !== undefined) assert.ok(Array.isArray(payload.titles));
});

test('降级路径：无 WE 时能力不抛错', async () => {
  const lib = await wp.providers['wallpaper.library']();
  assert.equal(typeof lib.ok, 'boolean');
  assert.ok(Array.isArray(lib.items));
  if (!lib.ok) assert.match(lib.error, /Wallpaper Engine/);
  const sync = await wp.providers['wallpaper.theme-sync']({ force: true });
  assert.equal(typeof sync.ok, 'boolean');
  const st = await wp.providers['wallpaper.state.get']();
  assert.equal(st.ok, true);
});

test('生命周期：activate → dispose 不抛错（定时器能起能收）', () => {
  wp.activate({ reason: 'test' });
  wp.deactivate({ reason: 'test' });
  wp.dispose();
});

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
