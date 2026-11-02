// 匿名用量遥测：周期性把"调用次数 + token 用量"快照发到 kondius.cn，供官网做总览统计。
//
// 隐私红线：payload 只有 随机 installId + 版本号 + 四个计数器。
//   不含 QQ 号、群号、昵称、聊天内容、机器信息、IP（IP 只在服务器内存里做限流，不落库）。
// 去重原理：服务器按 installId 覆盖式 upsert —— 同一客户端无论发多少次都只算一份，
//   彻底避免"一个用户的客户端发送多份"。覆盖安装/重装系统后 data 目录还在 → installId 不变。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ROOT } from './config.js';

const REPORT_URL = 'https://kondius.cn/qq-agent/api/telemetry';
const INTERVAL_MS = 6 * 3600 * 1000;   // 之后每 6 小时一次
const FIRST_DELAY_MS = 90 * 1000;      // 启动 90 秒后发第一次（避开启动高峰）

const ID_FILE = path.join(DATA_DIR, 'telemetry.json');
const TOTALS_FILE = path.join(DATA_DIR, 'telemetry-totals.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

/** 一个会话里的 LLM 调用次数（与用量页同口径：带 token 用量的 raw 条目数）。 */
function countLlmCalls(s) {
  let n = 0;
  for (const m of (s?.messages || [])) {
    const ru = m?.raw?.usage || {};
    if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) n += 1;
  }
  return n;
}

/**
 * 读累计总量；文件不存在（老用户升级后首次上报）就从历史会话文件重建一次。
 * 重建结果写回文件，之后的会话结束累加（sessions.js）会接着这个基数走。
 */
function loadTotals() {
  try { return JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8')); } catch { /* 需要重建 */ }
  const t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };

  // 优先走会话索引缓存（2026-10-07 改）。
  //
  // 原实现是**全量重扫 sessions/**：readdirSync + 逐个 readFileSync + JSON.parse。
  // 实测当前 data/sessions 已是 185MB / 1963 个文件 —— sessions.js 自己的注释就写着
  // "2277 个文件 / 178MB 要 25 秒"。而 loadTotals() 是在 report() 的 setTimeout
  // 回调里跑的，也就是**同步阻塞主线程 20+ 秒**，期间界面完全无响应。
  //
  // session-index-cache.json（v2）里已经包含每条会话的 usage 与 toolCalls 摘要 ——
  // 这正是为此准备的，不需要读全文。它不可用时（老版本缓存 / 损坏）才回退到全量重扫。
  const fromIndex = loadTotalsFromIndex();
  if (fromIndex) {
    try { fs.writeFileSync(TOTALS_FILE, JSON.stringify(fromIndex), 'utf8'); } catch { /* 下次再试 */ }
    return fromIndex;
  }

  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.json'))) {
      let s;
      try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
      const u = s.usage || {};
      t.calls += countLlmCalls(s);
      t.promptTokens += Number(u.promptTokens) || 0;
      t.completionTokens += Number(u.completionTokens) || 0;
      t.totalTokens += Number(u.totalTokens) || 0;
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
    }
  } catch { /* 目录都没有 */ }
  if (!t.calls) return null;
  try { fs.writeFileSync(TOTALS_FILE, JSON.stringify(t), 'utf8'); } catch { /* 下次再试 */ }
  return t;
}

/**
 * 从会话索引缓存重建累计量（快路径）。
 * 索引里的 usage 是 {calls, promptTokens, ...}，其中 calls 就是 LLM 调用次数
 * （sessions.js #summary 存的就是 session.usage），所以不需要重数 messages。
 * @returns {object|null} 索引不可用时返回 null，由调用方回退到全量重扫
 */
function loadTotalsFromIndex() {
  let idx;
  try {
    idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'session-index-cache.json'), 'utf8'));
  } catch { return null; }
  // 版本必须是 2：v1 的摘要里没有 toolCalls，用它会漏统计。
  // 也不能是 3+：将来摘要结构变了，这里的算法需要同步更新，宁可回退重扫。
  if (idx?.version !== 2 || !Array.isArray(idx.entries) || !idx.entries.length) return null;
  const t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
  for (const e of idx.entries) {
    const u = e?.usage || {};
    t.calls += Number(u.calls) || 0;
    t.promptTokens += Number(u.promptTokens) || 0;
    t.completionTokens += Number(u.completionTokens) || 0;
    t.totalTokens += Number(u.totalTokens) || 0;
    // 索引只存了工具调用**次数**，没存名字明细 → 这一项无法从索引还原。
    // 匿名遥测只上报 calls / prompt / completion / total 四个总数
    // （见文件头声明的 payload），toolCounts 不在 payload 里，
    // 所以缺它不影响上报口径，也就不该为此退回慢路径。
  }
  return t.calls ? t : null;
}

/** 匿名安装 ID：随机 UUID，首次运行时生成并持久化，重装/覆盖安装不丢。 */
function installId() {
  try {
    const d = JSON.parse(fs.readFileSync(ID_FILE, 'utf8'));
    if (d?.installId) return String(d.installId);
  } catch { /* 首次运行 */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ID_FILE, JSON.stringify({ installId: id, createdAt: Date.now() }), 'utf8');
  } catch { /* 写失败就下次再试 */ }
  return id;
}

function appVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch { return ''; }
}

export async function report(log) {
  const totals = loadTotals();   // 没有用量（含重建后仍为空）就不报
  if (!totals || !Number(totals.calls)) return;
  // 工具调用明细：只留 [a-z0-9_] 形态的键、整数次数，最多 50 个键
  const toolCounts = {};
  for (const [k, v] of Object.entries(totals.toolCounts || {})) {
    const key = String(k).slice(0, 40);
    const n = Math.max(0, Number(v) | 0);
    if (/^[\w-]+$/.test(key) && n > 0 && Object.keys(toolCounts).length < 50) toolCounts[key] = n;
  }
  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: installId(),
        version: appVersion(),
        calls: Math.max(0, Number(totals.calls) || 0),
        inputTokens: Math.max(0, Number(totals.promptTokens) || 0),
        outputTokens: Math.max(0, Number(totals.completionTokens) || 0),
        totalTokens: Math.max(0, Number(totals.totalTokens) || 0),
        tools: toolCounts
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) log(`[遥测] 上报返回 HTTP ${res.status}（不影响使用）`);
  } catch (e) {
    log(`[遥测] 上报失败（不影响使用）: ${e?.message ?? e}`);
  }
}

let firstTimer = null;
let loopTimer = null;

export function startTelemetryLoop(log = console.log) {
  const first = setTimeout(() => {
    report(log);
    loopTimer = setInterval(() => report(log), INTERVAL_MS);
    loopTimer.unref?.();
  }, FIRST_DELAY_MS);
  first.unref?.();
  firstTimer = first;
}

/** 停止遥测（app.stop() 调用）：清掉首发与循环定时器，退出后不再有网络请求。 */
export function stopTelemetryLoop() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}
