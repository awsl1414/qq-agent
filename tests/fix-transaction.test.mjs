import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-transaction-'));
const data = path.join(temp, 'data');
process.env.QQ_AGENT_DATA_DIR = data;
const core = await import('../src/harness/fix/core.js');
const { providers, setup } = await import('../src/harness/fix/index.js');
const { moduleFileSha1 } = await import('../src/plugin-loader.js');
const root = path.join(data, 'plugin-data', 'self-fix');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture({ count = 2, builtin = false, newFile = false } = {}) {
  const app = fs.mkdtempSync(path.join(temp, 'app-'));
  const id = core.newFixId();
  const changes = Array.from({ length: count }, (_, i) => ({
    scope: 'code', path: `${builtin ? 'plugins/demo/' : ''}${i}.txt`, level: builtin ? 'L2' : 'L1',
    intent: '修复文本', hunks: [{ from: 1, to: 1, replacement: `new-${i}` }]
  }));
  for (const [i, c] of changes.entries()) {
    if (!newFile || i !== count - 1) put(path.join(app, c.path), `old-${i}`);
    put(core.stagedPath(root, id, c), `new-${i}`);
  }
  const rec = {
    id, createdAt: 1, status: 'verified', question: '修复测试文本',
    approval: { approvedAt: 1, consumed: true, token: 'used' },
    proposal: { changes }, protocol: { passed: true, blocking: 0, violations: [] },
    snapshot: { files: [] }, decision: null
  };
  core.writeRecord(root, id, rec);
  const logs = [];
  const api = { appRoot: app, config: () => ({ fixEnabled: true, allowCoreFiles: true, auditKeepDays: 0, auditMaxRecords: 0 }), log: (...args) => logs.push(args.join(' ')) };
  setup(api);
  const call = (method, args = {}) => providers[`fix.${method}`]({ fixId: id, ...args });
  return {
    app, id, rec, changes, api, logs, call,
    read: () => core.readRecord(root, id),
    content: (i) => fs.readFileSync(path.join(app, changes[i].path), 'utf8'),
    backup: (i) => fs.readFileSync(core.backupPath(root, id, changes[i]), 'utf8')
  };
}

function failSecond(t, f) {
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    const durable = f.read();
    assert.equal(durable.snapshot.phase, 'writing');
    assert.equal(durable.snapshot.files.length, f.changes.length);
    if (source === core.stagedPath(root, f.id, f.changes[1])) throw new Error('second copy failed');
    return copy(source, target, ...args);
  });
  const result = f.call('commit');
  t.mock.restoreAll();
  assert.equal(result.ok, false);
  assert.match(result.error, /second copy failed/);
  assert.equal(f.content(0), 'new-0');
  assert.equal(f.read().snapshot.phase, 'writing');
  return result;
}

test('第二个文件复制失败后快照索引已持久化，回滚恢复首文件及其余文件', (t) => {
  const f = fixture();
  failSecond(t, f);
  assert.equal(f.content(1), 'old-1');
  assert.equal(f.backup(0), 'old-0');
  assert.equal(f.call('rollback').ok, true);
  assert.equal(f.content(0), 'old-0');
  assert.equal(f.content(1), 'old-1');
  assert.equal(f.read().snapshot.phase, 'rolled-back');
  assert.equal(f.read().status, 'proposed');
  assert.equal(f.read().approval.consumed, false);
});

test('重试跳过已完成目标，不覆盖原始快照，结单与阶段一并持久化', (t) => {
  const f = fixture();
  failSecond(t, f);
  const snapshot = f.read().snapshot;
  const copy = fs.copyFileSync;
  const copied = [];
  t.mock.method(fs, 'copyFileSync', (source, ...args) => {
    copied.push(source);
    return copy(source, ...args);
  });
  const result = f.call('commit');
  t.mock.restoreAll();
  assert.equal(result.ok, true);
  assert.deepEqual(copied, [core.stagedPath(root, f.id, f.changes[1])]);
  assert.equal(f.backup(0), 'old-0');
  assert.equal(f.backup(1), 'old-1');
  assert.deepEqual(f.read().snapshot.files, snapshot.files);
  assert.equal(f.read().snapshot.at, snapshot.at);
  assert.equal(f.read().snapshot.phase, 'committed');
  assert.equal(f.read().status, 'committed');
  assert.equal(f.read().decision.verdict, 'accept');
  assert.equal(f.call('commit').ok, false);
  assert.equal(f.call('rollback').ok, true);
  assert.equal(f.content(0), 'old-0');
});

