import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-migrate-rs-'));
const target = path.join(root, 'target');
const source = path.join(root, 'source');
fs.mkdirSync(target); fs.mkdirSync(source);
process.env.QQ_AGENT_DATA_DIR = target;
const { normalizeStickerEntry } = await import('../plugins/sticker/lib/stickers.js');
const { applyImport, rollbackImport, scanSource } = await import('../src/migrate.js');
const write = (dir, file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
const read = (file) => JSON.parse(fs.readFileSync(path.join(target, file), 'utf8'));
let remindersReloaded = 0, stickersReloaded = 0;
const hooks = { remindersReload: () => { remindersReloaded += 1; }, stickersReload: () => { stickersReloaded += 1; } };

test('reminders: target wins, fired preserved, duplicate source skipped, rollback reloads', async () => {
  const original = { reminders: [{ id: 'same', fired: true, text: 'local' }] };
  write(target, 'reminders.json', original);
  write(source, 'reminders.json', { reminders: [{ id: 'same', fired: false }, { id: 'new', fired: false }, { id: 'new' }] });
  const scan = scanSource(source);
  assert.equal(scan.reminders.count, 3); assert.equal(scan.reminders.pending, 3);
  const r = await applyImport(source, { reminders: true }, hooks);
  assert.deepEqual(r.reminders, { ok: true, added: 1, total: 2, skipped: 2 });
  assert.deepEqual(read('reminders.json').reminders[0], original.reminders[0]);
  assert.equal(remindersReloaded, 1);
  assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
  assert.deepEqual(read('reminders.json'), original); assert.equal(remindersReloaded, 2);
});

test('stickers: normalized aliases, target metadata retained, rollback restores exact file', async () => {
  const original = [{ id: 'same', localFile: 'file:///local', useCount: 9, tags: ['local'] }];
  write(target, 'stickers.json', original);
  write(source, 'stickers.json', [{ id: 'same', tags: ['remote'] }, { emoji_id: ' new ', md5: 'abc', tags: [' x ', ''] }, { resId: 'new' }, {}]);
  assert.equal(scanSource(source).stickers.count, 4);
  const r = await applyImport(source, { stickers: true }, hooks);
  assert.deepEqual(r.stickers, { ok: true, added: 1, total: 2, skipped: 3 });
  const data = read('stickers.json');
  assert.equal(data[0].localFile, original[0].localFile); assert.equal(data[0].useCount, 9); assert.deepEqual(data[0].tags, ['local']);
  assert.deepEqual(data[1], { emoji_id: ' new ', md5: 'abc', tags: [' x ', ''] });
  const normalized = normalizeStickerEntry(data[1]);
  assert.equal(normalized.id, 'new'); assert.equal(normalized.md5, 'ABC'); assert.deepEqual(normalized.tags, ['x']);
  assert.equal(stickersReloaded, 1);
  assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
  assert.deepEqual(read('stickers.json'), original); assert.equal(stickersReloaded, 2);
});

for (const category of ['reminders', 'stickers']) {
  test(`${category}: missing/corrupt/empty files follow category policy; empty collection valid; rollback deletes new files`, async () => {
    const file = `${category}.json`;
    fs.rmSync(path.join(target, file), { force: true }); fs.rmSync(path.join(source, file), { force: true });
    for (const content of [null, '', '{broken', '{}']) {
      if (content !== null) fs.writeFileSync(path.join(source, file), content);
      const r = await applyImport(source, { [category]: true }, hooks);
      assert.equal(r[category].ok, category === 'stickers');
      if (category === 'stickers') await rollbackImport(r.backupId, hooks);
      assert.equal(fs.existsSync(path.join(target, file)), false);
    }
    write(source, file, category === 'reminders' ? { reminders: [] } : []);
    const r = await applyImport(source, { [category]: true }, hooks);
    assert.deepEqual(r[category], { ok: true, added: 0, total: 0, skipped: 0 });
    assert.equal((await rollbackImport(r.backupId, hooks)).ok, true);
    assert.equal(fs.existsSync(path.join(target, file)), false);
    fs.writeFileSync(path.join(target, file), 'broken');
    const rejected = await applyImport(source, { [category]: true }, hooks);
    assert.equal(rejected[category].ok, category === 'stickers');
    if (category === 'stickers') await rollbackImport(rejected.backupId, hooks);
    assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), 'broken');
  });
}
test('omitted switches leave categories untouched and absent from report', async () => {
  const r = await applyImport(source);
  assert.equal(Object.hasOwn(r, 'reminders'), false); assert.equal(Object.hasOwn(r, 'stickers'), false);
  assert.equal(fs.readFileSync(path.join(target, 'reminders.json'), 'utf8'), 'broken');
});

test('async reload failures are reported and hidden list remains local', async () => {
  write(target, 'stickers.json', []);
  write(source, 'stickers.json', [{ id: 'new' }]);
  write(target, 'stickers-hidden.json', ['local']);
  write(source, 'stickers-hidden.json', ['remote']);
  const r = await applyImport(source, { stickers: true }, { stickersReload: async () => { throw new Error('reload failed'); } });
  assert.equal(r.ok, false); assert.equal(r.stickers.ok, false); assert.match(r.stickers.error, /reload failed/);
  assert.deepEqual(read('stickers-hidden.json'), ['local']);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'import-backups', r.backupId, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.actions.map((a) => a.type), ['stickers']);
  const rollback = await rollbackImport(r.backupId, { stickersReload: async () => { throw new Error('reload failed'); } });
  assert.equal(rollback.ok, false); assert.equal(rollback.failed, 1);
  assert.deepEqual(read('stickers.json'), []);
});

test('missing stickers reload hook warns after import and rollback', async () => {
  const { logger } = await import('../src/logger.js');
  const original = logger.warn;
  const warnings = [];
  logger.warn = (...args) => warnings.push(args.join(' '));
  try {
    const r = await applyImport(source, { stickers: true });
    await rollbackImport(r.backupId);
    assert.equal(warnings.filter((line) => line.includes('需重启或重新同步才能生效')).length, 2);
  } finally {
    logger.warn = original;
  }
});
