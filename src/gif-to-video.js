// GIF → 视频转换：有人发动态表情（GIF）时，把它转成模型可读的 mp4。
//
// ── 为什么需要这个模块 ────────────────────────────────────────────────
// "支持图片输入"和"能读 GIF"是两回事，"支持视频输入"和"能读 GIF"也是两回事：
//   · 多数视觉 API 对 GIF 要么按第一帧处理、要么直接拒收；
//   · 全模态模型多数能读 mp4，却读不了 GIF。
// 所以当用户在设置里勾了「视频输入」(api.video) 时，看图工具拿到 GIF 不再按
// 图片原样发，而是先用 ffmpeg 转成 mp4，再按 video 部件发给模型
// （llm.js 的 specializedModelFor 会自动切到 videoModel）。
//
// ── 防"压缩炸弹"（decompression bomb）────────────────────────────────
// GIF 是无损索引色格式，一个几 MB 的 GIF 解开可能是上万帧超大画布，
// 转出来的 mp4 会大到把模型 token 预算炸穿（甚至拖垮网关）。
// 强约束（写死，不做成配置 —— 这是安全上限，不是口味）：
//   · 转换后长宽的最大边 ≤ 480 像素
//   · 转换后的总帧数 ≤ 24 帧
// ffmpeg 一次调用同时做到：先按需缩放，再均匀重采样帧（fps=帧数/时长），
// 最后 -frames:v 兜底截断 —— 即使 GIF 元数据撒谎也能被第三道闸拦住。
//
// ── 与项目其它 ffmpeg 用法的关系 ─────────────────────────────────────
// 路径解析统一走 `ffmpeg-resolve.js`（全项目唯一入口）：它负责「手填 > 环境变量 >
// 设置页下载的 > 旧随包 > PATH/注册表/WinGet」这条链，本模块只保留自己的
// **超时口径**（转换 45s、探测 10s）——那才是当初不该共享的东西。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { detectImageType } from './image-type.js';
import { resolveFfmpeg } from './ffmpeg-resolve.js';

/** 转换后最大边（像素）。 */
export const GIF_VIDEO_MAX_DIM = 480;
/** 转换后最大帧数。 */
export const GIF_VIDEO_MAX_FRAMES = 24;

