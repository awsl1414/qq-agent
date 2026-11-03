// 数据备份与恢复：对外 API。
//
// 调用链：
//   runBackup   archive.buildBackup（一次构建，多目标共用）→ target.put → 保留策略
//   runRestore  target.get → archive.parseBackup（sha256 校验）→ 临时解包
//               → migrate.applyImport（唯一的落地路径）→ 丢弃临时区
//
// 为什么一次构建多目标共用：同一轮所有目标写的是同一份内容，逐目标重建会
// 让每个目标的包都有不同的 sha256 与时间戳，目标之间无法互相校验，也白白多读一遍盘。
//
// 恢复绝不直接覆盖文件：备份包的 data/ 结构等同另一个实例的 data 目录，
// 直接交给 migrate.applyImport，合并/去重/导入前备份/回滚全部沿用既有逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, getConfig } from '../config.js';
import { logger } from '../logger.js';
import { applyImport, scanSource } from '../migrate.js';
import { encryptPayload, decryptPayload } from './crypto.js';
import { parseZip } from '../zip-install.js';
import {
  buildBackup, parseBackup, extractEntries, listBackupCategories, isBackupKey
} from './archive.js';
import { createTarget } from './targets/index.js';
import { applyRetention } from './schedule.js';
import {
  readState, listRuns, getLastRun, markRunStarted, markRunFinished
} from './state.js';

const RESTORE_ROOT = path.join(DATA_DIR, 'backup-restore');
const RESTORE_MAX_FILES = 20000;
const RESTORE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const RESTORE_ZIP_LIMITS = { maxFiles: RESTORE_MAX_FILES, maxTotal: RESTORE_MAX_TOTAL_BYTES };
export const DEFAULT_RETENTION = 7;

// 恢复是"下载 + 解包 + 合并写盘"的长流程，与 migrate.applyImport 的并发闸同一理由：
// 并发两次会把两份导入的备份目录与缓存回填互相交错。
let restoreInFlight = false;
let backupInFlight = false;
let backupTask = null;
let restoreTask = null;
let operationsStopped = false;

function backupConfig() {
  return getConfig()?.backup || {};
}

/** 配置里的目标项（含类型/启用状态）。缺 id 的项给一个稳定兜底名，便于展示。 */
function configuredTargets() {
  const list = Array.isArray(backupConfig().targets) ? backupConfig().targets : [];
  return list
    .filter((t) => t && typeof t === 'object' && String(t.type || '').trim())
    .map((t, i) => ({ ...t, id: String(t.id || `t${i + 1}`) }));
}

function findTargetEntry(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return configuredTargets().find((t) => t.id === key) || null;
}

function appVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch { return ''; }
}

/**
 * 实例标识：沿用遥测的随机 installId（data/telemetry.json）。
 * 只读不建 —— 备份功能不该因为自己没备份过而抢先创建凭据类文件。
 */
function instanceId() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'telemetry.json'), 'utf8'));
    return String(d?.installId || '');
  } catch {
    // 文件不存在/损坏都只影响清单里的展示字段，返回空串即可。
    return '';
  }
}

/**
 * 立即执行一次备份。
 *
 * @param {{trigger?:string, targetIds?:string[], categories?:string[], now?:Date}} opts
 *   targetIds 省略 = 所有 enabled 的目标。
 *   categories 省略 = 这些目标 categories 的并集。包是整体的，做不到"每类只写给
 *   勾了它的目标"，所以按并集构建一份包、所有目标共用同一份内容。
 * @returns {Promise<{ok:boolean, runId:string, key?:string, bytes?:number,
 *                    targets:Array<{id,type,ok,key?,bytes?,error?}>, error?:string}>}
 */
export async function runBackup({ trigger = 'manual', targetIds = null, categories = null, now = new Date() } = {}, { encryptPayload: encryptData = encryptPayload } = {}) {
  if (operationsStopped) return { ok: false, runId: '', targets: [], error: '应用正在停止，无法开始备份' };
  if (backupInFlight || restoreInFlight) return { ok: false, runId: '', targets: [], error: '已有一个备份或恢复正在进行，请等它完成' };
  backupInFlight = true;
  try {
    backupTask = runBackupInner({ trigger, targetIds, categories, now, encryptData });
    return await backupTask;
  } finally {
    backupInFlight = false;
    backupTask = null;
  }
}

export function startBackupOperations() {
  operationsStopped = false;
}

/** 停机先拒绝新操作，等上传、恢复和历史收尾，再释放实例锁与热生效回调。 */
export async function stopBackupOperations() {
  operationsStopped = true;
  await Promise.allSettled([backupTask, restoreTask]);
}

