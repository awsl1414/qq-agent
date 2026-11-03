// 版本迁移：处理"跨版本升级后留在用户磁盘/配置里的残留"。
//
// 为什么需要这一层：用户数据（data/）不在安装清单里，exe 安装器升级时不碰它，
// 免安装 zip 覆盖更不会。于是"程序目录里已经被删掉的模块"会以两种形式继续存在：
//   ① 它的目录还在（免安装覆盖路径只写新文件、不删旧文件）；
//   ② 指向它的配置引用还在（config.json 的 trustedPlugins / skills）。
// 两者叠加就出事。0.4.8.5 的真实例子：内置记忆插件从 `conversation-memory`
// 整体换血为 `mem-layered`，而老用户 config 的 trustedPlugins 里还留着
// `conversation-memory`，信任闸（plugin-loader.js 的 checkPluginTrust）
// 按目录名直接放行、不看基线指纹，于是残留的旧插件照常加载，与新插件
// 争同名能力。后果是三条叠加（详见 plugins/mem-layered/lib/conflict.js）：
//   - 钩子叠加：runHook 遍历所有已激活 Skill，两边都往最后一条 user
//     消息追加记忆，内容重复、token 翻倍；
//   - 能力先注册者赢：api.capability 只取第一个提供者，`conversation-memory`
//     (c) 按目录名排在 `mem-layered`(m) 之前，模型主动检索查到的是旧
//     数据根，新插件的数据在磁盘上却查不到，且不报错；
//   - 双定时器：两边各跑一份后台巩固。
//
// 与 config.js 的 LEGACY_SKILL_MIGRATIONS 的分工（两者不重叠）：
//   - 那边是纯字段映射：无副作用、每次启动都跑、靠"目标字段不存在"幂等。
//   - 这边是有副作用的动作：要 stat 磁盘、要改配置、要打日志，
//     幂等靠 data/upgrade-state.json 里的"已执行 id"。
//   纯映射能表达的事情继续留在那边，不要搬进来，否则两套幂等机制会打架。
//
// 三条硬约束：
//   ① 不删用户文件：只改配置与本模块自己的状态文件；动磁盘上的旧文件只允许
//      **搬进数据目录的备份区**（backupPath），绝不直接删除。真正的删除只发生在
//      用户于界面上逐个确认之后（removeLegacyResidue）。
//   ② 幂等：已执行过的 id 永不重跑；动作本身也要能重复执行而不叠加。
//   ③ 失败不阻塞启动：单项抛错只记日志（且不记入 applied，下次重试），
//      其余项与整个启动流程照常继续。
//
// 分层：自动迁移 vs 用户确认清理
//   · 自动迁移（runUpgrades，启动时跑）：只做**无损**动作。旧位置的文件搬到
//     data/runtime/legacy-backup/，随时可以搬回来，所以不需要用户点头。
//   · 用户确认清理（detectLegacyResidue / removeLegacyResidue，界面触发）：
//     删除不可恢复，所以只检测、不自动做，列在「设置 → 外观与数据」里等用户点。
//   判断标准一句话：搬得走就自动搬，删了回不来的必须让用户确认。
//
// 调用点：src/app.js 的 start() 开头，必须在 reloadSkills({reason:'boot'})
// 之前，因为插件扫描会读 trustedPlugins，晚一步就白做。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, CONFIG_FILE, updateConfig } from './config.js';

/** 迁移状态文件（放在 DATA_DIR：它是"这台机器的本次安装"的状态，不是出厂内容）。 */
export function upgradeStatePath(dataDir = DATA_DIR) {
  return path.join(dataDir, 'upgrade-state.json');
}

/**
 * 把 applied 里的一条记录归一成 `{ at, ...extra }`。
 *
 * 格式演进：最早是 `applied[id] = "ISO 时间戳"`，只表示"跑过了"。现在需要
 * 记录动作结果（`movedTo` 等），所以新写法是
 * `applied[id] = { at: ISO, movedTo: '...', items: [...] }`。
 * 两种都必须能读：用户磁盘上的老状态文件是前者，读不懂就会把已执行的迁移
 * 再跑一遍（虽然幂等，但会白打日志、且 migrated 记录被改写）。
 * 返回 null = 这个条目形态不认识，按"没跑过"处理（宁可重跑一次）。
 */
