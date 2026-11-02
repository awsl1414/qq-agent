// 图片压缩：把过大的图片缩到模型可接受的尺寸/体积，降低 token 成本与传输开销。
//
// 背景：QQ 图床的原图可能几 MB 甚至十几 MB，直接 base64 给模型既贵又慢，
// 很多视觉模型对超大图还会拒收或报错。这里在下载后、给模型前做一道压缩。
//
// 实现：项目没有图像处理库（无 sharp/jimp），用 ffmpeg 做缩放。
//   - 有 ffmpeg：按最长边缩到 maxDim，并重编码为 JPEG（质量可调）
//   - 无 ffmpeg：原样返回（不压缩，保持旧行为）
// 判断"是否过大"：优先按像素（需 ffprobe 读尺寸），读不到尺寸时按字节数兜底。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectImageType, mimeToExt } from './image-type.js';
import { logger } from './logger.js';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from './ffmpeg-resolve.js';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? true : null); });
  });
}

/**
 * 取当前可用的 ffmpeg / ffprobe。
 *
 * 2026-11-03：随包 ffmpeg 下线，路径解析统一交给 ffmpeg-resolve.js
 * （手填 > 环境变量 > 设置页下载的 > 旧随包 > PATH/注册表/WinGet）。
 * 这里只保留「探不到时告警一次」这条本模块特有的行为 —— 静默原样返回会让
 * "图片没被压缩"完全不可见，2026-10-16 那次 6.5MB 的请求体就是这么查的。
 */
let _warnedNoFfmpeg = false;
async function ensureFf() {
  const r = await resolveFfmpeg();
  if (!r.ok && !_warnedNoFfmpeg) {
    _warnedNoFfmpeg = true;
    logger.warn('image-compress', '⚠️ 未找到 ffmpeg（大图将不压缩，请求体可能涨到数 MB）。去「设置 → 媒体工具」下载即可修复。');
  }
  return { ffmpeg: r.ffmpeg, ffprobe: r.ffprobe };
}

/** 用 ffprobe 读图片尺寸。 */
async function imageSize(ffprobe, filePath) {
  const out = await new Promise((resolve) => {
    let txt = '';
    let child;
    try {
      child = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10000);
    child.stdout.on('data', (d) => { txt += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(txt);
        const s = (j.streams || []).find((x) => x.codec_type === 'video' || x.width);
        resolve(s && s.width ? { width: Number(s.width), height: Number(s.height) } : null);
      } catch {
        resolve(null);
      }
    });
  });
  return out;
}

/**
 * 压缩一张图片（如需要）。
 * @param {Buffer} buffer 原始图片字节
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1568] 最长边上限（像素），超过则等比缩小
 * @param {number} [opts.maxBytes=4*1024*1024] 字节上限，超过则尝试压缩
 * @param {number} [opts.quality=4] JPEG 质量（ffmpeg -q:v，2 最好 31 最差，4 是不错的平衡）
 * @returns {Promise<{buffer: Buffer, mime: string, compressed: boolean}>}
 */
export async function compressImage(buffer, { maxDim = 1568, maxBytes = 4 * 1024 * 1024, quality = 4 } = {}) {
  const mime = detectMime(buffer) || 'image/jpeg';
  // 小图直接过（字节数就很小，没必要压缩）
  if (buffer.length <= Math.min(maxBytes, 512 * 1024)) {
    return { buffer, mime, compressed: false };
  }
  const { ffmpeg, ffprobe } = await ensureFf();
  if (!ffmpeg) {
    // 无 ffmpeg：无法压缩，原样返回（保持旧行为）
    return { buffer, mime, compressed: false };
  }
  // 写到临时文件 → ffmpeg 缩放 → 读回
  const tmpIn = path.join(os.tmpdir(), `qqa_img_in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${extOf(mime)}`);
  const tmpOut = path.join(os.tmpdir(), `qqa_img_out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // 判断是否超过最长边（有 ffprobe 才读得到；读不到就按字节数决定压不压）
    let needResize = buffer.length > maxBytes;
    if (ffprobe) {
      const size = await imageSize(ffprobe, tmpIn);
      if (size && (size.width > maxDim || size.height > maxDim)) needResize = true;
    }
    if (!needResize) return { buffer, mime, compressed: false };
    // ffmpeg：等比缩放到最长边 maxDim，重编码 JPEG
    const okRun = await run(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(quality),
      tmpOut
    ], 25000);
    if (okRun && fs.existsSync(tmpOut)) {
      const compressed = fs.readFileSync(tmpOut);
      // 只有真的变小了才用压缩结果（否则保留原图）
      if (compressed.length && compressed.length < buffer.length) {
        return { buffer: compressed, mime: 'image/jpeg', compressed: true };
      }
    }
    return { buffer, mime, compressed: false };
  } catch {
    return { buffer, mime, compressed: false };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

// 类型嗅探与 MIME→扩展名统一放在 image-type.js（曾经这里/tools.js/sticker-manager.js
// 各有一份实现，容易各自演化出不一致的行为）。
function detectMime(buf) {
  return detectImageType(buf)?.mime ?? null;
}

function extOf(mime) {
  return mimeToExt(mime);
}
