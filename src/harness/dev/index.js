// 开发工单（dev-orders）—— 「开发模式」：白名单直接对话，聊天就是开发。
//
// ── 定位 ──
//   白名单成员发「开发 xxx」→ 该会话（群/私聊）进入**开发模式**：
//   · 之后的每条白名单消息都直接进开发 agent（对话持续、模型直接改文件）；
//   · agent 的回复直接发回 QQ（不需要来 harness 确认）；
//   · harness →「开发工单」页 = 看/插话同一个会话（本机聊天框）。
//   发「退出开发」结束开发模式。
//
// ── 权限立场（用户明确要求：白名单就是最大的信任）──
//   · 文件工具以**项目根**为界：项目内（含 data/、.workbuddy/、resources/app/…）全读写；
//   · dev_run：在项目根**启动 shell 执行任意命令**（构建/测试/git…）。
//     ⚠️ cwd 只是起始目录、**不是沙箱** —— 命令能 cd 出去、按绝对路径读写项目外文件、
//     执行任意程序、连任意主机。所以"不越出项目目录"只对文件工具成立，对 dev_run 不成立。
//   ⚠️ 这个模式等价于"把开发机交给白名单账号"：账号被盗 = 机器被接管（并可越出项目目录）。
//
// ── 红线 ──
//   状态只写 <DATA_DIR>/plugin-data/dev-orders/（state.json / sessions/ / transcripts/）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../config.js';
import { runTurn, trimMessagesToBudget, isCtxNote, CTX_NOTE_PREFIX } from './executor.js';

// 内置化（2026-10-21）：本文件在 <appRoot>/src/harness/dev/，层级比插件期深一层。
// 三个根改成可写，setup 时优先采用宿主注入的 api.appRoot（见 src/harness/index.js）。
let APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
const SANDBOX_NAME = 'dev-sandbox';
const SANDBOX_ENV = String(process.env.QQ_AGENT_DEV_SANDBOX || '').trim();
let SANDBOX_ROOT = SANDBOX_ENV || path.join(PROJECT_ROOT, SANDBOX_NAME);

const DEFAULTS = { maxRounds: 120, turnTimeoutSec: 3600, maxSessionsPerDay: 20, thinkingNotice: true, noticeMinGapSec: 20, ctxCharBudget: 400 * 1024 };
const MAX_REQUIREMENT_LEN = 600;
const HISTORY_KEEP = 60;          // 保留的对话条目数（文本轮；工具足迹在 transcript 里）
const ROUTE_CACHE_MS = 5 * 60 * 1000;
const DETAIL_MAX_BYTES = 256 * 1024;   // dev.order-detail 单次最多读这么多字节的 transcript
const DETAIL_MAX_LINES = 400;          // dev.order-detail 单次最多返回这么多行

let cfg = () => DEFAULTS;
let log = (..._a) => {};
let api_ = null;
let storeDir = '';
let statePath = '';
let transcriptDir = '';
let historyDir = '';
let ctxDir = '';                  // 追加式上下文（ctx/<id>.json）
let state = null;                 // { v:2, whitelist:[], seq, sessions:[] }
let running = '';                 // 正在跑的会话 id（全局单飞：一次一个 turn）
let runningSince = 0;             // 本轮开始时间（界面用来显示"已跑 N 分钟"）
let currentAbort = null;          // 当前轮的 abortBox（界面「中止」按钮用）
const pendingTurns = new Map();   // sessionId -> [{ text, from, at }]
const senders = new Map();        // chatKey -> send(texts)（onMessage 时由核心递进来的"话筒"）
const routeCache = new Map();     // 去重：onMessage 与 dev.route 对同一条消息只处理一次

// ── 状态存取 ─────────────────────────────────────────────────────────────

function emptyState() {
  return { v: 2, whitelist: [], seq: 0, sessions: [] };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const s = emptyState();
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.whitelist)) s.whitelist = raw.whitelist.map((x) => String(x)).filter(Boolean);
      if (Number.isFinite(Number(raw.seq))) s.seq = Math.max(0, Number(raw.seq));
      const list = Array.isArray(raw.sessions) ? raw.sessions : (Array.isArray(raw.orders) ? raw.orders : []);
      s.sessions = list.filter((o) => o && typeof o === 'object' && o.id).map((o) => ({
        id: o.id,
        seq: o.seq,
        title: String(o.title || o.requirement || '').slice(0, 200),
        chatKey: String(o.chatKey || ''),
        source: o.source === 'local' ? 'local' : 'qq',
        status: o.status === 'closed' ? 'closed' : 'active',
        createdAt: o.createdAt || 0,
        updatedAt: o.updatedAt || o.finishedAt || o.createdAt || 0,
        lastReply: String(o.lastReply || o.summary || '').slice(0, 2000),
        // 本次开发的累计用量（界面底部显示；老状态文件里没有这一项 → null）
        usage: (o.usage && typeof o.usage === 'object') ? {
          promptTokens: Number(o.usage.promptTokens) || 0,
          completionTokens: Number(o.usage.completionTokens) || 0,
          cachedTokens: Number(o.usage.cachedTokens) || 0,
          totalTokens: Number(o.usage.totalTokens) || 0,
          calls: Number(o.usage.calls) || 0,
          turns: Number(o.usage.turns) || 0
        } : null
      }));
    }
    state = s;
  } catch {
    state = emptyState();
  }
}

function save() {
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, statePath);
  } catch (e) {
    log(`⚠️ 状态写入失败：${e?.message || e}`);
  }
}