export function normalizeAppliedEntry(raw) {
  if (typeof raw === 'string') return raw ? { at: raw } : { at: '' };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...raw, at: String(raw.at || '') };
  }
  return null;
}

/** 读迁移状态。坏文件/不存在一律当"从没跑过"：迁移项自身幂等，重跑无害。 */
export function readUpgradeState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') throw new Error('not an object');
    const applied = {};
    const rawApplied = (j.applied && typeof j.applied === 'object' && !Array.isArray(j.applied)) ? j.applied : {};
    for (const [id, entry] of Object.entries(rawApplied)) {
      const norm = normalizeAppliedEntry(entry);
      if (norm) applied[id] = norm;
    }
    return { version: String(j.version || ''), applied, updatedAt: String(j.updatedAt || '') };
  } catch {
    return { version: '', applied: {}, updatedAt: '' };
  }
}

/** 原子写状态（与 config.js 同款：临时名带 pid，避免双开互相 rename 走半截文件）。 */
function writeUpgradeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读当前应用版本（package.json）。读不到返回空串，只影响状态记录，不影响是否执行。 */
function readAppVersion(appRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

/** 读内置基线里的模块名集合（builtin-modules.json 的 modules[].dir）。 */
function readBuiltinIds(appRoot) {
  const out = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appRoot, 'builtin-modules.json'), 'utf8'));
    for (const m of j.modules || []) {
      if (m && m.dir) out.add(String(m.dir));
      else if (m && m.id) out.add(String(m.id));
    }
  } catch { /* 基线读不到 → 集合为空：下面的"孤儿"判定会偏保守（少清），比误清安全 */ }
  return out;
}

/** 某模块目录是否存在于 plugins/ 或 skills/ 下（历史版本两处都放过）。 */
function findModuleDir(appRoot, id) {
  for (const kind of ['plugins', 'skills']) {
    const dir = path.join(appRoot, kind, id);
    try { if (fs.existsSync(dir)) return dir; } catch { /* 权限/盘掉了：当作不存在 */ }
  }
  return null;
}

// ── 路径安全 ────────────────────────────────────────────────────────────
//
// 本模块会按"用户传进来的路径"删东西，这是整个仓库里少数几个真正危险的面。
// 校验集中在这一个函数里，任何删除/搬移都必须先过它，不允许各调用点自己拼判断
// （漏一处就是一个任意文件删除）。
//
// 拦五类输入：
//   ① 相对路径 / 空路径 —— 它会按进程 cwd 解析，落在哪儿不可控；
//   ② 文件系统根 `/`、`C:\` —— 删它等于毁掉整台机器；
//   ③ 越界路径（`..` 逃逸、或根本不在允许根下）；
//   ④ 允许根本身（DATA_DIR / appRoot 根 / appRoot/runtime 根）—— 删它等于删掉
//      全部用户数据或整个程序；
//   ⑤ 符号链接 —— lstat 判定，是链接就不跟（跟的话删的是链接指向的外部文件）。
//      另外用"父链真实路径"再确认一次，挡住「允许根里面有一个目录是指向外面的
//      链接」这种 lstat 看不出来的形态。

const ALLOWED_ROOTS_HINT = 'DATA_DIR 或 appRoot/runtime';

/**
 * 允许写入/删除的根。
 *
 * 只有两处：数据目录（迁移备份、下载残留都在这里），以及程序根下的 runtime/
 * （历史版本随包分发的 ffmpeg 就在那儿）。**刻意不包含 appRoot 本身**：它装着
 * 全部源码与内置扩展，误删一个路径就是整个程序没了。
 */
export function allowedRoots({ appRoot = ROOT, dataDir = DATA_DIR } = {}) {
  return [path.resolve(dataDir), path.join(path.resolve(appRoot), 'runtime')];
}

/** a 是否严格位于 b 之下（不含相等）。 */
function isStrictlyInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 取一个路径的"最近真实祖先"：不存在的尾部段原样拼回去。
 * 用于在目标还不存在时（搬移目的路径）仍能判断它落在哪个真实目录里。
 */
