// ffmpeg 路径解析（2026-11-03 随包 ffmpeg 下线时补）
//
// 背景：此前 5 处各自探测 ffmpeg，顺序还不一致 —— video-reader 只查 PATH，
// 于是同一个安装包里「图片压缩能用、视频元信息读不出」。现在统一到
// src/ffmpeg-resolve.js，这里钉住三件容易回归的事：
//   ① 版本解析（git 构建不能被误判成"过旧"）
//   ② ffprobe 从 ffmpeg 同目录推导（不再裸名 spawn）
//   ③ 候选顺序与缓存语义
//
// 不伪造 .exe 做端到端探测：Windows 上伪造的可执行文件 spawn 必然失败，
// 那样测出来的只是"假文件跑不起来"，不是真实语义。真正要真跑 exe 的断言
// 放在文件末尾，机器上确实有 ffmpeg 时才执行（没有就跳过，不算失败）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `qqa-ffresolve-${process.pid}-${Date.now()}`);

// 必须**在 import 模块之前**设好数据目录：config.js 的 DATA_DIR 是模块级常量，
// 晚一步设就会指向真实 data/，测试会污染用户目录。
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const mod = await import('../src/ffmpeg-resolve.js');
const {
  FFMPEG_SOURCES, FFMPEG_SOURCE_ORDER, normalizeSourcePreference
} = mod;

before(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true }); });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 造一个占位文件（只为验证路径推导，不参与 spawn）。 */
function touchFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

test('版本与校验值常量自洽（升级时最容易漏改的一处）', () => {
  assert.match(mod.FFMPEG_VERSION, /^\d+\.\d+(\.\d+)?$/);
  // 资产按平台分组：win32 是同一份内容的两种压缩格式，linux 是 ffmpeg/ffprobe
  // 两个独立包。分组结构不同，但每个资产都必须过同一套校验值自洽检查。
  const groups = [
    ['win32', mod.FFMPEG_ASSETS.win32],
    ['linux.x64', mod.FFMPEG_ASSETS.linux.x64],
    ['linux.arm64', mod.FFMPEG_ASSETS.linux.arm64]
  ];
  for (const [group, assets] of groups) {
    assert.ok(assets, `缺少 ${group} 资产组`);
    for (const [key, a] of Object.entries(assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, `${group}.${key} 的 sha256 不是 64 位小写十六进制`);
      assert.ok(Number.isInteger(a.bytes) && a.bytes > 0, `${group}.${key} 的字节数应为正整数，实际 ${a.bytes}`);
    }
  }
  // Windows 的 7z 必须显著小于 zip，否则「7z 优先」的前提不成立
  assert.ok(
    mod.FFMPEG_ASSETS.win32['7z'].bytes < mod.FFMPEG_ASSETS.win32.zip.bytes,
    '7z 应小于 zip，否则优先下 7z 没有意义'
  );
});

test('parseFfmpegVersion：官方构建取主版本', () => {
  assert.deepEqual(
    mod.parseFfmpegVersion('ffmpeg version 9.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2025'),
    { raw: '9.0.2-essentials_build-www.gyan.dev', major: 9 }
  );
});

test('parseFfmpegVersion：n7.1-dev 仍能取主版本 7（不会被当成过旧）', () => {
  const v = mod.parseFfmpegVersion('ffmpeg version n7.1-dev');
  assert.equal(v.major, 7);
  assert.equal(v.raw, 'n7.1-dev');
});

test('parseFfmpegVersion：纯提交号构建按最新算，不误判成过旧', () => {
  const v = mod.parseFfmpegVersion('ffmpeg version N-116000-g1234abc');
  assert.equal(v.major, Number.MAX_SAFE_INTEGER);
  assert.equal(v.raw, 'N-116000-g1234abc');
});

test('parseFfmpegVersion：认不出返回 null（调用方据此判不可用）', () => {
  assert.equal(mod.parseFfmpegVersion(''), null);
  assert.equal(mod.parseFfmpegVersion(null), null);
  assert.equal(mod.parseFfmpegVersion('command not found'), null);
});

test('ffprobeFor：同目录有 ffprobe 就用它', () => {
  const dir = path.join(TMP, 'bin-with-probe');
  const ff = touchFile(path.join(dir, mod.exeName('ffmpeg')));
  const fp = touchFile(path.join(dir, mod.exeName('ffprobe')));
  assert.equal(mod.ffprobeFor(ff), fp);
});

test('ffprobeFor：同目录没有就返回 null（调用方退回 ffmpeg -i 兜底）', () => {
  const dir = path.join(TMP, 'bin-no-probe');
  const ff = touchFile(path.join(dir, mod.exeName('ffmpeg')));
  assert.equal(mod.ffprobeFor(ff), null);
});

test('ffprobeFor：裸名 → 裸名 ffprobe（交给 PATH 解析）', () => {
  assert.equal(mod.ffprobeFor('ffmpeg'), mod.exeName('ffprobe'));
});

test('probeFfmpeg：不存在的路径 → ok:false（不抛）', async () => {
  const r = await mod.probeFfmpeg(path.join(TMP, 'nope', 'ffmpeg.exe'));
  assert.equal(r.ok, false);
  assert.equal(r.major, 0);
});

test('managedBinDir 指向数据目录下的 runtime/ffmpeg/bin', () => {
  const dir = mod.managedBinDir();
  assert.ok(dir.startsWith(TMP), `应在测试数据目录下，实际 ${dir}`);
  assert.ok(dir.endsWith(path.join('runtime', 'ffmpeg', 'bin')));
});

