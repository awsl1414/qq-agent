import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-routes-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { createRoutes } = await import('../src/routes.js');
const { getConfig } = await import('../src/config.js');
const { decryptCredential } = await import('../src/backup/crypto.js');
const { registerTarget } = await import('../src/backup/targets/index.js');
const routes = createRoutes({ readBody: async (body) => body, emit() {}, sanitizeConfig: (config) => config });
after(() => fs.rmSync(temp, { recursive: true, force: true }));

async function request(method, pathname, body = {}) {
  const route = routes.find((item) => item.method === method && item.pattern === pathname);
  assert.ok(route, pathname);
  let response;
  await route.handler({ req: body, res: {}, url: new URL(pathname, 'http://localhost'), json: (_res, status, data) => { response = { status, data }; } });
  return response;
}

test('backup config contract: three target types round-trip with masked credentials and blank means unchanged', async () => {
  const targets = [
    { id: 'local', type: 'local', name: 'local', enabled: true, dir: temp, categories: ['messages'] },
    { id: 'dav', type: 'webdav', name: 'dav', enabled: true, url: 'https://nas.test/dav', username: 'dav-user', password: 'dav-password', categories: ['memory'] },
    { id: 's3', type: 's3', name: 's3', enabled: true, endpoint: 'https://s3.test', region: 'auto', bucket: 'backups', accessKeyId: 'access-id', secretAccessKey: 'secret-key', forcePathStyle: false, categories: ['usage'] }
  ];
  const saved = await request('POST', '/api/backup/config', { enabled: false, intervalHours: 12, retention: 3, includeSecrets: false, targets });
  assert.equal(saved.status, 200);
  const serialized = JSON.stringify(saved.data);
  for (const secret of ['dav-user', 'dav-password', 'access-id', 'secret-key']) assert.ok(!serialized.includes(secret));
  assert.equal(saved.data.config.targets[1].hasCredentials, true);
  assert.equal(saved.data.config.targets[2].hasSecretAccessKeyCipher, true);
  assert.equal(saved.data.config.targets[2].forcePathStyle, false);
  assert.deepEqual(saved.data.config.targets.map((target) => target.categories), [['messages'], ['memory'], ['usage']]);
  const blankPatch = structuredClone(saved.data.config);
  Object.assign(blankPatch.targets[1], { username: '', password: '' });
  Object.assign(blankPatch.targets[2], { accessKeyId: '', secretAccessKey: '' });
  assert.equal((await request('POST', '/api/backup/config', blankPatch)).status, 200);
  const actual = getConfig().backup.targets;
  assert.equal(actual[1].username, 'dav-user');
  assert.equal(decryptCredential(actual[1].credentials), 'dav-password');
  assert.equal(actual[2].accessKeyId, 'access-id');
  assert.equal(decryptCredential(actual[2].secretAccessKeyCipher), 'secret-key');
  const read = await request('GET', '/api/backup/config');
  assert.deepEqual(read.data.config, saved.data.config);
});

test('backup run contract: failed target details survive all-failed HTTP errors and partial-success responses', async () => {
  fs.mkdirSync(path.join(temp, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'messages', 'group_1.json'), '{"messages":[]}');
  let successful = false;
  registerTarget('route-review', (entry) => ({
    type: 'route-review',
    async put() { if (!successful || entry.id === 'failed') throw new Error('认证失败（401），请检查凭据'); },
    async list() { return []; }
  }));
  await request('POST', '/api/backup/config', { targets: ['success', 'failed'].map((id) => ({ id, type: 'route-review', enabled: true, categories: ['messages'] })) });
  const failed = await request('POST', '/api/backup/run');
  assert.equal(failed.status, 400);
  assert.match(failed.data.error, /success：认证失败/);
  assert.match(failed.data.error, /failed：认证失败/);
  successful = true;
  const partial = await request('POST', '/api/backup/run');
  assert.equal(partial.status, 200);
  assert.equal(partial.data.ok, true);
  assert.equal(partial.data.partial, true);
  assert.equal(partial.data.targets.find((target) => target.id === 'success').ok, true);
  assert.match(partial.data.targets.find((target) => target.id === 'failed').error, /401/);
});

test('backup connection failures provide error text consumable by the shared api helper', async () => {
  await request('POST', '/api/backup/config', { targets: [{ id: 'missing-path', type: 'local', enabled: true, dir: '', categories: ['messages'] }] });
  const failed = await request('POST', '/api/backup/test', { targetId: 'missing-path' });
  assert.equal(failed.status, 400);
  assert.equal(failed.data.ok, false);
  assert.match(failed.data.error, /目录/);
});
