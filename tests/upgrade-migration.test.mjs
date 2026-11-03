// 版本迁移（src/upgrade.js）的单测。这条链路做的是"在用户机器上搬文件、删文件"，
// 出错代价最高：删错一个目录、或把已执行的迁移重跑一遍，用户的数据就没了。
//
// 钉住五件事：
//   ① 路径安全：越界 / 根目录 / 符号链接 / 允许根本身 全部拒绝
//   ② 幂等：已执行的项永不重跑；老格式状态文件（字符串时间戳）也认得
//   ③ 状态格式演进：新格式能读出 movedTo，老格式照样跳过
//   ④ 失败不阻塞：抛错项不进 applied、其余项照跑
//   ⑤ 搬移语义：原位置消失、新位置存在、内容一致、目标已存在不覆盖
//
// retire-bundled-ffmpeg 现在的落点是**正式位置**（data/runtime/ffmpeg/bin/），
// 不是备份区。它的三种落点各自成组：目标已有 ffmpeg / 目标为空 / 目标不存在。
//
// 全部在 fs.mkdtempSync 建的临时目录里跑，**绝不碰真实 data/**。
// runUpgrades 接受 appRoot 与 dataDir 注入，这里靠它们把两侧都指到临时目录。
//
// 运行：node --test tests/upgrade-migration.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  UPGRADES,
  runUpgrades,
  readUpgradeState,
  upgradeStatePath,
  assertSafePath,
  allowedRoots,
  movePath,
  renamePath,
  removePath,
  runtimeDirPath,
  normalizeAppliedEntry
} from '../src/upgrade.js';
import { managedBinDir, exeName } from '../src/ffmpeg-resolve.js';

/** 每次调用建一个全新的隔离现场：appRoot 与 dataDir 是同级两个目录。 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-upgrade-'));
  const appRoot = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(appRoot, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(appRoot, 'runtime'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // 内置基线：让 prune-orphan-trusted 有东西可读（空列表也合法）
  fs.writeFileSync(path.join(appRoot, 'builtin-modules.json'), JSON.stringify({ modules: [] }), 'utf8');
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'qq-agent', version: '9.9.9.9' }), 'utf8');
  return { root, appRoot, dataDir };
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录，删不掉无所谓 */ }
}
void cleanup;   // 沙箱留在系统 tmp 里由系统回收；显式清理只在排障时用

/** 只跑指定的迁移项（其余项在测试沙箱里多半会因为缺前置而失败，干扰断言）。 */
function runOnly(ids, opts) {
  return runUpgrades({ ...opts, upgrades: UPGRADES.filter((u) => ids.includes(u.id)) });
}

const silent = () => {};
const ffmpegExe = exeName('ffmpeg');
const ffprobeExe = exeName('ffprobe');

/** 正式位置的路径（与迁移项共用同一个函数，避免两边各写一份路径）。 */
function managedDir(dataDir) {
  return managedBinDir(dataDir);
}

// ── ① 路径安全 ──────────────────────────────────────────────────────────

test('路径安全：相对路径、空路径被拒绝', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  assert.throws(() => assertSafePath('', roots), /路径为空/);
  assert.throws(() => assertSafePath('   ', roots), /路径为空/);
  assert.throws(() => assertSafePath('relative/path', roots), /绝对路径/);
  assert.throws(() => assertSafePath('./x', roots), /绝对路径/);
});

test('路径安全：文件系统根被拒绝', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const fsRoot = path.parse(path.resolve('/')).root;
  assert.throws(() => assertSafePath(fsRoot, roots), /文件系统根/);
});

test('路径安全：越界路径（.. 逃逸、允许根之外）被拒绝', () => {
  const { root, appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  // 同级但不在允许根下
  assert.throws(() => assertSafePath(path.join(root, 'elsewhere'), roots), /不在允许范围内/);
  // 用 .. 从 dataDir 逃到 appRoot
  assert.throws(() => assertSafePath(path.join(dataDir, '..', 'app', 'src'), roots), /不在允许范围内/);
  // 程序根本身不在允许列表里（只允许 appRoot/runtime）
  assert.throws(() => assertSafePath(appRoot, roots), /不在允许范围内/);
});

test('路径安全：允许根本身被拒绝（删它等于删掉全部数据）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  assert.throws(() => assertSafePath(dataDir, roots), /不在允许范围内/);
  assert.throws(() => assertSafePath(path.join(appRoot, 'runtime'), roots), /不在允许范围内/);
});

