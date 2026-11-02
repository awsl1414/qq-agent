// Wallpaper Engine 场景渲染窗口控制 + 屏幕录制（动态壁纸导入用）。
// ⚠️ 与 ../we-control.js 的分工：本文件管「开渲染窗 + 录屏」，
//    we-control.js 管「-control 命令行 + 壁纸库扫描 + 当前壁纸」，别弄混。
// 移植自 zcode-beautify（MIT，https://github.com/Logocceai/zcode-beautify）。
//
// 实测踩坑（原项目 docs/spike-notes.md 验证过，此处照单全收）：
//   - `wallpaper64.exe -control openWallpaper -file <pkg> -playInWindow <title>`
//     创建的窗口标题精确等于 <title>；-width/-height 不可靠（要 1920x1080
//     只给你 1280x720），所以开窗后必须 SetWindowPos 重新定尺寸。
//   - WE 已在运行时，spawn 出来的进程只是把命令经 IPC 转发给老进程就退出，
//     窗口属于老进程 —— proc 只做诊断，句柄以窗口枚举结果为准。
//   - 关窗必须走 `-control closeWallpaper -playInWindow <title>`，杀进程留窗。
//   - FindWindowW 在 PowerShell 字符串编组下对这些窗口失灵（EnumWindows
//     能看到、FindWindowW 返回 0），所以用 EnumWindows 精确匹配标题。
//   - ddagrab 抓的是合成后的整个桌面，录制期间窗口必须置顶（录完还原）。
//   - crop 对 d3d11 硬件帧会静默无效：链路必须 ddagrab → hwdownload,format=bgra
//     → crop → scale。裁剪矩形用定尺寸后量得的 client rect（外框会录进标题栏）。
//   - draw_mouse=0 别把鼠标录进去。
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { execFileP } from './exec.js';
import { resolveHwEncoder } from './deps.js';

const exec = execFileP;

export class SceneWindowError extends Error {}

export const PS_WINDOW_HELPERS = `
# ddagrab 抓的是物理像素；不开 DPI 感知 PowerShell 拿到的是逻辑（虚拟化）坐标，裁剪会错位
Add-Type -Namespace N -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[N.Dpi]::SetProcessDPIAware() | Out-Null
Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetWindowPos(IntPtr h, IntPtr after, int X, int Y, int cx, int cy, uint flags);
[DllImport("user32.dll")]
public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")]
public static extern bool ClientToScreen(IntPtr h, ref POINT p);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int m);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static string FindExact(string title) {
    string hit = null;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == title) { hit = h.ToString(); return false; }
      return true;
    }, IntPtr.Zero);
    return hit;
  }
}
'@
function Find-WindowByTitle([string]$Title) {
  $r = [WinEnum]::FindExact($Title)
  if ($r) { [long]$r } else { $null }
}
function Measure-Client([IntPtr]$h) {
  $cr = New-Object Native.Win+RECT
  [Native.Win]::GetClientRect($h, [ref]$cr) | Out-Null
  $pt = New-Object Native.Win+POINT
  [Native.Win]::ClientToScreen($h, [ref]$pt) | Out-Null
  ,@($pt.X, $pt.Y, ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top))
}
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForWindow(title, timeoutMs) {
  const script = `${PS_WINDOW_HELPERS}
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
while ((Get-Date) -lt $deadline) {
  $h = Find-WindowByTitle '${title}'
  if ($null -ne $h) { Write-Output $h; exit 0 }
  Start-Sleep -Milliseconds 300
}
exit 3`;
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], { timeout: timeoutMs + 10_000 });
    const hwnd = Number(stdout.trim());
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch { return null; }
}

async function findWindowOnce(title) {
  const script = `${PS_WINDOW_HELPERS}
$h = Find-WindowByTitle '${title}'
if ($null -ne $h) { Write-Output $h }`;
  try {
    const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
    const hwnd = Number(stdout.trim());
    return Number.isFinite(hwnd) && hwnd > 0 ? hwnd : null;
  } catch { return null; }
}

function parseClientRect(stdout, title) {
  const [x, y, width, height] = stdout.trim().split(',').map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new SceneWindowError(`量不到「${title}」的客户区（输出：${stdout.trim()}）`);
  }
  return { x, y, width, height };
}

async function positionWindow(hwnd, opts) {
  const script = `${PS_WINDOW_HELPERS}
$h = [IntPtr]${hwnd}
$x = ${opts.x ?? -1}; $y = ${opts.y ?? -1}
$w = ${opts.width}; $hh = ${opts.height}
if ($x -eq -1 -or $y -eq -1) {
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = [int](($b.Width - $w) / 2); $y = [int](($b.Height - $hh) / 2)
}
[Native.Win]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $hh, 0x0004) | Out-Null  # SWP_NOZORDER
Start-Sleep -Milliseconds 200
$c = Measure-Client $h
Write-Output ("{0},{1},{2},{3}" -f $c[0], $c[1], $c[2], $c[3])`;
  const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
  return parseClientRect(stdout, opts.title);
}

/** WE 定完尺寸后可能又异步挪窗，录制前必须重量一次客户区。 */
export async function measureClientRect(hwnd, title) {
  const script = `${PS_WINDOW_HELPERS}
