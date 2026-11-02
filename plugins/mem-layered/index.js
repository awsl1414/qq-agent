// 分层记忆（确定性型 / plugins/mem-layered/）
//
// ── 一句话 ────────────────────────────────────────────────────────────────
// 一个"按会话分片、会遗忘、每轮自动想起一点旧事"的长时记忆，全部通过钩子与能力
// 挂进宿主，**不改宿主一行代码**。
//
// ── 与内置 plugins/conversation-memory 的关系 ─────────────────────────────
// 两者**提供同名能力**（memory.search / memory.archive / memory.status /
// memory.rebuild），因此：
//   · 宿主自带的 skills/memory-recall（注册 memory_search / memory_archive /
//     memory_status 三个工具）不需要任何改动就能用本引擎；
//   · routes.js 的「数据移植」在导入后会调 memory.rebuild 重建索引，也直接复用。
//   · 宿主自己的 /api/memory-files（群友印象那套）**不在本插件的职责范围内** ——
//     那是核心 MemoryStore 的接口，插件拿不到路由注册权，硬做只会两套数据打架。
//
// ⚠️ 两个提供者同时启用时，"能力取第一个提供者"的结果取决于加载顺序，
//    所以**建议在插件页把内置的会话记忆关掉**，只留一个引擎。
//    —— 这件事不能只写在注释里等人来看：lib/conflict.js 会在启用时自检，
//       检测到内置版还开着就主动提醒（日志 + 状态 + 私聊里的一句话）。
//
// ── 相对内置版的六处实质改动（都针对实测到的问题）────────────────────────
//   1. 按会话分片索引（内置版单文件全量重写：实测 index.json 721KB，而它索引的
//      15 个块加起来才 176KB —— 索引是内容的 4.1 倍）
//   2. 检索加 idf（内置版无 idf；实测 5422 个词项里 df=1 占 78%，这些最有区分度的
//      "独苗词"与覆盖全部块的高频词同权）
//   3. 真遗忘：命中加分 × 指数衰减 × 老块淘汰（内置版 forget() 的 soft 分支零调用，
//      块权重恒为 1）
//   4. 每轮自动检索注入（内置版只注入待办/跨轮/语义卡/跨群，从不注入相关旧事 ——
//      "记了但想不起来"）
//   5. 补上内置版有、但本插件原先缺的五项：待办提醒（含工具入口）、跨轮工作记忆、
//      语义卡（写入即去噪 + 会话隔离）、跨群旁听（默认关）、成本护栏（日级+会话级）
//   6. 效果度量：stats.json 记检索命中率、注入字节、模型主动调用次数
//   7. 引擎冲突自检：内置版还开着就主动提醒（日志 + 状态 + 私聊一句话），
//      免得"两套记忆同时注入、模型却查的是旧数据"这种哑巴亏（见 lib/conflict.js）
import path from 'node:path';
import { DATA_DIR } from './lib/env.js';
import { timeOfDayOf } from './lib/util.js';
import { LayeredStore } from './lib/store.js';
import { Consolidator } from './lib/consolidate.js';
import { GistStore } from './lib/gist.js';
import { Recall } from './lib/recall.js';
import { ArchiveReader } from './lib/archive.js';
import { Injector } from './lib/inject.js';
import { Stats, dirSize } from './lib/stats.js';
import { CrossTurn } from './lib/crossturn.js';
import { Pending } from './lib/pending.js';
import { Cards } from './lib/cards.js';
import { Peek } from './lib/peek.js';
import { Budget } from './lib/budget.js';
import { ConflictGuard, ENGINE_TAG, PROBE_KEY } from './lib/conflict.js';