test('路径安全：符号链接被拒绝（不跟链接删外部文件）', { skip: process.platform === 'win32' && 'Windows 上创建符号链接需要额外权限' }, () => {
  const { root, appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep me', 'utf8');
  const link = path.join(dataDir, 'link-to-outside');
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => assertSafePath(link, roots), /符号链接/);
  // 链接指向的那个真实目录也必须拦（父链真实路径复查）
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep me');
});

test('路径安全：允许根内部套一层指向外部的链接目录也要拦', { skip: process.platform === 'win32' && 'Windows 上创建符号链接需要额外权限' }, () => {
  const { root, appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const outside = path.join(root, 'outside2');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x', 'utf8');
  // data/escape/ 是指向外部的链接，目标本身是普通文件，lstat(abs) 看到的是普通文件
  fs.symlinkSync(outside, path.join(dataDir, 'escape'), 'dir');
  const sneaky = path.join(dataDir, 'escape', 'secret.txt');
  assert.throws(() => assertSafePath(sneaky, roots), /真实父目录不在允许范围内/);
});

// ── ② 幂等 / ③ 状态格式 ──────────────────────────────────────────────────

test('状态格式：老格式（字符串时间戳）能读出并跳过', () => {
  const { appRoot, dataDir } = sandbox();
  const stateFile = upgradeStatePath(dataDir);
  fs.writeFileSync(stateFile, JSON.stringify({
    version: '0.5.1.1',
    applied: {
      'retire-conversation-memory': '2026-10-01T00:00:00.000Z',
      'prune-orphan-trusted': '2026-10-02T00:00:00.000Z'
    },
    updatedAt: '2026-10-02T00:00:00.000Z'
  }), 'utf8');

  const st = readUpgradeState(stateFile);
  assert.equal(st.applied['retire-conversation-memory'].at, '2026-10-01T00:00:00.000Z');
  assert.equal(st.applied['prune-orphan-trusted'].at, '2026-10-02T00:00:00.000Z');

  // 预置的两项必须被认成"已执行"并跳过（其余项照常跑，不影响本断言）
  const r = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 1, saveConfig: () => {} });
  assert.ok(r.skipped.includes('retire-conversation-memory'));
  assert.ok(r.skipped.includes('prune-orphan-trusted'));
  assert.ok(!r.ran.some((x) => x.id === 'retire-conversation-memory'));
  assert.ok(!r.ran.some((x) => x.id === 'prune-orphan-trusted'));
});

test('状态格式：新格式能读出 movedTo，且不会被重跑', () => {
  const { appRoot, dataDir } = sandbox();
  const stateFile = upgradeStatePath(dataDir);
  fs.writeFileSync(stateFile, JSON.stringify({
    version: '0.5.1.3',
    applied: {
      'retire-bundled-ffmpeg': { at: '2026-11-03T01:02:03.000Z', movedTo: 'runtime/ffmpeg/bin' }
    },
    updatedAt: '2026-11-03T01:02:03.000Z'
  }), 'utf8');

  const st = readUpgradeState(stateFile);
  assert.equal(st.applied['retire-bundled-ffmpeg'].movedTo, 'runtime/ffmpeg/bin');
  assert.equal(st.applied['retire-bundled-ffmpeg'].at, '2026-11-03T01:02:03.000Z');

  const r = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 2, saveConfig: () => {} });
  assert.ok(r.skipped.includes('retire-bundled-ffmpeg'));
  assert.ok(!r.ran.some((x) => x.id === 'retire-bundled-ffmpeg'));
});

