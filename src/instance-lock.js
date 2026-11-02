// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `pnpm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 SnowLuma、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 qq-agent.lock 文件。
//   启动时若锁文件存在且对应进程仍活着 → 判定已有实例，拒绝启动；
//   锁文件存在但进程已死（上次异常退出残留）→ 抢占锁，继续启动。
//   正常退出 / 被 kill 时删除锁文件。
//
// ── R76 加固（BUG-09）──────────────────────────────────────────────────
// 旧版锁里只存裸 PID，"活着"的判据只有 process.kill(pid, 0)。有两个坑：
//   ① 原生硬崩溃（0xC0000005，见崩溃诊断）不走 process.on('exit') →
//      锁文件残留；当 Windows 把这个 PID 复用给别的进程时，pidAlive 为真 →
//      新实例被拒，用户看到"双击没反应 / 提示已在运行但界面上根本没有"。
//   ② releaseInstanceLock 原来比较 Number(content) === process.pid，
//      锁内容一旦不是纯数字就永远删不掉（见下面的 readLock 兼容逻辑）。
// 现在锁内容升级为 { pid, bootTime, image }，"活着"的判据加两道身份校验：
//   PID 存活 → 进程镜像名与锁里记的一致 → 进程创建时刻与 bootTime 吻合（±30s）。
// 任一环不过 = 残留锁（进程死了，或 PID 被复用），删除接管。
// 查不了身份时（powershell 不可用 / 超时 / 非 Windows）自动退回旧行为，
// 不会把"能启动"变成"不能启动"——加固只收紧误判，不制造新回归。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');

// 身份容忍窗口：锁里记的 bootTime 与目标进程实际创建时刻，相差超过它即认定
// "PID 被别的进程复用了"。取 30s 是为了容忍"进程启动 → 模块加载 → 真正拿锁"
// 之间的间隔（日志实测首启到控制台就绪约 3 秒，30s 有充足余量）；
// 而 PID 复用/另一个实例的创建时刻差通常是分钟级以上，不会误吞。
const IDENTITY_TOLERANCE_MS = 30_000;

// r93：锁心跳的"陈腐"阈值。持有者每 60 秒刷新一次锁里的 hb 字段（见
// startLockHeartbeat）。超过这个时间没刷新 = 持有者早就不在了。
// 取 10 分钟而不是 1~2 分钟，是为了容忍"系统休眠期间定时器不跑"——
// 睡一觉醒来 hb 必然变旧，但进程其实一直活着，不能因此被别人抢锁。
const LOCK_HEARTBEAT_STALE_MS = 10 * 60_000;

// r93：心跳定时器（模块级，保证只挂一个）
let lockHeartbeatTimer = null;

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号（别的用户），也算活着
    return error?.code === 'EPERM';
  }
}

/**
 * R93：先花很小的代价问一次**镜像名**（tasklist，通常 30~80ms）。
 *
 * 为什么要分两步：R76 的实现一上来就 `Get-CimInstance`，而 powershell 冷启动
 * 要 300~800ms（超时上限 5s）。这段是**同步**跑在 `createApp()` 里、**建窗之前**，
 * 所以"上次崩溃留下锁 + 那个 PID 恰好被系统复用"时，用户双击后要干等几百
 * 毫秒到 5 秒才见到窗口 —— 与"双击半天不出窗"是同一笔账。
 *
 * 而绝大多数情况下（PID 被**无关程序**复用，正是硬崩溃后最常见的场景）镜像名
 * 就对不上，第一步即可下结论，根本不需要惊动 powershell。
 *
 * 返回 null 表示"查不到"（非 Windows / tasklist 不可用 / PID 不在列表里），
 * 调用方据此回退到 CIM 全量查询 —— 不改变任何判定语义，只是把快路径提前。
 */
function processImageName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', [
      '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'
    ], { timeout: 1500, windowsHide: true, encoding: 'utf8' });
    // 命中时形如："QQ Agent.exe","1234","Console","1","188,788 K"
    // 未命中时 tasklist 输出的是本地化的"没有运行的任务…"提示，正则自然不匹配。
    const m = String(out).match(/"([^"]+)"/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * R76：查一个 PID 的进程身份（镜像名 + 创建时刻，Unix 毫秒）。
 * Windows 走 CIM（Get-CimInstance Win32_Process）；查不到 / 超时 /
 * powershell 不可用 / 非 Windows 一律返回 null —— 调用方据此退回旧行为。
 */
