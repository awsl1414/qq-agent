// 击穿归因：算法测试
//
// 这块的价值全在"定位准不准"：报错一个段名，用户会去改错的插件。
// 所以每个分支都要有用例 —— 段内容变化 / 新增段 / 删除段 / 多段同时变 /
// 映射不到模块 / 窗口截断。
//
// 真实数据验证过的结论（2026-10-23，98 会话）：sticker 的「表情包」段
// 两次翻字，断点 4513/5507 与 4513/5623，miss 8,898 + 9,663。
// 这里用合成数据复现同样的形态。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sliceSections, firstSectionChange, sectionSlice, attributeBreaks, attributionText } from '../src/harness/doctor/cache-attribution.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HEAD = '你是群聊助手。\n';
const SYS_A = `${HEAD}▸ 表情包\n【表情包策略：暂时没有可用表情】\n- 库是空的\n▸ 发言人身份\n甲、乙\n`;
const SYS_B = `${HEAD}▸ 表情包\n【表情包策略：像真人一样用】\n- 时机：被戳\n▸ 发言人身份\n甲、乙\n`;

function mkData(list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'));
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  list.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, `s${String(i).padStart(3, '0')}.json`), JSON.stringify({
      id: s.id || `s${i}`,
      startedAt: s.at,
      systemPrompt: s.sys,
      userPrompt: s.user || '【过去状态】…\n\n【本次唤醒】…',
      usage: { promptTokens: s.prompt, cachedTokens: s.cached, completionTokens: s.out || 100 }
    }), 'utf8');
  });
  return root;
}

// ── 1. 分段 ─────────────────────────────────────────────────────────────
console.log('\n分段');
const secs = sliceSections(SYS_A);
ok(secs.length === 3, '切成 3 段（核心头部 + 2 个 ▸ 段）', String(secs.length));
ok(secs[0].title === '(核心头部)' && secs[0].idx === 0, '首段是核心头部，从 0 开始');
ok(secs[1].title === '表情包' && secs[1].idx === HEAD.length, '表情包段起点 = 头部长度', String(secs[1].idx));
ok(secs[2].title === '发言人身份', '第三段标题正确');

// ── 2. 段内容变化 ───────────────────────────────────────────────────────
console.log('\n段内容变化');
const c1 = firstSectionChange(SYS_A, SYS_B);
ok(c1?.title === '表情包', '定位到「表情包」段', c1?.title);
ok(c1?.change === 'changed', '类型为 changed');
ok(c1?.idx === HEAD.length, '断点就是该段起点（其后全部要重算）', String(c1?.idx));

// ── 3. 一字未动 ─────────────────────────────────────────────────────────
console.log('\n无变化');
ok(firstSectionChange(SYS_A, SYS_A) === null, '完全一致返回 null（这一轮没有插件责任）');

// ── 4. 新增段 ───────────────────────────────────────────────────────────
console.log('\n新增段');
const SYS_ADD = `${HEAD}▸ 表情包\n【表情包策略：暂时没有可用表情】\n- 库是空的\n▸ 待确认的自创扩展\n有 1 个草稿\n▸ 发言人身份\n甲、乙\n`;
const c2 = firstSectionChange(SYS_A, SYS_ADD);
ok(c2?.title === '待确认的自创扩展', '定位到新增的那一段', c2?.title);
ok(c2?.change === 'added', '类型为 added');
ok(SYS_ADD.slice(c2.idx).startsWith('▸ 待确认'), '断点位置 = 新段起点', SYS_ADD.slice(c2.idx, c2.idx + 10));

// ── 5. 删除段 ───────────────────────────────────────────────────────────
console.log('\n删除段');
const c3 = firstSectionChange(SYS_ADD, SYS_A);
ok(c3?.title === '待确认的自创扩展', '定位到被删的段', c3?.title);
ok(c3?.change === 'removed', '类型为 removed');

