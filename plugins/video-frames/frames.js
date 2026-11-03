// 多帧抽帧实现（纯 ffmpeg 调用，不碰网络/配置）。
//
// 为什么 `-ss` 要放在 `-i` 前面：
// `ffmpeg -i in.mp4 -ss 30 ...` 是输出定位，必须从第 0 秒解码到第 30 秒，
// 再把前面全部丢掉，30 秒的高清视频要白解 30 秒。
// `ffmpeg -ss 30 -i in.mp4 ...` 是输入定位，直接跳到关键帧再解码，
// 快几倍到几十倍。对 10 分钟的视频取 4 帧，这个差别是「秒级」和「卡住」的区别。
//
// 为什么不直接把 URL 丢给 ffmpeg：
// 社区版让 ffmpeg 直接读 HTTP URL，好处是只拉真正需要的那几段字节
// （10 分钟视频取 4 帧只传几百 KB，而不是几十 MB）。
// 但这里有 SSRF 缺口：URL 来自 OneBot 消息段（发送方可影响），
// ffmpeg 会自己去连、自己解析 DNS，我们没有任何机会做内网校验，
// 让群友发一条"视频链接"就能让宿主去探内网端口。
// 所以本项目坚持先经 safe-fetch 校验并落地成文件，再对本地文件抽帧。
// 代价是下载整个视频；换来的是不能被当跳板。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg, invalidateFfmpegCache } from '../../src/ffmpeg-resolve.js';

/**
 * 调外部命令，收集 stdout；失败/超时返回 null（不抛）。
 *
 * collectStderr=true 时额外收集最后一段 stderr：ffmpeg 把"未知编码器
 * libx264 / 找不到滤镜 scale / 不支持的输入"这类具体原因都写在 stderr
 * 里。只丢 stdout 的话，上层只能报"抽帧失败"，用户和我们都不知道是版本、
 * 构建还是输入的问题。
 */
function run(cmd, args, timeoutMs = 20000, { collectStderr = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', collectStderr ? 'pipe' : 'ignore'], windowsHide: true });
    } catch { return finish(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; if (err.length > 65536) err = err.slice(-32768); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      if (collectStderr) return finish({ stdout: out, stderr: err });
      finish(out || null);
    });
  });
}

/**
 * 把 ffmpeg 的 stderr 归类成可操作的原因。
 *
 * 这几类都指向同一个结论：这份 ffmpeg 缺东西，换一份就能解决。
 * 所以 UI 可以据此直接引导去下载，而不必让用户去猜"抽帧失败"是什么意思。
 * 返回 '' 表示认不出（保持原有的泛化报错，不误导）。
 */
