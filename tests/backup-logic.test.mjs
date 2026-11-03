import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-logic-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { getConfig, updateConfig } = await import('../src/config.js');
const backup = await import('../src/backup/index.js');
const state = await import('../src/backup/state.js');
const { buildBackup } = await import('../src/backup/archive.js');
const { applyImport, rollbackImport } = await import('../src/migrate.js');
const goodDir = path.join(root, 'target');
const message = path.join(root, 'messages', 'group_1.json');
fs.mkdirSync(path.dirname(message), { recursive: true });
fs.writeFileSync(message, JSON.stringify({ messages: [{ id: 1, mid: 'a', text: 'original' }] }));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('all/partial/failed target results persist accurately and backup/restore share a guard', async () => {
  const bad = path.join(root, 'not-a-directory');
  fs.writeFileSync(bad, 'x');
  getConfig().backup = { retention: 7, targets: [
    { id: 'good', enabled: true, type: 'local', dir: goodDir, categories: ['messages'] },
    { id: 'bad', enabled: true, type: 'local', dir: bad, categories: ['messages'] }
  ] };
  const first = backup.runBackup();
  assert.equal(backup.getStatus().running, true);
  assert.equal((await backup.runBackup()).ok, false);
  assert.equal((await backup.runRestore()).ok, false);
  const partial = await first;
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.targets.map((item) => item.ok), [true, false]);
  assert.equal(state.getLastRun().ok, true);
  assert.equal(backup.getStatus().running, false);
  const success = await backup.runBackup({ targetIds: ['good'] });
  assert.equal(success.ok, true);
  assert.equal(state.getLastRun().ok, true);
  const failed = await backup.runBackup({ targetIds: ['bad'] });
  assert.equal(failed.ok, false);
  assert.equal(state.getLastRun().ok, false);
  assert.equal(state.listRuns().length, 3);
});

