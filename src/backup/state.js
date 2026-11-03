// 备份历史与运行状态：data/backup-state.json。
//
// 只存"界面要展示的东西"（上次跑得怎么样、最近几次的结果、每个目标写没写成），
// 不存凭据。备份包的真相在目标端（list 以目标实际内容为准），这里坏掉/被删掉
// 只影响展示，不影响功能 —— 所以读取失败时回落空状态并记警告，不阻塞任何操作。
//
// "是否正在备份"刻意不落盘：它是进程内的瞬时状态，落盘后进程若在备份途中退出
// （崩溃、被任务管理器结束），文件里会永久残留 true，界面从此一直显示"正在备份"
// 且没有任何操作能清除它。进行中状态由 index.js 的内存标记回答，进程结束即消失。
//
// 写盘走 atomic-write.js：定时备份可能与其他配置读写交错，
// 用固定名 tmp 会让双开实例互相踩。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { atomicWriteJson } from '../atomic-write.js';
import { logger } from '../logger.js';

export const BACKUP_STATE_VERSION = 1;
export const BACKUP_STATE_FILE = path.join(DATA_DIR, 'backup-state.json');
/** 历史只保留最近多少条：界面最多展示一屏，多了只是白白撑大配置文件。 */
export const MAX_HISTORY_RUNS = 50;
const activeRuns = new Map();

function emptyState() {
  return {
    version: BACKUP_STATE_VERSION,
    updatedAt: 0,
    // 最近一次运行在前，结构见 makeRun()
    history: []
  };
}

function makeRun({ trigger = 'manual', categories = [], targetIds = [], now = Date.now() } = {}) {
  return {
    id: `run-${now}-${Math.random().toString(16).slice(2, 8)}`,
    trigger: String(trigger || 'manual'),
    startedAt: now,
    finishedAt: null,
    ok: null,                 // null = 进行中
    categories: [...categories].map(String),
    targetIds: [...targetIds].map(String),
    targets: [],              // [{ id, type, key, bytes, ok, error }]
    error: ''
  };
}

/** 规整任意读入的对象：缺字段补默认，坏类型丢弃，防止历史形状漂移。 */
function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const targets = Array.isArray(raw.targets)
    ? raw.targets.filter((t) => t && typeof t === 'object').map((t) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? ''),
      key: String(t.key ?? ''),
      bytes: Number(t.bytes) || 0,
      ok: t.ok === true,
      error: t.error ? String(t.error) : ''
    }))
    : [];
  return {
    id: String(raw.id ?? ''),
    trigger: String(raw.trigger ?? 'manual'),
    startedAt: Number(raw.startedAt) || 0,
    finishedAt: Number(raw.finishedAt) || null,
    ok: raw.ok === true ? true : (raw.ok === false ? false : null),
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
    targetIds: Array.isArray(raw.targetIds) ? raw.targetIds.map(String) : [],
    targets,
    error: raw.error ? String(raw.error) : ''
  };
}

/** 读状态。文件不存在 = 从未备份过（正常）；损坏则警告并回落空状态。 */
export function readState() {
  let text = '';
  try {
    text = fs.readFileSync(BACKUP_STATE_FILE, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger.warn('backup', `备份状态读取失败（${error.message ?? error}），按空状态处理`);
    }
    return emptyState();
  }
  let parsed = null;
  try {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    parsed = JSON.parse(text);
  } catch (error) {
    // 状态文件不是用户数据：重建即可，但保留日志让"为什么历史没了"可查。
    logger.warn('backup', `备份状态文件损坏（${error.message}），按空状态处理`);
    return emptyState();
  }
  if (!parsed || typeof parsed !== 'object') return emptyState();
  const history = (Array.isArray(parsed.history) ? parsed.history : [])
    .map(normalizeRun)
    .filter(Boolean)
    .slice(0, MAX_HISTORY_RUNS);
  // 只有本进程登记的记录才可能仍在运行；崩溃遗留的 null 必须显示为中断。
  for (const run of history) {
    if (run.ok === null && !activeRuns.has(run.id)) {
      run.ok = false;
      run.finishedAt = Number(parsed.updatedAt) || run.startedAt;
      run.error = '上次备份在完成前中断，目标结果未知';
    }
  }
  return {
    version: BACKUP_STATE_VERSION,
    updatedAt: Number(parsed.updatedAt) || 0,
    history
  };
}

/** 写状态（原子）。失败抛原始错误，由调用方决定是否降级。 */
export function writeState(state) {
  const next = {
    version: BACKUP_STATE_VERSION,
    updatedAt: Date.now(),
    history: (Array.isArray(state?.history) ? state.history : []).map(normalizeRun).filter(Boolean).slice(0, MAX_HISTORY_RUNS)
  };
  atomicWriteJson(BACKUP_STATE_FILE, next);
  return next;
}

/** 开始一次运行：写一条 ok=null 的记录。返回 run 对象（含 id）。 */
export function markRunStarted(opts = {}) {
  const state = readState();
  const run = makeRun(opts);
  activeRuns.set(run.id, run);
  state.history = [run, ...state.history].slice(0, MAX_HISTORY_RUNS);
  try {
    writeState(state);
  } catch (error) {
    // 记录失败不该阻止备份本身：历史只是展示层。
    logger.warn('backup', `备份状态写入失败（${error?.message ?? error}），本次运行不记入历史`);
  }
  return run;
}

/**
 * 结束一次运行。
 * @param {string} runId
 * @param {{ok:boolean, targets?:Array, error?:string}} result
 */
export function markRunFinished(runId, { ok = false, targets = [], error = '' } = {}) {
  const state = readState();
  const idx = state.history.findIndex((r) => r.id === runId);
  const patch = {
    finishedAt: Date.now(),
    ok: ok === true,
    targets: Array.isArray(targets) ? targets : [],
    error: error ? String(error) : ''
  };
  if (idx >= 0) state.history[idx] = normalizeRun({ ...state.history[idx], ...patch });
  else state.history.unshift(normalizeRun({ ...(activeRuns.get(runId) || makeRun()), id: String(runId), ...patch }));
  activeRuns.delete(runId);
  try {
    writeState(state);
  } catch (writeError) {
    logger.warn('backup', `备份状态写入失败（${writeError?.message ?? writeError}）`);
  }
  return state.history[idx >= 0 ? idx : 0];
}

export function getLastRun() {
  return readState().history[0] || null;
}

export function listRuns(limit = MAX_HISTORY_RUNS) {
  const n = Math.max(1, Number(limit) || MAX_HISTORY_RUNS);
  return readState().history.slice(0, n);
}

/** 只给测试/重建用：清空历史。 */
export function resetState() {
  return writeState(emptyState());
}

export default {
  BACKUP_STATE_VERSION,
  BACKUP_STATE_FILE,
  MAX_HISTORY_RUNS,
  readState,
  writeState,
  markRunStarted,
  markRunFinished,
  getLastRun,
  listRuns,
  resetState
};