function ensureSandbox() {
  try { fs.mkdirSync(SANDBOX_ROOT, { recursive: true }); } catch { /* ignore */ }
}

// ── 开发记录 / 对话历史 ───────────────────────────────────────────────────

function transcriptPathFor(id) { return path.join(transcriptDir, `${id}.jsonl`); }
function historyPathFor(id) { return path.join(historyDir, `${id}.json`); }
function ctxPathFor(id) { return path.join(ctxDir, `${id}.json`); }

// ── 追加式上下文（2026-10-09，借鉴 DSH 把命中率做到 99% 的做法）────────────
//
// 前缀缓存只认"严格扩展"：请求 N+1 必须是请求 N 的前缀 + 新尾部才命中。
// 所以这里存的是**上一轮结束时的完整消息数组**（含 assistant 的 tool_calls 与 role:tool 结果），
// 下次请求直接接在它后面 —— 而不是像以前那样用 {role,text} 文本历史重建（把工具足迹全丢了）。
// 代价：上下文会一直长 → 超过预算就压一次（只保留最近若干轮），
// 压缩会让前缀断一次（一次全价），之后又稳定 —— 这是"长会话"绕不开的取舍。
// ⚠️ 上限默认维持 40 万字符（2026-10-09 用户拍板：**开发用量不小，别压；隔离靠换模型**）——
//   前缀缓存的容量按「账号 + 模型」共享，挤占问题用「开发模式配一个不同的模型」治本
//   （executor 有同模型警告、模型设置弹窗有提示），而不是砍开发模式的上下文。
//   但 2026-10-15 用户报「会话量一多就爆了、只能记单次对话」：40 万字符对窗口较小的
//   模型（以及中文/代码混合的上下文）本来就可能超。所以现在：① 预算可在
//   harness → 开发工单 → 模型设置 里调小；② 请求前/每轮前都按预算裁（见 executor）；
//   ③ 撞了 context_length_exceeded 会自动减半重试。
const CTX_MAX_CHARS = 400000;
// 2026-10-15 起不再使用（压实改由 executor 的 trimMessagesToBudget 统一处理，
// 它按预算裁而不是按固定条数）。保留常量只为兼容旧测试引用。
const CTX_KEEP_TAIL = 40;

function loadCtx(id) {
  try {
    const d = JSON.parse(fs.readFileSync(ctxPathFor(id), 'utf8'));
    if (Array.isArray(d?.messages)) return d.messages;
  } catch { /* 还没有就空 */ }
  return [];
}

function saveCtx(id, messages, opts = {}) {
  try {
    // maxChars 可传参（测试用小阈值驱动同一条压实路径，不用造 40 万字符的数据）
    const cap = Math.max(1000, Number(opts.maxChars) || CTX_MAX_CHARS);
    let msgs = Array.isArray(messages) ? messages : [];
    let compacted = 0;
    // ⚠️ 2026-10-15：压实改成调 executor 里的**同一个** trimMessagesToBudget。
    //   原来这里另写了一份"先按条数、再按大小"的逻辑，和请求侧的预算各说各话 ——
    //   结果就是"请求侧早就该压了，这里却还没压"，每一轮都拿超限的上下文去撞上游
    //   400（用户报「随着会话量增多，他爆了」）。而且旧逻辑只保最近 40 条、
    //   把"最初那句需求"一起丢了 → 「只能记单次对话」。
    //   现在统一：落点对齐 user 消息、保留最近一轮、并把最初的需求写进省略提示。
    const fit = trimMessagesToBudget(msgs, cap);
    if (fit.trimmed) { msgs = fit.messages; compacted = fit.dropped; }
    fs.mkdirSync(ctxDir, { recursive: true });
    const tmp = `${ctxPathFor(id)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, savedAt: Date.now(), compacted, messages: msgs }, null, 1)}\n`);
    fs.renameSync(tmp, ctxPathFor(id));
  } catch (e) {
    log(`⚠️ 上下文写入失败：${e?.message || e}`);
  }
}

function appendTranscript(id, evt) {
  try {
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.appendFileSync(transcriptPathFor(id), JSON.stringify(evt) + '\n');
  } catch (e) {
    log(`⚠️ 开发记录写入失败：${e?.message || e}`);
  }
}

function loadHistory(id) {
  try {
    const d = JSON.parse(fs.readFileSync(historyPathFor(id), 'utf8'));
    if (Array.isArray(d?.messages)) return d.messages.filter((m) => m && m.role && m.text);
  } catch { /* 没有就空 */ }
  return [];
}

