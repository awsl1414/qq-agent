import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-file-restore-test-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { createRoutes } = await import('../src/routes.js');
const { getConfig } = await import('../src/config.js');
const { runRestore, restorePreview, startBackupOperations, stopBackupOperations } = await import('../src/backup/index.js');
const { receiveBackupUpload, discardBackupUpload, readBackupUpload } = await import('../src/backup/uploads.js');
const { BACKUP_FORMAT, BACKUP_VERSION, BACKUP_MAX_ARCHIVE_BYTES, computePayloadSha256 } = await import('../src/backup/archive.js');
const { signManifest, encryptPayload } = await import('../src/backup/crypto.js');
const { buildZip } = await import('../src/zip-build.js');
const { registerTarget } = await import('../src/backup/targets/index.js');
const { rollbackImport } = await import('../src/migrate.js');
const routes = createRoutes({ readBody: async (body) => body, emit() {}, sanitizeConfig: (config) => config });
let targetBuffer;
registerTarget('file-test', () => ({ async get() { return targetBuffer; } }));
getConfig().backup.targets = [{ id: 'same-package', type: 'file-test' }];
const targetInput = { targetId: 'same-package', key: 'backup.qqab' };
const entries = [
  { name: 'data/messages/group_42.json', data: Buffer.from('{"messages":[{"id":1,"mid":"a","text":"restore me"}]}') },
  { name: 'data/memory/group_42/7.json', data: Buffer.from('{"userId":"7","impressions":[{"content":"kind"}]}') },
  { name: 'data/usage-daily.json', data: Buffer.from('{"days":{"2026-11-01":{"tokens":10}}}') }
];
const ids = new Set();
after(() => {
  for (const id of ids) discardBackupUpload(id);
  fs.rmSync(root, { recursive: true, force: true });
});

function pack(payload = entries, { encrypted = false, innerZip, mutate = () => {} } = {}) {
  const ciphertext = encrypted ? encryptPayload(innerZip ?? buildZip(payload)) : null;
  const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, encrypted,
    files: payload.map((e) => ({ path: e.name, bytes: e.data.length })).sort((a, b) => a.path.localeCompare(b.path)),
    sha256: encrypted ? createHash('sha256').update(ciphertext).digest('hex') : computePayloadSha256(payload) };
  manifest.hmac = signManifest(manifest);
  mutate(manifest);
  return buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) },
    ...(encrypted ? [{ name: 'payload.enc', data: ciphertext }] : payload)]);
}

function stream(buffer, headers = {}) {
  return Object.assign(Readable.from([buffer]), { headers });
}

async function stage(buffer) {
  const fileId = await receiveBackupUpload(stream(buffer));
  ids.add(fileId);
  return { fileId };
}

async function request(method, endpoint, req = {}) {
  const url = new URL(endpoint, 'http://localhost');
  const route = routes.find((item) => item.method === method && item.pattern === url.pathname);
  assert.ok(route, endpoint);
  let response;
  await route.handler({ req, res: {}, url, json: (_res, status, data) => { response = { status, data }; } });
  if (response.data.fileId) ids.add(response.data.fileId);
  return response;
}

test('explicit selection restores only memory from a multi-category target package', async () => {
  targetBuffer = pack();
  const result = await runRestore({ ...targetInput, selection: { memory: true } });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(path.join(root, 'memory/group_42/7.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'messages/group_42.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'usage-daily.json')), false);
  assert.deepEqual(result.report.messages, []);
  assert.equal((await rollbackImport(result.backupId)).ok, true);
});

