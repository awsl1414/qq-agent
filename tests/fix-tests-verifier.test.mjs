import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-tests-verifier-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { runVerifyPlan } = await import('../src/harness/fix/checks.js');
const core = await import('../src/harness/fix/core.js');
const fix = await import('../src/harness/fix/index.js');
const dev = await import('../src/harness/dev/index.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function put(root, file, code = 'import { test } from "node:test"; test("executed", () => {});') {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, code);
  return abs;
}
function fixture() {
  const project = fs.mkdtempSync(path.join(temp, 'project-'));
  put(project, 'package.json', '{"type":"module"}');
  return project;
}
function verify(projectRoot, file) {
  return standaloneNode(() => runVerifyPlan('', projectRoot, '', { proposal: { verifyPlan: [{ verifier: 'tests', file }] } }, { projectRoot }).items[0]);
}
function standaloneNode(run) {
  // 子进程是一次独立测试运行，不能继承父 node:test 的内部运行标记。
  const context = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return run(); }
  finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
}

for (const file of ['tests/pass.test.mjs', 'tests/nested/pass.js', '.workbuddy/tools/legacy.mjs']) {
  test(`执行实际存在的白名单脚本：${file}`, () => {
    const root = fixture();
    put(root, file);
    const result = verify(root, file);
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.match(result.stdout, /executed/);
    assert.match(result.detail, /未隔离到沙箱改动版/);
  });
}

test('两目录同时存在时只采用 tests，不放行上游目录', () => {
  const root = fixture();
  put(root, 'tests/ok.mjs');
  put(root, '.workbuddy/tools/old.mjs');
  assert.equal(verify(root, 'tests/ok.mjs').status, 'pass');
  assert.equal(verify(root, '.workbuddy/tools/old.mjs').status, 'fail');
});

test('无测试目录、无项目根或未指定文件时诚实 skip', () => {
  const root = fixture();
  assert.match(verify(root, 'tests/missing.mjs').detail, /没有测试目录/);
  assert.equal(verify(root, 'tests/missing.mjs').status, 'skip');
  assert.equal(verify('', 'tests/missing.mjs').status, 'skip');
  assert.equal(verify(root, '').status, 'skip');
});

test('tests 是普通文件时不误当目录，仍可使用上游目录', () => {
  const root = fixture();
  put(root, 'tests', 'not a directory');
  put(root, '.workbuddy/tools/ok.mjs');
  assert.equal(verify(root, '.workbuddy/tools/ok.mjs').status, 'pass');
});

test('白名单内不存在的文件与失败断言分别返回 fail', () => {
  const root = fixture();
  put(root, 'tests/bad.mjs', 'import { test } from "node:test"; test("fails", () => { throw new Error("expected failure"); });');
  assert.equal(verify(root, 'tests/missing.mjs').status, 'fail');
  const result = verify(root, 'tests/bad.mjs');
  assert.equal(result.status, 'fail');
  assert.match(result.stdout, /expected failure/);
});

test('拒绝越界、前缀伪装、不允许的后缀及伪装成脚本的目录', () => {
  const root = fixture();
  const marker = path.join(root, 'executed.txt');
  const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`;
  put(root, 'outside.mjs', code);
  put(root, 'tests-other/escape.mjs', code);
  put(root, 'tests/bad.cjs', code);
  fs.mkdirSync(path.join(root, 'tests/folder.mjs'));
  for (const file of ['tests/../outside.mjs', 'tests-other/escape.mjs', 'tests/bad.cjs', 'tests/folder.mjs', path.join(root, 'outside.mjs')]) {
    assert.equal(verify(root, file).status, 'fail', file);
  }
  assert.equal(fs.existsSync(marker), false);
});

for (const linkedRoot of [false, true]) {
  test(`拒绝${linkedRoot ? '测试根' : '测试子目录'}通过联接逃出白名单`, () => {
    const root = fixture();
    const outside = fixture();
    const marker = path.join(outside, 'executed.txt');
    put(outside, 'escape.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    if (!linkedRoot) fs.mkdirSync(path.join(root, 'tests'));
    const link = linkedRoot ? 'tests' : 'tests/link';
    fs.symlinkSync(outside, path.join(root, link), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(verify(root, `${link}/escape.mjs`).status, 'fail');
    assert.equal(fs.existsSync(marker), false);
  });
}

for (const resources of [null, 'resources', 'Resources']) {
  test(`${resources ? `${resources}/app` : '源码'}布局通过真实 fix.verify 入口找到测试，开发根一致`, () => {
    const project = fixture();
    const app = resources ? path.join(project, resources, 'app') : project;
    fs.mkdirSync(app, { recursive: true });
    const file = resources ? '.workbuddy/tools/ok.mjs' : 'tests/ok.test.mjs';
    put(project, file);
    const root = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data/self-fix');
    const id = core.newFixId();
    const change = { scope: 'code', path: 'sample.txt' };
    put(path.dirname(core.stagedPath(root, id, change)), 'sample.txt', 'staged');
    core.writeRecord(root, id, { id, createdAt: Date.now(), status: 'applied', proposal: { changes: [change], verifyPlan: [{ verifier: 'tests', file }] } });
    const api = { appRoot: app, config: () => ({ fixEnabled: true }), log() {} };
    fix.setup(api);
    const result = standaloneNode(() => fix.providers['fix.verify']({ fixId: id }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.verify.items[0].status, 'pass', JSON.stringify(result));
    dev.setup(api);
    assert.equal(dev.providers['dev.snapshot']().projectRoot, project);
    assert.equal(fs.existsSync(path.join(project, 'dev-sandbox')), true);
  });
}

for (const [label, response, status] of [
  ['现存 critical 阻断', { result: { findings: [{ file: 'sample.txt', severity: 'critical', ruleId: 'test', line: 1, detail: 'critical' }] } }, 'fail'],
  ['无命中可通过', { result: { findings: [] } }, 'pass'],
  ['能力缺失诚实跳过', undefined, 'skip'],
  ['结果形态不符诚实跳过', {}, 'skip']
]) {
  test(`fix.verify 使用 capability 返回的扫描结果：${label}`, () => {
    const app = fixture();
    const root = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data/self-fix');
    const id = core.newFixId();
    const change = { scope: 'code', path: 'sample.txt' };
    put(path.dirname(core.stagedPath(root, id, change)), 'sample.txt', 'staged');
    core.writeRecord(root, id, { id, createdAt: Date.now(), status: 'applied', proposal: { changes: [change], verifyPlan: [{ verifier: 'scan' }] } });
    let calls = 0;
    fix.setup({ appRoot: app, config: () => ({ fixEnabled: true }), log() {}, capability(name, args) {
      assert.equal(name, 'doctor.scan-project');
      assert.deepEqual(args, {});
      calls++;
      return response;
    } });
    const result = fix.providers['fix.verify']({ fixId: id });
    assert.equal(result.ok, true);
    assert.equal(result.verify.items[0].status, status);
    assert.equal(calls, 1);
    if (status !== 'skip') assert.match(result.verify.items[0].detail, /未验证沙箱改动版/);
  });
}