function nearestReal(target) {
  let cur = target;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 校验一个将被删除/搬移的路径。通过时返回规范化后的绝对路径，否则抛错。
 *
 * 抛错而不是返回 { ok:false }：调用方（迁移项、路由）无一例外要在失败时中止，
 * 返回码在"忘了检查"时会被静默忽略，异常不会。
 */
export function assertSafePath(target, roots) {
  const raw = String(target ?? '').trim();
  if (!raw) throw new Error('路径为空');
  if (!path.isAbsolute(raw)) throw new Error(`路径必须是绝对路径：${raw}`);
  const abs = path.resolve(raw);
  if (abs === path.parse(abs).root) throw new Error(`拒绝操作文件系统根目录：${abs}`);

  const list = (Array.isArray(roots) ? roots : [roots])
    .filter(Boolean)
    .map((r) => path.resolve(String(r)));
  if (!list.length) throw new Error('没有可用的允许根目录');
  const root = list.find((r) => isStrictlyInside(r, abs));
  if (!root) throw new Error(`拒绝操作：${abs} 不在允许范围内（只允许 ${ALLOWED_ROOTS_HINT} 之内）`);

  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* 不存在：搬移目的地允许不存在 */ }
  if (st && st.isSymbolicLink()) throw new Error(`拒绝操作符号链接：${abs}`);

  // 父链真实路径复查：允许根内部若有指向外部的链接目录，lstat(abs) 看到的是
  // 链接指向的那个普通文件，不是链接本身，单靠上面的判断漏得掉。
  const realRoot = nearestReal(root);
  const realParent = nearestReal(path.dirname(abs));
  if (!realRoot || !realParent) throw new Error(`无法确认真实路径：${abs}`);
  if (!(realParent === realRoot || isStrictlyInside(realRoot, realParent))) {
    throw new Error(`拒绝操作：${abs} 的真实父目录不在允许范围内`);
  }
  return abs;
}

// ── 文件动作 ────────────────────────────────────────────────────────────
// 迁移项与用户确认清理共用这三个函数，不各写一遍 rename/copy/rm。

/**
 * 原子搬移。同盘走 rename；跨盘（EXDEV，数据目录与程序目录常在不同分区）
 * 降级为 copy + 删除。任一步失败都保持"原文件还在"：跨盘时若复制成功而删除
 * 失败，会把复制出来的那份也清掉再抛错，绝不留下半套。
 *
 * 目标已存在时默认抛错（不覆盖），这是幂等要求的一部分：重复执行不能把
 * 上一次的备份盖掉。
 */
export function movePath(src, dest, { roots, overwrite = false } = {}) {
  const from = assertSafePath(src, roots);
  const to = assertSafePath(dest, roots);
  if (from === to) throw new Error(`源与目标相同：${from}`);
  if (isStrictlyInside(from, to)) throw new Error(`拒绝把目录搬进它自己里面：${to}`);
  if (!overwrite && fs.existsSync(to)) throw new Error(`目标已存在，不覆盖：${to}`);

  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    try {
      fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
    } catch (copyError) {
      try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* 尽力回滚 */ }
      throw copyError;
    }
    try {
      fs.rmSync(from, { recursive: true, force: true });
    } catch (removeError) {
      try { fs.rmSync(to, { recursive: true, force: true }); } catch { /* 尽力回滚 */ }
      throw removeError;
    }
  }
  return { from, to };
}

/**
 * 删除文件或目录。路径不存在视为已达成（幂等）。
 * 符号链接由 assertSafePath 整体拒绝：删链接本身虽然安全，但"删除"这个动作
 * 对准的从来不是链接，把选择权留在调用方（迁移项）更不容易误判。
 */
export function removePath(p, { roots } = {}) {
  const abs = assertSafePath(p, roots);
  let st = null;
  try { st = fs.lstatSync(abs); } catch { return { removed: false, path: abs }; }
  fs.rmSync(abs, { recursive: st.isDirectory(), force: true });
  return { removed: true, path: abs };
}

/** 备份区根：`data/runtime/legacy-backup/`。旧版本留下的文件都搬到这里。 */
export function legacyBackupRoot(dataDir = DATA_DIR) {
  return path.join(dataDir, 'runtime', 'legacy-backup');
}

/** 目标已存在时追加 `-2` / `-3`…，保证搬移永远不覆盖已有的备份。 */
function uniqueDest(target) {
  if (!fs.existsSync(target)) return target;
  for (let i = 2; i < 100; i += 1) {
    const cand = `${target}-${i}`;
    if (!fs.existsSync(cand)) return cand;
  }
  throw new Error(`备份目标重复太多，放弃：${target}`);
}

