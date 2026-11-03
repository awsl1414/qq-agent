import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, applyRetention } from '../src/backup/schedule.js';

const HOUR_MS = 60 * 60 * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(runBackup = async () => ({ ok: true })) {
  const timers = new Map();
  let id = 0;
  let time = 0;
  const warnings = [];
  const config = { backup: { enabled: true, intervalHours: 24 } };
  const scheduler = createScheduler({
    now: () => time,
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimeout(key) { timers.delete(key); }
  });
  scheduler.start({ runBackup, getConfig: () => config, logger: { warn: (...args) => warnings.push(args) } });
  return {
    scheduler, timers, config, warnings,
    async tick(elapsed = config.backup.intervalHours * HOUR_MS) {
      time += elapsed;
      const [key, timer] = timers.entries().next().value;
      timers.delete(key);
      timer.callback();
      await flush();
    },
    delay() { return timers.values().next().value?.delay; }
  };
}

test('first run waits one interval and next interval reads updated config', async () => {
  let calls = 0;
  const f = fixture(async (options) => { assert.equal(options.trigger, 'scheduled'); calls += 1; });
  assert.equal(calls, 0);
  assert.equal(f.delay(), 60 * 1000);
  f.config.backup.intervalHours = 2;
  await f.tick();
  assert.equal(calls, 1);
  assert.equal(f.delay(), 60 * 1000);
  await f.tick();
  assert.equal(calls, 2);
  f.scheduler.stop();
  assert.equal(f.timers.size, 0);
});

test('callback failures are logged and later runs still execute', async () => {
  let calls = 0;
  const f = fixture(() => { if (++calls === 1) throw new Error('offline'); return { ok: false, error: 'failed result' }; });
  await f.tick();
  await f.tick();
  assert.equal(calls, 2);
  assert.equal(f.warnings.length, 2);
  assert.equal(f.timers.size, 1);
  f.scheduler.stop();
});

test('disabled schedule skips runs and runNow coalesces concurrent work', async () => {
  let calls = 0;
  let finish;
  const f = fixture(() => { calls += 1; return new Promise((resolve) => { finish = resolve; }); });
  f.config.backup.enabled = false;
  await f.tick();
  assert.equal(calls, 0);
  const first = f.scheduler.runNow();
  assert.equal(first, f.scheduler.runNow());
  await flush();
  f.scheduler.stop();
  finish({ ok: true });
  await first;
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
});

test('stop during scheduled work prevents rearming; logging failures are contained', async () => {
  let finish;
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  await f.tick();
  f.scheduler.stop();
  finish({ ok: true });
  await flush();
  assert.equal(f.timers.size, 0);
  f.scheduler.start({ runBackup: () => { throw new Error('offline'); }, logger: { warn() { throw new Error('disk full'); } } });
  assert.equal((await f.scheduler.runNow()).ok, false);
  f.scheduler.stop();
});

function key(day) { return `qq-agent/backup-202611${String(day).padStart(2, '0')}-0300.qqab`; }

test('retention deletes oldest keys regardless of mtime and preserves unrelated files', async () => {
  const deleted = [];
  const entries = [4, 1, 5, 2, 3].map((day) => ({ key: key(day), mtimeMs: 10 - day }));
  const target = { list: async () => [...entries, { key: 'other.txt' }], remove: async (value) => deleted.push(value) };
  assert.deepEqual(await applyRetention(target, 2), { removed: 3, kept: 2 });
  assert.deepEqual(deleted, [key(1), key(2), key(3)]);
});

test('retention defaults to seven and contains list and individual removal failures', async () => {
  const deleted = [];
  const entries = Array.from({ length: 9 }, (_, index) => ({ key: key(index + 1) }));
  const target = { type: 'fake', list: async () => entries, remove: async (value) => deleted.push(value) };
  assert.deepEqual(await applyRetention(target), { removed: 2, kept: 7 });
  assert.deepEqual(deleted, [key(1), key(2)]);
  target.remove = async (value) => { if (value === key(1)) throw new Error('offline'); };
  assert.deepEqual(await applyRetention(target), { removed: 1, kept: 8 });
  target.list = async () => { throw new Error('offline'); };
  assert.deepEqual(await applyRetention(target), { removed: 0, kept: 0 });
});

test('retention invalid counts use safe default and large counts remove nothing', async () => {
  for (const retention of [0, -1, 0.5, Infinity, NaN, 20]) {
    const deleted = [];
    const target = { list: async () => [1, 2, 3].map((day) => ({ key: key(day) })), remove: async (value) => deleted.push(value) };
    assert.deepEqual(await applyRetention(target, retention), { removed: 0, kept: 3 });
    assert.deepEqual(deleted, []);
  }
});

test('extending interval, sleep and repeated start keep exactly one timer and avoid catch-up loops', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; return { ok: true }; });
  await f.tick(HOUR_MS);
  assert.equal(calls, 0);
  f.config.backup.intervalHours = 48;
  await f.tick(24 * HOUR_MS);
  assert.equal(calls, 0);
  await f.tick(100 * HOUR_MS);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 1);
  const handlers = { runBackup: async () => { calls += 1; }, getConfig: () => f.config, logger: { warn() {} } };
  f.scheduler.start(handlers);
  f.scheduler.start(handlers);
  assert.equal(f.timers.size, 1);
  f.scheduler.stop();
  assert.equal(f.timers.size, 0);
});
