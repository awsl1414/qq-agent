// 版本迁移（src/upgrade.js）的单测。此前这条链路**完全没有测试**，而它做的是
// "在用户机器上搬文件、删文件"，出错代价最高：删错一个目录、或把已执行的迁移
// 重跑一遍（覆盖备份），用户的数据就没了。
//
// 钉住五件事：
//   ① 路径安全：越界 / 根目录 / 符号链接 / 允许根本身 全部拒绝
//   ② 幂等：已执行的项永不重跑；老格式状态文件（字符串时间戳）也认得
//   ③ 状态格式演进：新格式能读出 movedTo，老格式照样跳过
//   ④ 失败不阻塞：抛错项不进 applied、其余项照跑
//   ⑤ 搬移语义：原位置消失、新位置存在、内容一致、目标已存在不覆盖
//
// 全部在 fs.mkdtempSync 建的临时目录里跑，**绝不碰真实 data/**。
// runUpgrades / detectLegacyResidue / removeLegacyResidue 都接受 appRoot 与
// dataDir 注入，这里靠它们把两侧都指到临时目录。
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
  removePath,
  backupPath,
  legacyBackupRoot,
  detectLegacyResidue,
  removeLegacyResidue,
  normalizeAppliedEntry
} from '../src/upgrade.js';

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

/** 只跑指定的迁移项（其余项在测试沙箱里多半会因为缺前置而失败，干扰断言）。 */
function runOnly(ids, opts) {
  return runUpgrades({ ...opts, upgrades: UPGRADES.filter((u) => ids.includes(u.id)) });
}

const silent = () => {};

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
      'retire-bundled-ffmpeg': { at: '2026-11-03T01:02:03.000Z', movedTo: 'runtime/legacy-backup/ffmpeg-x' }
    },
    updatedAt: '2026-11-03T01:02:03.000Z'
  }), 'utf8');

  const st = readUpgradeState(stateFile);
  assert.equal(st.applied['retire-bundled-ffmpeg'].movedTo, 'runtime/legacy-backup/ffmpeg-x');
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
  const oldExe = path.join(appRoot, 'runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.writeFileSync(oldExe, 'FAKE-OLD-FFMPEG', 'utf8');

  const first = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 1000, saveConfig: () => {} });
  const ff = first.ran.find((x) => x.id === 'retire-bundled-ffmpeg');
  assert.ok(ff, '第一次应执行 ffmpeg 迁移');
  assert.equal(fs.existsSync(oldExe), false, '旧位置应已被搬走');

  // 备份落到 data/runtime/legacy-backup/ffmpeg-<时间戳>/ 下，内容不变
  const backupRoot = legacyBackupRoot(dataDir);
  const dirs = fs.readdirSync(backupRoot);
  assert.equal(dirs.length, 1);
  const movedFile = path.join(backupRoot, dirs[0], path.basename(oldExe));
  assert.equal(fs.readFileSync(movedFile, 'utf8'), 'FAKE-OLD-FFMPEG');

  // 状态里记下了搬到哪里
  const st = readUpgradeState(upgradeStatePath(dataDir));
  assert.equal(st.applied['retire-bundled-ffmpeg'].movedTo, `runtime/legacy-backup/${dirs[0]}`);

  // 第二次：全部跳过，备份目录不会多出一份
  const second = runUpgrades({ appRoot, dataDir, version: '9.9.9.9', log: silent, now: 2000, saveConfig: () => {} });
  assert.ok(second.skipped.includes('retire-bundled-ffmpeg'));
  assert.equal(fs.readdirSync(backupRoot).length, 1, '第二次不应产生新备份');
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

test('backupPath：目标重名时自动加后缀，不覆盖已有备份', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const backupRoot = path.join(dataDir, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(path.join(backupRoot, 'f.txt'), 'FIRST', 'utf8');

  const src = path.join(dataDir, 'f.txt');
  fs.writeFileSync(src, 'SECOND', 'utf8');
  const r = backupPath(src, { backupRoot, roots });
  assert.equal(path.basename(r.to), 'f.txt-2');
  assert.equal(fs.readFileSync(path.join(backupRoot, 'f.txt'), 'utf8'), 'FIRST');
  assert.equal(fs.readFileSync(r.to, 'utf8'), 'SECOND');
});

test('removePath：不存在视为已达成（幂等）', () => {
  const { appRoot, dataDir } = sandbox();
  const roots = allowedRoots({ appRoot, dataDir });
  const r = removePath(path.join(dataDir, 'nope.txt'), { roots });
  assert.equal(r.removed, false);
});

// ── ffmpeg 迁移项覆盖的旧形态 ────────────────────────────────────────────

const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

test('retire-bundled-ffmpeg：没有旧文件时不做事，也不记成"已执行"之外的东西', () => {
  const { appRoot, dataDir } = sandbox();
  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 10, saveConfig: () => {} });
  assert.equal(r.ran.length, 1);
  assert.deepEqual(r.ran[0].changed, []);
  assert.match(r.ran[0].note, /没有旧随包 ffmpeg/);
});

test('retire-bundled-ffmpeg：覆盖单文件形态 runtime/ffmpeg.exe', () => {
  const { appRoot, dataDir } = sandbox();
  const oldExe = path.join(appRoot, 'runtime', ffmpegExe);
  fs.writeFileSync(oldExe, 'X', 'utf8');
  const r = runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 11, saveConfig: () => {} });
  assert.equal(fs.existsSync(oldExe), false);
  assert.equal(r.ran[0].changed.length, 1);
});