/**
 * 把路径搬进备份区并返回新位置。`name` 可指定备份中的名字（默认取原文件名），
 * 用来把 `runtime/ffmpeg.exe` 这类散落文件放进同一次迁移的子目录里。
 */
export function backupPath(p, { backupRoot, roots, name } = {}) {
  if (!backupRoot) throw new Error('缺少备份根目录');
  const root = assertSafePath(backupRoot, roots);
  const src = assertSafePath(p, roots);
  const dest = uniqueDest(path.join(root, String(name || path.basename(src))));
  return movePath(src, dest, { roots });
}

// ── 迁移注册表 ────────────────────────────────────────────────────────────
// 加一项只需在此追加一个对象。惯例：
//   - id 一旦发布永不修改（它是幂等账本的键，改了等于让它再跑一次）；
//   - run() 只做无损动作：改配置，或把磁盘上的旧文件搬进 legacy-backup；
//     **不删任何东西**，删除只走用户确认那条路（removeLegacyResidue）；
//   - 返回 { changed: string[], note?: string, record?: object }，
//     record 会连同执行时间写进状态文件的 applied 里（如 movedTo）。

export const UPGRADES = [
  {
    id: 'retire-conversation-memory',
    title: '停用已被取代的旧记忆插件（conversation-memory → mem-layered）',
    run({ appRoot, log, saveConfig }) {
      const LEGACY = 'conversation-memory';
      const found = findModuleDir(appRoot, LEGACY);
      const changed = [];

      saveConfig((cfg) => {
        const patch = {};

        // ① 移出可信清单。信任闸按目录名匹配后直接放行（checkPluginTrust），
        //    留着这一项等于给残留目录一张长期免检通行证，正好抵消基线闸的作用。
        const trusted = Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins.map(String) : [];
        if (trusted.includes(LEGACY)) {
          patch.trustedPlugins = trusted.filter((x) => x !== LEGACY);
          changed.push('trustedPlugins');
        }

        // ② 目录还在 → 显式关掉。`config.skills[id].enabled === false` 会让
        //    reloadSkills 里的 `if (st.enabled && st.loaded)` 不成立，于是不 activate，
        //    不挂 after-response 钩子、不起后台巩固定时器，冲突被从根上切断，
        //    即使它仍被读进内存也不产生任何行为。
        //    只在目录确实存在时才写这一条：给一个不存在的插件留配置，
        //    只会让「插件」页多出一条"已配置但未安装"的噪音，而它什么也挡不住。
        if (found) {
          const cur = cfg.skills?.[LEGACY];
          if (!cur || typeof cur !== 'object' || cur.enabled !== false) {
            patch.skills = { [LEGACY]: { ...(cur && typeof cur === 'object' ? cur : {}), enabled: false } };
            changed.push('skills.enabled=false');
          }
        }
        return patch;
      });

      if (!changed.length) {
        return { changed, note: '本机没有该插件的残留（目录与配置都干净），无需处理' };
      }
      const parts = [];
      if (found) parts.push(`发现残留目录 ${found}`);
      else parts.push('目录已不存在（安装器/手动清理过）');
      parts.push(`已处理：${changed.join('、')}`);
      if (found) {
        parts.push('插件文件按"不删用户数据"原则**原样保留**；如要彻底移除，请手动删除该目录');
      }
      const note = parts.join('；');
      log(`[upgrade]     ${note}`);
      return { changed, note };
    }
  },

  {
    id: 'prune-orphan-trusted',
    title: '清理可信插件清单里指向"已不存在模块"的孤儿项',
    run({ appRoot, log, saveConfig }) {
      const builtin = readBuiltinIds(appRoot);
      const orphans = [];
      saveConfig((cfg) => {
        const list = Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins.map(String) : [];
        if (!list.length) return {};
        const keep = [];
        for (const id of list) {
          // 空项（手改配置留下的 ""）顺手清掉，它挡不住也放行不了任何东西
          if (!id) { orphans.push(id); continue; }
          // 内置基线里的：目录一定随包分发，即便这台机器的安装形态里暂时看不到
          if (builtin.has(id)) { keep.push(id); continue; }
          // 目录在 → 不是孤儿（用户装的第三方插件就属于这种）
          if (findModuleDir(appRoot, id)) { keep.push(id); continue; }
          orphans.push(id);
        }
        return orphans.length ? { trustedPlugins: keep } : {};
      });

      if (!orphans.length) return { changed: [], note: '没有孤儿项' };
      // 为什么值得清：一条指向空名字的白名单项当前什么也挡不住、也什么也不放行，
      // 但它占着名字。将来谁把目录改成这个名字，就直接绕过了能力扫描。
      // 这正是 checkPluginTrust 注释里点名的那类攻击形态（"占掉内置模块的名字"）。
      const shown = orphans.map((x) => x || '(空项)');
      const note = `已清掉 ${orphans.length} 项无主信任：${shown.join('、')}（对应的插件目录已不存在）`;
      log(`[upgrade]     ${note}`);
      return { changed: ['trustedPlugins'], removed: orphans, note };
    }
  },

  {
    // ffmpeg 曾经随包分发在 `<app>/runtime/ffmpeg.exe`（79MB，占安装包的 43%），
    // 后来改为设置页按需下载到 `data/runtime/ffmpeg/bin/`。免安装 zip 覆盖升级
    // 只写新文件、不删旧文件，所以老用户机器上那份会一直留着，且解析链还必须
    // 为它保留一条兼容候选（buildCandidates 的 ④）—— 一个纯为老版本存在的分支。
    //
    // 迁移只搬不删：删了不可恢复（用户可能正靠它工作），搬进 legacy-backup 后
    // 新版照样能用（解析链在迁移**之后**才去掉兼容候选这件事需要另一次版本发布，
    // 见 src/ffmpeg-resolve.js 文件头）。搬走之后那条候选才失去真实使用方。
    id: 'retire-bundled-ffmpeg',
    title: '把旧版随包分发的 ffmpeg 搬进备份区（新版改为按需下载到数据目录）',
    run({ appRoot, dataDir, log, now }) {
      const roots = allowedRoots({ appRoot, dataDir });
      const runtimeDir = path.join(path.resolve(appRoot), 'runtime');
      const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      // 搬移时的程序版本。状态文件顶层的 version 是**最后一次**启动的版本，
      // 之后每次启动都会把它刷成新的，所以不能拿它反推"这份备份是谁留下的"。
      const appVersion = readAppVersion(appRoot);

      // 旧随包形态历史上出现过三种：
      //   ① runtime/ffmpeg.exe            单文件（最早的形态，只有 ffmpeg 没有 ffprobe）
      //   ② runtime/ffmpeg/bin/ffmpeg.exe  目录形态（带 ffprobe 的完整包）
      //   ③ runtime/ffmpeg/               目录里直接放可执行文件
      // 非 Windows 上 ① 与 ③ 是同一个路径（可执行文件没有 .exe 后缀），所以候选
      // 按"目录 + 文件"两类收集、以**实际类型**判定，不能按文件名猜：
      //   是目录 → 只有里面真躺着 ffmpeg 才算旧随包（同名杂项目录不许误伤）；
      //   是文件 → 它就叫 ffmpeg，按单文件形态处理。
      // ⚠️ 只认 ffmpeg 这个名字：runtime/ 下还住着便携 QQ（qq-portable /
      //    qq-portable-data），那是用户正在用的数据，任何情况下都不许碰。
      const dirForm = path.join(runtimeDir, 'ffmpeg');
      const fileForm = path.join(runtimeDir, exe);
      const seen = new Set();
      const real = [];
      for (const p of [dirForm, fileForm]) {
        const abs = path.resolve(p);
        if (seen.has(abs)) continue;              // 非 Windows 上两者重合
        seen.add(abs);
        let st = null;
        try { st = fs.lstatSync(abs); } catch { continue; }   // 不存在 / 权限：当没有
        if (st.isSymbolicLink()) continue;        // 链接不跟：搬它等于搬别人家的文件
        if (st.isDirectory()) {
          if (dirContainsFfmpeg(abs, exe)) real.push(abs);
        } else if (st.isFile()) {
          real.push(abs);
        }
      }
      if (!real.length) {
        return { changed: [], note: '本机没有旧随包 ffmpeg，无需处理' };
      }

      const backupRoot = path.join(legacyBackupRoot(dataDir), `ffmpeg-${stamp}`);
      // 逐项搬；不在搬之前建目录 —— 搬移失败（如文件被占用）时留着空的时间戳
      // 目录，下次启动又会建一个，日积月累全是空壳。movePath 自己按需建父目录。
      // 逐个搬而不是整体搬：一个文件被占用不该让另一个留在原地（它下次启动重试）。
      const moved = [];
      let failed = null;
      for (const src of real) {
        try {
          const r = backupPath(src, { backupRoot, roots, name: path.basename(src) });
          moved.push(path.relative(dataDir, r.to).replace(/\\/g, '/'));
          log(`[upgrade]     已搬移 ${src} → ${r.to}`);
        } catch (error) {
          failed = failed || error;
          log(`[upgrade]     ⚠️ 搬移失败 ${src}：${error?.message ?? error}`);
        }
      }
      if (!moved.length) throw failed || new Error('旧随包 ffmpeg 搬移失败');
      // 部分失败也抛：runUpgrades 的语义是"整项成功才记 applied"，不记才有下次
      // 重试。已搬走的那些不在原位了，重试只会处理剩下的，不会重复搬。
      if (failed) throw failed;

      // data/runtime/ffmpeg/bin/ 里若用户已经下载过新版，这里什么都不做：
      // 旧的那份搬走与否都不影响新位置，绝不覆盖。
      const note = `旧随包 ffmpeg 已搬到 ${path.relative(dataDir, backupRoot).replace(/\\/g, '/')}`
        + `（共 ${moved.length} 项；未删除，确认不要了可在「设置 → 外观与数据」里清理）`;
      log(`[upgrade]     ${note}`);
      return {
        changed: moved,
        note,
        record: {
          movedTo: path.relative(dataDir, backupRoot).replace(/\\/g, '/'),
          items: moved,
          fromVersion: appVersion
        }
      };
    }
  }
];

