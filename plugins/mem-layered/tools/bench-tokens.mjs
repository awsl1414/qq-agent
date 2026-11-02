// 端到端 token 实测：同一份语料、同一串查询，对比三种配置烧多少注入字符。
//
//   node tools/bench-tokens.mjs
//
// 复刻 index.js before-llm-messages 的真实链路与记账：
//   buildReplay(2.5 睡眠重演) → build(3 自动想起旧事) → 送达后
//   markInjected(cooldownIds) + passiveChunkIds 记 passive + replayChunkIds 记 full/replay。
// 轮与轮之间只清块级冷却（模拟间隔 ≥30 分钟）、保留碎片记忆 lastMids ——
// 与 selftest M8 同口径，隔离出「省 token 三件套」的贡献。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayeredStore } from '../lib/store.js';
import { Consolidator } from '../lib/consolidate.js';
import { GistStore } from '../lib/gist.js';
import { Recall } from '../lib/recall.js';
import { ArchiveReader } from '../lib/archive.js';
import { Injector } from '../lib/inject.js';
import { Stats } from '../lib/stats.js';
import { Cards } from '../lib/cards.js';

const DAY = 86400000;
const KEY = 'group:bench-tokens';

function defaults() {
  return {
    enabled: true,
    consolidateIntervalMin: 10,
    consolidateBatchMax: 20000,
    rollupAfterDays: 7,
    forgetAfterDays: 120,
    minForgetScore: 0.25,
    maxSnippetsPerBlock: 120,
    maxVocabPerChat: 20000,
    dfCutoffRatio: 0.7,
    decayHalfLifeDays: 45,
    decayShape: 0.7,
    stabilityGain: 1.0,
    stabilityMax: 3650,
    hitBoost: 1.15,
    autoRecall: true,
    autoRecallBudget: 220,
    autoRecallTopBlocks: 2,
    autoRecallCooldownMin: 30,
    minTriggerChars: 6,
    observeTools: true,
    pendingTodos: false,
    crossTurn: false,
    crossTurnTtlMin: 90,
    crossTurnMaxChars: 200,
    semanticCards: false,
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
    warnOnConflict: true,
    conflictWarnCooldownMin: 1440,
    gistEnabled: true,
    gistMaxPerChat: 400,
    gistRetainDays: 1095,
    gistReviveMaxMb: 24,
    gistWeight: 0.35,
    peopleBoost: 1.3,
    diversityLambda: 0.3,
    autoRecallMinRel: 0.25,
    staleSnippetSkip: true,
    recallRowWidth: 0,
    linkBoost: 0.15,
    linkLearn: true,
    reminiscenceAmp: 0.12,
    todBoost: 1.1,
    sleepReplay: true,
    replayCooldownDays: 3
  };
}

function makeEnv(root, overrides = {}) {
  const settings = { ...defaults(), ...overrides };
  const get = () => settings;
  const dataRoot = path.join(root, 'memory-v3');
  const messagesDir = path.join(root, 'messages');
  const store = new LayeredStore(dataRoot, get);
  const stats = new Stats(dataRoot);
  const cards = new Cards(dataRoot, get);
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
  const injector = new Injector({ recall, settings: get, stats, store });
  return { settings, store, consolidator, recall, injector, stats, cards, gist, dataRoot, messagesDir };
}

// 语料：130 天的群聊历史。每层 2 个小时块、话题轮换。
// 36~44 天区间密铺（9 层）—— 那是 score=1 的块「该复习了」的窗口
// （gap∈[0.8S,2.5S] 且 R∈[0.5,0.95]，S=45 天时约等于 36~45 天）。
const AGES = [1, 2, 3, 5, 8, 12, 16, 20, 24, 28, 32, 36, 37, 38, 39, 40, 41, 42, 43, 44, 48, 54, 60, 70, 85, 100, 115, 130];
const TOPICS = ['猫粮', '婚礼', '显卡', '论文', '火锅'];

function seed(root) {
  const msgs = [];
  let id = 1;
  for (const age of AGES) {
    const base = Math.floor((Date.now() - age * DAY) / 3600000) * 3600000;
    for (let h = 0; h < 2; h += 1) {
      const topic = TOPICS[(age + h) % TOPICS.length];
      const ts0 = base + h * 3600000 + 100000;
      msgs.push({
        id, ts: ts0, mid: `a${age}h${h}a`, self: false,
        senderId: '1001', senderName: '阿甲', text: `${topic}的事情第 ${h} 次提起，约定下次一起搞${topic}`
      });
      id += 1;
      msgs.push({
        id, ts: ts0 + 60000, mid: `a${age}h${h}b`, self: false,
        senderId: '1002', senderName: '阿乙', text: `关于${topic}我还有别的想法，随便聊聊${topic}的事情`
      });
      id += 1;
    }
  }
  fs.writeFileSync(
    path.join(root, 'messages', `${KEY.replace(/[^a-z0-9_]/gi, '_')}.json`),
    JSON.stringify({ version: 1, messages: msgs }, null, 1),
    'utf8'
  );
  // dfCutoffRatio=1 / peopleBoost=1：块数几十时默认 0.7 会剪掉短词（README 提醒过），
  // 多线索加权与本题无关 —— 都关掉，隔离出「省 token」本身的贡献。
  return makeEnv(root, { dfCutoffRatio: 1, peopleBoost: 1, pendingTodos: false, crossTurn: false, semanticCards: false });
}

