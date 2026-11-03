import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-collision-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { setup, providers } = await import('../src/harness/forge/index.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('锻造台候选目录耗尽不覆盖现有模块，失败不消耗确认票据', () => {
  setup({ config: () => ({}), log() {}, appRoot: temp });
  const draftId = 'sample';
  const draft = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data', 'extension-forge', 'staging', draftId);
  fs.mkdirSync(draft, { recursive: true });
  fs.writeFileSync(path.join(draft, 'skill.json'), JSON.stringify({ id: 'sample', name: '样例', apiVersion: 1, entry: 'index.js' }));
  fs.writeFileSync(path.join(draft, 'index.js'), 'export function setup(api) {}');
  const ticket = providers['forge.confirm-ticket']({ draftId, human: true });
  assert.equal(ticket.ok, true, JSON.stringify(ticket));
  for (let i = 0; i <= 100; i++) {
    const dir = path.join(temp, 'skills', i ? `sample_${i}` : 'sample');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), 'original');
  }
  const result = providers['forge.install']({ draftId, approvalToken: ticket.approvalToken, confirmIssues: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /占用/);
  assert.equal(fs.readFileSync(path.join(temp, 'skills', 'sample_100', 'index.js'), 'utf8'), 'original');
  fs.rmSync(path.join(temp, 'skills', 'sample_100'), { recursive: true });
  const retried = providers['forge.install']({ draftId, approvalToken: ticket.approvalToken, confirmIssues: true });
  assert.equal(retried.ok, true, JSON.stringify(retried));
});

test('锻造台升级复制失败可恢复旧扩展，不因缺少目标根目录丢失旧版', (t) => {
  const app = path.join(temp, 'upgrade-app');
  setup({ config: () => ({}), log() {}, appRoot: app });
  const target = path.join(app, 'skills', 'upgrade-sample');
  fs.mkdirSync(target, { recursive: true });
  const manifest = { id: 'upgrade-sample', name: '样例', apiVersion: 1, entry: 'index.js', version: '1' };
  fs.writeFileSync(path.join(target, 'skill.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(target, 'index.js'), 'export const value = "old";');
  const started = providers['forge.upgrade-start']({ kind: 'skill', dir: 'upgrade-sample' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const draft = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data', 'extension-forge', 'staging', started.draftId);
  fs.writeFileSync(path.join(draft, 'index.js'), 'export const value = "new";');
  const ticket = providers['forge.confirm-ticket']({ draftId: started.draftId, human: true });
  assert.equal(ticket.ok, true, JSON.stringify(ticket));
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (src, dest, ...args) => {
    if (src === path.join(draft, 'index.js')) throw new Error('upgrade copy failed');
    return copy(src, dest, ...args);
  });
  const result = providers['forge.upgrade-install']({ draftId: started.draftId, kind: 'skill', dir: 'upgrade-sample', confirmIssues: true, approvalToken: ticket.approvalToken });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'export const value = "old";');
});

test('锻造台回滚复制失败恢复回滚前完整版本，不保留空壳目标', (t) => {
  const app = path.join(temp, 'rollback-app');
  setup({ config: () => ({}), log() {}, appRoot: app });
  const target = path.join(app, 'skills', 'rollback-sample');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'skill.json'), JSON.stringify({ id: 'rollback-sample' }));
  fs.writeFileSync(path.join(target, 'index.js'), 'current');
  const backup = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data', 'extension-forge', 'backups', 'rollback-sample', '2026-01-01');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'index.js'), 'old');
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (src, dest, ...args) => {
    if (src === path.join(backup, 'index.js')) throw new Error('rollback copy failed');
    return copy(src, dest, ...args);
  });
  const result = providers['forge.rollback']({ kind: 'skill', dir: 'rollback-sample' });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), 'current');
});