function saveHistory(id, messages) {
  try {
    fs.mkdirSync(historyDir, { recursive: true });
    const trimmed = messages.slice(-HISTORY_KEEP);
    fs.writeFileSync(historyPathFor(id), JSON.stringify({ v: 1, messages: trimmed }, null, 2) + '\n');
  } catch (e) {
    log(`⚠️ 对话历史写入失败：${e?.message || e}`);
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────

function normalizeQQ(v) {
  return String(v ?? '').trim().replace(/[^0-9]/g, '');
}

function stripDecorations(text) {
  let t = String(text || '').trim();
  for (let i = 0; i < 3; i++) {
    const n = t.replace(/^\[(?:引用|回复)[^\]]*\]\s*/, '');
    if (n === t) break;
    t = n;
  }
  for (let i = 0; i < 3; i++) {
    const m = /^@[^\s@]*?(?:\(QQ:\d+\))?\s+/.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t.trim();
}

/** 「开发 xxx」：剥掉装饰后以「开发」开头（拒「开发了/过/出/的/着/完」这类陈述句）。 */
function extractRequirement(text) {
  const cleaned = stripDecorations(text);
  const m = /^\s*[/]?\s*开发\s*[:：,，]?\s*([\s\S]+)$/.exec(cleaned);
  if (!m) return '';
  const req = m[1].replace(/\s+/g, ' ').trim();
  if (req.length < 2 || req.length > MAX_REQUIREMENT_LEN) return '';
  if (/^[了过出的着完]/.test(req)) return '';
  return req;
}

/**
 * 收工指令：「退出/结束/关闭/停止」+ 可选的「开发（模式）」。
 * ⚠️ 单独的「结束」「退出」也算 —— 但只在"白名单 + 该会话正处于开发模式"时生效，
 * 不会影响普通聊天；整句必须就是这个指令（可带标点），不能是句子里的一小段。
 */
const EXIT_RE = /^(?:退出|结束|关闭|停止)\s*(?:开发(?:模式)?\s*)?[。!！~]?$/;

/**
 * 重开旧工单：「开发#6」「开发 #6」，后面还能带一句话（重开后直接当作需求发给它）。
 * ⚠️ 必须在 extractRequirement **之前**判定 —— 否则「开发#6」会被当成新需求，
 * 建出一个标题叫「#6」的新会话（那就永远回不去了）。
 */
const REOPEN_RE = /^\s*[/]?\s*开发\s*[#＃]\s*(\d+)\s*[:：,，]?\s*([\s\S]*)$/;

function todaySessionCount() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return state.sessions.filter((s) => Number(s.createdAt || 0) >= start.getTime()).length;
}

/**
 * 重开旧工单（「开发#6」/ 界面的「重开」按钮）。
 *
 * 为什么可行：追加式上下文（ctx/<id>.json）一直都在 —— 重开后模型能**接着上次的
 * 工具足迹继续干**，这是这个功能真正有价值的地方（不是把标题翻出来，是续上工作现场）。
 * 规则：同 chat 的其它活跃工单先归档（保持"同 chat 活跃会话唯一"）；
 *       工单属于别的群时不允许跨群重开；本机工单被群里重开则转入该群。
 */
function reopenSession(seq, { chatKey = '' } = {}) {
  const n = Math.max(1, Math.floor(Number(seq) || 0));
  if (!n) return { ok: false, msg: '工单编号不对（要形如 开发#6）。' };
  const s = state.sessions.find((x) => Number(x.seq) === n);
  if (!s) {
    const recent = state.sessions.slice(-5).reverse()
      .map((x) => `#${x.seq} ${String(x.title || '').slice(0, 24)}`).join('、');
    return { ok: false, msg: `没有 #${n} 这个工单。最近的：${recent || '（还没有）'}` };
  }
  if (s.chatKey && chatKey && s.chatKey !== chatKey) {
    return { ok: false, msg: `工单 #${s.seq} 属于其它会话（${s.chatKey}），不能在这边重开。` };
  }
  if (chatKey) {
    for (const x of state.sessions) {
      if (x.id !== s.id && x.chatKey === chatKey && x.status === 'active') {
        x.status = 'closed';
        appendTranscript(x.id, { kind: 'closed', at: Date.now() });
      }
    }
  }
  const wasActive = s.status === 'active';
  s.status = 'active';
  if (chatKey) s.chatKey = chatKey;      // 本机工单被群里重开 → 转入该群
  s.updatedAt = Date.now();
  appendTranscript(s.id, {
    kind: 'notice', at: Date.now(),
    text: wasActive ? `已回到工单 #${s.seq}` : `已重开工单 #${s.seq}`
  });
  save();
  log(`重开工单 #${s.seq}（${s.id}）${chatKey ? `@ ${chatKey}` : '（界面）'}`);
  return {
    ok: true,
    session: s,
    msg: `${wasActive ? '已在' : '已回到'}工单 #${s.seq}「${String(s.title || '').slice(0, 40)}」。`
      + '直接说需求就能继续（上次的上下文都在）；发「结束」退出。'
  };
}

function findSession(id) {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return state.sessions.find((s) => s.id === key) || null;
}

function activeSessionFor(chatKey) {
  const list = state.sessions.filter((s) => s.chatKey === chatKey && s.status === 'active');
  return list.length ? list[list.length - 1] : null;
}

function sessionView(s) {
  const u = s.usage || null;
  return {
    id: s.id,
    seq: s.seq,
    title: s.title,
    chatKey: s.chatKey,
    source: s.source,
    status: s.status,
    createdAt: s.createdAt || 0,
    updatedAt: s.updatedAt || 0,
    // ⚠️ 只给短预览：sessionView 会被 dev.snapshot 带上**所有**会话、界面每秒拉一次；
    //    原来这里带的是 2000 字的完整回复，会话一多快照就是几百 KB 的纯浪费
    //    （用户报「随着会话量增多，他爆了」的一半原因）。列表本来只渲染 title/时间/状态。
    lastReply: String(s.lastReply || '').slice(0, 200),
    // 命中率口径与项目其它地方一致：cachedTokens / promptTokens（llm.js cacheHitRate）
    usage: u ? { ...u, hitRate: u.promptTokens ? Math.min(1, (u.cachedTokens || 0) / u.promptTokens) : 0 } : null
  };
}

/** 把一轮的用量并进会话（**失败/中止也并** —— 那些 token 是真花了）。 */
function mergeUsage(session, u) {
  if (!session || !u || !Number(u.calls)) return;
  const cur = session.usage || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0, turns: 0 };
  session.usage = {
    promptTokens: cur.promptTokens + (Number(u.promptTokens) || 0),
    completionTokens: cur.completionTokens + (Number(u.completionTokens) || 0),
    cachedTokens: cur.cachedTokens + (Number(u.cachedTokens) || 0),
    totalTokens: cur.totalTokens + (Number(u.totalTokens) || 0),
    calls: cur.calls + (Number(u.calls) || 0),
    turns: (cur.turns || 0) + 1
  };
  session.updatedAt = Date.now();
  save();
}

// ── 会话生命周期 ─────────────────────────────────────────────────────────

function startNewSession({ chatKey = '', source = 'qq', title = '', requesterName = '' }) {
  if (source === 'qq') {
    const limit = Math.max(1, Number(cfg().maxSessionsPerDay) || DEFAULTS.maxSessionsPerDay);
    if (todaySessionCount() >= limit) {
      log(`今日会话数已达上限（${limit}），本条不建新会话`);
      return null;
    }
  }
  // 同一会话（chat）里再开新开发会话 = 关掉旧的
  const prev = chatKey ? activeSessionFor(chatKey) : null;
  if (prev) prev.status = 'closed';
  state.seq += 1;
  const s = {
    id: `dev-${state.seq}`,
    seq: state.seq,
    title: String(title || '').slice(0, 200) || `开发会话 #${state.seq}`,
    chatKey,
    source,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastReply: ''
  };
  state.sessions.push(s);
  save();
  log(`新开发会话 ${s.id}（${source === 'qq' ? `来自 ${chatKey}` : '本机'}）：${s.title.slice(0, 50)}${requesterName ? ` · ${requesterName}` : ''}`);
  return s;
}

function closeSession(id) {
  const s = findSession(id);
  if (!s) return { ok: false, error: '会话不存在' };
  s.status = 'closed';
  s.updatedAt = Date.now();
  save();
  return { ok: true, id: s.id, seq: s.seq };
}

function queueTurn(session, text, from) {
  const list = pendingTurns.get(session.id) || [];
  list.push({ text, from, at: Date.now() });
  pendingTurns.set(session.id, list);
  appendTranscript(session.id, { kind: 'user', at: Date.now(), text, from });
  kickRunner();
}

function safeSend(chatKey, messages, opts) {
  const fn = senders.get(chatKey);
  if (typeof fn !== 'function') return false;
  try {
    Promise.resolve(fn(messages, opts)).catch((e) => log(`⚠️ 回信失败：${e?.message || e}`));
    return true;
  } catch (e) {
    log(`⚠️ 回信异常：${e?.message || e}`);
    return false;
  }
}

/** 单飞调度：一次跑一个 turn，跑完接着看队列。 */
function kickRunner() {
  if (running) return;
  let next = '';
  for (const [sid, list] of pendingTurns) {
    if (list.length && findSession(sid)?.status === 'active') { next = sid; break; }
  }
  if (!next) return;
  running = next;
  runningSince = Date.now();
  runOneTurn(next)
    .catch((e) => log(`⚠️ turn 未捕获异常：${e?.message || e}`))
    .finally(() => {
      running = '';
      runningSince = 0;
      currentAbort = null;
      save();
      kickRunner();
    });
}

async function runOneTurn(sessionId) {
  const session = findSession(sessionId);
  const list = pendingTurns.get(sessionId) || [];
  pendingTurns.delete(sessionId);
  if (!session || session.status !== 'active' || !list.length) return;

  const joined = list.map((x) => String(x.text || '').trim()).filter(Boolean).join('\n\n').slice(0, MAX_REQUIREMENT_LEN * 2);
  if (!joined) return;
  const from = list[list.length - 1].from || '';

  const history = loadHistory(sessionId);      // 老的文本历史（仅作迁移兜底）
  const priorMessages = loadCtx(sessionId);    // 追加式上下文（优先用这个）
  const cfgNow = cfg();
  // 上下文预算（字符）：默认 40 万，harness → 开发工单 → 模型设置 里可调小
  const ctxBudget = Math.max(32 * 1024, Number(cfgNow.ctxCharBudget) || DEFAULTS.ctxCharBudget);
  const workDir = path.join(SANDBOX_ROOT, sessionId);
  try { fs.mkdirSync(workDir, { recursive: true }); } catch { /* ignore */ }

  let reply = '';
  const abortBox = {};
  const usageBox = {};
  const ctxBox = {};
  currentAbort = abortBox;      // 让「中止」按钮能打到本轮
  // 失败/中止也要落账：token 是真花的，工具足迹也是下一轮的上下文
  const persistTurn = () => {
    mergeUsage(session, usageBox);
    if (Array.isArray(ctxBox.messages) && ctxBox.messages.length) {
      // 落盘时用**和请求侧同一个预算**（否则下次开轮时又要当场裁一次，白断一次前缀）
      saveCtx(sessionId, ctxBox.messages, { maxChars: ctxBudget });
    }
  };
  try {
    reply = await runTurn({
      session,
      userText: joined,
      userFrom: from,
      history,
      priorMessages,
      workDir,
      projectRoot: PROJECT_ROOT,
      maxRounds: Math.max(2, Number(cfgNow.maxRounds) || DEFAULTS.maxRounds),
      timeoutSec: Math.max(30, Number(cfgNow.turnTimeoutSec) || DEFAULTS.turnTimeoutSec),
      ctxCharBudget: ctxBudget,
      log,
      onEvent: (evt) => appendTranscript(sessionId, evt),
      // 「正在连接 X…」的出口：QQ 会话直发回群（走统一发送队列：限频/去重/留档）；
      // 本机会话没有收件人 —— 提示只进 transcript，由 harness 页面显示。
      // ⚠️ dedupe: false —— 提示文案每轮都一模一样，走默认去重会被 8 秒窗口静默吃掉
      //   （表现就是"有时有提示、有时没有"）。限流由 executor 的 20 秒节流负责。
      notify: session.chatKey ? (text) => safeSend(session.chatKey, text, { dedupe: false }) : null,
      noticeEnabled: cfgNow.thinkingNotice !== false,
      noticeGapSec: Number(cfgNow.noticeMinGapSec),
      abortBox,
      usageBox,
      ctxOut: ctxBox
    });
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 500);
    persistTurn();   // 失败/中止的 token 是真花了的；工具足迹也是下一轮的上下文
    // 被用户中止：不是错误，别把界面刷成红色报错，回群里也说清楚
    if (msg.includes('已被用户中止')) {
      appendTranscript(sessionId, { kind: 'notice', at: Date.now(), text: '已被用户中止（这一轮停下了）' });
      session.updatedAt = Date.now();
      save();
      if (session.chatKey) safeSend(session.chatKey, '（已中止这一轮）');
      return;
    }
    appendTranscript(sessionId, { kind: 'error', at: Date.now(), message: msg });
    session.updatedAt = Date.now();
    if (session.chatKey) safeSend(session.chatKey, `（开发出错：${msg}）`);
    return;
  }
  persistTurn();

  if (!reply) {
    reply = '（本轮只改动了文件，没有附说明 —— 需要细节可以继续问。）';
    appendTranscript(sessionId, { kind: 'assistant', at: Date.now(), text: reply, fallback: true });
  }
  saveHistory(sessionId, [...history, { role: 'user', text: joined, at: Date.now() }, { role: 'assistant', text: reply, at: Date.now() }]);
  session.lastReply = reply.slice(0, 2000);
  session.updatedAt = Date.now();
  save();

  if (session.chatKey) {
    const ok = safeSend(session.chatKey, reply);
    appendTranscript(sessionId, { kind: 'delivered', at: Date.now(), ok });
  }
}

