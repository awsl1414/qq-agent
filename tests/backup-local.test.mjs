// 数据备份与恢复 · 本地目标端到端测试。
//
// 覆盖：
//   1. 备份包构建 → 解析往返（内容一致、sha256 自校验、篡改被拒）；
//   2. 本地目标适配器 test / put / get / list / remove 全链路；
//   3. 按类别筛选（只装勾选类别；类别顺序无关；未知类别被丢弃）；
//   4. 目标适配器接口对齐（预置 local/webdav/s3 三个键）。
//
// 数据目录必须指到临时目录：config.js 的 DATA_DIR 是进程级常量，静态 import
// 会在设 env 之前求值完，所以下面全部用动态 import。
//
// 运行：node --test tests/backup-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-test-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const archive = await import('../src/backup/archive.js');
const targets = await import('../src/backup/targets/index.js');
const { createLocalTarget } = await import('../src/backup/targets/local.js');
const { parseZip } = await import('../src/zip-install.js');
const { buildZip } = await import('../src/zip-build.js');

/** 造一份最小 data 目录：messages / memory 两个目录 + 三个单文件类别。 */
function seedData() {
  fs.mkdirSync(path.join(TMP, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'messages', 'group_123.json'), JSON.stringify({
    chatKey: 'group:123',
    nextLocalId: 3,
    messages: [
      { id: 1, mid: 'm1', ts: 1_700_000_000_000, senderId: '1', text: '早' },
      { id: 2, mid: 'm2', ts: 1_700_000_001_000, senderId: '2', text: '好' }
    ]
  }), 'utf8');
  fs.mkdirSync(path.join(TMP, 'memory', 'group_123'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'memory', 'group_123', '42.json'), JSON.stringify({
    userId: '42', name: '小明', impressions: [{ content: '爱猫', createdAt: 1 }], updatedAt: 2, lastConsolidatedAt: 0
  }), 'utf8');
  fs.writeFileSync(path.join(TMP, 'usage-daily.json'), JSON.stringify({ version: 1, days: { '2026-11-01': { calls: 1 } } }), 'utf8');
  fs.writeFileSync(path.join(TMP, 'reminders.json'), JSON.stringify([{ id: 'r1', text: '倒垃圾' }]), 'utf8');
  fs.writeFileSync(path.join(TMP, 'stickers.json'), JSON.stringify({ items: [] }), 'utf8');
}

seedData();

test('类别筛选：只打包勾选类别，顺序无关，未知类别被丢弃', () => {
  const a = archive.normalizeCategories(['memory', 'messages', 'nope']);
  const b = archive.normalizeCategories(['messages', 'memory']);
  assert.deepEqual(a, ['memory', 'messages']);
  assert.deepEqual(a, b, '同一组类别必须得到同一顺序（多目标共用一份包的前提）');
  assert.deepEqual(archive.normalizeCategories({ messages: true, usage: false }), ['messages']);
});

test('构建 → 解析往返：清单、内容、文件数一致', () => {
  const built = archive.buildBackup({
    categories: ['messages', 'memory', 'reminders'],
    appVersion: '9.9.9',
    instanceId: 'inst-1',
    now: new Date('2026-11-03T03:00:00Z')
  });
  assert.equal(built.ok, true, built.error);
  assert.match(built.name, /^backup-\d{8}-\d{4}\.qqab$/);
  assert.equal(built.key, `qq-agent/${built.name}`);
  assert.equal(built.manifest.encrypted, false);
  assert.deepEqual(built.manifest.categories.map((c) => c.key), ['memory', 'messages', 'reminders']);

  // 包里确实只有 manifest.json + data/，没有 config.json / plugin-data
  const names = parseZip(built.buffer).map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('data/messages/group_123.json'));
  assert.ok(names.includes('data/memory/group_123/42.json'));
  assert.ok(names.includes('data/reminders.json'));
  assert.equal(names.some((n) => n === 'data/usage-daily.json'), false, '未勾选的类别不该进包');
  assert.equal(names.some((n) => n.includes('config.json')), false);

  const parsed = archive.parseBackup(built.buffer);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.manifest.appVersion, '9.9.9');
  assert.equal(parsed.manifest.instanceId, 'inst-1');
  assert.equal(parsed.files, built.manifest.files.length);

  const msg = parsed.entries.find((e) => e.name === 'data/messages/group_123.json');
  const body = JSON.parse(msg.data.toString('utf8'));
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].text, '好');
});