async function runBackupInner({ trigger, targetIds, categories, now, encryptData }) {
  const cfg = backupConfig();
  const wanted = new Set(
    (Array.isArray(targetIds) ? targetIds : configuredTargets()
      .filter((t) => t.enabled === true)
      .map((t) => t.id)).map(String)
  );
  const targets = configuredTargets().filter((t) => wanted.has(t.id));
  if (!targets.length) {
    return { ok: false, runId: '', targets: [], error: '没有启用的备份目标' };
  }

  // 类别：显式指定 > 所有目标 categories 的并集 > 全部可用类别。
  // 用并集而不是逐目标构建，是因为包内容一旦不同，目标之间就无法互相比对/取最新。
  let cats = Array.isArray(categories) && categories.length ? categories : null;
  if (!cats) {
    const union = new Set();
    for (const t of targets) {
      for (const c of Array.isArray(t.categories) ? t.categories : []) union.add(String(c));
    }
    cats = union.size ? [...union] : listBackupCategories().map((c) => c.key);
  }

  const run = markRunStarted({
    trigger,
    categories: cats,
    targetIds: targets.map((t) => t.id),
    now: now.getTime()
  });
  const results = [];
  try {
    const includeSecrets = cfg.includeSecrets === true;
    const built = buildBackup({ categories: cats, appVersion: appVersion(), instanceId: instanceId(), now, includeSecrets, encrypt: includeSecrets }, { encryptPayload: encryptData });
    if (!built.ok) {
      markRunFinished(run.id, { ok: false, error: built.error });
      return { ok: false, runId: run.id, targets: [], error: built.error, skippedCategories: built.skippedCategories };
    }

    for (const entry of targets) {
      const row = { id: entry.id, type: String(entry.type), key: built.key, bytes: built.bytes, ok: false, error: '' };
      let target = null;
      try {
        target = createTarget(entry);
        await target.put(built.key, built.buffer);
        row.ok = true;
      } catch (error) {
        row.error = String(error?.message ?? error);
        logger.warn('backup', `备份目标 ${entry.id}（${entry.type}）写入失败：${row.error}`);
      }
      if (row.ok) {
        const retention = entry.retention ?? cfg.retention ?? DEFAULT_RETENTION;
        const r = await applyRetention(target, retention, entry.id);
        if (r.removed) logger.info('backup', `目标 ${entry.id} 清理旧备份 ${r.removed} 个（保留 ${retention} 个）`);
      }
      results.push(row);
    }

    // 一份副本成功即有可恢复的备份；部分失败由 targets 保留逐目标结果。
    const ok = results.some((r) => r.ok);
    const error = ok ? '' : results.map((row) => `${row.id}：${row.error || '写入失败'}`).join('；');
    markRunFinished(run.id, { ok, targets: results, error });
    logger.info('backup', `备份完成（${trigger}）：${built.key}，${results.filter((r) => r.ok).length}/${results.length} 个目标成功`);
    return { ok, runId: run.id, key: built.key, bytes: built.bytes, manifest: built.manifest, targets: results, skippedCategories: built.skippedCategories, ...(error ? { error } : {}) };
  } catch (error) {
    const msg = String(error?.message ?? error);
    markRunFinished(run.id, { ok: false, targets: results, error: msg });
    logger.error('backup', `备份失败：${msg}`);
    return { ok: false, runId: run.id, targets: results, error: msg };
  }
}

/** 预览、恢复与详情检查共用外层校验和解密入口。 */
function parseRestoreBackup(buffer) {
  const parsed = parseBackup(buffer);
  if (!parsed.ok || parsed.manifest.encrypted !== true) return parsed;
  try {
    const plainEntries = parseZip(decryptPayload(parsed.ciphertext), RESTORE_ZIP_LIMITS);
    if (plainEntries.some((e) => e.name === 'manifest.json')) {
      return { ok: false, error: '加密载荷不能包含重复 manifest.json' };
    }
    return { ...parsed, entries: plainEntries };
  } catch {
    return { ok: false, error: '备份包已损坏、被篡改，或来自另一台机器（加密密钥绑定本机实例，换机后无法解密）' };
  }
}

async function withRestoreSource({ targetId, key }, action) {
  let extractDir = '';
  try {
    const entry = findTargetEntry(targetId);
    if (!entry) return { ok: false, error: `找不到备份目标：${targetId}` };
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: '缺少备份文件 key' };
    let buffer;
    try { buffer = await createTarget(entry).get(k); }
    catch (error) { return { ok: false, error: `下载备份失败：${error?.message ?? error}` }; }
    const parsed = parseRestoreBackup(buffer);
    if (!parsed.ok) return parsed;
    fs.mkdirSync(RESTORE_ROOT, { recursive: true });
    extractDir = fs.mkdtempSync(path.join(RESTORE_ROOT, 'restore-'));
    const extracted = extractEntries(parsed.entries, extractDir);
    if (!extracted.ok) return extracted;
    const sourceDir = path.join(extractDir, 'data');
    const scan = scanSource(sourceDir);
    if (!scan.ok) return scan;
    return await action({ sourceDir, scan, manifest: parsed.manifest, key: k });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    // 与 discardBundle 一样，只清理本次拥有的临时区，失败也不能留下解密数据。
    if (extractDir) {
      try { fs.rmSync(extractDir, { recursive: true, force: true }); }
      catch (error) { logger.warn('backup', `清理恢复临时区失败：${error?.message ?? error}`); }
    }
  }
}

