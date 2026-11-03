import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-routes-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { createRoutes } = await import('../src/routes.js');
const { getConfig } = await import('../src/config.js');
const { decryptCredential, signManifest } = await import('../src/backup/crypto.js');
const { registerTarget } = await import('../src/backup/targets/index.js');
const { buildZip } = await import('../src/zip-build.js');
const { BACKUP_FORMAT, BACKUP_VERSION, computePayloadSha256 } = await import('../src/backup/archive.js');
const { skillManager } = await import('../src/skills/manager.js');
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

test('backup categories expose all 13 choices, default flags and actual collected sizes', async () => {
  const pet = Buffer.alloc(4096, 1);
  fs.mkdirSync(path.join(temp, 'desktop-pet'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'desktop-pet', 'model.bin'), pet);
  const response = await request('GET', '/api/backup/targets');
  assert.equal(response.status, 200);
  const categories = response.data.categories;
  assert.deepEqual(categories.map((item) => item.key).sort(), ['messages', 'memory', 'usage', 'reminders', 'stickers', 'persona', 'customPersonas', 'lists', 'configSafe', 'wallpaper', 'desktopPet', 'extensions', 'drafts'].sort());
  for (const item of categories) {
    assert.equal(item.defaultOn, item.key !== 'drafts', item.key);
    assert.equal(typeof item.bytes, 'number', item.key);
    assert.ok(item.bytes >= 0);
  }
  assert.equal(categories.find((item) => item.key === 'desktopPet').bytes, pet.length);
  assert.match(categories.find((item) => item.key === 'configSafe').desc, /不含 API Key 与账号凭据/);
});

test('backup routes preserve per-target package keys when target categories differ', async () => {
  fs.mkdirSync(path.join(temp, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'memory', 'friend.json'), '{"impression":"friend"}');
  registerTarget('route-multi', () => ({ async put() {}, async list() { return []; } }));
  await request('POST', '/api/backup/config', { targets: [
    { id: 'messages-only', type: 'route-multi', enabled: true, categories: ['messages'] },
    { id: 'memory-only', type: 'route-multi', enabled: true, categories: ['memory'] }
  ] });
  const result = await request('POST', '/api/backup/run');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.key, undefined);
  assert.equal(result.data.keys.length, 2);
  assert.equal(result.data.packages.length, 2);
  assert.notEqual(result.data.targets[0].key, result.data.targets[1].key);
  assert.ok(result.data.targets.every((target) => result.data.keys.includes(target.key)));
});

test('backup restore routes forward selection and forge hooks with the recorded draft id, reload config and allow rollback', async (t) => {
  const entries = [
    { name: 'config-fields/customPersonas.json', data: Buffer.from(JSON.stringify({ customPersonas: [{ id: 'restored-route-persona', name: 'route persona' }] })) },
    { name: 'modules/plugins/route-demo/plugin.json', data: Buffer.from(JSON.stringify({ id: 'route-demo', entry: 'index.js' })) },
    { name: 'modules/plugins/route-demo/index.js', data: Buffer.from('export default {};') }
  ];
  const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, encrypted: false,
    categories: [{ key: 'customPersonas' }, { key: 'extensions' }], sha256: computePayloadSha256(entries),
    files: entries.map(e => ({ path: e.name, bytes: e.data.length })).sort((a, b) => a.path.localeCompare(b.path)) };
  manifest.hmac = signManifest(manifest);
  const zip = buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...entries]);
  registerTarget('route-restore', () => ({ async get() { return zip; } }));
  await request('POST', '/api/backup/config', { targets: [{ id: 'restore', type: 'route-restore', enabled: true }] });
  const imported = [];
  const discarded = [];
  t.mock.method(skillManager, 'getCapabilityProviders', (capability) => {
    const handlers = {
      'forge.import-zip': (input) => { imported.push(input); return { ok: true, draftId: input.draftId }; },
      'forge.gate': ({ draftId }) => ({ ok: true, draftId }),
      'forge.discard': ({ draftId }) => { discarded.push(draftId); return { ok: true }; }
    };
    return handlers[capability] ? [{ fn: handlers[capability] }] : [];
  });
  const input = { targetId: 'restore', key: 'route-backup.zip' };
  const preview = await request('POST', '/api/backup/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.scan.modules.length, 1);
  const restored = await request('POST', '/api/backup/restore', { ...input, selection: { customPersonas: true, modules: ['plugin:route-demo'] } });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(imported.length, 1);
  assert.match(imported[0].draftId, /^restore-/);
  assert.equal(restored.data.report.modules[0].draftId, imported[0].draftId);
  assert.ok(getConfig().customPersonas.some((persona) => persona.id === 'restored-route-persona'));
  const rollback = await request('POST', '/api/backup/rollback', { backupId: restored.data.backupId });
  assert.equal(rollback.status, 200, JSON.stringify(rollback.data));
  assert.deepEqual(discarded, [imported[0].draftId]);
  assert.ok(!getConfig().customPersonas.some((persona) => persona.id === 'restored-route-persona'));
});
