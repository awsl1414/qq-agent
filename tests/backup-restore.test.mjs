import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-restore-test-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { getConfig } = await import('../src/config.js');
const { runRestore, restorePreview } = await import('../src/backup/index.js');
const { computePayloadSha256, BACKUP_FORMAT } = await import('../src/backup/archive.js');
const { encryptPayload } = await import('../src/backup/crypto.js');
const { buildZip } = await import('../src/zip-build.js');
const { createLocalTarget } = await import('../src/backup/targets/local.js');
const { listBackups, rollbackImport } = await import('../src/migrate.js');
const target = createLocalTarget({ dir: path.join(root, 'target') });
getConfig().backup.targets = [{ id: 'test', type: 'local', dir: path.join(root, 'target') }];
const messageFile = path.join(root, 'messages', 'group_123.json');
const local = JSON.stringify({ chatKey: 'group:123', nextLocalId: 2, messages: [{ id: 1, mid: 'a', ts: 1, text: 'local' }] });
fs.mkdirSync(path.dirname(messageFile), { recursive: true });
fs.writeFileSync(messageFile, local);
const entries = [
  { name: 'data/messages/group_123.json', data: Buffer.from(JSON.stringify({ chatKey: 'group:123', messages: [
    { id: 1, mid: 'a', ts: 1, text: 'local' }, { id: 2, mid: 'b', ts: 2, text: 'restored' }
  ] })) },
  { name: 'data/memory/group_123/42.json', data: Buffer.from(JSON.stringify({ userId: '42', impressions: [{ content: 'kind', createdAt: 1 }] })) }
];
function pack(payload = entries, overrides = {}) {
  // 明文按排序条目集合摘要，避开 zip 时间戳；加密包直接摘要 payload.enc 的
  // 完整字节（含版本头、nonce、tag 和密文），解密时仍须通过 GCM 认证。
  const sha256 = overrides.encrypted === true
    ? createHash('sha256').update(payload[0].data).digest('hex')
    : computePayloadSha256(payload);
  const manifest = { format: BACKUP_FORMAT, version: 1, encrypted: false,
    categories: ['messages', 'memory'], sha256, ...overrides };
  return buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...payload]);
}
async function put(buffer, key = 'qq-agent/backup-test.qqab') {
  await target.put(key, buffer);
  return { targetId: 'test', key };
}
function assertClean() {
  const dir = path.join(root, 'backup-restore');
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
}
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('sha256: valid package reaches injected applyImport without direct data writes', async () => {
  const args = await put(pack());
  let source;
  let called = 0;
  const hooks = { storeInvalidate() {} };
  const result = await runRestore({ ...args, options: { hooks } }, { applyImport: async (dir, selection, actualHooks) => {
    called += 1;
    source = dir;
    assert.equal(fs.existsSync(path.join(dir, 'memory', 'group_123', '42.json')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'messages', 'group_123.json'))).messages.length, 2);
    assert.deepEqual(selection.messages, { chatKeys: ['group:123'], strategy: 'merge' });
    assert.equal(selection.memory, true);
    assert.equal(actualHooks, hooks);
    assert.equal(fs.readFileSync(messageFile, 'utf8'), local);
    return { ok: true, backupId: 'rollback-id' };
  } });
  assert.equal(result.ok, true, result.error);
  assert.equal(called, 1);
  assert.equal(result.backupId, 'rollback-id');
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(messageFile, 'utf8'), local);
  assert.equal(fs.existsSync(path.join(root, 'memory')), false);
  assertClean();
});

test('payload and manifest tampering rejected before import', async () => {
  let calls = 0;
  for (const buffer of [pack([{ ...entries[0], data: Buffer.from('tampered') }, entries[1]], { sha256: computePayloadSha256(entries) }), pack(entries, { sha256: '0'.repeat(64) })]) {
    const result = await runRestore(await put(buffer), { applyImport: async () => { calls += 1; } });
    assert.equal(result.ok, false);
    assert.match(result.error, /sha256/);
  }
  assert.equal(calls, 0);
  assertClean();
});

test('preview reuses scanSource counts without importing and cleans staging', async () => {
  const result = await restorePreview(await put(pack()));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.scan.messages[0].source.count, 2);
  assert.equal(result.scan.messages[0].target.count, 1);
  assert.equal(result.scan.messages[0].extra, 1);
  assert.equal(result.scan.memory.chats[0].notes, 1);
  assert.equal(fs.readFileSync(messageFile, 'utf8'), local);
  assertClean();
});

test('encrypted payload validates outer sha256 then decrypts through B2', async () => {
  const payload = [{ name: 'payload.enc', data: encryptPayload(buildZip(entries)) }];
  const args = await put(pack(payload, { encrypted: true }));
  let calls = 0;
  const result = await runRestore(args, { applyImport: async (dir) => {
    calls += 1;
    assert.equal(fs.existsSync(path.join(dir, 'messages', 'group_123.json')), true);
    return { ok: true, backupId: 'encrypted-id' };
  } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.manifest.encrypted, true);
  assert.equal(calls, 1);
  const broken = [{ name: 'payload.enc', data: Buffer.from(payload[0].data) }];
  broken[0].data[broken[0].data.length - 1] ^= 1;
  const badHash = await runRestore(await put(pack(broken, { encrypted: true, sha256: createHash('sha256').update(payload[0].data).digest('hex') })));
  assert.match(badHash.error, /sha256/);
  const badAuth = await runRestore(await put(pack(broken, { encrypted: true })));
  assert.equal(badAuth.ok, false);
  assert.match(badAuth.error, /损坏|篡改/);
  assertClean();
});

test('import failures and exceptions clean temporary directory and retain rollback id', async () => {
  const args = await put(pack());
  for (const implementation of [async () => ({ ok: false, backupId: 'partial', error: 'failed' }), async () => { throw new Error('thrown'); }]) {
    const result = await runRestore(args, { applyImport: implementation });
    assert.equal(result.ok, false);
    if (result.report) assert.equal(result.backupId, 'partial');
    assertClean();
  }
});

test('selection forwards additional fields and reminders/stickers default from actual package', async () => {
  const extra = [...entries, { name: 'data/reminders.json', data: Buffer.from('[]') }, { name: 'data/stickers.json', data: Buffer.from('{}') }];
  const args = await put(pack(extra));
  const defaults = await runRestore(args, { applyImport: async (dir, selection) => {
    assert.equal(selection.reminders, true);
    assert.equal(selection.stickers, true);
    return { ok: true };
  } });
  assert.equal(defaults.ok, true, defaults.error);
  const selection = { memory: false, futureCategory: true };
  const explicit = await runRestore({ ...args, options: { selection } }, { applyImport: async (dir, picked) => {
    assert.equal(picked, selection);
    return { ok: true };
  } });
  assert.equal(explicit.ok, true, explicit.error);
  assertClean();
});

test('real migrate import creates rollback backup and rollback restores original data', async () => {
  const result = await runRestore(await put(pack()));
  assert.equal(result.ok, true, result.error);
  assert.equal(JSON.parse(fs.readFileSync(messageFile)).messages.length, 2);
  assert.ok(listBackups().some((b) => b.id === result.backupId));
  assert.equal(fs.existsSync(path.join(root, 'memory', 'group_123', '42.json')), true);
  const rolled = await rollbackImport(result.backupId);
  assert.equal(rolled.ok, true);
  assert.equal(fs.readFileSync(messageFile, 'utf8'), local);
  assert.equal(fs.existsSync(path.join(root, 'memory', 'group_123', '42.json')), false);
  assertClean();
});