// ── 6. 多段同时变 → 只报最早的 ──────────────────────────────────────────
console.log('\n多段同时变');
const SYS_MULTI = `${HEAD}▸ 表情包\n【表情包策略：像真人一样用】\n- 时机：被戳\n▸ 发言人身份\n丙、丁\n`;
const c4 = firstSectionChange(SYS_A, SYS_MULTI);
ok(c4?.title === '表情包', '只报字节流里最早变的那段（表情包在发言人身份之前）', c4?.title);

// ── 7. 端到端：两次击穿 + 尾部轮次 ──────────────────────────────────────
console.log('\n端到端归因');
const base = 1792680000000;
const data = mkData([
  { at: base, sys: SYS_A, prompt: 17000, cached: 16800 },                      // 基线
  { at: base + 1000, sys: SYS_A, prompt: 17100, cached: 16700 },               // 尾部
  { at: base + 2000, sys: SYS_B, prompt: 17200, cached: 8300, out: 200 },      // 击穿①
  { at: base + 3000, sys: SYS_B, prompt: 17300, cached: 16900 },               // 尾部
  { at: base + 4000, sys: `${SYS_B}▸ 回忆旧事\n上周聊过 A\n`, prompt: 17400, cached: 8100 } // 击穿②（新增段）
]);
const attr = attributeBreaks({ dataDir: data, sectionOwner: { '表情包': 'sticker', '回忆旧事': 'mem-layered' } });
ok(attr.compared === 4, '对比 4 对相邻轮', String(attr.compared));
ok(attr.breaks.length === 2, '抓到 2 次击穿', String(attr.breaks.length));
ok(attr.breaks[0].module === 'sticker', '第一次归到 sticker', String(attr.breaks[0].module));
ok(attr.breaks[0].change === 'changed' && attr.breaks[0].title === '表情包', '第一次是表情包段内容变化');
ok(attr.breaks[1].module === 'mem-layered', '第二次归到 mem-layered', String(attr.breaks[1].module));
ok(attr.breaks[1].change === 'added', '第二次是新增段');

ok(attr.tail.rounds === 2, '尾部轮次 2（无插件责任）', String(attr.tail.rounds));
ok(attr.tail.miss === 800, '尾部 miss = 400 + 400（两次无系统变化轮次）', String(attr.tail.miss));
ok(attr.tail.medianMiss === 400, '尾部中位取偶数位（索引 1）', String(attr.tail.medianMiss));

ok(attr.byModule.length === 2, '按模块汇总 2 项');
ok(attr.byModule[0].miss >= attr.byModule[1].miss, '汇总按累计 miss 降序');

// ── 8. 映射不到模块 ─────────────────────────────────────────────────────
console.log('\n未知来源');
const attr2 = attributeBreaks({ dataDir: data, sectionOwner: {} });
ok(attr2.breaks[0].module === null, '没有映射时 module=null（UI 显示"未识别来源"，不编造）');
ok(attr2.breaks[0].title === '表情包', '但段名仍然保留，可人工判断');

// ── 9. 窗口截断 ─────────────────────────────────────────────────────────
console.log('\n窗口');
const attr3 = attributeBreaks({ dataDir: data, window: 2 });
ok(attr3.windowRounds === 2, 'window=2 只取 2 轮');
ok(attr3.compared === 1, '2 轮 → 1 对比较');

// ── 10. 不足两轮 ────────────────────────────────────────────────────────
console.log('\n数据不足');
const one = mkData([{ at: base, sys: SYS_A, prompt: 1000, cached: 900 }]);
const attr4 = attributeBreaks({ dataDir: one });
ok(attr4.compared === 0 && attr4.breaks.length === 0, '只有一轮时 compared=0');
ok(attributionText(attr4).includes('没有足够'), '文本版给出可读提示');

// ── 11. 空目录 ──────────────────────────────────────────────────────────
console.log('\n空目录');
const none = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-none-'));
const attr5 = attributeBreaks({ dataDir: none });
ok(attr5.scanned === 0 && attr5.breaks.length === 0, '没有 sessions 目录时安静返回');

