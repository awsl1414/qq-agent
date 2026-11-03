import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-lifecycle-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const theme = await import('../src/wallpaper/theme.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

for (const action of ['deactivate', 'dispose', 'activate']) {
  test(`壁纸同步回调等待期间 ${action} 不会复活旧循环`, async (t) => {
    const timers = new Set();
    t.mock.method(globalThis, 'setTimeout', (callback) => {
      const timer = { callback, unref() {} };
      timers.add(timer);
      return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', (timer) => timers.delete(timer));
    theme.setup({ config: () => ({ follow: false }) });
    await theme.activate();
    const first = [...timers][0];
    timers.delete(first);
    const running = first.callback();
    await theme[action]();
    await running;
    try { assert.equal(timers.size, action === 'activate' ? 1 : 0); }
    finally { theme.dispose(); }
  });
}

test('壁纸图片头读取失败仍关闭已打开的文件', (t) => {
  const file = path.join(temp, 'broken.jpg');
  fs.writeFileSync(file, 'test');
  let opened;
  const open = fs.openSync;
  const close = fs.closeSync;
  let closed = false;
  t.mock.method(fs, 'openSync', (...args) => (opened = open(...args)));
  t.mock.method(fs, 'readSync', () => { throw new Error('read failed'); });
  t.mock.method(fs, 'closeSync', (fd) => { closed = fd === opened; return close(fd); });
  assert.equal(theme.internals.imageWidth(file), 0);
  try { assert.equal(closed, true); }
  finally { if (!closed) close(opened); }
});
