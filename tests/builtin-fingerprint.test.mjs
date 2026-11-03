import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-builtin-fingerprint-'));
process.env.QQ_AGENT_DATA_DIR = path.join(root, 'data');
const { moduleFileSha1, builtinContentMatches, refreshBuiltinEntry, checkPluginTrust } = await import('../src/plugin-loader.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, 'builtin-modules.json'), 'utf8'));
const rawSha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);

function sandbox() {
  return fs.mkdtempSync(path.join(root, 'case-'));
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withLineEndings(buf, eol) {
  if (buf.includes(0)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, eol), 'latin1');
}

function copyBuiltin(rec, parent, eol) {
  const dir = path.join(parent, rec.dir);
  const source = path.join(repoRoot, rec.kind === 'skill' ? 'skills' : 'plugins', rec.dir);
  for (const rel of Object.keys(rec.files)) write(dir, rel, withLineEndings(fs.readFileSync(path.join(source, rel)), eol));
  return dir;
}

test('CRLF 与 LF 文本指纹相同，并保持已有 LF 基线', () => {
  const lf = Buffer.from('中文内容\nimport fs from "node:fs";\n');
  const crlf = withLineEndings(lf, '\r\n');
  assert.equal(moduleFileSha1(lf), rawSha1(lf));
  assert.equal(moduleFileSha1(crlf), moduleFileSha1(lf));
  assert.notEqual(rawSha1(crlf), rawSha1(lf));
});

test('含 NUL 的二进制文件按原始字节计算，保留其中的 CRLF', () => {
  const binary = Buffer.from([0xff, 0, 13, 10, 0x80]);
  assert.equal(moduleFileSha1(binary), rawSha1(binary));
  assert.notEqual(moduleFileSha1(binary), moduleFileSha1(Buffer.from([0xff, 0, 10, 0x80])));
});

test('真实内容篡改仍改变指纹，包括非 UTF-8 字节和单独 CR', () => {
  assert.notEqual(moduleFileSha1(Buffer.from('safe\n')), moduleFileSha1(Buffer.from('changed\n')));
  assert.notEqual(moduleFileSha1(Buffer.from([0xff, 13, 10])), moduleFileSha1(Buffer.from([0xfe, 13, 10])));
  assert.notEqual(moduleFileSha1(Buffer.from('a\rb')), moduleFileSha1(Buffer.from('a\nb')));
});

test('仓库全部内置模块通过真实基线校验，临时目录 LF / CRLF 副本均通过', () => {
  assert.equal(baseline.version, 2);
  assert.ok(baseline.modules.length > 0);
  for (const rec of baseline.modules) {
    const source = path.join(repoRoot, rec.kind === 'skill' ? 'skills' : 'plugins', rec.dir);
    assert.equal(builtinContentMatches(rec, path.join(source, rec.entry)).matches, true, rec.dir);
    for (const eol of ['\n', '\r\n']) {
      const dir = copyBuiltin(rec, sandbox(), eol);
      const entry = path.join(dir, rec.entry);
      const result = builtinContentMatches(rec, entry);
      assert.deepEqual(result.mismatches, [], `${rec.dir} ${JSON.stringify(eol)}`);
      assert.equal(result.matches, true);
      assert.deepEqual(checkPluginTrust(rec.id, entry), { ok: true });
    }
  }
});

test('仅换行差异保留诊断详情，但不使模块失去豁免', () => {
  const rec = baseline.modules.find((item) => item.dir === 'account-pool');
  const dir = copyBuiltin(rec, sandbox(), '\r\n');
  const result = builtinContentMatches(rec, path.join(dir, rec.entry));
  assert.equal(result.matches, true);
  assert.ok(result.lineEndingOnly.includes('plugin.json'));
  assert.deepEqual(result.mismatches, []);
});

test('缺少或损坏 files 的旧条目 fail-closed，entrySha1 不再获得豁免', () => {
  const dir = sandbox();
  write(dir, 'index.js', 'export default {};\n');
  const entry = path.join(dir, 'index.js');
  for (const rec of [undefined, {}, { entrySha1: rawSha1(fs.readFileSync(entry)) }, { files: null }, { files: [] }, { files: 'bad' }]) {
    const result = builtinContentMatches(rec, entry);
    assert.equal(result.matches, false);
    assert.deepEqual(result.mismatches, [{ path: 'builtin-modules.json', type: 'invalid-baseline' }]);
  }
});

test('逐一报告真实内容失配、缺失、不可读文件和新增可执行文件', () => {
  const dir = sandbox();
  const original = Buffer.from('original\n');
  write(dir, 'index.js', 'changed\n');
  write(dir, 'extra.mjs', 'export {};\n');
  fs.mkdirSync(path.join(dir, 'unreadable.txt'));
  const rec = { files: Object.fromEntries(['index.js', 'missing.txt', 'unreadable.txt'].map((rel) => [rel, moduleFileSha1(original)])) };
  const result = builtinContentMatches(rec, path.join(dir, 'index.js'));
  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, [
    { path: 'index.js', type: 'content' },
    { path: 'missing.txt', type: 'missing' },
    { path: 'unreadable.txt', type: 'unreadable' },
    { path: 'extra.mjs', type: 'extra-executable' }
  ]);
});

test('内置拒载文案先列出真正失配文件，再说明能力扫描和权限边界', () => {
  const rec = baseline.modules.find((item) => item.dir === 'mem-layered');
  const dir = copyBuiltin(rec, sandbox(), '\r\n');
  fs.appendFileSync(path.join(dir, 'README.md'), ' ');
  const result = checkPluginTrust(rec.id, path.join(dir, rec.entry));
  assert.equal(result.ok, false);
  assert.match(result.reason, /^内置模块「mem-layered」的以下文件与随包基线不一致：README\.md（内容指纹不一致）。/);
  assert.match(result.reason, /仅换行差异，已归一化且不影响校验/);
  assert.match(result.reason, /能力扫描命中：.+（导入了高危 Node 模块）/);
  assert.match(result.reason, /仍受宿主账号和操作系统权限约束/);
  assert.doesNotMatch(result.reason, /获得本机全部权限/);
});

test('重算插件及技能基线共用归一化指纹，换行转换不会触发重写', () => {
  for (const kind of ['plugin', 'skill']) {
    const appRoot = sandbox();
    const dir = path.join(appRoot, kind === 'skill' ? 'skills' : 'plugins', 'fixture');
    const text = Buffer.from('export default {};\n');
    const binary = Buffer.from([0, 13, 10, 0xff]);
    write(dir, 'index.js', withLineEndings(text, '\r\n'));
    write(dir, 'image.bin', binary);
    const baselineFile = path.join(appRoot, 'builtin-modules.json');
    write(appRoot, 'builtin-modules.json', JSON.stringify({ version: 2, modules: [{ dir: 'fixture', kind, files: {} }] }));
    assert.equal(refreshBuiltinEntry('fixture', { appRoot }).updated, true);
    const saved = fs.readFileSync(baselineFile, 'utf8');
    const rec = JSON.parse(saved).modules[0];
    assert.deepEqual(rec.files, { 'image.bin': rawSha1(binary), 'index.js': rawSha1(text) });
    assert.equal(builtinContentMatches(rec, path.join(dir, 'index.js')).matches, true);
    write(dir, 'index.js', text);
    assert.deepEqual(refreshBuiltinEntry('fixture', { appRoot }), { ok: true, updated: false, files: 2 });
    assert.equal(fs.readFileSync(baselineFile, 'utf8'), saved);
  }
});