test('normalizeAppliedEntry：认三种形态，认不出的当作没跑过', () => {
  assert.deepEqual(normalizeAppliedEntry('2026-01-01T00:00:00.000Z'), { at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(normalizeAppliedEntry({ at: 'x', movedTo: 'y' }), { at: 'x', movedTo: 'y' });
  assert.deepEqual(normalizeAppliedEntry({ movedTo: 'y' }), { movedTo: 'y', at: '' });
  assert.equal(normalizeAppliedEntry(42), null);
  // null 形态在 readUpgradeState 里被丢掉 → 该项视为没跑过（宁可重跑一次）
  const st = readUpgradeState(writeTmpState({ applied: { a: 42, b: 'ts' } }));
  assert.equal(st.applied.a, undefined);
  assert.equal(st.applied.b.at, 'ts');
});

function writeTmpState(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-state-'));
  const f = path.join(dir, 'upgrade-state.json');
  fs.writeFileSync(f, JSON.stringify(payload), 'utf8');
  return f;
}

test('幂等：同一个迁移项跑两次，第二次不重复执行', () => {
  const { appRoot, dataDir } = sandbox();
  // 造一个旧随包 ffmpeg，让 retire-bundled-ffmpeg 真的有事可做
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'FAKE-OLD-FFMPEG', 'utf8');

  const first = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 1000, saveConfig: () => {} });
  const ff = first.ran.find((x) => x.id === 'retire-bundled-ffmpeg');
  assert.ok(ff, '第一次应执行 ffmpeg 迁移');
  assert.equal(fs.existsSync(oldExe), false, '旧位置应已被搬走');

  // 搬到了正式位置，内容不变
  const movedFile = path.join(managedDir(dataDir), ffmpegExe);
  assert.equal(fs.readFileSync(movedFile, 'utf8'), 'FAKE-OLD-FFMPEG');

  // 状态里记下了搬到哪里（相对数据目录，便于日志展示）
  const st = readUpgradeState(upgradeStatePath(dataDir));
  assert.equal(st.applied['retire-bundled-ffmpeg'].movedTo, 'runtime/ffmpeg/bin');

  // 第二次：全部跳过，正式位置不会多出一份
  const second = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 2000, saveConfig: () => {} });
  assert.ok(second.skipped.includes('retire-bundled-ffmpeg'));
  assert.equal(fs.readdirSync(managedDir(dataDir)).length, 1, '第二次不应产生新文件');
});

// ── ④ 失败不阻塞 ────────────────────────────────────────────────────────

test('失败不阻塞：抛错的项不进 applied，其余项照常执行', () => {
  const { appRoot, dataDir } = sandbox();
  const boom = {
    id: 'test-boom',
    title: '故意失败',
    run() { throw new Error('炸了'); }
  };
  const ok = {
    id: 'test-ok',
    title: '应当执行',
    run() { return { changed: ['x'] }; }
  };
  const r = runUpgrades({
    appRoot, dataDir, version: '1.0.0', log: silent, now: 3000, saveConfig: () => {},
    upgrades: [...UPGRADES, boom, ok]
  });
  assert.deepEqual(r.failed.map((x) => x.id), ['test-boom']);
  assert.ok(r.ran.some((x) => x.id === 'test-ok'), '后续项不应被前面的失败挡住');

  const st = readUpgradeState(upgradeStatePath(dataDir));
  assert.equal(st.applied['test-boom'], undefined, '失败项不能记入 applied（否则永不重试）');
  assert.ok(st.applied['test-ok'], '成功项要记入');
});

// ── ⑤ 搬移语义 ──────────────────────────────────────────────────────────

test('movePath：文件搬走后原位置不存在、新位置存在、内容一致', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(dataDir, 'a.txt');
  const dest = path.join(dataDir, 'sub', 'b.txt');
  fs.writeFileSync(src, 'hello', 'utf8');

  const r = movePath(src, dest, { roots });
  assert.equal(r.to, dest);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello');
});

test('movePath：目录搬移（含嵌套内容）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(dataDir, 'dir');
  fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'bin', 'ffmpeg'), 'FF', 'utf8');
  const dest = path.join(dataDir, 'moved', 'dir');

  movePath(src, dest, { roots });
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(path.join(dest, 'bin', 'ffmpeg'), 'utf8'), 'FF');
});

test('movePath：目标已存在时不覆盖（默认抛错，原文件保留）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(dataDir, 'src.txt');
  const dest = path.join(dataDir, 'dest.txt');
  fs.writeFileSync(src, 'NEW', 'utf8');
  fs.writeFileSync(dest, 'OLD', 'utf8');

  assert.throws(() => movePath(src, dest, { roots }), /目标已存在/);
  assert.equal(fs.readFileSync(src, 'utf8'), 'NEW', '失败时源文件必须还在');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'OLD', '目标不能被覆盖');
});

test('movePath：拒绝把目录搬进它自己里面', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(dataDir, 'd');
  fs.mkdirSync(src, { recursive: true });
  assert.throws(() => movePath(src, path.join(src, 'inner'), { roots }), /搬进它自己/);
});

test('removePath：不存在视为已达成（幂等）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const r = removePath(path.join(dataDir, 'nope.txt'), { roots });
  assert.equal(r.removed, false);
});

// ── retire-bundled-ffmpeg：三种落点 ────────────────────────────────────

