import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-hardening-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { buildBackup, parseBackup, computePayloadSha256 } = await import('../src/backup/archive.js');
const { parseZip } = await import('../src/zip-install.js');
const { buildZip } = await import('../src/zip-build.js');
const { getConfig } = await import('../src/config.js');
const { runBackup, inspectBackup } = await import('../src/backup/index.js');
const { createLocalTarget } = await import('../src/backup/targets/local.js');
const { createWebdavTarget } = await import('../src/backup/targets/webdav.js');
const { createS3Target } = await import('../src/backup/targets/s3.js');
const { registerTarget } = await import('../src/backup/targets/index.js');
const {
  BACKUP_DOWNLOAD_MAX_BYTES, BACKUP_LIST_PAGE_MAX_BYTES, BACKUP_LIST_MAX_PAGES_COUNT,
  BACKUP_LIST_MAX_ENTRIES_COUNT, BACKUP_LIST_MAX_DEPTH_LEVELS, BACKUP_LIMIT_ERROR_CODE,
  readBoundedResponse
} = await import('../src/backup/targets/limits.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'messages'));
fs.mkdirSync(path.join(root, 'memory'));
fs.writeFileSync(path.join(root, 'messages', 'group_1.json'), '{"messages":[{"text":"private message"}]}');
fs.writeFileSync(path.join(root, 'memory', 'friend.json'), '{"memory":"private memory"}');

function repack(built, mutate) {
  const entries = parseZip(built.buffer);
  const manifest = JSON.parse(entries.find(e => e.name === 'manifest.json').data);
  const payload = entries.filter(e => e.name !== 'manifest.json');
  mutate(manifest, payload);
  return buildZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, ...payload]);
}

test('v2 authenticates plaintext even if the attacker recomputes the payload digest', () => {
  const built = buildBackup({ categories: ['messages'] });
  assert.equal(built.ok, true, built.error);
  assert.equal(built.manifest.version, 2);
  assert.equal(parseBackup(built.buffer).authenticated, true);
  const tampered = repack(built, (manifest, payload) => {
    payload[0].data = Buffer.from('attacker data');
    manifest.sha256 = computePayloadSha256(payload);
  });
  for (const verify of [true, false]) {
    const parsed = parseBackup(tampered, { verify });
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /HMAC/);
  }
});

test('authenticated file boundaries cannot be changed while preserving the old concatenated digest', () => {
  const file = path.join(root, 'messages', 'group_1.json');
  const original = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, 'firstdata/messages/group_2.json\0second');
    const built = buildBackup({ categories: ['messages'] });
    const tampered = repack(built, (manifest, payload) => {
      payload[0].data = Buffer.from('first');
      payload.push({ name: 'data/messages/group_2.json', data: Buffer.from('second') });
      assert.equal(computePayloadSha256(payload), manifest.sha256);
    });
    const parsed = parseBackup(tampered);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /文件清单/);
  } finally { fs.writeFileSync(file, original); }
});

test('manifest fields are bound to both plaintext and encrypted payloads with stable key ordering', () => {
  for (const encrypt of [false, true]) {
    const built = buildBackup({ categories: ['messages'], encrypt });
    for (const field of ['instanceId', 'categories', 'files', 'encrypted', 'version']) {
      const parsed = parseBackup(repack(built, manifest => { manifest[field] = 'tampered'; }));
      assert.equal(parsed.ok, false, field);
      assert.match(parsed.error, /HMAC/);
    }
    const reordered = repack(built, manifest => {
      const fields = Object.entries(manifest).reverse();
      for (const key of Object.keys(manifest)) delete manifest[key];
      Object.assign(manifest, Object.fromEntries(fields));
    });
    assert.equal(parseBackup(reordered).authenticated, true);
    const missing = parseBackup(repack(built, manifest => { delete manifest.hmac; }));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /HMAC/);
  }
});

test('v1 packages remain readable and explicitly unauthenticated, including details API', async () => {
  const dir = path.join(root, 'legacy');
  getConfig().backup = { targets: [{ id: 'legacy', type: 'local', dir }] };
  for (const encrypt of [false, true]) {
    const legacy = repack(buildBackup({ categories: ['messages'], encrypt }), manifest => {
      manifest.version = 1;
      delete manifest.hmac;
    });
    const parsed = parseBackup(legacy);
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.authenticated, false);
    await createLocalTarget({ dir }).put('legacy.qqab', legacy);
    const detail = await inspectBackup({ targetId: 'legacy', key: 'legacy.qqab' });
    assert.equal(detail.ok, true, detail.error);
    assert.equal(detail.authenticated, false);
  }
});

test('targets with different selections receive only their categories; equal normalized sets reuse a package', async () => {
  const received = new Map();
  registerTarget('hardening', entry => ({
    put: async (key, buffer) => { received.set(entry.id, { key, buffer }); },
    list: async () => [], remove: async () => {}
  }));
  getConfig().backup = { targets: [
    { id: 'A', type: 'hardening', enabled: true, categories: ['messages'] },
    { id: 'B', type: 'hardening', enabled: true, categories: ['memory'] },
    { id: 'C', type: 'hardening', enabled: true, categories: ['messages', 'messages', 'unknown'] }
  ] };
  const result = await runBackup();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.keys.length, 2);
  assert.equal(result.key, undefined);
  assert.equal(received.get('A').buffer, received.get('C').buffer);
  assert.notEqual(received.get('A').key, received.get('B').key);
  for (const [id, own, other] of [['A', 'messages', 'memory'], ['B', 'memory', 'messages']]) {
    const parsed = parseBackup(received.get(id).buffer);
    assert.deepEqual(parsed.manifest.categories.map(c => c.key), [own]);
    assert.ok(parsed.entries.some(e => e.name.startsWith(`data/${own}/`)));
    assert.equal(parsed.entries.some(e => e.name.startsWith(`data/${other}/`)), false);
    assert.equal(result.targets.find(t => t.id === id).key, received.get(id).key);
  }
});

