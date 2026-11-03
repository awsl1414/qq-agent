import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipToModuleDir } from '../src/zip-install.js';
import { buildZip } from '../src/zip-build.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-install-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const entries = [
  { name: 'skill.json', data: JSON.stringify({ id: 'sample', entry: 'index.js' }) },
  { name: 'index.js', data: 'export const value = "new";' }
];
function sandbox() { return fs.mkdtempSync(path.join(root, 'case-')); }
function occupy(base) {
  for (let i = 0; i <= 100; i++) {
    const dir = path.join(base, i ? `sample_${i}` : 'sample');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), 'original');
  }
}

test('ZIP 安装同名候选全部占用时拒绝，不覆盖最后一个现有扩展', async () => {
  const dir = sandbox();
  occupy(path.join(dir, 'skills'));
  await assert.rejects(unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' }), /目录|占用/);
  assert.equal(fs.readFileSync(path.join(dir, 'skills', 'sample_100', 'index.js'), 'utf8'), 'original');
});

test('ZIP 写入失败清除本次新目录，保留已有同名扩展', async () => {
  const dir = sandbox();
  fs.mkdirSync(path.join(dir, 'skills', 'sample'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'sample', 'index.js'), 'original');
  const broken = buildZip([...entries, { name: 'a', data: 'file' }, { name: 'a/child.js', data: 'child' }]);
  await assert.rejects(unzipToModuleDir(broken, { root: dir, type: 'skill', preferId: 'sample' }));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['sample']);
  assert.equal(fs.readFileSync(path.join(dir, 'skills', 'sample', 'index.js'), 'utf8'), 'original');
});

test('ZIP 安装最后一个候选未占用时正常创建，不覆盖已有候选', async () => {
  const dir = sandbox();
  const base = path.join(dir, 'skills');
  occupy(base);
  fs.rmSync(path.join(base, 'sample_100'), { recursive: true });
  const installed = await unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' });
  assert.equal(installed, 'sample_100');
  assert.equal(fs.readFileSync(path.join(base, installed, 'index.js'), 'utf8'), entries[1].data);
  assert.equal(fs.readFileSync(path.join(base, 'sample_99', 'index.js'), 'utf8'), 'original');
});

// 导入器以自身模块位置定位扩展目录；在临时包内加载原始源码，避免测试写入仓库扩展。
async function localImporter(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../src/module-import.js', import.meta.url), path.join(dir, 'module-import.js'));
  fs.writeFileSync(path.join(dir, 'plugin-loader.js'),
    `export const SKILLS_DIR = ${JSON.stringify(path.join(dir, 'skills'))}; export const PLUGINS_DIR = ${JSON.stringify(path.join(dir, 'plugins'))};`);
  fs.writeFileSync(path.join(dir, 'zip-install.js'), `export * from ${JSON.stringify(new URL('../src/zip-install.js', import.meta.url).href)};`);
  return import(pathToFileURL(path.join(dir, 'module-import.js')).href);
}

test('本地目录导入同名候选耗尽时不覆盖现有扩展', async () => {
  const dir = sandbox();
  const { importPath } = await localImporter(dir);
  const source = path.join(dir, 'sample');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.js'), 'new');
  occupy(path.join(dir, 'skills'));
  assert.throws(() => importPath(source), /目录|占用/);
  assert.equal(fs.readFileSync(path.join(dir, 'skills', 'sample_100', 'index.js'), 'utf8'), 'original');
});

test('本地导入复制中途失败后不遗留可被加载的半成品', async (t) => {
  const dir = sandbox();
  const { importPath } = await localImporter(dir);
  const source = path.join(dir, 'sample');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.js'), 'new');
  fs.writeFileSync(path.join(source, 'other.js'), 'other');
  const original = fs.copyFileSync;
  let copied = 0;
  t.mock.method(fs, 'copyFileSync', (...args) => {
    if (++copied === 2) throw new Error('disk full');
    return original(...args);
  });
  assert.throws(() => importPath(source), /disk full/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), []);
  assert.equal(fs.readFileSync(path.join(source, 'index.js'), 'utf8'), 'new');
});