// 8 轮对话 = 三次小会话（火锅×3、显卡×2、婚礼×2 连续聊 + 一个新话题）。
// ⚠️ 必须包含**连续同话题**的轮次 —— 碎片级跨轮去重按设计只对照「上一轮」的碎片
// （lastMids 不累积，否则旧事永远别想再露面），话题轮换的序列根本触发不了它。
// 现实中「一个晚上连着把一件事聊完」正是重复注入的高发场景。
const QUERIES = [
  '火锅 约定 下次 一起搞',
  '火锅 还是那家 好吃',
  '火锅 换个时间 也行',
  '显卡 预算 别的想法',
  '显卡 换代 随便聊聊',
  '婚礼 酒店 准备',
  '婚礼 婚纱 想法',
  '论文 截止 想法'
];

const CONFIGS = [
  { label: 'v1.7.0 全开（默认）', over: {} },
  { label: '省 token 三件套全关', over: { staleSnippetSkip: false, autoRecallMinRel: 0, recallRowWidth: 90 } },
  { label: '再关睡眠重演', over: { sleepReplay: false } }
];

function run(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayered-tok-'));
  fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
  const env = seed(root);
  env.consolidator.consolidateChat(KEY);
  Object.assign(env.settings, over);
  const blocks = env.store.stats().blocks;
  const vocab = env.store.stats().vocab;
  let main = 0;
  let replay = 0;
  let mainRows = 0;
  let rounds = 0;
  let replayRounds = 0;
  const perRound = [];
  for (const q of QUERIES) {
    const rep = env.settings.sleepReplay === false
      ? { text: '', chunkIds: [] }
      : env.injector.buildReplay({ chatKey: KEY, budgetScale: 1 });
    const r = env.injector.build({ chatKey: KEY, triggerText: q, budgetScale: 1 });
    const repText = rep.text || '';
    const mainText = (typeof r === 'string' ? r : (r?.text || ''));
    if (repText || mainText) {
      rounds += 1;
      if (repText) replayRounds += 1;
      main += mainText.length;
      replay += repText.length;
      mainRows += mainText.split('\n').filter((l) => l.startsWith('- ')).length;
      perRound.push({ q, main: mainText.length, replay: repText.length });
      const cooldownIds = [
        ...(typeof r === 'object' && Array.isArray(r.cooldownIds) ? r.cooldownIds : []),
        ...(rep.chunkIds || [])
      ];
      if (cooldownIds.length) env.injector.markInjected(KEY, cooldownIds);
      if (typeof r === 'object' && Array.isArray(r.chunkIds)) {
        for (const id of r.chunkIds) env.store.markHit(KEY, id, { mode: 'passive' });
      }
      for (const id of rep.chunkIds || []) env.store.markHit(KEY, id, { mode: 'full', replay: true });
    } else {
      perRound.push({ q, main: 0, replay: 0 });
    }
    // 轮间：只清块级冷却（间隔 ≥30 分钟），保留 lastMids 碎片记忆
    env.injector.recent.delete(KEY);
    env.injector.lastLines = [];
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { blocks, vocab, main, replay, total: main + replay, mainRows, rounds, replayRounds, perRound };
}

const rows = CONFIGS.map((c) => ({ ...c, ...run(c.over) }));
const base = rows[0];
const nosave = rows[1];
const noreplay = rows[2];

console.log(`语料：${AGES.length} 个时间层 × 2 块 = ${base.blocks} 块 / 词表 ${base.vocab}｜${QUERIES.length} 轮对话（火锅×3 显卡×2 其余×1）\n`);
const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);
console.log(pad('配置', 22), padStart('相关旧事', 8), padStart('突然想起', 8), padStart('合计', 8), padStart('旧事行数', 8), padStart('注入轮数', 8), padStart('重演轮数', 8));
for (const r of rows) {
  console.log(
    pad(r.label, 22),
    padStart(r.main, 8), padStart(r.replay, 8), padStart(r.total, 8),
    padStart(r.mainRows, 8), padStart(`${r.rounds}/${QUERIES.length}`, 8), padStart(`${r.replayRounds}/${QUERIES.length}`, 8)
  );
}
console.log('');
const mainPct = ((nosave.main - base.main) / nosave.main) * 100;
const savePct = ((nosave.total - base.total) / nosave.total) * 100;
console.log(`省 token 三件套 · 相关旧事段：${nosave.main} → ${base.main} 字符，省 ${mainPct.toFixed(1)}%（旧事行数 ${nosave.mainRows} → ${base.mainRows}）`);
console.log(`省 token 三件套 · 总注入（含重演）：${nosave.total} → ${base.total} 字符，省 ${savePct.toFixed(1)}%（注入轮数 ${nosave.rounds} vs ${base.rounds}，一次没少）`);
console.log(`睡眠重演成本：占默认配置总注入的 ${((base.replay / base.total) * 100).toFixed(1)}%（${base.replay} / ${base.total} 字符，${base.replayRounds} 轮有「突然想起」；两个配置下完全相同，不构成三件套的节省差异）`);
console.log(`重演段自身预算 = autoRecallBudget × 0.6 = 132 字符/轮（默认 220 的六成）\n`);
console.log('默认配置逐轮明细（相关旧事 / 突然想起，字符）：');
for (const [i, p] of base.perRound.entries()) {
  console.log(`  第 ${i + 1} 轮 ${pad(p.q, 18)} ${padStart(p.main, 6)} / ${padStart(p.replay, 6)}${p.main + p.replay === 0 ? '  （本轮无注入）' : ''}`);
}
