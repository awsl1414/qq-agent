// ffmpeg 平台能力判定
//
// ffmpeg 的获取方式按平台分叉：Windows / Linux 可以程序内下载，macOS 只能走
// Homebrew。三件事最容易在改动中悄悄错掉：
//   ① canAutoInstall 的判断与资产表不同步（mac 上露出一个必然失败的下载按钮）
//   ② installGuideFor 的文案/命令被改坏（用户照着敲却装不上）
//   ③ Linux 资产串了架构（x64 下到 arm64 包，或 ffmpeg/ffprobe 指向同一个包）
// 这里只读常量与纯函数，不下载任何东西，网络不稳定不该让测试变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `qqa-ffplatform-${process.pid}-${Date.now()}`);

// 必须在 import 模块之前设好数据目录：config.js 的 DATA_DIR 是模块级常量，
// 晚一步设就会指向真实 data/，测试会污染用户目录。
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const mod = await import('../src/ffmpeg-resolve.js');

// 资产体积的合理区间：Linux 的 ffmpeg/ffprobe 都是静态大包，抄错数量级
// （把 33MB 写成 33 万或 33 亿）在下载时才暴露，且表现为"校验失败"而非
// "常量写错"，很难自查。区间取 10MB ~ 100MB。
const MIN_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;

test('canAutoInstall：Windows / Linux 可程序内下载，macOS 一律不行', () => {
  assert.equal(mod.canAutoInstall('darwin'), false, 'macOS 的 ffmpeg 由 Homebrew 提供，不能露出下载入口');
  assert.equal(mod.canAutoInstall('win32'), true, 'Windows 走 7z/zip 下载');
  assert.equal(mod.canAutoInstall('linux'), true, 'Linux 走 riedl 的 sha256 包');
});

test('installGuideFor(darwin)：主命令是 brew install ffmpeg', () => {
  const g = mod.installGuideFor('darwin');
  assert.ok(g, 'macOS 必须给出安装引导，否则用户无从下手');
  assert.equal(g.kind, 'command');
  assert.ok(g.primary?.cmd?.includes('brew install ffmpeg'), `主命令应包含 brew install ffmpeg，实际 ${g.primary?.cmd}`);
});

test('installGuideFor(darwin)：兜底命令是 Homebrew 官方安装脚本', () => {
  const g = mod.installGuideFor('darwin');
  assert.ok(
    g.fallback?.cmd?.includes('Homebrew/install'),
    `兜底命令应指向 Homebrew/install 脚本，实际 ${g.fallback?.cmd}`
  );
});

test('installGuideFor(linux)：四个发行版，每条命令都真的在装 ffmpeg', () => {
  const g = mod.installGuideFor('linux');
  assert.ok(Array.isArray(g?.distros), 'Linux 引导应是按发行版分列的命令');
  assert.equal(g.distros.length, 4, `distros 应恰好 4 项（Debian/Fedora/Arch/openSUSE），实际 ${g.distros.length}`);
  for (const d of g.distros) {
    assert.ok(d.cmd?.includes('ffmpeg'), `${d.id} 的命令里没有 ffmpeg：${d.cmd}`);
  }
});

test('installGuideFor(win32)：返回 null（Windows 走程序内下载，不给命令行引导）', () => {
  assert.equal(mod.installGuideFor('win32'), null);
});

test('platformAssets(darwin)：返回 null（mac 不下载任何资产）', () => {
  assert.equal(mod.platformAssets('darwin'), null, 'macOS 没有可下载的资产组，调用方据此隐藏下载入口');
});

test('platformAssets(win32)：有 7z 与 zip 两种格式', () => {
  const a = mod.platformAssets('win32');
  assert.ok(a?.['7z'], 'win32 资产组应含 7z');
  assert.ok(a?.zip, 'win32 资产组应含 zip 兜底');
});

test('platformAssets(linux, x64)：ffmpeg 与 ffprobe 是两个独立包', () => {
  const a = mod.platformAssets('linux', 'x64');
  assert.ok(a?.ffmpeg, 'linux.x64 应含 ffmpeg');
  assert.ok(a?.ffprobe, 'linux.x64 应含 ffprobe');
  assert.notEqual(
    a.ffmpeg.sha256,
    a.ffprobe.sha256,
    'ffmpeg 与 ffprobe 是两个不同的包，校验值相同说明抄串了'
  );
});

test('Linux 资产体积在合理区间（防抄错数量级）', () => {
  for (const arch of ['x64', 'arm64']) {
    for (const key of ['ffmpeg', 'ffprobe']) {
      const bytes = mod.FFMPEG_ASSETS.linux[arch][key].bytes;
      assert.ok(
        bytes >= MIN_ASSET_BYTES && bytes <= MAX_ASSET_BYTES,
        `linux.${arch}.${key} 的字节数 ${bytes} 超出 10MB~100MB 的合理区间`
      );
    }
  }
});