/** 调外部命令，只看退出码；失败/超时返回 false（不抛）。 */
function runOk(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** 这段字节是 GIF 吗（魔数 GIF87a / GIF89a）。 */
export function isGifBuffer(buf) {
  const head = buf?.length >= 6 ? buf.toString('ascii', 0, 6) : '';
  return head === 'GIF87a' || head === 'GIF89a';
}

/**
 * 把 GIF 字节转成 mp4 data URL。
 *
 * @param {Buffer} buffer GIF 原始字节（已由调用方下载并校验过魔数）
 * @returns {Promise<{dataUrl: string, frames: number, width: number, height: number} | null>}
 *   失败（没 ffmpeg / 转换出错 / 产出异常）返回 null，调用方回退到按图片发送。
 */
export async function gifToVideoDataUrl(buffer) {
  const type = detectImageType(buffer);
  if (!type || type.mime !== 'image/gif') return null;
  const resolved = await resolveFfmpeg();
  const ffmpeg = resolved.ok ? resolved.ffmpeg : null;
  if (!ffmpeg) return null;

  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif_out_${stamp}.mp4`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // ffmpeg 参数：
    //   -ignore_loop 0        GIF 是循环格式；不忽略 loop 的话某些版本会无限读帧
    //   fps=24/duration ...   见下：需要先知道时长才能均匀采到 ≤24 帧
    //   scale                  最长边 ≤480，等比缩小（小图不放大）
    //   -frames:v 24           帧数兜底闸：即使 fps 估算被恶意元数据骗过，
    //                          输出也绝不可能超过 24 帧
    //   -an                    GIF 没有音轨，显式丢弃避免某些封装器报错
    //   -movflags +faststart   mp4 索引前置：模型网关多数是流式读，不用等全文件
    //   -pix_fmt yuv420p       多数解码器只认 420p；GIF 的调色板格式直转会被拒
    //
      // fps 的取法（防炸弹的核心）：
      //   GIF 的帧延时可以任意小（1ms），直接 -r 抽采样会先解码全部帧再丢，
      //   上万帧的炸弹 GIF 会让 ffmpeg 跑几分钟。所以分两步：
      //   第一步 ffprobe 拿真实时长；第二步 fps = 24 / duration（每帧间隔都保留）。
      //   拿不到时长就退回 fps=12 的保守值 —— 24 帧上限由 -frames:v 保证。
      //
      // force_divisible_by=2（2026-09-19 修"勾了视频输入 GIF 依旧按图片发"）：
      //   yuv420p + libx264 只吃偶数宽高。QQ 表情 GIF 常见 640x361 这种奇数高，
      //   转换会以 "Error while opening encoder" 失败，gifToVideoDataUrl 返回
      //   null，调用方静默回退到按图片发 —— 表现为「视频输入勾了却永远不生效」。
      //   整除 2 最多让画面偏 1px，比转换失败强得多。
      const duration = await probeDuration(tmpIn, ffmpeg, resolved.ffprobe);
      const fps = duration > 0 ? Math.min(24, Math.max(1, 24 / duration)) : 12;
      const okRun = await runOk(ffmpeg, [
        '-y',
        '-ignore_loop', '0',
        '-i', tmpIn,
        '-vf', `fps=${fps.toFixed(3)},scale='min(${GIF_VIDEO_MAX_DIM},iw)':'min(${GIF_VIDEO_MAX_DIM},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-frames:v', String(GIF_VIDEO_MAX_FRAMES),
      '-an',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpOut
    ], 45000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    // 产出为空或大得离谱（>8MB）都视为异常：正常 480px/24帧 的 mp4 不会超过几百 KB
    if (!out.length || out.length > 8 * 1024 * 1024) return null;
    const dims = await probeVideoSize(tmpOut, ffmpeg, resolved.ffprobe);
    return {
      dataUrl: `data:video/mp4;base64,${out.toString('base64')}`,
      frames: Math.min(GIF_VIDEO_MAX_FRAMES, Math.max(1, Math.round(duration > 0 ? Math.min(duration * fps, GIF_VIDEO_MAX_FRAMES) : GIF_VIDEO_MAX_FRAMES))),
      width: dims?.width || 0,
      height: dims?.height || 0
    };
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/**
 * 从 ffmpeg `-i` 的 stderr 文本里抠时长（秒）。纯函数，便于单测。
 * ffmpeg 形如：`  Duration: 00:00:05.04, start: 0.000000, bitrate: 1234 kb/s`
 */
export function parseFfmpegDuration(text) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text || ''));
  if (!m) return 0;
  const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

/**
 * 从 ffmpeg `-i` 的 stderr 文本里抠视频宽高。纯函数，便于单测。
 * ffmpeg 形如：`  Stream #0:0(und): Video: h264 (avc1), yuv420p, 480x360 [SAR 1:1 DAR 4:3]`
 */