test('全部类别：五个类别都在时一个不落', () => {
  const built = archive.buildBackup({
    categories: archive.listBackupCategories().map((c) => c.key),
    now: new Date('2026-11-03T04:00:00Z')
  });
  assert.equal(built.ok, true, built.error);
  assert.deepEqual(
    built.manifest.categories.map((c) => c.key).sort(),
    ['memory', 'messages', 'reminders', 'stickers', 'usage']
  );
});

test('sha256 校验：载荷被篡改 → 解析拒绝', () => {
  const built = archive.buildBackup({ categories: ['reminders'], now: new Date('2026-11-03T05:00:00Z') });
  assert.equal(built.ok, true, built.error);
  // 改载荷条目内容、清单保持原样重建：等价于"包在传输/存储中被改过"。
  const entries = parseZip(built.buffer);
  const manifestEntry = entries.find((e) => e.name === 'manifest.json');
  const payload = entries.filter((e) => e.name !== 'manifest.json');
  const tampered = payload.map((e, i) => (i === 0 ? { name: e.name, data: Buffer.from('tampered', 'utf8') } : e));
  const forged = buildZip([manifestEntry, ...tampered]);
  const parsed = archive.parseBackup(forged);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /sha256/);
});

test('sha256 校验：manifest 摘要被改 → 解析拒绝', () => {
  const built = archive.buildBackup({ categories: ['reminders'], now: new Date('2026-11-03T06:00:00Z') });
  // 用同一批条目重建包，但把 manifest 的 sha256 换成别的值
  const entries = parseZip(built.buffer).filter((e) => e.name !== 'manifest.json');
  const badManifest = { ...built.manifest, sha256: 'f'.repeat(64) };
  const forged = buildZip([{ name: 'manifest.json', data: JSON.stringify(badManifest) }, ...entries]);
  assert.equal(archive.parseBackup(forged).ok, false);
  // 把同一份内容写回正确摘要则能通过（证明拒绝来自摘要而非别的字段）
  const goodManifest = { ...built.manifest, sha256: archive.computePayloadSha256(entries) };
  const good = buildZip([{ name: 'manifest.json', data: JSON.stringify(goodManifest) }, ...entries]);
  assert.equal(archive.parseBackup(good).ok, true);
});

test('空类别 / 空数据：明确报错而不是产出空包', () => {
  assert.equal(archive.buildBackup({ categories: [] }).ok, false);
  assert.match(archive.buildBackup({ categories: [] }).error, /没有选中/);
});

test('适配器工厂：local 已实现，webdav/s3 预置但抛 not-implemented', async () => {
  const local = targets.createTarget({ type: 'local', dir: TMP });
  assert.equal(local.type, 'local');
  for (const m of ['test', 'list', 'put', 'get', 'remove']) {
    assert.equal(typeof local[m], 'function', `local 缺少 ${m}`);
  }

  for (const type of ['webdav', 's3']) {
    const t = targets.createTarget({ type });
    assert.equal(t.type, type);
    for (const m of ['list', 'put', 'get', 'remove']) {
      await assert.rejects(() => t[m]('k'), (e) => e.code === 'not-implemented', `${type}.${m} 应报 not-implemented`);
    }
    // test() 契约不抛错
    const r = await t.test();
    assert.equal(r.ok, false);
    assert.match(r.message, /尚未实现/);
  }
  assert.throws(() => targets.createTarget({ type: 'ftp' }), /未知的备份目标类型/);
  assert.equal(targets.isTargetImplemented('local'), true);
  assert.equal(targets.isTargetImplemented('webdav'), false);
});

