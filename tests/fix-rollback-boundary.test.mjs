import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-rollback-boundary-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { rollback } = await import('../src/harness/fix/core.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

function fixture() {
  const root = fs.mkdtempSync(path.join(temp, 'case-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(app, 'target.txt'), 'current');
  return { root, app };
}
for (const link of [false, true]) {
  test(`自修复回滚整体拒绝越界快照源，前面的合法删除也不执行（联接=${link}）`, () => {
    const { root, app } = fixture();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    let backupRel = 'outside/secret.txt';
    if (link) {
      fs.mkdirSync(path.join(root, 'backups', 'job'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'backups', 'job', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      backupRel = 'backups/job/linked/secret.txt';
    }
    const result = rollback(root, 'job', app, root, { snapshot: { files: [
      { scope: 'code', path: 'keep.txt', isNew: true },
      { scope: 'code', path: 'target.txt', isNew: false, backupRel }
    ] } });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(app, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(app, 'target.txt'), 'utf8'), 'current');
  });
}

test('自修复回滚删除失败必须报错，不伪造 rolled-back 成功', (t) => {
  const { root, app } = fixture();
  t.mock.method(fs, 'rmSync', () => { throw new Error('access denied'); });
  const result = rollback(root, 'job', app, root, { snapshot: { files: [{ scope: 'code', path: 'keep.txt', isNew: true }] } });
  assert.equal(result.ok, false);
  assert.match(result.error, /access denied/);
  assert.equal(fs.readFileSync(path.join(app, 'keep.txt'), 'utf8'), 'keep');
});

test('自修复合法快照恢复原内容并删除新增文件', () => {
  const { root, app } = fixture();
  const backupRel = 'backups/job/code/target.txt';
  fs.mkdirSync(path.dirname(path.join(root, backupRel)), { recursive: true });
  fs.writeFileSync(path.join(root, backupRel), 'old');
  const result = rollback(root, 'job', app, root, { snapshot: { files: [
    { scope: 'code', path: 'keep.txt', isNew: true },
    { scope: 'code', path: 'target.txt', isNew: false, backupRel }
  ] } });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(app, 'keep.txt')), false);
  assert.equal(fs.readFileSync(path.join(app, 'target.txt'), 'utf8'), 'old');
});
