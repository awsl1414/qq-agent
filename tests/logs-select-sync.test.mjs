// 日志页筛选控件的显示同步契约（回归：切换筛选后按钮文案停在旧值）。
//
// 根因：logsSetSelect 重建 <option> 后，原生 select 会自动选中第一项；
// 若「要选的值」恰好也是第一项，sel.value === value 成立 → 旧实现提前 return，
// 不派发 change，而自绘下拉（00-core.js enhanceOneSelect）的文案只在 change 上
// 更新，于是按钮永远显示旧文案（首屏是空白按钮）。
//
// 这里把 logsSetSelect / logsModuleItems 从源码切出来，在 vm 里用最小 DOM 替身
// 跑纯逻辑（与 tests/readiness-single-source.test.mjs 同一手法），断言：
//   1. 值没变化也要同步文案（走 sel._selSyncHead，不派发 change）；
//   2. 重建 options 后落值正确；
//   3. 选中的模块不在统计里时，下拉仍有这一项（否则会退成空白按钮）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/app/20-logs.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start > 0, `20-logs.js 里找不到 ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `20-logs.js 里找不到 ${endMarker} 之后的边界`);
  return source.slice(start, end);
}

const logsSetSelectSource = slice('function logsSetSelect(sel, value, items)', 'function logsSyncToolbar(');
const logsModuleItemsSource = slice('function logsModuleItems()', 'function logsDateItems(');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 最小 <select> 替身：innerHTML 赋值 = 重建 options 并把 selectedIndex 归零
 * （真实浏览器行为），value 读写按 option.value 匹配，未命中时 selectedIndex = -1。
 */
function makeSelect() {
  const sel = {
    dataset: {},
    options: [],
    selectedIndex: -1,
    syncHeadCalls: 0,
    changeEvents: 0,
    get value() {
      const opt = this.options[this.selectedIndex];
      return opt ? opt.value : '';
    },
    set value(v) {
      const i = this.options.findIndex((o) => o.value === String(v));
      this.selectedIndex = i;
    },
    set innerHTML(html) {
      const re = /<option value="([^"]*)">([^<]*)<\/option>/g;
      const opts = [];
      for (const m of html.matchAll(re)) opts.push({ value: unesc(m[1]), text: unesc(m[2]) });
      this.options = opts;
      this.selectedIndex = opts.length ? 0 : -1;
    },
    dispatchEvent() { this.changeEvents += 1; return true; }
  };
  sel._selSyncHead = () => { sel.syncHeadCalls += 1; };
  return sel;
}

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function runLogsSetSelect(sel, value, items) {
  const ctx = vm.createContext({ esc });
  vm.runInContext(logsSetSelectSource, ctx);
  return vm.runInContext('logsSetSelect', ctx)(sel, value, items);
}

function runLogsModuleItems(logsState) {
  const ctx = vm.createContext({
    logsState,
    logsFamily: (mod) => {
      const i = mod.indexOf(':');
      return i > 0 ? mod.slice(0, i) : mod;
    }
  });
  vm.runInContext(logsModuleItemsSource, ctx);
  return vm.runInContext('logsModuleItems', ctx)();
}

const ITEMS = [
  { value: '', label: '全部模块' },
  { value: 'app', label: 'app（44）' }
];

test('值没变化也要同步自绘下拉文案，且不派发 change', () => {
  const sel = makeSelect();
  // 首次落值：'' 恰好是第一项，重建后 selectedIndex 已是 0 → 旧实现在这里提前 return
  runLogsSetSelect(sel, '', ITEMS);
  assert.equal(sel.selectedIndex, 0);
  assert.equal(sel.value, '');
  assert.equal(sel.syncHeadCalls, 1, '必须调用一次同步点');
  assert.equal(sel.changeEvents, 0, '程序化落值不应派发 change（会触发业务 reload）');
});

test('重建 options 后选中值落到正确项，文案同步', () => {
  const sel = makeSelect();
  runLogsSetSelect(sel, 'app', ITEMS);
  assert.equal(sel.selectedIndex, 1);
  assert.equal(sel.value, 'app');
  assert.equal(sel.syncHeadCalls, 1);

  // 选项集合没变（sig 相同）时改值，同样要同步
  runLogsSetSelect(sel, '', ITEMS);
  assert.equal(sel.selectedIndex, 0);
  assert.equal(sel.syncHeadCalls, 2);
  assert.equal(sel.changeEvents, 0);
});

test('选项集合变化时重建，并重新落值', () => {
  const sel = makeSelect();
  runLogsSetSelect(sel, 'app', ITEMS);
  const grown = [...ITEMS, { value: 'skill', label: 'skill:*（11）' }];
  runLogsSetSelect(sel, 'skill', grown);
  assert.deepEqual(sel.options.map((o) => o.value), ['', 'app', 'skill']);
  assert.equal(sel.value, 'skill');
  assert.equal(sel.changeEvents, 0);
});

test('选中的模块不在统计里时仍然出现在选项中', () => {
  const state = { module: 'ghost', moduleCounts: new Map([['app', 3]]) };
  const items = runLogsModuleItems(state);
  assert.ok(items.some((it) => it.value === 'ghost'), '缺项会让下拉退成空白按钮');
  assert.equal(items.find((it) => it.value === 'ghost').label, 'ghost');
});

test('模块统计为空时至少保留「全部模块」', () => {
  const items = runLogsModuleItems({ module: '', moduleCounts: new Map() });
  // vm 里的数组属于另一个 realm，原型不同，用结构化值比较
  assert.deepEqual(JSON.parse(JSON.stringify(items)), [{ value: '', label: '全部模块' }]);
});

test('选项集合只由分布快照决定：切换模块、输入关键字都不改变选项', () => {
  const counts = new Map([['app', 94], ['skill:sticker', 3], ['skill:weather', 2]]);
  const plain = (items) => JSON.parse(JSON.stringify(items.map(({ value, label }) => ({ value, label }))));
  const all = plain(runLogsModuleItems({ module: '', q: '', moduleCounts: counts }));
  const selected = plain(runLogsModuleItems({ module: 'skill', q: '', moduleCounts: counts }));
  const searched = plain(runLogsModuleItems({ module: 'skill', q: 'sticker', moduleCounts: counts }));
  // 这三份快照是同一天同一批级别算出来的：用户选了哪个模块、输了什么关键字，
  // 都不能让选项塌缩（旧缺陷的根因就是选项来自「当前已加载数据」）。
  assert.deepEqual(selected, all);
  assert.deepEqual(searched, all);
  assert.deepEqual(all, [
    { value: '', label: '全部模块' },
    { value: 'skill', label: 'skill:*（5）' },
    { value: 'app', label: 'app（94）' }
  ]);
  // 选中族时仍是可读的「skill:*（5）」形式，而不是裸 skill
  assert.equal(selected.find((it) => it.value === 'skill').label, 'skill:*（5）');
  // 切回「全部模块」永远可达
  assert.ok(selected.some((it) => it.value === ''));
});
