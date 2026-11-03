// 外部依赖检测：ffmpeg（≥5，ddagrab 需要）与 Wallpaper Engine。
// 移植自 zcode-beautify（MIT）并按本项目情况改造：
//   - WE 复用插件自己的 resolveWeDir（注册表 + 常见路径），不重复造；
//   - ffmpeg 路径解析统一交给 src/ffmpeg-resolve.js（2026-11-03 起）：那份
//     覆盖「手填 > 环境变量 > 设置页下载的 > 旧随包 > PATH/注册表/WinGet」，
//     本模块只保留**版本下限判定**与给用户看的安装引导文案。
// 检测永不抛错：缺工具返回 { ok:false, detail } 供 UI 引导。
import { execFileP } from './exec.js';
import { resolveFfmpeg } from '../../ffmpeg-resolve.js';

const MIN_FFMPEG_MAJOR = 5;

/**
 * 找 ffmpeg。路径解析由 src/ffmpeg-resolve.js 统一负责（手填 > QQ_AGENT_FFMPEG >
 * 设置页下载的 > 旧随包 > PATH > 注册表现读 > WinGet Links > winget 包目录扫盘），
 * 这里只做本模块特有的**版本下限判定**（ddagrab 需要 ≥5）与安装引导文案。
 */
export async function checkFfmpeg() {
  // 动态壁纸录制是**平台本身**不可用，不是依赖没装：ddagrab 是 D3D11 桌面
  // 抓屏滤镜，Wallpaper Engine 也只有 Windows 版。macOS / Linux 上无论装
  // 多少份 ffmpeg 都录不出来，所以必须给独立原因码，混进 'missing' 会把
  // 用户引去装一个装了也没用的 ffmpeg，最后仍然在 recordSceneWindow 撞上
  // "No such filter: ddagrab"。
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      detail: '动态壁纸录制依赖 Windows 的 ddagrab 桌面抓取与 Wallpaper Engine，macOS / Linux 上不可用。'
    };
  }
  const r = await resolveFfmpeg();
  if (!r.ok) {
    return {
      ok: false,
      // 结构化标记：前端据此决定是"弹一段长文案"还是"直接把用户送去安装"。
      // 靠正则匹配 detail 的措辞太脆，改一句话就断。
      reason: 'missing',
      detail: '这台电脑还没装 ffmpeg（转动态壁纸要用它录制/转码；只需装一次，不影响壁纸系统的其它功能）。\n\n'
        + '最简单的装法（约 1 分钟）：点下面的「去安装」，在「设置 → 媒体工具」里点「下载并安装」—— '
        + '会自动下载到数据目录，装完不用重启 QQ Agent。\n\n'
        + '也可以自己装：按 Win 键，输入 powershell，回车后粘贴 `winget install Gyan.FFmpeg`。\n'
        + '如果装完还是提示没找到，让帮你装的人设置环境变量 QQ_AGENT_FFMPEG 指向 ffmpeg.exe 的完整路径。'
    };
  }
  if (r.major < MIN_FFMPEG_MAJOR) {
    return {
      ok: false,
      path: r.ffmpeg,
      reason: 'outdated',
      detail: `ffmpeg ${r.version} 版本过旧，ddagrab 需要 ≥ ${MIN_FFMPEG_MAJOR}.0。`
        + '可在「设置 → 媒体工具」下载新版本，或运行 `winget upgrade Gyan.FFmpeg`。'
    };
  }
  return { ok: true, path: r.ffmpeg, detail: `ffmpeg ${r.version}` };
}

// ── 硬件视频编码器探测（NVENC > AMF > libx264）─────────────────────────
// 导入/录制是无缝循环的编码环节：libx264 软编码在弱 CPU 机器上要跑满核
// 好几分钟；N 卡 NVENC / A 卡 AMF 硬编码几十秒完事且几乎不占 CPU。
// 探测用「真编三帧」而不是查 -encoders 列表，列表里有 ≠ 驱动能用。
// 结果按进程缓存（每次探测要拉起一次 ffmpeg + 初始化 GPU 编码会话）。
let hwEncoderCache = null;
export async function resolveHwEncoder(ffmpegPath) {
  if (hwEncoderCache) return hwEncoderCache;
  const candidates = [
    { codec: 'h264_nvenc', extra: ['-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0'], label: 'NVIDIA NVENC' },
    { codec: 'h264_amf', extra: ['-quality', 'quality', '-b:v', '20M'], label: 'AMD AMF' },
    { codec: 'libx264', extra: ['-preset', 'veryfast', '-crf', '18'], label: 'CPU libx264' }
  ];
  for (const c of candidates) {
    try {
      await execFileP(ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2',
        '-frames:v', '3', '-c:v', c.codec, ...c.extra,
        '-f', 'null', '-'
      ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      hwEncoderCache = { ...c };
      break;
    } catch { /* 驱动不支持/编码器不存在：试下一个 */ }
  }
  if (!hwEncoderCache) hwEncoderCache = { codec: 'libx264', extra: ['-preset', 'veryfast', '-crf', '18'], label: 'CPU libx264' };
  return hwEncoderCache;
}
