// ffmpeg 路径解析：**全项目唯一的入口**。
//
// ── 为什么要有这个模块 ────────────────────────────────────────────────
// 此前有 5 处各自探测 ffmpeg，顺序还不一致：
//   · image-compress / gif-to-video / video-frames → 先随包、再 PATH
//   · video-reader                                 → 只查 PATH（看不见随包那份）
//   · wallpaper/lib/deps                           → env / PATH / 注册表 / WinGet 扫盘
// 后果是 CHANGELOG 里反复出现的「包里明明有 ffmpeg，却报未找到」：
// 同一个安装包，图片压缩能用、视频抽帧不能用。
//
// 现在统一成一条链（见 resolveFfmpeg 的注释），各处只保留自己的**超时与缓存
// 口径**——那是调用方的事，不是路径解析的事。
//
// ── 用户可以选「用哪一份」（2026-11-03）───────────────────────────────
// 链的顺序不再是硬编码的：设置页可以把 manual / managed / system 任一组
// 整体提到最前（config.media.ffmpegSource）。切的是**组**，组内顺序固定，
// 其余组按默认顺序继续作为兜底。这样系统里已经装过 ffmpeg 的用户不必再下
// 一份，想用下载的那份也随时切得回来。
//
// ── 随包 ffmpeg 已下线（2026-11-03）───────────────────────────────────
// 79MB 的 runtime/ffmpeg.exe 不再随安装包分发，改为设置页「媒体工具」按需
// 下载到 DATA_DIR/runtime/ffmpeg/bin/。旧安装升级后若 runtime/ 里还有那份，
// 解析链第 4 位仍然命中 —— 老用户功能不中断，也不用重下。
//
// ── ffprobe 一律从 ffmpeg 同目录推导 ──────────────────────────────────
// 以前 gif-to-video / video-reader 直接 spawn 裸名 'ffprobe'：ffmpeg 在
// 非 PATH 目录（随包 / 下载 / 手填）时，明明同目录就躺着 ffprobe.exe，却
// 找不到，只能退化到「解析 ffmpeg -i 的 stderr」——精度和健壮性都差一截。
// 现在 ffprobeFor() 从 ffmpeg 路径推同目录的 ffprobe，找不到才返回 null。
//
// ── 全平台资产（2026-11-03）──────────────────────────────────────────
// 三平台分三种策略，FFMPEG_ASSETS 也按平台分组：
//
//   Windows  程序内下载（GyanD/codexffmpeg 的 essentials_build）。原样保留：
//            这台机器上没有可依赖的包管理器，按需下载是唯一不要求用户先
//            配环境的路径。
//   Linux    程序内下载（martin-riedl 的静态包）。服务器与容器里经常没有
//            包管理器的写权限（或根本没有包管理器），此时"给条 apt 命令"
//            等于让用户去改宿主机，程序内下载才是唯一能自己解决的路。
//   macOS    **不**做程序内下载，只给 Homebrew 命令。原因不是"懒"：
//            Homebrew 的 ffmpeg bottle 是动态链接的，依赖 7 个 libav*.dylib
//            与 11 个 formula，无法塞进单个可执行文件；而唯一可行的第三方
//            静态包又与"用 brew 的源"这个决定相悖 —— 留着它就会同时存在
//            两条互不兼容的升级路径（brew upgrade 升不到下载的那份，
//            下载的那份也不会被 brew 感知），用户无从判断自己用的是哪套。
//            与其造一个会分叉的安装方式，不如把 macOS 交给它事实上的包管理器。
//
// Linux 为什么选 riedl 而不是 johnvansickle：后者停在 7.0.2，且发布页只给
// md5 —— 与本模块"装上的东西一定是验证过的"这条前提冲突（md5 可碰撞，
// 且无法与上游 digest 对齐）。riedl 是 9.0.2，与 Windows 那份同版本，
// 且每个包都提供 sha256。
//
// ⚠️ 已知取舍：riedl 的 Linux 包是**动态链接**的，需要 glibc ≥ 2.22。
//    CentOS 7 这类老系统（glibc 2.17）装了也跑不起来。这是有意的取舍 ——
//    为了拿到 sha256 可验证的现成包，放弃对已停止维护的老发行版的支持；
//    这些系统上用户可以改用发行版自带的 ffmpeg（解析链会先看系统那份）。
//
// 注意：程序内下载**只在 canAutoInstall() 为真的平台**上开放。macOS 上
// platformAssets() 返回 null，调用方据此隐藏下载入口、改展示 installGuideFor()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, getConfig } from './config.js';