test('one group failing construction does not prevent a successful group or widen empty selections', async () => {
  getConfig().backup.targets = [
    { id: 'ok', type: 'hardening', enabled: true, categories: ['messages'] },
    { id: 'empty', type: 'hardening', enabled: true, categories: [] }
  ];
  const result = await runBackup();
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.targets.map(t => t.ok), [true, false]);
  assert.match(result.targets[1].error, /没有选中/);
  assert.equal(result.targets[1].key, undefined);
});

test('stream budgets enforce actual bytes and cancel on overflow, including misleading Content-Length', async () => {
  for (const contentLength of [null, '1']) {
    let cancelled = false;
    let reads = 0;
    const response = {
      headers: new Headers(contentLength ? { 'content-length': contentLength } : {}),
      body: new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(5)); },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 })
    };
    await assert.rejects(readBoundedResponse(response, 8), { code: BACKUP_LIMIT_ERROR_CODE });
    assert.equal(cancelled, true);
    assert.equal(reads, 2);
  }
  assert.equal((await readBoundedResponse(new Response('12345678'), 8)).toString(), '12345678');
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '9' } });
  await assert.rejects(readBoundedResponse(response, 8), { code: BACKUP_LIMIT_ERROR_CODE });
  assert.equal(cancelled, true);
});

async function remote(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return [createWebdavTarget({ url }), createS3Target({ endpoint: url, bucket: 'backups', accessKeyId: 'test', secretAccessKey: 'test' })];
}

test('WebDAV and S3 reject oversized Content-Length downloads without retries', async t => {
  let requests = 0;
  const targets = await remote(t, (req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Length': BACKUP_DOWNLOAD_MAX_BYTES + 1 });
    res.flushHeaders();
  });
  for (const target of targets) await assert.rejects(target.get('large.qqab'), { code: BACKUP_LIMIT_ERROR_CODE });
  assert.equal(requests, 2);
});

test('WebDAV and S3 limit chunked listing XML by actual bytes', async t => {
  const targets = await remote(t, (req, res) => {
    res.writeHead(req.method === 'PROPFIND' ? 207 : 200);
    res.end('x'.repeat(BACKUP_LIST_PAGE_MAX_BYTES + 1));
  });
  for (const target of targets) await assert.rejects(target.list(), { code: BACKUP_LIMIT_ERROR_CODE });
});

const davResponse = (key, collection = true) => `<response><href>/${key}</href><propstat><status>HTTP/1.1 200 OK</status><prop><resourcetype>${collection ? '<collection/>' : ''}</resourcetype></prop></propstat></response>`;

test('S3 pagination with unique tokens still stops at the total page budget', async t => {
  let requests = 0;
  const [, target] = await remote(t, (req, res) => {
    requests++;
    res.end(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>${requests}</NextContinuationToken></ListBucketResult>`);
  });
  await assert.rejects(target.list(), { code: BACKUP_LIMIT_ERROR_CODE });
  assert.equal(requests, BACKUP_LIST_MAX_PAGES_COUNT);
});

test('WebDAV breadth cannot exceed the total directory page budget', async t => {
  let requests = 0;
  const [target] = await remote(t, (req, res) => {
    requests++;
    res.writeHead(207).end(`<multistatus>${Array.from({ length: BACKUP_LIST_MAX_PAGES_COUNT }, (_, i) => davResponse(`d${i}/`)).join('')}</multistatus>`);
  });
  await assert.rejects(target.list(), { code: BACKUP_LIMIT_ERROR_CODE });
  assert.equal(requests, 1);
});

test('remote lists reject too many entries and excessive key depth', async t => {
  for (const mode of ['entries', 'depth']) {
    const targets = await remote(t, (req, res) => {
      const keys = mode === 'entries' ? Array(BACKUP_LIST_MAX_ENTRIES_COUNT + 1).fill('f') : [Array(BACKUP_LIST_MAX_DEPTH_LEVELS + 1).fill('d').join('/')];
      if (req.method === 'PROPFIND') res.writeHead(207).end(`<multistatus>${keys.map(key => davResponse(key, false)).join('')}</multistatus>`);
      else res.end(`<ListBucketResult>${keys.map(key => `<Contents><Key>${key}</Key><Size>0</Size></Contents>`).join('')}</ListBucketResult>`);
    });
    for (const target of targets) await assert.rejects(target.list(), { code: BACKUP_LIMIT_ERROR_CODE });
  }
});

test('local download checks stat before reading and still bounds a file that grows after stat', async () => {
  const dir = path.join(root, 'local-limit');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'large.qqab');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, BACKUP_DOWNLOAD_MAX_BYTES + 1);
  await assert.rejects(createLocalTarget({ dir }).get('large.qqab'), { code: BACKUP_LIMIT_ERROR_CODE });
  const original = fsp.open;
  let closed = false;
  fsp.open = async () => ({
    stat: async () => ({ isFile: () => true, size: 0 }),
    read: async () => ({ bytesRead: BACKUP_DOWNLOAD_MAX_BYTES + 1 }),
    close: async () => { closed = true; }
  });
  try { await assert.rejects(createLocalTarget({ dir }).get('large.qqab'), { code: BACKUP_LIMIT_ERROR_CODE }); }
  finally { fsp.open = original; }
  assert.equal(closed, true);
});
