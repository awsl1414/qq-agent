import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-file-boundary-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { buildDevTools } = await import('../src/harness/dev/executor.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('开发文件工具拒绝通过目录联接访问项目外文件', async () => {
  const root = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { defs } = buildDevTools(root, path.join(root, '.work'));
  for (const [id, args] of [
    ['dev_read_file', { path: 'linked/secret.txt' }],
    ['dev_list_dir', { path: 'linked' }],
    ['dev_write_file', { path: 'linked/new/created.txt', content: 'bad' }],
    ['dev_delete_file', { path: 'linked/secret.txt' }]
  ]) {
    const result = await defs.find((d) => d.id === id).execute({}, args);
    assert.equal(result.isError, true, id);
  }
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
});

test('开发文件工具仍可创建项目内多级新文件并读取', async () => {
  const root = path.join(temp, 'valid');
  fs.mkdirSync(root);
  const { defs } = buildDevTools(root, path.join(root, '.work'));
  const written = await defs.find((d) => d.id === 'dev_write_file').execute({}, { path: 'a/b.txt', content: 'hello' });
  assert.notEqual(written.isError, true);
  const read = await defs.find((d) => d.id === 'dev_read_file').execute({}, { path: 'a/b.txt' });
  assert.notEqual(read.isError, true);
  assert.match(read.content, /hello/);
});