test('local export ZIP previews and restores through HTTP, and consumes its upload ID', async () => {
  fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
  const destination = path.join(root, 'messages/group_42.json');
  fs.writeFileSync(destination, entries[0].data);
  let exported;
  const route = routes.find((item) => item.pattern === '/api/backup/export');
  await route.handler({ req: { categories: ['messages'] }, res: {
    writeHead(status) { assert.equal(status, 200); }, end(buffer) { exported = buffer; }
  }, json() { assert.fail('export failed'); } });
  fs.unlinkSync(destination);
  const preview = await request('POST', '/api/backup/import-file', stream(exported));
  assert.equal(preview.status, 200, preview.data.error);
  assert.equal(fs.existsSync(destination), false, 'preview never imports');
  assert.equal(preview.data.scan.categories[0].chats, 1);
  assert.equal(preview.data.scan.categories[0].files, 1);
  assert.equal(preview.data.scan.categories[0].bytes, entries[0].data.length);
  const result = await request('POST', '/api/backup/restore', { fileId: preview.data.fileId, selection: { messages: preview.data.selection.messages } });
  assert.equal(result.status, 200, result.data.error);
  assert.equal(JSON.parse(fs.readFileSync(destination)).messages[0].text, 'restore me');
  assert.throws(() => readBackupUpload(preview.data.fileId), /过期|不存在/);
  assert.equal((await rollbackImport(result.data.backupId)).ok, true);
});

test('file and target previews share scan, selection defaults, and the same applyImport boundary', async () => {
  targetBuffer = pack();
  const input = await stage(targetBuffer);
  const filePreview = await restorePreview(input);
  const targetPreview = await restorePreview(targetInput);
  assert.deepEqual(filePreview, targetPreview);
  assert.deepEqual(filePreview.scan.categories.map((item) => item.key), ['messages', 'memory', 'stats']);
  assert.deepEqual(filePreview.selection.stats, { usageDaily: true });
  let calls = 0;
  const hooks = { storeInvalidate() {} };
  for (const source of [input, targetInput]) {
    const result = await runRestore({ ...source, hooks }, { applyImport: async (dir, selection, receivedHooks) => {
      calls++;
      assert.deepEqual(selection, filePreview.selection);
      assert.equal(receivedHooks, hooks);
      for (const entry of entries) assert.deepEqual(fs.readFileSync(path.join(dir, entry.name)), entry.data);
      return { ok: true };
    } });
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(calls, 2);
  discardBackupUpload(input.fileId);
});

test('encrypted uploaded package previews and really restores selected messages', async () => {
  const preview = await request('POST', '/api/backup/import-file', stream(pack(entries, { encrypted: true })));
  assert.equal(preview.status, 200, preview.data.error);
  assert.equal(preview.data.manifest.encrypted, true);
  const restored = await request('POST', '/api/backup/restore', { fileId: preview.data.fileId, selection: { messages: preview.data.selection.messages } });
  assert.equal(restored.status, 200, restored.data.error);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'messages/group_42.json'))).messages.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'memory/group_42/7.json')), false);
  assert.equal((await rollbackImport(restored.data.backupId)).ok, true);
});

function oversizedZip() {
  const zip = buildZip([{ name: 'data/wallpaper-static/bomb.txt', data: 'tiny' }]);
  const central = zip.readUInt32LE(zip.length - 6);
  zip.writeUInt32LE(512 * 1024 * 1024 + 1, central + 24);
  return zip;
}

test('corruption, forged HMAC, bad digest, traversal and zip limits reject identically on both sources before import', async () => {
  const traversal = [{ name: '../escape.txt', data: Buffer.from('bad') }];
  const badPackages = [
    Buffer.from('not a zip'),
    pack(entries, { mutate: (m) => { m.hmac = '0'.repeat(64); } }),
    pack(entries, { mutate: (m) => { m.sha256 = '0'.repeat(64); m.hmac = signManifest(m); } }),
    pack(traversal), oversizedZip(),
    pack(traversal, { encrypted: true }),
    pack(entries, { encrypted: true, innerZip: oversizedZip() }),
    buildZip(Array.from({ length: 20001 }, (_, i) => ({ name: `data/${i}.txt`, data: '' }))),
    pack(entries, { encrypted: true, innerZip: buildZip(Array.from({ length: 20001 }, (_, i) => ({ name: `data/${i}.txt`, data: '' }))) })
  ];
  let imports = 0;
  for (const buffer of badPackages) {
    targetBuffer = buffer;
    const input = await stage(buffer);
    const filePreview = await restorePreview(input);
    const targetPreview = await restorePreview(targetInput);
    assert.equal(filePreview.ok, false);
    assert.equal(filePreview.error, targetPreview.error);
    for (const source of [input, targetInput]) {
      const result = await runRestore(source, { applyImport: async () => { imports++; return { ok: true }; } });
      assert.equal(result.error, filePreview.error);
    }
    discardBackupUpload(input.fileId);
    const response = await request('POST', '/api/backup/import-file', stream(buffer));
    assert.equal(response.status, 400);
    assert.equal(response.data.error, filePreview.error);
    assert.equal(response.data.fileId, undefined);
  }
  assert.equal(imports, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'backup-restore')), []);
});