/** 出厂默认（与 plugin.json 的 settings 一致，改一处要改两处）。 */
const DEFAULTS = {
  enabled: true,
  consolidateIntervalMin: 10,
  consolidateBatchMax: 20000,
  rollupAfterDays: 7,
  forgetAfterDays: 120,
  maxSnippetsPerBlock: 120,
  maxVocabPerChat: 100000,
  dfCutoffRatio: 0.7,
  hitBoost: 1.15,
  decayHalfLifeDays: 45,
  decayShape: 0.7,
  stabilityGain: 1.0,
  stabilityMax: 3650,
  autoRecall: true,
  autoRecallBudget: 220,
  autoRecallTopBlocks: 2,
  autoRecallCooldownMin: 30,
  // 自动回忆的行宽（字符）。0 = 按预算自动摊到各行（默认行为）；
  // > 0 = 固定行宽，不再随预算伸缩。见 lib/inject.js 的"预算行宽联动"。
  //
  // ⚠️ 2026-10-16 评估过"改成定长 60"，**结论是不改**，已回滚。
  //实测数据：旧实现段长随命中条数在 148/220/220/220 间跳（幅度 72）；
  // 定长版在 101/183 间跳（幅度 82）—— **抖动反而更大**，
  // 且把覆盖条数从 3~4 条砍到 2 条，还破坏了 M1/M5/M8 三项既有断言。
  // 原实现的"行宽随 cap 摊"其实是段内自适应的最优解。
  recallRowWidth: 0,
  // —— 全局注入封顶（2026-10-16 新增）——
  // 七个注入段（待办/跨轮/重演/旧事/语义卡/旁听/冲突提醒）各管各的预算，
  // 彼此零仲裁 ⇒ 每轮注入体积在 0~700+ 字符间随机漂移。这是硬上限，
  // 0 = 不限（旧行为）。建议 400：对齐 autoRecallBudget(220)+重演(140) 的
  // 常见组合，又能容纳一条待办。详见 clipParts() 的注释。
  injectTotalMax: 400,
  minTriggerChars: 6,
  observeTools: true,
  // —— 附加五项（对齐内置版）——
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
  minForgetScore: 0.25,
  // —— 冲突自检（见 lib/conflict.js）——
  warnOnConflict: true,
  conflictWarnCooldownMin: 1440,
  // —— 梗概墓碑 + 多线索检索 + 结果多样性（见 lib/gist.js / lib/recall.js）——
  gistEnabled: true,
  gistMaxPerChat: 400,
  gistRetainDays: 1095,
  gistReviveMaxMb: 24,
  gistWeight: 0.35,
  peopleBoost: 1.3,
  diversityLambda: 0.3,
  autoRecallMinRel: 0.25,
  staleSnippetSkip: true,
  // —— 人类记忆机制包 v1.7.0（共激活联想 · 自发恢复 · 时段情境 · 睡眠重演）——
  // 共激活联想：同轮一起被想起的块结缘，之后检索时激活向邻居扩散（Hebb）
  linkBoost: 0.15,
  linkLearn: true,
  // 自发恢复：深忘区（>3S）后"突然又有点想起来"的复苏项幅度，0 = 关闭
  reminiscenceAmp: 0.12,
  // 时段情境：块的发生时段与当下时段一致时加权（编码特异性），1 = 关闭
  todBoost: 1.1,
  // 睡眠重演：巩固时挑"该复习了"的块，下次激活自然带出一句
  sleepReplay: true,
  replayCooldownDays: 3
};

let api = null;
let store = null;
let consolidator = null;
let recall = null;
let archive = null;
let injector = null;
let stats = null;
let crossTurn = null;
let pending = null;
let cards = null;
let peek = null;
let budget = null;
let conflictGuard = null;
let gist = null;
let timer = null;
let bootTimer = null;
let consolidating = false;

/** 本轮触发内容暂存：before-context 写、before-llm-messages 读完即删。 */
const pendingTrigger = new Map();
/** 本轮注入过哪几条旧事：before-llm-messages 写、after-response 读完即删。 */
const lastInject = new Map();

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * 懒建冲突看门狗。
 * ⚠️ 检测必须发生在 **activate 之后**（这里只在需要时建对象，真正判定在 activate 里跑）：
 *    setup() 阶段本插件自己还没注册进能力表，这时探针必然只看到内置版 —— 会把
 *    "我还没上桌"误判成"我抢不过它"。见 lib/conflict.js 的 #probeSelfFirst。
 */
function guard() {
  if (!conflictGuard && api) conflictGuard = new ConflictGuard(api, settings);
  return conflictGuard;
}

/** 懒建实例：只有真的要用时才碰磁盘。 */
function instance() {
  if (store) return { store, consolidator, recall, archive, injector, stats, crossTurn, pending, cards, peek, budget, gist };
  const root = path.join(DATA_DIR, 'memory-v3');
  const messagesDir = path.join(DATA_DIR, 'messages');
  stats = new Stats(root);
  store = new LayeredStore(root, settings);
  // 梗概墓碑：淘汰块时留一条"去哪儿找"的线索，检索命中时按 id 区间重建。
  gist = new GistStore(root, settings);
  // 附加模块先建：consolidator 写完块要顺手喂语义卡
  crossTurn = new CrossTurn(root, settings);
  pending = new Pending(root, settings);
  cards = new Cards(root, settings);
  peek = new Peek({ messagesDir, settings });
  budget = new Budget(root, settings);
  consolidator = new Consolidator({
    store,
    messagesDir,
    settings,
    gist,
    // 每写成一个小时块就把碎片喂给语义卡（抽卡在 lib/cards.js 里做写入即去噪）
    onBlock: (chatKey, block) => cards.ingest(chatKey, block?.snippets || [])
  });
  // 检索侧的两条注入：gistSearch 让墓碑参与排序；revive 让墓碑命中后能重建整块。
  // ⚠️ 都做成函数注入而不是让 Recall 直接 import GistStore/Consolidator ——
  //    Recall 与它们共享 store，直接互相 import 会成环。
  recall = new Recall({
    store,
    settings,
    stats,
    gistSearch: (q, o) => gist.search(q, o),
    revive: (chatKey, g) => consolidator.reviveBlock(chatKey, g)
  });
  archive = new ArchiveReader({ messagesDir });
  // store 一并给 Injector：睡眠重演要它挑"该复习了"的块（v1.7.0）
  injector = new Injector({ recall, settings, stats, store });
  return { store, consolidator, recall, archive, injector, stats, crossTurn, pending, cards, peek, budget, gist };
}