test('retire-bundled-ffmpeg：覆盖目录形态 runtime/ffmpeg/bin/ffmpeg', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', ffmpegExe), 'X', 'utf8');
  fs.writeFileSync(path.join(dir, 'bin', 'ffprobe'), 'P', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 12, saveConfig: () => {} });
  assert.equal(fs.existsSync(dir), false, '整个目录应被搬走');
  const backupRoot = legacyBackupRoot(dataDir);
  const [inner] = fs.readdirSync(backupRoot);
  assert.ok(fs.existsSync(path.join(backupRoot, inner, 'ffmpeg', 'bin', ffmpegExe)));
});

test('retire-bundled-ffmpeg：不动 runtime/qq-portable（便携 QQ 是用户数据）', () => {
  const { appRoot, dataDir } = sandbox();
  const portable = path.join(appRoot, 'runtime', 'qq-portable');
  fs.mkdirSync(portable, { recursive: true });
  fs.writeFileSync(path.join(portable, 'QQ.exe'), 'QQ', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 13, saveConfig: () => {} });
  assert.equal(fs.existsSync(portable), true);
  assert.equal(fs.readFileSync(path.join(portable, 'QQ.exe'), 'utf8'), 'QQ');
});

test('retire-bundled-ffmpeg：同名空目录不搬（不是 ffmpeg 的目录不误伤）', () => {
  const { appRoot, dataDir } = sandbox();
  const dir = path.join(appRoot, 'runtime', 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ffmpeg', 'utf8');
  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 14, saveConfig: () => {} });
  assert.equal(fs.existsSync(dir), true, '目录里没有 ffmpeg，不该动它');
});

test('retire-bundled-ffmpeg：新版已下载时不覆盖 data/runtime/ffmpeg/bin', () => {
  const { appRoot, dataDir } = sandbox();
  const managed = path.join(dataDir, 'runtime', 'ffmpeg', 'bin');
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, ffmpegExe), 'NEW', 'utf8');
  fs.writeFileSync(path.join(appRoot, 'runtime', ffmpegExe), 'OLD', 'utf8');

  runOnly(['retire-bundled-ffmpeg'], { appRoot, dataDir, version: '9.9.9.9', log: silent, now: 15, saveConfig: () => {} });
  assert.equal(fs.readFileSync(path.join(managed, ffmpegExe), 'utf8'), 'NEW', '新位置不能被旧文件覆盖');
  assert.equal(fs.existsSync(path.join(appRoot, 'runtime', ffmpegExe)), false, '旧文件照样搬走');
});

// ── 用户确认清理 ────────────────────────────────────────────────────────

test('detectLegacyResidue：列出备份区条目与尚未搬走的旧 ffmpeg', () => {
  const { appRoot, dataDir } = sandbox();
  const backup = path.join(legacyBackupRoot(dataDir), 'ffmpeg-2026-11-03T00-00-00-000Z');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, ffmpegExe), 'x'.repeat(100), 'utf8');
  fs.writeFileSync(path.join(appRoot, 'runtime', ffmpegExe), 'y', 'utf8');

  const r = detectLegacyResidue({ appRoot, dataDir });
  assert.equal(r.items.length, 2);
  const kinds = r.items.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['legacy-backup', 'runtime-pending']);
  const b = r.items.find((x) => x.kind === 'legacy-backup');
  assert.equal(b.sizeBytes, 100);
  assert.equal(b.files, 1);
  assert.match(b.relPath, /^runtime\/legacy-backup\//);
});

test('detectLegacyResidue：没有残留时返回空列表', () => {
  const { appRoot, dataDir } = sandbox();
  const r = detectLegacyResidue({ appRoot, dataDir });
  assert.deepEqual(r.items, []);
});

test('removeLegacyResidue：只删备份区里的条目', () => {
  const { appRoot, dataDir } = sandbox();
  const backup = path.join(legacyBackupRoot(dataDir), 'ffmpeg-old');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, ffmpegExe), 'x'.repeat(10), 'utf8');

  const r = removeLegacyResidue({ paths: [backup], appRoot, dataDir });
  assert.deepEqual(r.removed, [backup]);
  assert.equal(fs.existsSync(backup), false);
  assert.ok(r.freedBytes >= 10);
});

test('removeLegacyResidue：拒绝备份区以外的数据目录路径（不能传什么删什么）', () => {
  const { appRoot, dataDir } = sandbox();
  const victim = path.join(dataDir, 'config.json');
  fs.writeFileSync(victim, '{}', 'utf8');
  const r = removeLegacyResidue({ paths: [victim], appRoot, dataDir });
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /可清理范围/);
  assert.equal(fs.existsSync(victim), true);
});

test('removeLegacyResidue：越界、根目录、符号链接全部被拒', { skip: process.platform === 'win32' && 'Windows 上创建符号链接需要额外权限' }, () => {
  const { root, appRoot, dataDir } = sandbox();
  const outside = path.join(root, 'outside3');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep'), 'k', 'utf8');
  const link = path.join(dataDir, 'runtime', 'legacy-backup', 'link');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, 'dir');

  const r = removeLegacyResidue({
    paths: [path.parse(path.resolve('/')).root, path.join(root, 'outside3'), link],
    appRoot, dataDir
  });
  assert.deepEqual(r.removed, []);
  assert.equal(r.skipped.length, 3);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k');
});

test('removeLegacyResidue：不存在的项视为已删（幂等，不报错也不计入 removed）', () => {
  const { appRoot, dataDir } = sandbox();
  const ghost = path.join(legacyBackupRoot(dataDir), 'ghost');
  const r = removeLegacyResidue({ paths: [ghost], appRoot, dataDir });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.skipped, []);
});
