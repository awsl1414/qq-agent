import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 主进程入口不能在 node:test 中启动；只装载 IPC 注册块并替换原生对话框边界。
const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const start = source.indexOf("ipcMain.handle('backup:save-file'");
const block = source.slice(start, source.indexOf('\n// 拖放反查路径', start));

function setup({ canceled = false, error = null } = {}) {
  const mainWindow = {};
  const calls = { dialogs: [], writes: [] };
  let handler;
  vm.runInNewContext(block, {
    Uint8Array, path, mainWindow, windowOf: (event) => event.win,
    ipcMain: { handle(channel, fn) { assert.equal(channel, 'backup:save-file'); handler = fn; } },
    dialog: { async showSaveDialog(win, options) { calls.dialogs.push({ win, options }); return { canceled, filePath: 'chosen-backup.zip' }; } },
    fs: { promises: { async writeFile(file, bytes) { if (error) throw error; calls.writes.push({ file, bytes }); } } }
  });
  return { handler, calls, event: { win: mainWindow } };
}

test('desktop backup save uses a parented save dialog and writes exactly the selected bytes', async () => {
  const { handler, calls, event } = setup();
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const result = await handler(event, '../backup.zip', bytes);
  assert.equal(result.ok, true);
  assert.equal(calls.dialogs[0].win, event.win);
  assert.equal(calls.dialogs[0].options.defaultPath, 'backup.zip');
  assert.equal(calls.dialogs[0].options.filters[0].extensions[0], 'zip');
  assert.equal(calls.writes[0].file, 'chosen-backup.zip');
  assert.equal(calls.writes[0].bytes, bytes);
});

test('canceling the native save dialog writes nothing', async () => {
  const { handler, calls, event } = setup({ canceled: true });
  const result = await handler(event, 'backup.zip', new Uint8Array([1]));
  assert.equal(result.canceled, true);
  assert.equal(calls.writes.length, 0);
});

test('desktop save rejects other windows and invalid payloads before opening a dialog', async () => {
  const { handler, calls, event } = setup();
  assert.equal((await handler({ win: {} }, 'backup.zip', new Uint8Array([1]))).ok, false);
  assert.equal((await handler(event, 'backup.zip', new Uint8Array())).ok, false);
  assert.equal((await handler(event, 'backup.zip', 'not bytes')).ok, false);
  assert.equal(calls.dialogs.length, 0);
});

test('native file write failures are returned to the UI', async () => {
  const { handler, event } = setup({ error: new Error('disk full') });
  const result = await handler(event, 'backup.zip', new Uint8Array([1]));
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});