/**
 * 跑一次增量巩固。
 * 重入保护 + 失败只打日志：记忆是增强功能，坏了也绝不能让主流程陪葬。
 */
function consolidate(why) {
  if (consolidating) return null;
  if (settings().enabled === false) return null;
  consolidating = true;
  try {
    const it = instance();
    const results = it.consolidator.consolidateAll({ log: (m) => api.warn(m) }) || [];
    const added = results.reduce((n, r) => n + (Number(r?.added) || 0), 0);
    const rolled = results.reduce((n, r) => n + (Number(r?.rolledUp) || 0), 0);
    const gone = results.reduce((n, r) => n + (Number(r?.forgotten) || 0), 0);
    const pruned = results.reduce((n, r) => n + (Number(r?.prunedTokens) || 0), 0);

    // 顺手做维护：三件事都是"本地小文件扫描"，放在巩固末尾最省事，
    // 不额外占钩子的 5 秒预算。
    const droppedCards = it.cards.sweep();
    const droppedTurn = it.crossTurn.sweep();
    const droppedTodos = it.pending.sweep();

    it.stats.bump({
      consolidateRuns: 1,
      blocksAdded: added,
      rollups: rolled,
      forgotten: gone,
      prunedTokens: pruned,
      cardsDropped: droppedCards,
      crossTurnDropped: droppedTurn,
      todosDropped: droppedTodos
    });
    if (added || rolled || gone) {
      api.log(`巩固（${why}）：+${added} 条 / 汇总 ${rolled} 天 / 淘汰 ${gone} 块 / 剪枝 ${pruned} 词`);
    }
    return results;
  } catch (error) {
    api.warn('巩固失败：', error?.message ?? error);
    return null;
  } finally {
    consolidating = false;
  }
}

/**
 * 把片段并进**最后一条 user 消息的末尾**（原地改，钩子约定允许）。
 *
 * ⚠️ 为什么不能并进 system：system 是整条请求前缀的第一段，它尾巴一变，
 *   后面的 tools 与整条 user 全部作废（内置版踩过：真实调用第 1 次只命中
 *   2560 tok，第 2 次才 98%）。而 user 消息的**尾部**本来就是易变段，
 *   放这里不额外增加任何缓存损失。
 *
 * ⚠️ 也**不**退到 system：真找不到 user 消息时宁可这一轮不注入。
 *   注入是"锦上添花"，缓存全废是"真金白银"，两者不该等价交换。
 */
export function appendToLastUser(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  let target = null;
  for (const m of messages) if (m && m.role === 'user') target = m;
  if (!target) return false;
  if (typeof target.content === 'string') { target.content += text; return true; }
  if (Array.isArray(target.content)) { target.content.push({ type: 'text', text }); return true; }
  return false;
}

/**
 * 组装本轮要注入的全部片段，返回**一整段**文本。
 *
 * 顺序是有讲究的：越靠前越"当轮就要用得上"。
 *   待办（现在就该办）→ 跨轮（别复读）→ 旧事（上下文）→ 语义卡（常识）→ 旁听（环境）
 * 成本护栏的档位会决定后几段要不要留（见 lib/budget.js 的 LEVELS）。
 */