/** 目录里（含一层 bin/）是否有可执行 ffmpeg。用于区分"旧随包目录"与同名杂项目录。 */
function dirContainsFfmpeg(dir, exe) {
  for (const cand of [path.join(dir, exe), path.join(dir, 'bin', exe)]) {
    try { if (fs.statSync(cand).isFile()) return true; } catch { /* 没有 */ }
  }
  return false;
}

/**
 * 执行所有尚未执行过的迁移项。同步、开销极小（几次 stat，最多写一次 config）。
 *
 * @param {object}  [opts]
 * @param {string}  [opts.appRoot]    程序根（默认 ROOT = resources/app）
 * @param {string}  [opts.dataDir]    数据根（默认 DATA_DIR）
 * @param {string}  [opts.version]    当前版本（默认从 appRoot/package.json 读）
 * @param {Function}[opts.log]        日志出口
 * @param {number}  [opts.now]        时间戳（测试注入）
 * @param {Function}[opts.saveConfig] 改配置的方式：(mutator) => void。
 *                                    默认走 config.js 的 updateConfig（原子读-改-写 + 落盘）；
 *                                    测试可注入内存实现，避免碰真实 config.json。
 * @param {Array}   [opts.upgrades]   迁移注册表（默认 UPGRADES）。只给测试用：
 *                                    注入一个"会抛错"的项来验证失败不阻塞，
 *                                    不必往生产注册表里塞测试项。
 * @returns {{ran:Array, skipped:string[], failed:Array, stateFile:string}}
 */
