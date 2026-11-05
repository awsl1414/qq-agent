import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { watchPlugins } from '../src/plugin-loader.js';

test('扩展监听：建立后的异步 error 被报告为 warn 级，日志失败也不应使进程退出', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-watch-error-'));
  const watcher = new EventEmitter();
  let closed = false;
  watcher.close = () => { closed = true; };
  t.mock.method(fs, 'watch', () => watcher);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // watchPlugins 的 log 是分级对象（src/logger.js 的 subLogger）：级别由调用点给出。
  // 目录监听失效会让热重载停摆，但单个目录的问题可恢复（重建监听即可），按
  // 任务分级表属"单个扩展/子系统失败" → warn。
  const logs = [];
  let failLog = false;
  const record = (level) => (message) => {
    if (failLog) throw new Error('log failed');
    logs.push({ level, message });
  };
  const subscription = watchPlugins({
    roots: { plugins: root, skills: path.join(root, 'missing') },
    log: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
  });
  t.after(() => subscription?.close());
  assert.doesNotThrow(() => watcher.emit('error', Object.assign(new Error('access denied'), { code: 'EPERM' })));
  const hit = logs.find((entry) => entry.message.includes('目录监听失效') && entry.message.includes('access denied'));
  assert.ok(hit, '监听失效必须写日志');
  assert.equal(hit.level, 'warn', '监听失效是 warn 级，不按文案关键字推断');
  failLog = true;
  assert.doesNotThrow(() => watcher.emit('error', new Error('watch failed again')));
  subscription.close();
  assert.equal(closed, true);
});
