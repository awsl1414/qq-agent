// 内置模块 id 保护（P1-2）：第三方包不能与 kind='core' 的内置模块同 id。
//
// 根因：内置模块（self-doctor / self-fix / extension-forge / dev-orders / wallpaper）
// 是 kind='core'、relDir 形如 src/harness/forge，**不在** skills/ 与 plugins/ 里，
// 也不在 builtin-modules.json 基线里。只按那两个目录做「同 id 拒绝安装」时，
// 这一类完全查不到 —— 第三方包装进去后，loadPlugins 把它注册进 SkillManager，
// manager.register() 的 capabilities.removeOwner(id) 把内置模块的 providers 整体
// 清空（实测 forge.install 提供者 1 → 0），而扩展页上看不到任何异常条目。
//
// 三段修复各一条测试：
//   ① 安装侧 findIdConflict 把内置模块算进真源（forge.install 拒绝落地）；
//   ② 装载侧 loadSkillDir 拒绝手工拷进 skills/ 的同 id 目录（双保险）；
//   ③ 注册侧 SkillManager.register 拒绝非 core 条目占用内置 id（最后一道）。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-id-guard-'));
process.env.QQ_AGENT_DATA_DIR = path.join(temp, 'data');
const { setup, providers } = await import('../src/harness/forge/index.js');
const { skillManager } = await import('../src/skills/manager.js');
const { loadPlugins } = await import('../src/plugin-loader.js');
const { findModuleIdConflict, knownModules } = await import('../src/module-id.js');
const { CORE_MODULES, isCoreModuleId } = await import('../src/core-modules.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const appRoot = path.join(temp, 'app');
const staging = path.join(process.env.QQ_AGENT_DATA_DIR, 'plugin-data', 'extension-forge', 'staging');

function boot() {
  setup({ config: () => ({}), log() {}, appRoot });
  fs.mkdirSync(staging, { recursive: true });
}

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

function skillDraft(id, manifestId) {
  return draft(id, {
    'skill.json': JSON.stringify({ id: manifestId, name: manifestId, apiVersion: 1, entry: 'index.js' }),
    'index.js': 'export function setup(api) {}'
  });
}

function install(draftId) {
  const ticket = providers['forge.confirm-ticket']({ draftId, human: true });
  assert.equal(ticket.ok, true, JSON.stringify(ticket));
  return providers['forge.install']({ draftId, approvalToken: ticket.approvalToken });
}

/**
 * 取锻造台自己的环境快照。
 * 通过 forge.env（能力层）而不是直接 import 模块内部：测的就是闸门真正拿到的数据。
 */
function envSnapshotOf() {
  const env = providers['forge.env']({});
  return { existingIds: new Set(env.existingIds) };
}

/** 日志桩：收 warn 行，供断言"拒绝原因明确"。 */
function recorder() {
  const lines = [];
  return { lines, log: { info() {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)), debug() {} } };
}

beforeEach(() => {
  boot();
  fs.rmSync(path.join(appRoot, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(appRoot, 'plugins'), { recursive: true, force: true });
  // 每个用例都从一个"没有 core 注册"的进程状态出发，避免用例间互相影响
  skillManager.registry.clear();
});

test('内置模块名单与 harness 注册表一致（五个 core 模块都在）', () => {
  assert.deepEqual(Object.keys(CORE_MODULES).sort(), ['dev-orders', 'extension-forge', 'self-doctor', 'self-fix', 'wallpaper']);
  assert.equal(CORE_MODULES['extension-forge'], 'src/harness/forge');
  assert.equal(isCoreModuleId('extension-forge'), true);
  assert.equal(isCoreModuleId('not-a-core'), false);
});

test('id=extension-forge 的草稿：安装被拒（conflict），磁盘上没有落下任何东西', () => {
  skillDraft('forge-shadow', 'extension-forge');
  const result = install('forge-shadow');

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.conflict, true);
  assert.equal(result.existing.id, 'extension-forge');
  assert.equal(result.existing.kind, 'core');
  assert.equal(result.existing.relDir, 'src/harness/forge');
  // 内置模块不可卸载：报错必须指向"改 id"，不能让人去扩展页找卸载按钮
  assert.match(result.error, /属于内置模块/);
  assert.match(result.error, /修改草稿清单里的 id/);
  assert.doesNotMatch(result.error, /先卸载再装/);
  // 关键：skills/ 下没有被建出一个同 id 目录（修复前这里是 ['extension-forge']）
  assert.equal(fs.existsSync(path.join(appRoot, 'skills')), false);
});

test('不同 id 的安装不受影响', () => {
  skillDraft('normal', 'my-own-skill');
  const result = install('normal');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(fs.readdirSync(path.join(appRoot, 'skills')), ['my-own-skill']);
});

test('闸门的 existingIds 能看见内置模块（适配提示里的 id-conflict 对 core 生效）', () => {
  const known = knownModules({ appRoot, registry: skillManager });
  for (const id of Object.keys(CORE_MODULES)) {
    assert.equal(known.has(id), true, id);
    assert.equal(known.get(id).kind, 'core');
  }
  // 占用者信息够闸门区分"内置模块不可占用 / 已装扩展先卸载"
  assert.equal(known.get('extension-forge').relDir, 'src/harness/forge');
});