export function classifyFfmpegError(stderr) {
  const s = String(stderr || '');
  if (/Unknown encoder ['"]?libx264/i.test(s)) return '这份 ffmpeg 缺少 libx264 编码器';
  if (/No such filter:\s*['"]?scale/i.test(s)) return '这份 ffmpeg 缺少 scale 滤镜';
  if (/Unknown encoder/i.test(s)) return '这份 ffmpeg 缺少所需的编码器';
  if (/No such filter/i.test(s)) return '这份 ffmpeg 缺少所需的滤镜';
  if (/not found|cannot find|is not recognized|不是内部或外部命令/i.test(s)) return 'ffmpeg 无法执行（可能文件损坏或架构不匹配）';
  if (/Invalid data found when processing input/i.test(s)) return '输入文件无法解析（不是这份 ffmpeg 的问题）';
  return '';
}

/**
 * 找一个可用的 ffmpeg。
 *
 * 路径解析统一交给 src/ffmpeg-resolve.js（手填 > 环境变量 > 设置页下载的 >
 * 旧随包 > PATH/注册表/WinGet）。缓存与「失败 60 秒后重探」的口径也由它负责，
 * 用户装好 / 下载完成后不用重启，`video.frames.available` 下一轮就能翻成可用。
 */
export async function findFfmpeg() {
  const r = await resolveFfmpeg();
  return r.ok ? r.ffmpeg : null;
}

/** 测试/运维用：强制清空探测缓存。 */
export function resetFfmpegCache() {
  invalidateFfmpegCache();
}

/** 用 ffprobe 读时长；没有 ffprobe（或解析失败）就返回 0（调用方退回"等间隔猜"）。 */
export async function probeDuration(filePath, ffprobePath = null) {
  const probe = ffprobePath || (await resolveFfmpeg()).ffprobe;
  if (!probe) return 0;
  const txt = await run(probe, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
  ], 15000);
  if (!txt) return 0;
  try {
    const j = JSON.parse(txt);
    return Number(j?.format?.duration) || 0;
  } catch { return 0; }
}

/**
 * 从视频里抽 N 帧，返回 data URL 数组。
 *
 * @param {object} o
 *   filePath    本地视频文件（必须是本地路径，见文件头 SSRF 说明）
 *   count       要几帧（1~12，默认 4）
 *   ffmpegPath  可执行文件路径（不传则自动探测）
 *   maxWidth    缩放宽度上限（默认 768；越小 token 越省）
 *   quality     JPEG 质量 2~31，越小越好（默认 4）
 *   durationSec 已知时长（省一次 ffprobe）
 *   tmpDir      临时目录
 * @returns {Promise<{ frames: string[], times: number[], error?: string }>}
 */
export async function extractFrames({
  filePath,
  count = 4,
  ffmpegPath = null,
  maxWidth = 768,
  quality = 4,
  durationSec = 0,
  tmpDir = null
} = {}) {
  const src = String(filePath || '');
  if (!src || !fs.existsSync(src)) return { frames: [], times: [], error: '视频文件不存在' };

  const resolved = ffmpegPath
    ? { ffmpeg: ffmpegPath, ffprobe: null }
    : await resolveFfmpeg();
  const ffmpeg = resolved.ffmpeg;
  if (!ffmpeg) return { frames: [], times: [], error: '未找到 ffmpeg' };

  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 4)));
  const dir = tmpDir || path.dirname(src);

  // 时间点：均匀分布在 (5%, 95%) 区间。
  // 不用首尾两端：开头常是黑场/logo，结尾常是黑场/字幕，两头都取等于浪费 2 帧。
  const dur = Number(durationSec) > 0
    ? Number(durationSec)
    : (await probeDuration(src, resolved.ffprobe));
  const times = [];
  if (dur > 0) {
    for (let i = 0; i < n; i++) {
      times.push(Number((dur * (0.05 + 0.9 * (i / Math.max(1, n - 1)))).toFixed(3)));
    }
  } else {
    // 时长未知：取前几秒的几个点（短视频居多，猜错的代价只是画面重复）
    for (let i = 0; i < n; i++) times.push(Number((1 + i * 2).toFixed(3)));
  }

  const frames = [];
  const okTimes = [];
  let lastStderr = '';
  for (const t of times) {
    const dest = path.join(dir, `frame_${Date.now().toString(36)}_${Math.round(t * 1000)}.jpg`);
    // -ss 在 -i 之前 = 输入定位（快）；-frames:v 1 = 只要一帧
    const r = await run(ffmpeg, [
      '-y', '-ss', String(t), '-i', src,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', String(quality),
      dest
    ], 20000, { collectStderr: true });
    if (r && r.stderr) lastStderr = r.stderr;
    try {
      if (!fs.existsSync(dest)) continue;
      const buf = fs.readFileSync(dest);
      if (!buf.length) continue;
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      okTimes.push(t);
    } catch { /* 单帧失败不影响其它帧 */ } finally {
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    }
  }

  if (!frames.length) {
    // 优先给出具体原因：缺编码器 / 缺滤镜这类是"换一份 ffmpeg 就能好"的，
    // 和"输入文件坏了"对用户的意义完全不同。认不出才退回泛化文案。
    const classified = classifyFfmpegError(lastStderr);
    return { frames: [], times: [], error: classified || '抽帧失败（ffmpeg 没有产出可用画面）' };
  }
  return { frames, times: okTimes };
}
