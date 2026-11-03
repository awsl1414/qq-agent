import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-backup-files-'));
const data = path.join(root, 'data');
process.env.QQ_AGENT_DATA_DIR = data;
const {
  FILE_CATEGORIES, BACKUP_MAX_FILES, BACKUP_MAX_TOTAL_BYTES,
  createFileSources, walkFiles, readBackupFile
} = await import('../src/backup/sources/files.js');
const { DATA_CATEGORIES } = await import('../src/bundle.js');
const { buildBackup, parseBackup } = await import('../src/backup/archive.js');
const { logger } = await import('../src/logger.js');
logger.mirrorConsole = false;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

beforeEach(() => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(relative, content = relative) {
  const file = path.join(data, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function source(key, collector = createFileSources()) {
  const found = collector.sources.find((item) => item.key === key);
  assert.ok(found, `missing source: ${key}`);
  return found;
}

function mockSizes(t, files, size) {
  const selected = new Set(files);
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const stat = original(file, ...args);
    if (selected.has(file)) stat.size = size;
    return stat;
  });
}

test('wallpaper collects both recursive image directories and the two exact JSON files', () => {
  const expected = [
    'wallpaper-static/main.jpg', 'wallpaper-static/nested/extra.png',
    'ui/background.jpg', 'ui/nested/another.webp',
    'wallpaper-state.json', 'wallpaper-imports.json'
  ];
  for (const file of expected) write(file);
  write('wallpaper-unrelated.json');
  const wallpaper = source('wallpaper');
  assert.equal(wallpaper.label, '壁纸');
  assert.equal(wallpaper.defaultOn, true);
  const entries = wallpaper.collect();
  assert.deepEqual(entries.map((entry) => entry.name).sort(), expected.map((file) => `data/${file}`).sort());
  for (const entry of entries) assert.equal(entry.data.toString(), entry.name.slice('data/'.length));
  assert.equal(DATA_CATEGORIES.some((category) => category.key === 'wallpaper'), false);
  assert.ok(FILE_CATEGORIES.some((category) => category.key === 'wallpaper'));
});

test('desktopPet collects models, previews, state and other nested files', () => {
  const expected = [
    'desktop-pet/models/cat/model.json', 'desktop-pet/models/cat/textures/skin.png',
    'desktop-pet/previews/cat.png', 'desktop-pet/state.json', 'desktop-pet/custom/info.json'
  ];
  for (const file of expected) write(file);
  const desktopPet = source('desktopPet');
  assert.equal(desktopPet.label, '桌宠');
  assert.equal(desktopPet.defaultOn, true);
  assert.deepEqual(desktopPet.collect().map((entry) => entry.name).sort(), expected.map((file) => `data/${file}`).sort());
});

test('archive registers the new categories and preserves data paths in the package', () => {
  write('wallpaper-static/main.jpg', 'wallpaper');
  write('desktop-pet/models/cat/model.json', '{"model":"cat"}');
  const built = buildBackup({ categories: ['wallpaper', 'desktopPet'] });
  assert.equal(built.ok, true, built.error);
  assert.deepEqual(built.manifest.categories.map((category) => category.key).sort(), ['desktopPet', 'wallpaper']);
  const parsed = parseBackup(built.buffer);
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.entries.map((entry) => entry.name).sort(), [
    'data/desktop-pet/models/cat/model.json', 'data/wallpaper-static/main.jpg'
  ]);
});

test('missing files, empty directories and zero-byte files return empty arrays', () => {
  for (const key of ['wallpaper', 'desktopPet']) assert.deepEqual(source(key).collect(), []);
  for (const dir of ['wallpaper-static/nested', 'ui', 'desktop-pet/models', 'desktop-pet/previews']) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }
  for (const file of ['wallpaper-state.json', 'wallpaper-imports.json', 'desktop-pet/state.json']) write(file, '');
  for (const key of ['wallpaper', 'desktopPet']) assert.deepEqual(source(key).collect(), []);
  write('wallpaper-imports.json', '[]');
  assert.deepEqual(source('wallpaper').collect().map((entry) => entry.name), ['data/wallpaper-imports.json']);
});

test('new directory sources retain credential, temporary file and cache exclusions', () => {
  for (const dir of ['wallpaper-static', 'ui', 'desktop-pet']) {
    write(`${dir}/saved.json`);
    for (const file of ['config.json', 'backup-crypto.salt', 'other.salt', 'state.lock', 'leftover.tmp', 'config.bak']) {
      write(`${dir}/${file}`, 'excluded');
    }
    for (const excluded of ['plugin-data', 'logs', 'cache', '.cache', 'node_modules', '.git']) {
      write(`${dir}/${excluded}/private.json`, 'excluded');
    }
  }
  const collector = createFileSources();
  const entries = [...source('wallpaper', collector).collect(), ...source('desktopPet', collector).collect()];
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    'data/desktop-pet/saved.json', 'data/ui/saved.json', 'data/wallpaper-static/saved.json'
  ]);
});

for (const [key, relative] of [
  ['wallpaper', 'wallpaper-static/large.png'],
  ['wallpaper', 'ui/large.png'],
  ['wallpaper', 'wallpaper-state.json'],
  ['wallpaper', 'wallpaper-imports.json'],
  ['desktopPet', 'desktop-pet/models/large.bin']
]) {
  test(`${relative} rejects files over 64MB before reading`, (t) => {
    const file = write(relative, 'small fixture');
    mockSizes(t, [file], MAX_FILE_BYTES + 1);
    const read = t.mock.method(fs, 'readFileSync');
    assert.throws(() => source(key).collect(), /单个文件.*上限/);
    assert.equal(read.mock.calls.some((call) => call.arguments[0] === file), false);
  });
}