export function runUpgrades({
  appRoot = ROOT,
  dataDir = DATA_DIR,
  version = readAppVersion(appRoot),
  log = console.log,
  now = Date.now(),
  upgrades = UPGRADES,
  saveConfig = (mutator) => { updateConfig(mutator); }
} = {}) {
  const stateFile = upgradeStatePath(dataDir);
  const state = readUpgradeState(stateFile);
  const ran = [];
  const skipped = [];
  const failed = [];

  for (const up of upgrades) {
    if (state.applied[up.id]) { skipped.push(up.id); continue; }
    try {
      const r = up.run({ appRoot, dataDir, log, saveConfig, now });
      const entry = { at: new Date(now).toISOString() };
      // record 是迁移项自报的动作结果（如备份落点）。老格式只有时间戳字符串，
      // 新格式是对象 —— 两种都能被 readUpgradeState 读回同一个形态。
      if (r?.record && typeof r.record === 'object') Object.assign(entry, r.record);
      state.applied[up.id] = entry;
      ran.push({ id: up.id, title: up.title, ...(r || {}) });
      log(`[upgrade] ✅ ${up.title}${r?.note ? ` —— ${r.note}` : ''}`);
    } catch (error) {
      // 不记入 applied → 下次启动重试。也不抛出：迁移是"锦上添花"，
      // 绝不允许它把整个启动流程带下去。
      const msg = error?.message ?? String(error);
      failed.push({ id: up.id, title: up.title, error: msg });
      log(`[upgrade] ❌ ${up.title} 失败（不影响启动，下次启动会重试）：${msg}`);
    }
  }

  // 只有状态真的变了才落盘：正常启动（全部 skipped 且版本没变）零磁盘写。
  const versionChanged = state.version !== version;
  if (ran.length || failed.length || versionChanged) {
    state.version = version;
    state.updatedAt = new Date(now).toISOString();
    try {
      writeUpgradeState(stateFile, state);
    } catch (error) {
      log(`[upgrade] ⚠️ 迁移状态落盘失败（下次启动会重跑这些项，幂等，无副作用）：${error?.message ?? error}`);
    }
  }

  if (ran.length || failed.length) {
    log(`[upgrade] 版本 ${version || '(未知)'}：执行 ${ran.length} 项、失败 ${failed.length} 项、跳过 ${skipped.length} 项`
      + `（状态文件 ${path.relative(appRoot, stateFile) || stateFile}）`);
  } else if (versionChanged) {
    log(`[upgrade] 版本变更为 ${version || '(未知)'}：无待执行的迁移项`);
  }

  return { ran, skipped, failed, stateFile };
}