test('retire-bundled-ffmpeg：没有旧文件时不做事', () => {
  const { appRoot, dataDir } = sandbox();
  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 10, saveConfig: () => {} });
  assert.equal(r.ran.length, 1);
  assert.deepEqual(r.ran[0].changed, []);
  assert.match(r.ran[0].note, /没有旧随包 ffmpeg/);
  assert.equal(fs.existsSync(managedDir(dataDir)), false, '什么都不该搬时不该建出空目录');
});

test('落点①目标已有 ffmpeg：单文件形态 → 旧的被删除，目标不变', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'NEW', 'utf8');
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'OLD', 'utf8');

  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 11, saveConfig: () => {} });
  assert.equal(fs.existsSync(oldExe), false, '旧的那份应被删除');
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'NEW', '目标不能被覆盖');
  assert.equal(r.ran.length, 1);
  assert.equal(r.ran[0].changed.length, 1);
  // 没有搬移 → 不记 movedTo（它不是"搬到哪儿"的动作）
  assert.equal(readUpgradeState(upgradeStatePath(dataDir)).applied['retire-bundled-ffmpeg'].movedTo, undefined);
});

test('落点①目标已有 ffmpeg：目录形态 → 整目录内容被删、目标不变', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'NEW', 'utf8');
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', ffmpegExe), 'OLD-FF', 'utf8');
  fs.writeFileSync(path.join(dir, 'bin', ffprobeExe), 'OLD-FP', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 12, saveConfig: () => {} });
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'NEW', '目标不能被覆盖');
  // 旧包里带着 ffprobe、目标没有 → 它必须跟着走，不能删
  assert.equal(fs.readFileSync(path.join(managed, ffprobeExe), 'utf8'), 'OLD-FP', 'ffprobe 应搬到正式位置');
  assert.equal(fs.existsSync(dir), false, '搬空的旧目录应被清掉');
});

test('落点②目标为空目录（空壳）：旧的搬进去，成为正式那份', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });                 // 上次搬了一半留下的壳
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'OLD', 'utf8');

  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 13, saveConfig: () => {} });
  assert.equal(fs.existsSync(oldExe), false);
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'OLD');
  assert.equal(r.ran[0].changed.length, 1);
  assert.equal(readUpgradeState(upgradeStatePath(dataDir)).applied['retire-bundled-ffmpeg'].movedTo, 'runtime/ffmpeg/bin');
});

test('落点③目标不存在：单文件形态 → 搬到 managedBinDir()/<exe>', () => {
  const { appRoot, dataDir } = sandbox();
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'OLD', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 14, saveConfig: () => {} });
  assert.equal(fs.existsSync(oldExe), false);
  assert.equal(fs.readFileSync(path.join(managedDir(dataDir), ffmpegExe), 'utf8'), 'OLD');
});

test('落点③目标不存在：目录形态 bin/ 下的 ffmpeg + ffprobe 一起搬', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', ffmpegExe), 'FF', 'utf8');
  fs.writeFileSync(path.join(dir, 'bin', ffprobeExe), 'FP', 'utf8');
  fs.writeFileSync(path.join(dir, 'LICENSE.txt'), 'license', 'utf8');

  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 15, saveConfig: () => {} });
  const managed = managedDir(dataDir);
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'FF');
  assert.equal(fs.readFileSync(path.join(managed, ffprobeExe), 'utf8'), 'FP', 'ffprobe 必须跟着走');
  assert.equal(fs.existsSync(path.join(managed, 'LICENSE.txt')), false, '非可执行文件不搬进 bin/');
  assert.equal(r.ran[0].changed.length, 2);
  // 旧目录里还剩 LICENSE → 不能删非空目录
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8'), 'license');
});

test('落点③目录形态：可执行文件直接在根上（历史形态 ③）', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ffmpegExe), 'FF', 'utf8');
  fs.writeFileSync(path.join(dir, ffprobeExe), 'FP', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 16, saveConfig: () => {} });
  const managed = managedDir(dataDir);
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'FF');
  assert.equal(fs.readFileSync(path.join(managed, ffprobeExe), 'utf8'), 'FP');
  assert.equal(fs.existsSync(dir), false, '全部搬空后旧目录应被清掉');
});