test('闸门对内置模块 id 的提示指向「改 id」，不指向「先卸载」', () => {
  const snap = envSnapshotOf();
  assert.equal(snap.existingIds.has('extension-forge'), true);
  // 用真实闸门跑一份同 id 的草稿：id-conflict 提示必须是 core 口径
  skillDraft('gate-core', 'extension-forge');
  const gate = providers['forge.gate']({ draftId: 'gate-core' });
  const issue = gate.issues.find((i) => i.code === 'id-conflict');
  assert.ok(issue, JSON.stringify(gate.issues));
  assert.match(issue.why, /内置模块/);
  assert.match(issue.why, /改成别的名字/);
  assert.doesNotMatch(issue.why, /卸载/);
});

test('手工把第三方目录放进 skills/extension-forge：加载被拒，日志说明原因，core 能力不被顶掉', async () => {
  // 先在注册表里放一个"正在跑的 core"，模拟启动后的真实状态
  const removed = [];
  skillManager.register({
    manifest: { id: 'extension-forge', name: '扩展锻造台', version: '1.0.0', apiVersion: 1, capabilities: [] },
    kind: 'core', source: 'core', relDir: 'src/harness/forge',
    providers: { 'forge.install': () => ({ ok: true }) }, hooks: {}, toolIds: []
  });
  assert.equal(skillManager.hasCapability('forge.install'), true);

  // 手工拷贝一份同 id 的第三方目录
  const dir = path.join(appRoot, 'skills', 'extension-forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: 'extension-forge', name: 'shadow', apiVersion: 1, entry: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const providers = {};');

  const rec = recorder();
  const res = await loadPlugins({ log: rec.log, roots: { skills: path.join(appRoot, 'skills'), plugins: path.join(appRoot, 'plugins') } });
  removed.push(res);

  // 加载失败，原因明确可读（点名内置模块与源码目录）
  const failed = res.failed.find((f) => f.id === 'extension-forge');
  assert.ok(failed, JSON.stringify(res.failed));
  assert.match(failed.error, /内置模块/);
  assert.match(failed.error, /src\/harness\/forge/);
  assert.equal(rec.lines.some((l) => /内置模块/.test(l) && /src\/harness\/forge/.test(l)), true, rec.lines.join('\n'));

  // 关键：注册表里仍是 core，能力没有消失
  const entry = skillManager.registry.get('extension-forge');
  assert.equal(entry.kind, 'core', '第三方条目不能顶掉 core');
  assert.equal(skillManager.hasCapability('forge.install'), true);
  // 目录还在（拒绝加载不是删除，处置权留给人）
  assert.equal(fs.existsSync(dir), true);
  skillManager.unregister('extension-forge');
});

test('注册侧兜底：非 core 条目注册内置 id 被拒，core 条目正常', () => {
  const coreSkill = {
    manifest: { id: 'self-fix', name: '自动修复', apiVersion: 1 },
    kind: 'core', providers: { 'fix.apply': () => ({}) }, hooks: {}, toolIds: []
  };
  assert.equal(skillManager.register(coreSkill).ok, true);
  assert.equal(skillManager.hasCapability('fix.apply'), true);

  const shadow = {
    manifest: { id: 'self-fix', name: 'shadow', apiVersion: 1 },
    kind: 'skill', providers: {}, hooks: {}, toolIds: []
  };
  const r = skillManager.register(shadow);
  assert.equal(r.ok, false);
  assert.match(r.error, /内置模块/);
  // 能力仍在
  assert.equal(skillManager.hasCapability('fix.apply'), true);
  assert.equal(skillManager.registry.get('self-fix').kind, 'core');
  skillManager.unregister('self-fix');
});

test('findModuleIdConflict 的优先级：core 名单 > 注册表 > 磁盘目录', () => {
  // ① core 名单：与磁盘无关
  assert.deepEqual(
    findModuleIdConflict('dev-orders', { appRoot }),
    { id: 'dev-orders', kind: 'core', version: '', dir: 'src/harness/dev', relDir: 'src/harness/dev' }
  );
  // ② 注册表：kind/relDir 来自在跑的条目
  skillManager.register({
    manifest: { id: 'in-registry', name: 'x', version: '2.0.0', apiVersion: 1 },
    kind: 'skill', relDir: 'custom/root/in-registry', providers: {}, hooks: {}, toolIds: []
  });
  const fromRegistry = findModuleIdConflict('in-registry', { appRoot, registry: skillManager });
  assert.equal(fromRegistry.kind, 'skill');
  assert.equal(fromRegistry.relDir, 'custom/root/in-registry');
  assert.equal(fromRegistry.version, '2.0.0');
  // ③ 磁盘目录：没有注册表时报磁盘位置
  const dir = path.join(appRoot, 'plugins', 'disk-only');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'disk-only', version: '1.2.3', entry: 'index.js' }));
  const fromDisk = findModuleIdConflict('disk-only', { appRoot });
  assert.equal(fromDisk.kind, 'plugin');
  assert.equal(fromDisk.relDir, 'plugins/disk-only');
  assert.equal(fromDisk.version, '1.2.3');
  // 空闲 id
  assert.equal(findModuleIdConflict('nobody', { appRoot }), null);
  skillManager.unregister('in-registry');
});
