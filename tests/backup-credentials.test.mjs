import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-credentials-'));
process.env.QQ_AGENT_DATA_DIR = TEMP;
const { createTarget, registerTarget } = await import('../src/backup/targets/index.js');
const { createWebdavTarget } = await import('../src/backup/targets/webdav.js');
const { createS3Target } = await import('../src/backup/targets/s3.js');
const { encryptCredential } = await import('../src/backup/crypto.js');
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const PASSWORD = 'factory-only-plaintext-password';
const CASES = [
  { type: 'webdav', cipherField: 'credentials', plainField: 'password', factory: createWebdavTarget },
  { type: 's3', cipherField: 'secretAccessKeyCipher', plainField: 'secretAccessKey', factory: createS3Target }
];

for (const { type, cipherField, plainField, factory } of CASES) {
  test(`${type}: factory unseals credentials without mutating config or serializing secrets`, () => {
    const cipher = encryptCredential(PASSWORD);
    const entry = { type, [cipherField]: cipher };
    let received;
    registerTarget(type, adapted => {
      received = adapted;
      return factory(adapted);
    });
    try {
      const target = createTarget(entry);
      assert.equal(received[plainField], PASSWORD);
      assert.equal(Object.hasOwn(received, cipherField), false);
      assert.equal(entry[cipherField], cipher);
      assert.equal(Object.hasOwn(entry, plainField), false);
      const serialized = JSON.stringify(target);
      assert.equal(serialized.includes(PASSWORD), false);
      assert.equal(serialized.includes(cipher), false);
    } finally {
      registerTarget(type, factory);
    }
  });

  test(`${type}: corrupt credentials produce a safe error and every operation stops before transport`, async () => {
    const cipher = 'qqac:v1:damaged-sensitive-ciphertext';
    let received;
    registerTarget(type, adapted => {
      received = adapted;
      return factory(adapted);
    });
    let target;
    try {
      // 无效 URL/bucket 也必须优先给出解封错误；不会进入网络层。
      target = createTarget({ type, [cipherField]: cipher });
    } finally {
      registerTarget(type, factory);
    }
    assert.ok(received.__credentialError);
    assert.equal(received.__credentialError.includes(cipher), false);
    assert.equal(Object.hasOwn(received, cipherField), false);
    const expected = { message: received.__credentialError };
    assert.deepEqual(await target.test(), { ok: false, ...expected });
    await assert.rejects(target.list(), expected);
    await assert.rejects(target.put('file.qqab', Buffer.from('data')), expected);
    await assert.rejects(target.get('file.qqab'), expected);
    await assert.rejects(target.remove('file.qqab'), expected);
    assert.equal(JSON.stringify(target).includes(cipher), false);
  });
}
