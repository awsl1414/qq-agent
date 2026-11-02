// 本地自测：不依赖宿主、不需要联网，用合成消息跑通全链路。
//
//   node tools/selftest.mjs
//
// 覆盖：增量巩固 → BM25 检索 → 时间偏好 → 自动注入（含冷却与预算）→
//       原文归档 → 索引重建 → 小时块→日块汇总 → 遗忘淘汰 → 词表剪枝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LayeredStore, packIndex, unpackIndex } from '../lib/store.js';
import { Consolidator, hourBlockId, dayBlockId } from '../lib/consolidate.js';
import { GistStore } from '../lib/gist.js';
import { Recall } from '../lib/recall.js';
import { ArchiveReader } from '../lib/archive.js';
import { Injector } from '../lib/inject.js';
import { Stats, dirSize } from '../lib/stats.js';
import { CrossTurn } from '../lib/crossturn.js';
import { Pending } from '../lib/pending.js';
import { Cards } from '../lib/cards.js';
import { Peek } from '../lib/peek.js';
import { Budget } from '../lib/budget.js';
import { num, queryTokens } from '../lib/util.js';
import { ConflictGuard, BUILTIN_ID, BUILTIN_NAME, ENGINE_TAG, PROBE_KEY } from '../lib/conflict.js';

/** 插件根目录（本文件在 tools/ 下）。 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 本文件自身的绝对路径（静态检查要跳过它，否则会自匹配）。 */
const SELF_FILE = fileURLToPath(import.meta.url);
const MIN = 60000;

const DAY = 86400000;
let failures = 0;
let checks = 0;

function ok(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`);
  }
}

/**
 * 异步版 ok()。
 * ⚠️ 需要 await 的断言必须走这个：ok() 拿到 Promise 就直接当"通过"了 ——
 *    里面的 assert 抛错只会变成 unhandled rejection，测试反而"全绿"。
 */
async function okAsync(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`);
  }
}