test('单文件形态没有 ffprobe：如实记录日志，不假装搬了', () => {
  const { appRoot, dataDir } = sandbox();
  fs.writeFileSync(path.join(appRoot, 'runtime', ffmpegExe), 'OLD', 'utf8');
  const logs = [];
  const r = runOnly(['retire-bundled-ffmpeg'], {
    appRoot, dataDir, version: '9.9.9.9', now: 17, saveConfig: () => {},
    log: (m) => logs.push(m)
  });
  assert.match(r.ran[0].note, /没有 ffprobe/);
  assert.equal(fs.existsSync(path.join(managedDir(dataDir), ffprobeExe)), false);
  assert.ok(logs.some((m) => /没有 ffprobe/.test(m)), '日志里要能查到这件事');
});

test('重试补齐：ffmpeg 已在正式位置、旧目录只剩 ffprobe → 只搬 ffprobe 并清掉旧目录', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'FF', 'utf8');
  // 模拟上一轮：ffmpeg 搬走了、ffprobe 那一步失败留在原地
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', ffprobeExe), 'FP', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 18, saveConfig: () => {} });
  assert.equal(fs.readFileSync(path.join(managed, ffprobeExe), 'utf8'), 'FP', '缺的 ffprobe 要补上');
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'FF');
  assert.equal(fs.existsSync(dir), false);
});

test('retire-bundled-ffmpeg：不动 runtime/qq-portable（便携 QQ 是用户数据）', () => {
  const { appRoot, dataDir } = sandbox();
  const portable = path.join(appRoot, 'runtime', 'qq-portable');
  fs.mkdirSync(portable, { recursive: true });
  fs.writeFileSync(path.join(portable, 'QQ.exe'), 'QQ', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 19, saveConfig: () => {} });
  assert.equal(fs.existsSync(portable), true);
  assert.equal(fs.readFileSync(path.join(portable, 'QQ.exe'), 'utf8'), 'QQ');
});

test('retire-bundled-ffmpeg：同名但里面没有 ffmpeg 的目录不搬', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ffmpeg', 'utf8');
  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 20, saveConfig: () => {} });
  assert.equal(fs.existsSync(dir), true, '目录里没有 ffmpeg，不该动它');
});

// 回归：同一个目标文件名有两个来源（旧包根与 bin/ 下都有 ffprobe）。
// 旧实现按目录逐个搬，第二个来源会把第一个**刚搬过去的**文件当成"目标已存在"
// 清掉再覆盖 —— 第一份静默丢失，changed 里却记了两次、日志两次都说"已搬移"。
test('retire-bundled-ffmpeg：同名文件两处来源时只搬一个，不覆盖也不丢', () => {
  const { appRoot, dataDir } = sandbox();
  const pkg = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, ffprobeExe), 'FROM-ROOT', 'utf8');
  fs.writeFileSync(path.join(pkg, 'bin', ffprobeExe), 'FROM-BIN', 'utf8');

  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'NEW', 'utf8');

  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 21, saveConfig: () => {} });
  assert.equal(r.ran.length, 1);
  // 只搬一份：根目录那份优先
  assert.equal(r.ran[0].changed.length, 1, `changed 不应记录被覆盖的重复项：${JSON.stringify(r.ran[0].changed)}`);
  assert.equal(fs.readFileSync(path.join(managed, ffprobeExe), 'utf8'), 'FROM-ROOT');
  // 未选中的第二份留在原位（不删非空目录），日志里要有交代
  assert.equal(fs.existsSync(path.join(pkg, 'bin', ffprobeExe)), true, '多余来源应留在原处，不该被静默删除');
  assert.match(r.ran[0].note, /同名文件/);
});

test('失败不记 applied：跨盘放弃后下次启动还能重试', () => {
  const { appRoot, dataDir } = sandbox();
  fs.writeFileSync(path.join(appRoot, 'runtime', ffmpegExe), 'OLD', 'utf8');

  // 真实环境里跨盘由 EXDEV 表达；这里直接让 rename 抛 EXDEV，钉住"放弃、不复制"。
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };
  let first;
  try {
    first = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 21, saveConfig: () => {} });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(first.failed.map((x) => x.id), ['retire-bundled-ffmpeg']);
  assert.equal(fs.existsSync(path.join(appRoot, 'runtime', ffmpegExe)), true, '放弃搬移时源必须原样保留');
  assert.equal(fs.existsSync(path.join(managedDir(dataDir), ffmpegExe)), false, '不能留下复制出来的副本');
  assert.equal(readUpgradeState(upgradeStatePath(dataDir)).applied['retire-bundled-ffmpeg'], undefined,
    '失败项不能记入 applied，否则永不重试');

  // 下一次启动照常搬
  const second = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 22, saveConfig: () => {} });
  assert.equal(second.failed.length, 0);
  assert.equal(fs.existsSync(path.join(managedDir(dataDir), ffmpegExe)), true);
});

