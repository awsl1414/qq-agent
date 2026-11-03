// 视频读取：探测视频元信息（时长/分辨率/大小/格式），并按配置决定怎么让模型"看"到画面。
//
// 两条路线（互斥，由 config.api.videoMode 决定）：
//   native 全模态模型直接读视频：把视频地址作为 video 部分发给模型。
//          由设置页的「视频输入专用模型」声明"我有这种模型"，核心不猜。
//   frames 抽帧：把视频变成若干张图片，任何视觉模型都能用。
//          实现放在 `skills/video-frames`（capability `video.frames`），
//          本模块通过能力名取用，关掉 Skill 就自动退回"只给元信息"。
//
// 不两条一起喂：同一段内容重复计费，而且视频部分和图片部分混在一起
// 多数网关会因格式冲突直接 400。二选一是刻意的设计，不是偷懒。
//
// 探测元信息本身是尽力而为的：NapCat/SnowLuma 的视频缓存不一定在，
// ffprobe/ffmpeg 也不一定装了。每一步失败都降级，绝不抛出让模型看到一串技术错误。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, getConfig } from './config.js';
import { safeFetchBinaryToFile } from './safe-fetch.js';
import { resolveCachedMediaPath } from './media-path.js';
import { resolveFfmpeg } from './ffmpeg-resolve.js';
import { skillManager } from './skills/manager.js';

/** 允许的抽帧模式取值（配置写错时回退 auto）。 */
export const VIDEO_MODES = ['auto', 'native', 'frames', 'off'];

function videoCacheDir() {
  return path.join(DATA_DIR, 'video-cache');
}

/**
 * 决定这次视频走哪条路。纯函数，方便测试与在 UI 里预览判定结果。
 *
 * @param {object} o
 *   mode       config.api.videoMode
 *   videoModel config.api.videoModel（非空 = 用户声明有全模态模型）
 *   framesOk   抽帧能力是否可用
 *   hasUrl     视频是否有可用的 http(s) 地址（native 需要）
 * @returns {{ route: 'native'|'frames'|'meta', reason: string }}
 */
export function resolveVideoRoute({ mode = 'auto', videoModel = '', framesOk = false, hasUrl = false } = {}) {
  const m = VIDEO_MODES.includes(String(mode)) ? String(mode) : 'auto';
  const omni = Boolean(String(videoModel || '').trim());

  if (m === 'off') return { route: 'meta', reason: 'videoMode=off：只读元信息，不喂画面' };

  if (m === 'native') {
    return hasUrl
      ? { route: 'native', reason: 'videoMode=native：按原生视频输入发送' }
      : { route: 'meta', reason: 'videoMode=native，但这条视频没有可用的 http(s) 地址' };
  }

  if (m === 'frames') {
    return framesOk
      ? { route: 'frames', reason: 'videoMode=frames：抽帧成图片' }
      : { route: 'meta', reason: 'videoMode=frames，但抽帧不可用（未见 ffmpeg 或 Skill 已关闭）' };
  }

  // auto：配了全模态模型就原生，否则抽帧，都不行只给元信息
  if (omni && hasUrl) return { route: 'native', reason: 'auto：已配置视频专用模型，按原生视频输入发送' };
  if (framesOk) return { route: 'frames', reason: 'auto：未配置视频专用模型，改用抽帧' };
  return { route: 'meta', reason: 'auto：既没有视频专用模型，抽帧也不可用，只读元信息' };
}

/**
 * stdout 累计上限。
 *
 * 当前 run() 只跑 `#ffprobe` 的 `-show_format -show_streams`（JSON 输出，
 * 实测几 KB ~ 上百 KB，理论上无上限）。
 * 逐块 `out += d` 有两个问题：① 无上限，异常输入（或将来换成更啰嗦的探针命令）
 * 能把内存吃满；② 字符串反复重拼接是 O(n²)，长输出时代价陡增。
 * 8MB 定得很宽松，明显高于任何真实 ffprobe 输出，只为把"无界"变成"有界"；
 * 真触到上限说明输入异常，截断后 JSON.parse 会失败并静默返回空元信息
 * （#ffprobe 的 catch 分支），不会把半截数据当正常结果用。
 */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** 调外部命令并收集 stdout（带超时）。 */