// ── 12. 文本版 ──────────────────────────────────────────────────────────
console.log('\n文本版');
const txt = attributionText(attr);
ok(txt.includes('sticker') && txt.includes('18,000') === false, '文本含模块名');
ok(txt.includes('尾部成本'), '文本含尾部成本（防止只看击穿、忽略真正的日常开销）');
ok(txt.includes('tools 段不在本归因范围') || txt.includes('工具集变化不在本归因范围'), '文本声明覆盖边界');

// ── 13. drift 合并：会话内部翻字（会话间 diff 抓不到的那类）────────────
// 本机实测形态：98 个会话间 diff 一字未动，cache-guard 的 drift 抓到 2 次
// 「表情包」翻字 —— 全发生在会话内部。没有 B 数据源就会漏报。
console.log('\n漂移记录合并');
function withDrift(root, drift) {
  const dir = path.join(root, 'plugin-data', 'cache-guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ savedAt: base, drift }, null, 1), 'utf8');
  return root;
}
const dIntra = withDrift(mkData([
  { at: base, sys: SYS_A, prompt: 17000, cached: 16900 },
  { at: base + 5000, sys: SYS_A, prompt: 17000, cached: 16900 }
]), [{ at: base + 2500, chatKey: 'group:1', sections: ['表情包'], added: [], removed: [] }]);
const adIntra = attributeBreaks({ dataDir: dIntra, sectionOwner: { '表情包': 'sticker' } });
ok(adIntra.breaks.length === 1, '会话间相同 + drift 有记录 → 仍抓到 1 次击穿', String(adIntra.breaks.length));
ok(adIntra.breaks[0].source === 'drift', '来源标记为 drift（段名级，非字节级）');
ok(adIntra.breaks[0].module === 'sticker', 'drift 事件同样能归到模块');
ok(adIntra.breaks[0].at === base + 2500, '时间用 drift 记录的时刻', String(adIntra.breaks[0].at));
ok(adIntra.sources.drift === 1 && adIntra.sources.driftUsed === 1 && adIntra.sources.deduped === 0,
  '来源计数：读 1 / 用 1 / 判重 0', JSON.stringify(adIntra.sources));
ok(adIntra.tail.rounds === 1, '会话间无变化的轮仍计尾部（不重复计罪）', String(adIntra.tail.rounds));

// ── 14. 判重：同一事件不算两回 ────────────────────────────────────────
console.log('\n判重');
const dDup = withDrift(mkData([
  { at: base, sys: SYS_A, prompt: 17000, cached: 16900 },
  { at: base + 5000, sys: SYS_B, prompt: 17200, cached: 8300 }
]), [{ at: base + 2500, chatKey: 'group:1', sections: ['表情包'], added: [], removed: [] }]);
const adDup = attributeBreaks({ dataDir: dDup, sectionOwner: { '表情包': 'sticker' } });
ok(adDup.breaks.length === 1, '会话间 diff 已抓到 → drift 判重掉，只记 1 次', String(adDup.breaks.length));
ok(adDup.breaks[0].source === 'session', '保留字节级更好的那份');
ok(adDup.sources.deduped === 1 && adDup.sources.driftUsed === 0, '判重计数正确', JSON.stringify(adDup.sources));

// ── 15. before/after 与模块清单 ───────────────────────────────────────
console.log('\n字节级细节与模块清单');
const adFull = attributeBreaks({
  dataDir: data,
  sectionOwner: { '表情包': 'sticker', '回忆旧事': 'mem-layered' },
  moduleNames: { sticker: '表情系统' }
});
ok(adFull.breaks[0].before.includes('库是空的'), '改前预览取自旧轮存档', adFull.breaks[0].before);
ok(adFull.breaks[0].after.includes('时机：被戳'), '改后预览取自新轮存档', adFull.breaks[0].after);
ok(adFull.byModule.find((m) => m.module === 'sticker')?.name === '表情系统', '模块展示名透传');
ok(adFull.byModule.find((m) => m.module === 'sticker')?.sections.includes('表情包'), '汇总带涉及段名');
ok(adFull.sections.length === 4, '清单含全部 4 段（核心头部 + 3 个 ▸ 段）', String(adFull.sections.length));
const invEmo = adFull.sections.find((s) => s.title === '表情包');
ok(invEmo.module === 'sticker' && invEmo.chars > 0 && invEmo.flips === 1,
  '表情包段：归属 sticker、有体量、翻字 1 次', JSON.stringify(invEmo));
const invHead = adFull.sections.find((s) => s.title === '(核心头部)');
ok(invHead.module === null, '核心头部无归属模块（不编造）');
ok(Math.abs(adFull.sections.reduce((s, x) => s + x.share, 0) - 1) < 1e-9, '各段占比合计 100%');

// ── 16. 取段原文 ──────────────────────────────────────────────────────
console.log('\n取段原文');
ok(sectionSlice(SYS_A, '表情包').startsWith('▸ 表情包'), '按标题取段原文');
ok(sectionSlice(SYS_A, '不存在的段') === '', '段不存在返回空串');

// ── 17. drift 文件损坏不拖垮整份归因 ──────────────────────────────────
console.log('\n容错');
const dBroken = withDrift(mkData([
  { at: base, sys: SYS_A, prompt: 1000, cached: 900 },
  { at: base + 1000, sys: SYS_B, prompt: 1000, cached: 900 }
]), []);
fs.writeFileSync(path.join(dBroken, 'plugin-data', 'cache-guard', 'stats.json'), '{ 坏 JSON', 'utf8');
const adBroken = attributeBreaks({ dataDir: dBroken });
ok(adBroken.breaks.length === 1, 'drift 文件损坏不抛错，会话间 diff 仍工作', String(adBroken.breaks.length));
ok(adBroken.sources.drift === 0, '坏文件按 0 条处理（不猜）');

// ── 18. 预览窗口对准段内差异点（长段只改一行）─────────────────────────
// 实测形态：第二次翻字前后 90 字符完全一样（差异在段落后部）—— 从段首
// 截断会显得"什么都没变"，用户根本看不出谁干的。
console.log('\n差异点对准');
const LONG_HEAD = '▸ 长段\n第一行内容\n第二行内容\n第三行内容\n第四行内容\n第五行内容\n第六行内容\n第七行内容\n第八行内容\n第九行内容\n第十行内容\n';
const SYS_LONG_A = `${HEAD}${LONG_HEAD}▸ 发言人身份\n甲、乙\n`;
const SYS_LONG_B = `${HEAD}▸ 长段\n第一行内容\n第二行内容\n第三行内容\n第四行内容\n第五行内容\n第六行内容\n第七行内容\n第八行内容\n第九行内容\n第十行内容**改了这里**\n▸ 发言人身份\n甲、乙\n`;
const dLong = mkData([
  { at: base, sys: SYS_LONG_A, prompt: 10000, cached: 9900 },
  { at: base + 1000, sys: SYS_LONG_B, prompt: 10000, cached: 9900 }
]);
const adLong = attributeBreaks({ dataDir: dLong });
ok(adLong.breaks.length === 1 && adLong.breaks[0].title === '长段', '定位到长段', adLong.breaks[0]?.title);
ok(adLong.breaks[0].before.includes('第五行内容') && !adLong.breaks[0].before.includes('第一行'),
  '改前预览窗口落在差异点附近，不是段首', adLong.breaks[0].before);
ok(adLong.breaks[0].after.includes('改了这里'), '改后预览包含真正变的内容', adLong.breaks[0].after);

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
if (fail) { console.log('失败用例：', failures.join('；')); process.exitCode = 1; }
