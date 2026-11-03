import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-boundary-'));
const data = path.join(root, 'data');
process.env.QQ_AGENT_DATA_DIR = data;
const { rollbackImport } = await import('../src/migrate.js');
const id = '2026-11-04_120000-000';
const backup = path.join(data, 'import-backups', id);
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function manifest(actions, directory = backup) {
  write(path.join(directory, 'manifest.json'), JSON.stringify({ actions }));
}
beforeEach(() => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(data);
  write(path.join(root, 'outside.txt'), 'keep');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('回滚 backupId 不得读取备份根目录之外的清单', async () => {
  write(path.join(data, 'keep.txt'), 'keep');
  manifest([{ type: 'messages', target: 'keep.txt' }], path.join(root, 'foreign'));
  const result = await rollbackImport('../../foreign');
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'keep');
});

for (const restore of [false, true]) {
  test(`回滚拒绝越界${restore ? '写入' : '删除'}目标，其他合法目标也保持不变`, async () => {
    write(path.join(data, 'keep.txt'), 'keep');
    write(path.join(backup, 'saved.txt'), 'replace');
    manifest([
      { type: 'messages', target: 'keep.txt' },
      { type: 'messages', target: '../outside.txt', ...(restore ? { backup: 'saved.txt' } : {}) }
    ]);
    const result = await rollbackImport(id);
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(data, 'keep.txt'), 'utf8'), 'keep');
  });
}

test('回滚备份内容路径不能越过当前备份目录', async () => {
  manifest([{ type: 'messages', target: 'copied.txt', backup: '../../../outside.txt' }]);
  const result = await rollbackImport(id);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(path.join(data, 'copied.txt')), false);
});

test('回滚拒绝经目录联接写入数据目录外', async () => {
  const external = path.join(root, 'external');
  write(path.join(external, 'keep.txt'), 'keep');
  fs.symlinkSync(external, path.join(data, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(backup, 'saved.txt'), 'replace');
  manifest([{ type: 'messages', target: 'linked/keep.txt', backup: 'saved.txt' }]);
  const result = await rollbackImport(id);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'keep');
});
