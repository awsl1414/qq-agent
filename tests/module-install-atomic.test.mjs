// 模块落地的原子性与同 id 拒绝（2026-11 口径：不再有 `_1/_2` 递增）。
//
// 历史行为是"同名候选自动递增"，产生磁盘两份、注册表一份的孤儿目录。
// 现在写入方只做独占 mkdir：同 id 在落地前就被拒绝（ModuleIdConflictError），
// 不同 id 撞目录名同样拒绝，语义统一为"绝不覆盖、也不造第二份"。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipToModuleDir, unzipToSandboxDir } from '../src/zip-install.js';
import { buildZip } from '../src/zip-build.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-install-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const entries = [
  { name: 'skill.json', data: JSON.stringify({ id: 'sample', entry: 'index.js' }) },
  { name: 'index.js', data: 'export const value = "new";' }
];
function sandbox() { return fs.mkdtempSync(path.join(root, 'case-')); }

/** 造一份已占位的扩展目录：带清单，模拟"已经装过同 id 的那一份"。 */
function occupy(base, dirName, id) {
  const dir = path.join(base, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: id || dirName, entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'original');
  return dir;
}

test('ZIP 安装同 id 已存在时拒绝（conflict + existing），不产生 _1 副本', async () => {
  const dir = sandbox();
  const existing = occupy(path.join(dir, 'skills'), 'elsewhere', 'sample');
  await assert.rejects(
    unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' }),
    (e) => e.conflict === true && e.existing.id === 'sample' && e.existing.dir === 'elsewhere'
  );
  // 关键断言：没有 `_1`，已装的那份内容也没被覆盖
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['elsewhere']);
  assert.equal(fs.readFileSync(path.join(existing, 'index.js'), 'utf8'), 'original');
});

test('ZIP 安装同目录名已存在时拒绝，不递增、不覆盖', async () => {
  const dir = sandbox();
  // 目录名相同、清单 id 不同：同 id 检查放行，独占 mkdir 必须拦在写入前
  const existing = occupy(path.join(dir, 'skills'), 'clash', 'other-id');
  await assert.rejects(
    unzipToModuleDir(buildZip([
      { name: 'skill.json', data: JSON.stringify({ id: 'different', entry: 'index.js' }) },
      { name: 'index.js', data: 'export const value = "new";' }
    ]), { root: dir, type: 'skill', preferId: 'clash' }),
    /已存在/
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['clash']);
  assert.equal(fs.readFileSync(path.join(existing, 'index.js'), 'utf8'), 'original');
});

test('ZIP 安装内置模块 id（extension-forge）时拒绝', async () => {
  const dir = sandbox();
  await assert.rejects(
    unzipToModuleDir(buildZip([
      { name: 'skill.json', data: JSON.stringify({ id: 'extension-forge', entry: 'index.js' }) },
      { name: 'index.js', data: 'export const value = "new";' }
    ]), { root: dir, type: 'skill', preferId: 'extension-forge' }),
    (e) => e.conflict === true && e.existing.kind === 'core' && e.existing.relDir === 'src/harness/forge'
  );
  assert.equal(fs.existsSync(path.join(dir, 'skills')), false);
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

test('ZIP 安装不同 id 且目录名空闲时正常创建', async () => {
  const dir = sandbox();
  const installed = await unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' });
  assert.equal(installed, 'sample');
  assert.equal(fs.readFileSync(path.join(dir, 'skills', installed, 'index.js'), 'utf8'), entries[1].data);
});

// 导入器以自身模块位置定位扩展目录；在临时包内加载原始源码，避免测试写入仓库扩展。
async function localImporter(dir) {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(new URL('../src/module-import.js', import.meta.url), path.join(dir, 'module-import.js'));
  fs.writeFileSync(path.join(dir, 'plugin-loader.js'),
    `export const SKILLS_DIR = ${JSON.stringify(path.join(dir, 'skills'))}; export const PLUGINS_DIR = ${JSON.stringify(path.join(dir, 'plugins'))};`);
  fs.writeFileSync(path.join(dir, 'zip-install.js'), `export * from ${JSON.stringify(new URL('../src/zip-install.js', import.meta.url).href)};`);
  // module-import.js 现在还会 import ./module-id.js（同 id 判据）：转发到同一份实现，
  // 它的内部依赖仍按真实 src/ 目录解析，不需要再造 config.js 之类的桩。
  fs.writeFileSync(path.join(dir, 'module-id.js'), `export * from ${JSON.stringify(new URL('../src/module-id.js', import.meta.url).href)};`);
  return import(pathToFileURL(path.join(dir, 'module-import.js')).href);
}

test('本地目录导入同名目录时拒绝，不递增出 _1', async () => {
  const dir = sandbox();
  const { importPath } = await localImporter(dir);
  const source = path.join(dir, 'sample');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.js'), 'new');
  const existing = occupy(path.join(dir, 'skills'), 'sample', 'sample');
  assert.throws(() => importPath(source), /已存在/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['sample']);
  assert.equal(fs.readFileSync(path.join(existing, 'index.js'), 'utf8'), 'original');
});

test('本地目录导入同 id（目录名不同）时拒绝，磁盘只有一份', async () => {
  const dir = sandbox();
  const { importPath } = await localImporter(dir);
  const source = path.join(dir, 'pkgB');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ id: 'same-id', entry: 'index.js' }));
  fs.writeFileSync(path.join(source, 'index.js'), 'new');
  occupy(path.join(dir, 'skills'), 'pkgA', 'same-id');
  assert.throws(() => importPath(source), /已在|已安装 same-id/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['pkgA']);
});