// ── 用户确认清理 ─────────────────────────────────────────────────────────
//
// 自动迁移只搬不删（删了不可恢复）。搬进 legacy-backup 的东西终究要有个出口，
// 但出口必须是用户点的，不能是启动时的自动行为。这一节只负责"检测"与"按用户
// 指定的路径删除"，两件事都收口在一个地方，路由层不做任何路径判断。
//
// 删除的边界比搬移更窄：只允许删 legacy-backup 里的条目，以及 `runtime/` 下
// 那几种旧 ffmpeg 形态。不允许"传什么删什么"——即使路径在 DATA_DIR 里，
// 也不能让一次误点删掉会话存档或记忆库。

/** 单次统计大小的文件数上限：残留目录通常是几十到几百个文件，超过就按已知部分报。 */
const RESIDUE_SIZE_FILE_LIMIT = 20000;

function dirSize(target, budget = { files: RESIDUE_SIZE_FILE_LIMIT }) {
  let bytes = 0;
  let files = 0;
  const walk = (p) => {
    if (budget.files <= 0) return;
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;              // 不跟链接，避免统计/删除跑到根外面
    if (st.isDirectory()) {
      let ents = [];
      try { ents = fs.readdirSync(p); } catch { return; }
      for (const name of ents) walk(path.join(p, name));
      return;
    }
    if (!st.isFile()) return;
    bytes += st.size;
    files += 1;
    budget.files -= 1;
  };
  walk(target);
  return { bytes, files, truncated: budget.files <= 0 };
}

/**
 * 检出"旧版本残留"的候选项。只检测，不动任何东西。
 *
 * 两类：
 *   ① legacy-backup 里的条目 —— 自动迁移搬进来的旧文件，确认不要了可以删；
 *   ② `<app>/runtime` 下仍存在的旧 ffmpeg 形态 —— 正常启动时已被 ① 搬走，
 *      出现在这里说明那次迁移失败或还没跑（例如用户是手动拷进来的）。
 *
 * @returns {{items: Array, roots: string[]}}
 */