export function parseFfmpegVideoSize(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => /Stream #\d+:\d+.*Video:/.test(l));
  if (!line) return null;
  const m = /[, ](\d{2,5})x(\d{2,5})(?:[ ,[])/.exec(line);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 跑一个命令并收集 stderr（ffmpeg -i 的元数据全在 stderr）。失败/超时返回 ''。 */
function runStderr(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch {
      return finish('');
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(out); }, timeoutMs);
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

/**
 * 读时长（秒）：优先 ffprobe（结构化、最准），没有 ffprobe 就用 ffmpeg 自报的
 * `Duration:` 兜底。都没有 → 0，调用方回退保守 fps。
 * @param {string} file
 * @param {string|null} ffmpeg 已解析到的 ffmpeg
 * @param {string|null} ffprobe 与 ffmpeg 配套的 ffprobe（由 ffmpeg-resolve 推导）
 */
async function probeDuration(file, ffmpeg = null, ffprobe = null) {
  if (ffprobe) {
    const txt = await runStdout(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', file
    ], 10000);
    if (txt) {
      try {
        const n = Number(JSON.parse(txt)?.format?.duration) || 0;
        if (n > 0) return n;
      } catch { /* 落到 ffmpeg 兜底 */ }
    }
  }
  if (!ffmpeg) return 0;
  return parseFfmpegDuration(await runStderr(ffmpeg, ['-hide_banner', '-i', file], 10000));
}

/**
 * 读视频宽高：优先 ffprobe，没有就用 ffmpeg `-i` 的 Stream 行兜底。
 * @param {string} file
 * @param {string|null} ffmpeg
 * @param {string|null} ffprobe
 * @returns {Promise<{width:number,height:number}|null>}
 */
async function probeVideoSize(file, ffmpeg = null, ffprobe = null) {
  if (ffprobe) {
    const txt = await runStdout(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', file
    ], 10000);
    if (txt) {
      try {
        const s = (JSON.parse(txt).streams || []).find((x) => x.codec_type === 'video');
        if (s?.width) return { width: Number(s.width), height: Number(s.height) };
      } catch { /* 落到 ffmpeg 兜底 */ }
    }
  }
  if (!ffmpeg) return null;
  return parseFfmpegVideoSize(await runStderr(ffmpeg, ['-hide_banner', '-i', file], 10000));
}

/** 调外部命令并收集 stdout；失败/超时返回 null。 */
function runStdout(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(out || null); });
  });
}

/**
 * 当前配置下 GIF 应该走哪条路。**纯函数**，便于测试。
 *
 * 规则矩阵（2026-09-19 按用户定稿重写；vision = api.vision，video = api.video）：
 *   vision=F, video=F → 'image'      所有图片（含动图）按 [图片] 占位符（看图工具整体不存在）
 *   vision=T, video=F → 'gif-image'  GIF 直接按图片发（读不了 GIF 的模型报错时，由调用方取首帧重试）
 *   vision=F, video=T → 'image'      图片输入没开：视频输入只管视频，图片一律占位符
 *   vision=T, video=T → 'video'      GIF 转 mp4 按 video 部件发（llm.js 自动切 videoModel）
 *
 * @returns {'video'|'gif-image'|'image'}
 */
export function resolveGifRoute({ vision = true, video = false } = {}) {
  if (!vision) return 'image';        // 看图工具不存在，谈不上 GIF 选路
  if (video) return 'video';          // 图片+视频都开：动图转视频
  return 'gif-image';                 // 只开图片：动图按图发，报错降级到首帧
}

/**
 * GIF 首帧提取：把动图的第一帧转成静态 PNG/JPEG 的 dataUrl。
 * 用途：resolveGifRoute 走 'gif-image' 时，模型/网关读不了 GIF 报错的**降级重试**——
 * "报错则取首帧输入模型，此流程写进代码而不靠模型调用"（用户定稿）。
 * 提取失败（没 ffmpeg / 文件异常）返回 null，调用方退回原样发送。
 */
export async function gifFirstFrameDataUrl(buffer) {
  const resolved = await resolveFfmpeg();
  const ffmpeg = resolved.ok ? resolved.ffmpeg : null;
  if (!ffmpeg) return null;
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(os.tmpdir(), `qqa_gif1_in_${stamp}.gif`);
  const tmpOut = path.join(os.tmpdir(), `qqa_gif1_out_${stamp}.png`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // -frames:v 1 只解码第一帧；scale 压到 ≤768px（静态帧没必要更大，省 token）
    const okRun = await runOk(ffmpeg, [
      '-y',
      '-ignore_loop', '0',
      '-i', tmpIn,
      '-vf', "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
      '-frames:v', '1',
      '-an',
      tmpOut
    ], 20000);
    if (!okRun || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    if (!out.length || out.length > 4 * 1024 * 1024) return null;
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return null;
  } finally {
    try { if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}