function buildInject({ chatKey, triggerText, personIds }) {
  const s = settings();
  const it = instance();
  const level = it.budget.shouldReduce(chatKey);
  const f = level.flags;
  const parts = [];
  const recalled = [];
  /** 本轮真正注入进提示词的块 id（由 3) 填充，供调用方在送达后记"被动命中"）。 */
  const passiveChunkIds = [];
  /** 本轮该进冷却的块 id（= 展示过的 + 内容被展示覆盖的）。 */
  const cooldownChunkIds = [];
  let announce = false;

  // 0) 引擎冲突提醒：唯一一条"不是记忆内容"的注入。
  //    只在检测到内置版还开着、且是私聊、且过了冷却时才出现（见 lib/conflict.js）。
  //    放最前面是因为它需要被看见；不进护栏裁剪是因为它只有一行、且是配置问题，
  //    跟"这轮省不省 token"不是一回事。
  try {
    const g = guard();
    if (g && g.canAnnounce(chatKey)) {
      const t = g.announce();
      if (t) { parts.push(t); announce = true; }
    }
  } catch { /* 自检失败只是少一句提醒，绝不影响记忆注入 */ }

  // 1) 待办：最短、最要紧，护栏再狠也保留一条
  if (s.pendingTodos !== false) {
    try {
      const t = it.pending.render({ chatKey, personIds, max: level.level >= 2 ? 1 : 3 });
      if (t) parts.push(t);
    } catch { /* 单段失败不影响其它段 */ }
  }

  // 2) 跨轮：防复读
  if (f.crossTurn && s.crossTurn !== false) {
    try {
      const t = it.crossTurn.render(chatKey);
      if (t) parts.push(t);
    } catch { /* ignore */ }
  }

  // 2.5) 睡眠重演（v1.7.0）：不看你问什么，只看"哪块旧事该复习了"。
  //      放在相关旧事前面：它是"突然想起"，该比"你查过的东西"更显眼一点。
  let replayChunkIds = [];
  if (f.autoRecall && s.sleepReplay !== false) {
    try {
      const r = it.injector.buildReplay({ chatKey, budgetScale: f.recallBudgetScale });
      if (r && r.text) {
        parts.push(r.text);
        if (Array.isArray(r.chunkIds)) {
          replayChunkIds = r.chunkIds;
          cooldownChunkIds.push(...r.chunkIds);
        }
      }
    } catch { /* 重演失败只是少一句"突然想起"，绝不影响其它段 */ }
  }

  // 3) 自动想起旧事（本插件的核心价值）
  if (f.autoRecall && s.autoRecall !== false && triggerText) {
    try {
      const r = it.injector.build({ chatKey, triggerText, budgetScale: f.recallBudgetScale, personIds });
      // 兼容字符串返回（老版本 / 测试桩），正常走对象分支
      const t = typeof r === 'string' ? r : (r?.text || '');
      if (t) {
        parts.push(t);
        recalled.push(...(it.injector.lastLines || []));
        if (r && Array.isArray(r.chunkIds)) passiveChunkIds.push(...r.chunkIds);
        if (r && Array.isArray(r.cooldownIds)) cooldownChunkIds.push(...r.cooldownIds);
      }
    } catch { /* ignore */ }
  }

  // 4) 语义卡（默认按会话隔离，见 lib/cards.js）
  if (f.cards && s.semanticCards !== false && triggerText) {
    try {
      const t = it.cards.render(triggerText, {
        chatKey,
        scope: s.cardsCrossChat === true ? 'global' : 'chat',
        limit: 2
      });
      if (t) parts.push(t);
    } catch { /* ignore */ }
  }

  // 5) 跨群旁听（默认关；开了才读别的会话）
  if (f.peek && s.crossChatPeek === true) {
    try {
      const t = it.peek.build(chatKey);
      if (t) parts.push(t);
    } catch { /* ignore */ }
  }

  return {
    text: parts.length ? `\n\n${clipParts(parts, s)}` : '',
    recalled,
    passiveChunkIds,
    cooldownChunkIds,
    replayChunkIds,
    level: level.level,
    // 提醒的"记账"由调用方在注入成功后再做（见 before-llm-messages）：
    // 这里只是"打算提醒"，还没真的送到。
    announce
  };
}

/**
 * 全局注入封顶（2026-10-16缓存/漂移修复 · 对应改造①）。
 *
 * ── 为什么要它 ────────────────────────────────────────────────────────────
 * buildInject 会拼最多 7 段（待办 / 跨轮 / 睡眠重演 / 相关旧事 / 语义卡 /
 * 跨群旁听 / 引擎冲突提醒），**每段各管自己的预算，彼此之间零仲裁**。
 * 结果是每轮注入体积在 0 ~ 700+ 字符之间随机跳：
 *   - 有没有待办、到没到期、有没有到点的睡眠重演 → 变
 *   - 检索命中几条（cap = min(4, lines.length)）→ 变
 *   - recallRowWidth=0 时行宽按 (budget-fixed)/cap 现算 → 跟着变
 * 这是提示词体积"漂移"的直接来源。
 *
 * 现有的 budgetGuard 护栏（lib/budget.js）**管不到这件事**：它看的是
 * 日/会话累计 prompt 量（dayPromptMax=800,000 / chatPromptMax=200,000），
 * 是**事后**按天降档。而实测单日已跑 6,434,834 字符 —— 是 dayMax 的 8 倍，
 * 这条线从来没生效过，护栏形同虚设。降档粒度也远不够：一档只关掉
 * 语义卡/旁听/跨轮，核心的「相关旧事」不受影响。
 *
 * ── 裁剪规则 ──────────────────────────────────────────────────────────────
 * 优先级（parts 的push 顺序 = 重要性顺序，越靠前越该保留）：
 *   冲突提醒 > 待办 > 跨轮 > 睡眠重演 > 相关旧事 > 语义卡 > 跨群旁听
 * 从**最低优先级**开始整段丢弃，直到总字符数 ≤ injectTotalMax。
 * **整段丢，不做半截截断** —— 半截的记忆行会让模型读到一句没有上下文的
 * 残缺内容，比不给更糟（相关旧事那段本来就有"截断也好过丢光"的取舍，
 * 但那是段内单条的兜底，不是段间的仲裁，两者别混）。
 *
 * ⚠️ 引擎冲突提醒**豁免**：它只有一行，说的是"你还有另一套记忆引擎开着，
 *    建议关掉"这种配置问题，不是记忆内容。裁掉它等于让一个配置错误永远
 *    无人发现。它不进 parts 的裁剪链，单独拼在最前。
 */