/**
 * 程序内下载的 ffmpeg 版本。**升级时必须同步改 FFMPEG_ASSETS 里的 sha256 与字节数**。
 *
 * 校验值写死在代码里而不是每次问上游 API，是为了让「装上的东西一定是
 * 我们验证过的」成为一条不依赖网络与限流的性质：API 挂掉、Token 过期、
 * 镜像站被投毒，都拦不住下载，但改不了这里的一个字节。
 *
 * Windows 与 Linux 两份资产都是 9.0.2，版本号因此只有一个来源。
 */
export const FFMPEG_VERSION = '9.0.2';

/**
 * 按平台分组的下载资产。
 *
 * win32：两个发布包（7z 优先，zip 兜底），sha256 取自 GitHub Release API 的
 *        digest 字段。字段形态 `{ name, sha256, bytes }`。
 * linux：ffmpeg 与 ffprobe 是**两个独立 zip**，按架构分目录，字段形态
 *        `{ url, sha256, bytes }`。URL 里的时间戳目录是站点构建 ID，没有稳定
 *        别名，所以整条 URL 写死；sha256 与字节数均为逐包实测值，改动前必须
 *        重新下载核对。
 *
 * darwin 刻意不在表里：它的 ffmpeg 由 Homebrew 提供，见文件头说明。
 */