/** options.selection / options.hooks 传给 migrate；第二参数仅用于注入导入实现测试。 */
export async function runRestore({ targetId, key, options = {}, selection, hooks } = {}, { applyImport: importData = applyImport } = {}) {
  if (operationsStopped) return { ok: false, error: '应用正在停止，无法开始恢复' };
  if (restoreInFlight || backupInFlight) return { ok: false, error: '已有一个备份或恢复正在进行，请等它完成' };
  restoreInFlight = true;
  try {
    restoreTask = withRestoreSource({ targetId, key }, async ({ sourceDir, scan, manifest, key: k }) => {
      const picked = options.selection ?? selection ?? {
        messages: { chatKeys: scan.messages.map((m) => m.chatKey), strategy: 'merge' },
        memory: scan.memory.available,
        stats: Object.fromEntries(scan.stats.map((stat) => [stat.id, true])),
        reminders: fs.existsSync(path.join(sourceDir, 'reminders.json')),
        stickers: fs.existsSync(path.join(sourceDir, 'stickers.json'))
      };
      const report = await importData(sourceDir, picked, options.hooks ?? hooks ?? {});
      if (!report.ok) return { ok: false, backupId: report.backupId, error: report.error || '导入失败', report };
      logger.info('backup', `恢复完成：${targetId} / ${k}`);
      return { ok: true, backupId: report.backupId, source: `${targetId}:${k}`, manifest, report };
    });
    return await restoreTask;
  } finally { restoreInFlight = false; restoreTask = null; }
}

/** scanSource 提供包内、本机和预计新增消息数；预览结束立即清理临时数据。 */
export async function restorePreview({ targetId, key } = {}) {
  return withRestoreSource({ targetId, key }, ({ scan, manifest }) => {
    const { sourceDir, ...preview } = scan;
    return { ok: true, manifest, scan: preview };
  });
}

/**
 * 当前状态（设置页首屏用）。
 * 不联网、不读写目标：只回答"配置了什么、上次跑得怎么样"。
 */
export function getStatus() {
  const cfg = backupConfig();
  const state = readState();
  return {
    ok: true,
    enabled: cfg.enabled === true,
    intervalHours: Number(cfg.intervalHours) || 24,
    retention: Number(cfg.retention) || DEFAULT_RETENTION,
    includeSecrets: cfg.includeSecrets === true,
    running: backupInFlight || restoreInFlight,
    lastRun: state.history[0] || null,
    history: state.history,
    targets: configuredTargets().map((t) => ({
      id: t.id,
      name: String(t.name || ''),
      type: String(t.type),
      enabled: t.enabled === true,
      categories: Array.isArray(t.categories) ? t.categories.map(String) : []
    })),
    categories: listBackupCategories().map((c) => ({ key: c.key, label: c.label, desc: c.desc }))
  };
}

/**
 * 测试一个目标（设置页「测试连接」）。永不抛错。
 * @param {string|object} targetOrId 配置里的目标 id，或直接给一个目标配置对象
 */
export async function testTarget(targetOrId) {
  const entry = typeof targetOrId === 'string' ? findTargetEntry(targetOrId) : targetOrId;
  if (!entry) return { ok: false, message: `找不到备份目标：${targetOrId}` };
  try {
    return await createTarget(entry).test();
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/**
 * 列出各目标上已有的备份文件。
 * @param {{targetIds?:string[]}} opts 省略 = 所有已配置目标（含未启用，便于发现残留）
 */
export async function listBackups({ targetIds = null } = {}) {
  const wanted = targetIds ? new Set(targetIds.map(String)) : null;
  const rows = configuredTargets().filter((t) => !wanted || wanted.has(t.id));
  const out = [];
  for (const entry of rows) {
    const row = { id: entry.id, name: String(entry.name || ''), type: String(entry.type), enabled: entry.enabled === true, ok: false, error: '', backups: [] };
    try {
      const list = await createTarget(entry).list();
      row.backups = list
        .filter((e) => isBackupKey(e.key))
        .sort((a, b) => a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
      row.ok = true;
    } catch (error) {
      row.error = String(error?.message ?? error);
    }
    out.push(row);
  }
  return { ok: out.every((r) => r.ok), targets: out };
}

/** 读某个备份包的 manifest（列表页展开详情用；只下载、不落地任何数据）。 */
export async function inspectBackup({ targetId, key } = {}) {
  const entry = findTargetEntry(targetId);
  if (!entry) return { ok: false, error: `找不到备份目标：${targetId}` };
  try {
    const buffer = await createTarget(entry).get(String(key || ''));
    const parsed = parseRestoreBackup(buffer);
    return parsed.ok ? { ok: true, manifest: parsed.manifest, bytes: buffer.length } : parsed;
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export { listRuns, getLastRun };

export default {
  runBackup,
  runRestore,
  restorePreview,
  getStatus,
  testTarget,
  listBackups,
  inspectBackup,
  listRuns,
  getLastRun
};
