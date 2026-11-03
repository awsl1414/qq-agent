import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-migrate-assets-'));
const target = path.join(root, 'target');
const staging = 'plugin-data/extension-forge/staging';
process.env.QQ_AGENT_DATA_DIR = target;
const { applyImport, rollbackImport, scanSource } = await import('../src/migrate.js');
const { logger } = await import('../src/logger.js');
logger.mirrorConsole = false;
beforeEach(() => {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function source() { return fs.mkdtempSync(path.join(root, 'source-')); }
function write(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function read(rel) { return JSON.parse(fs.readFileSync(path.join(target, rel), 'utf8')); }
function manifest(report) { return read(`${report.backupDir}/manifest.json`); }
function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, file).replace(/\\/g, '/'), fs.readFileSync(file).toString('base64')];
    }).sort(([a], [b]) => a.localeCompare(b)));
}

test('wallpaper restores binary assets, merges both JSON files with local priority and rolls back exact bytes', async () => {
  const dir = source();
  const original = '\uFEFF{ "id": "local", "dim": 0, "nested": { "enabled": false } }\n';
  write(target, 'wallpaper-state.json', original);
  write(target, 'wallpaper-imports.json', { same: { hash: 'local' } });
  write(target, 'wallpaper-static/same.png', Buffer.from([255, 0, 128]));
  write(target, 'wallpaper-static/local.png', 'keep');
  const before = snapshot(target);
  const image = Buffer.from([0, 255, 129, 254, 10]);
  write(dir, 'data/wallpaper-static/same.png', image);
  write(dir, 'data/wallpaper-static/sub/new.png', image);
  write(dir, 'data/ui/background.png', image);
  write(dir, 'data/wallpaper-state.json', { id: 'remote', dim: 1, nested: { enabled: true, added: 1 }, fit: 'cover' });
  write(dir, 'data/wallpaper-imports.json', { same: { hash: 'remote' }, added: { hash: 'new' } });
  assert.equal(scanSource(dir).wallpaper.available, true);
  const r = await applyImport(dir, { wallpaper: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.wallpaper.files, 5);
  assert.deepEqual(fs.readFileSync(path.join(target, 'wallpaper-static/same.png')), image);
  assert.deepEqual(fs.readFileSync(path.join(target, 'ui/background.png')), image);
  assert.equal(fs.readFileSync(path.join(target, 'wallpaper-static/local.png'), 'utf8'), 'keep');
  assert.deepEqual(read('wallpaper-state.json'), { id: 'local', dim: 0, nested: { enabled: false, added: 1 }, fit: 'cover' });
  assert.deepEqual(read('wallpaper-imports.json'), { same: { hash: 'local' }, added: { hash: 'new' } });
  assert.ok(manifest(r).actions.every((a) => a.type === 'wallpaper'));
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  const restored = snapshot(target);
  for (const file of Object.keys(restored)) if (file.startsWith('import-backups/') || file.startsWith('logs/')) delete restored[file];
  assert.deepEqual(restored, before);
});

test('desktopPet restores models and previews, keeps local state keys and rolls back', async () => {
  const dir = source();
  write(target, 'desktop-pet/state.json', { enabled: false, model: null, nested: { scale: 0 } });
  write(target, 'desktop-pet/models/demo/model.glb', Buffer.from([255, 128, 1]));
  const before = snapshot(path.join(target, 'desktop-pet'));
  write(dir, 'data/desktop-pet/models/demo/model.glb', Buffer.from([0, 255, 254]));
  write(dir, 'data/desktop-pet/previews/demo.png', Buffer.from([128, 0]));
  write(dir, 'data/desktop-pet/state.json', { enabled: true, model: 'remote', nested: { scale: 1, x: 2 }, newKey: 'new' });
  assert.equal(scanSource(dir).desktopPet.available, true);
  const r = await applyImport(dir, { desktopPet: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.desktopPet.files, 3);
  assert.deepEqual(read('desktop-pet/state.json'), { enabled: false, model: null, nested: { scale: 0, x: 2 }, newKey: 'new' });
  assert.deepEqual(fs.readFileSync(path.join(target, 'desktop-pet/models/demo/model.glb')), Buffer.from([0, 255, 254]));
  assert.deepEqual(fs.readFileSync(path.join(target, 'desktop-pet/previews/demo.png')), Buffer.from([128, 0]));
  assert.ok(manifest(r).actions.every((a) => a.type === 'desktopPet'));
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  assert.deepEqual(snapshot(path.join(target, 'desktop-pet')), before);
});

test('draft directories replace only matching staging drafts, preserve metadata and snapshots, never install and roll back', async () => {
  const dir = source();
  write(target, `${staging}/same/index.js`, 'local');
  write(target, `${staging}/same/obsolete.js`, 'remove on import');
  write(target, `${staging}/keep/index.js`, 'untouched draft');
  write(target, 'plugins/installed/index.js', 'installed plugin');
  write(target, 'skills/installed/index.js', 'installed skill');
  const installedDirs = ['plugins', 'skills'].flatMap((name) => [
    path.join(target, name), fileURLToPath(new URL(`../${name}/`, import.meta.url))
  ]);
  const installed = installedDirs.map(snapshot);
  const before = snapshot(path.join(target, staging));
  write(dir, 'drafts/same/index.js', 'restored');
  write(dir, 'drafts/same/_meta/source.json', { source: 'backup' });
  write(dir, 'drafts/same/_snapshots/v1/index.js', 'snapshot');
  write(dir, 'drafts/new/plugin.json', { id: 'new', entry: 'index.js' });
  write(dir, 'drafts/new/index.js', "throw new Error('must never execute');");
  assert.equal(scanSource(dir).drafts.available, true);
  const r = await applyImport(dir, { drafts: true }, {
    forgeImportZip: () => assert.fail('restoring drafts must not import or install extensions'),
    forgeGate: () => assert.fail('restoring drafts must not run forge hooks'),
    forgeDiscard: () => assert.fail('draft rollback uses recorded files')
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.drafts.drafts, 2);
  assert.equal(r.drafts.files, 5);
  assert.equal(fs.existsSync(path.join(target, staging, 'same/obsolete.js')), false);
  assert.equal(fs.readFileSync(path.join(target, staging, 'same/index.js'), 'utf8'), 'restored');
  assert.deepEqual(read(`${staging}/same/_meta/source.json`), { source: 'backup' });
  assert.equal(fs.readFileSync(path.join(target, staging, 'same/_snapshots/v1/index.js'), 'utf8'), 'snapshot');
  assert.deepEqual(installedDirs.map(snapshot), installed);
  assert.ok(manifest(r).actions.every((a) => a.type === 'drafts' && a.target.startsWith(`${staging}/`)));
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  assert.deepEqual(snapshot(path.join(target, staging)), before);
  assert.equal(fs.existsSync(path.join(target, staging, 'new')), false);
  assert.deepEqual(installedDirs.map(snapshot), installed);
});

test('draft directory replacement supports file/directory changes and rollback restores the original tree', async () => {
  const dir = source();
  write(target, `${staging}/same/file-to-dir`, 'old file');
  write(target, `${staging}/same/dir-to-file/index.js`, 'old nested file');
  const before = snapshot(path.join(target, staging));
  write(dir, 'drafts/same/file-to-dir/index.js', 'new nested file');
  write(dir, 'drafts/same/dir-to-file', 'new file');
  const r = await applyImport(dir, { drafts: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(target, staging, 'same/dir-to-file'), 'utf8'), 'new file');
  assert.equal(fs.readFileSync(path.join(target, staging, 'same/file-to-dir/index.js'), 'utf8'), 'new nested file');
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  assert.deepEqual(snapshot(path.join(target, staging)), before);
});

test('missing state files are created and rollback removes the new files and asset directories', async () => {
  const dir = source();
  write(dir, 'data/wallpaper-state.json', { id: 'remote' });
  write(dir, 'data/wallpaper-imports.json', { remote: { hash: 'hash' } });
  write(dir, 'data/desktop-pet/state.json', { enabled: true });
  const r = await applyImport(dir, { wallpaper: true, desktopPet: true });
  assert.equal(r.ok, true);
  assert.deepEqual(read('wallpaper-state.json'), { id: 'remote' });
  assert.deepEqual(read('wallpaper-imports.json'), { remote: { hash: 'hash' } });
  assert.deepEqual(read('desktop-pet/state.json'), { enabled: true });
  assert.ok(manifest(r).actions.every((a) => a.backup === null));
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  for (const rel of ['wallpaper-state.json', 'wallpaper-imports.json', 'desktop-pet']) assert.equal(fs.existsSync(path.join(target, rel)), false);
});

test('a failed atomic draft write remains recoverable after stale files have been removed', async () => {
  const dir = source();
  write(target, `${staging}/same/index.js`, 'local');
  write(target, `${staging}/same/obsolete.js`, 'old');
  const before = snapshot(path.join(target, staging));
  write(dir, 'drafts/same/index.js', 'remote');
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (to === path.join(target, staging, 'same/index.js')) throw new Error('asset write failed');
    return rename(from, to, ...args);
  };
  let r;
  try { r = await applyImport(dir, { drafts: true }); }
  finally { fs.renameSync = rename; }
  assert.equal(r.ok, false);
  assert.match(r.drafts.error, /asset write failed/);
  assert.equal(manifest(r).actions.length, 2);
  assert.equal((await rollbackImport(r.backupId)).ok, true);
  assert.deepEqual(snapshot(path.join(target, staging)), before);
});

test('omitted selections leave all three categories untouched; old packages without prefixes are no-ops', async () => {
  const dir = source();
  write(dir, 'data/wallpaper-state.json', { id: 'remote' });
  write(dir, 'data/desktop-pet/state.json', { enabled: true });
  write(dir, 'drafts/new/index.js', 'remote');
  const r = await applyImport(dir);
  assert.deepEqual(manifest(r).actions, []);
  for (const category of ['wallpaper', 'desktopPet', 'drafts']) assert.equal(Object.hasOwn(r, category), false);
  const old = source();
  write(old, 'data/messages/group_1.json', { messages: [{ mid: '1', text: 'old', ts: 1 }] });
  const scan = scanSource(old);
  for (const category of ['wallpaper', 'desktopPet', 'drafts']) assert.equal(scan[category].available, false);
  const imported = await applyImport(old, { wallpaper: true, desktopPet: true, drafts: true, messages: { chatKeys: ['group:1'] } });
  assert.equal(imported.ok, true);
  assert.ok(imported.wallpaper.skipped && imported.desktopPet.skipped && imported.drafts.skipped);
  assert.deepEqual(manifest(imported).actions.map((a) => a.type), ['messages']);
  assert.equal(read('messages/group_1.json').messages[0].read, true);
});

for (const [category, rel] of [['wallpaper', 'wallpaper-state.json'], ['wallpaper', 'wallpaper-imports.json'], ['desktopPet', 'desktop-pet/state.json']]) {
  test(`${rel} rejects invalid source and local JSON without destroying local bytes`, async () => {
    for (const localInvalid of [false, true]) {
      const dir = source();
      write(dir, `data/${rel}`, localInvalid ? { key: 'incoming' } : '{broken');
      write(target, rel, localInvalid ? '{broken' : { key: 'local' });
      const original = fs.readFileSync(path.join(target, rel));
      const r = await applyImport(dir, { [category]: true });
      assert.equal(r.ok, false);
      assert.equal(r[category].ok, false);
      assert.deepEqual(fs.readFileSync(path.join(target, rel)), original);
      assert.deepEqual(manifest(r).actions, []);
    }
  });
}

for (const [category, rel, targetRel] of [
  ['wallpaper', 'data/ui/background.png', 'ui/background.png'],
  ['desktopPet', 'data/desktop-pet/previews/demo.png', 'desktop-pet/previews/demo.png'],
  ['drafts', 'drafts/same/index.js', `${staging}/same/index.js`]
]) {
  test(`${category} cannot mutate files when action persistence fails`, async () => {
    const dir = source();
    write(dir, rel, 'remote');
    write(target, targetRel, 'local');
    if (category === 'drafts') write(target, `${staging}/same/obsolete.js`, 'must survive');
    const before = snapshot(target);
    const rename = fs.renameSync;
    fs.renameSync = (from, to, ...args) => {
      if (path.basename(to) === 'manifest.json' && fs.existsSync(to)) throw new Error('manifest write failed');
      return rename(from, to, ...args);
    };
    let r;
    try { r = await applyImport(dir, { [category]: true }); }
    finally { fs.renameSync = rename; }
    assert.equal(r.ok, false);
    assert.deepEqual(manifest(r).actions, []);
    for (const [file, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(target, file)).toString('base64'), bytes);
  });
}

test('asset and draft ancestor junctions cannot read or write outside their roots', async (t) => {
  const outside = source();
  write(outside, 'same/index.js', 'outside');
  for (const [category, sourceRel, targetRel] of [
    ['wallpaper', 'data/ui', 'ui'], ['wallpaper', 'data', 'ui'],
    ['desktopPet', 'data/desktop-pet', 'desktop-pet'], ['drafts', 'drafts', staging]
  ]) {
    for (const side of ['source', 'target']) {
      const dir = source();
      const link = path.join(side === 'source' ? dir : target, side === 'source' ? sourceRel : targetRel);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('directory links unavailable'); return; }
        throw error;
      }
      if (side === 'target') {
        const incoming = category === 'drafts' ? 'drafts/same/index.js' : category === 'desktopPet' ? 'data/desktop-pet/same/index.js' : 'data/ui/same/index.js';
        write(dir, incoming, 'incoming');
      }
      try {
        const r = await applyImport(dir, { [category]: true });
        assert.equal(r.ok, false, `${category} ${side} ${sourceRel}`);
        assert.deepEqual(manifest(r).actions, []);
        assert.equal(fs.readFileSync(path.join(outside, 'same/index.js'), 'utf8'), 'outside');
      } finally { fs.unlinkSync(link); }
    }
  }
});
