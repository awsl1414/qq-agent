// 就绪判定只有一处：ui/app/00-core.js 的 assessReadiness。
//
// 四个读取方（体检卡 / 侧栏小标 / 新手引导 / 顶栏圆点）都必须取它按 key 的结论。
// 这里把 assessReadiness / readinessByKey 与侧栏的 settingsSidebarReady /
// settingsChipTitle / settingsMenuNeedsDot 切出来，在 vm 里跑纯函数（不引 DOM 框架，
// 与 tests/sent-image-preview.test.mjs 同一手法）。
//
// 重点回归：Base URL 只输入空格时 flags.baseUrl 必须为 false —— 顶栏曾用
// `!!cfg.api.baseUrl` 自算，把纯空格判成"配置已完成"，与体检卡的"还没有填接口地址"
// 同一时刻给出相反结论。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// ── 00-core.js：唯一判定来源 ────────────────────────────────────────────
const coreSource = fs.readFileSync(new URL('../ui/app/00-core.js', import.meta.url), 'utf8');
const coreStart = coreSource.indexOf('function assessReadiness(cfg, status)');
const coreEnd = coreSource.indexOf('// 横幅内容签名', coreStart);
assert.ok(coreStart > 0 && coreEnd > coreStart, '00-core.js 里找不到 assessReadiness / readinessByKey 段');

const core = vm.runInNewContext(
  `${coreSource.slice(coreStart, coreEnd)}
   ({ assessReadiness, readinessByKey })`
);

// ── 06-settings-render.js：侧栏小标的结论与文案 ─────────────────────────
const renderSource = fs.readFileSync(new URL('../ui/app/06-settings-render.js', import.meta.url), 'utf8');
const renderStart = renderSource.indexOf('function settingsSidebarReady()');
const renderEnd = renderSource.indexOf('function renderSettingsSidebar()', renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart, '06-settings-render.js 里找不到侧栏就绪段');

function loadSidebar(config, status) {
  const ctx = vm.createContext({
    state: { config, status },
    readinessByKey: core.readinessByKey
  });
  vm.runInContext(`${renderSource.slice(renderStart, renderEnd)}`, ctx);
  return (expr) => vm.runInContext(expr, ctx);
}

// ── 用例表：4 种 cfg × 2 种 status ─────────────────────────────────────
const ALLOW = { groups: ['1'], private: [] };
const BASE_CFG = {
  api: { baseUrl: 'https://api.example.com/v1', model: 'demo-model' },
  allow: { groups: [...ALLOW.groups], private: [] },
  allowAllWhenEmpty: false
};
const MISSING = {
  baseUrl: { ...BASE_CFG, api: { ...BASE_CFG.api, baseUrl: '' } },
  model: { ...BASE_CFG, api: { ...BASE_CFG.api, model: '' } },
  allow: { ...BASE_CFG, allow: { groups: [], private: [] }, allowAllWhenEmpty: false }
};
const STATUS_CASES = {
  'status=null': null,
  connected: { onebot: { connected: true, self: { nickname: '小鲸鱼' } } }
};

test('4 种 cfg × 2 种 status：ready 与各 key 的结论', () => {
  for (const [statusName, status] of Object.entries(STATUS_CASES)) {
    const obOk = !!status?.onebot?.connected;
    const cases = [
      ['缺 baseUrl', MISSING.baseUrl, { baseUrl: false, model: true, allow: true, onebot: obOk }],
      ['缺 model', MISSING.model, { baseUrl: true, model: false, allow: true, onebot: obOk }],
      ['缺 allow', MISSING.allow, { baseUrl: true, model: true, allow: false, onebot: obOk }],
      ['全齐', BASE_CFG, { baseUrl: true, model: true, allow: true, onebot: obOk }]
    ];
    for (const [name, cfg, expected] of cases) {
      const { ready, checks } = core.assessReadiness(cfg, status);
      const flags = core.readinessByKey(cfg, status);
      // 跨 vm realm 的对象 / 数组换成宿主 realm 的再比对（原型不同）
      assert.deepEqual({ ...flags }, expected, `${statusName} / ${name} → readinessByKey`);
      assert.equal(ready, expected.baseUrl && expected.model && expected.allow && expected.onebot,
        `${statusName} / ${name} → ready`);
      // checks 的 key 集合与顺序是消费方（体检卡按 key 取结论）依赖的稳定契约
      assert.deepEqual(Array.from(checks, (c) => c.key), ['baseUrl', 'model', 'allow', 'onebot']);
      assert.deepEqual(Array.from(checks, (c) => !!c.ok),
        [expected.baseUrl, expected.model, expected.allow, expected.onebot],
        `${statusName} / ${name} → checks.ok`);
    }
  }
});