export const FFMPEG_ASSETS = {
  win32: {
    '7z': {
      name: `ffmpeg-${FFMPEG_VERSION}-essentials_build.7z`,
      sha256: '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077',
      bytes: 35430500
    },
    zip: {
      name: `ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
      sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
      bytes: 114768076
    }
  },
  linux: {
    x64: {
      ffmpeg: {
        url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1789931100_9.0.2/ffmpeg.zip',
        sha256: 'fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f',
        bytes: 33326445
      },
      ffprobe: {
        url: 'https://ffmpeg.martin-riedl.de/download/linux/amd64/1789931100_9.0.2/ffprobe.zip',
        sha256: '3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32',
        bytes: 33223234
      }
    },
    arm64: {
      ffmpeg: {
        url: 'https://ffmpeg.martin-riedl.de/download/linux/arm64/1789931697_9.0.2/ffmpeg.zip',
        sha256: '93a76ae90db5474eecdf951a729857c64f3de23567228d6a7d5e6e8e3cd1021b',
        bytes: 28753826
      },
      ffprobe: {
        url: 'https://ffmpeg.martin-riedl.de/download/linux/arm64/1789931697_9.0.2/ffprobe.zip',
        sha256: 'bcbe80fb741c180083327afaf5434812e006b33cacde2016b9aeaf6936128330',
        bytes: 28655683
      }
    }
  }
};

/**
 * 当前平台能不能程序内下载。macOS 一律 false —— 它的 ffmpeg 由 Homebrew 提供。
 *
 * 用函数而不是让调用方读 FFMPEG_ASSETS：调用方要回答的是"能不能点这个按钮"，
 * 而资产表的结构在 win32（按格式）与 linux（按架构）之间并不一致，让 UI
 * 去理解两种形态只会把平台差异泄漏到界面层。
 */
export function canAutoInstall(platform = process.platform) {
  return platform === 'win32' || platform === 'linux';
}

/**
 * 取当前平台的资产组；不支持平台返回 null。
 *
 * win32 返回 `{ '7z': {...}, zip: {...} }`，linux 返回 `{ ffmpeg: {...}, ffprobe: {...} }`。
 * 两种形态由 ffmpeg-setup 各自消费，这里不做归一化 —— 归一化会丢掉
 * 「Windows 的 7z/zip 是同一份内容的不同压缩格式」与「Linux 的 ffmpeg/ffprobe
 * 是两个独立文件」这个本质区别。
 */
export function platformAssets(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return FFMPEG_ASSETS.win32;
  if (platform === 'linux') return FFMPEG_ASSETS.linux[arch] || null;
  return null;
}

/** Homebrew 官方安装脚本地址。写死常量，避免在返回结构里散落长字符串。 */
const HOMEBREW_INSTALL_CMD = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/**
 * 包管理器安装命令。Windows 返回 null（它走程序内下载）。
 *
 * 这里只返回数据、不执行：安装系统包需要 sudo 与用户确认，替用户跑
 * `sudo apt install` 既越权，也会让"点了没反应"变成一个需要排查的问题。
 * 界面负责把命令展示成可复制的形式。
 *
 * @returns {null | { kind:'command', primary?:{label:string,cmd:string},
 *                    fallback?:{label:string,cmd:string}, notes?:string[],
 *                    distros?:Array<{id:string,label:string,cmd:string,note:string}> }}
 */
export function installGuideFor(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    const guide = {
      kind: 'command',
      primary: { label: 'Homebrew（推荐）', cmd: 'brew install ffmpeg' },
      fallback: { label: '还没装 Homebrew 的话先装它', cmd: HOMEBREW_INSTALL_CMD },
      notes: []
    };
    // Intel Mac 没有官方 ffmpeg bottle，brew 会回落到源码编译 —— 这一步
    // 需要 Xcode 命令行工具，且耗时以十分钟计。提前说明，免得用户以为卡死。
    if (arch === 'x64') {
      guide.notes.push('Intel Mac 上 Homebrew 会从源码编译 ffmpeg，需先执行 xcode-select --install，耗时约十几分钟');
    }
    return guide;
  }
  if (platform === 'linux') {
    return {
      kind: 'command',
      distros: [
        { id: 'debian', label: 'Debian / Ubuntu', cmd: 'sudo apt install ffmpeg', note: '' },
        // Fedora 默认源不含 ffmpeg（专利考虑），必须先启用 RPM Fusion。
        { id: 'fedora', label: 'Fedora', cmd: 'sudo dnf install ffmpeg', note: '需先启用 RPM Fusion 源' },
        { id: 'arch', label: 'Arch / Manjaro', cmd: 'sudo pacman -S ffmpeg', note: '' },
        // openSUSE 的官方 ffmpeg 功能受限，完整编解码器在 Packman 源里。
        { id: 'suse', label: 'openSUSE', cmd: 'sudo zypper install ffmpeg', note: '需先启用 Packman 源' }
      ]
    };
  }
  return null;
}

/** 下载落地目录（`data/runtime/ffmpeg/bin/`）。下载安装只往这里写。 */
export function managedBinDir() {
  return path.join(DATA_DIR, 'runtime', 'ffmpeg', 'bin');
}

/** 旧随包目录（`<app>/runtime/`）。仅作兼容候选，不再往里写。 */
export function bundledBinDir() {
  return path.join(ROOT, 'runtime');
}

/** 平台可执行文件名。 */
export function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

/**
 * 由 ffmpeg 路径推出同目录的 ffprobe。
 * 裸名（PATH 解析，如 'ffmpeg'）→ 返回裸名 'ffprobe'，交给 PATH 自己找。
 * 绝对路径 → 只在同目录且文件存在时返回，否则 null（调用方退回 ffmpeg -i 兜底）。
 */
export function ffprobeFor(ffmpegPath) {
  const p = String(ffmpegPath || '');
  if (!p) return null;
  const dir = path.dirname(p);
  if (!dir || dir === '.' || dir === p) return exeName('ffprobe');
  const cand = path.join(dir, exeName('ffprobe'));
  try { return fs.statSync(cand).isFile() ? cand : null; } catch { return null; }
}

/**
 * ffprobe 兜底：同目录没有就再问 PATH。
 *
 * 真实场景里很常见：用户把 ffmpeg.exe 单独拷进某个目录（旧随包那份就是只有
 * ffmpeg、没有 ffprobe），而系统里另外装着完整的 ffmpeg+ffprobe。这时
 * ffprobeFor() 返回 null，但 PATH 里那份仍然可用 —— 用它比退回
 * 「解析 ffmpeg -i 的 stderr」准得多。
 */
async function ffprobeFallback(ffmpegPath) {
  const same = ffprobeFor(ffmpegPath);
  if (same) return same;
  const name = exeName('ffprobe');
  for (const p of await whereExecutable(name)) {
    if (isFile(p)) return p;
  }
  // 裸名交给 spawn 的 PATH 解析；真没有时调用方会自己退回 ffmpeg -i 兜底
  return name;
}

// ── 子进程 ──────────────────────────────────────────────────────────────

/** 跑一条命令并收集 stdout；失败/超时返回 ''。 */
function runStdout(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { return finish(''); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(out); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

/**
 * 从 `ffmpeg -version` 的输出里解析版本。纯函数，便于单测。
 *
 * 官方构建形如 `9.0.2-essentials_build-www.gyan.dev`；
 * git 构建形如 `n7.1-dev`（主版本仍可解析，取 7）或 `N-116000-g…`
 * （纯提交号，没有可靠主版本 → 按最新算，返回 MAX_SAFE_INTEGER）。
 * 后者不能当成 0，否则会被「版本过旧」误判拦下。
 *
 * @returns {{ raw: string, major: number } | null} 认不出返回 null
 */
export function parseFfmpegVersion(text) {
  const m = /ffmpeg version (\S+)/.exec(String(text || ''));
  if (!m) return null;
  const raw = m[1];
  const numeric = raw.replace(/^[nN]/, '').match(/^(\d+)/);
  return { raw, major: numeric ? Number(numeric[1]) : Number.MAX_SAFE_INTEGER };
}

/**
 * 验证一个 ffmpeg 可执行文件，返回 { ok, raw, major }。
 * 用真跑 `-version` 而不是「文件存在」——存在但架构不对 / 缺 DLL 的情况
 * 在 Windows 上很常见，光看路径会把它当成可用。
 */
export async function probeFfmpeg(exe, timeoutMs = 8000) {
  const out = await runStdout(exe, ['-version'], timeoutMs);
  const v = parseFfmpegVersion(out);
  return v ? { ok: true, ...v } : { ok: false, raw: '', major: 0 };
}

/**
 * 本应用实际依赖的 ffmpeg 能力。**探测它们的理由**：`-version` 能跑不代表
 * 功能能用 —— 精简构建可能不带 libx264、不带某些滤镜，或者装的是个残缺
 * 二进制。用户看到的是"装了 ffmpeg 但转 GIF 报错 / 压图失败"，而状态栏
 * 仍然显示"已安装"，非常难自查。
 *
 * 这里只查两项，因为它们是四条功能共同的硬依赖：
 *   · libx264   —— GIF 转视频、视频抽帧都指定 `-c:v libx264`
 *   · scale     —— 所有转码路径都用 `-vf scale=...` 缩放
 * 不查 ddagrab：那是动态壁纸专有的，且 Windows 专用，由 wallpaper 模块
 * 自己按版本下限判定。
 */
export const FFMPEG_REQUIRED_ENCODERS = Object.freeze(['libx264']);
export const FFMPEG_REQUIRED_FILTERS = Object.freeze(['scale']);

/**
 * 体检一个 ffmpeg 是否满足本应用的需求。
 *
 * 返回 { ok, problems: [{ kind, detail }] }。problems 为空即健康；
 * 非空时每一项都是可操作的（缺什么、意味着哪条功能不可用）。
 *
 * 为什么单独一个函数、而不是塞进 probeFfmpeg：`-version` 是**每次解析都要跑**
 * 的热路径，而这里是三条 `-encoders` / `-filters` 级别的查询，慢一个数量级。
 * 只有用户在设置页看状态、或某条功能失败时，才值得付这份代价。
 */
export async function checkFfmpegCapabilities(exe, { timeoutMs = 8000 } = {}) {
  const problems = [];
  if (!exe) return { ok: false, problems: [{ kind: 'missing', detail: '没有可用的 ffmpeg' }] };

  const encoders = await runStdout(exe, ['-hide_banner', '-encoders'], timeoutMs);
  if (!encoders) {
    // 连 -encoders 都吐不出东西，通常是二进制残缺或架构不对
    return { ok: false, problems: [{ kind: 'broken', detail: 'ffmpeg 无法列出编码器（安装可能不完整）' }] };
  }
  for (const enc of FFMPEG_REQUIRED_ENCODERS) {
    // 编码器列表形如 ` V....D libx264   H.264 / AVC ...`
    if (!new RegExp(`\\b${enc}\\b`).test(encoders)) {
      problems.push({ kind: 'encoder', detail: `缺少编码器 ${enc}` });
    }
  }

  const filters = await runStdout(exe, ['-hide_banner', '-filters'], timeoutMs);
  if (filters) {
    for (const f of FFMPEG_REQUIRED_FILTERS) {
      if (!new RegExp(`\\b${f}\\b`).test(filters)) {
        problems.push({ kind: 'filter', detail: `缺少滤镜 ${f}` });
      }
    }
  }
  // -filters 失败不单独判 broken：老版本可能有兼容问题，但编码器在就仍能用大部分功能。

  return { ok: problems.length === 0, problems };
}

// ── PATH / 注册表 / WinGet 探测（Windows）────────────────────────────────

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** winget 按用户装包的默认落点（Gyan.FFmpeg 解压后 bin 里有 ffmpeg/ffprobe）。 */
function wingetFfmpegCandidates() {
  const out = [];
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
    'C:\\ProgramData\\winget\\Packages',
    'C:\\Program Files\\WinGet\\Packages'
  ];
  for (const root of roots) {
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^Gyan\.FFmpeg/i.test(d.name)) continue;
      // 包内还有一层 ffmpeg-<ver>-<build>/bin
      const pkgDir = path.join(root, d.name);
      let inner;
      try { inner = fs.readdirSync(pkgDir, { withFileTypes: true }); } catch { continue; }
      for (const sub of inner) {
        if (!sub.isDirectory()) continue;
        const bin = path.join(pkgDir, sub.name, 'bin', exeName('ffmpeg'));
        if (isFile(bin)) out.push(bin);
      }
    }
  }
  return out;
}

/** winget 的 Links 垫片目录：装便携包时把 ffmpeg.exe 放这里并写进用户 PATH。 */
function wingetLinksCandidates() {
  if (process.platform !== 'win32') return [];
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exeName('ffmpeg')),
    `C:\\Program Files\\WinGet\\Links\\${exeName('ffmpeg')}`
  ].filter(isFile);
}

/**
 * 从注册表现读用户/系统 PATH。
 *
 * 为什么必须现读：常驻进程的 process.env.PATH 是启动时的旧快照，用户中途
 * winget 装完 ffmpeg 后进程里看不到 —— 不现读就只能重启才生效。
 * reg query 对 REG_EXPAND_SZ 给的是未展开原值，这里手动展开常见变量。
 */
async function registryPathFfmpeg() {
  if (process.platform !== 'win32') return [];
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
  ];
  const found = [];
  const expand = (v) => v
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%LOCALAPPDATA%/gi, path.join(os.homedir(), 'AppData', 'Local'))
    .replace(/%APPDATA%/gi, path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%ProgramFiles\(X86\)%/gi, 'C:\\Program Files (x86)')
    .replace(/%ProgramW6432%/gi, 'C:\\Program Files')
    .replace(/%ProgramFiles%/gi, 'C:\\Program Files')
    .replace(/%SystemRoot%/gi, process.env.SystemRoot || 'C:\\Windows');
  for (const key of keys) {
    const out = await runStdout('reg', ['query', key, '/v', 'Path'], 5000);
    const m = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/.exec(out);
    if (!m) continue;
    for (let raw of m[1].split(';')) {
      raw = expand(String(raw).trim().replace(/^"|"$/g, ''));
      if (!raw || raw.includes('%')) continue;   // 展不开的变量：跳过该目录
      const exe = path.join(raw.replace(/[\\/]+$/, ''), exeName('ffmpeg'));
      if (isFile(exe) && !found.includes(exe)) found.push(exe);
    }
  }
  return found;
}

async function whereExecutable(name) {
  if (process.platform !== 'win32') return [];
  const out = await runStdout('where', [name], 5000);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ── 解析 ────────────────────────────────────────────────────────────────

/**
 * 候选来源分组。**用户的「优先使用」只能在这几组之间切换**，组内顺序固定。
 *
 * 为什么分组而不是让用户给具体路径排序：用户真正想选的是「用哪一份」，
 * 而不是「PATH 和注册表谁先」。分组后偏好有稳定语义，设置页也不必存
 * 一堆易失的绝对路径。
 */
export const FFMPEG_SOURCES = Object.freeze({
  MANUAL: 'manual',     // 用户手填的路径
  MANAGED: 'managed',   // 设置页「下载并安装」的落点
  SYSTEM: 'system'      // 系统里自己装的（PATH / 注册表 / WinGet）
});

/** 未设置偏好时的默认顺序，与历史行为一致（手填 > 下载的 > 系统的）。 */
export const FFMPEG_SOURCE_ORDER = Object.freeze([
  FFMPEG_SOURCES.MANUAL,
  FFMPEG_SOURCES.MANAGED,
  FFMPEG_SOURCES.SYSTEM
]);

/** 把配置值归一成三组之一；认不出来返回 ''（= 用默认顺序）。 */
export function normalizeSourcePreference(raw) {
  const v = String(raw || '').trim();
  return FFMPEG_SOURCE_ORDER.includes(v) ? v : '';
}

/**
 * 候选列表，按优先级排列。**顺序即语义**，改之前先想清楚会不会让用户
 * 手动指定的路径失效。
 *
 *   ① config.media.ffmpegPath   用户手填（设置页「媒体工具」）—— 最高优先级，
 *                               用户明确指定就该赢过一切自动探测
 *   ② QQ_AGENT_FFMPEG           环境变量（wallpaper 一直用这个口径，保留）
 *   ③ DATA_DIR/runtime/ffmpeg/bin   设置页下载的落点
 *   ④ <app>/runtime/ffmpeg      旧随包位置（老安装升级后仍命中）
 *   ⑤ PATH（where + 进程 PATH）
 *   ⑥ 注册表现读 PATH            winget 装完不重启也能认
 *   ⑦ WinGet Links 垫片 / 包目录扫盘
 *
 * config.media.ffmpegSource 把某一组整体提到最前。提的是**组**不是具体路径：
 * 组内顺序仍固定，手填的路径也不会因为切到 system 就被丢掉 —— 它只是退到
 * 该组之后继续当兜底。
 */
async function buildCandidates() {
  const groups = await buildCandidatesByGroup();

  let preferred = '';
  try { preferred = normalizeSourcePreference(getConfig()?.media?.ffmpegSource); } catch { /* 配置未就绪 */ }
  const order = preferred
    ? [preferred, ...FFMPEG_SOURCE_ORDER.filter((g) => g !== preferred)]
    : FFMPEG_SOURCE_ORDER;

  const out = [];
  for (const group of order) {
    for (const p of groups[group]) if (!out.includes(p)) out.push(p);
  }
  return out;
}

let _cache = null;          // { at, entry, result }
let _inflight = null;
const RETRY_MS = 60000;

/** 当前配置里影响解析结果的键。变化即视为缓存失效。 */
function cacheKey() {
  try {
    const m = getConfig()?.media || {};
    return `${m.ffmpegPath || ''}\u0000${m.ffmpegSource || ''}`;
  } catch { return ''; }
}

/**
 * 解析当前可用的 ffmpeg。
 *
 * 缓存口径与项目里其它探测器一致：**命中长期缓存；没找到 60 秒后允许重探**
 * ——用户中途装好 / 下载完成不用重启进程。并发调用共享同一次探测。
 *
 * 除了时间，缓存还绑着「手填路径 + 来源偏好」：用户在设置页改了这两项，
 * 下一次解析必须重走一遍。否则会出现「切了优先使用，界面却还显示旧的那份」
 * —— 那正是靠缓存躲过去、却又没躲干净的典型。
 *
 * @param {{ force?: boolean }} [opts] force=true 跳过缓存（下载完成后、手填路径保存后调）
 * @returns {Promise<{ok:boolean, ffmpeg:string|null, ffprobe:string|null,
 *                    source:string, version:string, major:number, detail:string}>}
 */
export async function resolveFfmpeg({ force = false } = {}) {
  const now = Date.now();
  const key = cacheKey();
  if (!force && _cache) {
    if (_cache.entry === key && _cache.result.ok) return _cache.result;
    if (_cache.entry === key && now - _cache.at < RETRY_MS) return _cache.result;
  }
  // ⚠️ 复用进行中的探测必须**同时**确认它是用当前配置跑的：
  //    _inflight 是上一个调用者用**当时**的配置启动的。若用户在它跑完之前
  //    改了「优先使用」，key 已经变了，等这个 _inflight 拿到的仍是旧顺序的
  //    结果，而且它随后还会写回 _cache —— 新配置被旧结果覆盖，直到下次过期。
  //
  //    force 也参与共享：两个并发 force 调用（例如下载完成回调 + 设置页刷新）
  //    要的是"最新结果"，而一次刚启动的探测本身就是最新的。若 force 绕开它
  //    各跑一遍，就是重复 spawn 同一批候选，还可能因后完成的那个覆盖前者。
  if (_inflight && _inflight.key === key) return _inflight.promise;

  const promise = (async () => {
    const candidates = await buildCandidates();
    let result = null;
    for (const cand of candidates) {
      // 绝对路径先做存在性检查：省掉一次 spawn（PATH 裸名直接放行）
      const abs = path.isAbsolute(cand);
      if (abs && !isFile(cand)) continue;
      const v = await probeFfmpeg(cand);
      if (!v.ok) continue;
      result = {
        ok: true,
        ffmpeg: cand,
        ffprobe: await ffprobeFallback(cand),
        source: sourceOf(cand),
        version: v.raw,
        major: v.major,
        detail: `ffmpeg ${v.raw}`
      };
      break;
    }
    if (!result) {
      result = {
        ok: false,
        ffmpeg: null,
        ffprobe: null,
        source: 'none',
        version: '',
        major: 0,
        detail: '未找到 ffmpeg。可在「设置 → 媒体工具」下载，或手动指定路径。'
      };
    }
    // 只在"本次探测用的仍是当前配置"时写回。两个不同 key 的探测可能并存
    // （用户在探测途中改了设置），若旧的那次后完成还照样写，就会把新结果
    // 覆盖掉 —— 下一次 resolveFfmpeg 读到 key 不匹配的缓存，白重探一次。
    if (key === cacheKey()) _cache = { at: Date.now(), entry: key, result };
    return result;
  })().finally(() => {
    // 只清掉自己那一次：force 调用可能与旧的 _inflight 并存，
    // 无条件置 null 会把别人的在途探测也当成已结束。
    if (_inflight?.promise === promise) _inflight = null;
  });

  _inflight = { key, promise };
  return promise;
}

/** 给 UI / 日志用的来源标签。 */
export function sourceOf(p) {
  const s = String(p || '');
  if (!s) return 'none';
  try {
    if (s === String(getConfig()?.media?.ffmpegPath || '').trim()) return 'manual';
  } catch { /* 配置未就绪 */ }
  if (s === String(process.env.QQ_AGENT_FFMPEG || '').trim()) return 'env';
  if (s.startsWith(managedBinDir())) return 'managed';
  if (s.startsWith(bundledBinDir())) return 'bundled';
  if (!path.isAbsolute(s)) return 'path';
  return 'system';
}

/** 清空缓存（下载安装完成 / 手填路径保存后调）。 */
export function invalidateFfmpegCache() {
  _cache = null;
  _inflight = null;
  _sourceListCache = null;
}

/**
 * 每组的探测条数上限。PATH 异常时（例如被人塞了几百个目录）不限的话，
 * 打开一次设置页要 spawn 上百次 `-version`。用户真正在意的"系统里那份"
 * 几乎总在前几个。
 */
const SOURCE_PROBE_LIMIT_PER_GROUP = 5;
/** 列清单时的单次探测超时，比主解析链短：这里只为展示，不值得卡住设置页。 */
const SOURCE_PROBE_TIMEOUT_MS = 6000;

/**
 * 列出这台机器上**实际可用**的 ffmpeg，按组归类，供设置页「优先使用」展示。
 *
 * 与 resolveFfmpeg 的区别：那个只返回命中的第一个；这里把每组能跑的都探一遍，
 * 让用户知道"系统里那份到底认不认"。探测是真跑 `-version`（存在但缺 DLL、
 * 架构不对在 Windows 上很常见，光看路径会把坏文件当成可用）。
 *
 * ⚠️ 必须缓存：这个函数由 `/api/ffmpeg/status` 调用，而设置页会轮询那个接口；
 *    每次最多 spawn `3 组 × 5 个` 个进程，不缓存的话打开设置页就是在反复
 *    起子进程。TTL 短（30 秒）是因为用户可能刚装完系统 ffmpeg 就来看。
 *    缓存键带上配置里的路径与偏好，改设置立刻重探。
 */
const SOURCE_LIST_TTL_MS = 30 * 1000;
let _sourceListCache = null;   // { at, entry, list }

/**
 * 一个候选的"真实身份"，用于去重。
 *
 * 裸名（'ffmpeg'）与绝对路径可能指向同一个二进制：PATH 里有 /opt/homebrew/bin，
 * 裸名就会解析到 /opt/homebrew/bin/ffmpeg，与候选清单里那条绝对路径重复。
 * 所以先尽力解析成真实路径（realpath 会一并处理软链），解析不出来才退回原字符串。
 *
 * 只在非 Windows 上做 realpath：Windows 上路径大小写不敏感、短名（8.3）等形态
 * 会让 realpath 结果与用户看到的路径差异过大，展示用绝对路径更直观，而去重
 * 靠 buildCandidatesByGroup 的字符串去重已经够（那边不会同时产生裸名与绝对路径
 * 的同一份 —— where/注册表/WinGet 给的都是绝对路径）。
 */
function realIdentity(cand) {
  const s = String(cand || '');
  if (!s) return '';
  if (!path.isAbsolute(s)) {
    // 裸名：在 PATH 里找它，找到就返回真实路径；找不到就保留裸名
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, s);
      try {
        if (fs.statSync(p).isFile()) return safeRealpath(p);
      } catch { /* 该目录下没有，继续 */ }
    }
    return s;
  }
  return safeRealpath(s);
}

/** realpath 的容错版：失败时返回原路径（文件可能刚被删掉）。 */
function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

export async function listFfmpegSources({ perGroupLimit = SOURCE_PROBE_LIMIT_PER_GROUP, force = false } = {}) {
  const key = cacheKey();
  if (!force && _sourceListCache
      && _sourceListCache.entry === key
      && Date.now() - _sourceListCache.at < SOURCE_LIST_TTL_MS) {
    return _sourceListCache.list;
  }

  let groups;
  try {
    groups = await buildCandidatesByGroup();
  } catch { return []; }

  const out = [];
  const identities = new Set();   // 已列出的可执行文件的真实身份，见下方 realIdentity
  for (const group of FFMPEG_SOURCE_ORDER) {
    let seen = 0;
    for (const cand of groups[group] || []) {
      if (seen >= perGroupLimit) break;
      const abs = path.isAbsolute(cand);
      if (abs && !isFile(cand)) continue;
      const v = await probeFfmpeg(cand, SOURCE_PROBE_TIMEOUT_MS);
      if (!v.ok) continue;
      // 按**真实文件**去重，不按字符串。
      // 裸名 'ffmpeg' 与它解析出的绝对路径（如 /opt/homebrew/bin/ffmpeg）是同一个
      // 二进制，只按字符串比会列成两条 —— 设置页显示"本机可用：ffmpeg、
      // /opt/homebrew/bin/ffmpeg"，用户会以为装了两份。
      // 裸名解析成真实路径后再比；解析不出来（PATH 里没有）就用原字符串。
      const identity = realIdentity(cand);
      if (identities.has(identity)) continue;
      identities.add(identity);
      seen += 1;
      out.push({
        group,
        path: cand,
        version: v.raw,
        major: v.major,
        source: sourceOf(cand)
      });
    }
  }
  _sourceListCache = { at: Date.now(), entry: key, list: out };
  return out;
}

/**
 * 非 Windows 上额外探测的固定安装目录。
 *
 * 为什么需要：从 systemd（Linux 服务）或 launchd（macOS 后台启动）拉起的进程，
 * PATH 往往只有 `/usr/bin:/bin` —— Homebrew、Linuxbrew、snap 的 bin 全都不在
 * 里面。用户明明装了 ffmpeg，本应用却报"未找到"，而且从终端手动跑一次
 * `pnpm start` 又好了，极难自查。固定目录不依赖启动方式，能把这类环境补齐。
 *
 * 不写成 Windows 的等价物（注册表 / WinGet）：那几条在非 Windows 上本就是
 * 空数组，这里是它们的对应物。
 */
function nonWinSystemDirs() {
  const dirs = [
    '/opt/homebrew/bin',                    // Apple Silicon Homebrew
    '/usr/local/bin',                       // Intel Homebrew / 常见手动安装
    '/home/linuxbrew/.linuxbrew/bin',       // Linuxbrew
    path.join(os.homedir(), '.local', 'bin'),
    '/snap/bin'
  ];
  // 自定义前缀的 Homebrew（如用户装在 /opt/brew）不会出现在上面的固定列表里，
  // 但 brew 自己会导出 HOMEBREW_PREFIX，有值就补上它的 bin。
  const prefix = String(process.env.HOMEBREW_PREFIX || '').trim();
  if (prefix) dirs.push(path.join(prefix, 'bin'));
  return dirs;
}

/** buildCandidates 的分组形态（同一套探测，只是先不拍平）。 */
async function buildCandidatesByGroup() {
  const groups = { manual: [], managed: [], system: [] };
  const push = (group, p) => { if (p && !groups[group].includes(p)) groups[group].push(p); };

  let manual = '';
  try { manual = String(getConfig()?.media?.ffmpegPath || '').trim(); } catch { /* 配置未就绪 */ }
  if (manual) push('manual', manual);

  push('managed', String(process.env.QQ_AGENT_FFMPEG || '').trim());
  push('managed', path.join(managedBinDir(), exeName('ffmpeg')));
  push('managed', path.join(bundledBinDir(), exeName('ffmpeg')));

  for (const p of await whereExecutable('ffmpeg')) push('system', p);
  // 裸名排在固定目录**之前**：PATH 是用户/发行版明确的优先顺序，只要 PATH
  // 里能找到，就该按 PATH 走（可能是指向自建构建的软链）。固定目录只用来
  // 补 PATH 被裁剪时的缺口，不该反过来抢在 PATH 前面 —— 那会让"我把新版
  // 放进 PATH 第一位"这类常规操作失效。
  push('system', 'ffmpeg');
  if (process.platform !== 'win32') {
    for (const dir of nonWinSystemDirs()) {
      push('system', path.join(dir, exeName('ffmpeg')));
    }
  }
  for (const p of await registryPathFfmpeg()) push('system', p);
  for (const p of wingetLinksCandidates()) push('system', p);
  for (const p of wingetFfmpegCandidates()) push('system', p);

  return groups;
}