test('本地导入内置模块 id 时拒绝', async () => {
  const dir = sandbox();
  const { importPath } = await localImporter(dir);
  const source = path.join(dir, 'forged');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'skill.json'), JSON.stringify({ id: 'extension-forge', entry: 'index.js' }));
  fs.writeFileSync(path.join(source, 'index.js'), 'new');
  assert.throws(() => importPath(source), /内置模块/);
  assert.equal(fs.existsSync(path.join(dir, 'skills')), false);
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

// ── 沙箱路径：递增是语义的一部分 ────────────────────────────────────────────
//
// dev_market_pull 把广场扩展拉到 dev-sandbox/<会话>/pulled/ 下再读、再改，
// 「先拉一版原版、改完再拉一版对比」是它的正常用法。沙箱里的东西永远不会被
// 加载执行，所以「同一 id 只能有一份」在这里不成立 —— 递增必须保留。
// 安装路径则相反：多一份就是孤儿目录。两条路径的差异用这两条测试钉死，
// 防止将来有人把递增函数又接回安装路径、或把拒绝逻辑又套到沙箱上。

test('沙箱连续两次拉取同一包：得到 demo 与 demo_1，两份内容都在', async () => {
  const dir = sandbox();
  const a = await unzipToSandboxDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' });
  const b = await unzipToSandboxDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' });
  assert.equal(a, 'sample');
  assert.equal(b, 'sample_1');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), ['sample', 'sample_1']);
  // 两份都是完整解出来的，不是空壳
  for (const name of ['sample', 'sample_1']) {
    assert.equal(fs.readFileSync(path.join(dir, 'skills', name, 'index.js'), 'utf8'), 'export const value = "new";');
  }
});

test('沙箱不查 id：内置模块 id 也能拉进沙箱对比', async () => {
  const dir = sandbox();
  const zip = buildZip([
    { name: 'skill.json', data: JSON.stringify({ id: 'extension-forge', entry: 'index.js' }) },
    { name: 'index.js', data: 'export const v = 1;' }
  ]);
  const id = await unzipToSandboxDir(zip, { root: dir, type: 'skill', preferId: 'extension-forge' });
  assert.equal(id, 'extension-forge');
});

test('安装路径对同样的重复落地仍然拒绝（沙箱递增不得回流到安装）', async () => {
  const dir = sandbox();
  await unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' });
  await assert.rejects(
    unzipToModuleDir(buildZip(entries), { root: dir, type: 'skill', preferId: 'sample' }),
    (e) => e.conflict === true && e.existing.id === 'sample'
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')), ['sample']);
});