test('本地目标 put/get/list/remove 往返', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'target-'));
  const t = createLocalTarget({ dir });

  const tr = await t.test();
  assert.equal(tr.ok, true, tr.message);

  const payload = Buffer.from('hello backup', 'utf8');
  await t.put('qq-agent/backup-a.qqab', payload);
  assert.deepEqual(await t.get('qq-agent/backup-a.qqab'), payload);

  await t.put('qq-agent/sub/backup-b.qqab', Buffer.from('b'));
  const list = await t.list();
  assert.deepEqual(list.map((e) => e.key).sort(), ['qq-agent/backup-a.qqab', 'qq-agent/sub/backup-b.qqab']);
  assert.equal(list.find((e) => e.key === 'qq-agent/backup-a.qqab').size, payload.length);
  assert.ok(list.every((e) => typeof e.mtimeMs === 'number' && e.mtimeMs > 0));

  await t.remove('qq-agent/backup-a.qqab');
  const after = await t.list();
  assert.deepEqual(after.map((e) => e.key), ['qq-agent/sub/backup-b.qqab']);
});

test('本地目标：路径逃逸被拒，空目录 list 为空', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'target-escape-'));
  const t = createLocalTarget({ dir });
  await assert.rejects(() => t.put('../escape.qqab', Buffer.from('x')), /非法/);
  assert.deepEqual(await t.list(), []);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'escape.qqab')), false);
});

test('本地目标：未配置 dir 时 test 报不可用，list 明确报错', async () => {
  const t = createLocalTarget({});
  const r = await t.test();
  assert.equal(r.ok, false);
  assert.match(r.message, /未设置备份目录/);
  await assert.rejects(() => t.list(), /未设置目录/);
});

test('端到端：构建 → 本地目标 → 取回 → 解包回原结构', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'target-e2e-'));
  const t = createLocalTarget({ dir });
  const built = archive.buildBackup({
    categories: ['messages', 'memory'],
    now: new Date('2026-11-03T07:30:00Z')
  });
  assert.equal(built.ok, true, built.error);
  await t.put(built.key, built.buffer);

  const list = await t.list();
  assert.deepEqual(list.map((e) => e.key), [built.key]);
  assert.ok(archive.isBackupKey(list[0].key));

  const fetched = await t.get(built.key);
  const outDir = fs.mkdtempSync(path.join(TMP, 'restored-'));
  const extracted = archive.extractBackup(fetched, outDir);
  assert.equal(extracted.ok, true, extracted.error);
  // 结构与另一个实例的 data 目录一致，可直接喂给 migrate.applyImport
  assert.equal(fs.existsSync(path.join(outDir, 'data', 'messages', 'group_123.json')), true);
  const restored = JSON.parse(fs.readFileSync(path.join(outDir, 'data', 'messages', 'group_123.json'), 'utf8'));
  assert.equal(restored.messages.length, 2);
});

test('文件名与 key：时间戳到分钟，isBackupKey 只认本功能命名', () => {  const { name, key } = archive.backupKeyFor(new Date(2026, 10, 3, 3, 0));
  assert.equal(name, 'backup-20261103-0300.qqab');
  assert.equal(key, 'qq-agent/backup-20261103-0300.qqab');
  assert.equal(archive.isBackupKey(key), true);
  assert.equal(archive.isBackupKey('qq-agent/other.zip'), false);
  assert.equal(archive.isBackupKey('backup-20261103-0300.qqab'), false, '缺少前缀的不算本功能文件');
});

test('状态文件：ok 的 null → true 流转；损坏回落空状态（不阻塞）', async () => {
  const state = await import('../src/backup/state.js');
  state.resetState();
  const started = state.markRunStarted({ trigger: 'manual', categories: ['messages'], targetIds: ['t1'], now: Date.now() });
  // 进行中 = 记录已落下但 ok 仍为 null。"正在备份"由 index.js 的内存标记回答，
  // 不落盘（崩溃后会残留 true，界面永远卡在"正在备份"）。
  assert.equal(state.readState().history[0].ok, null, '进行中的记录 ok 应为 null');
  assert.equal('running' in state.readState(), false, 'running 不该落盘');

  state.markRunFinished(started.id, {
    ok: true,
    targets: [{ id: 't1', type: 'local', key: 'qq-agent/x.qqab', bytes: 12, ok: true }]
  });
  const after = state.readState();
  assert.equal(after.history[0].ok, true);
  assert.equal(after.history[0].finishedAt > 0, true);
  assert.equal(after.history[0].targets[0].key, 'qq-agent/x.qqab');

  fs.writeFileSync(state.BACKUP_STATE_FILE, '{broken', 'utf8');
  const fallback = state.readState();
  assert.deepEqual(fallback.history, []);
});