function processIdentity(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | ForEach-Object { "$($_.Name)|$([DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds())" }`
    ], { timeout: 2500, windowsHide: true, encoding: 'utf8' });
    const line = String(out).trim().split(/\r?\n/)[0] || '';
    const [name, ms] = line.split('|');
    const creationMs = Number(ms);
    if (!name || !Number.isFinite(creationMs)) return null;
    return { name: name.toLowerCase(), creationMs };
  } catch {
    return null;
  }
}

// 身份查询的可替换点（与 image-cache.js 的 __resetForTest 同一约定）：
// 生产永远走上面的 CIM 实现；单测可注入假实现验证判定链，不必真起 powershell。
let identityProbe = processIdentity;

// R93：一次 acquireInstanceLock() 内的身份查询记忆。为什么需要 ——
// acquireInstanceLock 最多试两轮，每轮都会走到 lockIsLive()；旧实现会把
// 同一份 CIM 查询（同步、几百毫秒）跑两遍。缓存只活在一次抢锁调用里，
// 跨调用清空，所以不会把"进程身份变了"这种变化记成陈旧值。
let identityMemo = new Map();

/** 带记忆的身份查询（键 = pid）。 */
function cachedIdentity(pid) {
  if (identityMemo.has(pid)) return identityMemo.get(pid);
  const id = identityProbe(pid);
  identityMemo.set(pid, id);
  return id;
}

/**
 * R76：读锁文件，统一成 { pid, bootTime, image }。
 * 兼容 v1（纯 PID 文本）：那种锁没有身份信息，只能按旧逻辑（仅 PID 存活）判断。
 */
function readLock() {
  try {
    const raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const obj = JSON.parse(raw);
      const pid = Number(obj?.pid);
      if (!Number.isFinite(pid)) return null;
      return {
        pid,
        bootTime: Number(obj.bootTime) || 0,
        image: String(obj.image || ''),
        // r93：心跳时间戳。v2 旧锁没有这个字段 → 0 = "未知"，判定时退回旧行为。
        hb: Number(obj.hb) || 0
      };
    }
    const pid = Number(raw);
    return Number.isFinite(pid) ? { pid, bootTime: 0, image: '', hb: 0 } : null;
  } catch {
    return null;   // 读不出（截断/被清）就当没有锁
  }
}

/**
 * R76：这个锁还代表一个活着的"我们自己"吗？
 * 判定链：PID 存活 →（身份可查时）镜像名一致 → 创建时刻与 bootTime 吻合。
 * 任一环不过 = 残留锁；身份查不了时维持"PID 活着就算活着"的旧语义。
 *
 * R93：判定链前面加了一步廉价预筛（见 processImageName）。**语义不变** ——
 * 只是把"PID 被无关程序复用"这个硬崩溃后最常见的残留锁场景，从"要起
 * powershell（300~800ms，同步阻塞建窗）"降到"一次 tasklist（30~80ms）"。
 * 注入假探针的单测不受影响（预筛只在生产实现下启用），判定链依旧可测。
 */
function lockIsLive(lock) {
  if (!lock || !lock.pid || lock.pid === process.pid) return false;
  if (!pidAlive(lock.pid)) return false;
  if (lock.image && identityProbe === processIdentity) {
    const name = processImageName(lock.pid);
    if (name && name !== String(lock.image).toLowerCase()) return false;   // PID 被别的程序复用
  }
  const id = cachedIdentity(lock.pid);
  if (!id) {
    // r93：身份查不了（非 Windows / powershell 被安全策略拦 / 子进程被禁）时，
    // 旧行为是"PID 活着就算活着" —— 而这正是 BUG-09 的复现条件：硬崩溃留下的
    // 锁 + 那个 PID 被无关程序复用 + 查不了身份 → **双击没反应、提示已在运行但
    // 界面上根本没有**。现在先用心跳兜一道：持有者若已 10 分钟没刷新锁，
    // 说明它早就不在了，按残留锁接管。
    // 只有 hb 存在（r93 之后的锁）才用这条；旧锁 hb=0 时维持原语义不变。
    if (lock.hb && Date.now() - lock.hb > LOCK_HEARTBEAT_STALE_MS) return false;
    return true;                                                 // 查不了身份：旧行为
  }
  if (lock.image && id.name !== String(lock.image).toLowerCase()) return false;   // PID 被别的程序复用
  if (lock.bootTime && Math.abs(id.creationMs - lock.bootTime) > IDENTITY_TOLERANCE_MS) return false; // 同名但不同进程
  return true;
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读锁判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  // R93：本次抢锁开始，清空身份记忆（跨调用不保留，避免记成陈旧身份）
  identityMemo = new Map();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      // v2：带身份信息（R76），供残留锁判定
      fs.writeFileSync(LOCK_FILE, JSON.stringify({
        pid: process.pid,
        bootTime: Date.now(),
        image: path.basename(process.execPath),
        // r93：心跳时间戳，由 startLockHeartbeat() 每 60 秒刷新。
        // 用途见 lockIsLive() —— 它让"身份查不了"的环境也能正确识别残留锁。
        hb: Date.now()
      }), { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：按身份判定是活锁还是残留锁
      const lock = readLock();
      if (lock && lockIsLive(lock)) {
        return { ok: false, reason: `已有 QQ Agent 实例在运行（PID ${lock.pid}）`, existingPid: lock.pid };
      }
      // 残留锁（进程已死 / PID 被复用 / v1 旧锁且进程已死）：删掉，下一轮 wx 重新抢。
      // r92：删除前必须复核锁内容未变。原实现"读到残留 → unlink → 下一轮 wx"
      // 三步之间无原子性，且 lockIsLive 内含同步 CIM 身份查询（最长 5s）——
      // 进程 B 完全可能在这个窗口里删掉同一把残留锁并用 wx 建好自己的锁，
      // 随后我们的 unlink 把 **B 的新锁**删掉、我们的 wx 成功 → 两个实例都
      // 自认锁主，双核心同时连 OneBot、重复回复群消息（正是该锁存在的目的）。
      // 复核把危险窗口从"秒级"缩到"两次背靠背同步 IO 之间的微秒级"；身份
      // （pid+bootTime）不一致说明锁已被别人抢走/重建，不动手，下一轮 wx 见分晓。
      if (lock) {
        const recheck = readLock();
        const same = recheck && recheck.pid === lock.pid && recheck.bootTime === lock.bootTime;
        if (same) {
          try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
        }
      } else {
        // v1 旧锁读不出身份：按残留处理（原行为）
        try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
      }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  try {
    if (lockHeartbeatTimer) { clearInterval(lockHeartbeatTimer); lockHeartbeatTimer = null; }
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    // ⚠️ 必须用 readLock 解析（v2 是 JSON），不能直接 Number(content) 比较 ——
    // 那正是旧版的坑：锁内容变成 JSON 后 Number() 恒为 NaN，锁永远删不掉。
    const lock = readLock();
    if (lock && Number(lock.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/**
 * r93：开始刷新锁心跳（每 60 秒把锁里的 hb 更新成当前时间）。
 *
 * 为什么需要：`lockIsLive()` 在"身份查不了"时只能退回"PID 活着就算活着"，
 * 而硬崩溃留下的锁 + PID 被无关程序复用，正好落在这条路上 → 新实例被拒，
 * 用户看到"双击没反应"。心跳给了第二条独立证据：持有者若 10 分钟没刷新，
 * 就是残留锁。心跳与进程同生命周期，且**只刷新自己的锁**（pid 不符即停手），
 * 绝不会踩到新实例刚建的锁。
 *
 * `unref()` 保证它不阻止进程退出 —— 这个定时器纯属"给别的进程看的信号"，
 * 不该成为退出流程的牵挂。
 */
export function startLockHeartbeat() {
  if (lockHeartbeatTimer) return;                       // 幂等
  lockHeartbeatTimer = setInterval(() => {
    try {
      const lock = readLock();
      if (!lock || Number(lock.pid) !== process.pid) {
        // 锁已被别人接管（或已删）：停掉心跳，不再写。
        clearInterval(lockHeartbeatTimer);
        lockHeartbeatTimer = null;
        return;
      }
      fs.writeFileSync(LOCK_FILE, JSON.stringify({
        pid: process.pid,
        bootTime: lock.bootTime || Date.now(),
        image: lock.image || path.basename(process.execPath),
        hb: Date.now()
      }));
    } catch { /* 写不进去就算了，不影响主流程 */ }
  }, 60_000);
  lockHeartbeatTimer.unref?.();
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  // r93：拿到锁之后立刻开始刷心跳（给"下一个启动的进程"留一条独立于
  // powershell 的存活证据，见 startLockHeartbeat 的注释）。
  startLockHeartbeat();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}

/**
 * 测试接缝（生产勿用）：替换身份查询实现，返回还原函数。
 * 存在的意义：CIM 查询依赖 powershell 子进程，单测跑不起/不该跑，
 * 但"镜像名 / 创建时刻 / 查不了"三条分支必须被覆盖。
 */
export function __setIdentityProbeForTest(fn) {
  const prev = identityProbe;
  identityProbe = fn || processIdentity;
  identityMemo = new Map();   // R93：换实现即失效旧记忆，免得串味
  return () => { identityProbe = prev; identityMemo = new Map(); };
}
