import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-boundary-'));
const data = path.join(root, 'data');
process.env.QQ_AGENT_DATA_DIR = data;
const { applyImport, rollbackImport } = await import('../src/migrate.js');
const id = '2026-11-04_120000-000';
const backup = path.join(data, 'import-backups', id);
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function read(file) {
  return fs.readFileSync(file, 'utf8');
}
/** 逐字节记录目录树；回滚载体与运行日志不参与数据比对。 */
function snapshot(dir) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, file).replace(/\\/g, '/'), fs.readFileSync(file).toString('base64')];
    })
    .filter(([rel]) => !rel.startsWith('import-backups/') && !rel.startsWith('logs/'))
    .sort(([a], [b]) => a.localeCompare(b)));
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

test('恢复源里的符号链接文件仍被拒绝，不会把链接指向的内容写进数据目录', async (t) => {
  // 回滚会按清单把备份文件复制回原位；备份里若混入指向边界外的链接，
  // checkedSourcePath 必须在预检阶段拦下，而不是在复制时读到链接目标。
  const external = path.join(root, 'outside-link-target.txt');
  write(external, 'outside secret');
  fs.mkdirSync(backup, { recursive: true });
  const link = path.join(backup, 'evil.txt');
  try { fs.symlinkSync(external, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('文件符号链接不可用'); return; }
    throw error;
  }
  manifest([{ type: 'messages', target: 'copied.txt', backup: 'evil.txt' }]);
  const result = await rollbackImport(id);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /符号链接|目录联接/);
  assert.equal(fs.existsSync(path.join(data, 'copied.txt')), false);
});

test('file↔dir 互换的导入回滚真正成功，目录树逐字节还原', async () => {
  // 真实场景：本机暂存区里 `file-to-dir` 是文件、`dir-to-file` 是目录，
  // 来件草稿正好把两者互换。导入生成的清单会同时记录两类动作：
  // 旧内容的还原快照，以及"本轮新增路径"（backup=null）的删除项。
  const staging = path.join(data, 'plugin-data', 'extension-forge', 'staging');
  write(path.join(staging, 'same/file-to-dir'), 'old file');
  write(path.join(staging, 'same/dir-to-file/index.js'), 'old nested file');
  const before = snapshot(data);

  const source = path.join(root, 'swap-source');
  write(path.join(source, 'drafts/same/file-to-dir/index.js'), 'new nested file');
  write(path.join(source, 'drafts/same/dir-to-file'), 'new file');
  const applied = await applyImport(source, { drafts: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  // 互换确实发生了：原文件变成目录、原目录变成文件。
  assert.equal(read(path.join(staging, 'same/file-to-dir/index.js')), 'new nested file');
  assert.equal(read(path.join(staging, 'same/dir-to-file')), 'new file');

  // 关键点：回滚预检会遍历到 "swap 是文件、swap/x 无从谈起" 的 ENOTDIR。
  // 若把它当成清单不安全，整次回滚会被一票否决，旧内容一个都还原不了；
  // 这里断言的是回滚真的成功、真的还原，而不只是"没报清单不安全"。
  const result = await rollbackImport(applied.backupId);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
  assert.equal(result.restored, 2);
  assert.equal(result.removed, 2);

  // 逐字节比对：回滚后数据目录（排除回滚自身的备份目录）与导入前完全一致。
  assert.deepEqual(snapshot(data), before);
  assert.equal(read(path.join(staging, 'same/file-to-dir')), 'old file');
  assert.equal(read(path.join(staging, 'same/dir-to-file/index.js')), 'old nested file');
});