function clipParts(parts, s) {
  // 0 = 不限（保留旧行为）。默认 400：对齐 autoRecallBudget(220) + 重演(140)
  // 的常见组合，又足够容纳一次待办。
  const max = Math.max(0, Number(s?.injectTotalMax) || 0);
  const joined = parts.join('\n\n');
  if (max <= 0 || joined.length <= max) return joined;

  // 冲突提醒是 parts[0]（guard().canAnnounce 分支 push 的），豁免裁剪
  const head = parts[0] && isConflictHead(parts[0]) ? parts[0] : '';
  const rest = head ? parts.slice(1) : parts;
  const room = max - (head ? head.length + 2 : 0);
  if (room <= 0) return head.slice(0, max);

  const kept = [];
  let used = 0;
  for (const p of rest) {
    const add = (used ? 2 : 0) + p.length;   // 段间 \n\n 占2
    if (used + add > room) break;              // 顺序即优先级，撞上就停
    kept.push(p);
    used += add;
  }
  const body = kept.join('\n\n');
  return head ? `${head}\n\n${body}` : body;
}

/**
 * 判断某段是不是引擎冲突提醒。
 * ⚠️ 段头必须与 lib/conflict.js 的 announce() 严格一致：是 `〔记忆引擎提醒〕`
 *    （方头括号，不是【方头块】），错一个字符就匹配不上 —— 而匹配不上的
 *    后果是**悄悄被裁掉**，且没有任何日志。所以改conflict.js 段头时必须同步这里。
 */
function isConflictHead(text) {
  return typeof text === 'string' && text.startsWith('〔记忆引擎提醒〕');
}

/** 注册「记待办」工具 —— 没有入口的记忆功能等于没做（见 lib/pending.js 头注释）。 */
function registerTodoTool(a) {
  if (!a || typeof a.registerTool !== 'function') return;
  a.registerTool({
    id: 'memory_todo',
    name: '记待办 / 办完待办',
    description:
      '把"过一会儿要做/要问的事"记下来，到期自动消失。只在对方明确让你记着、或你自己说"回头再问"时用；'
      + '日常闲聊不要调用。默认 120 分钟后忘掉，可以用 expireInMinutes 改（最长 7 天）。'
      + '办完了用 action=done 销掉，不确定还剩什么用 action=list。',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'done', 'list'], description: 'add=记一条；done=办完销掉；list=看还剩哪些。' },
        text: { type: 'string', description: 'action=add 时是要记的事（一句话）；action=done 时可以只写几个关键词。' },
        expireInMinutes: { type: 'number', description: '多久后自动忘掉，默认 120，最长 10080（7 天）。' },
        userId: { type: 'string', description: '可选：这条待办只跟某个人有关（填对方 QQ 号），他不在场就不会被提起。' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      const action = String(args?.action || 'list');
      const chatKey = String(ctx?.chatKey || '');
      const it = instance();
      if (action === 'list') {
        const list = it.pending.list({ chatKey, limit: 10 });
        if (!list.length) return { content: '当前没有未完成的待办。' };
        return { content: JSON.stringify({ ok: true, todos: list }, null, 1) };
      }
      if (action === 'done') {
        const r = it.pending.done({ chatKey, text: args?.text });
        if (!r.ok) return { content: `销不掉：${r.error}`, isError: true };
        return { content: `已销掉待办「${r.removed?.text || ''}」。` };
      }
      const r = it.pending.add({
        chatKey,
        text: args?.text,
        expireInMinutes: args?.expireInMinutes,
        userId: args?.userId
      });
      if (!r.ok) return { content: `记不下来：${r.error}`, isError: true };
      const left = Math.max(0, Math.round(((Number(r.todo.expiresAt) || 0) - Date.now()) / 60000));
      return {
        content: `${r.deduped ? '这条已经记过了，帮你把时间刷新成' : '记下了'}「${r.todo.text}」，约 ${left} 分钟后自动忘掉。`
      };
    }
  });
}