test('unfinished history from a terminated process becomes failed on restart', () => {
  const orphan = { id: 'orphan', startedAt: 123, ok: null, finishedAt: null };
  fs.writeFileSync(state.BACKUP_STATE_FILE, JSON.stringify({ history: [orphan], running: true }));
  const script = `import { getStatus } from './src/backup/index.js'; process.stdout.write(JSON.stringify(getStatus()));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.running, false);
  assert.equal(result.lastRun.ok, false);
  assert.match(result.lastRun.error, /中断/);
});

test('a running backup retains its configuration snapshot when settings change during upload', async () => {
  const prefix = path.join(goodDir, 'qq-agent');
  for (const day of ['01', '02', '03']) fs.writeFileSync(path.join(prefix, `backup-202610${day}-0300.qqab`), 'old');
  fs.writeFileSync(path.join(prefix, 'personal.qqab'), 'user data');
  const before = fs.readdirSync(prefix).length;
  const cfg = getConfig().backup;
  cfg.retention = 7;
  cfg.targets = [{ id: 'good', enabled: true, type: 'local', dir: goodDir, categories: ['messages'] }];
  const task = backup.runBackup();
  updateConfig({ backup: { retention: 1, targets: [{ ...cfg.targets[0], dir: path.join(root, 'new-target') }] } });
  const result = await task;
  assert.equal(result.ok, true);
  assert.equal(fs.readdirSync(prefix).length, before + 1);
  assert.equal(fs.readFileSync(path.join(prefix, 'personal.qqab'), 'utf8'), 'user data');
  assert.equal(fs.existsSync(path.join(root, 'new-target')), false);
});

test('build rejects unreadable data and oversized category-root files before reading', () => {
  const original = fs.statSync;
  fs.statSync = (file, ...args) => {
    if (file === message) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return original(file, ...args);
  };
  try {
    const result = buildBackup({ categories: ['messages'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /permission denied/);
  } finally { fs.statSync = original; }
  const reminders = path.join(root, 'reminders.json');
  fs.writeFileSync(reminders, '');
  fs.truncateSync(reminders, 64 * 1024 * 1024 + 1);
  try {
    const result = buildBackup({ categories: ['reminders'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /上限/);
  } finally { fs.rmSync(reminders); }
});

test('memory writes have durable rollback actions even when a later member fails', async () => {
  const source = path.join(root, 'source-memory');
  const memory = path.join(source, 'memory', 'group_2');
  fs.mkdirSync(memory, { recursive: true });
  for (const id of ['1', '2']) fs.writeFileSync(path.join(memory, `${id}.json`), JSON.stringify({ userId: id, impressions: [{ content: id }] }));
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(root, 'memory', 'group_2', '2.json')) throw new Error('disk full');
    return original(from, to);
  };
  let report;
  try { report = await applyImport(source, { memory: true }); }
  finally { fs.renameSync = original; }
  assert.equal(report.ok, false);
  assert.equal(report.memory.ok, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, report.backupDir, 'manifest.json')));
  assert.equal(manifest.actions.length, 2);
  assert.equal(fs.existsSync(path.join(root, 'memory', 'group_2', '1.json')), true);
  assert.equal((await rollbackImport(report.backupId)).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'memory', 'group_2')), false);
});

test('manifest write failure prevents data mutation and marks import failed', async () => {
  const source = path.join(root, 'source-message');
  fs.mkdirSync(path.join(source, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(source, 'messages', 'group_1.json'), JSON.stringify({ messages: [{ id: 2, mid: 'b', text: 'new' }] }));
  const before = fs.readFileSync(message, 'utf8');
  const original = fs.renameSync;
  let manifests = 0;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'manifest.json' && ++manifests === 2) throw new Error('disk full');
    return original(from, to);
  };
  let report;
  try { report = await applyImport(source, { messages: { chatKeys: ['group:1'] } }); }
  finally { fs.renameSync = original; }
  assert.equal(report.ok, false);
  assert.equal(fs.readFileSync(message, 'utf8'), before);
  assert.equal((await rollbackImport(report.backupId)).ok, true);
});

test('usage archive and today restore by day and rollback restores the exact original', async () => {
  const source = path.join(root, 'source-usage');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'usage-archived-days.json'), JSON.stringify({ days: { '2026-11-01': { runs: 1 } } }));
  fs.writeFileSync(path.join(source, 'usage-today.json'), JSON.stringify({ dayKey: '2026-11-02', runs: 2 }));
  const archived = path.join(root, 'usage-archived-days.json');
  const before = JSON.stringify({ days: { '2026-10-31': { runs: 3 } } });
  fs.writeFileSync(archived, before);
  const report = await applyImport(source, { stats: { usageArchivedDays: true, usageToday: true } });
  assert.equal(report.ok, true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(archived)).days).length, 3);
  assert.equal(fs.existsSync(path.join(root, 'usage-today.json')), false);
  assert.equal((await rollbackImport(report.backupId)).ok, true);
  assert.equal(fs.readFileSync(archived, 'utf8'), before);
});

test('rollback and import cannot interleave while asynchronous rebuild hooks are pending', async () => {
  let release;
  const task = applyImport(path.join(root, 'source-message'), { messages: { chatKeys: ['group:1'] } }, {
    rebuildChat: () => new Promise((resolve) => { release = resolve; })
  });
  assert.equal(typeof release, 'function');
  assert.equal((await rollbackImport('anything')).ok, false);
  assert.equal((await applyImport(path.join(root, 'source-message'))).ok, false);
  release({ mode: 'test' });
  const report = await task;
  assert.equal(report.ok, true);
  assert.equal((await rollbackImport(report.backupId)).ok, true);
});

test('shutdown drains backup and restore before completing and rejects new operations', async () => {
  getConfig().backup.targets = [{ id: 'good', enabled: true, type: 'local', dir: goodDir, categories: ['messages'] }];
  const task = backup.runBackup();
  const stopping = backup.stopBackupOperations();
  assert.equal((await backup.runBackup()).ok, false);
  const saved = await task;
  await stopping;
  assert.equal(saved.ok, true);
  assert.equal(backup.getStatus().running, false);
  assert.equal(state.getLastRun().ok, true);
  backup.startBackupOperations();
  let signal;
  let release;
  const ready = new Promise((resolve) => { signal = resolve; });
  const restore = backup.runRestore({ targetId: 'good', key: saved.key }, { applyImport: async () => {
    signal();
    await new Promise((resolve) => { release = resolve; });
    return { ok: true };
  } });
  await ready;
  let stopped = false;
  const stopRestore = backup.stopBackupOperations().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(backup.getStatus().running, true);
  assert.equal((await backup.runRestore()).ok, false);
  release();
  assert.equal((await restore).ok, true);
  await stopRestore;
  assert.equal(backup.getStatus().running, false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'backup-restore')), []);
  backup.startBackupOperations();
});