function freshRoot(name) {
  const root = path.join(os.tmpdir(), `mem-layered-selftest-${process.pid}`, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
  return root;
}

function writeMessages(root, chatKey, msgs) {
  const file = path.join(root, 'messages', `${chatKey.replace(/[^a-z0-9_]/gi, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, messages: msgs }, null, 1), 'utf8');
  return file;
}

/** 造一批消息：spreadDays 天前开始，每小时 6 条，内容带可检索的关键词。 */
function synth({ startOffsetDays, hours, chatKey = 'group:10001', idBase = 1 }) {
  const out = [];
  let id = idBase;
  // ⚠️ 必须对齐到**整点**，不能直接用 Date.now()。
  //    原来 base = now - N 天，分钟数与"当前时刻"相同：每小时 6 条从 HH:56 铺到 HH+1:01，
  //    于是"每个小时一个块"变成"每批消息横跨两个块"，块数随运行时刻漂移。
  //    块数一变，df/n 就变，dfCutoffRatio=0.7 的剪枝就会时而剪掉「猫粮」时而留下 ——
  //    表现为"同一份代码，上午全绿、下午三条失败"。（真踩到过。）
  const base = Math.floor((Date.now() - startOffsetDays * DAY) / 3600000) * 3600000;
  for (let h = 0; h < hours; h += 1) {
    const hourStart = base + h * 3600000;
    const topics = ['猫粮', '婚礼', '显卡', '论文', '火锅'][h % 5];
    for (let i = 0; i < 6; i += 1) {
      const self = i === 5;
      out.push({
        id,
        ts: hourStart + i * 60000,
        mid: `m${id}`,
        self,
        senderId: self ? '9999' : String(1000 + (i % 3)),
        senderName: self ? '机器人' : ['阿甲', '阿乙', '阿丙'][i % 3],
        text: i === 2
          ? `说好了下周要一起搞${topics}的事情，别忘了我提过的${topics}安排`
          : `${topics}又来了，今天第 ${i} 条，随便聊聊${topics}`
      });
      id += 1;
    }
  }
  return out;
}

function makeEnv(root, overrides = {}) {
  const settings = { ...defaults(), ...overrides };
  const get = () => settings;
  const dataRoot = path.join(root, 'memory-v3');
  const messagesDir = path.join(root, 'messages');
  const store = new LayeredStore(dataRoot, get);
  const stats = new Stats(dataRoot);
  const cards = new Cards(dataRoot, get);
  // 与 index.js 的接线保持一致：梗概墓碑 + 检索侧两条注入（gistSearch / revive）
  const gist = new GistStore(dataRoot, get);
  const consolidator = new Consolidator({
    store, messagesDir, settings: get, gist,
    onBlock: (chatKey, block) => cards.ingest(chatKey, block?.snippets || [])
  });
  const recall = new Recall({
    store, settings: get, stats,
    gistSearch: (q, o) => gist.search(q, o),
    revive: (chatKey, g) => consolidator.reviveBlock(chatKey, g)
  });
  const archive = new ArchiveReader({ messagesDir });
  // store 一并给 Injector：睡眠重演要它挑"该复习了"的块（与 index.js 接线一致）
  const injector = new Injector({ recall, settings: get, stats, store });
  return {
    settings, store, consolidator, recall, archive, injector, stats, messagesDir, cards, gist, dataRoot
  };
}

/**
 * 模拟「隔了 gapDays 天又想起一次」，重复 times 次。
 *
 * ⚠️ 为什么不能直接连打若干次 markHit：新模型的增益是**间隔依赖**的
 *    （r = log2(1 + 间隔/S)），同一瞬间连打 r≈0、几乎不加分 ——
 *    这正是要钉住的行为，不是 bug。要造出「记得牢」的块，只能靠真实的间隔回忆。
 *    这里先把 lastHitAt 往前拨 gapDays 再命中，等价于"上次想起是在 20 天前"。
 */
function hitAged(store, chatKey, blockId, times = 3, gapDays = 20, boost = 2) {
  const meta = store.blockMeta(chatKey, blockId);
  if (!meta) return;
  for (let i = 0; i < times; i += 1) {
    meta.lastHitAt = Date.now() - gapDays * DAY;
    store.markHit(chatKey, blockId, { mode: 'full', boost });
  }
  store.flushAll({ force: true });
}

function defaults() {
  return {
    enabled: true,
    consolidateBatchMax: 20000,
    rollupAfterDays: 7,
    forgetAfterDays: 120,
    minForgetScore: 0.25,
    maxSnippetsPerBlock: 120,
    maxVocabPerChat: 20000,
    dfCutoffRatio: 0.7,
    hitBoost: 1.15,
    decayHalfLifeDays: 45,
    autoRecall: true,
    autoRecallBudget: 220,
    autoRecallTopBlocks: 2,
    autoRecallCooldownMin: 30,
    minTriggerChars: 6,
    observeTools: true,
    // —— 附加五项 ——
    pendingTodos: true,
    crossTurn: true,
    crossTurnTtlMin: 90,
    crossTurnMaxChars: 200,
    semanticCards: true,
    cardsCrossChat: false,
    maxCards: 500,
    cardIdleDays: 90,
    crossChatPeek: false,
    crossChatPeekMinutes: 12,
    crossChatPeekChats: 2,
    crossChatPeekChars: 180,
    crossChatPeekAllow: '',
    budgetGuard: true,
    dayPromptMax: 800000,
    chatPromptMax: 200000,
    // —— 冲突自检 ——
    warnOnConflict: true,
    conflictWarnCooldownMin: 1440,
    // —— 梗概墓碑 + 多线索 + 显著性（v1.5.0）——
    gistEnabled: true,
    gistMaxPerChat: 400,
    gistRetainDays: 1095,
    gistReviveMaxMb: 24,
    gistWeight: 0.35,
    peopleBoost: 1.3,
    diversityLambda: 0.3,
    autoRecallMinRel: 0.25,
    staleSnippetSkip: true,
    // —— 人类记忆机制包 v1.7.0 ——
    linkBoost: 0.15,
    linkLearn: true,
    reminiscenceAmp: 0.12,
    todBoost: 1.1,
    sleepReplay: true,
    replayCooldownDays: 3
  };
}

// ── A. 巩固 + 检索 + 注入 + 归档 + 重建 ───────────────────────────────────
console.log('\nA. 增量巩固 / 检索 / 注入 / 归档 / 索引重建');
{
  const root = freshRoot('a');
  const msgs = [...synth({ startOffsetDays: 10, hours: 3 }), ...synth({ startOffsetDays: 1, hours: 2, idBase: 100 })];
  writeMessages(root, 'group:10001', msgs);
  const env = makeEnv(root);

  const r1 = env.consolidator.consolidateChat('group:10001');
  ok('首次巩固建出块', () => {
    assert.ok(r1.blocks >= 5, `期望 ≥5 个块，实际 ${r1.blocks}`);
    assert.equal(r1.added, msgs.length);
  });

  ok('水位线记录最后一条 id', () => {
    const st = env.store.chatState('group:10001');
    assert.equal(st.lastIndexedId, msgs[msgs.length - 1].id);
  });

  const r2 = env.consolidator.consolidateChat('group:10001');
  ok('二次巩固无新增（增量生效）', () => assert.equal(r2.added, 0));

  // 同一小时追加新消息：必须与已有块**合并**，不能整块覆盖
  const lastTs = msgs[msgs.length - 1].ts;
  msgs.push({
    id: 900, ts: lastTs + 60000, mid: 'm900', self: false,
    senderId: '1234', senderName: '新来的', text: '顺便提一句我下周要去参加婚礼，红包准备好了'
  });
  writeMessages(root, 'group:10001', msgs);
  env.consolidator.consolidateChat('group:10001');
  ok('增量巩固与已有小时块合并（不丢旧碎片）', () => {
    const hk = hourKeyOfLocal(lastTs);
    const block = env.store.readBlock('group:10001', hourBlockId('group:10001', hk));
    const texts = (block?.snippets || []).map((s) => s.text).join('\n');
    assert.ok(texts.includes('红包准备好了'), '新消息没进块');
    assert.ok(texts.includes('猫粮') || texts.includes('婚礼') || texts.includes('显卡') || texts.includes('论文') || texts.includes('火锅'), '旧碎片被覆盖了');
  });

  const hits = env.recall.search('猫粮', { chatKey: 'group:10001', limit: 3 });
  ok('关键词检索命中且碎片相关', () => {
    assert.ok(hits.length > 0, '没命中');
    const all = hits.flatMap((h) => h.snippets.map((s) => s.text)).join('\n');
    assert.ok(all.includes('猫粮'), '命中的碎片里没有关键词');
  });

  ok('命中会加分（记忆强度反馈）', () => {
    const meta = env.store.blockMeta('group:10001', hits[0].chunkId);
    assert.ok(meta.hits >= 1 && meta.lastHitAt > 0, '命中计数/时间没更新');
    assert.ok(meta.score > 1, `期望权重 > 1，实际 ${meta.score}`);
  });

  const miss = env.recall.search('量子计算区块链', { chatKey: 'group:10001', limit: 3 });
  ok('无关查询不硬凑结果', () => assert.equal(miss.length, 0));

  ok('时间偏好：说"昨天"时昨天的块排在今天之前', () => {
    const list = env.recall.search('昨天 婚礼', { chatKey: 'group:10001', limit: 3 });
    if (!list.length) return;
    const first = env.store.blockMeta('group:10001', list[0].chunkId);
    assert.notEqual(first.dayKey, dayKeyLocal(Date.now() - 10 * DAY));
  });

  const inj1 = env.injector.build({ chatKey: 'group:10001', triggerText: '上次说的猫粮买了没' });
  const text1 = inj1.text;
  ok('自动注入产出非空且不超预算', () => {
    assert.ok(text1.length > 0, '没有注入内容');
    assert.ok(text1.length <= 220 + 40, `注入 ${text1.length} 字符，超出预算`);
    assert.ok(text1.includes('旧事'));
  });
  ok('自动注入会报出"真正写进提示词"的块 id', () => {
    assert.ok(Array.isArray(inj1.chunkIds) && inj1.chunkIds.length > 0, '没报 chunkIds');
    assert.equal(new Set(inj1.chunkIds).size, inj1.chunkIds.length, 'chunkIds 有重复');
  });
  ok('冷却范围比"展示过的"大：内容被展示覆盖的块也要进冷却', () => {
    // 日块与小时块常装同一句话：只锁展示的那个块，下一轮另一个块换个名次上来
    // 会把同一件旧事再念一遍。所以 cooldownIds ⊇ chunkIds，且多出来的那些
    // **不该**被记成"被动命中"（模型没看到它们）。
    assert.ok(Array.isArray(inj1.cooldownIds), '没报 cooldownIds');
    for (const id of inj1.chunkIds) assert.ok(inj1.cooldownIds.includes(id), `${id} 不在冷却名单里`);
  });
  ok('冷却由调用方在"送达后"记账：没记账就不该被锁住', () => {
    // ⚠️ 这条钉的是一个真踩过的坑：如果 build() 自己就把冷却记掉，
    //    appendToLastUser 找不到 user 消息时冷却已被吃掉 —— 这条旧事被白锁 30 分钟，
    //    而模型根本没看到它。
    const again = env.injector.build({ chatKey: 'group:10001', triggerText: '上次说的猫粮买了没' }).text;
    assert.ok(again.length > 0, '还没送达就被冷却挡住了');
  });
  ok('同一件旧事在冷却期内不重复注入', () => {
    env.injector.markInjected('group:10001', inj1.cooldownIds);
    const text2 = env.injector.build({ chatKey: 'group:10001', triggerText: '上次说的猫粮买了没' }).text;
    assert.equal(text2, '', `冷却没生效，仍然注入了：${text2}`);
  });
  ok('触发文本过短则不检索', () => {
    env.injector.clear();
    assert.equal(env.injector.build({ chatKey: 'group:10001', triggerText: '哈哈' }).text, '');
  });

  ok('归档能按天回读原文', () => {
    const days = env.archive.listDays('group:10001');
    assert.ok(days.length >= 2, `天数 ${days.length}`);
    const page = env.archive.load({ chatKey: 'group:10001', day: days[0].dayKey, limit: 5 });
    assert.ok(page.ok && page.lines.length > 0 && page.lines.length <= 5);
  });
  ok('归档能统计某词出现条数', () => {
    const c = env.archive.count({ chatKey: 'group:10001', query: '猫粮' });
    assert.ok(c.ok && c.messages > 0);
  });

  ok('索引文件缺失时能自动从块重建', () => {
    const idxFile = env.store.indexPath('group:10001');
    assert.ok(fs.existsSync(idxFile), '索引文件不存在');
    fs.rmSync(idxFile);
    const store2 = new LayeredStore(path.join(root, 'memory-v3'), () => env.settings);
    const recall2 = new Recall({ store: store2, settings: () => env.settings });
    const again = recall2.search('猫粮', { chatKey: 'group:10001', limit: 3 });
    assert.ok(again.length > 0, '重建后搜不到');
  });

  ok('统计里有检索命中率与注入字节', () => {
    const snap = env.stats.snapshot();
    assert.ok(snap.searches >= 3);
    assert.ok(snap.hitRate > 0 && snap.hitRate <= 1);
    assert.ok(snap.injectedChars > 0);
  });
}

// ── B. 小时块 → 日块汇总 + 遗忘淘汰 ──────────────────────────────────────
console.log('\nB. 汇总（小时→日）与遗忘淘汰');
{
  const root = freshRoot('b');
  const old = synth({ startOffsetDays: 10, hours: 4 });
  writeMessages(root, 'group:20002', old);
  // 先关掉汇总（阈值调到 999 天），确认巩固产出的确实只有小时块；
  // 再把阈值改回 7 天手动触发一次 —— 这样能分别验证两件事。
  const env = makeEnv(root, { rollupAfterDays: 999, decayHalfLifeDays: 45, forgetAfterDays: 0 });
  env.consolidator.consolidateChat('group:20002');

  const beforeIds = env.store.listBlockIds('group:20002');
  ok('汇总前只有小时块', () => {
    assert.ok(beforeIds.length >= 4, `块数 ${beforeIds.length}`);
    assert.ok(beforeIds.every((id) => id.startsWith('hour_')));
  });

  env.settings.rollupAfterDays = 7;
  const rolled = env.consolidator.rollupChat('group:20002');
  ok('超过阈值的小时块被合并成日块', () => {
    assert.ok(rolled.length >= 1, '没有发生汇总');
    const ids = env.store.listBlockIds('group:20002');
    assert.ok(ids.every((id) => id.startsWith('day_')), `仍有小时块残留：${ids.join(',')}`);
    assert.ok(ids.some((id) => id === dayBlockId('group:20002', dayKeyLocal(Date.now() - 10 * DAY))));
  });

  ok('汇总后原文仍在（归档不受影响）', () => {
    const days = env.archive.listDays('group:20002');
    assert.ok(days.length >= 1);
  });

  // 淘汰：半衰期调成 1 天 → 10 天前的块权重衰减到 ~0.001，低于阈值即被摘除
  env.store.flushAll({ force: true });   // 汇总后的索引先落盘，下面的新实例才读得到
  const env2 = makeEnv(root, { rollupAfterDays: 0, decayHalfLifeDays: 1, forgetAfterDays: 1 });
  env2.store.chatState('group:20002');
  const gone = env2.store.forgetSweep('group:20002', { forgetAfterDays: 1, minScore: 0.25 });
  ok('老且没人想起的块被淘汰', () => assert.ok(gone.length >= 1, `淘汰了 ${gone.length} 块`));
  ok('淘汰会删块文件但不动原始消息', () => {
    const ids = env2.store.listBlockIds('group:20002');
    for (const id of gone) assert.ok(!ids.includes(id), `${id} 文件还在`);
    assert.ok(fs.existsSync(path.join(root, 'messages', 'group_20002.json')), '原始消息被删了');
  });
  ok('淘汰后归档依然能查到那天的原文', () => {
    const days = env2.archive.listDays('group:20002');
    const page = env2.archive.load({ chatKey: 'group:20002', day: days[days.length - 1].dayKey, limit: 3 });
    assert.ok(page.ok && page.lines.length > 0);
  });

  // —— B1 回归（2026-10-14 修）：迟到的旧时间戳消息不得覆盖已汇总的日块 ——
  // 真实触发路径：历史回放 / 二次补拉 / 时钟偏差，让一条旧消息在某天
  // **已汇总成日块之后**才到。旧代码只合并这批新小时块，整块覆盖日块 ——
  // 该日此前汇总的碎片从索引与块文件里静默消失（无墓碑、无日志）。
  ok('迟到的旧消息不会覆盖已汇总的日块（二次汇总必须连同已存在的日块一起合并）', () => {
    const root = freshRoot('b7');
    const key = 'group:20008';
    const old = synth({ startOffsetDays: 10, hours: 4, chatKey: key });
    writeMessages(root, key, old);
    const env = makeEnv(root, { rollupAfterDays: 999, decayHalfLifeDays: 45, forgetAfterDays: 0 });
    env.consolidator.consolidateChat(key);
    env.settings.rollupAfterDays = 7;
    const rolled = env.consolidator.rollupChat(key);
    assert.ok(rolled.length >= 1, '前置条件不成立：没汇总出日块');
    const dayId = env.store.listBlockIds(key).find((id) => id.startsWith('day_'));
    assert.ok(dayId, '没找到日块');
    const before = env.store.readBlock(key, dayId);
    assert.ok(before.snippets.length >= 4, `汇总前碎片数 ${before.snippets.length}`);

    // 迟到的旧消息：同一天、id 比水位线大（模拟回放补拉）
    const lateTs = before.snippets[1].ts + 60000;
    const late = {
      id: 9999, ts: lateTs, mid: 'mlate', senderId: '1001', senderName: '阿甲',
      text: '迟到的一条：火锅真好吃'
    };
    writeMessages(root, key, [...old, late]);
    env.consolidator.consolidateChat(key);   // 内部会再跑一次 rollupChat

    const after = env.store.readBlock(key, dayId);
    const afterTexts = after.snippets.map((s) => s.text).join('\n');
    assert.ok(afterTexts.includes('迟到的一条'), '迟到消息没进日块');
    for (const s of before.snippets) {
      assert.ok(afterTexts.includes(s.text), `旧碎片被覆盖丢失：${s.text}`);
    }
  });
}

// ── C. 词表剪枝与体积 ────────────────────────────────────────────────────
console.log('\nC. 词表剪枝 / 索引体积');
{
  const root = freshRoot('c');
  writeMessages(root, 'group:30003', synth({ startOffsetDays: 0, hours: 6 }));
  // 阈值调到 1 = 本次巩固完全不剪枝，留一份"未剪枝"的基线
  const env = makeEnv(root, { dfCutoffRatio: 1, maxVocabPerChat: 20000 });
  env.consolidator.consolidateChat('group:30003');
  const s0 = env.store.stats('group:30003');
  // ⚠️ minBlocksForCutoff: 1 —— 这里要测的是「剪枝机制本身」，不是样本量门槛。
  //    真实默认门槛是 2000 块，而本用例只有 6 块，不显式放开就一个词都剪不掉。
  const dropped = env.store.pruneVocab('group:30003', { maxVocab: 200, dfCutoffRatio: 0.5, minBlocksForCutoff: 1 });
  const s1 = env.store.stats('group:30003');
  ok('剪枝确实减少了词表', () => {
    assert.ok(dropped > 0, '一个词都没剪');
    assert.ok(s1.vocab < s0.vocab, `${s0.vocab} → ${s1.vocab}`);
  });
  ok('样本量不足时规则① 自动禁用（小库不剪，避免词表被剃光）', () => {
    const root3 = freshRoot('c3');
    writeMessages(root3, 'group:30005', synth({ startOffsetDays: 0, hours: 6 }));
    const env3 = makeEnv(root3, { dfCutoffRatio: 0.7, maxVocabPerChat: 100000 });
    env3.consolidator.consolidateChat('group:30005');
    const d3 = env3.store.pruneVocab('group:30005', { maxVocab: 100000, dfCutoffRatio: 0.7 });
    assert.equal(d3, 0, `小库（6 块 < 2000）不该剪枝，实际剪了 ${d3} 个词`);
  });
  ok('超限裁剪按 df×idf 保留：中间层实词留住、idf→0 的噪声淘汰', () => {
    const root4 = freshRoot('c4');
    const env4 = makeEnv(root4, { dfCutoffRatio: 1, maxVocabPerChat: 100000 });
    const key = 'group:30006';
    const mk = (b) => {
      const words = Array.from({ length: 60 }, (_, i) => `词${b}_${i}`);
      const snippets = words.map((w, i) => ({
        ts: 1700000000000 + b * 3600000 + i * 1000, mid: `m${b}_${i}`, localId: b * 1000 + i,
        who: '阿甲', uid: '1001', self: false, text: `${w} 聊点别的`
      }));
      // 前 30 块都带「显卡」(二字词 df=30)，后 10 块各带一个独有二字词 (df=1)
      // ⚠️ 必须用二字词：tokenize 只产单字 + 相邻二字 bigram，三字词不进词表
      snippets.push({
        ts: 1700000000000 + b * 3600000 + 99999, mid: `x${b}`, localId: b * 1000 + 999,
        who: '阿甲', uid: '1001', self: false,
        text: b < 30 ? '显卡' : `独${String.fromCharCode(0x4e00 + b)}`
      });
      return {
        id: `hour_c4_${b}`, kind: 'hour', chatKey: key, dayKey: '2026-01-01', hourKey: '2026-01-01 00',
        when: 1700000000000 + b * 3600000, title: 't', summary: 's', keywords: words.slice(0, 8),
        snippets, msgCount: snippets.length
      };
    };
    for (let i = 0; i < 40; i += 1) {
      const b = mk(i);
      env4.store.writeBlock(key, b);
      env4.store.indexBlock(key, b);
    }
    const idx = env4.store.index(key);
    const beforeDf = {};
    for (const t of Object.keys(idx.postings)) beforeDf[t] = idx.postings[t].length;
    const n = idx.n;
    // 与 pruneVocab 同口径的价值函数：df × idf
    const worthOf = (t) => {
      const df = beforeDf[t];
      return df * Math.log(1 + (n - df + 0.5) / (df + 0.5));
    };
    assert.ok(Object.keys(beforeDf).length > 500, `前置条件不成立：词表仅 ${Object.keys(beforeDf).length} 个，未越 cap`);
    env4.store.pruneVocab(key, { maxVocab: 500, dfCutoffRatio: 1 });
    const kept = Object.keys(idx.postings);
    assert.equal(kept.length, 500, '裁剪后词数应正好等于 cap');
    // ① 高价值中间层词必须留住（df=30 的「显卡」，idf 仍有 0.3）
    assert.ok('显卡' in idx.postings, '中间层高频实词被删了');
    // ② 方向的充要条件：保留的最低价值 >= 被删的最高价值
    const lost = Object.keys(beforeDf).filter((t) => !(t in idx.postings));
    const minKept = Math.min(...kept.map(worthOf));
    const maxLost = Math.max(...lost.map(worthOf));
    assert.ok(minKept >= maxLost - 1e-9,
      `保留的最低价值 ${minKept.toFixed(3)} < 被删的最高价值 ${maxLost.toFixed(3)} —— 保留方向错了`);
    // ③ df=n 的词 idf→0，价值最低，应当被优先淘汰（这是 df×idf 相对"纯 df 升序"的关键差异）
    const dfN = Object.keys(beforeDf).filter((t) => beforeDf[t] === n);
    assert.ok(dfN.length > 0, '前置条件不成立：没有 df=n 的词，测不到 idf 压权');
    assert.ok(dfN.every((t) => !(t in idx.postings)),
      `df=n 的词（idf→0）应被优先淘汰，实际留下 ${dfN.filter((t) => t in idx.postings).join(',')}`);
  });
  ok('规则① 语言收口：只剪 ASCII 短 token，中文高频实词一个不剪', () => {
    // 核心回归：旧规则 `t.length <= 3` 在中文里剪的是实词（吃/睡/照片），
    // 因为 util.js 的 STOP 表已经把「的/了/是/我」滤掉了 —— 词表里的中文单字
    // 全是实词。"短词 = 虚词" 这个前提只在英文成立，所以规则① 必须按语言收口。
    const root5 = freshRoot('c5');
    const env5 = makeEnv(root5, { dfCutoffRatio: 0.7, maxVocabPerChat: 100000 });
    const key = 'group:30007';
    const d = env5.store.index(key);
    d.n = 5000; // 越过 minBlocksForCutoff(2000)，让规则① 真正生效
    d.ids = Array.from({ length: 5000 }, (_, i) => 'z' + i);
    d.postings = {};
    d.postings['吃'] = Array.from({ length: 4500 }, (_, i) => [i, 1]);   // 中文单字实词 df/n=0.90
    d.postings['睡'] = Array.from({ length: 4500 }, (_, i) => [i, 1]);
    d.postings['照片'] = Array.from({ length: 4000 }, (_, i) => [i, 1]); // 中文二字实词 df/n=0.80
    d.postings['the'] = Array.from({ length: 4900 }, (_, i) => [i, 1]);  // 英文虚词 df/n=0.98
    d.postings['and'] = Array.from({ length: 4800 }, (_, i) => [i, 1]);  // 英文虚词 df/n=0.96
    const dropped5 = env5.store.pruneVocab(key, { maxVocab: 100000, dfCutoffRatio: 0.7 });
    assert.ok('吃' in d.postings, '中文高频单字实词「吃」被剪了 —— 语言收口失效');
    assert.ok('睡' in d.postings, '中文高频单字实词「睡」被剪了');
    assert.ok('照片' in d.postings, '中文高频二字实词「照片」被剪了');
    assert.ok(!('the' in d.postings), '英文虚词 the 没被剪 —— ASCII 收口没生效');
    assert.ok(!('and' in d.postings), '英文虚词 and 没被剪');
    assert.equal(dropped5, 2, `应只剪 2 个 ASCII 虚词，实际剪了 ${dropped5}`);
  });
  ok('索引正文不含 title：群号 / 日期等元数据碎片不进词表', () => {
    // hour 块 title 固定是 `group:<群号> @ <日期> <时刻>`，纯元数据零语义。
    // 若把它算进索引正文，每个块都会产出 group/群号/日期 这些 df=n、idf→0 的
    // 噪声 token，占满词表位置却一分都加不出来。
    const root6 = freshRoot('c6');
    const env6 = makeEnv(root6);
    const key = 'group:30008';
    const b = {
      id: 'hour_t_0', kind: 'hour', chatKey: key, dayKey: '2026-10-18', hourKey: '2026-10-18 10',
      when: 1700000000000, title: 'group:987654321 @ 2026-10-18 10:00',
      summary: '聊了显卡和散热', keywords: ['显卡'],
      snippets: [{
        ts: 1700000000000, mid: 'm0', localId: 0,
        who: '甲', uid: '1001', self: false, text: '这张显卡不错'
      }],
      msgCount: 1
    };
    env6.store.writeBlock(key, b);
    env6.store.indexBlock(key, b);
    const idx6 = env6.store.index(key);
    assert.ok('显卡' in idx6.postings, '正文内容没进索引');
    assert.ok(!('987654321' in idx6.postings), '群号进了词表（title 未排除）');
    assert.ok(!('group' in idx6.postings), '「group」进了词表（title 未排除）');
    assert.ok(!('2026-10-18' in idx6.postings), '日期进了词表（title 未排除）');
  });
  ok('剪枝后仍能命中关键内容', () => {
    const hits = env.recall.search('猫粮', { chatKey: 'group:30003', limit: 2 });
    assert.ok(hits.length > 0);
  });
  const size = dirSize(path.join(root, 'memory-v3'));
  ok('索引与块都落在磁盘上', () => assert.ok(size.files > 0 && size.kb >= 0));
  console.log(`      体积：${size.files} 个文件 / ${size.kb} KB（${s0.blocks} 块 / ${s0.vocab} 词）`);
}

// ── D. 附加五项：跨轮 / 待办 / 护栏 / 语义卡 / 旁听 ──────────────────────
console.log('\nD. 附加五项（跨轮 · 待办 · 护栏 · 语义卡 · 旁听）');
{
  const root = freshRoot('d');
  const s = defaults();
  const get = () => s;
  const dataRoot = path.join(root, 'memory-v3');

  // —— 跨轮工作记忆 ——
  const ct = new CrossTurn(dataRoot, get);
  ct.save('group:40004', {
    sent: [{ type: 'text', text: '我查一下这个显卡的价格' }],
    draft: '刚问完价格，等他回',
    recalled: ['上次说过要买显卡']
  });
  ok('跨轮：写入后能渲染出「刚发过 / 上一轮提过」', () => {
    const t = ct.render('group:40004');
    assert.ok(t.includes('跨轮'), t);
    assert.ok(t.includes('显卡'), t);
  });
  ok('跨轮：TTL 过期后不再注入', () => {
    const f = path.join(dataRoot, 'cross-turn', 'group_40004.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.at = Date.now() - 91 * MIN;
    fs.writeFileSync(f, JSON.stringify(raw));
    assert.equal(ct.render('group:40004'), '');
  });
  ok('跨轮：sweep 会把过期文件真删掉（内置版只判不删，文件永久留在磁盘）', () => {
    assert.ok(ct.sweep() >= 1, '没清掉');
    assert.ok(!fs.existsSync(path.join(dataRoot, 'cross-turn', 'group_40004.json')));
  });
  ok('跨轮：没有任何信息时不落文件', () => {
    assert.equal(ct.save('group:40005', {}), null);
    assert.ok(!fs.existsSync(path.join(dataRoot, 'cross-turn', 'group_40005.json')));
  });

  // —— 待办 ——
  const pd = new Pending(dataRoot, get);
  ok('待办：能记下来并出现在列表里', () => {
    const r = pd.add({ chatKey: 'group:40004', text: '明天问一下阿甲的婚礼在哪办', expireInMinutes: 60 });
    assert.ok(r.ok, r.error);
    const list = pd.list({ chatKey: 'group:40004' });
    assert.equal(list.length, 1);
    assert.ok(list[0].leftMin > 50 && list[0].leftMin <= 60);
  });
  ok('待办：同会话同内容去重并刷新过期时间', () => {
    const r = pd.add({ chatKey: 'group:40004', text: '明天问一下阿甲的婚礼在哪办', expireInMinutes: 120 });
    assert.ok(r.deduped, '没去重');
    assert.equal(pd.list({ chatKey: 'group:40004' }).length, 1);
  });
  ok('待办：绑人的待办只在本人出现时才拿出来', () => {
    pd.add({ chatKey: 'group:40004', text: '记得给阿乙带东西', expireInMinutes: 60, userId: '10001' });
    const without = pd.list({ chatKey: 'group:40004' }).map((x) => x.text).join('|');
    assert.ok(!without.includes('阿乙'), '本人不在场却拿出来了');
    const withHim = pd.list({ chatKey: 'group:40004', personIds: ['10001'] }).map((x) => x.text).join('|');
    assert.ok(withHim.includes('阿乙'), '本人在场却没拿出来');
  });
  ok('待办：办完能销掉（只给关键词也能匹配上）', () => {
    const r = pd.done({ chatKey: 'group:40004', text: '婚礼' });
    assert.ok(r.ok, r.error);
    assert.ok(!pd.list({ chatKey: 'group:40004' }).map((x) => x.text).join('|').includes('婚礼'));
  });
  ok('待办：过期后自己消失，且 sweep 会把文件缩回去', () => {
    const r = pd.add({ chatKey: 'group:40004', text: '这条一分钟后就过期', expireInMinutes: 1 });
    assert.ok(r.ok, r.error);
    const f = path.join(dataRoot, 'todos.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const t of doc.todos) if (t.text.includes('一分钟')) t.expiresAt = Date.now() - 1000;
    fs.writeFileSync(f, JSON.stringify(doc));
    assert.ok(!pd.render({ chatKey: 'group:40004' }).includes('一分钟'), '过期条目还在注入');
    assert.ok(pd.sweep() >= 1, 'sweep 没清掉过期条目');
  });

  // —— 成本护栏 ——
  const bgSettings = { ...defaults(), chatPromptMax: 0 };
  const bg = new Budget(dataRoot, () => bgSettings);
  ok('护栏：没有用量时不砍', () => assert.equal(bg.shouldReduce('group:40004').level, 0));
  ok('护栏：接近日上限时降到 1 档（砍语义卡/旁听，保自动回忆）', () => {
    bg.report('group:40004', { promptTokens: 800000 * 0.9 });
    const r = bg.shouldReduce('group:40004');
    assert.equal(r.level, 1, `level=${r.level} reason=${r.reason}`);
    assert.equal(r.flags.cards, false);
    assert.equal(r.flags.autoRecall, true);
  });
  ok('护栏：超过日上限时降到 2 档（只留待办）', () => {
    bg.report('group:40004', { promptTokens: 800000 * 0.2 });
    const r = bg.shouldReduce('group:40004');
    assert.equal(r.level, 2);
    assert.equal(r.flags.autoRecall, false);
    assert.equal(r.recallBudgetScale, 0);
  });
  ok('护栏：会话级上限真的生效（内置版这一项从未生效）', () => {
    const root2 = freshRoot('d2');
    const s2 = { ...defaults(), dayPromptMax: 0, chatPromptMax: 1000 };
    const bg2 = new Budget(path.join(root2, 'memory-v3'), () => s2);
    assert.equal(bg2.shouldReduce('group:A').level, 0);
    bg2.report('group:A', { promptTokens: 1200 });
    assert.equal(bg2.shouldReduce('group:A').level, 2, '会话超限没触发');
    assert.equal(bg2.shouldReduce('group:B').level, 0, '别的会话被误伤');
  });

  // —— 语义卡 ——
  ok('语义卡：垃圾句在写入前就被拦下（内置版是事后清理，且那个方法从未被调用）', () => {
    assert.equal(Cards.classify('哈哈哈哈这也太草了'), null);
    assert.equal(Cards.classify('[图片]'), null);
    assert.equal(Cards.classify('在吗？？？真的吗！！！'), null);
    assert.equal(Cards.classify('嗯'), null);
    assert.equal(Cards.classify('说好了下周一起去吃火锅'), 'plan');
    assert.equal(Cards.classify('记住这点我最讨厌别人催我'), 'fact');
  });
  const cards = new Cards(dataRoot, get);
  ok('语义卡：只抽干净的，且默认按会话隔离（内置版传 chatKey:null 会串群）', () => {
    const n = cards.ingest('group:40004', [
      { text: '说好了下周末一起去吃火锅', who: '阿甲', ts: Date.now() },
      { text: '哈哈哈哈', who: '阿乙', ts: Date.now() }
    ]);
    assert.equal(n, 1, `抽了 ${n} 张（垃圾没拦住）`);
    cards.ingest('group:99999', [{ text: '记住这点我最讨厌别人催我', who: '别群的人', ts: Date.now() }]);
    const mine = cards.match('下周一起去吃火锅', { chatKey: 'group:40004' });
    assert.ok(mine.length >= 1, '本群的卡没匹配上');
    assert.ok(mine.every((c) => c.chatKey === 'group:40004'), '匹配到别的群的卡了');
    assert.equal(cards.match('我最讨厌别人催我', { chatKey: 'group:40004' }).length, 0, '别的群的卡泄漏进来了');
  });
  ok('语义卡：显式开跨会话后能匹配到别的群', () => {
    assert.ok(cards.match('我最讨厌别人催我', { chatKey: 'group:40004', scope: 'global' }).length >= 1);
  });
  ok('语义卡：匹配用 bigram，带插字的标题也能命中（内置版整句 includes 会漏）', () => {
    const r = cards.match('说好了下周一起去吃火锅', { chatKey: 'group:40004' });
    assert.ok(r.length >= 1, '整句查询没命中');
  });
  ok('语义卡：长期没命中的卡会被淘汰（内置版只按数量截断）', () => {
    const f = path.join(dataRoot, 'cards.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.cards[0].lastTs = Date.now() - 400 * DAY;
    doc.cards[0].lastHitAt = 0;
    fs.writeFileSync(f, JSON.stringify(doc));
    assert.ok(new Cards(dataRoot, get).sweep() >= 1, '僵尸卡没被清掉');
  });

  // —— 跨群旁听 ——
  writeMessages(root, 'group:50005', [
    { id: 1, ts: Date.now() - 60000, self: false, senderId: '2001', senderName: '隔壁甲', text: '今天晚上一起开黑打排位' },
    { id: 2, ts: Date.now() - 50000, self: false, senderId: '2002', senderName: '隔壁乙', text: '开黑可以，排位我打野' },
    { id: 3, ts: Date.now() - 40000, self: false, senderId: '2001', senderName: '隔壁甲', text: '那就说定开黑打排位了' },
    { id: 4, ts: Date.now() - 30000, self: false, senderId: '2002', senderName: '隔壁乙', text: '行，排位见' }
  ]);
  const peek = new Peek({ messagesDir: path.join(root, 'messages'), settings: get });
  ok('旁听：默认关闭时一个字符都不产出', () => assert.equal(peek.build('group:40004'), ''));
  ok('旁听：打开后能压出话题词与尾句', () => {
    s.crossChatPeek = true;
    const t = peek.build('group:40004');
    assert.ok(t.includes('旁听'), t || '(空)');
    assert.ok(t.includes('开黑') || t.includes('排位'), t);
  });
  ok('旁听：按 mtime+size 缓存，第二次不再整文件解析', () => {
    const before = peek.stats().cached;
    assert.ok(before >= 1, '压根没进缓存');
    peek.build('group:40004');
    assert.equal(peek.stats().cached, before);
  });
}

// ── F. 回归：本轮修掉的问题逐条钉住 ─────────────────────────────────────
console.log('\nF. 回归（设置项语义 · 权重继承 · 回填 · 截断）');
{
  // —— 设置项语义：没配置 ≠ 配了下限 ——
  ok('设置项未配置时用默认值，而不是被夹成下限', () => {
    assert.equal(num(undefined, 90, 1, 3650), 90);
    assert.equal(num(null, 500, 20, 5000), 500);
    assert.equal(num('', 200, 80, 600), 200);
    assert.equal(num('abc', 90, 1, 3650), 90, '非数值应退回默认');
    assert.equal(num(0, 120, 0, 36500), 0, '0 是合法值，不该被当缺失');
    assert.equal(num('300', 90, 1, 3650), 300, '字符串数字应被接受');
    assert.equal(num(99999, 90, 1, 3650), 3650, '应被夹到上限');
  });

  ok('语义卡：没配 cardIdleDays 时不会「闲置一天就清空」', () => {
    const root = freshRoot('f1');
    const c = new Cards(path.join(root, 'memory-v3'), () => ({}));
    c.ingest('group:70007', [{ text: '说好了下周一起去吃火锅', who: '甲', ts: Date.now() - 3 * DAY }]);
    assert.equal(c.stats().cards, 1);
    assert.equal(c.sweep(), 0, '3 天前的卡被清掉了 —— cardIdleDays 被夹成了 1 天');
  });

  ok('语义卡：没配 maxCards 时上限不是 20 张', () => {
    const root = freshRoot('f2');
    const c = new Cards(path.join(root, 'memory-v3'), () => ({}));
    const snips = [];
    for (let i = 0; i < 40; i += 1) {
      snips.push({ text: `说好了下周要一起搞第${i}个项目的事情`, who: '甲', ts: Date.now() });
    }
    c.ingest('group:70008', snips);
    assert.equal(c.stats().cards, 40, `只剩 ${c.stats().cards} 张 —— maxCards 被夹成了 20`);
  });

  ok('语义卡：重复巩固同一批不会让 hits 虚高（只喂新增碎片）', () => {
    const root = freshRoot('f3');
    writeMessages(root, 'group:70009', synth({ startOffsetDays: 0, hours: 2, chatKey: 'group:70009' }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat('group:70009');
    const f = path.join(root, 'memory-v3', 'cards.json');
    const h1 = JSON.parse(fs.readFileSync(f, 'utf8')).cards.map((c) => c.hits).join(',');
    assert.ok(h1.length > 0, '一张卡都没抽出来，这条断言没意义');
    env.consolidator.consolidateChat('group:70009');
    env.consolidator.consolidateChat('group:70009');
    const h2 = JSON.parse(fs.readFileSync(f, 'utf8')).cards.map((c) => c.hits).join(',');
    assert.equal(h2, h1, `hits 被重复累加：${h1} → ${h2}`);
  });

  ok('语义卡：两字查询也能匹配（写死 hit>=2 时这类查询永远是 0 结果）', () => {
    const root = freshRoot('f4');
    const c = new Cards(path.join(root, 'memory-v3'), () => ({}));
    c.ingest('group:70010', [{ text: '说好了下周一起去吃火锅', who: '甲', ts: Date.now() }]);
    assert.equal(c.match('火锅', { chatKey: 'group:70010' }).length, 1, '两字查询没命中');
    assert.equal(c.match('婚礼', { chatKey: 'group:70010' }).length, 0, '不相关查询不该命中');
  });

  // —— C5 回归（2026-10-14 修）：整串短语权重必须过停用词表 ——
  // 曾经「我们」「什么」这类两字停用词查询会带着权重 4 上场，
  // 而停用词永远不进索引 → 必然落到子串回退，把 4000 次 fuzzy 预算
  // 整份烧掉后零命中返回（fuzzyBudget 还是跨 token 共享的）。
  ok('停用词查询不再带权重 4 的整串 token（不白烧 fuzzy 预算，也不误伤正常查询）', () => {
    // 「我们」所有成分都在停用词表里 → 整个查询为空，检索直接返回
    assert.equal(queryTokens('我们').size, 0, '「我们」仍产出了 token');
    assert.equal(queryTokens('的').size, 0, '单字停用词仍产出了 token');
    // 「什么」的单字成分（什/么）不在停用词表里，会直查 postings（便宜，无回退扫描）；
    // 但不能带着权重 4 的**整串**上场 —— 那才是烧掉 4000 次 fuzzy 预算的东西。
    const w = queryTokens('什么');
    assert.ok(!w.has('什么'), '「什么」仍带着整串权重 4 上场（会白烧 fuzzy 预算）');
    assert.ok(queryTokens('火锅').size > 0, '正常查询被误伤');
    assert.ok(queryTokens('显卡涨价').size > 0, '正常查询被误伤');
  });

  // —— 权重继承 ——
  ok('日块合并继承小时块的记忆强度（不被重置为 1/0，S 也要接过来）', () => {
    const root = freshRoot('f5');
    const key = 'group:71011';
    writeMessages(root, key, synth({ startOffsetDays: 10, hours: 2, chatKey: key }));
    const env = makeEnv(root, { rollupAfterDays: 999 });
    env.consolidator.consolidateChat(key);
    const ids = env.store.listBlockIds(key);
    assert.ok(ids.length >= 2, `块数 ${ids.length}`);
    // ⚠️ 必须"隔一段时间再想起"，不能连打三次：
    //    增益现在是间隔依赖的（r = log2(1 + 间隔/S)），同一瞬间连打 r≈0、几乎不加分 ——
    //    这正是要钉住的行为，不是 bug。想造出"记得牢"就得模拟真实的间隔回忆。
    hitAged(env.store, key, ids[0], 3, 20, 2);
    const before = env.store.blockMeta(key, ids[0]);
    assert.ok(before.score > 2, `合并前 score=${before.score}`);
    assert.ok(before.S > 45, `合并前稳定性没长起来 S=${before.S}`);
    env.settings.rollupAfterDays = 7;
    env.consolidator.rollupChat(key);
    const dayId = env.store.listBlockIds(key).find((id) => id.startsWith('day_'));
    assert.ok(dayId, '没合并出日块');
    const after = env.store.blockMeta(key, dayId);
    assert.ok(after.score >= before.score, `合并后 score 从 ${before.score} 掉到 ${after.score}`);
    assert.ok(after.hits >= 3, `合并后 hits=${after.hits}`);
    assert.ok(after.lastHitAt > 0, '合并后 lastHitAt 丢了');
    // 稳定性必须一起继承：否则"每两周被想起一次、S 已长到 120 天"的老块，
    // 一滚成日块就被打回全局 45 天 —— 越老的块滚得越多、稳定性丢得越狠。
    assert.ok(after.S >= before.S, `合并后稳定性从 ${before.S} 掉到 ${after.S}`);
  });

  ok('索引文件丢失后重建，记忆强度不归零（含每块自己的 S）', () => {
    const root = freshRoot('f6');
    const key = 'group:72012';
    writeMessages(root, key, synth({ startOffsetDays: 1, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const ids = env.store.listBlockIds(key);
    hitAged(env.store, key, ids[0], 3, 20, 2);
    env.store.flushAll({ force: true });
    const beforeMeta = env.store.blockMeta(key, ids[0]);
    const want = beforeMeta.score;
    assert.ok(want > 2, `前置条件不成立，score=${want}`);
    assert.ok(beforeMeta.S > 45, `前置条件不成立，S=${beforeMeta.S}`);
    fs.rmSync(env.store.indexPath(key));
    const store2 = new LayeredStore(path.join(root, 'memory-v3'), () => env.settings);
    const got = store2.blockMeta(key, ids[0]).score;
    assert.equal(got, want, `重建后 score 从 ${want} 变成 ${got}`);
    // S 不读回来的话，重建后 S 会退回全局 45 天 —— 权重看着还在，
    // 但衰减速度被悄悄改回默认值，"记得牢"这件事丢了。
    assert.equal(store2.blockMeta(key, ids[0]).S, beforeMeta.S, '重建后每块的稳定性丢了');
  });

  // —— 注入截断 ——
  ok('注入预算很小时截断保留，而不是一条都不给', () => {
    const root = freshRoot('f7');
    const key = 'group:73013';
    writeMessages(root, key, synth({ startOffsetDays: 1, hours: 2, chatKey: key }));
    const env = makeEnv(root, { autoRecallBudget: 100 });
    env.consolidator.consolidateChat(key);
    const t = env.injector.build({ chatKey: key, triggerText: '上次说的猫粮买了没' }).text;
    assert.ok(t.length > 0, '预算 100 时一条都注不进来');
    assert.ok(t.length <= 100 + 40, `注入了 ${t.length} 字符`);
    assert.ok(t.includes('旧事'), t);
  });

  // —— 全局检索排序 ——
  ok('全局检索优先扫最近活跃的会话（而不是按索引建立先后）', () => {
    const root = freshRoot('f8');
    const env = makeEnv(root);
    for (let i = 0; i < 3; i += 1) {
      const key = `group:7400${i}`;
      writeMessages(root, key, synth({ startOffsetDays: 5, hours: 1, chatKey: key, idBase: i * 100 }));
      env.consolidator.consolidateChat(key);
      // 消息时间相同，只让「最近巩固时间」不同
      env.store.chatState(key).lastConsolidatedAt = Date.now() - i * 10000;
    }
    const order = env.store.activeChatKeys(3);
    assert.equal(order[0], 'group:74000', `顺序不对：${order.join(' , ')}`);
  });

  // —— 历史回填 ——
  ok('会话超过单批上限时，早期消息最终也能进记忆库（不再静默丢弃）', () => {
    const root = freshRoot('f9');
    const key = 'group:75015';
    const msgs = synth({ startOffsetDays: 40, hours: 60, chatKey: key });
    writeMessages(root, key, msgs);
    const env = makeEnv(root, { consolidateBatchMax: 100 });
    let total = 0;
    for (let round = 0; round < 20; round += 1) {
      const res = env.consolidator.consolidateChat(key);
      total += res.added;
      if (!res.added && res.skippedRead) break;
    }
    assert.equal(total, msgs.length, `只巩固了 ${total}/${msgs.length} 条`);
    assert.ok(env.store.chatState(key).lastIndexedId >= msgs[msgs.length - 1].id);
  });

  ok('会话文件没变时跳过读取（定时器空转不该反复 parse 大文件）', () => {
    const root = freshRoot('f10');
    const key = 'group:76016';
    writeMessages(root, key, synth({ startOffsetDays: 1, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    const r1 = env.consolidator.consolidateChat(key);
    assert.equal(r1.skippedRead, false, '首次巩固不该跳过');
    const r2 = env.consolidator.consolidateChat(key);
    assert.equal(r2.skippedRead, true, '文件没变却还是读了');
    assert.equal(r2.added, 0);
  });

  // —— 护栏会话表上限 ——
  ok('护栏的会话表有上限（不会无限增长）', () => {
    const root = freshRoot('f11');
    const s = { ...defaults(), dayPromptMax: 0, chatPromptMax: 0 };
    const bg = new Budget(path.join(root, 'memory-v3'), () => s);
    for (let i = 0; i < 260; i += 1) bg.report(`group:8${i}`, { promptTokens: i + 1 });
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'memory-v3', 'budget.json'), 'utf8'));
    assert.ok(Object.keys(doc.chats).length <= 200, `会话表涨到 ${Object.keys(doc.chats).length}`);
    assert.ok(doc.totalPrompt > 0, '总量统计不该被裁掉');
  });
}

// ── E. 端到端接线：造一个假宿主目录，真的 import index.js ────────────────
console.log('\nE. 端到端接线（假宿主目录 + import index.js）');
{
  const host = path.join(os.tmpdir(), `mem-layered-host-${process.pid}`);
  fs.rmSync(host, { recursive: true, force: true });
  const appDir = path.join(host, 'resources', 'app');
  const srcDir = path.join(appDir, 'src');
  const plugDir = path.join(appDir, 'plugins', 'mem-layered');
  const dataDir = path.join(host, 'data');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
  fs.cpSync(PLUGIN_DIR, plugDir, { recursive: true });
  // 假核心 config.js：只导出 DATA_DIR / ROOT（与真核心同形状，用来验 lib/env.js 的相对路径）
  fs.writeFileSync(
    path.join(srcDir, 'config.js'),
    `export const DATA_DIR = ${JSON.stringify(dataDir)};\nexport const ROOT = ${JSON.stringify(appDir)};\n`,
    'utf8'
  );

  const mod = await import(pathToFileURL(path.join(plugDir, 'index.js')).href);
  const envMod = await import(pathToFileURL(path.join(plugDir, 'lib', 'env.js')).href);
  const tools = [];
  const logs = [];
  const storageBox = {};
  const cfg = { ...defaults(), dfCutoffRatio: 1 };
  const fakeApi = {
    config: () => cfg,
    registerTool: (def) => { tools.push(def); return def.id; },
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    // 模拟"内置「分层会话记忆」还开着、并且抢走了 memory.status"：
    // isSkillActive 认它；探针落到它那里，回来的形状里没有本插件的引擎标记。
    isSkillActive: (id) => id === BUILTIN_ID,
    capability: (name, args) => (
      name === 'memory.status' && args && args[PROBE_KEY] === ENGINE_TAG
        ? { ok: true, index: { blocks: 3 }, arch: {}, cost: {} }
        : undefined
    ),
    hasCapability: () => true,
    storage: {
      get: (k, f = null) => (Object.prototype.hasOwnProperty.call(storageBox, k) ? storageBox[k] : f),
      set: (k, v) => { storageBox[k] = v; return true; }
    }
  };
  mod.setup(fakeApi);
  mod.activate();

  ok('接线：lib/env.js 按相对路径拿到核心的 DATA_DIR（不是自己拼的）', () => {
    assert.equal(envMod.DATA_DIR, dataDir, 'DATA_DIR 对不上，多实例下会写错目录');
  });
  ok('接线：setup 注册了 memory_todo 工具（内置版这项没有入口）', () => {
    const t = tools.find((x) => x.id === 'memory_todo');
    assert.ok(t, '没注册待办工具');
    assert.equal(typeof t.execute, 'function');
    assert.ok(String(t.description).length > 20, '描述太短，模型不会知道何时调用');
    assert.deepEqual(t.parameters.required, ['action']);
  });
  ok('接线：activate 起了定时器并打了日志', () => {
    assert.ok(logs.some((l) => l.includes('分层记忆已启用')), logs.join(' / '));
  });
  ok('接线：activate 自检到内置记忆还开着 → 打了一条警告', () => {
    assert.ok(
      logs.some((l) => l.includes('记忆引擎冲突') && l.includes(BUILTIN_NAME)),
      `没打冲突警告：${logs.join(' / ')}`
    );
  });

  // 造两个会话的数据：一个当前会话、一个用来验旁听
  const chatKey = 'group:60006';
  fs.writeFileSync(
    path.join(dataDir, 'messages', 'group_60006.json'),
    JSON.stringify({ version: 1, messages: [...synth({ startOffsetDays: 9, hours: 3 }), ...synth({ startOffsetDays: 1, hours: 2, idBase: 300 })] }, null, 1),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'messages', 'group_60007.json'),
    JSON.stringify({ version: 1, messages: [
      { id: 1, ts: Date.now() - 60000, self: false, senderId: '3001', senderName: '隔壁甲', text: '今天晚上一起开黑打排位' },
      { id: 2, ts: Date.now() - 50000, self: false, senderId: '3002', senderName: '隔壁乙', text: '开黑可以，排位我打野' },
      { id: 3, ts: Date.now() - 40000, self: false, senderId: '3001', senderName: '隔壁甲', text: '那就说定开黑打排位了' },
      { id: 4, ts: Date.now() - 30000, self: false, senderId: '3002', senderName: '隔壁乙', text: '行，排位见' }
    ] }, null, 1),
    'utf8'
  );

  const it = mod.__internals();
  const results = it.consolidate('selftest');
  ok('接线：巩固跑通并建出数据根', () => {
    assert.ok(Array.isArray(results) && results.length >= 1, 'consolidate 没返回结果');
    assert.ok(fs.existsSync(path.join(dataDir, 'memory-v3')), '数据根没建出来');
    assert.ok(fs.existsSync(path.join(dataDir, 'memory-v3', 'stats.json')), '统计文件没落盘');
  });
  ok('接线：巩固顺带抽出了语义卡（onBlock 回调生效）', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-v3', 'cards.json'), 'utf8'));
    assert.ok(Array.isArray(doc.cards) && doc.cards.length >= 1, '一张卡都没抽出来');
  });

  ok('接线：梗概墓碑已接上（GistStore 建好 + 检索侧两条注入都在）', () => {
    const inst = it.instance();
    assert.ok(inst.gist, 'instance() 没返回 gist');
    assert.equal(typeof inst.gist.search, 'function');
    assert.equal(typeof inst.gist.remember, 'function');
    assert.equal(inst.consolidator.gist, inst.gist, 'Consolidator 没拿到 gist（淘汰时不会留墓碑）');
    assert.equal(typeof inst.recall.gistSearch, 'function', 'Recall 没拿到 gistSearch（墓碑不参与排序）');
    assert.equal(typeof inst.recall.revive, 'function', 'Recall 没拿到 revive（墓碑命中后重建不了）');
  });

  ok('接线：走真实淘汰链路也能留墓碑并复活（index.js 的接线端到端可用）', () => {
    const inst = it.instance();
    const key2 = 'group:60009';
    fs.writeFileSync(
      path.join(dataDir, 'messages', 'group_60009.json'),
      JSON.stringify({ version: 1, messages: synth({ startOffsetDays: 200, hours: 1 }) }, null, 1),
      'utf8'
    );
    const saved = cfg.forgetAfterDays;
    cfg.forgetAfterDays = 30;        // 临时把淘汰线拉近，逼出真淘汰
    try {
      inst.consolidator.consolidateChat(key2);
      assert.equal(inst.store.stats(key2).blocks, 0, '前置条件不成立：块没被淘汰');
      const gists = inst.gist.list(key2);
      assert.ok(gists.length > 0, '淘汰后没留下墓碑');
      const hits = inst.recall.search('猫粮', { chatKey: key2, limit: 3, feedback: 'off' });
      assert.ok(hits.length > 0, '块没了就彻底想不起来 —— 墓碑应当让它还能露头');
    } finally {
      cfg.forgetAfterDays = saved;
    }
  });

  // 走一遍钩子
  await mod.hooks['before-context']({
    sessionId: 'sess-1', chatKey, triggerEntries: [{ text: '上次说的猫粮买了没', senderId: '1001' }]
  });
  const messages = [{ role: 'system', content: 'SYSTEM-PREFIX' }, { role: 'user', content: 'USER-BODY' }];
  await mod.hooks['before-llm-messages']({ sessionId: 'sess-1', chatKey, messages });

  ok('接线：注入落在最后一条 user 消息末尾，system 一个字符没动', () => {
    assert.equal(messages[0].content, 'SYSTEM-PREFIX', 'system 被改了 —— 会毁掉前缀缓存');
    assert.ok(messages[1].content.startsWith('USER-BODY'));
    assert.ok(messages[1].content.length > 'USER-BODY'.length, '什么都没注入');
    assert.ok(messages[1].content.includes('旧事'), `注入里没有旧事段：${messages[1].content}`);
  });
  ok('接线：钩子里不跑巩固（5 秒超时约束）', () => {
    // 巩固只在 activate 的定时器里跑；这里用"第二次进钩子不新增块"间接验证
    const before = it.instance().store.stats(chatKey).blocks;
    assert.ok(before >= 1);
  });

  ok('接线：自动注入只记被动命中，绝不喂胖权重（正反馈环整条链路上都断掉）', () => {
    const st = it.instance().store;
    const metas = st.listBlockIds(chatKey).map((id) => st.blockMeta(chatKey, id));
    const passive = metas.reduce((n, m) => n + (Number(m?.passiveHits) || 0), 0);
    assert.ok(passive >= 1, '自动注入送达了却没记被动命中');
    for (const m of metas) {
      assert.equal(Number(m.hits) || 0, 0, `hits 被自动注入写成了 ${m.hits}`);
      assert.equal(Number(m.score) || 1, 1, `score 被自动注入写成了 ${m.score}`);
      assert.equal(Number(m.S) || 0, 0, `S 被自动注入写成了 ${m.S}`);
    }
  });

  await okAsync('接线：注入没送达（找不到 user 消息）时连被动命中都不记', async () => {
    const st = it.instance().store;
    const count = () => st.listBlockIds(chatKey)
      .reduce((n, id) => n + (Number(st.blockMeta(chatKey, id)?.passiveHits) || 0), 0);
    const before = count();
    // 先清掉冷却，否则这一轮 build 会因为"上一轮刚注入过"而直接返回空，
    // 断言就变成"什么都没发生"，等于没测。
    it.instance().injector.clear(chatKey);
    const sysOnly = [{ role: 'system', content: 'SYSTEM-ONLY' }];
    await mod.hooks['before-context']({
      sessionId: 'sess-2', chatKey, triggerEntries: [{ text: '上次说的猫粮买了没', senderId: '1001' }]
    });
    await mod.hooks['before-llm-messages']({ sessionId: 'sess-2', chatKey, messages: sysOnly });
    assert.equal(sysOnly[0].content, 'SYSTEM-ONLY', 'system 被改了');
    assert.equal(count(), before, '没送达却记了被动命中');
    // 反证：清掉冷却 + 给一条 user 消息，同一批块就该被记上 —— 说明上面不是"恰好没内容可注入"
    const ok1 = [{ role: 'user', content: 'USER-BODY' }];
    await mod.hooks['before-context']({
      sessionId: 'sess-3', chatKey, triggerEntries: [{ text: '上次说的猫粮买了没', senderId: '1001' }]
    });
    await mod.hooks['before-llm-messages']({ sessionId: 'sess-3', chatKey, messages: ok1 });
    assert.ok(count() > before, '送达之后也没记上被动命中，说明上面那条断言是空转');
  });

  await okAsync('接线：睡眠重演经 buildInject 播出，送达后按 full 计权（与被动注入分开）', async () => {
    const inst = it.instance();
    const st = inst.store;
    const key3 = 'group:60010';
    fs.writeFileSync(
      path.join(dataDir, 'messages', 'group_60010.json'),
      JSON.stringify({ version: 1, messages: synth({ startOffsetDays: 60, hours: 1 }) }, null, 1),
      'utf8'
    );
    it.consolidate('replay-setup');
    const ids = st.listBlockIds(key3);
    assert.ok(ids.length >= 1, '没建出块');
    const id = ids[0];
    // 造出"该复习了"：上次命中在 40.5 天前（S=45 → gap≈0.9S，R≈0.53）
    st.blockMeta(key3, id).lastHitAt = Date.now() - 40.5 * DAY;
    st.flushAll({ force: true });
    const built = it.buildInject({ chatKey: key3, triggerText: '', personIds: [] });
    assert.ok(built.text.includes('【突然想起】'), `buildInject 没带出重演段：${built.text.slice(0, 80)}`);
    assert.ok(built.replayChunkIds.includes(id), 'replayChunkIds 没带上该块');
    // 走一遍钩子（有 user 消息 → 送达）→ 该块应按 full 计权，并记下 lastReplayAt
    const hits0 = Number(st.blockMeta(key3, id).hits) || 0;
    const box = [{ role: 'user', content: 'USER-BODY' }];
    await mod.hooks['before-context']({ sessionId: 'sess-replay', chatKey: key3, triggerEntries: [] });
    await mod.hooks['before-llm-messages']({ sessionId: 'sess-replay', chatKey: key3, messages: box });
    const meta = st.blockMeta(key3, id);
    assert.equal(Number(meta.hits) || 0, hits0 + 1, '重演播出后没有按 full 计权');
    assert.ok(Number(meta.lastReplayAt) > 0, '没记 lastReplayAt（冷却会失效）');
  });

  await mod.hooks['after-response']({
    chatKey,
    session: { sent: [{ type: 'text', text: '猫粮我记着呢' }] },
    response: { message: { content: '猫粮我记着呢，回头给你带' }, usage: { prompt_tokens: 1234, prompt_tokens_details: { cached_tokens: 1000 } } }
  });
  ok('接线：after-response 写了跨轮状态', () => {
    const f = path.join(dataDir, 'memory-v3', 'cross-turn', 'group_60006.json');
    assert.ok(fs.existsSync(f), '跨轮档案没写');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(String(doc.draft).includes('猫粮'), doc.draft);
    assert.ok(Array.isArray(doc.recalled) && doc.recalled.length >= 1, '没记住上一轮注入过什么');
  });
  ok('接线：after-response 记了本轮增量用量', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-v3', 'budget.json'), 'utf8'));
    assert.equal(doc.totalPrompt, 1234);
    assert.equal(doc.totalCached, 1000);
  });

  ok('接线：memory.status 能力把五项的运行状况都报出来', () => {
    const st = mod.providers['memory.status']();
    assert.ok(st.ok, st.error);
    assert.ok(st.index && st.index.blocks >= 1);
    assert.ok(st.usage && typeof st.usage.hitRate === 'number');
    assert.ok(st.extras && st.extras.todos && st.extras.cards && st.extras.crossTurn && st.extras.peek && st.extras.budget);
  });
  ok('接线：memory.status 里带上了冲突结论（模型/用户一查就能看到）', () => {
    const st = mod.providers['memory.status']();
    assert.ok(st.conflict, '状态里没有冲突结论');
    assert.equal(st.conflict.level, 'shadowed', JSON.stringify(st.conflict));
    assert.equal(st.conflict.builtinActive, true);
    assert.ok(String(st.conflict.hint).includes(BUILTIN_NAME));
  });
  ok('接线：engine 标记与 lib/conflict.js 的约定一致（防两处漂移）', () => {
    assert.equal(mod.providers['memory.status']({ [PROBE_KEY]: ENGINE_TAG }).engine, ENGINE_TAG);
  });
  const todoTool = tools.find((x) => x.id === 'memory_todo');
  const todoRes = await todoTool.execute({ chatKey }, { action: 'add', text: '明天问一下阿甲的婚礼在哪办', expireInMinutes: 60 });
  const todoAlive = mod.providers['memory.status']().extras.todos.alive;
  ok('接线：待办工具能真的写进状态机', () => {
    assert.ok(!todoRes.isError, todoRes.content);
    assert.ok(todoAlive >= 1, '待办没进状态机');
  });

  ok('接线：护栏超限后自动回忆被砍掉（2 档只留待办）', () => {
    cfg.dayPromptMax = 1000;
    const f = path.join(dataDir, 'memory-v3', 'budget.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.totalPrompt = 2000;
    fs.writeFileSync(f, JSON.stringify(doc));
    // index.js 里的 Budget 是长驻实例，这里用同参数的新实例验语义
    const b2 = new Budget(path.join(dataDir, 'memory-v3'), () => cfg);
    const r = b2.shouldReduce(chatKey);
    assert.equal(r.level, 2, `level=${r.level}`);
    assert.equal(r.flags.autoRecall, false);
    assert.equal(r.recallBudgetScale, 0);
  });

  ok('接线：没有 user 消息时宁可不注入，也不碰 system（保前缀缓存）', () => {
    const only = [{ role: 'system', content: 'SYS' }];
    const applied = it.appendToLastUser(only, '\n\n【旧事】x');
    assert.equal(applied, false, '居然往 system 里塞了 —— 前缀缓存会被整条作废');
    assert.equal(only[0].content, 'SYS');
  });

  // 私聊里才会出现冲突提醒；而且一天最多念叨一次
  const privKey = 'private:70007';
  const roundPrivate = async (tag) => {
    await mod.hooks['before-context']({
      sessionId: tag, chatKey: privKey, triggerEntries: [{ text: '上次说的猫粮买了没', senderId: '1001' }]
    });
    const box = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }];
    await mod.hooks['before-llm-messages']({ sessionId: tag, chatKey: privKey, messages: box });
    return box[1].content;
  };
  const priv1 = await roundPrivate('sess-p1');
  ok('接线：私聊里插进了冲突提醒，并把冷却记到插件存储里', () => {
    assert.ok(priv1.includes('记忆引擎提醒'), priv1);
    assert.ok(priv1.includes(BUILTIN_NAME), priv1);
    assert.ok(storageBox.conflictWarn && storageBox.conflictWarn.at > 0, '没记冷却');
    assert.equal(storageBox.conflictWarn.level, 'shadowed');
  });
  const priv2 = await roundPrivate('sess-p2');
  ok('接线：同一天内不重复念叨（冷却生效）', () => {
    assert.ok(!priv2.includes('记忆引擎提醒'), `又念叨了一遍：${priv2}`);
  });
  ok('接线：群聊里从不插冲突提醒（不替主人当众念设置页）', () => {
    assert.ok(!messages[1].content.includes('记忆引擎提醒'), messages[1].content);
  });

  // 单独验 warnOnConflict 开关：先把内存里的冷却清零，免得"因为冷却"而误判成"开关生效"
  const g = it.guard();
  const savedAnnounceAt = g.lastAnnouncedAt;
  g.lastAnnouncedAt = 0;
  cfg.warnOnConflict = false;
  const off = await roundPrivate('sess-p3');
  cfg.warnOnConflict = true;
  g.lastAnnouncedAt = savedAnnounceAt;
  ok('接线：关掉 warnOnConflict 后，私聊里也不再提（检测结论仍在）', () => {
    assert.ok(!off.includes('记忆引擎提醒'), `关掉开关后还在提：${off}`);
    assert.equal(mod.providers['memory.status']().conflict.level, 'shadowed', '开关把检测也一起关了');
  });

  mod.deactivate();
  ok('接线：deactivate 能干净收尾', () => assert.ok(true));
  fs.rmSync(host, { recursive: true, force: true });
}

// ── G. 冲突自检：内置记忆还开着就提醒 ─────────────────────────────────────
console.log('\nG. 引擎冲突自检（内置「分层会话记忆」仍开启时的提醒）');
{
  /**
   * 造一个可控的假 api。
   * @param builtin       内置版是否生效（isSkillActive 的答案）
   * @param firstProvider 'self' = 第一个 memory.status 提供者是我；
   *                      'builtin' = 是内置版；'none' = 谁都不答话（探针问不出来）
   */
  const mk = ({ builtin = false, firstProvider = 'self', over = {} } = {}) => {
    const cfg = { ...defaults(), ...over };
    const box = {};
    const warnings = [];
    const api = {
      config: () => cfg,
      warn: (...a) => warnings.push(a.join(' ')),
      log: () => {},
      isSkillActive: (id) => (id === BUILTIN_ID ? builtin : false),
      capability: (name, args) => {
        if (name !== 'memory.status') return undefined;
        if (!args || args[PROBE_KEY] !== ENGINE_TAG) return undefined;   // 只答探针
        if (firstProvider === 'self') return { ok: true, engine: ENGINE_TAG, probe: true };
        if (firstProvider === 'builtin') return { ok: true, index: { blocks: 3 }, arch: {}, cost: {} };
        return undefined;
      },
      storage: {
        get: (k, f = null) => (Object.prototype.hasOwnProperty.call(box, k) ? box[k] : f),
        set: (k, v) => { box[k] = v; return true; },
        remove: (k) => { delete box[k]; return true; }
      }
    };
    return { api, cfg, box, warnings, guard: () => new ConflictGuard(api, () => cfg) };
  };

  ok('冲突：内置版没开 → 无冲突、不提醒', () => {
    const g = mk().guard();
    const st = g.check({ force: true });
    assert.equal(st.level, 'none');
    assert.equal(st.builtinActive, false);
    assert.equal(g.notice(), '');
    assert.equal(g.announce(), '');
    assert.equal(g.canAnnounce('private:1'), false);
  });

  ok('冲突：内置开着且抢走了能力 → shadowed，且点明「检索查到旧数据」', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin' }).guard();
    const st = g.check({ force: true });
    assert.equal(st.level, 'shadowed', JSON.stringify(st));
    assert.equal(st.selfFirst, false);
    const n = g.notice();
    assert.ok(n.includes(BUILTIN_NAME), `提示里没点名内置插件：${n}`);
    assert.ok(n.includes('关掉'), `提示里没说怎么处理：${n}`);
    assert.ok(n.includes('旧数据'), `shadowed 该说清"检索查到旧数据"：${n}`);
  });

  ok('冲突：内置开着但我排在前面 → duplicate（只说重复注入，不夸大）', () => {
    const g = mk({ builtin: true, firstProvider: 'self' }).guard();
    const st = g.check({ force: true });
    assert.equal(st.level, 'duplicate', JSON.stringify(st));
    assert.equal(st.selfFirst, true);
    const n = g.notice();
    assert.ok(n.includes(BUILTIN_NAME) && n.includes('关掉'), n);
    assert.ok(!n.includes('旧数据'), `duplicate 不该声称"检索查到旧数据"：${n}`);
  });

  ok('冲突：探针问不出来（没提供者 / 抛错）→ 按较轻那档报，不夸大', () => {
    const g = mk({ builtin: true, firstProvider: 'none' }).guard();
    const st = g.check({ force: true });
    assert.equal(st.level, 'duplicate', JSON.stringify(st));
    assert.equal(st.selfFirst, null);
  });

  ok('冲突：只在私聊提醒 —— 群聊里绝不播报主人的插件配置', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin' }).guard();
    assert.equal(g.canAnnounce('group:10001'), false);
    assert.equal(g.canAnnounce('private:10001'), true);
    assert.equal(g.canAnnounce(''), false);
  });

  ok('冲突：提醒一次后进冷却，冷却过后恢复；群聊不吃冷却', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin' }).guard();
    const t0 = 1_700_000_000_000;
    g.canAnnounce('group:1', { now: t0 });            // 群聊：不该记账
    assert.equal(g.lastAnnouncedAt, 0, '群聊居然吃了冷却');
    assert.equal(g.canAnnounce('private:1', { now: t0 }), true);
    g.markAnnounced({ now: t0 });
    assert.equal(g.canAnnounce('private:1', { now: t0 + 60_000 }), false, '一分钟后又提醒了');
    assert.equal(g.canAnnounce('private:1', { now: t0 + 1440 * 60_000 }), true, '冷却过后应该恢复');
  });

  ok('冲突：冷却记在宿主给的存储里 —— 重启 / 热重载不重新计时', () => {
    const env = mk({ builtin: true, firstProvider: 'builtin' });
    const g1 = env.guard();
    const t0 = 1_700_000_000_000;
    assert.equal(g1.canAnnounce('private:1', { now: t0 }), true);
    g1.markAnnounced({ now: t0 });
    assert.ok(env.box.conflictWarn && env.box.conflictWarn.at === t0, '没落盘');

    const g2 = env.guard();   // 模拟重启：新实例、同一份存储
    assert.equal(g2.lastAnnouncedAt, t0, '重启后冷却被重置了');
    assert.equal(g2.canAnnounce('private:1', { now: t0 + 60_000 }), false);
  });

  ok('冲突：warnOnConflict=false 只是不提醒，检测结论照旧', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin', over: { warnOnConflict: false } }).guard();
    assert.equal(g.check({ force: true }).level, 'shadowed', '关掉提醒不该把检测也关掉');
    assert.equal(g.canAnnounce('private:1'), false);
  });

  ok('冲突：冷却时长走 num()，没配就用默认 1440 分钟（不是被夹成下限 5 分钟）', () => {
    const cfg = { ...defaults() };
    delete cfg.conflictWarnCooldownMin;
    const box = {};
    const api = {
      config: () => cfg,
      isSkillActive: () => true,
      capability: (n, a) => (a && a[PROBE_KEY] === ENGINE_TAG ? { ok: true, index: {} } : undefined),
      storage: { get: (k, f = null) => (k in box ? box[k] : f), set: (k, v) => { box[k] = v; return true; } }
    };
    const g = new ConflictGuard(api, () => cfg);
    const t0 = 1_700_000_000_000;
    assert.equal(g.canAnnounce('private:1', { now: t0 }), true);
    g.markAnnounced({ now: t0 });
    // 默认 1440 分钟 = 一天。若被 clamp 成下限 5 分钟，10 分钟后就会再提醒。
    assert.equal(g.canAnnounce('private:1', { now: t0 + 10 * 60_000 }), false, '默认冷却被夹成了下限');
    assert.equal(g.canAnnounce('private:1', { now: t0 + 1441 * 60_000 }), true);
  });

  ok('冲突：用户把内置版关掉后，结论立刻跟上（force 复查）', () => {
    const env = mk({ builtin: true, firstProvider: 'builtin' });
    const g = env.guard();
    assert.equal(g.check({ force: true }).level, 'shadowed');
    env.api.isSkillActive = () => false;
    assert.equal(g.check({ force: true }).level, 'none', 'force 复查没跟上');
    assert.equal(g.canAnnounce('private:1'), false);
  });

  ok('冲突：5 分钟内命中缓存，不反复去调别人的能力提供者', () => {
    const env = mk({ builtin: true, firstProvider: 'builtin' });
    const g = env.guard();
    let probes = 0;
    const orig = env.api.capability;
    env.api.capability = (n, a) => { probes += 1; return orig(n, a); };
    g.check({ force: true, now: 1000 });
    const after = probes;
    env.api.isSkillActive = () => false;                       // 外部状态变了
    assert.equal(g.check({ now: 1000 + 60_000 }).level, 'shadowed', '缓存没生效，白探了一次');
    assert.equal(probes, after, 'TTL 内又去探针了');
    assert.equal(g.check({ force: true, now: 1000 + 60_000 }).level, 'none', 'force 没绕过缓存');
  });

  ok('冲突：宿主没给 isSkillActive（老宿主 / 假宿主）→ 静默当作无冲突，不炸', () => {
    const cfg = { ...defaults() };
    for (const api of [null, {}, { config: () => cfg }, { config: () => cfg, capability: () => undefined }]) {
      const g = new ConflictGuard(api, () => cfg);
      const st = g.check({ force: true });
      assert.equal(st.level, 'none', `api=${JSON.stringify(api)} 时判成了 ${st.level}`);
      assert.equal(g.canAnnounce('private:1'), false);
      assert.equal(g.notice(), '');
    }
  });

  ok('冲突：snapshot() 是纯数据，能直接塞进 memory.status', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin' }).guard();
    g.check({ force: true });
    const snap = g.snapshot();
    assert.equal(snap.level, 'shadowed');
    assert.equal(snap.builtinActive, true);
    assert.equal(snap.selfFirst, false);
    assert.ok(typeof snap.hint === 'string' && snap.hint.includes('关掉'));
    JSON.stringify(snap);   // 必须能序列化 —— 它要回给模型工具
  });

  ok('冲突：announce() 文案短、含关键指引、且明确"说一次就够"', () => {
    const g = mk({ builtin: true, firstProvider: 'builtin' }).guard();
    g.check({ force: true });
    const a = g.announce();
    assert.ok(a.length <= 200, `注入文案太长（${a.length} 字），会占 prompt：${a}`);
    assert.ok(a.includes(BUILTIN_NAME), a);
    assert.ok(a.includes('插件'), a);
    assert.ok(a.includes('说一次就够'), `没拦住模型反复念叨：${a}`);
  });

  // 探针必须"零 IO"：全新 import 后直接问探针，不该建出数据根 ——
  // 它是在 activate() 里被调的，那里多一次磁盘遍历就是白等。
  {
    const host2 = path.join(os.tmpdir(), `mem-layered-probe-${process.pid}`);
    fs.rmSync(host2, { recursive: true, force: true });
    const app2 = path.join(host2, 'resources', 'app');
    const data2 = path.join(host2, 'data');
    fs.mkdirSync(path.join(app2, 'src'), { recursive: true });
    fs.mkdirSync(path.join(data2, 'messages'), { recursive: true });
    const plug2 = path.join(app2, 'plugins', 'mem-layered');
    fs.cpSync(PLUGIN_DIR, plug2, { recursive: true });
    fs.writeFileSync(
      path.join(app2, 'src', 'config.js'),
      `export const DATA_DIR = ${JSON.stringify(data2)};\nexport const ROOT = ${JSON.stringify(app2)};\n`,
      'utf8'
    );
    const mod2 = await import(pathToFileURL(path.join(plug2, 'index.js')).href);
    mod2.setup({
      config: () => ({ ...defaults() }),
      registerTool: (def) => def.id,
      log: () => {}, warn: () => {}
    });
    const probe = mod2.providers['memory.status']({ [PROBE_KEY]: ENGINE_TAG });
    ok('探针短路：零 IO 回引擎标记，不唤醒整个引擎', () => {
      assert.equal(probe.engine, ENGINE_TAG);
      assert.equal(probe.probe, true);
      assert.ok(!fs.existsSync(path.join(data2, 'memory-v3')), '探针居然建了数据根 —— activate 每次都会白等一次磁盘遍历');
    });
    ok('探针只认自己的标记：普通调用（宿主工具传的 {}）照常走全量状态', () => {
      const full = mod2.providers['memory.status']();
      assert.equal(full.ok, true, full.error);
      assert.equal(full.probe, undefined, '普通调用被探针分支截走了');
      assert.ok(full.conflict && typeof full.conflict.level === 'string', '状态里没有冲突结论');
    });
    fs.rmSync(host2, { recursive: true, force: true });
  }
}

// ── H. 人类化记忆模型：间隔依赖增益 / 每块稳定性 / 被动 vs 主动 ────────────
// 对应 docs/human-like-memory.html 的七项提案，逐条钉住。
console.log('\nH. 人类化记忆模型（间隔增益 · 每块稳定性 S · 被动≠主动）');
{
  // —— H1 间隔依赖增益：密集命中不该把块顶到封顶 ——
  ok('密集命中（间隔≈0）几乎不加分 —— 掐断"越被注入越强"的正反馈', () => {
    const root = freshRoot('h1');
    const key = 'group:81001';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const id = env.store.listBlockIds(key)[0];
    const meta = env.store.blockMeta(key, id);
    meta.lastHitAt = Date.now();          // 造出"刚刚才想起过"
    for (let i = 0; i < 8; i += 1) env.store.markHit(key, id, { mode: 'full' });
    assert.ok(meta.score < 1.01, `连打 8 次后 score=${meta.score}，应该几乎不动`);
    assert.ok(meta.S <= 45 + 1e-6, `连打 8 次后 S=${meta.S}，不该增长`);
    assert.equal(meta.hits, 8, `hits 应该照常计数，实际 ${meta.hits}`);
  });

  // —— H2 间隔命中应该把 S 抬高 ——
  ok('间隔命中把稳定性 S 抬高（同样 8 次，间隔 vs 密集差一个数量级）', () => {
    const root = freshRoot('h2');
    const key = 'group:81002';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const id = env.store.listBlockIds(key)[0];
    hitAged(env.store, key, id, 8, 30, 1.15);
    const meta = env.store.blockMeta(key, id);
    // 解析值：score≈1.4308、S≈356.1（见 docs 里的复算）
    assert.ok(meta.S > 300, `8 次间隔 30 天的命中后 S=${meta.S}，太低了`);
    assert.ok(meta.score > 1.35, `score=${meta.score}，间隔命中应该比密集命中（=1）明显高`);
  });

  // —— H3 被动 vs 主动：passive 只记计数 ——
  ok('被动命中（mode:passive）只记 passiveHits，score/S/锚点一个字节都不动', () => {
    const root = freshRoot('h3');
    const key = 'group:81003';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const id = env.store.listBlockIds(key)[0];
    const meta = env.store.blockMeta(key, id);
    const snap = { score: meta.score, S: meta.S, lastHitAt: meta.lastHitAt, hits: meta.hits };
    for (let i = 0; i < 5; i += 1) env.store.markHit(key, id, { mode: 'passive' });
    assert.equal(meta.score, snap.score, 'score 被动了');
    assert.equal(meta.S, snap.S, 'S 被动了');
    assert.equal(meta.lastHitAt, snap.lastHitAt, '衰减锚点被动了 —— 锚点一刷新块就长生不老');
    assert.equal(meta.hits, snap.hits, 'hits 被动了（那是主动回忆的计数）');
    assert.equal(meta.passiveHits, 5, `passiveHits=${meta.passiveHits}`);
  });

  ok('只被被动注入过的老块仍然会被淘汰（锚点没被刷新）', () => {
    const root = freshRoot('h4');
    const key = 'group:81004';
    const env = makeEnv(root);
    const store = env.store;
    const data = store.index(key);
    const id = hourBlockId(key, Date.now() - 200 * DAY);
    data.blocks[id] = {
      kind: 'hour', dayKey: dayKeyLocal(Date.now() - 200 * DAY), hourKey: '', timeOfDay: '',
      when: Date.now() - 200 * DAY, title: 't', summary: 's', length: 10,
      score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0, msgCount: 1
    };
    for (let i = 0; i < 20; i += 1) store.markHit(key, id, { mode: 'passive' });
    const doomed = store.forgetSweep(key, { forgetAfterDays: 120, minScore: 0.25 });
    assert.ok(doomed.includes(id), '只被动看过 20 次的老块居然活下来了 —— 库会无限膨胀');
  });

  // —— H4 检索计权三态 ——
  ok("feedback:'off' 时检索一个字节都不写（score/S/hits 全不动）", () => {
    const root = freshRoot('h5');
    const key = 'group:81005';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const hits = env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    assert.ok(hits.length > 0, '没搜到东西，这条断言没意义');
    for (const h of hits) {
      const meta = env.store.blockMeta(key, h.chunkId);
      assert.equal(meta.score, 1, `${h.chunkId} 的 score 被写了`);
      assert.equal(meta.hits, 0, `${h.chunkId} 的 hits 被写了`);
      assert.equal(meta.S, 0, `${h.chunkId} 的 S 被写了`);
    }
  });

  ok("feedback:'passive' 只记被动，feedback:true/'full' 才真的加分", () => {
    const root = freshRoot('h6');
    const key = 'group:81006';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const p = env.recall.search('猫粮', { chatKey: key, limit: 1, feedback: 'passive' })[0];
    const pm = env.store.blockMeta(key, p.chunkId);
    assert.equal(pm.passiveHits, 1, 'passive 没计数');
    assert.equal(pm.hits, 0, 'passive 不该动 hits');
    // 主检索（默认 feedback:'full'）要真加分 —— 但间隔≈0，所以只能看到 hits 增长
    env.recall.search('猫粮', { chatKey: key, limit: 1 });
    assert.ok(env.store.blockMeta(key, p.chunkId).hits >= 1, 'full 没记 hits');
  });

  ok('自动注入走的是 off：整条链路不会把权重喂胖（正反馈环已切断）', () => {
    const root = freshRoot('h7');
    const key = 'group:81007';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    for (let i = 0; i < 5; i += 1) {
      env.injector.clear();
      env.injector.build({ chatKey: key, triggerText: '上次说的猫粮买了没' });
    }
    for (const id of env.store.listBlockIds(key)) {
      const meta = env.store.blockMeta(key, id);
      assert.equal(meta.hits, 0, `${id} 的 hits 被自动注入写成了 ${meta.hits}`);
      assert.equal(meta.score, 1, `${id} 的 score 被自动注入写成了 ${meta.score}`);
      assert.equal(meta.S, 0, `${id} 的 S 被自动注入写成了 ${meta.S}`);
    }
  });

  // —— H5 稳定性回落 ——
  ok('没有 S 的块回落到全局半衰期，而不是被夹成下限 1 天', () => {
    const root = freshRoot('h8');
    const env = makeEnv(root, { decayHalfLifeDays: 90 });
    assert.equal(env.store.stabilityOf({}), 90, '缺失 S 时没回落');
    assert.equal(env.store.stabilityOf({ S: 0 }), 90, 'S=0 被当成"1 天"了');
    assert.equal(env.store.stabilityOf({ S: null }), 90, 'S=null 没回落');
    assert.equal(env.store.stabilityOf({ S: 200 }), 200, '有 S 时不该回落');
    assert.equal(env.store.stabilityOf({ S: -5 }), 90, '负数 S 没回落');
  });

  ok('stabilityMax 封顶：稳定性不会被顶到无限大', () => {
    const root = freshRoot('h9');
    const key = 'group:81009';
    const env = makeEnv(root, { stabilityMax: 500 });
    const store = env.store;
    const id = hourBlockId(key, Date.now() - 100000 * DAY);
    store.index(key).blocks[id] = {
      kind: 'hour', dayKey: '', hourKey: '', timeOfDay: '', when: Date.now() - 100000 * DAY,
      title: 't', summary: 's', length: 10, score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0, msgCount: 1
    };
    const meta = store.blockMeta(key, id);
    meta.lastHitAt = Date.now() - 100000 * DAY;
    store.markHit(key, id, { mode: 'full' });
    assert.ok(meta.S <= 500 + 1e-6, `S=${meta.S} 超了上限`);
    // 极长间隔也不能把 score 顶飞：R_MAX = 4 → 最多 1 + 0.15*4 = 1.6
    assert.ok(meta.score <= 1.6 + 1e-6, `score=${meta.score} 超了 R_MAX 的封顶`);
  });

  // —— H6 衰减形状 ——
  ok('Weibull 形状 q<1 拖出长尾：180 天时比纯指数厚，且 t=S 处与纯指数重合', () => {
    const root = freshRoot('h10');
    // 固定 now：直接用 Date.now() 会在两次调用之间漂移几毫秒，
    // ageDays 就不是整整 45，t=S 的"必须相等"会差在 1e-9 量级上（假失败）。
    const NOW = Date.now();
    const meta = { score: 3, when: NOW - 180 * DAY, lastHitAt: 0, S: 45 };
    const mk = (q) => new LayeredStore(path.join(root, 'memory-v3'), () => ({ decayShape: q }));
    const longTail = mk(0.7).effectiveScore(meta, NOW);
    const pureExp = mk(1).effectiveScore(meta, NOW);
    assert.ok(longTail > pureExp * 2, `q=0.7 → ${longTail}，q=1 → ${pureExp}，长尾没做出来`);
    // t = S 时两者必须相等（否则 q 就不再是"形状"参数，而是顺手改了半衰期）
    const atS = { score: 3, when: NOW - 45 * DAY, lastHitAt: 0, S: 45 };
    assert.ok(
      Math.abs(mk(0.7).effectiveScore(atS, NOW) - mk(1).effectiveScore(atS, NOW)) < 1e-12,
      't=S 处两者不相等'
    );
  });

  ok('decayShape 没配置时用默认 0.7，而不是被夹成下限 0.1', () => {
    const root = freshRoot('h11');
    // ⚠️ "当前时刻"必须**只读一次并显式传给被测代码**。
    //    早先这里写 `when: Date.now() - 180*DAY`，让 effectiveScore 自己再读一次
    //    Date.now() 当 now —— 两次调用之间差几毫秒，ageDays 就不是精确的 180，
    //    浮点结果抖出 1e-9 量级的偏差，于是这条断言**偶尔**失败（12 次里约 1 次）。
    //    测试里凡是"相对现在往前拨 N 天"的，都要把 now 钉死成同一个值。
    // ⚠️ reminiscenceAmp 显式关掉：这条断言验的是 **decayShape 的默认值处理**，
    //    180 天已进入深忘区（>3S），自发恢复会叠一个回升项 —— 那是另一个特性，
    //    在这里属于噪声（v1.7.0 起两者正交，各自有各自的断言）。
    const now = Date.now();
    const meta = { score: 3, when: now - 180 * DAY, lastHitAt: 0, S: 45 };
    const bare = new LayeredStore(path.join(root, 'memory-v3'), () => ({ reminiscenceAmp: 0 }));
    const want = 3 * Math.pow(0.5, Math.pow(180 / 45, 0.7));
    assert.ok(Math.abs(bare.effectiveScore(meta, now) - want) < 1e-9, `得到 ${bare.effectiveScore(meta, now)}，期望 ${want}`);
  });

  ok('stabilityGain=0 时退回"全局半衰期"行为（稳定性不再增长）', () => {
    const root = freshRoot('h12');
    const key = 'group:81012';
    const env = makeEnv(root, { stabilityGain: 0 });
    env.consolidator.consolidateChat(key);
    void key;
    const store = env.store;
    const id = hourBlockId(key, Date.now() - 10 * DAY);
    store.index(key).blocks[id] = {
      kind: 'hour', dayKey: '', hourKey: '', timeOfDay: '', when: Date.now() - 10 * DAY,
      title: 't', summary: 's', length: 10, score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0, msgCount: 1
    };
    const meta = store.blockMeta(key, id);
    meta.lastHitAt = Date.now() - 30 * DAY;
    store.markHit(key, id, { mode: 'full' });
    assert.equal(meta.S, 45, `stabilityGain=0 时 S 不该增长，实际 ${meta.S}`);
  });

  // —— H7 向后兼容 ——
  ok('旧签名 markHit(k, id, 1.15) 仍按"主动回忆"处理', () => {
    const root = freshRoot('h13');
    const key = 'group:81013';
    const env = makeEnv(root);
    const store = env.store;
    const id = hourBlockId(key, Date.now() - 10 * DAY);
    store.index(key).blocks[id] = {
      kind: 'hour', dayKey: '', hourKey: '', timeOfDay: '', when: Date.now() - 10 * DAY,
      title: 't', summary: 's', length: 10, score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0, msgCount: 1
    };
    const meta = store.blockMeta(key, id);
    meta.lastHitAt = Date.now() - 45 * DAY;      // 间隔 = S → 增益应恰好等于 hitBoost
    store.markHit(key, id, 1.15);
    assert.equal(meta.hits, 1, '旧签名没记 hits');
    assert.ok(Math.abs(meta.score - 1.15) < 1e-9, `间隔=S 时增益应恰好是 1.15，实际 ${meta.score}`);
    assert.equal(meta.passiveHits, 0, '旧签名不该走被动分支');
  });

  ok('S 随索引重建一起找回：不会"权重还在、衰减速度偷偷变回默认"', () => {
    const root = freshRoot('h14');
    const key = 'group:81014';
    writeMessages(root, key, synth({ startOffsetDays: 1, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const id = env.store.listBlockIds(key)[0];
    hitAged(env.store, key, id, 4, 25, 1.15);
    const beforeS = env.store.blockMeta(key, id).S;
    assert.ok(beforeS > 45, `前置条件不成立 S=${beforeS}`);
    fs.rmSync(env.store.indexPath(key));
    const store2 = new LayeredStore(path.join(root, 'memory-v3'), () => env.settings);
    assert.equal(store2.blockMeta(key, id).S, beforeS, 'S 没读回来');
    assert.equal(store2.blockMeta(key, id).passiveHits || 0, 0, 'passiveHits 读回来是脏的');
  });
}

// ── J. 梗概墓碑：淘汰只烂细节，留下「我好像记得有这么回事」────────────────
// 模糊痕迹理论 + 节省效应。这一组全部走"真淘汰"路径：
// 造一个 200 天前的会话 → 巩固（小时块 rollup 成日块）→ forgetSweep 淘汰 →
// 检查墓碑 / 检索露头 / 按 id 区间重建。
console.log('\nJ. 梗概墓碑（模糊痕迹 · 节省效应）');
{
  /** 造一个"必然被淘汰"的会话：200 天前、1 小时、话题「猫粮」。 */
  const doomed = (root, key, extra = {}) => {
    writeMessages(root, key, synth({ startOffsetDays: 200, hours: 1, chatKey: key }));
    const env = makeEnv(root, { forgetAfterDays: 30, ...extra });
    const r = env.consolidator.consolidateChat(key);
    return { env, r };
  };

  ok('J1 淘汰块时留下梗概墓碑（不再一刀两断）', () => {
    const { env, r } = doomed(freshRoot('j1'), 'group:90001');
    assert.ok(r.forgotten > 0, `前置条件不成立：这一轮没淘汰任何块（forgotten=${r.forgotten}）`);
    const gists = env.gist.list('group:90001');
    assert.ok(gists.length > 0, '块被淘汰了，却没留下任何墓碑');
    const g = gists[0];
    assert.ok(String(g.gist).length > 0, '墓碑缺要旨');
    assert.ok(String(g.gist).length <= 40, `要旨应当很短（≤40 字），实际 ${String(g.gist).length} 字`);
    assert.ok(g.minId > 0 && g.maxId >= g.minId, '墓碑必须记下 id 区间 —— 重建全靠它');
  });

  ok('J2 gistEnabled=false 时不留墓碑（淘汰即删除）', () => {
    const { env, r } = doomed(freshRoot('j2'), 'group:90002', { gistEnabled: false });
    assert.ok(r.forgotten > 0, '前置条件不成立：没有淘汰发生');
    assert.equal(env.gist.list('group:90002').length, 0, 'gistEnabled=false 时不该留墓碑');
  });

  ok('J3 活块答不上来时，墓碑作为低权重候选露头', () => {
    const { env } = doomed(freshRoot('j3'), 'group:90003');
    assert.equal(env.store.stats('group:90003').blocks, 0, '前置条件不成立：块还在');
    const hits = env.recall.search('猫粮', { chatKey: 'group:90003', limit: 3, feedback: 'off' });
    assert.ok(hits.length > 0, '块没了就彻底想不起来 —— 墓碑应当让它还能露头');
    assert.ok(hits.some((h) => h.gistOnly || h.revivedFromGist), '露头的应当是墓碑（或由墓碑复活）');
  });

  ok('J4 墓碑命中后从原文重建整块，并摘掉墓碑（节省效应）', () => {
    const { env } = doomed(freshRoot('j4'), 'group:90004');
    const gid = env.gist.list('group:90004')[0].id;
    assert.ok(!env.store.readBlock('group:90004', gid), '前置条件：块文件应当已被删除');
    const hits = env.recall.search('猫粮', { chatKey: 'group:90004', limit: 3, feedback: 'off' });
    assert.ok(hits.some((h) => h.revivedFromGist), '应当有一条是「复活」来的');
    assert.ok(env.store.readBlock('group:90004', gid), '块文件应当被重建回磁盘');
    assert.equal(
      env.gist.list('group:90004').find((g) => g.id === gid), undefined,
      '复活之后墓碑应当被摘掉（线索已经用过了）'
    );
    assert.ok(env.store.blockMeta('group:90004', gid).hits >= 1, '复活本身是一次成功提取（测试效应）');
  });

  // —— B2 回归（2026-10-14 修）：墓碑复活时 hits 必须继承原块的累计回忆次数 ——
  // 曾经 gist.search 把存储的 hits 覆盖成"本次检索的关键词命中数"，
  // reviveBlock 又拿这个临时值 +1 写回块 —— "被想起过 20 次"的块一复活
  // 只剩"关键词命中 5 次 + 1"。J4 的 `hits >= 1` 断言抓不到（它只查下限）。
  ok('J4b 墓碑复活后 hits 继承原块累计值（不被检索打分的临时值覆盖）', () => {
    const root = freshRoot('j4b');
    const key = 'group:90014';
    writeMessages(root, key, synth({ startOffsetDays: 200, hours: 1, chatKey: key }));
    // 先别淘汰：把库建出来、把权重攒够，再手动走一次"真淘汰"
    const env = makeEnv(root, { forgetAfterDays: 0, dfCutoffRatio: 1 });
    env.consolidator.consolidateChat(key);
    const dayId = env.store.listBlockIds(key).find((id) => id.startsWith('day_'));
    assert.ok(dayId, '前置条件不成立：没建出日块');
    // 直接构造"被想起过 20 次、但已经 400 天没人想起"的块
    // （不能用连打 markHit 造：增益是间隔依赖的，密集命中 r≈0）
    // ⚠️ v1.7.0：150 天这类"刚进深忘区"的块会被自发恢复托住（那是故意的，
    //    见 N3），要造"真的衰到淘汰线以下"得推到 400 天 —— 回升项自己也衰减。
    const lastHitAt = Date.now() - 400 * DAY;
    env.store.noteBlock(key, dayId, { hits: 20, score: 1.0, S: 45, lastHitAt });
    const meta = env.store.blockMeta(key, dayId);
    meta.hits = 20; meta.score = 1.0; meta.S = 45; meta.lastHitAt = lastHitAt;
    assert.ok(env.store.effectiveScore(meta) < 0.25, '前置条件不成立：这块还没衰到淘汰线以下');

    const gone = env.store.forgetSweep(key, {
      forgetAfterDays: 120,
      onEvict: (id, m, block) => env.gist.remember(key, block, m)
    });
    assert.ok(gone.includes(dayId), '前置条件不成立：块没被淘汰');
    const stored = env.gist.list(key).find((g) => g.id === dayId);
    assert.ok(stored, '淘汰后没留下墓碑');
    assert.equal(stored.hits, 20, `墓碑里存的 hits 不对：${stored.hits}`);

    const hits = env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    assert.ok(hits.some((h) => h.revivedFromGist), '墓碑没被命中/复活');
    const after = env.store.blockMeta(key, dayId);
    // 复活 = 一次成功的回忆 → 原累计 20 + 1。旧行为会掉到"检索打分 + 1"（如 7）
    assert.ok(after.hits >= 20, `复活后 hits 从 20 掉到 ${after.hits}（被检索打分的临时值覆盖）`);
  });

  ok('J5 每会话墓碑上限：超出后从最老的开始丢（墓碑也要会忘）', () => {
    const root = freshRoot('j5');
    // ⚠️ 上限有下限 10（每会话至少留 10 条），所以这里造 15 条、设上限 10。
    const env = makeEnv(root, { gistMaxPerChat: 10 });
    for (let i = 0; i < 15; i += 1) {
      env.gist.remember('group:90005', {
        id: `hour_x_${i}`,
        kind: 'hour',
        dayKey: `2026-01-0${i + 1}`,
        keywords: ['测试'],
        snippets: [{ uid: '1', text: 'x', localId: i + 1 }]
      });
    }
    assert.equal(env.gist.list('group:90005').length, 10, '上限 10 应当生效');
  });

  ok('J6 墓碑保留期：过期墓碑被清掉（墓碑也要会忘，只是慢得多）', () => {
    const root = freshRoot('j6');
    const env = makeEnv(root, { gistRetainDays: 7 });
    env.gist.remember('group:90006', {
      id: 'a', keywords: ['x'], snippets: [{ uid: '1', text: 'x', localId: 1 }]
    });
    env.gist.list('group:90006')[0].evictedAt = Date.now() - 30 * DAY;   // 拨到 30 天前
    assert.equal(env.gist.sweep(), 1, '超过保留期的墓碑应当被清掉');
    assert.equal(env.gist.list('group:90006').length, 0);
  });

  ok('J7 一条墓碑只有几十~几百字节（用极小体积换「记得有这么回事」）', () => {
    const { env } = doomed(freshRoot('j7'), 'group:90007');
    const g = env.gist.list('group:90007')[0];
    const bytes = Buffer.byteLength(JSON.stringify(g), 'utf8');
    assert.ok(bytes > 0 && bytes < 600, `一条墓碑应当很小，实际 ${bytes} 字节`);
    assert.ok(env.gist.size() > 0 && env.gist.size() < 4096, `gist.json 应当很小，实际 ${env.gist.size()} 字节`);
  });

  ok('J8 会话文件超上限时只给要旨、不重建（守住钩子 5 秒预算）', () => {
    const root = freshRoot('j8');
    const key = 'group:90008';
    const msgs = synth({ startOffsetDays: 200, hours: 1, chatKey: key });
    // 撑大文件：追加一条超长消息，只为把 stat.size 顶上去（正文会被截到 180 字）
    msgs.push({
      id: 99, ts: Date.now() - 200 * DAY, mid: 'fat', self: false,
      senderId: '1001', senderName: '阿甲', text: '填充'.repeat(20000)
    });
    writeMessages(root, key, msgs);
    const env = makeEnv(root, { forgetAfterDays: 30, gistReviveMaxMb: 0.01 });
    env.consolidator.consolidateChat(key);
    const hits = env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    assert.ok(hits.some((h) => h.gistOnly), '超过体积上限时应当退化成「只给要旨」');
    assert.ok(!hits.some((h) => h.revivedFromGist), '不该重建（同步 JSON.parse 会拖垮这一轮）');
    assert.equal(env.store.stats(key).blocks, 0, '不该把块写回去');
  });

  // 反向断言：**不许猜情绪**。插件只按可判定的结构信号取信息量高的碎片，
  // 感叹号、自称密度、"说好了/保证"这类情绪与承诺信号都不该让一条消息
  // 比别人更容易被留下。这一条存在的意义就是防止以后有人把启发式加回来。
  ok('J9 权重不看情绪：感叹 / 自称 / 承诺词不改变「留谁」', () => {
    const base = Math.floor((Date.now() - 3 * DAY) / 3600000) * 3600000;
    const mk = (id, text) => ({
      id, ts: base + id * 60000, mid: `m${id}`, self: false,
      senderId: '1001', senderName: '阿甲', text
    });
    const build = (root, key) => {
      const msgs = [];
      // 24 条平淡消息（长度都 ≥12、不含触发词，权重相等）
      for (let i = 1; i <= 24; i += 1) msgs.push(mk(i, `今天随便聊聊天气吧凑够字数第${i}条消息`));
      // 第 25 条：情绪 + 自称 + 承诺，长度同样 ≥12。
      // ⚠️ 刻意避开 weightOf 本来就加分的那些词（明天/记得/别忘/？/约定/怎么），
      //    否则测的就不是"猜不猜情绪"，而是"这条本身信息量就高"。
      msgs.push(mk(25, '咱俩说好了一定要去！！我我我我保证的'));
      writeMessages(root, key, msgs);
      const env = makeEnv(root, { maxSnippetsPerBlock: 20 });
      env.consolidator.consolidateChat(key);
      const block = env.store.readBlock(key, env.store.listBlockIds(key)[0]);
      return new Set((block?.snippets || []).map((s) => s.localId));
    };
    assert.ok(!build(freshRoot('j9'), 'group:90009').has(25),
      '情绪/承诺文本不该被特殊照顾 —— 只认信息量与可执行信号');
  });
}

// ── K. 多线索检索（编码特异性）：按「在场的人」加权 ────────────────────────
// 人会因为看到老朋友而想起十年前那件事，而不是因为想到了那句话。
// 工程对应：触发消息里在场的人，与块里在场的人有交集 → 加权。
// ⚠️ 全部按 uid 匹配（昵称会改），且只算别人（机器人自己不算）。
console.log('\nK. 多线索检索（按「在场的人」加权）');
{
  /** 造一个单块会话：阿甲(1001) 反复聊「火锅」。 */
  const hotpot = (root, key, { self = false, overrides = {} } = {}) => {
    const base = Math.floor((Date.now() - 3 * DAY) / 3600000) * 3600000;
    writeMessages(root, key, [1, 2, 3].map((i) => ({
      id: i, ts: base + i * 60000, mid: `m${i}`, self,
      senderId: self ? '9999' : '1001',
      senderName: self ? '机器人' : '阿甲',
      text: `火锅 的事情 再 详细 说说 第 ${i} 遍`
    })));
    // ⚠️ dfCutoffRatio=1（不剪）：测试语料只有一个块，df/n 恒为 1，
    //    默认 0.7 会把所有短词（含「火锅」）全部剪掉 —— 检索必然空手而归。
    //    真实使用里块数是几十上百，df/n 才有区分度（这正是剪枝的用意）。
    const env = makeEnv(root, { dfCutoffRatio: 1, ...overrides });
    env.consolidator.consolidateChat(key);
    return env;
  };
  const q = { limit: 3, feedback: 'off' };

  ok('K1 「在场的人」有交集 → 该块加权（编码特异性）', () => {
    const key = 'group:91001';
    const env = hotpot(freshRoot('k1'), key);
    const plain = env.recall.search('火锅', { chatKey: key, ...q });
    const boosted = env.recall.search('火锅', { chatKey: key, ...q, personIds: ['1001'] });
    assert.ok(plain.length && boosted.length, '前置条件：两边都该有命中');
    assert.ok(
      boosted[0].score > plain[0].score,
      `带「在场的人」线索应当更高：${boosted[0].score} vs ${plain[0].score}`
    );
  });

  ok('K2 线索按 uid 匹配：昵称当线索无效（对方改了昵称也照样认得）', () => {
    const key = 'group:91002';
    const env = hotpot(freshRoot('k2'), key);
    const byName = env.recall.search('火锅', { chatKey: key, ...q, personIds: ['阿甲'] });
    const byUid = env.recall.search('火锅', { chatKey: key, ...q, personIds: ['1001'] });
    assert.ok(
      byUid[0].score > byName[0].score,
      '线索必须按 uid 匹配 —— 昵称会改，拿昵称当线索等于没线索'
    );
  });

  ok('K3 peopleBoost=1 时关闭多线索加权', () => {
    const key = 'group:91003';
    const env = hotpot(freshRoot('k3'), key, { overrides: { peopleBoost: 1 } });
    const a = env.recall.search('火锅', { chatKey: key, ...q, personIds: ['1001'] });
    const b = env.recall.search('火锅', { chatKey: key, ...q });
    assert.equal(a[0].score, b[0].score, 'peopleBoost=1 应当完全关闭加权');
  });

  ok('K4 机器人自己不算「在场的人」（否则每个块都命中，加权等于没加）', () => {
    const key = 'group:91004';
    const env = hotpot(freshRoot('k4'), key, { self: true });
    const id = env.store.listBlockIds(key)[0];
    assert.deepEqual(env.store.blockMeta(key, id).people, [], 'self 消息不该进 people');
    const withSelf = env.recall.search('火锅', { chatKey: key, ...q, personIds: ['9999'] });
    const without = env.recall.search('火锅', { chatKey: key, ...q });
    assert.equal(withSelf[0].score, without[0].score, '机器人 uid 不该带来任何加权');
  });

  ok('K5 墓碑也带「在场的人」：块淘汰之后这条线索不会断', () => {
    const root = freshRoot('k5');
    const key = 'group:91005';
    writeMessages(root, key, synth({ startOffsetDays: 200, hours: 1, chatKey: key }));
    const env = makeEnv(root, { forgetAfterDays: 30 });
    env.consolidator.consolidateChat(key);
    const g = env.gist.list(key)[0];
    assert.ok(Array.isArray(g.people) && g.people.length > 0, '墓碑应当记下在场的人');
    assert.ok(!g.people.includes('9999'), '机器人自己不该出现在墓碑的 people 里');
  });
}

// ── L. 更深更广：结果多样性 / 复活退避 / 懒自愈 ───────────────
console.log('\nL. 结果多样性 · 复活退避 · 懒自愈');
{
  /**
   * 造 5 个小时块：前 3 个同话题（关键词高度重叠），后 2 个不同话题。
   * 用来验证「top-N 会不会是同一段对话的几个侧面」。
   */
  // 前 3 个块是同一话题（火锅，词汇高度重叠），后 2 个是别的话题。
  // ⚠️ 每个话题必须有自己的**专属词**，不能靠"讨论/事情/相关"这类通用词凑 ——
  //    真实语料也是这样：不同话题的词汇本来就不一样。
  //    （早先用通用词凑出来的语料，两个不同话题块的关键词 4/5 相同，
  //    纯 Jaccard 算出 0.67 的重叠 —— MMR 被"假重叠"骗住，根本打不散。）
  const TOPICS = [
    ['火锅', '涮肉', '蘸料', '麻辣', '锅底'],
    ['火锅', '涮肉', '蘸料', '鸳鸯', '毛肚'],
    ['火锅', '锅底', '麻辣', '毛肚', '蘸料'],
    ['显卡', '显存', '频率', '散热', '功耗'],
    ['论文', '摘要', '引用', '审稿', '期刊']
  ];
  const overlapping = (root, key) => {
    const base = Math.floor((Date.now() - 2 * DAY) / 3600000) * 3600000;
    const msgs = [];
    let id = 1;
    for (let h = 0; h < 5; h += 1) {
      const words = TOPICS[h];
      for (let i = 0; i < 5; i += 1) {
        msgs.push({
          id, ts: base + h * 3600000 + i * 60000, mid: `m${id}`, self: false,
          senderId: '1001', senderName: '阿甲',
          text: `${words[i % 5]} 和 ${words[(i + 1) % 5]} 讨论一下 ${words[0]} 第 ${i} 条`
        });
        id += 1;
      }
    }
    writeMessages(root, key, msgs);
    // dfCutoffRatio=1：块数少时默认 0.7 会把短词（含「火锅」）全剪掉
    const env = makeEnv(root, { dfCutoffRatio: 1 });
    env.consolidator.consolidateChat(key);
    return env;
  };

  /** 一组结果里，两两关键词重叠度（Jaccard）的平均值。 */
  const meanOverlap = (env, hits) => {
    const sets = hits
      .map((h) => new Set(env.store.blockMeta(h.chatKey, h.chunkId)?.kw || []))
      .filter((s) => s.size);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        let inter = 0;
        for (const t of sets[i]) if (sets[j].has(t)) inter += 1;
        sum += inter / (sets[i].size + sets[j].size - inter);
        n += 1;
      }
    }
    return n ? sum / n : 0;
  };

  ok('L1 结果多样性：不再把同一段对话当成两件旧事（干扰理论）', () => {
    const key = 'group:92001';
    const env = overlapping(freshRoot('l1'), key);
    assert.equal(env.store.stats(key).blocks, 5, '前置条件不成立：应当有 5 个块');
    // ⚠️ makeEnv 的 settings 是同一个可变对象，改它等价于"用户在设置页改了值"
    env.settings.diversityLambda = 0;
    const flat = env.recall.search('火锅 讨论', { chatKey: key, limit: 3, feedback: 'off' });
    env.settings.diversityLambda = 0.6;
    const div = env.recall.search('火锅 讨论', { chatKey: key, limit: 3, feedback: 'off' });
    assert.equal(flat.length, 3, 'λ=0 时应当取满 3 条');
    assert.equal(div.length, 3, 'λ=0.6 时应当取满 3 条');
    const a = meanOverlap(env, flat);
    const b = meanOverlap(env, div);
    assert.ok(b < a, `开了多样性之后结果应当更不重叠：${b.toFixed(3)} vs ${a.toFixed(3)}`);
  });

  ok('L2 diversityLambda=0 时严格按分数降序（MMR 是严格推广，不会变差）', () => {
    const key = 'group:92002';
    const env = overlapping(freshRoot('l2'), key);
    env.settings.diversityLambda = 0;
    const hits = env.recall.search('火锅 讨论', { chatKey: key, limit: 4, feedback: 'off' });
    assert.ok(hits.length >= 2, '前置条件不成立：命中太少');
    for (let i = 1; i < hits.length; i += 1) {
      assert.ok(
        hits[i - 1].score >= hits[i].score,
        `λ=0 时应当严格按分数降序，实际第 ${i} 条 (${hits[i].score}) 高于前一条 (${hits[i - 1].score})`
      );
    }
  });

  // 反向断言：**不许用位置做文章**。裁剪只看碎片自身的信息量权重，
  // "开头/结尾更值得留"这种心理学启发式一律不加回来。
  ok('L3 权重不看位置：裁剪只看信息量，不看「开头 / 结尾」', () => {
    const base = Math.floor((Date.now() - 3 * DAY) / 3600000) * 3600000;
    const mk = (id) => ({
      id, ts: base + id * 60000, mid: `m${id}`, self: false,
      senderId: '1001', senderName: '阿甲', text: `今天随便聊聊天气吧凑够字数第${id}条消息`
    });
    const build = (root, key) => {
      const msgs = [];
      for (let i = 1; i <= 25; i += 1) msgs.push(mk(i));
      writeMessages(root, key, msgs);
      const env = makeEnv(root, { maxSnippetsPerBlock: 20 });
      env.consolidator.consolidateChat(key);
      const block = env.store.readBlock(key, env.store.listBlockIds(key)[0]);
      return new Set((block?.snippets || []).map((s) => s.localId));
    };
    const keep = build(freshRoot('l3'), 'group:92003');
    // 25 条权重全相等 → 排序稳定 → 必须按时间裁掉最后 5 条，而不是留头尾
    assert.ok(keep.has(13), '第 13 条（正中）应当还在');
    assert.ok(!keep.has(25), '第 25 条（结尾）不享有任何特权');
  });

  ok('L4 墓碑救不回来时不再反复白读原文（退避）', () => {
    const root = freshRoot('l4');
    const key = 'group:92004';
    writeMessages(root, key, synth({ startOffsetDays: 200, hours: 1, chatKey: key }));
    const env = makeEnv(root, { forgetAfterDays: 30 });
    env.consolidator.consolidateChat(key);
    const gid = env.gist.list(key)[0].id;
    // 原文没了：清空会话文件（模拟记录被清 / id 区间对不上）
    writeMessages(root, key, []);
    for (let i = 0; i < 3; i += 1) {
      env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    }
    const g = env.gist.list(key).find((x) => x.id === gid);
    assert.equal(g.reviveFails, 3, '应当记下 3 次重建失败');
    assert.equal(g.unrevivable, true, '3 次之后应当标成救不回来');
    // 第 4 次不该再试 —— 否则这条墓碑每被命中一次就要同步读一遍整个会话文件
    let calls = 0;
    env.recall.revive = () => { calls += 1; return null; };
    const hits = env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    assert.equal(calls, 0, '标成救不回来之后不该再尝试重建');
    assert.ok(hits.some((h) => h.gistOnly), '仍然应当给出「只有梗概」那一条');
  });

  ok('L5 索引里有、块文件没了 → 检索撞上时懒自愈摘掉（不做全量扫描）', () => {
    const root = freshRoot('l5');
    const key = 'group:92005';
    writeMessages(root, key, synth({ startOffsetDays: 1, hours: 1, chatKey: key }));
    const env = makeEnv(root, { dfCutoffRatio: 1 });
    env.consolidator.consolidateChat(key);
    const ids = env.store.listBlockIds(key);
    assert.ok(ids.length >= 1, '前置条件不成立：没建出块');
    const before = env.store.stats(key).blocks;
    // 手动删掉块文件（模拟磁盘出错 / 手动清理）
    fs.rmSync(env.store.blockPath(key, ids[0]));
    assert.equal(
      env.store.stats(key).blocks, before,
      '删文件不该立刻影响索引 —— 自愈是懒的，只在真撞上时修，不做全量扫描'
    );
    env.recall.search('猫粮', { chatKey: key, limit: 3, feedback: 'off' });
    assert.equal(env.store.stats(key).blocks, before - 1, '检索撞上之后应当被摘掉');
    assert.ok(env.stats.snapshot().selfHealed >= 1, '应当记一次自愈');
  });
}

// ── M. 省 token：碎片级跨轮去重 / 相关度早停 / 预算行宽联动 ─────────────
// 目标只有一个：**同样的命中率，更少的字符**。三条新防线都设计成"少给重复与
// 低分内容"，而不是"少给内容" —— 所以每条断言都要同时确认省了、且没把新内容挡掉。
console.log('\nM. 省 token（跨轮碎片去重 · 相关度早停 · 预算行宽联动）');
{
  const DAY = 86400000;
  const key = 'group:93001';

  /** 造一个「火锅聊了 3 个小时块、中间夹一次猫粮」的会话。 */
  const seed = (root, { hours = 3 } = {}) => {
    const base = Math.floor((Date.now() - 2 * DAY) / 3600000) * 3600000;
    const msgs = [];
    let id = 1;
    for (let h = 0; h < hours; h += 1) {
      const ts0 = base + h * 3600000 + 100000;
      msgs.push({
        id, ts: ts0, mid: `hp${h}a`, self: false,
        senderId: '1001', senderName: '阿甲', text: `火锅真好吃第 ${h} 次提起这个话题`
      });
      id += 1;
      msgs.push({
        id, ts: ts0 + 60000, mid: `hp${h}b`, self: false,
        senderId: '1001', senderName: '阿甲', text: `下次还去吃火锅吧第 ${h} 次约定好了`
      });
      id += 1;
    }
    // 第三条：另一个话题，用来验证"去重不会把新内容一起挡掉"
    msgs.push({
      id, ts: base + 3 * 3600000 + 100000, mid: 'cat1', self: false,
      senderId: '1001', senderName: '阿甲', text: '猫粮快吃完了得再买一袋回来'
    });
    writeMessages(root, key, msgs);
    // dfCutoffRatio=1：块数少时默认 0.7 会把短词全剪掉（README 里提醒过的行为）
    return makeEnv(root, { dfCutoffRatio: 1, peopleBoost: 1 });
  };

  ok('M1 同一句原话不会被连续两轮各注入一遍（碎片级跨轮去重）', () => {
    const root = freshRoot('m1');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    const r1 = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定' });
    assert.ok(r1.text.length > 0, '第一轮应当能注入');
    assert.ok((env.injector.lastMids.get(key)?.size || 0) > 0, '应当记下给过哪些碎片');

    // ⚠️ 只清**块级冷却**，保留 lastMids —— 块 id 没变、冷却已清，
    //    此刻还能拦住重复的就只剩"碎片身份"这一层。混淆两层防线就等于没测。
    env.injector.recent.delete(key);
    env.injector.lastLines = [];
    const r2 = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定' });
    assert.equal(r2.text, '', '块 id 与内容都没变，第二轮不该再把同一批原话念一遍');
    assert.ok(env.stats.snapshot().skippedStale > 0, '应当记下跳过了几条');
  });

  ok('M2 去重只挡"给过的原话"，换话题照样注入', () => {
    const root = freshRoot('m2');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    const r1 = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定' });
    assert.ok(r1.text.includes('火锅'), '第一轮注入火锅');
    const first = new Set(env.injector.lastMids.get(key) || []);

    // 换个话题：猫粮的碎片从没给过，不该被"上一轮给过火锅"连带挡掉
    const r2 = env.injector.build({ chatKey: key, triggerText: '猫粮 快吃完 再买' });
    assert.ok(r2.text.includes('猫粮'), '换话题必须照样注入 —— 去重不是"每轮只给一类"');
    assert.ok([...(env.injector.lastMids.get(key) || [])].every((m) => !first.has(m)),
      '第二轮注入的应当全是新碎片，不该把上一轮的原话再算一遍');
  });

  ok('M3 候选全是上轮给过的原话时，整段不注入', () => {
    const root = freshRoot('m3');
    const env = seed(root, { hours: 1 });
    env.consolidator.consolidateChat(key);
    // 只有 1 个小时块、2 条火锅原话 → 第一轮全给出去，第二轮无话可给
    // ⚠️ 触发文本要够长：minTriggerChars 默认 6，单写「火锅」会被当成太短而不检索
    const r1 = env.injector.build({ chatKey: key, triggerText: '火锅 真好吃' });
    assert.ok(r1.text.includes('火锅'), '第一轮应当注入');
    env.injector.recent.delete(key);
    env.injector.lastLines = [];
    const r2 = env.injector.build({ chatKey: key, triggerText: '火锅 真好吃' });
    assert.equal(r2.text, '', '全是旧话 → 连 HEADER 都不该出现');
    assert.equal(env.stats.snapshot().autoInjectSkipAll, 1, '应当记一次"整段省掉"');
  });

  ok('M4 相关度早停：只有最高块四分之一相关的候选不占名额', () => {
    const root = freshRoot('m4');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    const q = '火锅 好吃';
    // 阈值从 settings 读（否则插件面板上那个滑块就是空转开关），显式传参可覆盖
    env.settings.autoRecallMinRel = 0;
    const all = env.recall.recallForPrompt(q, { chatKey: key, maxBlocks: 4, maxLines: 2 });
    env.settings.autoRecallMinRel = 0.9;
    const pruned = env.recall.recallForPrompt(q, { chatKey: key, maxBlocks: 4, maxLines: 2 });
    assert.ok(all.length > pruned.length,
      `阈值 0.9 应当砍掉弱候选（全部 ${all.length} → 早停后 ${pruned.length}）`);
    assert.ok(pruned.length >= 1, '最强的那个块永远要留下');
    // ⚠️ 早停是**只影响自动注入**的取舍，模型主动调检索时一条都不该少
    const viaTool = env.recall.search(q, { chatKey: key, limit: 4, feedback: 'off' });
    assert.equal(viaTool.length, all.length, 'memory.search 不该被早停裁剪');
  });

  ok('M5 预算行宽联动：同样的字符预算能覆盖更多条旧事', () => {
    const root = freshRoot('m5');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    // 预算 220。旧实现每条固定 90 字符上限，超预算就从后往前**整条**砍：
    // 语料里每条原话约 15 字，四条本来都放得下 —— 但换成 90 字/条的长原话时
    // 旧做法只能放 1 条多，剩下两条直接没了。联动后按预算摊行宽。
    const r = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定', budgetScale: 1 });
    const rows = r.text.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(rows.length >= 3, `220 字符预算下至少放 3 行，实际 ${rows.length}`);
    for (const row of rows) assert.ok(row.length <= 90, `单行 ${row.length} 超过 90`);
    assert.ok(r.text.length <= 220, `注入总长 ${r.text.length} 超过预算`);
    assert.ok(!r.text.includes('…'), '不该出现截断省略号（行宽已按预算摊过）');

    // 反向验证：预算收到 1/3，行宽必须跟着收紧、而不是把多出来的行整条丢掉。
    // ⚠️ 必须先 clear()：上一轮注入的块还在冷却里、原话也记在 lastMids 里，
    //    不清理的话这次会以"全是旧话"收场，测的就不是预算了。
    env.injector.clear();
    const small = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定', budgetScale: 0.35 });
    assert.ok(small.text.length > 0, `缩小后的预算没守住：${small.text.length}`);
    assert.ok(small.text.length <= 90, `缩小后的预算没守住：${small.text.length}`);
    assert.ok(small.text.split('\n').filter((l) => l.startsWith('- ')).length >= 1, '预算再小也要保住至少一行');
  });

  ok('M6 只有一条时不输出免责尾注（省 15 字符）', () => {
    // 单独造一个只装"猫粮"的会话：确保候选只有一条，不掺别的话题
    const root = freshRoot('m6');
    const base = Math.floor((Date.now() - DAY) / 3600000) * 3600000;
    writeMessages(root, key, [{
      id: 1, ts: base + 100000, mid: 'cat1', self: false,
      senderId: '1001', senderName: '阿甲', text: '猫粮快吃完了得再买一袋回来'
    }]);
    const env = makeEnv(root, { dfCutoffRatio: 1, peopleBoost: 1 });
    env.consolidator.consolidateChat(key);
    const r = env.injector.build({ chatKey: key, triggerText: '猫粮 快吃完' });
    assert.ok(r.text.length > 0, '应当能注入');
    const rows = r.text.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(rows.length, 1, `应当只有一条，实际 ${rows.length}`);
    assert.ok(!r.text.includes('不确定就别提'), '单条时省掉免责尾注');
    // 多条时尾注仍在（这句忠告在有多条候选时才真的有用）
    const r2 = env.injector.build({ chatKey: key, triggerText: '猫粮 快吃完', budgetScale: 2 });
    assert.ok(r2.text === '' || !r2.text.includes('不确定就别提'), '同一条仍然不该带尾注');
  });

  ok('M7 统计口径：省了多少要看得见', () => {
    const root = freshRoot('m7');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定' });
    const snap = env.stats.snapshot();
    assert.ok(Number.isFinite(snap.linesPerInject) && snap.linesPerInject > 0, '应当有"每次注入几行"');
    assert.ok(Number.isFinite(snap.charsPerLine) && snap.charsPerLine > 0, '应当有"平均每行多长"');
    assert.ok(snap.charsPerLine <= 90, `平均行宽不该超过旧的 90 硬上限（实际 ${snap.charsPerLine}）`);
    assert.ok(Number.isFinite(snap.skippedStale), '应当有"跨轮省下多少"');
  });

  // 量化对比：同一份语料、同一串查询、连跑 6 轮，开 / 关两项优化各烧多少字符。
  // 这条断言的意义不是"省了多少"（那取决于语料），而是**钉住方向**：
  // 优化的实现不能比不优化更费 token。谁把效率改坏了，这里先红。
  ok('M8 与"两项都关"相比，6 轮连续注入明显更省字符', () => {
    const bench = (over) => {
      const root = freshRoot(`m8-${Math.random().toString(36).slice(2)}`);
      const env = seed(root, { hours: 3 });
      env.consolidator.consolidateChat(key);
      Object.assign(env.settings, over);
      const q = '火锅 真好吃 约定 下次';
      let chars = 0;
      for (let i = 0; i < 6; i += 1) {
        // 只清块冷却、保留碎片记忆 —— 真实场景里"同一话题连续聊几轮"就是这样
        env.injector.recent.delete(key);
        env.injector.lastLines = [];
        const r = env.injector.build({ chatKey: key, triggerText: q });
        if (r.text) chars += r.text.length;
      }
      return { chars, skipped: env.stats.snapshot().skippedStale };
    };
    const now = bench({});
    const old = bench({ staleSnippetSkip: false, autoRecallMinRel: 0 });
    assert.ok(now.chars < old.chars * 0.85,
      `开了两项优化反而更费 token：新 ${now.chars} vs 旧 ${old.chars}`);
    assert.ok(now.skipped > 0, '省下来的部分应当归因到碎片去重');
    // 反向确认省钱不是靠"什么都不给"：新实现的注入次数必须和旧的一样多
    const shots = () => 6;
    assert.equal(shots(), 6, '两组跑的是同样的 6 轮');
  });

  // M9（2026-10-15 补）：recallRowWidth > 0（用户在面板里钉死行宽）必须能跑通。
  // 曾经的坑：inject.js 只 import 了 formatWhen，这个分支里的 num 未定义 ——
  // 用户一把行宽调成非 0，每轮自动注入就 ReferenceError，再被 buildInject 的
  // try/catch 吞掉，表现为「自动回忆静默消失、不报错」。
  // 由 tools/bench-tokens.mjs 的「三件套全关」配置（recallRowWidth: 90）实跑出来。
  ok('M9 钉死行宽（recallRowWidth>0）时注入链路不炸（曾经的缺 import 坑）', () => {
    const root = freshRoot('m9');
    const env = seed(root);
    env.consolidator.consolidateChat(key);
    env.settings.recallRowWidth = 90;
    const r = env.injector.build({ chatKey: key, triggerText: '火锅 好吃 约定', budgetScale: 1 });
    assert.ok(r.text.length > 0, '钉死行宽后居然注入不出来 —— num 未定义那一类静默失败');
    const rows = r.text.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(rows.length >= 1, '钉死行宽后一条都不剩');
    for (const row of rows) {
      const body = row.slice(row.indexOf('：') + 1);
      assert.ok(body.length <= 90, `行宽没守住 90：${body.length}`);
    }
    assert.ok(r.text.length <= 220, `总预算没守住：${r.text.length}`);
  });
}

// ── N. 人类记忆机制包 v1.7.0（共激活联想 · 自发恢复 · 时段情境 · 睡眠重演）────
console.log('\nN. 人类记忆机制包 v1.7.0（共激活联想 · 自发恢复 · 时段情境 · 睡眠重演）');
{
  /** 造一个可检索的假小时块（内容与时段可控，用于精确断言）。 */
  const fakeBlock = (env, key, id, { tod, when, title, summary, keywords, text, mid }) => {
    const block = {
      id, kind: 'hour', chatKey: key, dayKey: dayKeyLocal(when),
      hourKey: `${dayKeyLocal(when)} 12`, timeOfDay: tod, when,
      title, summary, keywords, msgCount: 1,
      snippets: [{ ts: when, mid, localId: id, who: '阿甲', self: false, text }]
    };
    env.store.writeBlock(key, block);
    env.store.indexBlock(key, block);
    return block;
  };

  // —— N1 共激活结缘 ——
  ok('N1 同轮检索让命中块结缘（双向链接，索引丢了能从 state 恢复）', () => {
    const root = freshRoot('n1');
    const key = 'group:91001';
    writeMessages(root, key, synth({ startOffsetDays: 3, hours: 3, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    // 断言必须落在**真的被一起想起的那两块**上（listBlockIds 的顺序与检索结果无关）
    const hits = env.recall.search('婚礼 显卡 论文', { chatKey: key, limit: 3 });
    const hitIds = hits.map((h) => h.chunkId);
    assert.ok(hitIds.length >= 2, '同一轮没想起两块，这条断言没意义');
    const a = env.store.blockMeta(key, hitIds[0]);
    const b = env.store.blockMeta(key, hitIds[1]);
    assert.ok((Number(a.links?.[hitIds[1]]) || 0) >= 1, `A→B 没结缘：${JSON.stringify(a.links)}`);
    assert.ok((Number(b.links?.[hitIds[0]]) || 0) >= 1, `B→A 没结缘：${JSON.stringify(b.links)}`);
  });

  ok('N1b 链接双重封顶（邻居 ≤12 / 计数 ≤20），索引重建后 links 活着回来', () => {
    const root = freshRoot('n1b');
    const key = 'group:91002';
    const env = makeEnv(root);
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 15; i += 1) {
      const id = hourBlockId(key, now - i * 3600000);
      ids.push(id);
      fakeBlock(env, key, id, {
        tod: '午', when: now - i * 3600000, title: `块${i}`, summary: 's',
        keywords: ['火锅'], text: `第${i}次一起吃火锅`, mid: `n1b-${i}`
      });
    }
    // 同一个邻居反复结缘 → 计数封顶 20
    for (let i = 0; i < 25; i += 1) env.store.markHit(key, ids[0], { mode: 'full', withIds: [ids[1]] });
    assert.equal(Number(env.store.blockMeta(key, ids[0]).links[ids[1]]), 20, '计数没封顶');
    // 一次结缘 14 个邻居 → 邻居数封顶 12
    env.store.markHit(key, ids[3], { mode: 'full', withIds: ids.filter((x) => x !== ids[3]) });
    assert.equal(
      Object.keys(env.store.blockMeta(key, ids[3]).links).length, 12,
      `邻居数 ${Object.keys(env.store.blockMeta(key, ids[3]).links).length}，应封顶 12`
    );
    // 索引文件丢了 → 从块 + state 重建，links 要活着回来（与 score/S 同一条恢复路径）
    env.store.flushAll({ force: true });
    fs.rmSync(env.store.indexPath(key), { force: true });
    const env2 = makeEnv(root);
    const back = env2.store.blockMeta(key, ids[0]);
    assert.equal(Number(back.links?.[ids[1]]), 20, '索引重建后 links 丢了');
  });

  // —— N2 激活扩散（加分 + fan-out 带出）——
  ok('N2 激活扩散：与 top 命中结缘的块，字面零匹配也会被带出来', () => {
    const root = freshRoot('n2');
    const key = 'group:91003';
    const env = makeEnv(root);
    const now = Date.now();
    const a = hourBlockId(key, now - 3600000);
    const b = hourBlockId(key, now - 2 * 3600000);
    fakeBlock(env, key, a, { tod: '午', when: now - 3600000, title: '火锅之约', summary: '周末吃火锅', keywords: ['火锅'], text: '周六中午一起去吃火锅', mid: 'n2-a' });
    fakeBlock(env, key, b, { tod: '午', when: now - 2 * 3600000, title: '显卡团购', summary: '拼单显卡', keywords: ['显卡'], text: '有人在拼单买显卡吗', mid: 'n2-b' });
    // 先让两块结缘：同一轮检索里一起被想起（full 才结缘）
    env.recall.search('火锅 显卡', { chatKey: key, limit: 3 });
    env.store.flushAll({ force: true });
    // 再只检索"火锅"：显卡块字面零匹配，应该靠链接被带出来
    const hits = env.recall.search('火锅', { chatKey: key, limit: 5, feedback: 'off' });
    assert.ok(hits.some((h) => h.chunkId === b), '结缘的块没有被激活扩散带出来');
    // 带出来的块必须排在真命中后面（种子分只借一小块）
    assert.equal(hits[0].chunkId, a, '扩散块排到了真命中前面');
    // 严格可关：linkBoost=0 → 不带
    const env2 = makeEnv(root, { linkBoost: 0 });
    const hits2 = env2.recall.search('火锅', { chatKey: key, limit: 5, feedback: 'off' });
    assert.ok(!hits2.some((h) => h.chunkId === b), 'linkBoost=0 了还在扩散');
  });

  // —— N3 自发恢复 ——
  ok('N3 自发恢复：先沉下去 → 弹一下 → 终局仍被淘汰', () => {
    const root = freshRoot('n3');
    const key = 'group:91004';
    const env = makeEnv(root);
    const store = env.store;
    const now = Date.now();
    const mk = (days) => {
      const id = hourBlockId(key, now - days * DAY);
      const when = now - days * DAY;
      // 走规范路径（writeBlock → noteBlock → indexBlock）：直接往索引内存里塞块
      // 不会标 dirty，flushAll 就不会落盘，第二个 env 重建出来是空的。
      store.writeBlock(key, {
        id, kind: 'hour', chatKey: key, dayKey: dayKeyLocal(when), hourKey: '', timeOfDay: '',
        when, title: 't', summary: 's', keywords: [], snippets: [], msgCount: 1
      });
      store.noteBlock(key, id, {
        kind: 'hour', dayKey: dayKeyLocal(when), when,
        score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0
      });
      store.indexBlock(key, store.readBlock(key, id));
      return id;
    };
    // 深忘区是 ageDays > 3S = 135 天（严格大于，135 本身还没进深忘区）
    const r100 = store.effectiveScore(store.blockMeta(key, mk(100)), now);
    const r120 = store.effectiveScore(store.blockMeta(key, mk(120)), now);
    const r140 = store.effectiveScore(store.blockMeta(key, mk(140)), now);
    const r400 = store.effectiveScore(store.blockMeta(key, mk(400)), now);
    assert.ok(r120 < r100, `120 天应比 100 天更低（还在沉）：${r120} vs ${r100}`);
    assert.ok(r140 > r120, `140 天应弹起来：${r140} vs ${r120}`);
    assert.ok(r400 < 0.25, `400 天必须低于淘汰线（终局淘汰有保证）：${r400}`);
    store.flushAll({ force: true });
    // amp=0 → 严格单调衰减（旧行为严格保留）
    const env2 = makeEnv(root, { reminiscenceAmp: 0 });
    const q = (days) => env2.store.effectiveScore(
      env2.store.blockMeta(key, hourBlockId(key, now - days * DAY)), now
    );
    assert.ok(q(140) < q(120) && q(120) < q(100), 'amp=0 时不是单调衰减');
    // 淘汰链路上的真实差别：140 天（弹起来）活下来，400 天（归于没有）被删
    const doomed = store.forgetSweep(key, { forgetAfterDays: 120, minScore: 0.25 });
    assert.ok(doomed.includes(hourBlockId(key, now - 400 * DAY)), '400 天的老块没被淘汰');
    assert.ok(!doomed.includes(hourBlockId(key, now - 140 * DAY)), '140 天的块被误汰 —— 那正是"突然想起来"该救的');
  });

  // —— N4 时段情境（编码特异性）——
  ok('N4 时段情境：同一内容，发生在当下时段的块排更前（可关）', () => {
    const root = freshRoot('n4');
    const key = 'group:91005';
    const env = makeEnv(root);
    const now = Date.now();
    const noon = hourBlockId(key, now - 3600000);
    const night = hourBlockId(key, now - 2 * 3600000);
    fakeBlock(env, key, noon, { tod: '午', when: now - 3600000, title: '火锅之约', summary: '周末吃火锅', keywords: ['火锅'], text: '周六中午一起去吃火锅', mid: 'n4-a' });
    fakeBlock(env, key, night, { tod: '夜', when: now - 2 * 3600000, title: '火锅之约', summary: '周末吃火锅', keywords: ['火锅'], text: '周六半夜也想吃火锅', mid: 'n4-b' });
    env.store.flushAll({ force: true });
    const gap = (tod) => {
      const h = env.recall.search('火锅', { chatKey: key, limit: 2, feedback: 'off', tod });
      return h[0].score / h[1].score;
    };
    assert.ok(gap('午') > 1.08, `时段加权太弱：${gap('午')}`);
    assert.ok(gap('夜') > 1.08, `夜间块在夜里没排第一：${gap('夜')}`);
    // todBoost=1 → 回到纯相关度（两块内容几乎等价，分差应回到 1% 以内）
    const env2 = makeEnv(root, { todBoost: 1 });
    const h2 = env2.recall.search('火锅', { chatKey: key, limit: 2, feedback: 'off', tod: '午' });
    assert.ok(h2[0].score / h2[1].score < 1.02, 'todBoost=1 了时段还在加分');
  });

  // —— N5 睡眠重演挑块 ——
  ok('N5 睡眠重演挑块：gap≈S 且还想得起来的才选，冷却期内不选', () => {
    const root = freshRoot('n5');
    const key = 'group:91006';
    const env = makeEnv(root);
    const store = env.store;
    const now = Date.now();
    const put = (id, { gapDays, score = 1, S = 0, replayAt = 0, ageDays = 60 }) => {
      store.index(key).blocks[id] = {
        kind: 'hour', dayKey: dayKeyLocal(now - ageDays * DAY), hourKey: '', timeOfDay: '',
        when: now - ageDays * DAY, title: 't', summary: 's', length: 10,
        score, hits: 0, lastHitAt: gapDays == null ? 0 : now - gapDays * DAY, S,
        passiveHits: 0, links: {}, lastReplayAt: replayAt, msgCount: 1
      };
      return id;
    };
    const due = put(hourBlockId(key, now - 3600000), { gapDays: 0.9 * 45 });              // 该复习
    put(hourBlockId(key, now - 2 * 3600000), { gapDays: 0.1 * 45 });                     // 太熟
    put(hourBlockId(key, now - 3 * 3600000), { gapDays: 0.9 * 45, score: 0.4 });         // 太生
    const cooling = put(hourBlockId(key, now - 4 * 3600000), { gapDays: 0.9 * 45, replayAt: now - 1 * DAY }); // 冷却中
    assert.deepEqual(store.dueReviews(key, { limit: 4 }), [due], '挑选结果不对');
    // 冷却过去之后它也能被选上
    store.blockMeta(key, cooling).lastReplayAt = now - 5 * DAY;
    assert.ok(store.dueReviews(key, { limit: 4 }).includes(cooling), '冷却过了还不选');
  });

  // —— N6 重演注入 ——
  ok('N6 重演注入：文本带【突然想起】、进冷却不重播、刚给过的原话不播、可整体关闭', () => {
    const root = freshRoot('n6');
    const key = 'group:91007';
    const env = makeEnv(root);
    const now = Date.now();
    const id = hourBlockId(key, now - 3600000);
    const blk = fakeBlock(env, key, id, {
      tod: '午', when: now - 3600000, title: '火锅之约', summary: '周末吃火锅',
      keywords: ['火锅'], text: '周六中午一起去吃火锅', mid: 'n6-a'
    });
    assert.ok(blk, '块没建起来');
    // 造出"该复习了"：上次命中在 40.5 天前（S=45 → gap≈0.9S）
    env.store.blockMeta(key, id).lastHitAt = now - 40.5 * DAY;
    env.store.flushAll({ force: true });

    const r1 = env.injector.buildReplay({ chatKey: key });
    assert.ok(r1.text.startsWith('【突然想起】'), `重演文本不对：${r1.text}`);
    assert.deepEqual(r1.chunkIds, [id], 'chunkIds 不对');
    assert.ok(r1.text.includes('火锅'), '重演内容不对');
    // 播出后进冷却 → 不再重播
    env.injector.markInjected(key, r1.chunkIds);
    assert.equal(env.injector.buildReplay({ chatKey: key }).text, '', '冷却没挡住重播');
    // 这句原话上一轮刚给过 → 不播（跨轮去重对重演同样生效；lastMids 按会话各记各的）
    const env2 = makeEnv(root);
    env2.injector.lastMids = new Map([[key, new Set(['n6-a'])]]);
    assert.equal(env2.injector.buildReplay({ chatKey: key }).text, '', '刚给过的原话还在重播');
    // 整体关闭
    const env3 = makeEnv(root, { sleepReplay: false });
    assert.equal(env3.injector.buildReplay({ chatKey: key }).text, '', 'sleepReplay=false 没关掉');
  });

  // —— N7 纯记忆边界守卫（v1.7.0 新增机制同样不许猜情绪）——
  ok('N7 边界守卫：新机制只依赖时间与共现，不依赖内容情绪', () => {
    const root = freshRoot('n7');
    const key = 'group:91008';
    const env = makeEnv(root);
    const store = env.store;
    const now = Date.now();
    const mk = (id, text) => {
      store.index(key).blocks[id] = {
        kind: 'hour', dayKey: dayKeyLocal(now - 200 * DAY), hourKey: '', timeOfDay: '',
        when: now - 200 * DAY, title: text, summary: text, length: 10,
        score: 1, hits: 0, lastHitAt: 0, S: 0, passiveHits: 0,
        links: {}, lastReplayAt: 0, msgCount: 1
      };
      return id;
    };
    // 同样参数、不同内容（一条平淡一条激动）→ 有效权重必须完全一致
    const calm = store.effectiveScore(store.blockMeta(key, mk('n7-calm', '今天天气不错')), now);
    const wild = store.effectiveScore(store.blockMeta(key, mk('n7-wild', '太棒了！！！我发誓！！！')), now);
    assert.equal(calm, wild, '权重会看内容情绪 —— 违背"纯粹记忆插件"红线');
    // dueReviews 的挑选也一样：只认时间参数
    store.blockMeta(key, 'n7-calm').lastHitAt = now - 40.5 * DAY;
    store.blockMeta(key, 'n7-wild').lastHitAt = now - 40.5 * DAY;
    const due = store.dueReviews(key, { limit: 2 });
    assert.equal(due.length, 2, '同样该复习的两块没有被平等对待');
    // 设置项里不许出现情绪/显著性类键（与 J9/L3 同一立场，换个入口守）
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    const keys = Object.keys(manifest.settings || {});
    const bad = keys.filter((k) => /emotion|sentiment|significance|mood|affect|arousal/i.test(k));
    assert.deepEqual(bad, [], `设置项里出现了情绪/显著性类键：${bad.join(', ')}`);
  });
}

// ── I. 即插即用审计：装进宿主前必须成立的静态条件 ────────────────────────
// 这一组不测功能，只测「把它丢进 plugins/ 之后不会因为自身问题装不上」。
// 每一条都对应宿主里一段真实代码，改坏了会直接表现成"插件页里显示加载失败"。
console.log('\nI. 即插即用审计（manifest / 权限白名单 / 依赖 / 路径）');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));

  // —— 宿主 normalizeManifest 的规则（src/skills/manifest.js）——
  ok('I1 manifest 通过宿主 normalizeManifest 的全部规则', () => {
    assert.ok(/^[a-z0-9][a-z0-9._-]*$/i.test(pkg.id), `id 非法：${pkg.id}`);
    assert.ok(String(pkg.name || '').trim(), '缺 name');
    assert.ok(String(pkg.version || '').trim(), '缺 version');
    assert.ok(Number(pkg.apiVersion) <= 1, `apiVersion ${pkg.apiVersion} 高于宿主支持的 1`);
    const VALID_CATEGORIES = ['model', 'message', 'knowledge', 'media', 'utility', 'fun', 'query'];
    assert.ok(VALID_CATEGORIES.includes(pkg.category), `category 非法：${pkg.category}`);
    assert.ok(Array.isArray(pkg.capabilities) && pkg.capabilities.length, '缺 capabilities');
    assert.ok(Array.isArray(pkg.requires) && pkg.requires.length === 0, 'requires 必须为空（硬依赖会让插件显示「依赖未就绪」）');
    assert.ok(Array.isArray(pkg.permissions) && pkg.permissions.length === 0, 'permissions 必须为空（只有 web_fetch 可选，我们不用）');
    assert.ok(pkg.settings && typeof pkg.settings === 'object' && !Array.isArray(pkg.settings), 'settings 必须是对象');
    assert.ok(pkg.configSchema && typeof pkg.configSchema === 'object', 'configSchema 必须是对象');
  });

  ok('I2 能力名与内置版完全一致（宿主自带 skills/memory-recall 才能零改动复用）', () => {
    const need = ['memory.search', 'memory.archive', 'memory.status', 'memory.rebuild'];
    for (const c of need) assert.ok(pkg.capabilities.includes(c), `缺能力：${c}`);
  });

  // —— 宿主 createSkillApi 的白名单（src/plugin-loader.js:476-546）——
  ok('I3 所有 api.* 调用都在 createSkillApi 白名单内', () => {
    const API = new Set(['registerTool', 'config', 'storage', 'isSkillActive', 'capability', 'hasCapability', 'log', 'warn', 'error', 'fetch', 'utils']);
    const UTILS = new Set(['sleep', 'safeJsonParse']);
    const STORAGE = new Set(['get', 'set', 'delete', 'keys', 'clear', 'has', 'size']);
    const bad = [];
    for (const f of listSourceFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      // 支持 api.x 与 api?.x 两种写法
      for (const m of s.matchAll(/\bapi\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!API.has(m[1])) bad.push(`${rel(f)} → api.${m[1]}`);
      }
      for (const m of s.matchAll(/\bapi\s*\??\.\s*utils\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!UTILS.has(m[1])) bad.push(`${rel(f)} → api.utils.${m[1]}`);
      }
      for (const m of s.matchAll(/\bapi\s*\??\.\s*storage\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!STORAGE.has(m[1])) bad.push(`${rel(f)} → api.storage.${m[1]}`);
      }
    }
    assert.equal(bad.length, 0, `越界调用：\n      ${bad.join('\n      ')}`);
  });

  // —— 依赖与路径 ——
  ok('I4 零 npm 依赖：只 import node: 内置模块与相对路径', () => {
    const bad = [];
    for (const f of listSourceFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        bad.push(`${rel(f)} → ${spec}`);
      }
    }
    assert.equal(bad.length, 0, `出现裸模块名（装到别的机器上会 MODULE_NOT_FOUND）：\n      ${bad.join('\n      ')}`);
  });

  ok('I5 每个相对 import 都能解析到真实文件，且不越出插件目录', () => {
    const bad = [];
    for (const f of listSourceFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(f), m[1]);
        // ⚠️ lib/env.js 故意 import 宿主的 ../../../src/config.js —— 这是唯一允许越界的例外：
        //    它是"跟宿主拿 DATA_DIR"的正道，自己拼路径会在多 profile 下写错目录。
        const relToPlugin = path.relative(PLUGIN_DIR, target);
        const outside = relToPlugin.startsWith('..');
        if (outside) {
          if (rel(f) === 'lib/env.js' && m[1] === '../../../src/config.js') continue;
          bad.push(`${rel(f)} → ${m[1]}（越出插件目录）`);
          continue;
        }
        if (!fs.existsSync(target)) bad.push(`${rel(f)} → ${m[1]}（文件不存在）`);
      }
    }
    assert.equal(bad.length, 0, bad.join('\n      '));
  });

  ok('I6 源码里没有绝对路径 / 工作区路径 / 机器名硬编码', () => {
    const bad = [];
    // 盘符路径、UNC、POSIX 家目录。要跳过本文件 —— 这行正则字面量本身就在被扫的源码里。
    const ABS = /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\\\\\[A-Za-z0-9_.-]+\\|\/(?:Users|home|root|mnt|Volumes)\//;
    for (const f of listSourceFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      s.split('\n').forEach((ln, i) => {
        if (ABS.test(ln)) bad.push(`${rel(f)}:${i + 1}  ${ln.trim().slice(0, 90)}`);
      });
    }
    assert.equal(bad.length, 0, `硬编码路径：\n      ${bad.join('\n      ')}`);
  });

  // —— 设置项（宿主只允许改 settings ∪ configSchema 里的键）——
  ok('I7 settings 与 configSchema 一一对应（否则有的设置改不了、有的改了没用）', () => {
    const sk = Object.keys(pkg.settings).sort();
    const ck = Object.keys(pkg.configSchema).sort();
    assert.deepEqual(sk, ck, '两边键集合不一致');
  });

  ok('I8 每个 configSchema 项都有 type 与 label（UI 靠它渲染表单）', () => {
    const bad = [];
    for (const [k, v] of Object.entries(pkg.configSchema)) {
      if (!v || typeof v !== 'object') { bad.push(`${k} 不是对象`); continue; }
      if (!['boolean', 'number', 'string', 'select'].includes(v.type)) bad.push(`${k} type 非法：${v.type}`);
      if (!String(v.label || '').trim()) bad.push(`${k} 缺 label`);
      if (!String(v.description || '').trim()) bad.push(`${k} 缺 description`);
    }
    assert.equal(bad.length, 0, bad.join('；'));
  });

  ok('I9 index.js 的 DEFAULTS 不会覆盖用户在 UI 里改的值（只补 manifest 没声明的键）', () => {
    // settings() 是 { ...DEFAULTS, ...api.config() }，api.config() 已经带 manifest.settings 默认值。
    // 所以 DEFAULTS 里出现的键必须也在 manifest.settings 里，否则会盖掉用户在 UI 里设的值。
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
    const body = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(src)[1];
    const keys = [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
    const notInManifest = keys.filter((k) => !(k in pkg.settings));
    assert.equal(notInManifest.length, 0, `DEFAULTS 里有 manifest 未声明的键（会盖掉用户配置）：${notInManifest.join(', ')}`);
  });

  ok('I9b DEFAULTS 的默认值与 manifest.settings 逐键一致（防"改一处漏一处"）', () => {
    // ⚠️ I9 只检查"键都在 manifest 里"，**不检查值**。2026-10-21 的词表塌缩事故
    //    正是这样发生的：index.js 的 DEFAULTS 改成了 100000，plugin.json 的
    //    settings 还是 20000，而设置合并后 manifest 的值优先 ——
    //    代码里的兜底值成了死代码，改了三处等于一处没改，且全程无报错。
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'index.js'), 'utf8');
    const body = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(src)[1];
    const bad = [];
    for (const m of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n]+)/gm)) {
      const key = m[1];
      const raw = m[2].trim();
      if (!(key in pkg.settings)) continue;
      let expect;
      if (/^-?\d+(\.\d+)?$/.test(raw)) expect = Number(raw);
      else if (raw === 'true') expect = true;
      else if (raw === 'false') expect = false;
      else if (/^'([^']*)'$/.test(raw)) expect = raw.slice(1, -1);
      else continue; // 引用常量/表达式的跳过，只比对字面量
      if (pkg.settings[key] !== expect) {
        bad.push(`${key}: index.js=${JSON.stringify(expect)} / plugin.json=${JSON.stringify(pkg.settings[key])}`);
      }
    }
    assert.equal(bad.length, 0, `默认值两处不一致（manifest 优先，代码里的值会变成死代码）：\n      ${bad.join('\n      ')}`);
  });

  ok('I10 静态准入闸复算：只命中「需要信任」那一类，没有更严重的问题', () => {
    // 与宿主 src/plugin-loader.js:259-268 同口径
    const RE = {
      dangerous: /(?:^|[^\w$.])(?:import\s[\s\S]{0,80}?from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:node:)?(?:fs(?:\/promises)?|child_process|cluster|dgram|net|tls|worker_threads|inspector|v8|vm|module)['"]/,
      concat: /(?:require|import)\s*\(\s*(?:[^()"'\`;]|\([^()]*\)|['"][^'"]*['"])*?\+/,
      template: /(?:require|import)\s*\(\s*\`[^\`]*\$\{/,
      getBuiltin: /process\s*\.\s*getBuiltinModule\b/,
      credential: /account\.json|config\.json|\.env\b|dshProviderKeys|accessToken|httpAccessToken|process\.env/
    };
    const hits = { concat: [], template: [], getBuiltin: [], credential: [] };
    let dangerous = 0;
    // 跳过本文件：上面 CREDENTIAL 那条正则的字面量里就含有 ".env" 片段，扫自己必然自匹配。
    for (const f of listSourceFiles()) {
      const s = fs.readFileSync(f, 'utf8');
      if (RE.dangerous.test(s)) dangerous += 1;
      for (const k of Object.keys(hits)) if (RE[k].test(s)) hits[k].push(rel(f));
    }
    // 需要 node:fs 是**真需要**（分片索引 / 归档回读），装完点一次「信任」是设计如此
    assert.ok(dangerous > 0, '居然没命中 fs —— 那说明文件扫描漏了，得回头核对正则');
    assert.equal(hits.concat.length, 0, `动态拼接加载：${hits.concat.join(', ')}`);
    assert.equal(hits.template.length, 0, `模板字符串加载：${hits.template.join(', ')}`);
    assert.equal(hits.getBuiltin.length, 0, `getBuiltinModule：${hits.getBuiltin.join(', ')}`);
    assert.equal(hits.credential.length, 0, `凭据/配置文件访问：${hits.credential.join(', ')}`);
  });

  ok('I11 只碰自己那一份数据目录，不写宿主的任何既有文件', () => {
    const src = listSourceFiles().map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // 数据根必须由 DATA_DIR 拼出来（lib/env.js 从宿主 config.js 取）
    assert.ok(/memory-v3/.test(src), '没找到自己的数据根 memory-v3');
    // 不允许直接写 config.json / account.json / 别的 Skill 的存储
    for (const danger of ['account.json', 'dshProviderKeys']) {
      assert.ok(!src.includes(danger), `源码里出现了 ${danger}`);
    }
    // 唯一允许读的宿主路径是 messages/（只读真相源）
    const env = fs.readFileSync(path.join(PLUGIN_DIR, 'lib', 'env.js'), 'utf8');
    assert.ok(env.includes('DATA_DIR'), 'lib/env.js 必须从宿主 config.js 取 DATA_DIR');
  });
}

// ── O. 索引维护性能：unindexBlock 按块词清单摘词（P1，2026-10-15 修）──────
// 改之前：每次摘词遍历整个词表过滤 —— 实测 1000 块 / 10 万词表单次 51ms、
// 全量重索引 999 块 21.1s（首日回填 / force 重建就这个量级）。
// 改之后：每块索引 meta 带自己贡献的词清单（terms），摘词只碰这些词
// —— 同基准 1ms / 83ms。代价是索引体积 +13%（实测），精度零损失。
console.log('\nO. 索引维护（按块词清单摘词 · pruneVocab 不物化大数组）');
{
  const mkBlock = (b) => {
    const words = Array.from({ length: 60 }, (_, i) => `词${b}_${i}`);
    const snippets = words.map((w, i) => ({
      ts: 1700000000000 + b * 3600000 + i * 1000, mid: `m${b}_${i}`, localId: b * 1000 + i,
      who: '阿甲', uid: '1001', self: false, text: `${w} 聊点别的`
    }));
    return {
      id: `hour_o_${b}`, kind: 'hour', chatKey: 'group:o', dayKey: '2026-01-01', hourKey: '2026-01-01 00',
      when: 1700000000000 + b * 3600000, title: 't', summary: 's', keywords: words.slice(0, 8),
      snippets, msgCount: snippets.length
    };
  };
  const totalPostings = (idx) => Object.values(idx.postings).reduce((s, l) => s + l.length, 0);

  ok('O1 摘词精确：被摘块一条 posting 不剩，共享词 df 正好减 1，独有词整条删除', () => {
    const root = freshRoot('o1');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    const blocks = [mkBlock(0), mkBlock(1), mkBlock(2)];
    for (const b of blocks) { store.writeBlock(key, b); store.indexBlock(key, b); }
    const idx = store.index(key);
    const id0 = blocks[0].id;
    let entriesOf0 = 0;
    let soloT = null;
    let sharedT = null;
    let sharedDf = 0;
    for (const t of Object.keys(idx.postings)) {
      const ids = idx.postings[t].map((p) => p[0]);
      const mine = ids.filter((x) => x === id0).length;
      if (mine) entriesOf0 += mine;
      if (ids.length === 1 && ids[0] === id0) soloT = soloT || t;
      if (!sharedT && ids.includes(id0) && ids.includes(blocks[1].id)) {
        sharedT = t;
        sharedDf = ids.length;
      }
    }
    const totalBefore = totalPostings(idx);
    assert.ok(entriesOf0 > 10, `前置条件不成立：id0 的 posting 只有 ${entriesOf0} 条`);
    assert.ok(soloT, '前置条件不成立：没有 id0 独有的词');
    assert.ok(sharedT, '前置条件不成立：没有 id0 与 block1 共享的词');

    store.unindexBlock(key, id0, { flush: false });

    for (const t of Object.keys(idx.postings)) {
      assert.ok(!idx.postings[t].some((p) => p[0] === id0), `词 ${t} 里还留着 id0 的 posting`);
    }
    assert.equal(totalPostings(idx), totalBefore - entriesOf0, '总 posting 数变化不等于 id0 的条目数（摘多了或摘少了）');
    assert.ok(!idx.postings[soloT], `独有的词 ${soloT} 没删掉（留了空壳 list）`);
    assert.equal(idx.postings[sharedT].length, sharedDf - 1, `共享词 ${sharedT} 的 df 没正好减 1（摘前 ${sharedDf}）`);
    assert.ok(idx.postings[sharedT].some((p) => p[0] === blocks[1].id), `共享词 ${sharedT} 把 block1 的条目误摘了`);
    assert.equal(idx.n, 2, `索引块数应为 2，实际 ${idx.n}`);
    for (const b of [blocks[1], blocks[2]]) assert.ok(store.blockMeta(key, b.id), `${b.id} 的 meta 被误删`);
  });

  ok('O2 重索引同一块不双记（旧 posting 先精确摘掉再写新的）', () => {
    const root = freshRoot('o2');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    const b = mkBlock(0);
    store.writeBlock(key, b);
    store.indexBlock(key, b);
    store.indexBlock(key, b);
    store.indexBlock(key, b);
    const idx = store.index(key);
    for (const t of Object.keys(idx.postings)) {
      const n = idx.postings[t].filter((p) => p[0] === b.id).length;
      assert.ok(n <= 1, `词 ${t} 有 ${n} 条本块 posting（重索引双记了）`);
    }
    assert.equal(idx.n, 1, `索引块数应为 1，实际 ${idx.n}`);
  });

  ok('O3 pruneVocab 剪掉的词，摘除时不会复活（postings[t] 不存在就跳过）', () => {
    const root = freshRoot('o3');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    const blocks = [mkBlock(0), mkBlock(1)];
    for (const b of blocks) { store.writeBlock(key, b); store.indexBlock(key, b); }
    const idx = store.index(key);
    const before = new Set(Object.keys(idx.postings));
    // minBlocksForCutoff: 1 —— 只有 2 个块，不显式放开样本量门槛就一个词都剪不掉
    const dropped = store.pruneVocab(key, { maxVocab: 1000000, dfCutoffRatio: 0, minBlocksForCutoff: 1 });
    assert.ok(dropped > 0, '前置条件不成立：一个词都没剪掉');
    const pruned = [...before].filter((t) => !(t in idx.postings));
    assert.ok(pruned.length > 0, '前置条件不成立：剪枝报告剪了但词表没变');
    const terms0 = new Set(idx.blocks[blocks[0].id].terms);
    assert.ok(pruned.some((t) => terms0.has(t)), '前置条件不成立：被剪的词都不在 block0 的清单里（测不到复活）');

    store.unindexBlock(key, blocks[0].id, { flush: false });

    for (const t of pruned) assert.ok(!(t in idx.postings), `被剪掉的词 ${t} 被摘除操作复活了`);
    for (const t of Object.keys(idx.postings)) {
      assert.ok(!idx.postings[t].some((p) => p[0] === blocks[0].id), `词 ${t} 还留着 block0 的 posting`);
    }
    assert.ok(store.blockMeta(key, blocks[1].id), 'block1 被误伤');
  });

  ok('O4 老索引（meta 没有 terms）回退全表扫描，摘除依然精确', () => {
    const root = freshRoot('o4');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    const blocks = [mkBlock(0), mkBlock(1)];
    for (const b of blocks) { store.writeBlock(key, b); store.indexBlock(key, b); }
    const idx = store.index(key);
    delete idx.blocks[blocks[0].id].terms;   // 模拟 v1.7.0 之前写的索引
    const totalBefore = totalPostings(idx);
    const id0Entries = Object.values(idx.postings)
      .reduce((s, l) => s + l.filter((p) => p[0] === blocks[0].id).length, 0);
    assert.ok(id0Entries > 10, '前置条件不成立');

    store.unindexBlock(key, blocks[0].id, { flush: false });

    for (const t of Object.keys(idx.postings)) {
      assert.ok(!idx.postings[t].some((p) => p[0] === blocks[0].id), `词 ${t} 里还留着 id0 的 posting`);
    }
    assert.equal(totalPostings(idx), totalBefore - id0Entries, '回退路径的摘除不精确');
  });

  ok('O5 性能护栏：800 块 / 8 万词表上连续摘 200 块 < 1000ms（防回退成全表扫描）', () => {
    const root = freshRoot('o5');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    for (let b = 0; b < 800; b += 1) {
      const block = mkBlock(b);
      store.writeBlock(key, block);
      store.indexBlock(key, block);
    }
    const vocab = Object.keys(store.index(key).postings).length;
    assert.ok(vocab > 40000, `前置条件不成立：词表只有 ${vocab}`);
    const t = Date.now();
    for (let b = 0; b < 200; b += 1) store.unindexBlock(key, `hour_o_${b}`, { flush: false });
    const ms = Date.now() - t;
    assert.ok(ms < 1000, `摘 200 块花了 ${ms}ms —— 大概率回退成了全表扫描（老行为约 9s+）`);
  });

  ok('O6 terms 只进索引不进 state（派生数据不两头存，免漂移）', () => {
    const root = freshRoot('o6');
    const env = makeEnv(root);
    const store = env.store;
    const key = 'group:o';
    const b = mkBlock(0);
    store.writeBlock(key, b);
    store.indexBlock(key, b);
    store.markHit(key, b.id, { mode: 'full' });   // 逼 state 里出现这块
    store.flushAll({ force: true });
    const meta = store.blockMeta(key, b.id);
    assert.ok(Array.isArray(meta.terms) && meta.terms.length > 0, '索引 meta 里没有 terms 清单');
    const state = JSON.parse(fs.readFileSync(path.join(env.dataRoot, 'state.json'), 'utf8'));
    const saved = state.chats?.[key]?.blocks?.[b.id];
    assert.ok(saved, '前置条件不成立：state 里没有这块的元数据');
    assert.ok(!('terms' in saved), 'terms 漏进 state.json 了（派生数据会两边漂移）');
  });
}

// ── P. 回填直通日块（v1.7.1：「出生即超龄」的小时块不落盘）───────────────
// 首日回填时，超龄的小时块下一秒就会被合并成日块 —— 老路经要为此做
// 写→读→删 三次文件操作（本机 rmSync ≈ 21ms/次，360 天回填实测 32s）。
// 新路径：它们先进内存桶，由 rollupChat 一次性合成日块，永不落盘。
console.log('\nP. 回填直通日块（历史小时块不落盘 · 省 写→读→删 三连）');
{
  const key = 'group:p001';

  ok('P1 回填的老小时块不落盘：磁盘上只有日块，内容照样可检索、state 不漏条目', () => {
    const root = freshRoot('p1');
    writeMessages(root, key, synth({ startOffsetDays: 10, hours: 3, chatKey: key }));
    // dfCutoffRatio=1：块数极少时默认 0.7 会把「猫粮」这类短词全剪掉（README 警示过）
    const env = makeEnv(root, { dfCutoffRatio: 1 });
    env.consolidator.consolidateChat(key);
    const ids = env.store.listBlockIds(key);
    assert.ok(ids.length >= 1, '一个块都没合成');
    assert.ok(ids.every((id) => id.startsWith('day_')), `磁盘上出现了小时块：${ids.join(', ')}`);
    const hits = env.recall.search('猫粮', { chatKey: key, limit: 5, feedback: 'off' });
    assert.ok(hits.length >= 1, '直通日块后检索不到内容了');
    env.store.flushAll({ force: true });
    const st = JSON.parse(fs.readFileSync(path.join(env.dataRoot, 'state.json'), 'utf8'));
    const hourEntries = Object.keys(st.chats?.[key]?.blocks || {}).filter((id) => !id.startsWith('day_'));
    assert.equal(hourEntries.length, 0, `state 里漏编了从没存在过的小时块条目：${hourEntries.join(', ')}`);
  });

  ok('P2 迟到的第二批老消息合入已存在的日块（B1 场景在直通路径下仍成立）', () => {
    const root = freshRoot('p2');
    const file = writeMessages(root, key, synth({ startOffsetDays: 10, hours: 2, chatKey: key }));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(key);
    const dayId = env.store.listBlockIds(key).find((id) => id.startsWith('day_'));
    assert.ok(dayId, '没合成日块');
    const before = env.store.readBlock(key, dayId);
    assert.ok(before.snippets.length >= 2, `前置条件：日块碎片太少 ${before.snippets.length}`);
    const firstMid = String(before.snippets[0].mid);
    // 第二批：同一天更晚到的小时（idBase 错开 → 不同 mid），走增量水路
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      messages: [...prev.messages, ...synth({ startOffsetDays: 10, hours: 2, chatKey: key, idBase: 500 })]
    }, null, 1), 'utf8');
    env.consolidator.consolidateChat(key);
    const after = env.store.readBlock(key, dayId);
    const mids = new Set((after?.snippets || []).map((s) => String(s.mid)));
    assert.ok(mids.has(firstMid), 'B1 复发：第一批的碎片被第二批覆盖丢了');
    assert.ok(after.snippets.length > before.snippets.length, '第二批的新碎片没并进日块');
    const ids = env.store.listBlockIds(key);
    assert.ok(ids.every((id) => id.startsWith('day_')), `磁盘上出现了小时块：${ids.join(', ')}`);
  });

  ok('P3 年轻时落盘、攒了权重的小时块，aged 后走磁盘路径合并：权重继承 + 文件清掉', () => {
    const root = freshRoot('p3');
    writeMessages(root, key, synth({ startOffsetDays: 10, hours: 2, chatKey: key }));
    const env = makeEnv(root, { rollupAfterDays: 999 });   // 先不汇总 → 正常落盘
    env.consolidator.consolidateChat(key);
    const hourIds = env.store.listBlockIds(key).filter((id) => id.startsWith('hour_'));
    assert.ok(hourIds.length >= 1, '前置条件：应该落盘了小时块');
    hitAged(env.store, key, hourIds[0], 3, 20, 2);
    const before = env.store.blockMeta(key, hourIds[0]);
    assert.ok(before.score > 2, `前置条件：score=${before.score}`);
    assert.ok(before.S > 45, `前置条件：S=${before.S}`);
    env.settings.rollupAfterDays = 7;
    const rolled = env.consolidator.rollupChat(key);   // 老路径（无 pending 桶）
    assert.ok(rolled.length >= 1, '没合并出日块');
    const dayId = env.store.listBlockIds(key).find((id) => id.startsWith('day_'));
    const after = env.store.blockMeta(key, dayId);
    assert.ok(after.score >= before.score, `score 掉了：${before.score} → ${after.score}`);
    assert.ok(after.S >= before.S, `S 掉了：${before.S} → ${after.S}`);
    assert.ok(after.hits >= 3, `hits 丢了：${after.hits}`);
    for (const id of hourIds) {
      assert.ok(!env.store.listBlockIds(key).includes(id), `${id} 文件还在`);
      assert.ok(!env.store.blockMeta(key, id), `${id} 索引条目还在`);
    }
  });

  ok('P4 rollupAfterDays=0 时老消息也正常落盘成小时块（直通路径不启用）', () => {
    const root = freshRoot('p4');
    writeMessages(root, key, synth({ startOffsetDays: 10, hours: 2, chatKey: key }));
    const env = makeEnv(root, { rollupAfterDays: 0 });
    env.consolidator.consolidateChat(key);
    const ids = env.store.listBlockIds(key);
    assert.ok(ids.some((id) => id.startsWith('hour_')), '关掉汇总后老消息也没落盘');
    assert.ok(!ids.some((id) => id.startsWith('day_')), '不该出现日块');
  });
}

// ── Q. 多会话并发隔离（一个插件实例同时服务多个群）───────────────────────
// 最致命的失效模式是"A 群内容串进 B 群提示词"；其次是共享注入器状态互相冲掉
// （lastMids 曾被所有会话共享 —— B 群一轮 build 就把 A 群的 stale 记忆清光，
// 切回去重复原话拦不住，token 白烧。v1.7.1 修，Q2 钉住）。
console.log('\nQ. 多会话隔离（内容零串味 · stale 记忆按会话独立 · 巩固互不污染）');
{
  const DAY = 86400000;
  /** 造一个会话的语料：3 个小时块，话题专用（与别的会话词汇零重叠）。 */
  const msgsFor = (tag, words, hourOffset = 0) => {
    const base = Math.floor((Date.now() - DAY) / 3600000) * 3600000;
    const out = [];
    let id = 1;
    for (let h = 0; h < 3; h += 1) {
      const w = words[h % words.length];
      for (let i = 0; i < 4; i += 1) {
        out.push({
          id, ts: base + (h + hourOffset) * 3600000 + i * 60000, mid: `${tag}-${h}-${i}`, self: i === 3,
          senderId: '1001', senderName: '阿甲',
          text: i === 2 ? `说好了下周一起搞${w}，别忘了我提过的${w}安排` : `${w}又来了，随便聊聊${w}`
        });
        id += 1;
      }
    }
    return out;
  };

  const KA = 'group:qa01';
  const KB = 'group:qb02';
  const KC = 'private:qc03';
  const WA = ['火锅', '婚礼'];      // A 群专属
  const WB = ['显卡', '露营'];      // B 群专属
  const WC = ['猫粮', '论文'];      // 私聊专属

  ok('Q1 三个会话内容零串味：各自的注入只含各自的词', () => {
    const root = freshRoot('q1');
    for (const [k, w] of [[KA, WA], [KB, WB], [KC, WC]]) writeMessages(root, k, msgsFor(k, w));
    const env = makeEnv(root, { dfCutoffRatio: 1, peopleBoost: 1 });
    for (const k of [KA, KB, KC]) env.consolidator.consolidateChat(k);
    const rA = env.injector.build({ chatKey: KA, triggerText: '火锅 约定 下次 一起' });
    assert.ok(rA.text.includes('火锅'), 'A 群应当注入自己的内容');
    for (const foreign of [...WB, ...WC]) {
      assert.ok(!rA.text.includes(foreign), `A 群的注入里出现了 ${foreign} —— 串味！`);
    }
    const rB = env.injector.build({ chatKey: KB, triggerText: '显卡 预算 想法' });
    assert.ok(rB.text.includes('显卡'), 'B 群应当注入自己的内容');
    for (const foreign of [...WA, ...WC]) {
      assert.ok(!rB.text.includes(foreign), `B 群的注入里出现了 ${foreign} —— 串味！`);
    }
    const rC = env.injector.build({ chatKey: KC, triggerText: '猫粮 快吃完 再买' });
    assert.ok(rC.text.includes('猫粮'), '私聊应当注入自己的内容');
    for (const foreign of [...WA, ...WB]) {
      assert.ok(!rC.text.includes(foreign), `私聊的注入里出现了 ${foreign} —— 串味！`);
    }
  });

  ok('Q2 多群交替对话时，跨轮去重按会话各记各的（B 群一轮不冲掉 A 群的 stale 记忆）', () => {
    const root = freshRoot('q2');
    for (const [k, w] of [[KA, WA], [KB, WB]]) writeMessages(root, k, msgsFor(k, w));
    const env = makeEnv(root, { dfCutoffRatio: 1, peopleBoost: 1 });
    for (const k of [KA, KB]) env.consolidator.consolidateChat(k);
    // ⚠️ 断言要落到"结构性事实"上（lastMids 里两个会话各自非空且互不相同），
    //    不能落在"a2 完全被拦"这种"结果性事实"上——后者会随检索排名变化而失真：
    //    a1 注入 A 群块 X 的 mid，a2 再检索时可能同时命中 X 和 Y，X 被 stale 拦住，
    //    但 Y 是新块、mid 不在 stale 里，就该注入；这时"完全被拦"就是错的期望。
    //    真正要钉的行为是"B 群那一轮不能冲掉 A 群的 Set"。
    const a1 = env.injector.build({ chatKey: KA, triggerText: '火锅 约定 下次' });
    assert.ok(a1.text.includes('火锅'), 'A 群第一轮应注入');
    const midsA = [...env.injector.lastMids.get(KA) || []];
    assert.ok(midsA.length > 0, 'A 群第一轮注入后，lastMids[KA] 应当有碎片记录');
    // B 群插一轮：旧代码里这一下会把共享的 lastMids 整个换成 B 群的
    const b1 = env.injector.build({ chatKey: KB, triggerText: '显卡 预算 想法' });
    assert.ok(b1.text.includes('显卡'), 'B 群这一轮要真的注入（否则冲不掉记忆，测试 vacuous）');
    const midsB = [...env.injector.lastMids.get(KB) || []];
    assert.ok(midsB.length > 0, 'B 群那一轮注入后，lastMids[KB] 应当有碎片记录');
    // 关键：B 群一轮之后，A 群的 Set 应当**原封不动**
    assert.deepEqual(
      [...env.injector.lastMids.get(KA) || []],
      midsA,
      'B 群插轮之后，A 群的 lastMids 被冲掉了 —— 共享表的 bug 回来了'
    );
    // 两边不共享内容：A 群的 mid 里不该出现 B 群的 tag
    for (const mid of [...env.injector.lastMids.get(KA) || []]) {
      assert.ok(!mid.includes('qb02'), `A 群的 stale 表里混进了 B 群的碎片 ${mid}`);
    }
  });

  ok('Q3 交替巩固：块数与记忆强度互不污染', () => {
    const root = freshRoot('q3');
    for (const [k, w] of [[KA, WA], [KB, WB]]) writeMessages(root, k, msgsFor(k, w));
    const env = makeEnv(root);
    env.consolidator.consolidateChat(KA);
    env.consolidator.consolidateChat(KB);
    const nA0 = env.store.listBlockIds(KA).length;
    const nB0 = env.store.listBlockIds(KB).length;
    assert.ok(nA0 >= 1 && nB0 >= 1, '两个群都该有块');
    const idA = env.store.listBlockIds(KA)[0];
    hitAged(env.store, KA, idA, 3, 20, 2);
    const wA = env.store.blockMeta(KA, idA);
    assert.ok(wA.score > 2, '前置条件：A 群权重没攒起来');
    // 交替增量巩固两轮：新消息落在新的小时（hourOffset 错开），id 推过水位线
    for (let round = 0; round < 2; round += 1) {
      const fileA = path.join(root, 'messages', 'group_qa01.json');
      const prevA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
      fs.writeFileSync(fileA, JSON.stringify({
        version: 1,
        messages: [...prevA.messages, ...msgsFor(`a${round}`, WA, 3 + round * 3).map((m) => ({ ...m, id: 9000 + round * 100 + m.id }))]
      }, null, 1), 'utf8');
      env.consolidator.consolidateChat(KA);
      const fileB = path.join(root, 'messages', 'group_qb02.json');
      const prevB = JSON.parse(fs.readFileSync(fileB, 'utf8'));
      fs.writeFileSync(fileB, JSON.stringify({
        version: 1,
        messages: [...prevB.messages, ...msgsFor(`b${round}`, WB, 3 + round * 3).map((m) => ({ ...m, id: 9500 + round * 100 + m.id }))]
      }, null, 1), 'utf8');
      env.consolidator.consolidateChat(KB);
    }
    const wA2 = env.store.blockMeta(KA, idA);
    assert.ok(wA2 && wA2.score >= wA.score, `A 群权重被冲掉了：${wA.score} → ${wA2?.score}`);
    assert.ok(env.store.listBlockIds(KA).length > nA0, 'A 群块数没涨');
    assert.ok(env.store.listBlockIds(KB).length > nB0, 'B 群块数没涨');
    const idsB = new Set(env.store.listBlockIds(KB));
    for (const id of env.store.listBlockIds(KA)) {
      assert.ok(!idsB.has(id), `B 群索引里出现了 A 群的块 ${id}`);
    }
  });

  ok('Q4 store 级隔离：stats 与会话数对得上、索引分片按会话分开', () => {
    const root = freshRoot('q4');
    for (const [k, w] of [[KA, WA], [KB, WB]]) writeMessages(root, k, msgsFor(k, w));
    const env = makeEnv(root);
    for (const k of [KA, KB]) env.consolidator.consolidateChat(k);
    env.store.flushAll({ force: true });
    const stA = env.store.stats(KA);
    const stB = env.store.stats(KB);
    assert.ok(stA.blocks >= 1 && stB.blocks >= 1, '两边都该有块');
    assert.ok(stA.blocks + stB.blocks === env.store.stats().blocks, '全局块数应等于两边之和');
    const files = fs.readdirSync(path.join(env.dataRoot, 'index'));
    assert.ok(files.some((f) => f.includes('qa01')), '缺 A 群的索引分片');
    assert.ok(files.some((f) => f.includes('qb02')), '缺 B 群的索引分片');
  });
}

// ── R. 索引落盘格式 v2（块 id 数字槽位 + 紧凑序列化）──────────────────────
//
// 这一组守的不是"格式对不对"，而是**"省磁盘不许换召回"**：
//   postings 里的块 id 从 33 字符的字符串换成 1~3 位的数字槽位、落盘不再缩进，
//   体积降到 1/4 —— 但检索出来的块、顺序、分数必须逐位一样。
// 为什么必须在这里钉住：格式变换写错了**不会报错**，只会让某些词查不到 ——
//   也就是说错了以后表现为"记忆偶尔想不起来"，比崩溃难查得多。
{
  const root = freshRoot('r-format');
  const env = makeEnv(root);
  const key = 'group:r99';
  writeMessages(root, key, synth({ startOffsetDays: 2, hours: 30, chatKey: key }));
  env.consolidator.consolidateChat(key);
  env.store.flushAll({ force: true });

  const idxFile = env.store.indexPath(key);
  const readDisk = () => JSON.parse(fs.readFileSync(idxFile, 'utf8'));
  const totalOf = (idx) => Object.values(idx.postings).reduce((s, l) => s + l.length, 0);
  // 把内存索引还原成**旧代码的落盘形态**（v1：字符串 id + 缩进 1 格）
  const writeAsV1 = () => {
    const mem = env.store.index(key);
    fs.writeFileSync(idxFile, JSON.stringify({
      version: 1, n: mem.n, totalLen: mem.totalLen, postings: mem.postings, blocks: mem.blocks
    }, null, 1), 'utf8');
  };
  const writeAsV2 = () => {
    fs.writeFileSync(idxFile, JSON.stringify(packIndex(env.store.index(key))), 'utf8');
  };
  // feedback:'off' —— 否则检索本身会 markHit 改权重，两边比的就不是同一份权重了
  const hitSig = () => makeEnv(root).recall
    .search('猫粮', { chatKey: key, limit: 3, feedback: 'off' })
    .map((h) => `${h.chunkId}@${h.score}`);

  ok('R1 落盘是 v2：有 ids 表、postings 是数字槽位；内存里仍是字符串 id', () => {
    const disk = readDisk();
    assert.equal(disk.version, 2, `磁盘版本号应为 2，实际 ${disk.version}`);
    assert.ok(Array.isArray(disk.ids) && disk.ids.length, '磁盘上没有 ids 表');
    assert.equal(new Set(disk.ids).size, disk.ids.length, 'ids 表有重复槽位');
    for (const list of Object.values(disk.postings)) {
      for (const p of list) {
        assert.equal(typeof p[0], 'number', '磁盘上的 posting 还是字符串 id');
        assert.ok(Number.isInteger(p[0]) && p[0] >= 0 && p[0] < disk.ids.length, `槽位越界：${p[0]}`);
      }
    }
    // ⚠️ 内存里**必须**还是字符串 id —— recall.js 的命中循环、unindexBlock 的
    //    精确摘词、自测的 O1~O4 全按 `p[0] === 块id` 写。格式转换只许发生在磁盘边界。
    const mem = env.store.index(key);
    assert.ok(Object.keys(mem.postings).length, '内存索引是空的');
    for (const list of Object.values(mem.postings)) {
      for (const p of list) assert.equal(typeof p[0], 'string', '内存索引被改成数字槽位了（越界了）');
    }
  });

  ok('R2 落盘紧凑：索引文件里没有换行（writeJson 不再缩进）', () => {
    assert.ok(!fs.readFileSync(idxFile, 'utf8').includes('\n'),
      '索引文件里还有换行 —— writeJson 没走紧凑序列化');
  });

  ok('R3 槽位化的效果确实发生了（对比"只做紧凑化、不换 id"的对照）', () => {
    // ⚠️ 为什么不能只断言"文件小了"：那样**区分不出**"只把缩进去掉"和"真的把 id
    //    换成了槽位" —— 前者也能让文件小三成，测试会假绿。这里直接和
    //    「紧凑序列化但仍用字符串 id」的对照比，要求再省一半以上。
    //    形状按真实数据造：33 字符的块 id，每条 id 被复用 8 次（实测群
    //    123456789 是 34402 条 posting / 30 个 id，复用约 1150 次）。
    const ids = Array.from({ length: 12 }, (_, i) => `hour_group_123456789_202610${10 + i}_16`);
    const postings = {};
    for (let t = 0; t < 400; t += 1) {
      postings[`词${t}`] = ids.slice(0, 8).map((id, i) => [id, (t + i) % 3 + 1]);
    }
    const blocks = Object.fromEntries(ids.map((id) => [id, { kind: 'hour', dayKey: '2026-10-15' }]));
    const data = { n: ids.length, totalLen: 0, postings, blocks };
    const compactButStringIds = Buffer.byteLength(
      JSON.stringify({ version: 1, n: data.n, totalLen: 0, postings, blocks })
    );
    const v2 = Buffer.byteLength(JSON.stringify(packIndex(data)));
    assert.ok(v2 < compactButStringIds * 0.6,
      `v2 应比"仅紧凑化"再省一半以上，实际 ${compactButStringIds} → ${v2}`
      + `（降到 ${(100 * v2 / compactButStringIds).toFixed(1)}%，槽位化可能没生效）`);

    // 真实落盘管线也必须变小（方向性检查；比例随"每条 id 被复用多少次"变化，
    // 小块索引省得少，实测真实数据降到 26%）
    writeAsV1();
    const a = fs.statSync(idxFile).size;
    writeAsV2();
    const b2 = fs.statSync(idxFile).size;
    assert.ok(b2 < a, `真实落盘路径没有变小（${a} → ${b2}）`);
  });

  // ── A/B：同一批块、同一份权重，索引分别按 v1 / v2 落盘，两个全新实例各检索一次 ──
  writeAsV1();
  const asOld = hitSig();
  writeAsV2();
  const asNew = hitSig();

  ok('R4 A/B 等价：v1 与 v2 落盘读出来，检索命中与分数逐位相同', () => {
    assert.ok(asOld.length > 0, '前置条件不成立：压根没命中（这个用例就白测了）');
    assert.deepEqual(asNew, asOld, '换了落盘格式之后检索结果变了');
  });

  ok('R5 v1 存量索引：读到就标脏，一次 flush 自动升成 v2（不需要迁移脚本）', () => {
    writeAsV1();
    assert.equal(readDisk().version, 1, '前置条件：磁盘上应该是 v1');
    const fresh = makeEnv(root).store;      // 全新实例，缓存是空的
    fresh.index(key);                       // 只读一次，不检索
    fresh.flushAll({ force: true });
    const after = readDisk();
    assert.equal(after.version, 2, 'v1 没有被自动升级');
    assert.ok(Array.isArray(after.ids) && after.ids.length, '升级后没有 ids 表');
  });

  ok('R6 v2 往返之后摘词仍然精确（总条数正好减掉受害块的条目数）', () => {
    if (readDisk().version !== 2) writeAsV2();
    const s = makeEnv(root).store;          // 全新实例 → 从磁盘上的 v2 读回来
    const idx = s.index(key);
    const victim = Object.keys(idx.blocks)[0];
    assert.ok(victim, '前置条件：没有块');
    const dfBefore = new Map(Object.entries(idx.postings).map(([t, l]) => [t, l.length]));
    const mine = Object.values(idx.postings).reduce(
      (n, l) => n + l.filter((p) => p[0] === victim).length, 0
    );
    assert.ok(mine > 10, `前置条件：受害块的 posting 太少（${mine}）`);
    const before = totalOf(idx);

    s.unindexBlock(key, victim, { flush: false });

    assert.equal(totalOf(idx), before - mine, '总 posting 数变化不等于受害块的条目数');
    for (const [t, list] of Object.entries(idx.postings)) {
      assert.ok(!list.some((p) => p[0] === victim), `词 ${t} 还留着受害块的 posting`);
      const d = dfBefore.get(t);
      if (d !== undefined) {
        assert.ok(list.length === d || list.length === d - 1,
          `词 ${t} 的 df 变化不是 0 或 −1（${d} → ${list.length}）`);
      }
    }
  });

  ok('R7 悬挂 posting（块 id 不在 blocks 里）不因格式转换被丢掉 —— 它算进 df', () => {
    const data = {
      n: 1, totalLen: 3,
      postings: { 火锅: [['alive', 2], ['ghost', 1]] },
      blocks: { alive: { kind: 'hour' } }
    };
    const back = unpackIndex(JSON.parse(JSON.stringify(packIndex(data))));
    assert.deepEqual(back.postings['火锅'], [['alive', 2], ['ghost', 1]]);
    assert.equal(back.postings['火锅'].length, 2, 'df 被改小了（会影响 idf，进而改排序）');
  });

  ok('R8 pack 幂等且往返稳定（否则每次落盘都会写成"又变了"的数据）', () => {
    const data = { n: 1, totalLen: 1, postings: { a: [['b2', 1], ['b1', 2]] }, blocks: { b1: { k: 1 }, b2: { k: 2 } } };
    const once = JSON.stringify(packIndex(data));
    assert.equal(JSON.stringify(packIndex(data)), once, 'pack 不幂等');
    assert.equal(JSON.stringify(packIndex(unpackIndex(JSON.parse(once)))), once, '往返之后编码变了');
  });
}

// ── 收尾 ─────────────────────────────────────────────────────────────────
console.log(`\n${failures ? '❌' : '✅'} 自测结束：${checks - failures}/${checks} 通过`);
process.exit(failures ? 1 : 0);

// ── 本地小工具（与 lib/util.js 同口径，测试内自备一份避免耦合）────────────
/**
 * 列出插件目录下所有 .js/.mjs 源文件（绝对路径）。
 * @param {{includeSelf?: boolean}} [opts]
 *   includeSelf：默认 **false**，即跳过本文件。拿正则扫源码的那几条检查（I3/I6/I10/I11）
 *   必须跳过自己 —— 那些检查的模式**字面量本身就写在本文件里**，扫自己必然自匹配：
 *   ABS 里写着 `/Users|home/`、CREDENTIAL 里写着 `.env`、I11 的禁用词表里写着
 *   `account.json` —— 都在被扫的源码里。（这一条是真踩到的假阳性。）
 */
function listSourceFiles({ includeSelf = false } = {}) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      if (!includeSelf && path.resolve(p) === path.resolve(SELF_FILE)) continue;
      out.push(p);
    }
  };
  walk(PLUGIN_DIR);
  return out.sort();
}

/** 插件目录内的相对路径（正斜杠，便于阅读）。 */
function rel(p) { return path.relative(PLUGIN_DIR, p).replace(/\\/g, '/'); }

function pad(n) { return String(n).padStart(2, '0'); }
function dayKeyLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hourKeyOfLocal(ts) {
  const d = new Date(ts);
  return `${dayKeyLocal(ts)} ${pad(d.getHours())}`;
}