test('uploads enforce declared and actual byte limits, and a failed upload releases capacity', async () => {
  const declared = await request('POST', '/api/backup/import-file', stream(Buffer.from('x'), { 'content-length': String(BACKUP_MAX_ARCHIVE_BYTES + 1) }));
  assert.equal(declared.status, 413);
  // allocUnsafe reserves memory without touching it; the receiver must reject before reading/writing the bytes.
  const oversized = await request('POST', '/api/backup/import-file', stream(Buffer.allocUnsafe(BACKUP_MAX_ARCHIVE_BYTES + 1)));
  assert.equal(oversized.status, 413);
  const input = await stage(pack());
  assert.equal((await restorePreview(input)).ok, true);
  discardBackupUpload(input.fileId);
});

test('binary upload supports real archives larger than the ordinary 16 MiB JSON hard limit', async () => {
  const buffer = pack([{ name: 'data/wallpaper-static/large.bin', data: randomBytes(17 * 1024 * 1024) }]);
  assert.ok(buffer.length > 16 * 1024 * 1024);
  const preview = await request('POST', '/api/backup/import-file', stream(buffer));
  assert.equal(preview.status, 200, preview.data.error);
  assert.equal(preview.data.scan.categories[0].key, 'wallpaper');
  await request('DELETE', '/api/backup/import-file?' + new URLSearchParams({ fileId: preview.data.fileId }));
  assert.throws(() => readBackupUpload(preview.data.fileId), /过期|不存在/);
});

test('unknown IDs and mixed file/target sources are rejected; canceled uploads cannot restore', async () => {
  const input = await stage(pack());
  assert.equal((await restorePreview({ ...input, ...targetInput })).ok, false);
  await request('DELETE', '/api/backup/import-file?' + new URLSearchParams(input));
  for (const fileId of [input.fileId, '../config.json']) {
    assert.equal((await runRestore({ fileId })).ok, false);
  }
});

test('preview exposes all 13 restorable categories including root-level config, modules and drafts', async () => {
  const payload = [...entries,
    ...['persona', 'customPersonas', 'lists', 'configSafe'].map((key) => ({ name: `config-fields/${key}.json`, data: Buffer.from('{}') })),
    ...['data/reminders.json', 'data/stickers.json', 'data/wallpaper-imports.json', 'data/desktop-pet/state.json',
      'modules/plugins/demo/plugin.json', 'modules/plugins/demo/index.js', 'drafts/demo/plugin.json'].map((name) => ({ name, data: Buffer.from('{}') }))
  ];
  const input = await stage(pack(payload));
  const preview = await restorePreview(input);
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.scan.categories.length, 13);
  for (const item of preview.scan.categories) {
    assert.ok(preview.selection[item.key], item.key);
    assert.ok(item.files > 0, item.key);
    assert.ok(item.bytes > 0, item.key);
  }
  assert.equal(preview.selection.wallpaper, true, 'imports-only wallpapers are restorable');
  assert.equal(preview.selection.drafts, true, 'restore defaults include drafts present in the package');
  discardBackupUpload(input.fileId);
});

test('upload expiry releases files and shutdown drains pending uploads before cleaning', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const expiring = await stage(pack());
  t.mock.timers.tick(30 * 60 * 1000);
  assert.throws(() => readBackupUpload(expiring.fileId), /过期|不存在/);
  t.mock.timers.reset();
  const saved = await stage(pack());
  const req = new PassThrough();
  const pending = receiveBackupUpload(req);
  const settled = Promise.allSettled([pending]);
  try {
    await stopBackupOperations();
    const [result] = await settled;
    assert.equal(req.destroyed, true);
    if (result.status === 'fulfilled') assert.throws(() => readBackupUpload(result.value), /过期|不存在/);
    assert.throws(() => readBackupUpload(saved.fileId), /过期|不存在/);
    await assert.rejects(receiveBackupUpload(stream(pack())), /正在停止/);
  } finally { startBackupOperations(); }
});