function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // 分块收集，最后只 join 一次（见 MAX_STDOUT_BYTES 注释的 O(n²) 说明）。
    // 另一个附带修正：逐块 `out += d` 会按 chunk 边界各自解码 UTF-8，
    // 一个多字节汉字正好被切成两半时会变成 U+FFFD；先拼 Buffer 再整体解码不会。
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (total >= MAX_STDOUT_BYTES) return;                 // 已到上限：不再累积（连接仍排空）
      const room = MAX_STDOUT_BYTES - total;
      if (d.length > room) {
        chunks.push(d.subarray(0, room));
        total = MAX_STDOUT_BYTES + d.length;                 // 置超，后续块直接丢
        return;
      }
      chunks.push(d);
      total += d.length;
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!chunks.length) return finish(null);
      finish(Buffer.concat(chunks).toString('utf8') || null);
    });
  });
}

/** 调外部命令，只看退出码（带超时）。转码这类"不关心 stdout"的命令用它。 */
function runExitOk(cmd, args, timeoutMs = 60000) {
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

/** 探测 ffprobe / ffmpeg 是否可用。
 *
 * 路径解析统一交给 ffmpeg-resolve.js。只查 PATH 的话，看不见随包那份、
 * 也看不见设置页下载的那份，于是同一个安装包里「图片压缩能用、视频元信息读不出」。
 * 缓存与重探口径也一并交给它（命中长期缓存、未命中 60 秒后重探）。
 */
async function ensureFf() {
  const r = await resolveFfmpeg();
  return { ffprobe: r.ffprobe, ffmpeg: r.ffmpeg };
}

export class VideoReader {
  constructor(onebot) {
    this.onebot = onebot;
  }

  /** 抽帧能力是否可用（Skill 生效 + ffmpeg 存在）。 */
  async framesAvailable() {
    // 统一问 video-frames 能力"这条路现在走得通吗"。
    // 不要在这里再探测一遍 ffmpeg：技能里已有一份判断，两份实现迟早不一致
    // （例如技能支持自定义 ffmpeg 路径，这里却不知道，于是界面说不可用、实际能用）。
    const providers = skillManager.getCapabilityProviders('video.frames.available', {});
    if (!providers.length) return false;   // 技能被关或没装，这条路不通
    for (const p of providers) {
      try {
        const r = await p.fn({});
        if (r?.ok === false) return false;
        if (r?.ok === true) return true;
      } catch { /* 探测异常按不可用处理 */ }
    }
    return false;
  }

  /** 当前配置下这条视频会走哪条路（UI 展示 / 排障用）。 */
  async describeRoute(media = {}) {
    const cfg = getConfig();
    const framesOk = await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    return resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
  }

  /**
   * 探测一个视频媒体（{ file, url, path }）的元信息，并按配置取回画面。
   *
   * @returns {Promise<{durationSec?, width?, height?, sizeBytes?, format?,
   *                    route: 'native'|'frames'|'meta', routeReason: string,
   *                    frames?: string[], frameTimes?: number[],
   *                    nativeUrl?: string, note: string}>}
   */
  async probe(media, { count = 0 } = {}) {
    const cfg = getConfig();
    const out = { note: '', route: 'meta', routeReason: '' };

    // 1. 拿到视频文件（本地缓存优先，其次下载 url）
    const filePath = await this.#localize(media).catch(() => null);
    const hasFile = Boolean(filePath && fs.existsSync(filePath));

    if (hasFile) {
      try {
        out.sizeBytes = fs.statSync(filePath).size;
      } catch { /* ignore */ }
      // 2. ffprobe 读元信息
      const { ffprobe } = await ensureFf();
      if (ffprobe) {
        const meta = await this.#ffprobe(ffprobe, filePath);
        Object.assign(out, meta);
      }
    }

    // 3. 决定路线（元信息拿到之后再决定，因为 native 需要 url、frames 需要文件）
    const framesOk = hasFile && await this.framesAvailable();
    const hasUrl = /^https?:\/\//i.test(String(media?.url || ''));
    const routeInfo = resolveVideoRoute({
      mode: cfg.api?.videoMode,
      videoModel: cfg.api?.videoModel,
      framesOk,
      hasUrl
    });
    out.route = routeInfo.route;
    out.routeReason = routeInfo.reason;

    // 4. 按路线取画面
    if (routeInfo.route === 'native') {
      // 用户定稿规则：视频输入开启时，所有视频转码成最高 480p/24fps 的 mp4
      // 再发给模型。原始视频可能是 1080p/60fps 的几十 MB 文件，直接喂会把
      // token 预算炸穿（甚至被网关拒收）。转码失败（没 ffmpeg / 超时 / 产出异常）
      // 回退原 URL，不阻塞看视频。
      if (cfg.api?.video === true) {
        const transcoded = hasFile ? await this.#transcodeToMax480(filePath).catch(() => null) : null;
        if (transcoded) {
          out.nativeUrl = transcoded;
          out.routeReason += '；已转码 ≤480p/24fps';
        } else {
          out.nativeUrl = String(media.url);
        }
      } else {
        out.nativeUrl = String(media.url);
      }
    } else if (routeInfo.route === 'frames') {
      const r = await this.#extractViaSkill(filePath, { count, durationSec: out.durationSec });
      if (r.frames.length) {
        out.frames = r.frames;
        out.frameTimes = r.times;
      } else {
        // 抽帧失败不当错误抛：退回元信息，并在 note 里说清
        out.route = 'meta';
        out.routeReason = `${routeInfo.reason}；但抽帧未成功：${r.error || '未知原因'}`;
      }
    }

    out.note = this.#buildNote(out, { hasFile });
    return out;
  }

  /** 说明文案：让模型知道它拿到的是什么形式的内容。 */
  #buildNote(out, { hasFile }) {
    if (!hasFile) {
      return '无法获取视频文件（OneBot 无缓存且 url 下载失败）。只能告诉你这条消息带了一个视频。';
    }
    const bits = [];
    if (out.durationSec) bits.push(`时长 ${out.durationSec.toFixed(1)} 秒`);
    if (out.width && out.height) bits.push(`${out.width}×${out.height}`);
    if (out.sizeBytes) bits.push(`${(out.sizeBytes / 1024 / 1024).toFixed(1)}MB`);
    const head = bits.length ? `视频信息：${bits.join('，')}。` : '已获取视频文件，但读不到详细元信息（未安装 ffprobe）。';

    if (out.route === 'native') {
      return `${head}画面已作为**视频**发给多模态模型（原生视频输入）。`;
    }
    if (out.route === 'frames' && out.frames?.length) {
      return `${head}已从中抽取 ${out.frames.length} 张画面截图供你查看。注意这是截图不是连续视频，帧与帧之间的过程你看不到。`;
    }
    if (out.route === 'meta') {
      const why = out.routeReason || '当前配置不喂画面';
      return `${head}本次不提供画面（${why}）。`;
    }
    return head;
  }

  /** 通过 video.frames 能力抽帧；能力不在（Skill 被关）时返回空。 */
  async #extractViaSkill(filePath, { count = 0, durationSec = 0 } = {}) {
    const providers = skillManager.getCapabilityProviders('video.frames', {});
    if (!providers.length) return { frames: [], times: [], error: '抽帧 Skill 未启用' };
    for (const p of providers) {
      try {
        const r = await p.fn({ filePath, count: count || undefined, durationSec });
        if (r && Array.isArray(r.frames) && r.frames.length) {
          return { frames: r.frames, times: r.times || [] };
        }
        if (r?.error) return { frames: [], times: [], error: r.error };
      } catch (error) {
        return { frames: [], times: [], error: error?.message ?? String(error) };
      }
    }
    return { frames: [], times: [], error: '抽帧没有产出画面' };
  }

  /**
   * 转码到模型友好规格：最长边 ≤480px、24fps、H.264+yuv420p、faststart。
   * 返回 data:video/mp4;base64 URL；失败返回 null（调用方回退原 URL）。
   * 与 gif-to-video 的转换互不复用：那边处理的是 GIF 的帧采样防炸弹，
   * 这边处理的是常规视频的降规格，参数与护栏各不相同。
   */
  async #transcodeToMax480(filePath) {
    const { ffmpeg } = await ensureFf();
    if (!ffmpeg) return null;
    const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpOut = path.join(os.tmpdir(), `qqa_vt_${stamp}.mp4`);
    try {
      // 产物大小护栏：≤480p/24fps 的短视频通常 <10MB；20MB 上限给长视频留余地，
      // 超过说明源异常长，喂模型不划算（元信息里有时长，模型自己判断要不要看）。
      const okRun = await runExitOk(ffmpeg, [
        '-y',
        '-i', filePath,
        // force_divisible_by=2：yuv420p/libx264 只吃偶数宽高，奇数尺寸源（部分
        // 手机竖拍视频）会直接 "Error while opening encoder" 转码失败（见 gif-to-video 同款注释）
        '-vf', "scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
        '-an',                       // 聊天视频的画面理解不需要音轨
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-fs', '20M',
        tmpOut
      ], 120000);
      if (!okRun || !fs.existsSync(tmpOut)) return null;
      const out = fs.readFileSync(tmpOut);
      if (!out.length || out.length > 20 * 1024 * 1024) return null;
      return `data:video/mp4;base64,${out.toString('base64')}`;
    } catch {
      return null;
    } finally {
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    }
  }

  /** 把视频落地为本地文件路径（OneBot 缓存 → 下载 url）。 */
  async #localize(media) {
    // 路径 0：消息里直接给了本地 path
    // media.path 是消息段转述的字段，`existsSync 成立就采用` 等于"消息里写什么路径
    // 就读什么文件"。现在只放行我们自己写下的视频缓存（归属 + realpath + 命名规则，
    // 见 media-path.js）；协议端缓存走下面的路径 1（get_video/get_file 的返回值），
    // 那条不是消息可控的。
    if (media.path) {
      const gate = resolveCachedMediaPath(media.path, { kind: 'video' });
      if (gate.ok) return gate.path;
    }
    // 路径 1：OneBot get_video / get_file 拿缓存
    if (media.file) {
      for (const action of ['get_video', 'get_file', 'get_image']) {
        try {
          const ret = await this.onebot.call(action, { file: String(media.file) });
          const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
          if (p) return p;
          if (ret?.url) {
            const dl = await this.#download(String(ret.url));
            if (dl) return dl;
          }
        } catch { /* 尝试下一个 action */ }
      }
    }
    // 路径 2：直接下载 url
    if (media.url) {
      const dl = await this.#download(String(media.url));
      if (dl) return dl;
    }
    throw new Error('无法获取视频文件');
  }

  /**
   * video-cache 清理（修磁盘无界增长）。
   *
   * 只写不清的后果：`#download` 每次落地一个带随机后缀的新文件（同 URL 重复
   * probe = 多份副本），全 src 没有任何 unlink/prune 路径，data/video-cache
   * 单调增，单文件上限 200MB，用户形态是"data 目录几天几个 GB"。
   *
   * 现在三道闸：
   *   ① 文件名按 URL 哈希（`#download`），同一视频重复 probe 复用同一副本；
   *   ② TTL 24 小时：超过即删（看视频是一次性消费，很少有人反复回看同一段）；
   *   ③ 总量 2GB：超出按最旧优先淘汰。
   * 频率控制：probe 是热路径，最多每 10 分钟扫一次盘。
   */
  #pruneVideoCache() {
    const now = Date.now();
    if (now - (this._lastCachePruneAt || 0) < 10 * 60 * 1000) return;
    this._lastCachePruneAt = now;
    const dir = videoCacheDir();
    const TTL_MS = 24 * 3600 * 1000;
    const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
    try {
      const entries = [];
      for (const name of fs.readdirSync(dir)) {
        // 只清理本模块命名的副本（v_<16位哈希>.mp4），别碰用户可能放在别处的文件
        if (!/^v_[0-9a-f]{16}\.mp4$/.test(name)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          entries.push({ fp: path.join(dir, name), size: st.size, mtime: st.mtimeMs });
        } catch { /* 读盘间隙文件没了，跳过 */ }
      }
      let total = entries.reduce((n, e) => n + e.size, 0);
      entries.sort((a, b) => a.mtime - b.mtime);   // 最旧优先淘汰
      for (const e of entries) {
        if (now - e.mtime <= TTL_MS && total <= MAX_TOTAL_BYTES) break;
        try { fs.unlinkSync(e.fp); total -= e.size; } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响下载（目录不存在等） */ }
  }

  async #download(url, timeoutMs = 30000) {
    try {
      // 走 safe-fetch：url 来自 OneBot 媒体段（发送方可影响），裸 fetch 会变成 SSRF 通道。
      // 流式落盘（safeFetchBinaryToFile）：整读 200MB 进内存再写盘，多视频并发
      // 时进程直接被顶爆；边收边写盘后内存占用与视频大小无关。
      const maxBytes = 200 * 1024 * 1024;   // 视频上限 200MB
      fs.mkdirSync(videoCacheDir(), { recursive: true });
      this.#pruneVideoCache();
      // 文件名按 URL 哈希：同一视频重复 probe 复用同一副本，
      // 先写 .part 再 rename，并发 probe 同一 URL 时不会互相写半截
      // （safeFetchBinaryToFile 失败时自己删半截文件，这里兜底 rename 前的残留）。
      const key = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
      const dest = path.join(videoCacheDir(), `v_${key}.mp4`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
      const part = `${dest}.${process.pid}.${Date.now().toString(36)}.part`;
      try {
        // 超限/截断语义与旧实现一致：safeFetchBinaryToFile 在累计字节到达 maxBytes
        // 时删掉半截文件并抛错（残缺的 mp4 没法抽帧，不能让 ffprobe 报误导性元信息），
        // 这里接住异常返回 null，让上层按"拿不到文件"降级。
        await safeFetchBinaryToFile(String(url), part, maxBytes, { timeoutMs });
        fs.renameSync(part, dest);
      } catch (error) {
        try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* ignore */ }
        throw error;
      }
      return dest;
    } catch {
      return null;
    }
  }

  async #ffprobe(ffprobe, filePath) {
    const out = {};
    const txt = await run(ffprobe, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], 15000);
    if (!txt) return out;
    try {
      const j = JSON.parse(txt);
      const vstream = (j.streams || []).find((s) => s.codec_type === 'video');
      if (vstream) {
        if (vstream.width) out.width = Number(vstream.width);
        if (vstream.height) out.height = Number(vstream.height);
      }
      if (j.format) {
        if (j.format.duration) out.durationSec = Number(j.format.duration);
        if (j.format.format_name) out.format = String(j.format.format_name);
        if (j.format.size) out.sizeBytes = Number(j.format.size);
      }
    } catch { /* 解析失败就返回空 */ }
    return out;
  }
}
