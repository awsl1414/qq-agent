// 工具集批量静默期（2026-10-23）
//
// 要证明的核心命题：**一次插件重扫产生 N 次工具集增长时，只让模型看见 1 次变化**。
//
// 背景（"新加插件后缓存爆炸"的真实成因）：plugin-loader 的 loadSkillRoot 串行
// await 每个插件，setup() 在 import 期间注册工具，于是 N 个插件 = N 次增长；
// 而安装流程里每次 setSkillEnabled / trustedPlugins 都会 updateConfig → epoch+1，
// 让粘滞窗作废、立即生效。活跃群聊的请求撞上每一级中间态 = N 次 17k 全价重算。
//
// 对照组（未加 batch）会明确看到 3 次 transition —— 那就是 3 次击穿。

import {
  stabilizeToolset,
  resetToolsetSticky,
  beginToolsetBatch,
  endToolsetBatch,
  peekToolsetBatch
} from '../src/tool-registry.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const base = Array.from({ length: 22 }, (_, i) => `core_${String(i).padStart(2, '0')}`);
const stage1 = [...base, 'pluginA__do'];
const stage2 = [...stage1, 'pluginB__do', 'pluginB__list'];
const stage3 = [...stage2, 'pluginC__do', 'pluginC__reset'];

// ── 对照组：没有 batch，且每次增长都伴随一次配置写入（epoch+1）──────────────
// 模拟"装 3 个插件"过程中群里有消息进来，每个中间态都被一个请求看见。
console.log('\n对照组：无 batch + epoch 每级递增（= 现状）');
resetToolsetSticky();
let transitions = 0;
stabilizeToolset(base, { scope: 'g', epoch: 0 });              // 基线
for (const [i, set] of [stage1, stage2, stage3].entries()) {
  const r = stabilizeToolset(set, { scope: 'g', epoch: i + 1 });
  if (r.transition) transitions++;
  if (r.suppressed) transitions += 0;
}
ok(transitions === 3, '三个中间态各击穿一次（共 3 次）', `实际 ${transitions} 次`);

// ── 实验组：同样的三点增长，包在 batch 里 ───────────────────────────────────
console.log('\n实验组：batch 包住整轮扫描');
resetToolsetSticky();
transitions = 0;
let suppressed = 0;
stabilizeToolset(base, { scope: 'g', epoch: 0 });
beginToolsetBatch();
for (const [i, set] of [stage1, stage2, stage3].entries()) {
  const r = stabilizeToolset(set, { scope: 'g', epoch: i + 1 });
  if (r.transition) transitions++;
  if (r.suppressed) suppressed++;
  ok(r.ids.length === base.length, `第 ${i + 1} 次中间态仍发旧集合（${base.length} 个）`);
}
endToolsetBatch();

const after = stabilizeToolset(stage3, { scope: 'g', epoch: 3 });
if (after.transition) transitions++;
ok(suppressed === 3, '三次中间态全部被吸收');
ok(transitions === 1, '全程只击穿一次（扫描结束后）', `实际 ${transitions} 次`);
ok(after.ids.length === stage3.length, '结束后按最终集合生效', `实际 ${after.ids.length} 个`);
ok(after.ids.includes('pluginC__reset'), '新装插件的工具确实到位');

// ── 首次启动：batch 期间没有基线时必须建基线，否则整轮没有工具 ─────────────
console.log('\n边界：boot 首扫（无基线）');
resetToolsetSticky();
beginToolsetBatch();
const boot = stabilizeToolset(base, { scope: 'boot', epoch: 0 });
endToolsetBatch();
ok(!boot.suppressed && boot.ids.length === base.length, '无基线时照常建立（不吞掉全部工具）');

// ── 安全例外：batch 期间工具全不可用，必须立即跟随 ─────────────────────────
console.log('\n边界：全部工具消失');
resetToolsetSticky();
stabilizeToolset(base, { scope: 'g', epoch: 0 });
beginToolsetBatch();
const empty = stabilizeToolset([], { scope: 'g', epoch: 1 });
endToolsetBatch();
ok(!empty.suppressed && empty.ids.length === 0, '空集立即生效（不沿用幽灵工具）');

// ── 嵌套：watcher 外层 + reloadSkills 内层，内层归零不生效 ─────────────────
console.log('\n边界：两层嵌套');
resetToolsetSticky();
stabilizeToolset(base, { scope: 'g', epoch: 0 });
beginToolsetBatch();                       // watcher 的 runReload
beginToolsetBatch();                       // reloadSkills（preloaded 路径）
const mid = stabilizeToolset(stage2, { scope: 'g', epoch: 1 });
endToolsetBatch();                         // 内层结束
const stillHeld = stabilizeToolset(stage2, { scope: 'g', epoch: 1 });
endToolsetBatch();                         // 外层结束
const released = stabilizeToolset(stage2, { scope: 'g', epoch: 1 });
ok(mid.suppressed, '内层仍然吸收');
ok(stillHeld.suppressed, '内层归零但外层未结束 → 继续吸收');
ok(!released.suppressed && released.ids.length === stage2.length, '外层结束后才生效');

// ── 回退：batch 结束后的行为与旧逻辑一致（后续增长走 90s 粘滞窗）───────────
console.log('\n一致性：batch 之外仍是粘滞窗');
resetToolsetSticky();
stabilizeToolset(base, { scope: 'g', epoch: 0 });
const drift = stabilizeToolset(stage1, { scope: 'g', epoch: 0 });   // 无 epoch 变化
ok(drift.suppressed && drift.ids.length === base.length, '普通漂移被 90s 窗吸收（未回归）');

// ── 日志卫生：扫描期间集合没变，不能报"变化暂不生效" ──────────────────────
console.log('\n日志卫生：无变化时静默');
resetToolsetSticky();
stabilizeToolset(base, { scope: 'g', epoch: 0 });
beginToolsetBatch();
const quiet = stabilizeToolset(base, { scope: 'g', epoch: 1 });     // 集合没变
const releasedQuiet = endToolsetBatch();
ok(!quiet.suppressed && quiet.transition === null, '无变化时 suppressed=false（不打日志）');
ok(releasedQuiet.absorbed === 0, 'absorbed 计数为 0（不虚报）', `实际 ${releasedQuiet.absorbed}`);

// ── 吸收计数：3 次中间差异 → absorbed=3 ────────────────────────────────────
console.log('\n计数：absorbed 对应"原本会击穿几次"');
resetToolsetSticky();
stabilizeToolset(base, { scope: 'g', epoch: 0 });
beginToolsetBatch();
stabilizeToolset(stage1, { scope: 'g', epoch: 1 });
stabilizeToolset(stage2, { scope: 'g', epoch: 2 });
stabilizeToolset(stage2, { scope: 'g', epoch: 2 });                 // 重复的同一态不重复计
stabilizeToolset(stage3, { scope: 'g', epoch: 3 });
const releasedCount = endToolsetBatch();
ok(releasedCount.absorbed === 3, 'absorbed=3（重复态不重复计）', `实际 ${releasedCount.absorbed}`);
ok(releasedCount.scopes === 1, 'scopes=1（只有一个会话桶）');

// ── 诊断接口 ───────────────────────────────────────────────────────────────
console.log('\n诊断：peekToolsetBatch');
beginToolsetBatch();
const peeked = peekToolsetBatch();
endToolsetBatch();
ok(peeked.active && peeked.depth === 1, 'peek 报告批次进行中');
ok(peekToolsetBatch().active === false, '结束后 active 归为 false');

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} passed, ${fail} failed`);
if (fail) { console.log('失败用例：', failures.join('；')); process.exitCode = 1; }
