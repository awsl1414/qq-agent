// 用量账本（append-only）：会话文件的用量流水，会话文件被删也不丢。
//
// ── 为什么需要它 ──────────────────────────────────────────────────
// 用量统计原本**完全依赖 data/sessions/*.json**：src/app.js 的 parseUsageSessionFile
// 逐个读会话文件、展开每条 message.raw.usage 计价。而会话文件是可裁剪的
// （config.json 的 store.keepSessionFiles，实测配了 120），finish() 与
// #pruneFiles() 都会 unlink 旧文件。
//
// 于是产生了一个非常隐蔽的 bug（用户报"用量估算根本不更新"）：
//   裁剪掉的会话，其用量**永久消失**，统计数字被冻结在"最近 N 个会话"上。
//   实测：今日真实 813 次 / 1900 万 token，磁盘只剩 121 个会话文件，
//   统计只能读到 131 次 / 296 万 —— **84% 的数据静默丢失**。
//
// 而且越用越糟：文件越新覆盖的时间窗越短，"近 7 天"在文件被裁完的瞬间
// 也会跟着塌成"最近 120 次"。缓存、快照全是加速手段，救不了源头没有数据。
//
// ── 设计取舍 ──────────────────────────────────────────────────────
// ① 追加写、不改写：每条记录一行 JSON（NDJSON），崩了最多丢最后一行，
//    不会像整份 JSON 覆盖写那样把整个文件写坏。
// ② 按日分文件：data/usage-ledger/YYYY-MM-DD.ndjson。统计天然按天聚合，
//    读历史日不需要扫全量；单文件也不会无限膨胀到难以解析。
// ③ 与会话文件**互补而非替代**：会话文件仍在提供逐次调用的明细行
//    （精确到每次 LLM 调用的时间/模型，用于峰谷拆分与下钻）。
//    账本提供的是"这条会话总共花了多少"的日汇总。
// ④ 去重：会话文件里能读到的会话，账本里那条不算 —— 否则重复计费。
//    见 src/app.js 的 usageLedgerTotals()。
//
// ── 一致性 ────────────────────────────────────────────────────────
// 账本与 usage-today.json 是同一时刻（#persist 落盘时）写的，两者口径一致。
// 唯一例外是 retriedUsage（重试归档的 token），#bumpTodayUsage 会并进
// usage-today，本模块也一并并入，保证两边数字能对上。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LEDGER_DIR = path.join(DATA_DIR, 'usage-ledger');
// 日键 YYYY-MM-DD（本地时区，与 usage-today.json / app.js 的 dayKeyOf 同口径）
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区日键。 */
export function ledgerDayKey(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 从会话对象里抽出一条账本记录。
 *
 * 抽不出来（非零消耗为零的等待/中止会话）返回 null —— 与 #bumpTodayUsage
 * 的零消耗过滤保持一致，否则两处口径会打架。
 *
 * @param {object} s 会话对象（结构同 data/sessions/<id>.json）
 */

/**
 * 从会话消息里统计各工具被调用的次数。
 *
 * 口径必须与 app.js 的 parseUsageSessionFile 严格一致（逐条 message.toolCall.name
 * 计数），否则"账本补回的那部分"和"会话文件读到的那部分"会打架。
 *
 * ── 为什么账本要记这个（2026-10-19）──────────────────────────────
 * 用量页的「调用明细」弹窗原本**只从会话文件**读 toolCounts。会话文件被
 * keepSessionFiles（默认 120）裁掉后，明细就只剩"最近 120 个会话"——
 * 实测 120 个文件只覆盖 5 小时，弹窗显示"近 7 天共 157 次"，而单日账本里
 * 就有 1073 次调用。token/成本那半边早有账本兜底，唯独工具计数漏了。
 *
 * ── 体积 ────────────────────────────────────────────────────────
 * 一个会话通常 2~10 次工具调用，序列化后约 +60~120B/行。按每天 900 会话算，
 * 账本每天多约 100KB；配合 LEDGER_KEEP_DAYS(730) 两年上限约 250MB ——
 * 与"会话文件不裁剪会涨到 26GB/年"完全不是一个量级，所以**不需要**为了
 * 省磁盘去调大 keepSessionFiles。
 */
function toolCountsOf(s) {
  const counts = Object.create(null);
  const msgs = Array.isArray(s?.messages) ? s.messages : [];
  for (const m of msgs) {
    const raw = m && m.toolCall && m.toolCall.name;
    if (!raw) continue;
    // 防御：异常长的名字（插件工具 id 可能拼得很长）截断后再进账本，
    // 避免单行膨胀；正常工具名都在 64 字符以内。
    const name = String(raw).slice(0, 64);
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

export function ledgerRecordOf(s) {
  if (!s) return null;
  const archived = s.retriedUsage || null;   // 重试归档：那笔钱真花了
  const promptTokens = (Number(s.usage?.promptTokens) || 0) + (Number(archived?.promptTokens) || 0);
  const completionTokens = (Number(s.usage?.completionTokens) || 0) + (Number(archived?.completionTokens) || 0);
  const cachedTokens = (Number(s.usage?.cachedTokens) || 0) + (Number(archived?.cachedTokens) || 0);
  const calls = (Number(s.usage?.calls) || 0) + (Number(archived?.calls) || 0);
  const totalTokens = (Number(s.usage?.totalTokens) || 0) + (Number(archived?.totalTokens) || 0);
  if (calls === 0 && totalTokens === 0) return null;

  // dayKey 用**结束**时间（与 #bumpTodayUsage 同一理由：跨零点会话若用
  // startedAt，dayKey 会被打回昨天，导致今天这条记到昨天账上）
  const endedAt = Number(s.endedAt) || Date.now();
  return {
    id: String(s.id || ''),
    day: ledgerDayKey(endedAt),
    startedAt: Number(s.startedAt) || endedAt,
    endedAt,
    chatKey: String(s.chatKey || '(未知)'),
    model: String(s.model || ''),
    vendor: String(s.vendor || ''),
    calls,
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || (promptTokens + completionTokens),
    cachedTokens,
    webSearchCount: Number(s.webSearchCount) || 0,
    // 工具调用次数（2026-10-19）：账本自本条起成为"调用明细"的第二数据源。
    // 老账本行没有这个字段 → 读取方一律 `r.toolCounts || {}`，天然向后兼容。
    toolCounts: toolCountsOf(s),
  };
}

/** 追加失败是否已提示过（只提示一次，避免刷屏）。 */
let appendLedgerWarned = false;

/**
 * 追加一条账本记录（每会话一行，**按 id 幂等**）。
 *
 * 与会话文件落盘在同一个 #persist 里调用，所以两者口径严格一致 ——
 * 不会出现"账本有、会话文件没有"或反之的偏差。
 *
 * 幂等是硬要求（2026-10-17）：`usageLedgerTotals()` 不去重，重复行会双倍计费；
 * 同时 `clearFinished()` 也会在删会话文件前调本函数做兜底，必须可重复执行。
 *
 * 失败绝不能影响主流程：账本只是兜底，会话文件才是主数据源。
 */
export function appendUsageLedger(s) {
  try {
    const rec = ledgerRecordOf(s);
    if (!rec) return;
    // ⚠️（2026-10-17 N8）**必须按会话 id 幂等** —— 同一个会话一生只该有一行账本。
    //    两个理由：
    //    ① `usageLedgerTotals()` 是**纯累加、不去重**（`runs += 1` 无条件执行），
    //       同一 id 写两行 = 双倍计费。而 `#persist` 有 finish() 与 update() 两条
    //       调用路径，会话进入结束态后再落一次盘，旧实现就会追加第二行。
    //    ② `clearFinished()` 删会话文件前要做"补账本兜底"（见 sessions.js），
    //       这个动作必须能重复执行而不叠加。
    //    代价：每次会话结束多读一次当天账本。实测单行 ~267B、一天几百行 ≈ 200KB，
    //    与同一次 #persist 里同步重写整个会话 JSON（含全部 messages）相比可以忽略。
    //    `|| []` 是双保险：readUsageLedgerDay 的契约就是"读不到给空数组"，
    //    写死在这里，避免它将来又退回 undefined 时把整条账本链路静默搞死。
    for (const r of readUsageLedgerDay(rec.day) || []) {
      if (r && String(r.id) === rec.id) return;      // 已入账 → 不重复写
    }
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const file = path.join(LEDGER_DIR, `${rec.day}.ndjson`);
    const isNewDay = !fs.existsSync(file);
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
    // 跨天第一次写入时顺手清理一次过期账本（每天至多一次，开销可忽略）
    if (isNewDay) pruneUsageLedger();
  } catch (err) {
    // 账本是兜底，失败不能影响会话保存 —— 但**绝不能完全静默**。
    // 2026-10-17 实测教训：本函数里任何一个 TypeError（当时是 readUsageLedgerDay
    // 返回 undefined 引发的 `for...of` 报错）都会走到这里被吞掉，现象是
    // "data/usage-ledger/ 一直是空的，而任何地方都没有线索"，排查成本极高。
    // 只在首次失败时打一条（避免每条会话结束都刷日志），且照样不抛出。
    if (!appendLedgerWarned) {
      appendLedgerWarned = true;
      console.error('[usage-ledger] 追加账本失败（此提示只出现一次）:', err?.message ?? err);
    }
  }
}

/** 某一天的账本记录数组（跳过坏行，不让一行脏数据毁掉一整天）。 */
export function readUsageLedgerDay(dayKey) {
  if (!DAY_RE.test(String(dayKey || ''))) return [];
  try {
    const text = fs.readFileSync(path.join(LEDGER_DIR, `${dayKey}.ndjson`), 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (r && typeof r === 'object' && r.day === dayKey) out.push(r);
      } catch { /* 坏行跳过（可能是崩溃时截断的半行） */ }
    }
    return out;
  } catch { /* 该日没有账本 = 那天没用量（或还没落盘） */ }
  // ⚠️（2026-10-17）**必须显式返回空数组**。原先 catch 之后没有 return，
  //    函数在"文件不存在"时返回 undefined —— 调用方一旦 `for (const r of ...)`
  //    就抛 TypeError。而 appendUsageLedger 恰好把整段包在 try/catch 里静默吞错，
  //    于是表现为"账本一条也写不进去、却毫无报错"（实测踩到：加幂等检查后
  //    首次调用即整个账本链路失效）。此前的唯一调用方 usageLedgerTotals 先用
  //    listUsageLedgerDays() 过滤了存在的文件，所以一直没暴露。
  return [];
}

/** 账本里存在记录的所有日（升序）。 */
export function listUsageLedgerDays() {
  try {
    return fs.readdirSync(LEDGER_DIR)
      .filter((f) => f.endsWith('.ndjson') && DAY_RE.test(f.slice(0, 10)))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch { return []; }
}

// 账本保留天数。实测单行 ~267B、按每天 843 次会话计约 220KB/天，
// 一年 78MB —— 不清理也能跑，但没必要永远留着。两年的日文件足够覆盖
// 任何"回看用量"的需求，真要更早可以删（删掉后那一段就回到"无数据"，
// 但那是用户自己主动删的，不算静默丢失）。
const LEDGER_KEEP_DAYS = 730;

/**
 * 清理超出保留期的账本日文件。返回删除的文件数。
 *
 * 每天首次写入时顺带调用（不单独起定时任务）。
 */
export function pruneUsageLedger() {
  try {
    const days = listUsageLedgerDays();
    if (days.length <= LEDGER_KEEP_DAYS) return 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LEDGER_KEEP_DAYS);
    const cutoffKey = ledgerDayKey(cutoff.getTime());
    let removed = 0;
    for (const dayKey of days) {
      if (dayKey >= cutoffKey) continue;
      try { fs.rmSync(path.join(LEDGER_DIR, `${dayKey}.ndjson`), { force: true }); removed++; } catch { /* ignore */ }
    }
    return removed;
  } catch { return 0; }
}

/**
 * 汇总一段日期范围内的账本，返回 { days: Map<dayKey, 汇总>, byId: Set<会话id> }。
 *
 * byId 让调用方能**扣掉**"会话文件还在的那些" —— 那些数据已由
 * parseUsageSessionFile 精确统计过，账本再算一遍就是重复计费。
 *
 * @param {(dayKey: string) => boolean} includeDay 判断某日是否落在范围内
 */
export function usageLedgerTotals(includeDay) {
  const days = new Map();
  const byId = new Set();
  for (const dayKey of listUsageLedgerDays()) {
    if (typeof includeDay === 'function' && !includeDay(dayKey)) continue;
    const rows = readUsageLedgerDay(dayKey);
    if (!rows.length) continue;
    let runs = 0, calls = 0, promptTokens = 0, completionTokens = 0, totalTokens = 0, cachedTokens = 0, webSearchCount = 0;
    const toolCounts = Object.create(null);
    for (const r of rows) {
      runs += 1;
      calls += Number(r.calls) || 0;
      promptTokens += Number(r.promptTokens) || 0;
      completionTokens += Number(r.completionTokens) || 0;
      totalTokens += Number(r.totalTokens) || 0;
      cachedTokens += Number(r.cachedTokens) || 0;
      webSearchCount += Number(r.webSearchCount) || 0;
      // 工具计数同样累加（老行没有 toolCounts → 跳过，不影响其它字段）
      if (r.toolCounts && typeof r.toolCounts === 'object') {
        for (const [name, n] of Object.entries(r.toolCounts)) {
          const c = Number(n) || 0;
          if (c > 0) toolCounts[name] = (toolCounts[name] || 0) + c;
        }
      }
      if (r.id) byId.add(String(r.id));
    }
    days.set(dayKey, {
      runs, calls, promptTokens, completionTokens, totalTokens, cachedTokens, webSearchCount, toolCounts,
    });
  }
  return { days, byId };
}

/**
 * 某一天的账本记录中"会话文件已不在磁盘上"的那些。
 *
 * 这些正是被 store.keepSessionFiles 裁掉的会话 —— 统计时必须逐条补回，
 * 否则用量页会被冻结在"最近 N 个会话文件"上。用户报的现象是：
 * "今日 200 次运行，页面只算 120 次"（默认 keepSessionFiles=120）。
 *
 * @param {string} dayKey 'YYYY-MM-DD'
 * @param {Set<string>|Iterable<string>} onDiskIds 磁盘上仍存在的会话 id 集合
 * @returns {object[]} 被裁掉的会话的账本记录（保持行序）
 */
export function usageLedgerPrunedRecords(dayKey, onDiskIds) {
  const rows = readUsageLedgerDay(dayKey);
  if (!rows.length) return [];
  const disk = onDiskIds instanceof Set ? onDiskIds : new Set([...(onDiskIds || [])].map(String));
  return rows.filter((r) => r && r.id && !disk.has(String(r.id)));
}
