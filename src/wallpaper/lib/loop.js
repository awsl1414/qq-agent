// 无缝循环视频处理（移植自 zcode-beautify MIT，https://github.com/Logocceai/zcode-beautify）
//
// 构造（数学上无缝，原作者用 SSIM 首尾帧对比验证过 ≈1.0）：
//   output = crossfade( tail=input[D-f..D]（开头画面在它上面淡入）
//                     , main=input[f..D-f] )
//   总时长 = D - f
// 首尾衔接处是同一帧 → 循环点无跳变。音轨剥掉（壁纸必须无声），+faststart
// 让 HTTP 流式起播更快。
//
// 曾经踩过的坑（原注释保留）：最初设计的 [b]trim=1 做 base、淡入头
// setpts 平移到 [D-1..D] 的链路会整段丢掉 overlay 帧 —— overlay 输出随
// 主输入结束，主输入末尾之后的帧永远不会被合成。
import fs from 'node:fs';
import path from 'node:path';
import { execFileP } from './exec.js';
import { resolveHwEncoder } from './deps.js';

const exec = execFileP;

export class LoopError extends Error {}

export async function makeSeamless(input, output, fadeSec, ffmpegPath, options = {}) {
  const ffmpeg = ffmpegPath;
  if (!ffmpeg) throw new LoopError('ffmpeg 不可用');

  const fullDuration = await probeDuration(input, ffmpeg);
  if (!Number.isFinite(fullDuration) || fullDuration <= fadeSec + 1) {
    throw new LoopError(`输入太短，做不了 ${fadeSec}s 交叉淡化（时长 ${fullDuration}s）`);
  }
  // 长视频先截中段再循环：整段处理会让缓存膨胀到分钟级
  const duration = Math.min(fullDuration, options.seconds ?? fullDuration);
  const startAt = Math.min(options.startAt ?? 0, fullDuration - duration);
  if (duration <= fadeSec + 1) {
    throw new LoopError(`截段太短，做不了 ${fadeSec}s 交叉淡化（时长 ${duration}s）`);
  }

  const tailStart = duration - fadeSec;
  const mainLen = duration - 2 * fadeSec;
  const scale = options.maxWidth && options.maxWidth > 0
    ? `scale=w='min(${options.maxWidth}\\,iw)':h=-2,`
    : '';
  // 构造（2026-10-05 重构，输出语义与原版一致）：
  //   output = concat( overlay(尾段, 淡入的头段), 主体 )
  // 原版用 [0:v]split 双分支：尾段分支要等全片解完才开始消费，滤镜队列
  // 里堆下整段视频的帧 —— 1080p30 的 15 秒场景 ~1.3GB 还能活，4K60 的
  // 30 秒视频 ~20GB 直接 "Cannot allocate memory"。改为**三次定向 seek
  // 输入**（尾段/头段/主体各自独立解码），队列只剩常数帧，任何分辨率
  // 与时长都不再爆内存。
  //   input0 = [D-f, D]     尾段（crossfade 的底）
  //   input1 = [0, f]       头段（淡入叠上去）
  //   input2 = [f, D-f]     主体
  const filter = [
    `[1:v]format=yuva420p,fade=t=in:st=0:d=${fadeSec.toFixed(4)}:alpha=1[head]`,
    `[0:v]setpts=PTS-STARTPTS[tail]`,
    `[tail][head]overlay=format=auto:eof_action=pass[xfade]`,
    `[2:v]setpts=PTS-STARTPTS[main]`,
    `[xfade][main]concat=n=2:v=1:a=0[joined]`,
    `[joined]${scale}format=yuv420p[out]`
  ].join(';');

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  // 编码走硬件（NVENC/AMF，弱 CPU 机器软编码要跑满核几分钟）；探测失败
  // 自动回退 libx264。输入解码保持软件 —— 实测 -hwaccel auto 在双显卡/
  // 虚拟显示器机器上会 "Failed to transfer data to output frame: -12"
  // 直接炸掉整个转码（这类机器的 D3D11VA 路径不可靠，本就是一次性任务，
  // 软解源文件完全可接受）。
  const enc = await resolveHwEncoder(ffmpeg);
  const ss = (v) => v.toFixed(3);
  await exec(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'warning',
    // 尾段：seek 到 [startAt+D-f]，只读 f 秒（seek 落在关键帧上会多带
    // 几帧，concat 总长与理论值差几帧，可忽略）
    '-ss', ss(startAt + tailStart), '-t', ss(fadeSec), '-i', input,
    // 头段：从窗口起点读 f 秒
    '-ss', ss(startAt), '-t', ss(fadeSec), '-i', input,
    // 主体：[startAt+f, startAt+D-f]
    '-ss', ss(startAt + fadeSec), '-t', ss(mainLen), '-i', input,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:v', enc.codec, ...enc.extra,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    output
  ], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });

  return { inputDuration: duration, outputDuration: await probeDuration(output, ffmpeg) };
}

/** 容器时长（秒）：ffprobe 优先，ffmpeg -i 兜底。 */
export async function probeDuration(file, ffmpegPath) {
  const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  try {
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 });
    return Number(stdout.trim());
  } catch {
    const { stderr } = await exec(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number.NaN;
  }
}

/** 抓一帧代表性画面当 poster（跳过开头 1s：交叉淡化最暗的时刻）。 */
export async function extractPoster(loopFile, posterPath, ffmpegPath) {
  fs.mkdirSync(path.dirname(path.resolve(posterPath)), { recursive: true });
  await exec(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-ss', '1',
    '-i', loopFile,
    '-frames:v', '1', '-update', '1',
    '-q:v', '2',
    posterPath
  ], { timeout: 60_000 });
}
