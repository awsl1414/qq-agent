import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-export-routes-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { createRoutes } = await import('../src/routes.js');
const { getConfig, updateConfig } = await import('../src/config.js');
const { parseBackup } = await import('../src/backup/archive.js');
const { decryptPayload } = await import('../src/backup/crypto.js');
const { parseZip } = await import('../src/zip-install.js');
const { registerTarget } = await import('../src/backup/targets/index.js');
const route = createRoutes({ readBody: async (body) => body, emit() {}, sanitizeConfig: (config) => config })
  .find((item) => item.method === 'POST' && item.pattern === '/api/backup/export');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

async function request(body) {
  const response = {};
  await route.handler({ req: body, res: {
    writeHead(status, headers) { Object.assign(response, { status, headers }); },
    end(buffer) { response.buffer = buffer; }
  }, json: (_res, status, data) => Object.assign(response, { status, data }) });
  return response;
}

test('export returns an authenticated ZIP of only the selected data, without uploads or history', async () => {
  fs.mkdirSync(path.join(temp, 'messages'), { recursive: true });
  const message = '{"messages":[{"id":42,"text":"offline copy"}]}';
  fs.writeFileSync(path.join(temp, 'messages', 'group_42.json'), message);
  let uploads = 0;
  registerTarget('export-test', () => ({ async put() { uploads++; } }));
  updateConfig({ backup: { enabled: false, targets: [{ id: 'unused', type: 'export-test', enabled: true, categories: ['messages'] }] } });
  const history = path.join(temp, 'backup-state.json');
  const previous = fs.existsSync(history) ? fs.readFileSync(history, 'utf8') : null;
  const response = await request({ categories: ['messages'] });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/zip');
  assert.match(response.headers['Content-Disposition'], /^attachment; filename="backup-.*\.zip"$/);
  assert.equal(response.headers['Content-Length'], response.buffer.length);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const parsed = parseBackup(response.buffer);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.manifest.categories.map((item) => item.key), ['messages']);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].name, 'data/messages/group_42.json');
  assert.equal(parsed.entries[0].data.toString(), message);
  assert.equal(uploads, 0);
  assert.equal(fs.existsSync(history) ? fs.readFileSync(history, 'utf8') : null, previous);
});

test('export works without targets, strips secrets by default and encrypts explicit secret exports', async () => {
  updateConfig({ api: { apiKey: 'export-secret-key' }, backup: { targets: [] } });
  const response = await request({ categories: ['configSafe'] });
  assert.equal(response.status, 200);
  const plain = parseBackup(response.buffer);
  assert.equal(plain.ok, true, plain.error);
  assert.equal(plain.manifest.encrypted, false);
  assert.ok(!Buffer.concat(plain.entries.map((entry) => entry.data)).toString().includes('export-secret-key'));
  const encryptedResponse = await request({ categories: ['configSafe'], includeSecrets: true });
  assert.equal(encryptedResponse.status, 200);
  const encrypted = parseBackup(encryptedResponse.buffer);
  assert.equal(encrypted.ok, true, encrypted.error);
  assert.equal(encrypted.manifest.encrypted, true);
  const decrypted = parseZip(decryptPayload(encrypted.ciphertext));
  assert.ok(decrypted.some((entry) => entry.data.toString().includes('export-secret-key')));
  assert.deepEqual(getConfig().backup.targets, []);
});

test('export rejects empty or invalid category choices and invalid secret flags as JSON', async () => {
  for (const body of [{ categories: [] }, { categories: ['unknown'] }, { categories: 'messages' }, { categories: ['messages'], includeSecrets: 'true' }]) {
    const result = await request(body);
    assert.equal(result.status, 400);
    assert.equal(result.data.ok, false);
    assert.ok(result.data.error);
    assert.equal(result.buffer, undefined);
  }
});