test('部分失败也整项失败：已搬走的不重复，剩下的下次重试', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', ffmpegExe), 'FF', 'utf8');
  fs.writeFileSync(path.join(dir, 'bin', ffprobeExe), 'FP', 'utf8');

  // 让 ffprobe 那一次的 rename 失败（按目标名判断，不误伤 ffmpeg）
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith(ffprobeExe)) throw new Error('EBUSY: 文件被占用');
    return realRename(from, to);
  };
  try {
    const first = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 23, saveConfig: () => {} });
    assert.deepEqual(first.failed.map((x) => x.id), ['retire-bundled-ffmpeg']);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.existsSync(path.join(managedDir(dataDir), ffmpegExe)), true, '先搬的那个已经到位');
  assert.equal(fs.existsSync(path.join(dir, 'bin', ffprobeExe)), true, '失败的那个留在原地');

  const second = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 24, saveConfig: () => {} });
  assert.equal(second.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(managedDir(dataDir), ffprobeExe), 'utf8'), 'FP');
  assert.equal(fs.readFileSync(path.join(managedDir(dataDir), ffmpegExe), 'utf8'), 'FF', '重复执行不能把已到位的盖掉');
});

test('删除失败也整项失败：不记 applied，下次启动重试', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = managedDir(dataDir);
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'NEW', 'utf8');
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'OLD', 'utf8');

  // 模拟 Windows 上文件被占用：rm 抛 EBUSY
  const realRm = fs.rmSync;
  fs.rmSync = () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; };
  let first;
  try {
    first = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 25, saveConfig: () => {} });
  } finally {
    fs.rmSync = realRm;
  }
  assert.deepEqual(first.failed.map((x) => x.id), ['retire-bundled-ffmpeg']);
  assert.equal(fs.existsSync(oldExe), true, '删不掉时源必须还在');
  assert.equal(readUpgradeState(upgradeStatePath(dataDir)).applied['retire-bundled-ffmpeg'], undefined,
    '删除失败不能记 applied，否则这份残留永远留着');

  const second = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 26, saveConfig: () => {} });
  assert.equal(second.failed.length, 0);
  assert.equal(fs.existsSync(oldExe), false, '解锁后下次启动应删掉');
});

// ── 迁移项元信息 ────────────────────────────────────────────────────────

test('迁移项 label：注册表里每一项都有给用户看的 label，且互不相同', () => {
  assert.ok(UPGRADES.length > 0);
  const labels = UPGRADES.map((u) => u.label);
  for (const u of UPGRADES) {
    assert.equal(typeof u.label, 'string', `${u.id} 缺 label`);
    assert.ok(u.label.trim().length > 0, `${u.id} 的 label 为空`);
  }
  assert.equal(new Set(labels).size, labels.length, 'label 重复会让日志分不清是哪一项');
});

test('备份机制已移除：不再导出备份相关符号', async () => {
  const mod = await import('../src/upgrade.js');
  for (const gone of [
    'legacyBackupRoot', 'BACKUP_META_FILE', 'readBackupMeta', 'backupPath',
    'detectLegacyResidue', 'removeLegacyResidue'
  ]) {
    assert.equal(mod[gone], undefined, `${gone} 应已删除`);
  }
});

// ── renamePath：只走 rename，跨盘不复制 ──────────────────────────────────

test('renamePath：同盘目录搬移，内容原样', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(appRoot, 'runtime', 'thing');
  fs.mkdirSync(path.join(src, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(src, 'inner', 'f.txt'), 'payload', 'utf8');
  const dest = path.join(dataDir, 'runtime', 'thing');

  renamePath(src, dest, { roots });
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(path.join(dest, 'inner', 'f.txt'), 'utf8'), 'payload');
});

test('renamePath：目标已存在时不覆盖（源保持原位）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(appRoot, 'runtime', 'a');
  const dest = path.join(dataDir, 'runtime', 'a');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'new.txt'), 'NEW', 'utf8');
  fs.writeFileSync(path.join(dest, 'old.txt'), 'OLD', 'utf8');

  assert.throws(() => renamePath(src, dest, { roots }), /目标已存在/);
  assert.equal(fs.readFileSync(path.join(src, 'new.txt'), 'utf8'), 'NEW');
  assert.equal(fs.readFileSync(path.join(dest, 'old.txt'), 'utf8'), 'OLD');
});

