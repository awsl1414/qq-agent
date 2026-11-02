// soak 基准：180 天量级的群聊，巩固 tick 到底要多久、磁盘长多大。
//
//   node tools/bench-soak.mjs [天数=180] [每天小时块数=2]
//
// 回答的问题是「一个跑了半年的群，插件还撑得住吗」：
//   ① 全量巩固（首日回填 / force 重建的量级）
//   ② 次日增量巩固（日常形态：只读新消息 + rollup + pruneVocab + forgetSweep）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LayeredStore } from '../lib/store.js';
import { Consolidator } from '../lib/consolidate.js';
import { GistStore } from '../lib/gist.js';
import { Recall } from '../lib/recall.js';
import { Injector } from '../lib/inject.js';
import { Stats } from '../lib/stats.js';
import { Cards } from '../lib/cards.js';

const DAYS = Number(process.argv[2] || 180);
const BLOCKS_PER_DAY = Number(process.argv[3] || 2);
const KEY = 'group:soak';
const DAY = 86400000;

function settings() {
  return {
    enabled: true, consolidateIntervalMin: 10, consolidateBatchMax: 20000,
    rollupAfterDays: 7, forgetAfterDays: 120, minForgetScore: 0.25,
    maxSnippetsPerBlock: 120, maxVocabPerChat: 20000, dfCutoffRatio: 0.7,
    decayHalfLifeDays: 45, decayShape: 0.7, stabilityGain: 1.0, stabilityMax: 3650,
    hitBoost: 1.15, autoRecall: true, autoRecallBudget: 220, autoRecallTopBlocks: 2,
    autoRecallCooldownMin: 30, minTriggerChars: 6, observeTools: true,
    pendingTodos: false, crossTurn: false, semanticCards: false, cardsCrossChat: false,
    maxCards: 500, cardIdleDays: 90, crossChatPeek: false, budgetGuard: true,
    dayPromptMax: 800000, chatPromptMax: 200000, warnOnConflict: true,
    conflictWarnCooldownMin: 1440, gistEnabled: true, gistMaxPerChat: 400,
    gistRetainDays: 1095, gistReviveMaxMb: 24, gistWeight: 0.35, peopleBoost: 1.3,
    diversityLambda: 0.3, autoRecallMinRel: 0.25, staleSnippetSkip: true, recallRowWidth: 0,
    linkBoost: 0.15, linkLearn: true, reminiscenceAmp: 0.12, todBoost: 1.1,
    sleepReplay: true, replayCooldownDays: 3
  };
}

const TOPICS = ['猫粮', '婚礼', '显卡', '论文', '火锅', '露营', '展会', '球赛'];

/** 造「过去 days 天、每天 blocksPerDay 个小时块」的消息。 */
function makeMessages(days, blocksPerDay, startAgeDays) {
  const msgs = [];
  let id = 1;
  for (let d = 0; d < days; d += 1) {
    const age = startAgeDays - d;
    if (age < 0) break;
    const dayBase = Math.floor((Date.now() - age * DAY) / DAY) * DAY;
    for (let b = 0; b < blocksPerDay; b += 1) {
      const topic = TOPICS[(d * blocksPerDay + b) % TOPICS.length];
      const ts0 = dayBase + b * 3600000 + 100000;
      for (let i = 0; i < 4; i += 1) {
        msgs.push({
          id, ts: ts0 + i * 60000, mid: `d${d}b${b}i${i}`, self: i === 3,
          senderId: i === 3 ? '9999' : String(1000 + (i % 3)),
          senderName: i === 3 ? '机器人' : ['阿甲', '阿乙', '阿丙'][i % 3],
          text: i === 2
            ? `说好了下周要一起搞${topic}的事情，别忘了我提过的${topic}安排`
            : `${topic}又来了，今天第 ${i} 条，随便聊聊${topic}`
        });
        id += 1;
      }
    }
  }
  return msgs;
}

function writeMessages(root, chatKey, msgs) {
  fs.writeFileSync(
    path.join(root, 'messages', `${chatKey.replace(/[^a-z0-9_]/gi, '_')}.json`),
    JSON.stringify({ version: 1, messages: msgs }, null, 1),
    'utf8'
  );
}

function makeEnv(root) {
  const s = settings();
  const get = () => s;
  const dataRoot = path.join(root, 'memory-v3');
  const store = new LayeredStore(dataRoot, get);
  const stats = new Stats(dataRoot);
  const cards = new Cards(dataRoot, get);
  const gist = new GistStore(dataRoot, get);
  const consolidator = new Consolidator({
    store, messagesDir: path.join(root, 'messages'), settings: get, gist,
    onBlock: (chatKey, block) => cards.ingest(chatKey, block?.snippets || [])
  });
  const recall = new Recall({
    store, settings: get, stats,
    gistSearch: (q, o) => gist.search(q, o),
    revive: (chatKey, g) => consolidator.reviveBlock(chatKey, g)
  });
  const injector = new Injector({ recall, settings: get, stats, store });
  return { store, consolidator, recall, injector, stats, dataRoot };
}

function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += fs.statSync(p).size;
    }
  };
  walk(dir);
  return n;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayered-soak-'));
fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
const env = makeEnv(root);

// ① 全量巩固：过去 DAYS 天的消息一次读完（首日回填 / force 重建的量级）
writeMessages(root, KEY, makeMessages(DAYS, BLOCKS_PER_DAY, DAYS));
let t = Date.now();
const first = env.consolidator.consolidateChat(KEY);
const fullMs = Date.now() - t;
const st1 = env.store.stats();

// ② 次日增量：只追加"今天"的消息，再巩固一次（日常形态）
const today = makeMessages(1, BLOCKS_PER_DAY, 0).map((m, i) => ({ ...m, id: 900000 + i, mid: `today${i}` }));
const file = path.join(root, 'messages', `${KEY.replace(/[^a-z0-9_]/gi, '_')}.json`);
const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.writeFileSync(file, JSON.stringify({ version: 1, messages: [...prev.messages, ...today] }, null, 1), 'utf8');
t = Date.now();
const second = env.consolidator.consolidateChat(KEY);
const incMs = Date.now() - t;
const st2 = env.store.stats();
const idxBytes = dirSize(path.join(env.dataRoot, 'index'));
const stateBytes = fs.existsSync(path.join(env.dataRoot, 'state.json'))
  ? fs.statSync(path.join(env.dataRoot, 'state.json')).size : 0;

console.log(`语料：${DAYS} 天 × 每天 ${BLOCKS_PER_DAY} 个小时块（每条 4 消息）`);
console.log(`全量巩固：${fullMs}ms｜产出块 ${first.blocks ?? '?'} 个｜词表 ${st1.vocab}`);
console.log(`次日增量巩固：${incMs}ms｜产出块 ${second.blocks ?? '?'} 个｜当前块数 ${st2.blocks}｜词表 ${st2.vocab}`);
console.log(`磁盘：索引 ${(idxBytes / 1024).toFixed(0)} KB｜state.json ${(stateBytes / 1024).toFixed(0)} KB`);
console.log(`（首日回填之后，日常 tick 只做增量 —— ${incMs}ms 才是用户每 10 分钟体感的那个数）`);
fs.rmSync(root, { recursive: true, force: true });