test('手工构造 writing 记录，重启读取可识别中断并回滚（含新增文件）', () => {
  const f = fixture({ newFile: true });
  const files = f.changes.map((c, i) => {
    if (i === 0) put(core.backupPath(root, f.id, c), 'old-0');
    put(path.join(f.app, c.path), `new-${i}`);
    return { scope: c.scope, path: c.path, level: c.level, isNew: i === 1,
      backupRel: i === 0 ? path.relative(root, core.backupPath(root, f.id, c)) : null,
      hash: i === 0 ? core.sha1('old-0') : null, stagedHash: core.sha1(`new-${i}`) };
  });
  f.rec.snapshot = { files, at: 1, phase: 'writing' };
  core.writeRecord(root, f.id, f.rec);
  setup({ ...f.api, config: () => ({ fixEnabled: true, auditKeepDays: 1, auditMaxRecords: 1 }) });
  assert.match(f.call('detail').summary.recovery, /提交中断/);
  assert.ok(f.logs.some((line) => line.includes(f.id) && line.includes('提交中断')));
  assert.equal(f.call('rollback').ok, true);
  assert.equal(f.content(0), 'old-0');
  assert.equal(fs.existsSync(path.join(f.app, f.changes[1].path)), false);
});

for (const recover of ['commit', 'rollback']) {
  test(`真实进程在首次替换后退出，重新读取事务可 ${recover}`, () => {
    const f = fixture();
    const script = `
      import fs from 'node:fs';
      const core = await import(${JSON.stringify(new URL('../src/harness/fix/core.js', import.meta.url).href)});
      const [root, id, app, data, first] = process.argv.slice(1);
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (to === first) process.exit(73);
      };
      core.commit(root, id, app, data, core.readRecord(root, id));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root, f.id, f.app, data, path.join(f.app, f.changes[0].path)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 73, result.stderr);
    assert.equal(f.read().snapshot.phase, 'writing');
    assert.equal(f.content(0), 'new-0');
    assert.equal(f.content(1), 'old-1');
    assert.equal(f.call(recover).ok, true);
    assert.equal(f.content(0), recover === 'commit' ? 'new-0' : 'old-0');
    assert.equal(f.content(1), recover === 'commit' ? 'new-1' : 'old-1');
    assert.equal(f.backup(0), 'old-0');
  });
}

for (const count of [1, 2]) {
  test(`${count} 文件正常提交保持返回契约且可回滚`, () => {
    const f = fixture({ count });
    const out = f.call('commit');
    assert.equal(out.ok, true);
    assert.equal(out.fixId, f.id);
    assert.equal(out.files.length, count);
    assert.equal(out.coreChanged, true);
    assert.equal(out.needsRestart, true);
    assert.equal(f.read().status, 'committed');
    for (let i = 0; i < count; i++) assert.equal(f.content(i), `new-${i}`);
    assert.equal(f.call('rollback').ok, true);
    for (let i = 0; i < count; i++) assert.equal(f.content(i), `old-${i}`);
  });
}

test('失败不重算内置基线，成功重试后重算，回滚恢复原基线', (t) => {
  const f = fixture({ builtin: true });
  const baselinePath = path.join(f.app, 'builtin-modules.json');
  const original = JSON.stringify({ modules: [{ dir: 'demo', kind: 'plugin', files: { '0.txt': moduleFileSha1(Buffer.from('old-0')), '1.txt': moduleFileSha1(Buffer.from('old-1')) } }] });
  put(baselinePath, original);
  failSecond(t, f);
  assert.equal(fs.readFileSync(baselinePath, 'utf8'), original);
  assert.equal(f.call('commit').ok, true);
  let files = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).modules[0].files;
  assert.equal(files['0.txt'], moduleFileSha1(Buffer.from('new-0')));
  assert.equal(files['1.txt'], moduleFileSha1(Buffer.from('new-1')));
  assert.equal(f.call('rollback').ok, true);
  files = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).modules[0].files;
  assert.deepEqual(files, JSON.parse(original).modules[0].files);
});

for (const drift of ['target', 'staging', 'backup', 'manifest']) {
  test(`重试前 ${drift} 漂移则整体拒绝，不覆盖快照或真实文件`, (t) => {
    const f = fixture();
    failSecond(t, f);
    if (drift === 'target') put(path.join(f.app, f.changes[1].path), 'external');
    if (drift === 'staging') put(core.stagedPath(root, f.id, f.changes[1]), 'external');
    if (drift === 'backup') put(core.backupPath(root, f.id, f.changes[1]), 'external');
    if (drift === 'manifest') {
      const rec = f.read(); rec.proposal.changes.pop(); core.writeRecord(root, f.id, rec);
    }
    const before = [f.content(0), f.content(1), f.backup(0), f.backup(1)];
    assert.equal(f.call('commit').ok, false);
    assert.deepEqual([f.content(0), f.content(1), f.backup(0), f.backup(1)], before);
    assert.equal(f.read().snapshot.phase, 'writing');
  });
}

test('中断事务禁止 apply/verify/gate/discard/delete，启动与批量清理保留恢复索引', (t) => {
  const f = fixture();
  failSecond(t, f);
  const before = fs.readFileSync(core.recordFile(root, f.id), 'utf8');
  for (const method of ['apply', 'verify', 'gate', 'discard', 'delete']) {
    const out = f.call(method, { approvalToken: 'used', deleteSnapshot: true });
    assert.equal(out.ok, false, method);
    assert.match(out.error, /提交中断/);
  }
  const prune = f.call('prune', { before: Date.now(), status: 'verified', maxRecords: 1, dryRun: false });
  assert.equal(prune.ids.includes(f.id), false);
  setup({ ...f.api, config: () => ({ fixEnabled: true, auditKeepDays: 1, auditMaxRecords: 1 }) });
  assert.equal(fs.readFileSync(core.recordFile(root, f.id), 'utf8'), before);
  assert.equal(f.backup(0), 'old-0');
});

test('writing 清单持久化失败时真实文件完全不变，已有备份可复用', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === core.recordFile(root, f.id)) throw new Error('record unavailable');
    return rename(source, target);
  });
  const out = f.call('commit');
  t.mock.restoreAll();
  assert.equal(out.ok, false);
  assert.equal(f.content(0), 'old-0');
  assert.equal(f.content(1), 'old-1');
  assert.equal(f.read().snapshot.files.length, 0);
  assert.equal(f.backup(0), 'old-0');
  fs.rmSync(path.join(f.app, f.changes[0].path));
  const missing = f.call('commit');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /已有快照但原文件已不存在/);
  assert.equal(f.backup(0), 'old-0');
  put(path.join(f.app, f.changes[0].path), 'external');
  assert.equal(f.call('commit').ok, false);
  assert.equal(f.backup(0), 'old-0');
  put(path.join(f.app, f.changes[0].path), 'old-0');
  assert.equal(f.call('commit').ok, true);
  assert.equal(f.backup(0), 'old-0');
});

test('结单持久化失败仍保留 writing，重试仅结单且不覆盖原快照', (t) => {
  const f = fixture();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === core.recordFile(root, f.id) && JSON.parse(fs.readFileSync(source)).snapshot.phase === 'committed') throw new Error('final record unavailable');
    return rename(source, target);
  });
  assert.equal(f.call('commit').ok, false);
  t.mock.restoreAll();
  assert.equal(f.content(0), 'new-0');
  assert.equal(f.content(1), 'new-1');
  assert.equal(f.read().snapshot.phase, 'writing');
  assert.equal(f.call('commit').ok, true);
  assert.equal(f.backup(0), 'old-0');
});

test('复制中途损坏临时文件时真实目标仍完整，重试能够恢复', (t) => {
  const f = fixture();
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    if (source === core.stagedPath(root, f.id, f.changes[1])) {
      put(target, 'partial');
      throw new Error('copy interrupted');
    }
    return copy(source, target, ...args);
  });
  assert.equal(f.call('commit').ok, false);
  t.mock.restoreAll();
  assert.equal(f.content(1), 'old-1');
  assert.equal(f.call('commit').ok, true);
  assert.equal(f.content(1), 'new-1');
});

test('回滚后重新批准应用与自验可用，下一次提交复用最初基线', () => {
  const f = fixture();
  const created = providers['fix.create']({ proposal: {
    ...f.rec.proposal, rootCause: '修正文本', expectedEffect: '文本正确', rollback: '恢复快照',
    verifyPlan: [{ verifier: 'syntax' }, { verifier: 'protocol' }]
  } });
  const call = (method, args = {}) => providers[`fix.${method}`]({ fixId: created.fixId, ...args });
  let approvalToken = created.approvalToken;
  for (let round = 0; round < 2; round++) {
    assert.equal(call('apply', { approvalToken }).ok, true);
    const verify = call('verify');
    assert.equal(verify.ok, true);
    assert.equal(verify.verify.passed, true, JSON.stringify(verify.verify));
    assert.equal(call('commit').ok, true);
    assert.equal(fs.readFileSync(core.backupPath(root, created.fixId, f.changes[0]), 'utf8'), 'old-0');
    const rolled = call('rollback');
    assert.equal(rolled.ok, true);
    approvalToken = rolled.approvalToken;
  }
});
