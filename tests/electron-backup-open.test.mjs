import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const filename = fileURLToPath(new URL('../electron/main.js', import.meta.url));
const source = fs.readFileSync(filename, 'utf8');
const start = source.indexOf("ipcMain.handle('dialog:pick-backup'");
const block = source.slice(start, source.indexOf('// 保存位置必须', start));

function setup({ canceled = false, chunks = [Buffer.from('backup bytes')], error } = {}) {
  let handler;
  const mainWindow = {};
  const calls = { dialogs: [], reads: [] };
  vm.runInNewContext(block, {
    Uint8Array, Buffer, path, mainWindow, windowOf: (event) => event.win,
    ipcMain: { handle(channel, fn) { assert.equal(channel, 'dialog:pick-backup'); handler = fn; } },
    dialog: { async showOpenDialog(win, options) { calls.dialogs.push({ win, options }); return { canceled, filePaths: ['chosen-backup.zip'] }; } },
    fs: { createReadStream(file) { calls.reads.push(file); if (error) throw error; return Readable.from(chunks); } }
  }, { filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { handler, calls, event: { win: mainWindow } };
}

test('desktop backup picker reads only the dialog-selected file and returns bytes to the common HTTP flow', async () => {
  const { handler, calls, event } = setup();
  const result = await handler(event, 'untrusted-renderer-path');
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.dialogs[0].win, event.win);
  assert.deepEqual([...calls.dialogs[0].options.filters[0].extensions], ['zip', 'qqab']);
  assert.deepEqual(calls.reads, ['chosen-backup.zip']);
  assert.equal(Buffer.from(result.bytes).toString(), 'backup bytes');
  assert.equal(result.name, 'chosen-backup.zip');
  assert.equal(Object.hasOwn(result, 'path'), false);
});

test('backup picker cancellation and other-window calls never read local files', async () => {
  const { handler, calls, event } = setup({ canceled: true });
  assert.equal((await handler({ win: {} })).ok, false);
  assert.equal(calls.dialogs.length, 0);
  assert.equal((await handler(event)).canceled, true);
  assert.equal(calls.reads.length, 0);
});

test('backup picker rejects oversized reads and reports file failures', async () => {
  const { BACKUP_MAX_ARCHIVE_BYTES } = await import('../src/backup/archive.js');
  for (const options of [{ chunks: [Buffer.allocUnsafe(BACKUP_MAX_ARCHIVE_BYTES + 1)] }, { error: new Error('read failed') }]) {
    const { handler, event } = setup(options);
    const result = await handler(event);
    assert.equal(result.ok, false);
    assert.match(result.error, /体积超过上限|read failed/);
    assert.equal(result.bytes, undefined);
  }
});