test('白名单为空时开启「白名单为空时响应所有人」也算 allow 就绪', () => {
  const cfg = { ...BASE_CFG, allow: { groups: [], private: [] }, allowAllWhenEmpty: true };
  assert.equal(core.readinessByKey(cfg, null).allow, true);
  assert.equal(core.assessReadiness(cfg, null).ready, false, '其余三项未就绪时整体仍不 ready');});

test('回归：Base URL 为纯空格 → flags.baseUrl 为 false（顶栏与体检卡分歧的用例）', () => {
  for (const baseUrl of [' ', '   ', '\t', '\n  ']) {
    const cfg = { ...BASE_CFG, api: { ...BASE_CFG.api, baseUrl } };
    assert.equal(core.readinessByKey(cfg, null).baseUrl, false, `baseUrl=${JSON.stringify(baseUrl)}`);
    assert.equal(core.assessReadiness(cfg, null).ready, false);
    // 顶栏圆点 / 引导 / 侧栏都取同一个 key，结论必须同为 false
    const flags = loadSidebar(cfg, null);
    assert.equal(flags('settingsSidebarReady().api'), false, '侧栏「模型」小标不得判为就绪');
  }
  // 同理：纯空格模型名也不算已选
  const spaceModel = { ...BASE_CFG, api: { ...BASE_CFG.api, model: '  ' } };
  assert.equal(core.readinessByKey(spaceModel, null).model, false);
});

test('cfg 缺失（加载失败）时整体不 ready，且不抛错', () => {
  const { ready, checks } = core.assessReadiness(null, null);
  assert.equal(ready, false);
  assert.deepEqual(Array.from(checks, (c) => [c.key, c.ok]), [['config', false]]);
  // 状态未回来时按"未知"表述，不误报"机器人没连上"
  const offline = core.assessReadiness(BASE_CFG, null).checks.find((c) => c.key === 'onebot');  assert.equal(offline.ok, false);
  assert.match(offline.label, /正在读取/);
});

// ── 侧栏：结论合并 + 文案单一来源 ────────────────────────────────────────
test('settingsSidebarReady 把 baseUrl + model 合并成「模型」一项', () => {
  const flags = loadSidebar(BASE_CFG, STATUS_CASES.connected);
  assert.deepEqual(
    { ...flags('settingsSidebarReady()') },
    { api: true, onebot: true, allow: true }
  );
  const partial = loadSidebar(MISSING.model, null);
  assert.deepEqual({ ...partial('settingsSidebarReady()') }, { api: false, onebot: false, allow: true });
});

test('settingsChipTitle：文案与 ok 状态一一对应，未知 key 为空串', () => {
  const f = loadSidebar(BASE_CFG, null);
  assert.equal(f('settingsChipTitle("allow", false)'), '还没配白名单 —— 点这里去勾选');
  assert.equal(f('settingsChipTitle("allow", true)'), '已配置允许的群 / 好友');
  assert.equal(f('settingsChipTitle("onebot", true)'), 'QQ 已连上');
  assert.equal(f('settingsChipTitle("api", false)'), '还缺接口地址或模型 —— 点这里去填');
  assert.equal(f('settingsChipTitle("nope", false)'), '');
});

test('settingsMenuNeedsDot：三项按就绪结论点橙点，其余分区一律不点', () => {
  // 三项全未就绪：地址 / 模型为空 + 白名单为空 + OneBot 未连
  const pending = loadSidebar({ api: { baseUrl: '', model: '' }, allow: { groups: [], private: [] } }, null);
  assert.equal(pending('settingsMenuNeedsDot("allow", settingsSidebarReady())'), true);
  assert.equal(pending('settingsMenuNeedsDot("api", settingsSidebarReady())'), true);
  assert.equal(pending('settingsMenuNeedsDot("onebot", settingsSidebarReady())'), true);
  for (const id of ['persona', 'tools', 'media', 'backup', 'app']) {
    assert.equal(pending(`settingsMenuNeedsDot("${id}", settingsSidebarReady())`), false, id);
  }
  const ready = loadSidebar(BASE_CFG, STATUS_CASES.connected);
  assert.equal(ready('settingsMenuNeedsDot("allow", settingsSidebarReady())'), false);
});
