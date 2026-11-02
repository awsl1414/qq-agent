// 前缀缓存哨兵：数据契约测试
//
// 为什么值得测：这一块是 UI 量表的唯一数据源，字段一漂（改名/漏算/排序反了）
// 界面上就是"空白"或"数字不对"，而空白看起来像"还没跑"，没人会去查 ——
// 正是 self-doctor 自己最爱抓的那类静默失败。
//
// 用临时目录造真实形态的 session 文件，不依赖本机数据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recentCacheRounds,
  prefixStaticAudit,
  buildSentinel,
  sentinelText
} from '../src/harness/doctor/cache-sentinel.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function mkData(sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s), 'utf8');
  }
  return root;
}

function session(id, at, prompt, cached, completion, extra = {}) {
  return {
    id,
    chatKey: 'group:1',
    startedAt: at,
    endedAt: at + 5000,
    status: 'ok',
    usage: {
      promptTokens: prompt,
      cachedTokens: cached,
      completionTokens: completion,
      totalTokens: prompt + completion,
      calls: extra.calls || 1,
      extra: extra.reasoning ? { reasoningTokens: extra.reasoning } : undefined
    }
  };
}

// ── 1. 没有 sessions 目录 ────────────────────────────────────────────────
console.log('\n缺失场景');
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-empty-'));
const miss = recentCacheRounds(emptyRoot, { limit: 5 });
ok(miss.missing === true && miss.rounds.length === 0, '目录不存在时 missing=true（UI 走空态提示）');
ok(Number.isFinite(miss.totals?.rate ?? NaN) === false, 'totals 为空对象，不编造 0%');

// ── 2. 正常三档 ─────────────────────────────────────────────────────────
console.log('\n正常统计');
// 故意乱序写入，验证内部按 startedAt 升序
const base = 1792680000000;
const data = mkData([
  session('c', base + 20000, 17000, 16800, 200),
  session('a', base, 10000, 9000, 100),
  session('b', base + 10000, 20000, 10000, 300, { calls: 2, reasoning: 120 })
]);
const r = recentCacheRounds(data, { limit: 10 });
ok(r.rounds.length === 3, '读到 3 轮', `实际 ${r.rounds.length}`);
ok(r.rounds[0].at < r.rounds[2].at, '按时间升序（左旧右新）');
ok(r.totals.prompt === 47000, 'prompt 合计正确', String(r.totals.prompt));
ok(r.totals.cached === 35800, 'cached 合计正确', String(r.totals.cached));
ok(r.totals.miss === 11200, 'miss = prompt - cached', String(r.totals.miss));
ok(r.totals.out === 600, '输出合计正确', String(r.totals.out));
ok(r.totals.reasoning === 120, '思考 token 单列', String(r.totals.reasoning));

// 未命中 token 只占 23.8%，但按价（miss 1 / hit 0.02）应占 ~97% 的输入成本
const share = r.totals.missCostShare;
const expect = 11200 / (11200 + 35800 * 0.02);
ok(Math.abs(share - expect) < 1e-9, 'missCostShare 按 1 : 0.02 计价', share.toFixed(4));
ok(share > 0.9, '本例未命中按价占九成以上（token 占比会严重低估它）');

// ── 3. 未跑完的会话不计入 ────────────────────────────────────────────────
console.log('\n脏数据');
const dirty = mkData([
  session('ok', base, 1000, 900, 10),
  { id: 'bad', chatKey: 'g', startedAt: base + 1, usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0 } },
  { id: 'nousage', chatKey: 'g', startedAt: base + 2 }
]);
const rd = recentCacheRounds(dirty, { limit: 10 });
ok(rd.rounds.length === 1, 'prompt=0 / 无 usage 的会话被跳过', `实际 ${rd.rounds.length}`);

// ── 4. limit 截断取最近 N ───────────────────────────────────────────────
console.log('\n窗口截断');
const many = mkData(Array.from({ length: 12 }, (_, i) => session(`s${i}`, base + i * 1000, 1000, 900, 10)));
const rl = recentCacheRounds(many, { limit: 5 });
ok(rl.rounds.length === 5, 'limit=5 只返回 5 轮');
ok(rl.rounds[4].at === base + 11000, '保留的是最新 5 轮（末轮最新）', String(rl.rounds[4].at));
ok(rl.totals.rounds === 5, 'totals.rounds 与实际条数一致');

// ── 5. buildSentinel 结构 ───────────────────────────────────────────────
console.log('\n快照结构');
const snap = buildSentinel({ dataDir: data, appRoot: emptyRoot, limit: 10 });
ok(typeof snap.at === 'number' && snap.at > 0, 'at 为时间戳');
ok(snap.rounds?.rounds?.length === 3, 'rounds 区块带着明细');
ok(snap.statics && Array.isArray(snap.statics.sections), 'statics.sections 是数组（空目录也得是数组）');
ok(snap.headline && typeof snap.headline.level === 'string', 'headline.level 存在');
ok(['good', 'warn', 'bad', 'unknown'].includes(snap.headline.level), 'level 取值受控', snap.headline.level);
ok(snap.headline.rate > 0.7 && snap.headline.level === 'bad', '命中率 76% 判为 bad（阈值：≥95 good / ≥85 warn）', `${snap.headline.rate} / ${snap.headline.level}`);

// ── 6. 文本版（喂给模型的那份）──────────────────────────────────────────
console.log('\n文本版');
const text = sentinelText(snap);
ok(text.includes('最近 3 轮'), '文本里带轮次');
ok(text.includes('未命中'), '文本里带未命中');
ok(text.includes('启发式'), '文本明确标注静态判断是启发式（防止模型把猜测当事实）');
ok(sentinelText(null) === '（无数据）', '空输入不崩');

// ── 7. 静态体检：appRoot 不存在时安静返回 ───────────────────────────────
console.log('\n静态体检容错');
const audit = prefixStaticAudit(path.join(emptyRoot, '不存在'));
ok(audit.sections.length === 0 && audit.suspect === 0, '目录不存在时不抛错、返回空');

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
if (fail) { console.log('失败用例：', failures.join('；')); process.exitCode = 1; }
