import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-migrate-config-modules-'));
const target = path.join(root, 'target');
process.env.QQ_AGENT_DATA_DIR = target;
const { applyImport, rollbackImport, scanSource } = await import('../src/migrate.js');
const { parseZip } = await import('../src/zip-install.js');
const { logger } = await import('../src/logger.js');
logger.mirrorConsole = false;
beforeEach(() => {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function source() {
  return fs.mkdtempSync(path.join(root, 'source-'));
}
function write(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function read(rel) {
  return JSON.parse(fs.readFileSync(path.join(target, rel), 'utf8'));
}
function manifest(report) {
  return read(path.join(report.backupDir, 'manifest.json'));
}
function extension(dir, kind = 'plugins', name = 'user-demo', code = 'export default {};', entry = 'index.js') {
  const rel = path.join('modules', kind, name);
  write(dir, path.join(rel, kind === 'plugins' ? 'plugin.json' : 'skill.json'), { id: name, entry });
  write(dir, path.join(rel, 'index.js'), code);
  return `${kind.slice(0, -1)}:${name}`;
}

test('all four config categories merge by id/key, preserve local values and roll back exact original bytes', async () => {
  const dir = source();
  const local = {
    persona: { roleText: 'local' }, personaByChat: { existing: { roleText: 'local chat' } }, personaUnified: false,
    customPersonas: [{ id: 'same', name: 'local' }],
    allow: { groups: ['1'], private: ['2'] }, deny: { groups: ['3'] },
    blocklist: { chat: ['4'] }, globalBlocklist: ['5'], communityExemptions: ['6'],
    api: { apiKey: 'sk-local' }, server: { token: 'local-server' },
    tools: { enabled: false, service: { apiKey: 'local-tool-secret', url: 'local-url' } },
    extensions: { hotReload: false },
    skills: { 'account-pool': { accounts: [{ id: 'local', apiKey: 'local-account' }] }, demo: { token: 'local-skill-secret', enabled: false } }
  };
  const original = `\uFEFF${JSON.stringify(local, null, 2)}\n`;
  write(target, 'config.json', original);
  write(dir, 'config-fields/persona.json', {
    persona: { roleText: 'remote', botName: 'restored' }, personaByChat: { existing: { roleText: 'remote chat' }, newChat: { roleText: 'new' } },
    personaUnified: true, api: { apiKey: 'unwanted' }
  });
  write(dir, 'config-fields/customPersonas.json', { customPersonas: [{ id: 'same', name: 'remote' }, { id: 'new' }, { id: 'new', name: 'duplicate' }, {}, null] });
  write(dir, 'config-fields/lists.json', {
    allow: { groups: ['1', '7', '7'], private: ['8'] }, deny: { groups: ['3', '9'], private: ['10'] },
    blocklist: { chat: ['4', '11'], newChat: ['12'] }, globalBlocklist: ['5', '13'], communityExemptions: ['6', '14', '14']
  });
  write(dir, 'config-fields/configSafe.json', {
    api: { apiKey: 'sk-incoming' }, server: { token: 'remote-server' }, trustedPlugins: ['malicious'],
    tools: { enabled: true, service: { apiKey: 'remote-tool-secret', url: 'remote-url', timeout: 100 } },
    extensions: { hotReload: true, added: true },
    skills: { 'account-pool': { accounts: [{ id: 'remote', apiKey: 'remote-account' }] }, demo: { token: 'remote-secret', enabled: true, extra: 'restored' }, added: { enabled: false } }
  });
  let reloaded = 0;
  const hooks = { configReload: () => { reloaded += 1; } };
  const r = await applyImport(dir, { persona: true, customPersonas: true, lists: true, configSafe: true }, hooks);
  assert.equal(r.ok, true, r.error);
  assert.ok(Object.values(r.configFields).every((value) => value.ok));
  assert.deepEqual(read('config.json'), {
    ...local,
    persona: { roleText: 'local', botName: 'restored' },
    personaByChat: { existing: { roleText: 'local chat' }, newChat: { roleText: 'new' } },
    customPersonas: [{ id: 'same', name: 'local' }, { id: 'new' }],
    allow: { groups: ['1', '7'], private: ['2', '8'] }, deny: { groups: ['3', '9'], private: ['10'] },
    blocklist: { chat: ['4', '11'], newChat: ['12'] }, globalBlocklist: ['5', '13'], communityExemptions: ['6', '14'],
    tools: { enabled: false, service: { apiKey: 'local-tool-secret', url: 'local-url', timeout: 100 } },
    extensions: { hotReload: false, added: true },
    skills: { ...local.skills, demo: { token: 'local-skill-secret', enabled: false, extra: 'restored' }, added: { enabled: false } }
  });
  assert.equal(reloaded, 1);
  assert.deepEqual(manifest(r).actions.map((a) => a.category), ['persona', 'customPersonas', 'lists', 'configSafe']);
  assert.ok(manifest(r).actions.every((a) => a.type === 'config-fields' && a.target === 'config.json' && a.backup === 'config.json'));
  assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), original);
  assert.equal(reloaded, 2);
});

test('config-only package creates a missing config, excludes account-pool and rollback removes the new file', async () => {
  const dir = source();
  write(dir, 'config-fields/persona.json', { personaUnified: false });
  write(dir, 'config-fields/configSafe.json', { skills: { 'account-pool': { token: 'remote' }, demo: { enabled: true } }, api: { apiKey: 'remote' } });
  const scan = scanSource(dir);
  assert.equal(scan.ok, true);
  assert.equal(scan.configFields.persona.available, true);
  const r = await applyImport(dir, { persona: true, configSafe: true });
  assert.equal(r.ok, true);
  assert.deepEqual(read('config.json'), { personaUnified: false, skills: { demo: { enabled: true } } });
  assert.ok(manifest(r).actions.every((a) => a.backup === null));
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
});

test('malformed source or local config is reported without destroying local data', async () => {
  const dir = source();
  write(dir, 'config-fields/persona.json', '{broken');
  write(target, 'config.json', { personaUnified: false });
  let r = await applyImport(dir, { persona: true });
  assert.equal(r.ok, false);
  assert.deepEqual(manifest(r).actions, []);
  assert.deepEqual(read('config.json'), { personaUnified: false });
  write(dir, 'config-fields/persona.json', { personaUnified: true });
  write(target, 'config.json', '{local-corrupt');
  r = await applyImport(dir, { persona: true });
  assert.equal(r.ok, false);
  assert.deepEqual(manifest(r).actions, []);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{local-corrupt');
});

test('local null, false and empty values win; incoming prototype keys are never assigned', async () => {
  const dir = source();
  write(target, 'config.json', { persona: { roleText: '', nullable: null }, personaUnified: false });
  write(dir, 'config-fields/persona.json', '{"persona":{"roleText":"remote","nullable":"remote","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},"personaUnified":true}');
  const r = await applyImport(dir, { persona: true });
  assert.equal(r.ok, true);
  assert.deepEqual(read('config.json'), { persona: { roleText: '', nullable: null }, personaUnified: false });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(manifest(r).actions, []);
});

test('modules call capability scan, import-zip and gate, record actions before staging, and require later confirmation', async () => {
  const dir = source();
  const keys = [extension(dir), extension(dir, 'skills', 'user-skill')];
  const events = [];
  const hooks = {
    checkPluginTrust: (id, entry) => { events.push(['trust', id]); assert.equal(path.basename(entry), 'index.js'); return { ok: true }; },
    forgeImportZip: ({ zipBase64, zipName, draftId }) => {
      events.push(['stage', draftId]);
      assert.match(zipName, /\.zip$/);
      assert.match(draftId, /^restore-/);
      assert.deepEqual(parseZip(Buffer.from(zipBase64, 'base64')).map((e) => e.name).sort(), ['index.js', zipName.startsWith('plugin-') ? 'plugin.json' : 'skill.json']);
      const backup = fs.readdirSync(path.join(target, 'import-backups'))[0];
      assert.ok(read(path.join('import-backups', backup, 'manifest.json')).actions.some((a) => a.draftId === draftId));
      return { ok: true, draftId };
    },
    forgeGate: ({ draftId }) => { events.push(['gate', draftId]); return { ok: true, confirm: 0 }; },
    forgeDiscard: ({ draftId }) => { events.push(['discard', draftId]); return { ok: true }; },
    forgeInstall: () => assert.fail('restoring must never install an extension'),
    forgeConfirmTicket: () => assert.fail('restoring must never issue approval')
  };
  assert.deepEqual(scanSource(dir).modules.map((m) => m.key), keys);
  const r = await applyImport(dir, { extensions: true }, hooks);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.modules.length, 2);
  assert.ok(r.modules.every((m) => m.ok && m.needConfirm && m.draftId && m.gate.ok));
  assert.deepEqual(events.map(([event]) => event), ['trust', 'stage', 'gate', 'trust', 'stage', 'gate']);
  assert.deepEqual(fs.readdirSync(target), ['import-backups']);
  assert.deepEqual(manifest(r).actions.map((a) => a.type), ['modules', 'modules']);
  const rollback = await rollbackImport(r.backupId, hooks);
  assert.equal(rollback.ok, true);
  assert.equal(rollback.removed, 2);
  assert.deepEqual(events.filter(([event]) => event === 'discard').map(([, id]) => id), r.modules.map((m) => m.draftId));
});

test('real capability scan rejects dangerous code before invoking any forge writer', async () => {
  const dir = source();
  extension(dir, 'plugins', 'unsafe-extension', "import fs from 'node:fs'; export default {};");
  const r = await applyImport(dir, { extensions: true }, {
    forgeImportZip: () => assert.fail('unsafe code cannot reach staging'),
    forgeGate() {}, forgeDiscard() {}
  });
  assert.equal(r.ok, false);
  assert.match(r.modules[0].error, /高危/);
  assert.deepEqual(manifest(r).actions, []);
  assert.deepEqual(fs.readdirSync(target), ['import-backups']);
});

test('selecting module keys only stages chosen extensions and missing forge hooks fail closed', async () => {
  const dir = source();
  extension(dir);
  const key = extension(dir, 'skills', 'selected');
  const r = await applyImport(dir, { modules: [key] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.modules.map((m) => m.key), [key]);
  assert.match(r.modules[0].error, /未就绪/);
  assert.deepEqual(manifest(r).actions, []);
});

for (const failure of ['import', 'gate']) {
  test(`module ${failure} failure keeps rollback information for partial staging`, async () => {
    const dir = source();
    extension(dir);
    const staged = new Set();
    const hooks = {
      checkPluginTrust: () => ({ ok: true }),
      forgeImportZip: ({ draftId }) => { staged.add(draftId); if (failure === 'import') throw new Error('partial import'); return { ok: true, draftId }; },
      forgeGate: () => ({ ok: false, error: 'gate blocked' }),
      forgeDiscard: ({ draftId }) => { staged.delete(draftId); return { ok: true }; }
    };
    const r = await applyImport(dir, { extensions: true }, hooks);
    assert.equal(r.ok, false);
    assert.equal(staged.size, 1);
    assert.equal(manifest(r).actions[0].draftId, r.modules[0].draftId);
    const withoutForge = await rollbackImport(r.backupId);
    assert.equal(withoutForge.ok, false);
    assert.equal(withoutForge.failed, 1);
    assert.equal(staged.size, 1);
    assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
    assert.equal(staged.size, 0);
  });
}

test('combined config and module rollback restores configuration and removes only the recorded draft', async () => {
  const dir = source();
  extension(dir);
  write(target, 'config.json', '{ "personaUnified": false }\n');
  write(dir, 'config-fields/persona.json', { persona: { roleText: 'restored' } });
  const drafts = new Set(['unrelated-local-draft']);
  const hooks = {
    forgeImportZip: ({ draftId }) => { drafts.add(draftId); return { ok: true, draftId }; },
    forgeGate: () => ({ ok: true }),
    forgeDiscard: ({ draftId }) => { drafts.delete(draftId); return { ok: true }; }
  };
  const r = await applyImport(dir, { persona: true, extensions: true }, hooks);
  assert.equal(r.ok, true);
  assert.deepEqual(manifest(r).actions.map((a) => a.type), ['config-fields', 'modules']);
  assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{ "personaUnified": false }\n');
  assert.deepEqual([...drafts], ['unrelated-local-draft']);
});

test('legacy data directory and old data-only package keep message merge and rollback behavior', async () => {
  for (const packaged of [false, true]) {
    const dir = source();
    const local = { chatKey: 'group:42', messages: [{ id: 1, mid: 'same', text: 'local', read: true }], nextLocalId: 2 };
    write(target, 'messages/group_42.json', local);
    write(dir, `${packaged ? 'data/' : ''}messages/group_42.json`, { messages: [{ mid: 'same', text: 'remote' }, { mid: 'new', text: 'restored', read: false }] });
    const r = await applyImport(dir, { messages: { chatKeys: ['group:42'] } }, { rebuildChat: () => ({ mode: 'mock' }) });
    assert.equal(r.ok, true);
    assert.equal(r.messages[0].added, 1);
    const messages = read('messages/group_42.json').messages;
    assert.equal(messages[0].text, 'local');
    assert.equal(messages[1].read, true);
    assert.equal(Object.hasOwn(r, 'configFields'), false);
    assert.equal(Object.hasOwn(r, 'modules'), false);
    assert.equal((await rollbackImport(r.backupId, { rebuildChat: () => ({ mode: 'mock' }) })).ok, true);
    assert.deepEqual(read('messages/group_42.json'), local);
  }
});

test('legacy data argument sees sibling prefixes; omitted selections never touch config or extensions', async () => {
  const dir = source();
  fs.mkdirSync(path.join(dir, 'data'));
  write(dir, 'config-fields/persona.json', { personaUnified: false });
  extension(dir);
  let r = await applyImport(path.join(dir, 'data'));
  assert.equal(r.ok, true);
  assert.deepEqual(manifest(r).actions, []);
  assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
  r = await applyImport(path.join(dir, 'data'), { persona: true });
  assert.equal(r.ok, true);
  assert.deepEqual(read('config.json'), { personaUnified: false });
  assert.equal((await rollbackImport(r.backupId)).ok, true);
});

test('escaped extension entries are rejected before staging', async () => {
  const dir = source();
  extension(dir, 'plugins', 'escape', 'export default {};', '../../outside.js');
  const r = await applyImport(dir, { extensions: true }, {
    forgeImportZip: () => assert.fail('escaped entry cannot reach staging'), forgeGate() {}, forgeDiscard() {}
  });
  assert.equal(r.ok, false);
  assert.match(r.modules[0].error, /越界/);
  assert.deepEqual(manifest(r).actions, []);
});

test('nested entries cannot hide dangerous code in a sibling of the entry directory', async () => {
  const dir = source();
  extension(dir, 'plugins', 'nested-entry', "import fs from 'node:fs';", 'lib/start.js');
  write(dir, 'modules/plugins/nested-entry/lib/start.js', 'export default {};');
  const r = await applyImport(dir, { extensions: true }, {
    forgeImportZip: () => assert.fail('all extension code must pass capability scanning'), forgeGate() {}, forgeDiscard() {}
  });
  assert.equal(r.ok, false);
  assert.match(r.modules[0].error, /高危/);
  assert.deepEqual(manifest(r).actions, []);
});

test('config-field and module ancestor junctions cannot restore files from outside the source', async (t) => {
  const outside = source();
  write(outside, 'persona.json', { personaUnified: false });
  write(outside, 'escape/index.js', 'export default {};');
  for (const category of ['persona', 'extensions']) {
    const dir = source();
    extension(dir);
    const link = category === 'persona' ? 'config-fields' : 'modules/plugins/user-demo/lib';
    try { fs.symlinkSync(outside, path.join(dir, link), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory links unavailable'); return; }
      throw error;
    }
    const r = await applyImport(dir, { [category]: true }, {
      forgeImportZip: () => assert.fail('links cannot reach staging'), forgeGate() {}, forgeDiscard() {}
    });
    assert.equal(r.ok, false);
    assert.deepEqual(manifest(r).actions, []);
    assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
  }
});

test('a manifest persistence failure prevents both configuration writes and forge staging', async () => {
  for (const category of ['persona', 'extensions']) {
    const dir = source();
    write(dir, 'config-fields/persona.json', { personaUnified: false });
    extension(dir);
    const rename = fs.renameSync;
    fs.renameSync = (from, to, ...args) => {
      if (path.basename(to) === 'manifest.json' && fs.existsSync(to)) throw new Error('manifest write failed');
      return rename(from, to, ...args);
    };
    let r;
    try {
      r = await applyImport(dir, { [category]: true }, {
        checkPluginTrust: () => ({ ok: true }),
        forgeImportZip: () => assert.fail('unrecorded staging is forbidden'), forgeGate() {}, forgeDiscard() {}
      });
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(r.ok, false);
    assert.deepEqual(manifest(r).actions, []);
    assert.equal(fs.existsSync(path.join(target, 'config.json')), false);
  }
});