test('sourceOf：能认出 managed / bundled / path 三类来源', () => {
  assert.equal(mod.sourceOf(path.join(mod.managedBinDir(), mod.exeName('ffmpeg'))), 'managed');
  assert.equal(mod.sourceOf(path.join(mod.bundledBinDir(), mod.exeName('ffmpeg'))), 'bundled');
  assert.equal(mod.sourceOf('ffmpeg'), 'path');
  assert.equal(mod.sourceOf(''), 'none');
});

test('resolveFfmpeg：缓存命中返回同一对象，force 才重探', async () => {
  mod.invalidateFfmpegCache();
  const a = await mod.resolveFfmpeg();
  const b = await mod.resolveFfmpeg();
  assert.equal(a, b, '未 force 时应返回同一个结果对象（说明走了缓存）');
  const c = await mod.resolveFfmpeg({ force: true });
  assert.notEqual(a, c, 'force=true 应重新探测');
  assert.equal(a.ok, c.ok, '重探结果应与上次一致（环境没变）');
});

test('resolveFfmpeg：手填路径无效时继续往下找，不直接判失败', async () => {
  const { getConfig, updateConfig } = await import('../src/config.js');
  const before = getConfig()?.media?.ffmpegPath || '';
  try {
    updateConfig({ media: { ffmpegPath: path.join(TMP, 'does-not-exist', 'ffmpeg.exe') } });
    mod.invalidateFfmpegCache();
    const r = await mod.resolveFfmpeg();
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) assert.notEqual(r.source, 'manual', '无效手填路径不该被当成来源');
  } finally {
    updateConfig({ media: { ffmpegPath: before } });
    mod.invalidateFfmpegCache();
  }
});

// ── 真跑 exe 的断言：机器上确实有 ffmpeg 才执行 ──────────────────────────
// 上面所有路径推导都用占位文件，这里用真实解析结果验一遍"能跑起来"。
// 没装 ffmpeg 的机器跳过 —— 这不是失败，只是没条件验。
test('真实环境：解析到的 ffmpeg 能跑 -version（无 ffmpeg 则跳过）', async (t) => {
  mod.invalidateFfmpegCache();
  const r = await mod.resolveFfmpeg();
  if (!r.ok) return t.skip('本机没有可用的 ffmpeg');
  assert.ok(r.major > 0);
  assert.ok(r.detail.startsWith('ffmpeg '));
  // ffprobe 要么是同目录那份，要么从 PATH 兜底拿到；两者都没有时返回裸名
  assert.ok(r.ffprobe, 'ffprobe 不应为 null（至少有裸名兜底）');
});

// ── 来源偏好：组间可切换，组内顺序固定 ──────────────────────────────────

test('三组来源常量齐全且默认顺序是 手填 > 下载 > 系统', () => {
  assert.equal(FFMPEG_SOURCES.MANUAL, 'manual');
  assert.equal(FFMPEG_SOURCES.MANAGED, 'managed');
  assert.equal(FFMPEG_SOURCES.SYSTEM, 'system');
  assert.deepEqual([...FFMPEG_SOURCE_ORDER], ['manual', 'managed', 'system']);
});

test('normalizeSourcePreference：只认三个组名，其余归零', () => {
  assert.equal(normalizeSourcePreference('system'), 'system');
  assert.equal(normalizeSourcePreference('managed'), 'managed');
  assert.equal(normalizeSourcePreference('manual'), 'manual');
  // 前后空白容忍（配置可能被手改过），大小写与未知值一律归零
  assert.equal(normalizeSourcePreference('  system  '), 'system');
  for (const bad of ['', null, undefined, 'auto', 'SYSTEM', 'path']) {
    assert.equal(normalizeSourcePreference(bad), '', String(bad));
  }
});

// ── 缺 ffmpeg 时的引导原因码 ────────────────────────────────────────────
// 前端靠结构化原因码决定"给一键去安装"还是"只报错"，不匹配中文文案 ——
// 所以这里钉住字段本身，改文案不会悄悄把引导弄丢。

test('wallpaper deps：缺 ffmpeg / 版本过旧 / 平台不支持各有独立原因码', async () => {
  const { checkFfmpeg } = await import('../src/wallpaper/lib/deps.js');
  const r = await checkFfmpeg();
  assert.equal(typeof r.ok, 'boolean');
  if (!r.ok) {
    // 本机没有 / 没有可用 ffmpeg 时的形态。非 Windows 一律是
    // unsupported-platform：动态壁纸录制依赖 ddagrab 与 Wallpaper Engine，
    // 装不装 ffmpeg 都录不出来。
    const reasons = ['missing', 'outdated', 'unsupported-platform'];
    assert.ok(reasons.includes(r.reason), `reason 应为 ${reasons.join('/')}，实际 ${r.reason}`);
    if (process.platform !== 'win32') {
      assert.equal(r.reason, 'unsupported-platform', '非 Windows 上必须是平台原因，不能混成缺 ffmpeg');
    }
    assert.equal(typeof r.detail, 'string');
    assert.ok(r.detail.length > 0);
  } else {
    // 有可用 ffmpeg 时不该带 reason（避免前端误判成"要引导"）
    assert.equal(r.reason, undefined);
    assert.equal(typeof r.path, 'string');
  }
});
