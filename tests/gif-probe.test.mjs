// gif-to-video 的元数据解析（2026-10-23 体检补）
//
// 背景：这台机器 PATH 里没有 ffmpeg/ffprobe，gif-to-video 原先只查 PATH，
// 于是 findFfmpeg() 恒为 null → GIF 永远按图片发。现在改成「先随包、再 PATH」，
// 并且没有 ffprobe 时用 ffmpeg 自报的 Duration/Stream 行兜底。
//
// 这里只测**纯解析函数**（不 spawn），因为真正的转换依赖二进制、不适合当单测。
// 端到端那条路用 `node -e` 手工验过：96x72 的 1s GIF → 24 帧 mp4。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFfmpegDuration, parseFfmpegVideoSize } from '../src/gif-to-video.js';

test('时长：ffmpeg 常见 Duration 行', () => {
  assert.equal(parseFfmpegDuration('  Duration: 00:00:05.04, start: 0.000000, bitrate: 1234 kb/s'), 5.04);
});

test('时长：带小时的时间戳', () => {
  assert.equal(parseFfmpegDuration('Duration: 01:02:03.50, start: 0.0'), 3723.5);
});

test('时长：没有 Duration 行 / 空串 → 0（调用方回退保守 fps）', () => {
  assert.equal(parseFfmpegDuration('  Stream #0:0: Video: gif, bgra, 96x72'), 0);
  assert.equal(parseFfmpegDuration(''), 0);
  assert.equal(parseFfmpegDuration(null), 0);
});

test('时长：0 秒不算有效时长（避免 fps = 24/0）', () => {
  assert.equal(parseFfmpegDuration('Duration: 00:00:00.00, start: 0.0'), 0);
});

test('宽高：从 Video 流那一行取，忽略音频流的采样率数字', () => {
  const txt = [
    '  Stream #0:0: Audio: aac, 44100 Hz, stereo',
    '  Stream #0:1(und): Video: h264 (avc1), yuv420p, 480x360 [SAR 1:1 DAR 4:3], 30 fps'
  ].join('\n');
  assert.deepEqual(parseFfmpegVideoSize(txt), { width: 480, height: 360 });
});

test('宽高：没有视频流 → null', () => {
  assert.equal(parseFfmpegVideoSize('  Stream #0:0: Audio: aac, 44100 Hz'), null);
  assert.equal(parseFfmpegVideoSize(''), null);
});
