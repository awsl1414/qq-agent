// 模型解读的四段解析（问题 / 方案 / 收益 / 代价）
//
// 为什么必须测：这段正则决定"送去修复"时塞给修复模型的文本对不对。
// 解析错位（比如把收益塞进问题）会让修复方向整个跑偏，而且界面看起来
// 一切正常 —— 典型的静默错误。
//
// parseVerdict 住在 ui/app/13-doctor.js（浏览器侧，无模块导出），
// 这里用源码抽取的方式隔离测试。抽取失败会直接抛错，不会静默跳过。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../ui/app/13-doctor.js');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const src = fs.readFileSync(SRC, 'utf8');
const labels = src.match(/const VERDICT_LABELS = \{[\s\S]*?\};/);
const fnSrc = src.match(/function parseVerdict\(text\) \{[\s\S]*?\n\}/);
if (!labels || !fnSrc) {
  console.error('无法从 13-doctor.js 抽取 parseVerdict —— 函数被重命名或改写了？');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const parseVerdict = new Function(`${labels[0]}\n${fnSrc[0]}\nreturn parseVerdict;`)();

// ── 1. 标准格式（提示词要求的就是这个）──────────────────────────────────
console.log('\n标准【】格式');
const std = parseVerdict([
  '【问题】表情包段随库存翻字，整条前缀重算。',
  '【方案】把该段标 volatile 或加降档滞回。',
  '【收益】每天省 1.8 万 tok。',
  '【代价】滞回窗口内策略可能滞后 10 分钟。'
].join('\n'));
ok(std.structured === true, '识别为结构化');
ok(std.problem.includes('表情包段'), '问题段归位', std.problem);
ok(std.plan.includes('volatile'), '方案段归位', std.plan);
ok(std.benefit.includes('1.8 万'), '收益段归位', std.benefit);
ok(std.cost.includes('滞后'), '代价段归位', std.cost);

// ── 2. 三种容错写法 ─────────────────────────────────────────────────────
console.log('\n容错：markdown / 加粗 / 中文冒号');
const md = parseVerdict('## 问题\n命中率掉到 48%。\n## 方案\n改 promptSections。\n## 收益\n省 9000 tok。\n## 代价\n无明显代价。');
ok(md.structured && md.problem.includes('48%') && md.plan.includes('promptSections'), 'markdown 标题可解析');

const bold = parseVerdict('**问题**：段内容不稳定。\n**方案**：加节流。\n**收益**：省钱。\n**代价**：略慢。');
ok(bold.structured && bold.plan.includes('节流') && bold.cost.includes('略慢'), '加粗标题可解析');

const colon = parseVerdict('问题：库存翻字。\n方案：加滞回。\n收益：省 token。\n代价：无。');
ok(colon.structured && colon.problem.includes('库存') && colon.benefit.includes('省 token'), '中文冒号可解析');

// ── 3. 降级：不会因为格式没守就丢结论 ───────────────────────────────────
console.log('\n降级');
const free = parseVerdict('命中率 97.1%，看起来正常，未命中主要来自尾部滚动。建议先观察。');
ok(free.structured === false, '自由文本不强行结构化');
ok(free.raw.includes('尾部滚动'), '原文完整保留（UI 退回整段展示）');
ok(!free.problem && !free.plan, '不编造段落内容');

const empty = parseVerdict('');
ok(empty.structured === false && empty.raw === '', '空输入不崩');

const one = parseVerdict('【问题】只有一个标题');
ok(one.structured === false, '只认出一段时不认为结构化（避免把正文误当方案）');

// ── 4. 缺段：缺失本身是信息，不能补假话 ─────────────────────────────────
console.log('\n缺段');
const noCost = parseVerdict('【问题】段不稳定。\n【方案】加节流。\n【收益】省 9000 tok。');
ok(noCost.structured === true, '有问题+方案即可结构化');
ok(noCost.cost === '', '代价缺失时留空（UI 显示"模型未给出"，不编造）');

// ── 5. 顺序颠倒也要按标签归位，不按出现顺序 ─────────────────────────────
console.log('\n乱序');
const reorder = parseVerdict('【代价】要重启。\n【收益】省钱。\n【方案】加滞回。\n【问题】翻字。');
ok(reorder.problem.includes('翻字') && reorder.plan.includes('滞回'), '按标签归位而非按位置');
ok(reorder.benefit.includes('省钱') && reorder.cost.includes('重启'), '收益/代价也没有串位');

// ── 6. 多行正文保留换行 ─────────────────────────────────────────────────
console.log('\n多行正文');
const multi = parseVerdict('【问题】第一行。\n第二行。\n【方案】改这里。');
ok(multi.problem.includes('第二行'), '段落内换行被保留');

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
if (fail) { console.log('失败用例：', failures.join('；')); process.exitCode = 1; }