test('wallpaper checks the 512MB total across its separate directories and JSON files', (t) => {
  const files = [];
  for (const dir of ['wallpaper-static', 'ui']) {
    for (let i = 0; i < 4; i++) files.push(write(`${dir}/${i}.png`, 'fixture'));
  }
  files.push(write('wallpaper-state.json', '{}'));
  mockSizes(t, files, MAX_FILE_BYTES);
  const selected = new Set(files);
  const original = fs.readFileSync;
  // A shared buffer exercises the real aggregate budget without allocating 512MB.
  const chunk = Buffer.alloc(MAX_FILE_BYTES);
  t.mock.method(fs, 'readFileSync', (file, ...args) => selected.has(file) ? chunk : original(file, ...args));
  assert.equal(MAX_FILE_BYTES * 8, BACKUP_MAX_TOTAL_BYTES);
  assert.throws(() => source('wallpaper').collect(), /备份总量超过上限/);
});

test('wallpaper and desktopPet share the same 512MB budget', (t) => {
  const files = [];
  for (let i = 0; i < 8; i++) files.push(write(`wallpaper-static/${i}.png`, 'fixture'));
  files.push(write('desktop-pet/models/model.bin', 'fixture'));
  mockSizes(t, files, MAX_FILE_BYTES);
  const selected = new Set(files);
  const original = fs.readFileSync;
  const chunk = Buffer.alloc(MAX_FILE_BYTES);
  t.mock.method(fs, 'readFileSync', (file, ...args) => selected.has(file) ? chunk : original(file, ...args));
  const collector = createFileSources();
  assert.equal(source('wallpaper', collector).collect().length, 8);
  assert.throws(() => source('desktopPet', collector).collect(), /备份总量超过上限/);
});

test('directory walks reject more than 20000 files instead of silently truncating', (t) => {
  write('desktop-pet/model.bin', 'fixture');
  const dir = path.join(data, 'desktop-pet');
  const original = fs.readdirSync;
  const [entry] = original(dir, { withFileTypes: true });
  // Repeat a real entry to exercise the file-count boundary without 20001 disk files.
  t.mock.method(fs, 'readdirSync', (file, ...args) => file === dir ? Array(BACKUP_MAX_FILES + 1).fill(entry) : original(file, ...args));
  assert.throws(() => source('desktopPet').collect(), /文件数量超过上限/);
});

test('file sources reserve a manifest slot in their shared 20000-entry budget', (t) => {
  write('wallpaper-static/image.png', 'fixture');
  write('ui/background.png', 'fixture');
  const directories = new Map();
  const original = fs.readdirSync;
  for (const relative of ['wallpaper-static', 'ui']) {
    const dir = path.join(data, relative);
    directories.set(dir, original(dir, { withFileTypes: true })[0]);
  }
  t.mock.method(fs, 'readdirSync', (file, ...args) => directories.has(file)
    ? Array(BACKUP_MAX_FILES / 2).fill(directories.get(file)) : original(file, ...args));
  assert.throws(() => source('wallpaper').collect(), /文件数量超过备份上限/);
});

for (const [key, relative] of [['wallpaper', 'wallpaper-static'], ['wallpaper', 'ui'], ['desktopPet', 'desktop-pet']]) {
  test(`${relative} rejects a category-root symlink or junction`, () => {
    const outside = fs.mkdtempSync(path.join(root, 'outside-'));
    fs.writeFileSync(path.join(outside, 'private.json'), 'excluded');
    fs.symlinkSync(outside, path.join(data, relative), 'junction');
    assert.throws(() => source(key).collect(), /符号链接|目录联接/);
  });
}

test('nested symlinks and junctions are excluded without reading their targets', () => {
  const outside = fs.mkdtempSync(path.join(root, 'nested-outside-'));
  fs.writeFileSync(path.join(outside, 'private.json'), 'excluded');
  for (const dir of ['wallpaper-static', 'desktop-pet']) {
    write(`${dir}/saved.json`, 'saved');
    fs.symlinkSync(outside, path.join(data, dir, 'linked'), 'junction');
  }
  for (const key of ['wallpaper', 'desktopPet']) {
    const entries = source(key).collect();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.toString(), 'saved');
  }
});

test('custom anchors support traversal and reading while rejecting escapes and links', () => {
  const anchor = fs.mkdtempSync(path.join(root, 'anchor-'));
  const models = path.join(anchor, 'models');
  fs.mkdirSync(models);
  const file = path.join(models, 'model.json');
  fs.writeFileSync(file, '{"model":"cat"}');
  assert.deepEqual(walkFiles(models, { anchor }).map((entry) => entry.rel), ['model.json']);
  assert.equal(readBackupFile('modules/plugins/cat/models/model.json', file, anchor).toString(), '{"model":"cat"}');
  assert.throws(() => walkFiles(models), /超出锚点目录范围/);
  assert.throws(() => readBackupFile('data/model.json', file), /超出锚点目录范围/);
  const outside = fs.mkdtempSync(path.join(root, 'anchor-outside-'));
  const privateFile = path.join(outside, 'private.json');
  fs.writeFileSync(privateFile, 'excluded');
  assert.throws(() => walkFiles(outside, { anchor }), /超出锚点目录范围/);
  assert.throws(() => readBackupFile('modules/private.json', privateFile, anchor), /超出锚点目录范围/);
  const linked = path.join(anchor, 'linked');
  fs.symlinkSync(outside, linked, 'junction');
  assert.throws(() => walkFiles(linked, { anchor }), /符号链接|目录联接/);
  assert.throws(() => readBackupFile('modules/private.json', path.join(linked, 'private.json'), anchor), /符号链接|目录联接/);
  assert.deepEqual(walkFiles(anchor, { anchor }).map((entry) => entry.rel), ['models/model.json']);
});