test('renamePath：EXDEV 跨盘直接失败，绝不降级成复制（源与目标都不变）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const src = path.join(dataDir, 'big');
  const dest = path.join(dataDir, 'moved', 'big');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'payload'), 'X'.repeat(1024), 'utf8');

  // 直接制造 EXDEV：rename 在真实同盘环境里不会抛它，这里替换掉 fs.renameSync
  // 来钉住"跨盘不复制"这条契约（复制 1.5GB 是这条迁移不能做的事）。
  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EXDEV: cross-device link not permitted');
    err.code = 'EXDEV';
    throw err;
  };
  try {
    assert.throws(() => renamePath(src, dest, { roots }), /不在同一磁盘分区/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.existsSync(path.join(src, 'payload')), true, '跨盘放弃时源必须原样保留');
  assert.equal(fs.existsSync(dest), false, '不能留下复制出来的副本');
});

// ── relocate-portable-qq ────────────────────────────────────────────────

const portableNames = ['qq-portable', 'qq-portable-data'];

test('relocate-portable-qq：目录不存在时无事可做（mac/Linux 的正常路径）', () => {
  const { appRoot, dataDir } = sandbox();
  const r = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 30, saveConfig: () => {} });
  assert.equal(r.ran.length, 1);
  assert.deepEqual(r.ran[0].changed, []);
  assert.match(r.ran[0].note, /无需搬移/);
  // 数据目录下不应凭空建出 runtime/qq-portable 空壳
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'qq-portable')), false);
});

test('relocate-portable-qq：正常搬迁两个目录，源清空、内容一致', () => {
  const { appRoot, dataDir } = sandbox();
  for (const name of portableNames) {
    const src = path.join(appRoot, 'runtime', name);
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'marker.txt'), name, 'utf8');
  }

  const r = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 31, saveConfig: () => {} });
  assert.equal(r.ran.length, 1);
  assert.equal(r.ran[0].changed.length, 2);
  for (const name of portableNames) {
    assert.equal(fs.existsSync(path.join(appRoot, 'runtime', name)), false, `${name} 应已离开程序目录`);
    assert.equal(fs.readFileSync(path.join(dataDir, 'runtime', name, 'sub', 'marker.txt'), 'utf8'), name);
  }

  // 状态里记下了新的运行时根
  const st = readUpgradeState(upgradeStatePath(dataDir));
  assert.equal(st.applied['relocate-portable-qq'].movedTo, 'runtime');
});

test('relocate-portable-qq：目标已存在且非空时跳过，不合并两个目录', () => {
  const { appRoot, dataDir } = sandbox();
  const src = path.join(appRoot, 'runtime', 'qq-portable');
  const dest = path.join(dataDir, 'runtime', 'qq-portable');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'from-app.txt'), 'APP', 'utf8');
  fs.writeFileSync(path.join(dest, 'from-data.txt'), 'DATA', 'utf8');

  const r = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 32, saveConfig: () => {} });
  // 只有 qq-portable 被跳过（qq-portable-data 根本不存在 → 也算无需处理），整项成功
  assert.equal(r.ran.length, 1);
  assert.deepEqual(r.ran[0].changed, []);
  assert.equal(fs.readFileSync(path.join(src, 'from-app.txt'), 'utf8'), 'APP', '源必须原样保留');
  assert.equal(fs.readFileSync(path.join(dest, 'from-data.txt'), 'utf8'), 'DATA', '目标不能被覆盖');
  assert.equal(fs.existsSync(path.join(dest, 'from-app.txt')), false, '绝不能合并');
});

test('relocate-portable-qq：目标目录存在但为空 → 视为上次失败的壳，可以搬进去', () => {
  const { appRoot, dataDir } = sandbox();
  const src = path.join(appRoot, 'runtime', 'qq-portable');
  const dest = path.join(dataDir, 'runtime', 'qq-portable');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'QQ.exe'), 'QQ', 'utf8');

  const r = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 33, saveConfig: () => {} });
  assert.equal(r.ran[0].changed.length, 1);
  assert.equal(fs.readFileSync(path.join(dest, 'QQ.exe'), 'utf8'), 'QQ');
});

