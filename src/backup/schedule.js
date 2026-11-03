import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { isBackupKey } from './archive.js';

const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_RETENTION = 7;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const CONFIG_CHECK_MS = 60 * 1000;
const MIN_INTERVAL_MS = 1000;

function warn(log, message) {
  // 日志写入失败也不能把定时回调变成未处理异常。
  try { log.warn('backup', message); } catch { /* 退出/磁盘故障时日志可能不可写。 */ }
}

/** mtime 取决于存储端时钟，只有自有 key 中的时间戳能跨目标保持一致。 */
export async function applyRetention(target, retention = DEFAULT_RETENTION, label = '') {
  const count = Number(retention);
  const keep = Number.isInteger(count) && count > 0 ? count : DEFAULT_RETENTION;
  let entries;
  try {
    entries = (await target.list()).filter((entry) => isBackupKey(entry.key));
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  } catch (error) {
    warn(logger, `保留策略读取目标列表失败（${label || target.type}）：${error?.message ?? error}`);
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      await target.remove(entry.key);
      removed += 1;
    } catch (error) {
      warn(logger, `清理旧备份失败（${label || target.type} / ${entry.key}）：${error?.message ?? error}`);
    }
  }
  return { removed, kept: entries.length - removed };
}

/** 注入时钟使测试无需等待真实小时；每轮结束重新读配置，避免间隔被启动快照锁住。 */
export function createScheduler({ setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout, now = () => performance.now() } = {}) {
  let handlers = null;
  let timer = null;
  let generation = 0;
  let running = false;
  let inFlight = null;

  function runNow() {
    if (inFlight) return inFlight;
    const current = handlers;
    inFlight = Promise.resolve().then(async () => {
      if (!current) return { ok: false, error: '备份调度器尚未启动' };
      try {
        const result = await current.runBackup({ trigger: 'scheduled' });
        if (result?.ok === false) warn(current.logger, `定时备份失败：${result.error || '目标写入失败'}`);
        return result;
      } catch (error) {
        warn(current.logger, `定时备份异常：${error?.message ?? error}`);
        return { ok: false, error: String(error?.message ?? error) };
      }
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function arm(token) {
    if (!running || token !== generation) return;
    const started = now();
    const interval = () => {
      let hours = DEFAULT_INTERVAL_HOURS;
      try {
        const configured = Number(handlers.getConfig()?.backup?.intervalHours);
        if (Number.isFinite(configured) && configured > 0) hours = configured;
      } catch (error) {
        warn(handlers.logger, `读取备份间隔失败：${error?.message ?? error}`);
      }
      return Math.max(MIN_INTERVAL_MS, Math.min(hours * HOUR_MS, Number.MAX_SAFE_INTEGER));
    };
    const wait = () => {
      // 用单调时钟测量实际经过的时间；休眠后只补跑一次，系统校时不制造补跑风暴。
      // 最多一分钟重读配置，缩短间隔时也无需等完启动时的旧间隔。
      const delay = Math.max(0, Math.min(interval() - (now() - started), CONFIG_CHECK_MS, MAX_TIMEOUT_MS));
      timer = setTimer(() => {
        timer = null;
        if (!running || token !== generation) return;
        if (now() - started < interval()) { wait(); return; }
        // 和 diskPatrolTimer 一样，外部故障必须封在定时回调内，不能退出主进程。
        Promise.resolve().then(() => {
          if (!running || token !== generation) return;
          if (handlers.getConfig()?.backup?.enabled === true) return runNow();
        }).catch((error) => {
          warn(handlers.logger, `备份调度异常：${error?.message ?? error}`);
        }).finally(() => { arm(token); });
      }, delay);
      timer?.unref?.();
    };
    wait();
  }

  function stop() {
    running = false;
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function start(nextHandlers) {
    if (typeof nextHandlers?.runBackup !== 'function') throw new TypeError('需要 runBackup 回调');
    stop();
    handlers = { getConfig, logger, ...nextHandlers };
    running = true;
    arm(generation);
  }

  return { start, stop, runNow };
}

export const { start, stop, runNow } = createScheduler();