export function setup(a) {
  api = a;
  try { registerTodoTool(a); } catch (error) {
    api.warn('待办工具注册失败：', error?.message ?? error);
  }
  try { conflictGuard = new ConflictGuard(a, settings); } catch { conflictGuard = null; }
}

/** 生效：起后台巩固 + 做一次引擎冲突自检。首跑延迟 10 秒，别和启动抢 IO。 */
export function activate() {
  if (settings().enabled === false) return;
  instance();
  const everyMin = Math.max(1, Number(settings().consolidateIntervalMin) || 10);
  timer = setInterval(() => consolidate('tick'), everyMin * 60000);
  timer.unref?.();
  bootTimer = setTimeout(() => { bootTimer = null; consolidate('boot'); }, 10000);
  bootTimer.unref?.();
  api.log(`分层记忆已启用：巩固间隔 ${everyMin} 分钟，数据根 ${store.root}`);

  // 引擎冲突自检：宿主没给插件"读别的 Skill 配置"的口子，只能靠
  // isSkillActive + 能力探针判断（原理见 lib/conflict.js）。
  // force=true：每次 activate（启动 / 热重载 / 用户手动开）都重新问一遍，
  // 用户中途把内置版关掉后，这里的结论会立刻跟上。
  try {
    const g = guard();
    const st = g.check({ force: true });
    if (st.level !== 'none') api.warn(g.notice());
  } catch (error) {
    api.warn('冲突自检失败（不影响记忆功能）：', error?.message ?? error);
  }
}

/** 关闭：停定时器 + 把内存里的索引与统计落盘。索引文件留在磁盘，重开即复用。 */
export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  try { store?.flushAll({ force: true }); } catch { /* ignore */ }
  try { stats?.flush({ force: true }); } catch { /* ignore */ }
  // 墓碑是"最后一点痕迹"，关插件时务必带上盘（remember 平时只标 dirty）
  try { gist?.save({ force: true }); } catch { /* ignore */ }
  // 成本护栏平时 20 秒才落一次盘（C7），关插件时把最后不到 20 秒的计数补上
  try { budget?.flush(); } catch { /* ignore */ }
}

/**
 * 能力：宿主自带的 skills/memory-recall 与数据移植模块都按这些名字取用。
 * 一律返回 { ok, ... }，不抛错 —— 调用方是模型工具，抛错只会变成一句难懂的话。
 */
