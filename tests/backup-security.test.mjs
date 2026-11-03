import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-security-'));
const data = path.join(root, 'data');
fs.mkdirSync(data);
process.env.QQ_AGENT_DATA_DIR = data;
const { buildBackup, parseBackup } = await import('../src/backup/archive.js');
const { encryptCredential, decryptPayload } = await import('../src/backup/crypto.js');
const { parseZip } = await import('../src/zip-install.js');
const { createLocalTarget } = await import('../src/backup/targets/local.js');
const { logger } = await import('../src/logger.js');
logger.mirrorConsole = false;
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('default backup rejects a category root junction exposing config and salt', () => {
  fs.writeFileSync(path.join(data, 'config.json'), '{"apiKey":"FAKE_PRIVATE_KEY"}');
  fs.writeFileSync(path.join(data, 'backup-crypto.salt'), 'f'.repeat(64));
  const link = path.join(data, 'messages');
  fs.symlinkSync(data, link, 'junction');
  try {
    const built = buildBackup({ categories: ['messages'] });
    assert.equal(built.ok, false);
    assert.match(built.error, /符号链接|目录联接/);
    assert.equal(built.buffer, undefined);
  } finally { fs.unlinkSync(link); }
});

test('category walk excludes credentials, salts, locks, caches and nested junctions with a warning', () => {
  const messages = path.join(data, 'messages');
  fs.mkdirSync(messages);
  fs.writeFileSync(path.join(messages, 'group_123.json'), '{"messages":[{"text":"saved"}]}');
  for (const name of ['config.json', 'backup-crypto.salt', 'other.salt', 'state.lock', 'leftover.tmp', 'config.bak']) {
    fs.writeFileSync(path.join(messages, name), 'FAKE_SENSITIVE_MARKER');
  }
  for (const name of ['.cache', 'cache', 'logs', 'plugin-data']) {
    fs.mkdirSync(path.join(messages, name));
    fs.writeFileSync(path.join(messages, name, 'secret.json'), 'FAKE_SENSITIVE_MARKER');
  }
  fs.symlinkSync(data, path.join(messages, 'junction'), 'junction');
  const built = buildBackup({ categories: ['messages'] });
  assert.equal(built.ok, true, built.error);
  assert.deepEqual(parseBackup(built.buffer).entries.map(e => e.name), ['data/messages/group_123.json']);
  assert.equal(built.buffer.includes(Buffer.from('FAKE_SENSITIVE_MARKER')), false);
  assert.ok(logger.recent().some(entry => entry.level === 'warn' && /按安全边界排除/.test(entry.text)));
});

test('includeSecrets encrypts the config after removing backup credentials without changing the source', () => {
  const cipher = encryptCredential('FAKE_STORAGE_PASSWORD');
  const original = JSON.stringify({ api: { apiKey: 'FAKE_API_SECRET' }, backup: {
    targets: [{ url: 'https://private-nas.invalid/', credentials: cipher, secretAccessKeyCipher: cipher }]
  } }, null, 2);
  fs.writeFileSync(path.join(data, 'config.json'), original);
  const built = buildBackup({ categories: ['messages'], includeSecrets: true, encrypt: false });
  assert.equal(built.ok, true, built.error);
  const parsed = parseBackup(built.buffer);
  assert.equal(parsed.manifest.encrypted, true);
  const entries = parseZip(decryptPayload(parsed.ciphertext));
  const config = JSON.parse(entries.find(e => e.name === 'data/config.json').data);
  assert.equal(config.api.apiKey, 'FAKE_API_SECRET');
  assert.equal(Object.hasOwn(config, 'backup'), false);
  assert.equal(entries.some(e => e.data.includes(Buffer.from(cipher))), false);
  assert.equal(JSON.stringify(built.manifest).includes(cipher), false);
  assert.equal(logger.recent().some(entry => entry.text.includes(cipher)), false);
  assert.equal(fs.readFileSync(path.join(data, 'config.json'), 'utf8'), original);
});

test('invalid secret config fails closed without echoing raw configuration', () => {
  fs.writeFileSync(path.join(data, 'config.json'), 'FAKE_PRIVATE_CONFIG_INVALID_JSON');
  const built = buildBackup({ categories: ['messages'], includeSecrets: true });
  assert.equal(built.ok, false);
  assert.equal(built.error.includes('FAKE_PRIVATE_CONFIG_INVALID_JSON'), false);
  assert.equal(built.buffer, undefined);
});

test('local junction cannot read, write or delete outside the target and is absent from list', async () => {
  const dir = path.join(root, 'target');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'victim.qqab'), 'original');
  fs.symlinkSync(outside, path.join(dir, 'qq-agent'), 'junction');
  const target = createLocalTarget({ dir });
  await assert.rejects(target.get('qq-agent/victim.qqab'), /目标路径超出备份目录范围/);
  await assert.rejects(target.put('qq-agent/created.qqab', Buffer.from('changed')), /目标路径超出备份目录范围/);
  await assert.rejects(target.remove('qq-agent/victim.qqab'), /目标路径超出备份目录范围/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.qqab'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(outside, 'created.qqab')), false);
  assert.deepEqual(await target.list(), []);
});

test('local rejects traversal, POSIX absolute, UNC and drive-qualified keys for every operation', async () => {
  const dir = path.join(root, 'lexical-target');
  fs.mkdirSync(dir);
  const target = createLocalTarget({ dir });
  for (const key of ['../outside.qqab', '/outside.qqab', 'C:/outside.qqab', 'C:outside.qqab', '\\\\server\\share\\outside.qqab', 'a/../b.qqab']) {
    await assert.rejects(target.put(key, Buffer.from('x')), /非法/);
    await assert.rejects(target.get(key), /非法/);
    await assert.rejects(target.remove(key), /非法/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  await target.put('nested/deeper/valid.qqab', Buffer.from('valid'));
  assert.equal((await target.get('nested/deeper/valid.qqab')).toString(), 'valid');
  await target.remove('nested/deeper/valid.qqab');
});

test('local rejects replacing an already anchored target root with an outside junction', async () => {
  const dir = path.join(root, 'anchored-target');
  const outside = path.join(root, 'other-root');
  fs.mkdirSync(dir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'victim.qqab'), 'original');
  const target = createLocalTarget({ dir });
  fs.renameSync(dir, path.join(root, 'original-target'));
  fs.symlinkSync(outside, dir, 'junction');
  await assert.rejects(target.get('victim.qqab'), /目标路径超出备份目录范围/);
  await assert.rejects(target.put('new.qqab', Buffer.from('x')), /目标路径超出备份目录范围/);
  await assert.rejects(target.remove('victim.qqab'), /目标路径超出备份目录范围/);
});

test('local list returns empty only for ENOENT and propagates unreadable, offline and non-directory errors', async () => {
  assert.deepEqual(await createLocalTarget({ dir: path.join(root, 'missing') }).list(), []);
  const dir = path.join(root, 'unreadable');
  fs.mkdirSync(dir);
  const target = createLocalTarget({ dir });
  const original = fsp.opendir;
  try {
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      fsp.opendir = async () => { throw Object.assign(new Error('audit injected directory failure'), { code }); };
      await assert.rejects(target.list(), { code });
    }
  } finally { fsp.opendir = original; }
  const file = path.join(root, 'not-a-directory');
  fs.writeFileSync(file, 'x');
  await assert.rejects(createLocalTarget({ dir: file }).list(), { code: 'ENOTDIR' });
});
