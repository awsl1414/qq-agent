import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-encryption-test-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { getConfig } = await import('../src/config.js');
const { buildBackup, parseBackup } = await import('../src/backup/archive.js');
const { decryptPayload } = await import('../src/backup/crypto.js');
const { runBackup, runRestore, inspectBackup } = await import('../src/backup/index.js');
const { parseZip } = await import('../src/zip-install.js');
const { buildZip } = await import('../src/zip-build.js');
const { createLocalTarget } = await import('../src/backup/targets/local.js');
const dir = path.join(root, 'target');
const target = createLocalTarget({ dir });
getConfig().backup = { includeSecrets: true, targets: [{ id: 'test', type: 'local', dir, enabled: true, categories: ['messages'] }] };
const secret = JSON.stringify({ apiKey: 'SECRET-API-KEY' });
fs.writeFileSync(path.join(root, 'config.json'), secret);
fs.mkdirSync(path.join(root, 'messages'));
fs.writeFileSync(path.join(root, 'messages', 'group_123.json'), JSON.stringify({ chatKey: 'group:123', messages: [{ id: 1, text: 'saved' }] }));
fs.mkdirSync(path.join(root, 'plugin-data'));
fs.writeFileSync(path.join(root, 'plugin-data', 'credentials.json'), 'excluded');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('包含密钥强制加密：外层仅清单与密文，内层含 config 而无 plugin-data', async () => {
  const result = await runBackup();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.manifest.encrypted, true);
  const buffer = await target.get(result.key);
  const outer = parseZip(buffer);
  assert.deepEqual(outer.map((e) => e.name).sort(), ['manifest.json', 'payload.enc']);
  assert.equal(buffer.includes(Buffer.from('SECRET-API-KEY')), false);
  const parsed = parseBackup(buffer);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.code, 'encrypted');
  assert.equal(parsed.manifest.sha256, createHash('sha256').update(parsed.ciphertext).digest('hex'));
  const inner = parseZip(decryptPayload(parsed.ciphertext));
  assert.equal(inner.find((e) => e.name === 'data/config.json').data.toString(), secret);
  assert.equal(inner.some((e) => e.name.includes('plugin-data')), false);
  assert.equal((await inspectBackup({ targetId: 'test', key: result.key })).ok, true);
  let calls = 0;
  const restored = await runRestore({ targetId: 'test', key: result.key }, { applyImport: async (source) => {
    calls++;
    assert.equal(fs.readFileSync(path.join(source, 'config.json'), 'utf8'), secret);
    assert.ok(fs.existsSync(path.join(source, 'messages', 'group_123.json')));
    return { ok: true };
  } });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(calls, 1);
  assert.equal(buildBackup({ categories: ['messages'], includeSecrets: true, encrypt: false }).manifest.encrypted, true);
});

test('篡改密文：摘要拒绝；重算摘要也不能绕过认证，恢复和详情给出明确错误', async () => {
  const built = buildBackup({ categories: ['messages'], includeSecrets: true });
  const outer = parseZip(built.buffer);
  const ciphertext = outer.find((e) => e.name === 'payload.enc').data;
  ciphertext[ciphertext.length - 1] ^= 1;
  assert.throws(() => decryptPayload(ciphertext), /损坏|篡改/);
  assert.equal(parseBackup(buildZip(outer)).ok, false);
  const manifest = { ...built.manifest, sha256: createHash('sha256').update(ciphertext).digest('hex') };
  const key = 'qq-agent/backup-tampered.qqab';
  await target.put(key, buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, { name: 'payload.enc', data: ciphertext }]));
  for (const operation of [runRestore, inspectBackup]) {
    const result = await operation({ targetId: 'test', key });
    assert.equal(result.ok, false);
    assert.match(result.error, /备份包已损坏、被篡改，或来自另一台机器/);
    assert.match(result.error, /换机后无法解密/);
  }
});

test('加密抛错整次失败：不产出包、不上传、不清理已有包', async () => {
  const before = await target.list();
  let calls = 0;
  const result = await runBackup({}, { encryptPayload() { calls++; throw new Error('injected encryption failure'); } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /备份加密失败.*injected encryption failure/);
  assert.deepEqual(result.targets, []);
  assert.equal(result.key, undefined);
  assert.equal(result.buffer, undefined);
  assert.deepEqual(await target.list(), before);
});

test('不包含密钥保持明文行为且不会调用加密', async () => {
  getConfig().backup.includeSecrets = false;
  const result = await runBackup({}, { encryptPayload() { throw new Error('must not encrypt'); } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.manifest.encrypted, false);
  const parsed = parseBackup(await target.get(result.key));
  assert.equal(parsed.ok, true, parsed.error);
  assert.ok(parsed.entries.some((e) => e.name.startsWith('data/messages/')));
  assert.equal(parsed.entries.some((e) => /config.json|plugin-data/.test(e.name)), false);
});

test('部分空类别透传跳过原因，明文与包含密钥加密路径一致', async () => {
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reminders.json'), '');
  const expected = [
    { key: 'memory', label: '群友印象', reason: '本机还没有群友印象' },
    { key: 'reminders', label: '提醒', reason: '本机还没有提醒' },
    { key: 'usage', label: '用量统计', reason: '本机还没有用量统计' }
  ];
  for (const includeSecrets of [false, true]) {
    getConfig().backup.includeSecrets = includeSecrets;
    const result = await runBackup({ categories: ['messages', 'memory', 'usage', 'reminders'] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.manifest.encrypted, includeSecrets);
    assert.deepEqual(result.skippedCategories, expected);
    assert.deepEqual(result.manifest.categories.map((c) => c.key), ['messages']);
    const built = buildBackup({ categories: ['messages', 'memory', 'usage', 'reminders'], includeSecrets });
    assert.deepEqual(built.skippedCategories, expected);
    const parsed = parseBackup(built.buffer);
    const entries = includeSecrets ? parseZip(decryptPayload(parsed.ciphertext)) : parsed.entries;
    assert.ok(entries.some((e) => e.name.startsWith('data/messages/')));
  }
});

test('全空类别返回新错误文案与跳过原因，明文和加密路径一致', async () => {
  const error = '选中的类别目前都没有数据（可能是刚安装或还没产生聊天记录），没有可备份的内容';
  for (const encrypt of [false, true]) {
    const built = buildBackup({ categories: ['memory', 'usage', 'reminders'], encrypt });
    assert.equal(built.ok, false);
    assert.equal(built.error, error);
    assert.deepEqual(built.skippedCategories.map((c) => c.key), ['memory', 'reminders', 'usage']);
    assert.equal(built.buffer, undefined);
  }
  getConfig().backup.includeSecrets = false;
  const result = await runBackup({ categories: ['memory', 'usage', 'reminders'] });
  assert.equal(result.ok, false);
  assert.equal(result.error, error);
  assert.deepEqual(result.skippedCategories.map((c) => c.key), ['memory', 'reminders', 'usage']);
  assert.deepEqual(result.targets, []);
});