export const providers = {
  'memory.search': (args = {}) => {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, hits: [], error: '缺少检索关键词' };
    try {
      const { recall: r } = instance();
      const hits = r.search(query, {
        chatKey: args?.chatKey || null,
        limit: Math.min(12, Math.max(1, Number(args?.limit) || 5)),
        maxSnippets: 5,
        // 编码特异性·时段（v1.7.0）：模型主动检索也发生在"当下"，提取情境同样生效
        tod: timeOfDayOf(Date.now())
      });
      return { ok: true, hits, mode: 'bm25+decay' };
    } catch (error) {
      return { ok: false, hits: [], error: String(error?.message ?? error) };
    }
  },

  'memory.archive': (args = {}) => {
    try {
      const { archive: a } = instance();
      const chatKey = args?.chatKey || null;
      const mode = String(args?.mode || 'list');
      if (mode === 'list') return { ok: true, chatKey, days: a.listDays(chatKey, { limit: 30 }) };
      if (mode === 'count') {
        return {
          ok: true,
          ...a.count({
            chatKey, query: args?.query,
            day: args?.day || null, dayFrom: args?.dayFrom || null, dayTo: args?.dayTo || null,
            maxSamples: 8
          })
        };
      }
      if (mode === 'context') {
        return {
          ok: true,
          ...a.contextAround({
            chatKey, day: args?.day || null, hour: args?.hour || null,
            anchor: args?.anchor || '', before: args?.before, after: args?.after
          })
        };
      }
      return {
        ok: true,
        ...a.load({
          chatKey, day: args?.day, hour: args?.hour,
          dayFrom: args?.dayFrom, dayTo: args?.dayTo,
          offset: args?.offset, limit: args?.limit, query: args?.query
        })
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  'memory.status': (args = {}) => {
    // ── 探针短路 ──────────────────────────────────────────────────────────
    // 冲突自检要问"第一个 memory.status 提供者是不是我"，问法就是调一次
    // api.capability('memory.status', 探针)。如果先答话的是我，就走这一支：
    // **不建实例、不读盘、不算体积**，只回一个引擎标记。
    // ⚠️ 必须放在 instance() 之前 —— 探针是在 activate() 里跑的，那时候
    //    还没必要把整个引擎唤醒；而且这里返回得早，也就不存在自检递归。
    if (args && args[PROBE_KEY] === ENGINE_TAG) {
      return { ok: true, engine: ENGINE_TAG, probe: true };
    }
    try {
      const it = instance();
      const policy = settings();
      return {
        ok: true,
        engine: ENGINE_TAG,
        // 冲突自检结论：level=none 时说明内置版没开（或已被关掉）。
        conflict: (() => {
          try {
            const g = guard();
            if (!g) return { level: 'none', builtinActive: false, selfFirst: null, hint: '' };
            g.check();
            return g.snapshot();
          } catch { return { level: 'none', builtinActive: false, selfFirst: null, hint: '' }; }
        })(),
        index: it.store.stats(),
        disk: dirSize(it.store.root),
        usage: it.stats.snapshot(),
        extras: {
          todos: it.pending.stats(),
          cards: it.cards.stats(),
          crossTurn: it.crossTurn.stats(),
          peek: it.peek.stats(),
          budget: it.budget.snapshot(),
          // 梗概墓碑：条数 + 体积。"一直很小"正是它存在的意义，所以两个数都要露出来。
          gist: { ...it.gist.stats(), bytes: it.gist.size() }
        },
        policy: {
          rollupAfterDays: policy.rollupAfterDays,
          forgetAfterDays: policy.forgetAfterDays,
          decayHalfLifeDays: policy.decayHalfLifeDays,
          autoRecall: policy.autoRecall,
          autoRecallBudget: policy.autoRecallBudget,
          pendingTodos: policy.pendingTodos,
          crossTurn: policy.crossTurn,
          semanticCards: policy.semanticCards,
          cardsCrossChat: policy.cardsCrossChat,
          crossChatPeek: policy.crossChatPeek,
          budgetGuard: policy.budgetGuard,
          gistEnabled: policy.gistEnabled,
          peopleBoost: policy.peopleBoost,
          diversityLambda: policy.diversityLambda,
          linkBoost: policy.linkBoost,
          reminiscenceAmp: policy.reminiscenceAmp,
          todBoost: policy.todBoost,
          sleepReplay: policy.sleepReplay
        }
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  /** 全量重建某会话的索引（数据移植 / 排障用）。 */
  'memory.rebuild': (args = {}) => {
    const chatKey = String(args?.chatKey ?? '').trim();
    if (!chatKey) return { ok: false, error: '缺少 chatKey' };
    try {
      const { consolidator: c } = instance();
      const r = c.consolidateChat(chatKey, { force: true });
      return { ok: true, mode: 'force-consolidate', ...r };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

export const hooks = {
  /** 收集本轮触发文本，供注入时当检索查询用。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const texts = [];
      const people = new Set();
      for (const e of entries) {
        const t = String(e?.text ?? '').trim();
        if (t) texts.push(t);
        // "在场的人"只算**别人** —— 机器人自己几乎每轮都在，
        // 算进去会让"在场的人有交集"退化成"块里有人说过话"，多线索加权就废了。
        // （store 侧对块做同样的排除，这里是双保险。）
        if (e?.self) continue;
        const uid = String(e?.senderId ?? '').trim();
        if (uid) people.add(uid);
      }
      const key = String(ctx.sessionId || ctx.chatKey || '');
      if (!key) return;
      // ⚠️ 写入前顺手清陈旧条目：两个钩子之间流程可能中断（本轮被别的钩子拦、
      //    钩子抛错、LLM 未发起），条目会永久留在 Map 里 —— 慢速泄漏。
      if (pendingTrigger.size > 64) {
        const cutoff = Date.now() - 10 * 60000;
        for (const [k, v] of pendingTrigger) if (!v || (Number(v.at) || 0) < cutoff) pendingTrigger.delete(k);
      }
      pendingTrigger.set(key, {
        at: Date.now(),
        chatKey: String(ctx.chatKey || ''),
        triggerText: texts.join('\n').slice(0, 800),
        personIds: [...people]
      });
    } catch { /* 收集失败只是少点上下文，不影响这轮 */ }
  },

  /**
   * 注入记忆片段。
   * ⚠️ 这里**不**跑巩固：钩子有 5 秒超时，而巩固要读文件、写索引 —— 超时会被
   *    整个跳过还可能留下半截状态。巩固交给 activate() 的定时器。
   */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingTrigger.get(key) || {};
    pendingTrigger.delete(key);          // 用完即删，别攒着会话引用

    const chatKey = String(ctx.chatKey || info.chatKey || '');
    if (!chatKey) return;

      try {
        const { text, recalled, announce, passiveChunkIds, cooldownChunkIds, replayChunkIds } = buildInject({
          chatKey,
          triggerText: info.triggerText || '',
          personIds: info.personIds || []
        });
      if (!text) return;
      // 提醒的冷却只有"真的送出去了"才记账 —— 否则找不到 user 消息、
      // appendToLastUser 返回 false 时，这一次冷却被白吃掉，主人一整天看不到提醒。
      const delivered = appendToLastUser(ctx.messages, text);
      if (delivered && announce) guard()?.markAnnounced();
      // 被动命中 + 冷却记账：**送达之后**才做，且只记真的写进提示词的那几个块。
      // 被动命中的计的是"模型看到过"这件事，权重/锚点一个字节都不动（见 store.markHit）。
      // 这是本插件唯一会因"自动注入"而增长的量，所以它绝不能反过来影响排序。
      if (delivered && cooldownChunkIds.length) {
        try {
          const { store: st, injector: inj } = instance();
          inj.markInjected(chatKey, cooldownChunkIds);
          for (const id of passiveChunkIds) st.markHit(chatKey, id, { mode: 'passive' });
        } catch { /* 记账失败不影响本轮 */ }
      }
      // 睡眠重演的记账（v1.7.0）：播出 = 一次成功的提取练习（测试效应）→ 按 full 计权，
      // 与"被动看到"严格分开。没播出去（appendToLastUser 失败）就什么都不记。
      if (delivered && Array.isArray(replayChunkIds) && replayChunkIds.length) {
        try {
          const { store: st } = instance();
          for (const id of replayChunkIds) st.markHit(chatKey, id, { mode: 'full', replay: true });
        } catch { /* 记账失败不影响本轮 */ }
      }
      if (recalled.length) {
        // 与 pendingTrigger 同样的道理：after-response 未必每轮都跑到
        // （本轮被别的钩子拦、LLM 未发起、进程重启），不清理就是慢速泄漏。
        if (lastInject.size > 64) {
          const cutoff = Date.now() - 10 * 60000;
          for (const [k, v] of lastInject) if (!v || (Number(v.at) || 0) < cutoff) lastInject.delete(k);
        }
        lastInject.set(chatKey, { at: Date.now(), lines: recalled });
      }
    } catch (error) {
      api.warn('记忆注入失败：', error?.message ?? error);
    }
  },

  /**
   * 运行结束：写跨轮状态 + 记本轮成本 + 把内存里的索引与统计按节流落盘。
   * 都是本地小文件操作，不在钩子里做重活。
   */
  async 'after-response'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const chatKey = String(ctx?.chatKey || '');

    try {
      const it = instance();

      // 1) 跨轮状态：本轮发了什么、上一轮注入过哪些旧事
      if (s.crossTurn !== false && chatKey) {
        const prev = lastInject.get(chatKey);
        lastInject.delete(chatKey);
        const content = ctx?.response?.message?.content;
        it.crossTurn.save(chatKey, {
          sent: Array.isArray(ctx?.session?.sent) ? ctx.session.sent : [],
          draft: typeof content === 'string' ? content : '',
          recalled: prev?.lines || [],
          unfinished: false
        });
      }

      // 2) 成本护栏：只报**本轮增量**。
      //    宿主 after-response 每轮都触发，而 ctx.session.usage 是运行级累计值 ——
      //    内置版踩过这个坑（真实 791K 被记成 1285K，×1.62）。response.usage 才是
      //    服务端给这一次调用的原始用量。
      if (s.budgetGuard !== false) {
        const u = ctx?.response?.usage || {};
        it.budget.report(chatKey, {
          promptTokens: Number(u.prompt_tokens) || 0,
          cachedTokens: Number(
            u.prompt_tokens_details?.cached_tokens
            ?? u.prompt_cache_hit_tokens
            ?? u.cached_tokens
            ?? 0
          ) || 0
        });
      }

      // 3) 落盘
      it.store.flushAll({ force: false });
      it.stats.flush({ force: false });
    } catch { /* 记忆是增强功能，坏了不能让对话陪葬 */ }
  },

  /**
   * 观测：模型到底有没有主动用记忆。
   * 这是回答"记忆是不是白开了"的唯一数据来源 —— 内置版没有这个钩子。
   */
  async 'after-tool'(ctx = {}) {
    if (settings().observeTools === false) return;
    try {
      const name = String(ctx?.toolName || '');
      if (name.includes('memory_search')) instance().stats.bump({ toolSearch: 1 });
      else if (name.includes('memory_archive')) instance().stats.bump({ toolArchive: 1 });
      else if (name.includes('memory_status')) instance().stats.bump({ toolStatus: 1 });
      else if (name.includes('memory_todo')) instance().stats.bump({ toolTodo: 1 });
    } catch { /* 统计失败无所谓 */ }
  }
};

/** 供本地自测/排障直接拿内部实例（宿主不会调用）。 */
export function __internals() {
  return { settings, instance, consolidate, appendToLastUser, buildInject, guard };
}