export function detectLegacyResidue({ appRoot = ROOT, dataDir = DATA_DIR } = {}) {
  const items = [];
  const backupRoot = legacyBackupRoot(dataDir);
  let state = { applied: {} };
  try { state = readUpgradeState(upgradeStatePath(dataDir)); } catch { /* 状态读不到不影响检测 */ }
  const ffmpegRecord = normalizeAppliedEntry(state.applied['retire-bundled-ffmpeg']);

  // ① 备份区：每个子项一条。大小现算（用户点开设置页才调，不做缓存）。
  let entries = [];
  try { entries = fs.readdirSync(backupRoot, { withFileTypes: true }); } catch { /* 没有备份区 */ }
  for (const e of entries) {
    const abs = path.join(backupRoot, e.name);
    const size = dirSize(abs);
    const isFfmpegBackup = e.name.startsWith('ffmpeg-');
    items.push({
      id: `legacy-backup:${e.name}`,
      label: isFfmpegBackup ? '旧版随包 ffmpeg' : e.name,
      path: abs,
      relPath: path.relative(dataDir, abs).replace(/\\/g, '/'),
      sizeBytes: size.bytes,
      files: size.files,
      sizeTruncated: size.truncated,
      // "属于哪个版本"：搬移那一刻的执行时间与程序版本都存在 record 里。
      // 状态文件顶层的 version 不能用 —— 它每次启动都会被刷成最新值。
      migratedAt: ffmpegRecord?.at || '',
      fromVersion: String(ffmpegRecord?.fromVersion || ''),
      action: '删除（不可恢复）',
      kind: 'legacy-backup'
    });
  }

  // ② 还没搬走的旧随包 ffmpeg（迁移失败 / 手动拷入）。
  // 非 Windows 上 `runtime/ffmpeg` 这一个路径同时是"单文件形态"和"目录形态"
  // （可执行文件没有 .exe 后缀），所以按解析后的绝对路径去重，否则同一项会被
  // 列两次，用户勾一下删两次。
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const runtimeDir = path.join(path.resolve(appRoot), 'runtime');
  const seenRuntime = new Set();
  for (const cand of [path.join(runtimeDir, exe), path.join(runtimeDir, 'ffmpeg')]) {
    const abs = path.resolve(cand);
    if (seenRuntime.has(abs)) continue;
    seenRuntime.add(abs);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory() && !dirContainsFfmpeg(abs, exe)) continue;
    const size = dirSize(abs);
    items.push({
      id: `runtime:${path.basename(abs)}`,
      label: '旧版随包 ffmpeg（还没搬走）',
      path: abs,
      relPath: path.relative(path.resolve(appRoot), abs).replace(/\\/g, '/'),
      sizeBytes: size.bytes,
      files: size.files,
      sizeTruncated: size.truncated,
      migratedAt: '',
      fromVersion: '',
      action: '删除（不可恢复）；下次启动也会自动搬进备份区',
      kind: 'runtime-pending'
    });
  }

  return { items, roots: allowedRoots({ appRoot, dataDir }) };
}

/**
 * 删除用户勾选的残留项。**逐项重新校验**，不信任前端传来的任何东西：
 *   ① 必须是绝对路径，且通过 assertSafePath（越界 / 根目录 / 符号链接全拒）；
 *   ② 必须落在 legacy-backup 之内，或等于某个已知的旧 ffmpeg 形态；
 *   ③ 不存在视为已删（幂等），不报错。
 * 任何一项校验失败只跳过它并回报原因，不影响其余项。
 *
 * @returns {{removed:string[], skipped:Array<{path:string, reason:string}>, freedBytes:number}}
 */
export function removeLegacyResidue({ paths, appRoot = ROOT, dataDir = DATA_DIR, log = () => {} } = {}) {
  const roots = allowedRoots({ appRoot, dataDir });
  const backupRoot = path.join(path.resolve(dataDir), 'runtime', 'legacy-backup');
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const runtimeDir = path.join(path.resolve(appRoot), 'runtime');
  const allowedExact = new Set([path.join(runtimeDir, exe), path.join(runtimeDir, 'ffmpeg')]);

  const removed = [];
  const skipped = [];
  let freedBytes = 0;
  for (const raw of (Array.isArray(paths) ? paths : [])) {
    try {
      const abs = assertSafePath(raw, roots);
      // 二次收窄：只在备份区里，或恰好是已知的旧 ffmpeg 形态
      const inBackup = isStrictlyInside(backupRoot, abs);
      if (!inBackup && !allowedExact.has(abs)) {
        throw new Error('不在可清理范围内（只允许备份区与旧 ffmpeg 位置）');
      }
      const size = dirSize(abs);
      const r = removePath(abs, { roots });
      if (r.removed) {
        removed.push(abs);
        freedBytes += size.bytes;
        log(`[maintenance] 已删除残留 ${abs}（${size.files} 个文件）`);
      }
    } catch (error) {
      skipped.push({ path: String(raw ?? ''), reason: error?.message ?? String(error) });
    }
  }
  return { removed, skipped, freedBytes };
}

export { readAppVersion, readBuiltinIds, findModuleDir };
// CONFIG_FILE 仅用于排障日志的语义完整性（迁移改的就是它），显式再导出一份便于外部引用
export { CONFIG_FILE };
