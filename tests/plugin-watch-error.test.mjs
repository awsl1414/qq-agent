import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { watchPlugins } from '../src/plugin-loader.js';

test('扩展监听：建立后的异步 error 被报告，日志失败也不应使进程退出', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-watch-error-'));
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => { closed = true; };
  t.mock.method(fs, 'watch', () => watcher);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  let failLog = false;
  const subscription = watchPlugins({
    roots: { plugins: root, skills: path.join(root, 'missing') },
    log: (message) => {
      if (failLog) throw new Error('log failed');
      logs.push(message);
    }
  });
  t.after(() => subscription?.close());
  assert.doesNotThrow(() => watcher.emit('error', Object.assign(new Error('access denied'), { code: 'EPERM' })));
  assert.ok(logs.some((message) => message.includes('目录监听失效') && message.includes('access denied')));
  failLog = true;
  assert.doesNotThrow(() => watcher.emit('error', new Error('watch failed again')));
  subscription.close();
  assert.equal(closed, true);
});