// ── 消息路由（onMessage 钩子 + dev.route 能力共用；按 mid 去重）─────────────

function handleIncoming({ chatKey, senderId, senderName, text, mid, send }) {
  const ck = String(chatKey || '');
  if (!ck) return false;
  const cacheKey = String(mid || `${ck}|${senderId}|${String(text || '').slice(0, 80)}`);
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ROUTE_CACHE_MS) return cached.handled;

  let handled = false;
  try {
    const qq = normalizeQQ(senderId);
    if (qq && state.whitelist.includes(qq)) {
      if (typeof send === 'function') senders.set(ck, send);
      const cleaned = stripDecorations(text);
      if (cleaned) {
        if (EXIT_RE.test(cleaned)) {
          const cur = activeSessionFor(ck);
          if (cur) {
            closeSession(cur.id);
            safeSend(ck, `已退出开发模式（会话 #${cur.seq} 已归档）。`);
            appendTranscript(cur.id, { kind: 'closed', at: Date.now() });
          } else {
            safeSend(ck, '当前不在开发模式。');
          }
          handled = true;
        } else {
          // 「开发#6」→ 重开旧工单（必须放在 extractRequirement 之前，见 REOPEN_RE 的注释）
          const rm = REOPEN_RE.exec(cleaned);
          if (rm) {
            const r = reopenSession(Number(rm[1]), { chatKey: ck });
            safeSend(ck, r.msg);
            if (r.ok && r.session) {
              const rest = String(rm[2] || '').trim();
              if (rest) queueTurn(r.session, rest, String(senderName || qq));   // 「开发#6 把标题改掉」
            }
            handled = true;
          } else {
            const req = extractRequirement(cleaned);
            if (req) {
              const s = startNewSession({ chatKey: ck, source: 'qq', title: req, requesterName: String(senderName || qq) });
              if (s) {
                queueTurn(s, req, String(senderName || qq));
                handled = true;
              }
            } else {
              const active = activeSessionFor(ck);
              if (active) {
                queueTurn(active, cleaned, String(senderName || qq));
                handled = true;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    log(`handleIncoming 处理失败：${e?.message || e}`);
  }
  routeCache.set(cacheKey, { handled, at: Date.now() });
  if (routeCache.size > 400) {
    for (const [k, v] of routeCache) { if (Date.now() - v.at > ROUTE_CACHE_MS) routeCache.delete(k); }
  }
  return handled;
}

/**
 * 从 transcript（JSONL，append-only）里读一段**完整的记录行**。
 *
 * ⚠️ 2026-10-15 新增。原实现是 `readFileSync(整个文件).split('\n').filter(Boolean)`，
 *   而界面在跑单时每秒拉一次增量 —— 文件越大越慢，最后把主线程拖死（用户报
 *   「调用次数一多，自动刷新就暴毙」）。这里只读需要的那一段，开销与文件大小无关。
 *
 * @param {string} file  transcript 文件路径
 * @param {number} cursor 已读**字节偏移**；0（或已失效）→ 返回文件尾部窗口。
 *   ⚠️ 契约：cursor 必须是本函数上次返回的 nextFrom（或 0）。自己算的偏移如果没落在
 *   行首，开头会多出半条记录（本函数不做行首对齐探测，省一次读）。
 * @returns {{raw:string[], from:number, nextFrom:number, hasMore:boolean, size:number}}
 *   raw = 原始 JSONL 行；from = 这批第一行的字节偏移；nextFrom = 不透明游标（原样回传）
 */
function readTranscriptWindow(file, cursor = 0) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }

  const cur = Math.max(0, Number(cursor) || 0);
  const tail = !cur || cur > size;     // 首次打开 / 游标失效（记录被删或重建）→ 尾部窗口
  const winStart = tail ? Math.max(0, size - DETAIL_MAX_BYTES) : cur;
  const winLen = Math.max(0, Math.min(size - winStart, DETAIL_MAX_BYTES));

  let chunk = '';
  if (winLen > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.allocUnsafe(winLen);
      const n = fs.readSync(fd, b, 0, winLen, winStart);
      chunk = b.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  // ── 切齐行边界 ──
  let body = chunk;
  let base = winStart;                 // body 第一个字符在文件里的字节偏移
  if (tail && winStart > 0) {
    // 从文件中间切进来的：开头那段是半行，不是完整记录 → 丢掉
    const nl = body.indexOf('\n');
    if (nl >= 0) { base += Buffer.byteLength(body.slice(0, nl + 1), 'utf8'); body = body.slice(nl + 1); }
    else { base += winLen; body = ''; }
  } else if (!tail) {
    // 增量窗口：写入方可能正在写最后一条 → 先不消费它
    const nl = body.lastIndexOf('\n');
    if (nl >= 0) body = body.slice(0, nl + 1);
    else if (winLen === DETAIL_MAX_BYTES) { base += winLen; body = ''; }   // 单条记录超窗口上限：跳过，别让游标卡死
    else body = '';
  }
  // 统一收尾：末尾那条没写完的半行剔掉（下次读到完整的再显示，别渲染半条记录）
  let pendingTail = '';
  if (body && !body.endsWith('\n')) {
    const i = body.lastIndexOf('\n');
    pendingTail = i >= 0 ? body.slice(i + 1) : body;
    body = i >= 0 ? body.slice(0, i + 1) : '';
  }

  const all = body ? body.split('\n').filter(Boolean) : [];
  const raw = tail ? all.slice(-DETAIL_MAX_LINES) : all.slice(0, DETAIL_MAX_LINES);
  const droppedHead = all.length - raw.length;         // 尾部窗口里让给"更早"的行数

  const consumed = raw.length ? Buffer.byteLength(`${raw.join('\n')}\n`, 'utf8') : 0;
  const nextFrom = tail ? size - Buffer.byteLength(pendingTail, 'utf8') : base + consumed;
  const from = droppedHead > 0
    ? base + Buffer.byteLength(`${all.slice(0, droppedHead).join('\n')}\n`, 'utf8')
    : base;

  return { raw, from, nextFrom, hasMore: from > 0, size };
}

/**
 * 往前翻页：读 [before - DETAIL_MAX_BYTES, before) 这一段，返回**离 before 最近的**
 * 一批完整记录行（界面的「载入更早」）。
 *
 * @param {string} file
 * @param {number} before 这一批的**上界**（字节偏移，取自上一批的 from / prevFrom）
 * @returns {{raw:string[], from:number, hasMore:boolean, size:number}}
 */
function readTranscriptBefore(file, before = 0) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  const end = Math.max(0, Math.min(Number(before) || 0, size));
  if (end <= 0) return { raw: [], from: 0, hasMore: false, size };

  const winStart = Math.max(0, end - DETAIL_MAX_BYTES);
  const winLen = end - winStart;
  let chunk = '';
  if (winLen > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.allocUnsafe(winLen);
      const n = fs.readSync(fd, b, 0, winLen, winStart);
      chunk = b.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  let body = chunk;
  let base = winStart;
  if (winStart > 0) {
    // 从文件中间切进来的：开头那段是半行 → 丢掉
    const nl = body.indexOf('\n');
    if (nl >= 0) { base += Buffer.byteLength(body.slice(0, nl + 1), 'utf8'); body = body.slice(nl + 1); }
    else { base += winLen; body = ''; }
  }
  // 末尾那条不完整的也剔掉（正常不会发生：before 是上一批的行首偏移）
  if (body && !body.endsWith('\n')) {
    const i = body.lastIndexOf('\n');
    body = i >= 0 ? body.slice(0, i + 1) : '';
  }

  const all = body ? body.split('\n').filter(Boolean) : [];
  const raw = all.slice(-DETAIL_MAX_LINES);         // 离 before 最近的一批
  const droppedHead = all.length - raw.length;
  const from = droppedHead > 0
    ? base + Buffer.byteLength(`${all.slice(0, droppedHead).join('\n')}\n`, 'utf8')
    : base;
  return { raw, from, hasMore: from > 0, size };
}

// ── 插件入口 ─────────────────────────────────────────────────────────────

export function setup(api) {
  api_ = api;
  // 宿主注入的 app 根优先（内置模块不能靠 import.meta 反推，见文件头注释）
  if (api?.appRoot) {
    APP_ROOT = api.appRoot;
    PROJECT_ROOT = path.resolve(APP_ROOT, '..', '..');
    if (!SANDBOX_ENV) SANDBOX_ROOT = path.join(PROJECT_ROOT, SANDBOX_NAME);
  }
  cfg = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });
  log = api?.log || ((...a) => console.log('[dev-orders]', ...a));
  storeDir = path.join(DATA_DIR, 'plugin-data', 'dev-orders');
  statePath = path.join(storeDir, 'state.json');
  transcriptDir = path.join(storeDir, 'transcripts');
  historyDir = path.join(storeDir, 'sessions');
  ctxDir = path.join(storeDir, 'ctx');
  load();
  ensureSandbox();
  log(`已启动（白名单 ${state.whitelist.length} 人，项目根 ${PROJECT_ROOT}）`);
}

export const providers = {
  'dev.snapshot': ({ selected = '' } = {}) => {
    // state.sessions 是创建序（旧→新）；界面要"新的在前"，所以末尾 reverse。
    const all = state.sessions.slice();
    // ── 跨会话累计口径（2026-10-15 修：原来只有单会话 usage，跨会话总量在架构上不存在）──
    const usageTotal = all.reduce((acc, s) => {
      const u = s.usage;
      if (!u) return acc;
      acc.promptTokens += Number(u.promptTokens) || 0;
      acc.completionTokens += Number(u.completionTokens) || 0;
      acc.cachedTokens += Number(u.cachedTokens) || 0;
      acc.totalTokens += Number(u.totalTokens) || 0;
      acc.calls += Number(u.calls) || 0;
      acc.turns += Number(u.turns) || 0;
      return acc;
    }, { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0, turns: 0 });
    usageTotal.hitRate = usageTotal.promptTokens
      ? Math.min(1, usageTotal.cachedTokens / usageTotal.promptTokens) : 0;

    // ── 列表截断：界面每秒全量拉一次，payload 必须有上限 —— 只给最新 100 条 ──
    const SNAPSHOT_SESSION_CAP = 100;
    const out = all.slice(-SNAPSHOT_SESSION_CAP).reverse().map(sessionView);   // 新的在前
    // 选中兜底：选中的不在最新 100 条里 → 追加在列表**末尾**（前 100 条排序不变）。
    // 没有这段，客户端"选中项不在列表就复位"的逻辑会每秒把用户的选中清空
    // （2026-10-15 交付前自审发现的回归，已带针对性回归测试）。
    const sel = String(selected ?? '').trim();
    if (sel && !out.some((x) => x.id === sel)) {
      const hit = all.find((x) => x.id === sel);
      if (hit) out.push(sessionView(hit));
    }
    return {
      ok: true,
      projectRoot: PROJECT_ROOT,
      sandboxName: SANDBOX_NAME,
      whitelist: [...state.whitelist].sort(),
      running: running || '',
      runningSince: runningSince || 0,
      sessionsTotal: all.length,
      usageTotal,
      sessions: out
    };
  },

  'dev.whitelist-add': ({ qq } = {}) => {
    const n = normalizeQQ(qq);
    if (!/^\d{5,12}$/.test(n)) return { ok: false, error: 'QQ 号格式不对（应为 5–12 位数字）' };
    if (state.whitelist.includes(n)) return { ok: true, added: false, whitelist: [...state.whitelist].sort() };
    state.whitelist.push(n);
    save();
    log(`白名单 +${n}（现在 ${state.whitelist.length} 人）`);
    return { ok: true, added: true, whitelist: [...state.whitelist].sort() };
  },

  'dev.whitelist-remove': ({ qq } = {}) => {
    const n = normalizeQQ(qq);
    const before = state.whitelist.length;
    state.whitelist = state.whitelist.filter((x) => x !== n);
    if (state.whitelist.length !== before) {
      save();
      log(`白名单 -${n}（现在 ${state.whitelist.length} 人）`);
    }
    return { ok: true, removed: state.whitelist.length !== before, whitelist: [...state.whitelist].sort() };
  },

  /**
   * 对话视图：增量读一个会话的开发记录。
   *
   * ⚠️ from 的语义是**已读字节偏移**（不透明游标，前端原样回传 nextFrom 即可）。
   *   from=0（刚打开 / 刷新页面）→ 直接给文件**尾部**窗口：页面要的是
   *   "它现在在干什么"，而不是从第一行开始一秒 400 行地往前追。
   *   具体切窗口的规则见 readTranscriptWindow（含"半行怎么办"的说明）。
   */
  'dev.order-detail': ({ id, from = 0, before = 0 } = {}) => {
    const s = findSession(id);
    if (!s) return { ok: false, error: '会话不存在' };
    const file = transcriptPathFor(s.id);
    // before > 0 = 「载入更早」：往前翻一页（此时忽略 from，返回的那批以 before 为下界）
    const back = Number(before) > 0;
    const w = back ? readTranscriptBefore(file, before) : readTranscriptWindow(file, from);
    const lines = w.raw.map((l) => {
      try { return JSON.parse(l); } catch { return { kind: 'raw', text: String(l).slice(0, 4000) }; }
    });
    return {
      ok: true,
      id: s.id,
      session: sessionView(s),
      lines,
      from: w.from,                          // 这批第一行在文件里的字节偏移
      prevFrom: w.from,                      // 再往前翻一页就把这个原样传回 before
      nextFrom: back ? w.from : w.nextFrom,  // 增量游标（往前翻时无意义，前端不要覆盖）
      hasMore: w.hasMore                     // 前面还有更早的记录
    };
  },

  /** 本机（harness 页面）往会话里发消息（并发 kick）。 */
  'dev.send': ({ id, text } = {}) => {
    const s = findSession(id);
    if (!s) return { ok: false, error: '会话不存在' };
    const t = stripDecorations(text).slice(0, MAX_REQUIREMENT_LEN);
    if (!t) return { ok: false, error: '消息为空' };
    if (s.status === 'closed') s.status = 'active';   // 归档会话再发 = 重新激活
    s.updatedAt = Date.now();
    save();
    queueTurn(s, t, '本机');
    return { ok: true, id: s.id, queued: true };
  },

  /** 本机开新会话（并把第一句话带进去）。 */
  'dev.new-session': ({ text } = {}) => {
    const t = stripDecorations(text).slice(0, MAX_REQUIREMENT_LEN);
    const s = startNewSession({ chatKey: '', source: 'local', title: t || '本机开发会话' });
    if (!s) return { ok: false, error: '创建失败（看日志）' };
    if (t) queueTurn(s, t, '本机');
    return { ok: true, id: s.id, seq: s.seq };
  },

  'dev.reopen': ({ id } = {}) => {
    const s = findSession(id);
    if (!s) return { ok: false, error: `没有这个工单：${id}` };
    const r = reopenSession(Number(s.seq), { chatKey: s.chatKey || '' });
    return r.ok
      ? { ok: true, id: s.id, seq: s.seq, title: s.title, status: s.status, msg: r.msg }
      : { ok: false, error: r.msg };
  },

  'dev.close': ({ id } = {}) => closeSession(id),

  /**
   * 中止**正在跑**的那一轮（2026-10-08 加）。
   *
   * 为什么必须有：一轮最长可跑 turnTimeoutSec（默认 1 小时），而调度是**全局单飞** ——
   * 跑飞的那一轮不结束，**所有**会话都排队等着，界面只显示"模型正在干活…"，
   * 用户唯一的出路是等。实测报障："安排它做一个查日历写计划的插件，卡死了"。
   * 中止只是打断当前轮（模型调用/工具执行都会收到 abort），会话本身保持 active，
   * 可以接着发新指令。顺带把这轮**排队中**还没跑的消息丢掉，否则一中止马上又开始下一轮。
   */
  'dev.abort': ({ id } = {}) => {
    if (!running) return { ok: false, error: '当前没有正在跑的会话' };
    const want = String(id ?? '').trim();
    if (want && want !== running) return { ok: false, error: '只有正在跑的那个会话可以中止' };
    const target = running;
    let signaled = false;
    try { currentAbort?.abort?.(new Error('用户中止')); signaled = true; } catch { /* ignore */ }
    const queued = pendingTurns.get(target) || [];
    pendingTurns.delete(target);
    appendTranscript(target, {
      kind: 'notice', at: Date.now(),
      text: `已请求中止${queued.length ? `（同时丢弃排队中的 ${queued.length} 条）` : ''}`
    });
    log(`用户中止了会话 ${target}${signaled ? '' : '（信号未挂上，可能在收尾）'}`);
    return { ok: true, id: target, signaled, dropped: queued.length };
  },

  /**
   * 永久删除一个会话：从列表移除，并清掉开发记录（transcript）与对话历史。
   * 沙箱里已产出的文件**保留**（dev-sandbox/，用户可能还要）。开发中不可删。
   */
  'dev.delete': ({ id } = {}) => {
    const s = findSession(id);
    if (!s) return { ok: false, error: '会话不存在' };
    if (running === s.id) return { ok: false, error: '正在开发中，等这一轮跑完再删' };
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    save();
    for (const f of [transcriptPathFor(s.id), historyPathFor(s.id)]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    log(`已删除会话 ${s.id}（记录与开发记录已清；沙箱产出文件保留）`);
    return { ok: true, id: s.id };
  },

  /** 由核心在 ingest 点询问："这条消息开发模式接走吗？"（与 onMessage 同源、按 mid 去重）。 */
  'dev.route': ({ chatKey, senderId, senderName, text, mid } = {}) => ({
    handled: handleIncoming({ chatKey, senderId, senderName, text, mid })
  })
};

// ── 钩子 ─────────────────────────────────────────────────────────────────
//
// onMessage：消息入库时（app.js ingestMessage）每条都过 —— 识别 / 路由 / 记住发送通道。
// 与 dev.route 能力共用 handleIncoming（按 mid 去重），谁先谁后都只处理一次。

export const hooks = {
  async onMessage(ctx = {}) {
    try {
      handleIncoming({
        chatKey: ctx.chatKey,
        senderId: ctx.senderId,
        senderName: ctx.senderName,
        text: ctx.text,
        mid: ctx.mid ?? ctx.event?.message_id,   // 两条入口共用同一个去重键
        send: ctx.send
      });
    } catch (e) {
      log(`onMessage 处理失败：${e?.message || e}`);
    }
  }
};

// ── 提示词片段（静态文本，避免缓存漂移）──────────────────────────────────

export function promptSections() {
  try {
    return [{
      id: 'dev-orders-rule',
      title: '开发模式',
      priority: 30,
      content: '白名单成员发「开发 xxx」会开启开发模式：之后的对话由开发 agent 直接处理（模型会直接改项目文件），'
        + '相关的消息不会再交给你回复；发「结束」或「退出开发」结束。其它消息按普通规则处理即可。'
    }];
  } catch { return []; }
}

// 仅供测试断言（与 keyword-reply 的 internals 同款做法）。
export const internals = {
  extractRequirement, stripDecorations, normalizeQQ, EXIT_RE, SANDBOX_ROOT, PROJECT_ROOT, handleIncoming,
  // 记录窗口读取（增量游标 + 尾部窗口 + 往前翻页）：边界条件多，必须有真实断言
  readTranscriptWindow, readTranscriptBefore, DETAIL_MAX_BYTES, DETAIL_MAX_LINES,
  // 上下文裁剪（预算 / 落点对齐 / 最初需求保留）
  trimMessagesToBudget, isCtxNote, CTX_NOTE_PREFIX,
  // 追加式上下文（导出仅供测试：压实逻辑要有真实断言，不能只靠"看起来对"）
  loadCtx, saveCtx, CTX_MAX_CHARS, CTX_KEEP_TAIL
};
