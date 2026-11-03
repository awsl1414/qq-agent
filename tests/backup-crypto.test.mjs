import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-crypto-'));
const previousDataDir = process.env.QQ_AGENT_DATA_DIR;
process.env.QQ_AGENT_DATA_DIR = TMP;
const crypto = await import('../src/backup/crypto.js');
const PREFIX = 'qqac:v1:';
const HEADER_BYTES = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.QQ_AGENT_DATA_DIR;
  else process.env.QQ_AGENT_DATA_DIR = previousDataDir;
});

test('首次使用自动创建 salt，后续复用，POSIX 权限为 0600', () => {
  assert.equal(fs.existsSync(crypto.BACKUP_SALT_FILE), false);
  const encrypted = crypto.encryptCredential('first credential');
  const salt = fs.readFileSync(crypto.BACKUP_SALT_FILE, 'utf8');
  assert.match(salt, /^[a-f0-9]{64}$/);
  assert.equal(crypto.decryptCredential(encrypted), 'first credential');
  assert.equal(fs.readFileSync(crypto.BACKUP_SALT_FILE, 'utf8'), salt);
  assert.deepEqual(fs.readdirSync(TMP), ['backup-crypto.salt']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(crypto.BACKUP_SALT_FILE).mode & 0o777, 0o600);
});

test('凭据往返：Unicode、空串、随机 nonce、密文不含明文', () => {
  for (const plaintext of ['', 'secret-api-token-very-private', '中文密码🔑\u0000end']) {
    const encrypted = crypto.encryptCredential(plaintext);
    assert.ok(encrypted.startsWith(PREFIX));
    assert.equal(crypto.decryptCredential(encrypted), plaintext);
    assert.notEqual(crypto.encryptCredential(plaintext), encrypted);
    if (plaintext) {
      assert.equal(encrypted.includes(plaintext), false);
      assert.equal(Buffer.from(encrypted.slice(PREFIX.length), 'base64').includes(Buffer.from(plaintext)), false);
    }
  }
});

test('凭据改一个字节必须认证失败：nonce、tag、ciphertext', () => {
  const encrypted = crypto.encryptCredential('credential-tamper-test');
  const original = Buffer.from(encrypted.slice(PREFIX.length), 'base64');
  for (const offset of [0, NONCE_BYTES, NONCE_BYTES + TAG_BYTES]) {
    const modified = Buffer.from(original);
    modified[offset] ^= 1;
    assert.throws(() => crypto.decryptCredential(PREFIX + modified.toString('base64')), /凭据解密失败/);
  }
  assert.throws(() => crypto.decryptCredential('qqac:v2:abcd'), /版本/);
  assert.throws(() => crypto.decryptCredential(PREFIX + 'invalid!'), /格式/);
});

test('整包往返：二进制、空载荷、密文不含明文片段', () => {
  for (const plaintext of [Buffer.alloc(0), Buffer.from('config-secret-very-private\u0000中文\ufffd'), Buffer.from([0, 255, 128, 1])]) {
    const encrypted = crypto.encryptPayload(plaintext);
    assert.ok(Buffer.isBuffer(encrypted));
    assert.deepEqual(crypto.decryptPayload(encrypted), plaintext);
    assert.notDeepEqual(crypto.encryptPayload(plaintext), encrypted);
    if (plaintext.length) assert.equal(encrypted.includes(plaintext), false);
  }
});

test('整包逐段改一个字节、截断均被拒绝并给出明确错误', () => {
  const original = crypto.encryptPayload(Buffer.from('payload-tamper-test'));
  for (const offset of [0, HEADER_BYTES, HEADER_BYTES + NONCE_BYTES, HEADER_BYTES + NONCE_BYTES + TAG_BYTES]) {
    const modified = Buffer.from(original);
    modified[offset] ^= 1;
    assert.throws(() => crypto.decryptPayload(modified), /备份包已损坏或被篡改/);
  }
  for (const truncated of [Buffer.alloc(0), original.subarray(0, HEADER_BYTES), original.subarray(0, original.length - 1)]) {
    assert.throws(() => crypto.decryptPayload(truncated), /备份包已损坏或被篡改/);
  }
});

test('凭据密文不能伪装成载荷：用途认证隔离', () => {
  const credential = crypto.encryptCredential('private credential');
  const forged = Buffer.concat([Buffer.from('QQABENC1'), Buffer.from(credential.slice(PREFIX.length), 'base64')]);
  assert.throws(() => crypto.decryptPayload(forged), /备份包已损坏或被篡改/);
});

test('独立进程复用 salt 可解密，不同实例 salt 无法解密', () => {
  const encrypted = crypto.encryptCredential('cross-process-secret');
  const moduleUrl = new URL('../src/backup/crypto.js', import.meta.url).href;
  const script = `import { decryptCredential } from ${JSON.stringify(moduleUrl)}; process.stdout.write(decryptCredential(process.env.TEST_CIPHER));`;
  const env = { ...process.env, TEST_CIPHER: encrypted };
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }), 'cross-process-secret');
  const isolated = path.join(TMP, 'other-instance');
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...env, QQ_AGENT_DATA_DIR: isolated }, stdio: ['ignore', 'pipe', 'pipe']
  }), /凭据解密失败/);
});

test('损坏 salt 不会被静默替换；删除 salt 后重新创建且旧密文失效', () => {
  const old = crypto.encryptCredential('old-secret');
  fs.writeFileSync(crypto.BACKUP_SALT_FILE, 'broken');
  assert.throws(() => crypto.encryptCredential('new-secret'), /salt 文件无效/);
  assert.equal(fs.readFileSync(crypto.BACKUP_SALT_FILE, 'utf8'), 'broken');
  fs.unlinkSync(crypto.BACKUP_SALT_FILE);
  const fresh = crypto.encryptCredential('fresh-secret');
  assert.equal(crypto.decryptCredential(fresh), 'fresh-secret');
  assert.throws(() => crypto.decryptCredential(old), /凭据解密失败/);
});