test('relocate-portable-qq：符号链接不搬', { skip: process.platform === 'win32' && 'Windows 上创建符号链接需要额外权限' }, () => {
  const { root, appRoot, dataDir } = sandbox();
  const outside = path.join(root, 'outside-qq');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'QQ.exe'), 'OUT', 'utf8');
  fs.symlinkSync(outside, path.join(appRoot, 'runtime', 'qq-portable'), 'dir');

  const r = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 34, saveConfig: () => {} });
  assert.equal(r.ran[0].changed.length, 0);
  assert.equal(fs.existsSync(path.join(outside, 'QQ.exe')), true, '链接指向的外部文件必须原样');
});

test('relocate-portable-qq：搬移失败时整项报错且不记 applied，下次启动重试', () => {
  const { appRoot, dataDir } = sandbox();
  fs.mkdirSync(path.join(appRoot, 'runtime', 'qq-portable'), { recursive: true });
  // 让数据目录下的 runtime 成为一个**文件**：目标父路径不可用，rename 必然失败。
  // 用这个代替"Windows 上文件被占用"，在 mac/Linux 上也能稳定复现失败路径。
  fs.writeFileSync(path.join(dataDir, 'runtime'), 'blocker', 'utf8');

  const first = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 35, saveConfig: () => {} });
  assert.deepEqual(first.failed.map((x) => x.id), ['relocate-portable-qq']);
  assert.equal(fs.existsSync(path.join(appRoot, 'runtime', 'qq-portable')), true, '失败时源目录必须原样保留');
  assert.equal(readUpgradeState(upgradeStatePath(dataDir)).applied['relocate-portable-qq'], undefined,
    '失败项不能记入 applied，否则永不重试');

  // 修好之后下一次启动应照常搬
  fs.rmSync(path.join(dataDir, 'runtime'), { force: true });
  const second = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 36, saveConfig: () => {} });
  assert.equal(second.failed.length, 0);
  assert.equal(second.ran.length, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'qq-portable')), true);
});

test('relocate-portable-qq：跑两次，第二次跳过（幂等）', () => {
  const { appRoot, dataDir } = sandbox();
  fs.mkdirSync(path.join(appRoot, 'runtime', 'qq-portable'), { recursive: true });
  const first = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 37, saveConfig: () => {} });
  assert.equal(first.ran.length, 1);
  const second = runOnly(['relocate-portable-qq'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 38, saveConfig: () => {} });
  assert.deepEqual(second.skipped, ['relocate-portable-qq']);
  assert.equal(second.ran.length, 0);
});

// ── 运行时目录解析优先级 ────────────────────────────────────────────────

test('runtimeDirPath：数据目录优先，其次回落程序目录，都没有时给规范位置', () => {
  const { appRoot, dataDir } = sandbox();
  const canonical = path.join(dataDir, 'runtime', 'qq-portable');
  const legacy = path.join(appRoot, 'runtime', 'qq-portable');

  // ① 两处都没有 → 返回规范位置（新建内容一律落数据目录）
  assert.equal(runtimeDirPath('qq-portable', { appRoot, dataDir }), canonical);

  // ② 只有程序目录有（迁移还没成功）→ 用它，保证便携 QQ 照常可用
  fs.mkdirSync(legacy, { recursive: true });
  assert.equal(runtimeDirPath('qq-portable', { appRoot, dataDir }), legacy);

  // ③ 数据目录也有了（迁移完成）→ 优先用数据目录
  fs.mkdirSync(canonical, { recursive: true });
  assert.equal(runtimeDirPath('qq-portable', { appRoot, dataDir }), canonical);

  // ④ 迁移后程序目录那份不在 → 仍是数据目录
  fs.rmSync(legacy, { recursive: true, force: true });
  assert.equal(runtimeDirPath('qq-portable', { appRoot, dataDir }), canonical);
});

test('runtimeDirPath：qq-portable-data 与 qq-portable 各自独立解析', () => {
  const { appRoot, dataDir } = sandbox();
  fs.mkdirSync(path.join(appRoot, 'runtime', 'qq-portable'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime', 'qq-portable-data'), { recursive: true });
  assert.equal(
    runtimeDirPath('qq-portable', { appRoot, dataDir }),
    path.join(appRoot, 'runtime', 'qq-portable')
  );
  assert.equal(
    runtimeDirPath('qq-portable-data', { appRoot, dataDir }),
    path.join(dataDir, 'runtime', 'qq-portable-data')
  );
});

// 临时目录清理：每个 test 自己建沙箱，跑完由操作系统回收 tmp。
// 这里不留 after()，避免误删仍在断言的现场；cleanup() 留给需要显式清的场景。