$c = Measure-Client ([IntPtr]${hwnd})
Write-Output ("{0},{1},{2},{3}" -f $c[0], $c[1], $c[2], $c[3])`;
  const { stdout } = await exec('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
  return parseClientRect(stdout, title);
}

export async function openSceneWindow(pkgPath, opts, wallpaperExe) {
  if (!wallpaperExe || !fs.existsSync(wallpaperExe)) {
    throw new SceneWindowError('找不到 wallpaper64.exe，无法开渲染窗口');
  }
  const proc = spawn(wallpaperExe, [
    '-control', 'openWallpaper',
    '-file', pkgPath,
    '-playInWindow', opts.title,
    '-width', String(opts.width),
    '-height', String(opts.height)
  ], { stdio: 'ignore', detached: false, windowsHide: true });
  proc.unref();

  const hwnd = await waitForWindow(opts.title, 15_000);
  if (hwnd === null) throw new SceneWindowError(`渲染窗口「${opts.title}」15 秒内没出现`);
  // 去掉标题栏/边框：这是十几秒的临时工具窗，带标题栏会被用户手滑拖动
  // （录制按屏幕坐标裁剪，窗口一动就录进别的内容，成品必坏）或点 X 关掉
  // （录制中断）。无边框 = 拖不动也关不掉，录制期间绝对静止。
  await makeFrameless(hwnd);
  const client = await positionWindow(hwnd, opts);
  return { title: opts.title, hwnd, client, proc };
}

/** GWL_STYLE 去掉 WS_CAPTION(0x00C00000)|WS_THICKFRAME(0x00040000) + SWP_FRAMECHANGED。 */
async function makeFrameless(hwnd) {
  const script = `${PS_WINDOW_HELPERS}
Add-Type -Namespace N -Name W2 -MemberDefinition '[DllImport("user32.dll")] public static extern long GetWindowLongPtr(IntPtr h, int i);
[DllImport("user32.dll")] public static extern long SetWindowLongPtr(IntPtr h, int i, long v);'
$h = [IntPtr]${hwnd}
$style = [N.W2]::GetWindowLongPtr($h, -16)
$style = [long]($style -band (-bnot [int64]0x00C00000) -band (-bnot [int64]0x00040000))
[N.W2]::SetWindowLongPtr($h, -16, $style) | Out-Null
[Native.Win]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0023) | Out-Null  # FRAMECHANGED|NOSIZE|NOMOVE`;
  await exec('powershell', ['-NoProfile', '-Command', script], { timeout: 10_000 });
}

export async function closeSceneWindow(handle, wallpaperExe) {
  if (!wallpaperExe || !fs.existsSync(wallpaperExe)) {
    throw new SceneWindowError('找不到 wallpaper64.exe，无法关渲染窗口');
  }
  await exec(wallpaperExe, ['-control', 'closeWallpaper', '-playInWindow', handle.title], { timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await findWindowOnce(handle.title)) === null) return;
    await sleep(300);
  }
  throw new SceneWindowError(`关窗指令发出 10 秒后「${handle.title}」还挂着`);
}

async function setTopmost(hwnd, topmost) {
  // -1 = HWND_TOPMOST，-2 = HWND_NOTOPMOST；SWP_NOMOVE(0x2)|SWP_NOSIZE(0x1)：只动 Z 序
  const after = topmost ? -1 : -2;
  await exec('powershell', [
    '-NoProfile', '-Command',
    `Add-Type -Namespace N -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'
[N.W]::SetWindowPos([IntPtr]${hwnd}, [IntPtr]${after}, 0, 0, 0, 0, 0x0003)`
  ], { timeout: 10_000 });
}

export class RecordError extends Error {}

/** ddagrab 抓取指定窗口客户区，编码成 mp4。窗口全程置顶（抓完还原）。 */
export async function recordSceneWindow(handle, out, opts, ffmpegPath) {
  if (!ffmpegPath) throw new RecordError('ffmpeg 不可用，无法录制');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const client = await measureClientRect(handle.hwnd, handle.title);
  const { x, y, width, height } = client;
  // 编码走硬件（NVENC/AMF）：ddagrab 抓帧本来就在 GPU，软编码反而要把
  // 每帧搬回 CPU 压——硬件编码整条链路留在显卡上。探测失败自动回 libx264。
  const enc = await resolveHwEncoder(ffmpegPath);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=0:framerate=${opts.fps}:draw_mouse=0`,
    '-t', String(opts.duration),
    '-vf', `hwdownload,format=bgra,crop=${width}:${height}:${x}:${y},scale=${opts.outWidth}:${opts.outHeight}`,
    '-c:v', enc.codec, ...enc.extra,
    '-pix_fmt', 'yuv420p',
    '-an',
    out
  ];
  await setTopmost(handle.hwnd, true);
  try {
    await exec(ffmpegPath, args, { timeout: (opts.duration + 30) * 1000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new RecordError(`ddagrab 录制失败：${e?.message ?? e}`);
  } finally {
    await setTopmost(handle.hwnd, false).catch(() => undefined);
  }
}
