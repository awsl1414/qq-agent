import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-extension-sources-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'default-data');
const { EXTENSION_CATEGORIES, createExtensionSources } = await import('../src/backup/sources/extensions.js');
const { DRAFT_CATEGORIES, createDraftSources } = await import('../src/backup/sources/drafts.js');
const { isBuiltinModuleDir } = await import('../src/plugin-loader.js');
const { logger } = await import('../src/logger.js');
logger.mirrorConsole = false;
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'));
  const dataDir = path.join(dir, 'data');
  const staging = path.join(dataDir, 'plugin-data', 'extension-forge', 'staging');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.mkdirSync(path.join(dir, 'skills'));
  return { dir, dataDir, staging };
}

function write(dir, rel, content = rel) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function extensionSource(dir) {
  return createExtensionSources({ root: dir }).sources[0];
}

function draftSource(dataDir) {
  return createDraftSources({ dataDir }).sources[0];
}

test('extensions exclude builtins and collect user plugins and skills under modules paths', () => {
  const { dir } = fixture();
  const baseline = JSON.parse(fs.readFileSync(new URL('../builtin-modules.json', import.meta.url), 'utf8'));
  for (const kind of ['plugin', 'skill']) {
    const builtin = baseline.modules.find((entry) => entry.kind === kind).dir;
    assert.equal(isBuiltinModuleDir(builtin), true);
    write(dir, `${kind === 'plugin' ? 'plugins' : 'skills'}/${builtin}/index.js`, 'builtin');
  }
  write(dir, 'plugins/user-plugin/plugin.json', '{"id":"user-plugin"}');
  write(dir, 'plugins/user-plugin/lib/run.js', 'plugin implementation');
  write(dir, 'skills/user-skill/skill.json', '{"id":"user-skill"}');
  write(dir, 'skills/user-skill/empty.txt', '');
  write(dir, 'plugins/loose.txt', 'not an extension directory');
  const source = extensionSource(dir);
  assert.equal(source.key, 'extensions');
  assert.equal(source.defaultOn, true);
  assert.equal(EXTENSION_CATEGORIES[0].defaultOn, true);
  const entries = source.collect();
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    'modules/plugins/user-plugin/lib/run.js',
    'modules/plugins/user-plugin/plugin.json',
    'modules/skills/user-skill/empty.txt',
    'modules/skills/user-skill/skill.json'
  ]);
  assert.ok(entries.every((entry) => Buffer.isBuffer(entry.data)));
  assert.equal(entries.find((entry) => entry.name.endsWith('lib/run.js')).data.toString(), 'plugin implementation');
  assert.equal(entries.find((entry) => entry.name.endsWith('empty.txt')).data.length, 0);
});

test('drafts include multiple draft directories, snapshots and source metadata and default off', () => {
  const { dataDir, staging } = fixture();
  write(staging, 'first/index.js', 'draft implementation');
  write(staging, 'first/_snapshots/version-1/index.js', 'rollback implementation');
  write(staging, 'first/_meta/origin.json', '{"source":"forge"}');
  write(staging, 'second/skill.json', '{"id":"second"}');
  write(staging, 'loose.json', 'not a draft directory');
  const source = draftSource(dataDir);
  assert.equal(source.key, 'drafts');
  assert.equal(source.defaultOn, false);
  assert.equal(DRAFT_CATEGORIES[0].defaultOn, false);
  const entries = source.collect();
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    'drafts/first/_meta/origin.json',
    'drafts/first/_snapshots/version-1/index.js',
    'drafts/first/index.js',
    'drafts/second/skill.json'
  ]);
  assert.equal(entries.find((entry) => entry.name.includes('_snapshots')).data.toString(), 'rollback implementation');
  assert.equal(entries.find((entry) => entry.name.includes('_meta')).data.toString(), '{"source":"forge"}');
});

test('empty and missing directories return empty arrays', () => {
  const { dir, dataDir } = fixture();
  assert.deepEqual(extensionSource(dir).collect(), []);
  assert.deepEqual(draftSource(dataDir).collect(), []);
  assert.deepEqual(extensionSource(path.join(dir, 'missing-app')).collect(), []);
  assert.deepEqual(draftSource(path.join(dir, 'missing-data')).collect(), []);
});

test('both sources reuse exclusions for dependencies, git, credentials and nested links', () => {
  const { dir, dataDir, staging } = fixture();
  const outside = path.join(dir, 'outside');
  write(outside, 'private.txt', 'private');
  for (const parent of [path.join(dir, 'plugins'), path.join(dir, 'skills'), staging]) {
    write(parent, 'user/index.js', 'safe');
    for (const excluded of ['node_modules/pkg/index.js', '.git/config', 'config.json', 'backup-crypto.salt', 'state.lock', 'leftover.tmp', 'config.bak']) {
      write(parent, `user/${excluded}`, 'private');
    }
    fs.symlinkSync(outside, path.join(parent, 'user', 'outside-link'), 'junction');
    fs.symlinkSync(outside, path.join(parent, 'linked-user'), 'junction');
  }
  assert.deepEqual(extensionSource(dir).collect().map((entry) => entry.name).sort(), [
    'modules/plugins/user/index.js', 'modules/skills/user/index.js'
  ]);
  assert.deepEqual(draftSource(dataDir).collect().map((entry) => entry.name), ['drafts/user/index.js']);
});

test('extension collection rejects a category root symlink or junction', () => {
  for (const kind of ['plugins', 'skills']) {
    const { dir } = fixture();
    const outside = path.join(dir, 'outside');
    write(outside, 'user/index.js', 'private');
    const link = path.join(dir, kind);
    fs.rmdirSync(link);
    fs.symlinkSync(outside, link, 'junction');
    assert.throws(() => extensionSource(dir).collect(), /符号链接|目录联接/);
  }
});

test('draft collection rejects staging and ancestor symlinks or junctions', () => {
  for (const segments of [
    ['plugin-data', 'extension-forge', 'staging'],
    ['plugin-data', 'extension-forge'],
    ['plugin-data']
  ]) {
    const { dir, dataDir, staging } = fixture();
    write(staging, 'user/index.js', 'private');
    const link = path.join(dataDir, ...segments);
    const outside = path.join(dir, 'outside');
    fs.renameSync(link, outside);
    fs.symlinkSync(outside, link, 'junction');
    assert.throws(() => draftSource(dataDir).collect(), /符号链接|目录联接/);
  }
});

test('read-time validation rejects a directory replaced with a symlink after traversal', () => {
  const { dir } = fixture();
  const extension = path.join(dir, 'plugins', 'user');
  const outside = path.join(dir, 'outside');
  write(extension, 'index.js', 'safe');
  write(outside, 'index.js', 'private');
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  let switched = false;
  let privateRead = false;
  try {
    fs.readdirSync = function (target, ...args) {
      const entries = originalReaddir.call(this, target, ...args);
      if (target === extension && !switched) {
        switched = true;
        fs.renameSync(extension, path.join(dir, 'original-user'));
        fs.symlinkSync(outside, extension, 'junction');
      }
      return entries;
    };
    fs.readFileSync = function (target, ...args) {
      if (target === path.join(extension, 'index.js')) privateRead = true;
      return originalRead.call(this, target, ...args);
    };
    assert.throws(() => extensionSource(dir).collect(), /符号链接|目录联接/);
    assert.equal(switched, true);
    assert.equal(privateRead, false);
  } finally {
    fs.readFileSync = originalRead;
    fs.readdirSync = originalReaddir;
  }
});
