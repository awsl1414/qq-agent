// 插件安装链路的三个修复（J1）：
//   · 同 id 重复安装必须被拒绝，磁盘上只能有一个目录（不再产生 `_1`）
//   · 同 digest 的未安装草稿能被识别出来（市场口令重复下载的判据）
//   · 孤儿目录（磁盘上有、注册表里没有）能被扫出来，且只报告不删除
//
// 只测锻造台自己的行为（能力层），路由层的接线由实机验证覆盖。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-id-conflict-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { setup, providers, scanOrphans } = await import('../src/harness/forge/index.js');
const { skillManager } = await import('../src/skills/manager.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const appRoot = path.join(temp, 'app');
const staging = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data', 'extension-forge', 'staging');

function boot() {
  setup({ config: () => ({}), log() {}, appRoot });
  fs.mkdirSync(staging, { recursive: true });
}

/** 造一个草稿：files 的键是草稿内相对路径。 */
function draft(id, files) {
  const dir = path.join(staging, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function skillDraft(id, manifestId, body = 'export function setup(api) {}') {
  return draft(id, {
    'skill.json': JSON.stringify({ id: manifestId, name: manifestId, apiVersion: 1, entry: 'index.js' }),
    'index.js': body
  });
}

function install(draftId) {
  const ticket = providers['forge.confirm-ticket']({ draftId, human: true });
  assert.equal(ticket.ok, true, JSON.stringify(ticket));
  return providers['forge.install']({ draftId, approvalToken: ticket.approvalToken });
}

beforeEach(() => {
  boot();
  fs.rmSync(path.join(appRoot, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(appRoot, 'plugins'), { recursive: true, force: true });
});

test('同 id 重复安装被拒绝：conflict + existing，磁盘上只有一个目录', () => {
  skillDraft('first', 'deai-flavor', 'export const v = 1;');
  const first = install('first');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.dir, 'deai-flavor');

  skillDraft('second', 'deai-flavor', 'export const v = 2;');
  const second = install('second');

  assert.equal(second.ok, false);
  assert.equal(second.conflict, true);
  assert.deepEqual(
    { id: second.existing.id, dir: second.existing.dir },
    { id: 'deai-flavor', dir: 'deai-flavor' }
  );
  assert.match(second.error, /已安装/);
  assert.match(second.error, /升级扩展/);
  // 关键断言：没有 `_1`，原目录内容也没被覆盖
  assert.deepEqual(fs.readdirSync(path.join(appRoot, 'skills')), ['deai-flavor']);
  assert.equal(fs.readFileSync(path.join(appRoot, 'skills/deai-flavor/index.js'), 'utf8'), 'export const v = 1;');
});

test('冲突时确认票据不被消耗：处理好冲突后同一张票仍能落地', () => {
  skillDraft('a', 'dup-ticket');
  assert.equal(install('a').ok, true);
  skillDraft('b', 'dup-ticket');
  const ticket = providers['forge.confirm-ticket']({ draftId: 'b', human: true });
  assert.equal(ticket.ok, true);
  const blocked = providers['forge.install']({ draftId: 'b', approvalToken: ticket.approvalToken });
  assert.equal(blocked.conflict, true);
  // 移走已有目录（模拟用户卸载），再用同一张票重试
  fs.rmSync(path.join(appRoot, 'skills/dup-ticket'), { recursive: true, force: true });
  const retried = providers['forge.install']({ draftId: 'b', approvalToken: ticket.approvalToken });
  assert.equal(retried.ok, true, JSON.stringify(retried));
});

test('不同 id 正常安装，互不影响', () => {
  skillDraft('x', 'alpha');
  skillDraft('y', 'beta');
  assert.equal(install('x').ok, true);
  assert.equal(install('y').ok, true);
  assert.deepEqual(fs.readdirSync(path.join(appRoot, 'skills')).sort(), ['alpha', 'beta']);
});

test('插件（plugin.json）同样按 id 拒绝重复', () => {
  draft('p1', {
    'plugin.json': JSON.stringify({ id: 'echo-plugin', name: 'echo', apiVersion: 1, entry: 'index.js' }),
    'index.js': 'export const providers = {};'
  });
  assert.equal(install('p1').ok, true);
  draft('p2', {
    'plugin.json': JSON.stringify({ id: 'echo-plugin', name: 'echo', apiVersion: 1, entry: 'index.js' }),
    'index.js': 'export const providers = {};'
  });
  const again = install('p2');
  assert.equal(again.conflict, true);
  assert.deepEqual(fs.readdirSync(path.join(appRoot, 'plugins')), ['echo-plugin']);
});

test('同 digest 的未安装草稿能被识别（去重判据）', () => {
  skillDraft('d1', 'meme', 'export const same = true;');
  skillDraft('d2', 'meme', 'export const same = true;');
  const dup = providers['forge.find-duplicate']({ draftId: 'd2' });
  assert.equal(dup.ok, true);
  // 字典序最小的那份胜出：两个并发请求因此收敛到同一个答案
  assert.equal(dup.duplicateOf.draftId, 'd1');
  assert.equal(dup.duplicateOf.digest.length, 64);
  // 胜出者自己再查时不再有"另一个我"
  assert.equal(providers['forge.find-duplicate']({ draftId: 'd1' }).duplicateOf, null);
});

test('内容不同的草稿不算重复', () => {
  skillDraft('u1', 'meme', 'export const version = 1;');
  skillDraft('u2', 'meme', 'export const version = 2;');
  assert.equal(providers['forge.find-duplicate']({ draftId: 'u2' }).duplicateOf, null);
});

test('已安装过的草稿不参与去重（那是落地后留下的暂存副本）', () => {
  skillDraft('i1', 'once');
  assert.equal(install('i1').ok, true);
  skillDraft('i2', 'once', 'export function setup(api) {}');
  // i1 已装 → 标记 installedAt；i2 是同内容的新副本，但它自己也是唯一一份未安装的
  const dup = providers['forge.find-duplicate']({ draftId: 'i2' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicateOf, null, JSON.stringify(dup));
});

test('孤儿扫描：注册表里没有的目录被报出，且不被自动删除', () => {
  // 手工造一个磁盘上有、注册表里没有的目录（旧版本撞名留下的典型现场）
  const orphan = path.join(appRoot, 'skills', 'deai-flavor_1');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'skill.json'), JSON.stringify({ id: 'deai-flavor', name: 'x', apiVersion: 1, entry: 'index.js' }));
  fs.writeFileSync(path.join(orphan, 'index.js'), 'export function setup() {}');
  // 注册表里只有 skills/deai-flavor
  const registry = {
    list: () => [{ manifest: { id: 'deai-flavor' }, relDir: 'skills/deai-flavor' }]
  };
  // 让 skills/deai-flavor 也真实存在，模拟"注册表采用的是另一个目录"
  const adopted = path.join(appRoot, 'skills', 'deai-flavor');
  fs.mkdirSync(adopted, { recursive: true });
  fs.writeFileSync(path.join(adopted, 'skill.json'), JSON.stringify({ id: 'deai-flavor', name: 'x', apiVersion: 1, entry: 'index.js' }));

  const orphans = scanOrphans({ appRoot, registry });
  assert.deepEqual(orphans, [{
    dir: 'deai-flavor_1',
    relDir: 'skills/deai-flavor_1',
    manifestId: 'deai-flavor',
    reason: 'shadowed'
  }]);
  // 只报告，不删除
  assert.equal(fs.existsSync(orphan), true);

  // 能力层：真正的注册表里跑着 skills/deai-flavor，_1 因此是确定的孤儿 → warn
  skillManager.register({
    manifest: { id: 'deai-flavor', name: 'x', apiVersion: 1 },
    relDir: 'skills/deai-flavor', kind: 'skill', toolIds: [], providers: {}, hooks: {}
  });
  try {
    const warnLines = [];
    setup({
      config: () => ({}),
      log: () => {},
      warn: (m) => warnLines.push(String(m)),
      appRoot
    });
    providers['forge.orphans']({});
    assert.equal(warnLines.filter((l) => /⚠️ 发现未纳管的扩展目录：skills\/deai-flavor_1/.test(l)).length, 1, warnLines.join('\n'));
    // 同一批孤儿重复体检不再刷日志（扩展页每刷一次列表就会调一次）
    providers['forge.orphans']({});
    assert.equal(warnLines.filter((l) => /deai-flavor_1/.test(l)).length, 1, warnLines.join('\n'));
  } finally {
    skillManager.unregister('deai-flavor');
  }
  // 现场清掉后，孤儿消失
  fs.rmSync(orphan, { recursive: true, force: true });
  assert.equal(providers['forge.orphans']({}).orphans.some((o) => o.relDir === 'skills/deai-flavor_1'), false);
});

test('完全没人认领的目录也被报出（reason=unmanaged）', () => {
  const dir = path.join(appRoot, 'plugins', 'nobody-here');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'nobody-here', name: 'x', apiVersion: 1, entry: 'index.js' }));
  const orphans = scanOrphans({ appRoot, registry: { list: () => [] } });
  assert.deepEqual(orphans.map((o) => [o.relDir, o.reason]), [['plugins/nobody-here', 'unmanaged']]);
});

test('注册表采用的目录不会被误报成孤儿', () => {
  const dir = path.join(appRoot, 'skills', 'fine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: 'fine', name: 'x', apiVersion: 1, entry: 'index.js' }));
  assert.deepEqual(scanOrphans({ appRoot, registry: { list: () => [{ manifest: { id: 'fine' }, relDir: 'skills/fine' }] } }), []);
});
