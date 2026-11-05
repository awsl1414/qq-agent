// 版本迁移：逐版本累加的**迁移注册表**，负责所有跨版本的数据搬迁与清理。
//
// 它不只为某一种文件存在。凡是"新版本换了位置、换了名字、换了存储形态，
// 而用户的磁盘上还留着旧形态"的情况，都归这里：旧插件目录与配置引用、
// 旧随包二进制、运行时目录结构调整……一次升级要做的事，在这里加一项。
//
// 为什么需要这一层：用户数据（data/）不在安装清单里，exe 安装器升级时不碰它，
// 免安装 zip 覆盖更不会。于是"程序目录里已经被删掉的模块/文件"会以两种形式
// 继续存在：① 它的目录还在（覆盖路径只写新文件、不删旧文件）；② 指向它的
// 配置引用还在（config.json 的 trustedPlugins / skills）。两者叠加就出事。
// 0.4.8.5 的真实例子：内置记忆插件从 `conversation-memory` 整体换血为
// `mem-layered`，而老用户 config 的 trustedPlugins 里还留着
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
// 迁移只做一件事：把旧位置的残留搬到当前版本的**正式位置**，或者删掉。
// 它不替用户保管历史文件 —— 没有"备份区"，也没有"从备份还原"这条路。
//
// 为什么不留备份（三条，任一条都足够）：
//   · 没有消费方：除了本模块，全仓没有任何代码读备份目录，也没有还原入口；
//   · 不保证当前版本运行：解析链只认正式位置（ffmpeg-resolve.js 的
//     buildCandidates）。把旧 ffmpeg 搬进备份 = 从"旧的可达位置"搬到"新的
//     不可达位置"，功能反而降级，什么都没换来；
//   · 两条路径上都不需要它：迁移失败时原文件本来就没动（runUpgrades 不记
//     applied，下次重试）；迁移成功时文件已经在正式位置。没有"需要回滚"的场景。
//
// 三条硬约束：
//   ① 删除的边界：只删本模块自己认定属于「项目自带物」的文件（随安装包分发、
//      用户从未主动创建、新版有正式来源），且删除前必须过 assertSafePath。
//      用户资产 —— 群聊、记忆、API Key、用户装的扩展、便携 QQ 及其登录态
//      （qq-portable-data）—— 依然绝不删除、绝不搬走。判定标准不是"它在不在
//      数据目录里"，而是"用户有没有为它做过选择"。
//   ② 幂等：已执行过的 id 永不重跑；动作本身也要能重复执行而不叠加。
//   ③ 失败不阻塞启动：单项抛错只记日志（且不记入 applied，下次重试），
//      其余项与整个启动流程照常继续。
//
// 运行时目录的规范形态（`data/runtime/` 是唯一的运行时根）：
//   data/runtime/ffmpeg/bin/        设置页下载的 ffmpeg（也是旧随包 ffmpeg 的落点）
//   data/runtime/qq-portable/       便携 QQ 副本（历史上在 <app>/runtime/ 下）
//   data/runtime/qq-portable-data/  便携 QQ 的隔离登录态（同上）
// 历史上 `runtime/` 同时挂在程序目录与数据目录两个父目录下，迁移项
// relocate-portable-qq 与 retire-bundled-ffmpeg 把它收敛到数据目录；
// 解析口径见 runtimeDirPath。
//
// 调用点：src/app.js 的 start() 开头，必须在 reloadSkills({reason:'boot'})
// 之前，因为插件扫描会读 trustedPlugins，晚一步就白做。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, CONFIG_FILE, updateConfig } from './config.js';
// 正式落点与可执行文件名都以 ffmpeg-resolve 为准：迁移搬去的目录必须和解析链
// 认的是同一个，各写一份迟早会漂移。
import { managedBinDir, exeName } from './ffmpeg-resolve.js';

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
 * 只有两处：数据目录（迁移的正式落点都在这里），以及程序根下的 runtime/
 * （历史版本随包分发的 ffmpeg 就在那儿，是**源**而不是落点）。**刻意不包含 appRoot 本身**：它装着
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
// 迁移项的搬移与删除都走这里，不各写一遍 rename/copy/rm。

/**
 * 原子搬移。同盘走 rename；跨盘（EXDEV，数据目录与程序目录常在不同分区）
 * 降级为 copy + 删除。任一步失败都保持"原文件还在"：跨盘时若复制成功而删除
 * 失败，会把复制出来的那份也清掉再抛错，绝不留下半套。
 *
 * 目标已存在时默认抛错（不覆盖），这是幂等要求的一部分：重复执行不能把
 * 上一次搬过去的那份盖掉。
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
 * 只走 rename 的搬移：跨盘（EXDEV）直接失败，绝不降级成复制。
 *
 * 与 movePath 的差别只在跨盘这一条：movePath 面对 EXDEV 会 copy + 删源，
 * 对几十 MB 的 ffmpeg 可以接受；便携 QQ 是 1.5GB，复制一次要几分钟、还要占双份
 * 空间，中途失败可能留下半套。这里宁可不搬，把决定权交回用户。
 *
 * 目标已存在时默认抛错（不覆盖）：迁移项自己判"目标已存在 → 跳过"，
 * 走到这里说明判断之外还有竞态，覆盖会把用户手工放进去的那份盖掉。
 */
export function renamePath(src, dest, { roots, overwrite = false } = {}) {
  const from = assertSafePath(src, roots);
  const to = assertSafePath(dest, roots);
  if (from === to) throw new Error(`源与目标相同：${from}`);
  if (isStrictlyInside(from, to)) throw new Error(`拒绝把目录搬进它自己里面：${to}`);
  if (!overwrite && fs.existsSync(to)) throw new Error(`目标已存在，不覆盖：${to}`);

  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error?.code === 'EXDEV') {
      // 跨设备：数据目录与程序目录不在同一分区。不用 copy 兜底的原因见函数头。
      throw new Error(`源与目标不在同一磁盘分区，已放弃搬移（不做复制）：${from} → ${to}`);
    }
    throw error;
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

// ── 运行时目录 ──────────────────────────────────────────────────────────
//
// 运行时内容的规范根只有一处：`DATA_DIR/runtime/`。历史上 `runtime/` 同时挂在
// 程序目录（随包 ffmpeg、便携 QQ）与数据目录（下载的 ffmpeg）下，同名不同父。
// 迁移项 relocate-portable-qq 把便携 QQ 挪进数据目录，之后这里只留一条口径。

/** 便携 QQ 的两个运行时目录名（安装目录 + 隔离登录态）。 */
const PORTABLE_RUNTIME_NAMES = ['qq-portable', 'qq-portable-data'];

/**
 * 解析一个运行时子目录的实际位置。
 *
 * 顺序：`DATA_DIR/runtime/<name>` 存在就用它；否则回落 `<app>/runtime/<name>`；
 * 两处都没有就返回数据目录下的**规范位置**（新建内容一律落在数据目录）。
 *
 * 回落不是"留兼容代码"，而是迁移成功之前用户必须能继续用便携 QQ：迁移项
 * relocate-portable-qq 在便携 QQ 运行时会 rename 失败（文件被占用），那一轮
 * 启动里便携 QQ 仍在程序目录，解析必须找得到它，否则"QQ 明明装着却显示未安装"。
 * 迁移成功后程序目录那份已不存在，回落分支自然落空 —— 不需要另立删除时机。
 */
export function runtimeDirPath(name, { appRoot = ROOT, dataDir = DATA_DIR } = {}) {
  const canonical = path.join(path.resolve(dataDir), 'runtime', String(name));
  try { if (fs.existsSync(canonical)) return canonical; } catch { /* 权限/盘掉了：按不存在处理 */ }
  const legacy = path.join(path.resolve(appRoot), 'runtime', String(name));
  try { if (fs.existsSync(legacy)) return legacy; } catch { /* 同上 */ }
  return canonical;
}

/** 取一个路径所在设备的 dev（用于判断 rename 是否跨盘）。路径不存在时看最近的真实祖先。 */
function deviceOf(p) {
  const real = nearestReal(p);
  if (!real) return null;
  try { return fs.statSync(real).dev; } catch { return null; }
}

/** 目录是否为空（读不到当作非空：宁可跳过也不合并/删除）。 */
function dirIsEmpty(dir) {
  try { return fs.readdirSync(dir).length === 0; } catch { return false; }
}

// ── 迁移注册表 ────────────────────────────────────────────────────────────
// 加一项只需在此追加一个对象。惯例：
//   - id 一旦发布永不修改（它是幂等账本的键，改了等于让它再跑一次）；
//   - label 是给用户看的人类可读名字（日志与排障用，界面不再消费它）；
//   - run() 只在三种动作里选：改配置、把旧位置的残留搬到正式位置、删除本模块
//     认定属于项目自带物的文件。**不碰用户资产**（见文件头第 ① 条）；
//   - 返回 { changed: string[], note?: string, record?: object }，
//     record 会连同执行时间写进状态文件的 applied 里（如 movedTo）。

export const UPGRADES = [
  {
    id: 'retire-conversation-memory',
    label: '旧版记忆插件',
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
      log.info(`[upgrade]     ${note}`);
      return { changed, note };
    }
  },

  {
    id: 'prune-orphan-trusted',
    label: '无主信任项',
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
      log.info(`[upgrade]     ${note}`);
      return { changed: ['trustedPlugins'], removed: orphans, note };
    }
  },

  {
    // ffmpeg 曾经随包分发在 `<app>/runtime/ffmpeg.exe`（79MB，占安装包的 43%），
    // 后来改为按需下载到 `data/runtime/ffmpeg/bin/`。免安装 zip 覆盖升级只写
    // 新文件、不删旧文件，所以老用户机器上那份会一直留着。
    //
    // 落点是**正式位置**（managedBinDir），不是备份区：解析链只认正式位置，
    // 搬进备份等于把功能从"旧的可达位置"挪到"新的不可达位置"。目标已经有
    // ffmpeg 时旧的那份没有保留价值，直接删 —— 这些文件随安装包分发、用户从未
    // 主动创建，新版也有正式来源，符合文件头第 ① 条的删除边界。
    //
    // 幂等靠"按目标逐个判断"，不靠时间戳目录：同名文件已在正式位置就不能再搬
    // （rename 不覆盖），只能删。部分失败后重试时，已搬走的不在原位，剩下那些
    // 会重新按目标现状判断，不会重复搬、也不会把缺的 ffprobe 一并删掉。
    id: 'retire-bundled-ffmpeg',
    label: '旧版随包 ffmpeg',
    title: '把旧版随包分发的 ffmpeg 移到正式位置（新版改为按需下载到数据目录）',
    run({ appRoot, dataDir, log }) {
      const roots = allowedRoots({ appRoot, dataDir });
      const runtimeDir = path.join(path.resolve(appRoot), 'runtime');
      const exe = exeName('ffmpeg');
      const targetDir = managedBinDir(dataDir);

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
      // 每一项 = { root: 旧包根（目录形态才有）, dir: 可执行文件所在目录, entries? }
      //
      // 目录形态的 dir 一律取 `ffmpeg/bin/` 再回落到根，**不按"哪边先有 ffmpeg"
      // 猜**：两类形态下 ffprobe 可能与 ffmpeg 不在同一层，只取一边会把另一个
      // 漏掉。逐个候选都扫一遍，用 seen 去重即可。
      const sources = [];
      for (const p of [dirForm, fileForm]) {
        const abs = path.resolve(p);
        if (seen.has(abs)) continue;              // 非 Windows 上两者重合
        seen.add(abs);
        let st = null;
        try { st = fs.lstatSync(abs); } catch { continue; }   // 不存在 / 权限：当没有
        if (st.isSymbolicLink()) continue;        // 链接不跟：搬它等于搬别人家的文件
        if (st.isDirectory()) {
          if (!dirHasFfmpegResidue(abs, exe)) continue;
          sources.push({ root: abs, dir: abs });
          sources.push({ root: abs, dir: path.join(abs, 'bin') });
        } else if (st.isFile()) {
          sources.push({ root: null, dir: runtimeDir, entries: [exe] });
        }
      }
      if (!sources.length) {
        return { changed: [], note: '本机没有旧随包 ffmpeg，无需处理' };
      }

      // ── 收集阶段：按**目标文件名**去重，每个名字只保留一个来源 ──
      //
      // 上面收集的是"要扫的目录"，不是"要搬的文件"。旧包历史上可能同时在
      // `ffmpeg/` 根与 `ffmpeg/bin/` 下都有 ffprobe，于是同一个目标名会有两个
      // 来源。若直接带着 dup 往下走，循环里第二个来源会把第一个**刚搬过去的**
      // 文件当成"目标已有、清掉让路"，再 rename 覆盖 —— 第一个文件静默丢失，
      // 而 changed 里记了两次、日志两次都说"已搬移"，零报错。
      //
      // 所以在这里一次性收口：先扫出全部候选，按目标名去重，再进动作阶段。
      // 去重规则是"根优先"——历史上根目录那份是主安装，bin/ 是补丁层。
      const wanted = new Set([exe, exeName('ffprobe')]);
      const picks = new Map();   // 目标文件名 → { from, root }
      const skipped = [];        // 符号链接：不跟，不搬也不删
      const duplicated = [];     // 同一目标名的多余来源，留在原位不动
      for (const src of sources) {
        // 只取可执行文件本体（ffmpeg + 配套 ffprobe）。目录形态里可能还躺着
        // 许可证、README 之类，它们对运行无用，搬进 bin/ 只会让"已安装目录"
        // 里多出无主文件；留在原地，由 pruneEmptyDir 判断旧目录是否已空。
        let present = src.entries;
        if (!present) {
          try { present = fs.readdirSync(src.dir); } catch { continue; }
        }
        for (const name of present.filter((n) => wanted.has(n))) {
          const from = path.join(src.dir, name);
          let st = null;
          try { st = fs.lstatSync(from); } catch { continue; }   // 根目录形态下会混进目录，跳过
          if (st.isSymbolicLink()) { skipped.push(from); continue; }
          if (!st.isFile()) continue;
          const prev = picks.get(name);
          if (prev) {
            // 同名的第二个来源：不搬、不删，留原处交给 pruneEmptyDir 收尾。
            // 记下来是为了日志能解释"为什么旧目录里还剩一个文件"。
            duplicated.push({ name, kept: prev.from, ignored: from });
            continue;
          }
          picks.set(name, { from, root: src.root });
        }
      }
      if (!picks.has(exe) && !picks.has(exeName('ffprobe'))) {
        return { changed: [], note: '本机没有旧随包 ffmpeg，无需处理' };
      }
      const sourceHadFfprobe = picks.has(exeName('ffprobe'));

      // ── 动作阶段 ──
      // 正式位置的状态只按**可执行文件是否存在**判断，不看目录在不在：
      // 上次搬到一半留下的空壳目录必须能覆盖。ffprobe 的目标状态单独取，
      // 因为"目标有没有 ffprobe"决定了旧包里那份该搬还是该删。
      // 这个快照现在就安全了：动作阶段每个目标名只会被处理一次。
      const targetHasFfprobe = isFile(path.join(targetDir, exeName('ffprobe')));

      const moved = [];
      const deleted = [];
      const errors = [];
      let movedFfprobe = false;

      for (const [name, { from }] of picks) {
        const to = path.join(targetDir, name);
        // 正式位置已有同名文件 → 新版是唯一来源，旧的那份删掉。
        //
        // ffprobe 单独判：它不是"新旧两份挑新的"，而是 ffmpeg 的配套。
        // 目标那份 ffmpeg 若是设置页下载的、可能自带 ffprobe；不带时
        // （Windows 老包）旧包这唯一的 ffprobe 必须搬过去，不能删 ——
        // 否则视频抽帧 / 时长探测退化而图片压缩照常，这种半坏状态最难排查。
        const conflict = fs.existsSync(to);
        // 「目标已存在」的两类处理合并成一条：凡是目标已有可执行文件（ffmpeg 本身，
        // 或 ffprobe 且目标已有可用的 ffprobe），就以目标为准、删掉旧的。
        const targetWins = conflict && (name !== exeName('ffprobe') || targetHasFfprobe);
        if (targetWins) {
          try {
            removePath(from, { roots });
            deleted.push(from);
            log.info(`[upgrade]     已删除旧随包 ${from}（正式位置已有 ${to}）`);
          } catch (error) {
            errors.push(`删除 ${from} 失败：${error?.message ?? error}`);
            log.warn(`[upgrade]     ⚠️ 删除失败 ${from}：${error?.message ?? error}`);
          }
          continue;
        }
        if (conflict) {
          // 目标那个同名条目不是可执行文件（目录壳之类）：让路，只清这一个条目。
          // 走到这里说明是 ffprobe、目标没有可用的 ffprobe，且目标位置被别的东西占着。
          try { removePath(to, { roots }); } catch { /* 删不掉就让下面的 rename 报错 */ }
        }

        // 跨盘判断：先比 dev，比不出（路径不存在）就交给 rename 的 EXDEV。
        // 不做复制兜底 —— 与 relocate-portable-qq 同一条取舍。
        const srcDev = deviceOf(from);
        const destDev = deviceOf(to);
        if (srcDev !== null && destDev !== null && srcDev !== destDev) {
          throw new Error(`跨磁盘分区（dev ${srcDev} → ${destDev}），不做复制，已放弃：${from} → ${to}`
            + '（本次不记完成，下次启动会重试）');
        }

        const r = renamePath(from, to, { roots });
        moved.push(r.to);
        if (name === exeName('ffprobe')) movedFfprobe = true;
        log.info(`[upgrade]     已搬移 ${r.from} → ${r.to}`);
      }

      // 旧包目录在整轮动作之后统一收尾，而不是每处理一个目录就 prune 一次：
      // 目录形态会产生两条 source（根 + bin/），逐个 prune 时先清的是 bin/、
      // 根目录里可能还剩空 bin，于是根留了下来。收尾按"从深到浅"清，一次到位。
      const pruneTargets = new Set();
      for (const src of sources) {
        if (!src.root) continue;       // 单文件形态就在 <app>/runtime/ 根上，不能删它
        pruneTargets.add(src.root);
        pruneTargets.add(src.dir);
      }
      for (const dir of [...pruneTargets].sort((a, b) => b.length - a.length)) pruneEmptyDir(dir);

      // 删除失败也整项算失败：文件被占用（Windows 上很常见）时这一轮清不掉，
      // 记成完成就等于永远留着它。已成功的那些已在原位消失，重试只会处理剩下的。
      if (errors.length) {
        const done = moved.length + deleted.length ? `（已处理 ${moved.length + deleted.length} 项）` : '';
        throw new Error(`${errors.join('；')}${done}`);
      }

      // 同名文件出现两份来源时只搬一个，另一份原样留在旧目录里（不删非空目录）。
      // 用户会在程序目录下看到一个残留的 ffmpeg 目录，日志必须解释它是怎么来的，
      // 否则下次排查会以为迁移没跑完。
      if (duplicated.length) {
        for (const d of duplicated) {
          log.warn(`[upgrade]     同名文件有多个来源，保留 ${d.kept}，忽略 ${d.ignored}（留在原位不删）`);
        }
      }

      if (moved.length) {
        return {
          changed: moved,
          note: `旧随包 ffmpeg 已移到正式位置 ${path.relative(dataDir, targetDir).replace(/\\/g, '/')}`
            + `（搬入 ${moved.length} 项${deleted.length ? `，删除 ${deleted.length} 项` : ''}）`
            + ffprobeNote({ sourceHadFfprobe, movedFfprobe, targetHasFfprobe })
            + (duplicated.length ? `；另有 ${duplicated.length} 份同名文件留在原处未处理` : ''),
          record: {
            movedTo: path.relative(dataDir, targetDir).replace(/\\/g, '/'),
            items: moved,
            fromVersion: readAppVersion(appRoot)
          }
        };
      }

      if (deleted.length) {
        const note = `旧随包 ffmpeg 已删除（正式位置 ${path.relative(dataDir, targetDir).replace(/\\/g, '/')} 已有可用的那份）`
          + ffprobeNote({ sourceHadFfprobe, movedFfprobe, targetHasFfprobe: true });
        log.info(`[upgrade]     ${note}`);
        return { changed: deleted, note };
      }

      const why = skipped.length ? `有 ${skipped.length} 项是符号链接，已跳过（不跟链接动别人家的文件）` : '没有可搬移的内容';
      return { changed: [], note: `无需搬移：${why}` };
    }
  },

  {
    // 便携 QQ 的运行时目录改挂在数据目录下。
    //
    // 为什么搬：`runtime/` 这个名词此前同属两个父目录 —— 程序目录下的
    // `runtime/qq-portable`（约 1.5GB）与数据目录下的 `runtime/ffmpeg`。同一个
    // 名字两处含义，用户备份/迁移/换机时不知道该拷哪一个，卸载时也不知道
    // 哪份会被删。统一到 `DATA_DIR/runtime/` 之后只有一处运行时根。
    //
    // 平台：便携 QQ 只在 Windows 有实际内容（detectLocalQqDirOnce 在非 win32
    // 直接返回 null，进程枚举与 QQ.exe 匹配全是 win32 分支）。mac/Linux 上
    // `<app>/runtime/qq-portable` 永远是空目录或不存在的目录，"没有可搬的内容"
    // 就是这条迁移项在这些平台上的正常路径，不需要平台分支。
    id: 'relocate-portable-qq',
    label: '便携 QQ 运行时目录',
    title: '把便携 QQ 的运行时目录搬进数据目录（runtime/ 统一挂在 data/ 下）',
    run({ appRoot, dataDir, log }) {
      const roots = allowedRoots({ appRoot, dataDir });
      const legacyRuntime = path.join(path.resolve(appRoot), 'runtime');
      const canonicalRuntime = path.join(path.resolve(dataDir), 'runtime');

      const moved = [];
      const skipped = [];
      const failed = [];

      for (const name of PORTABLE_RUNTIME_NAMES) {
        const src = path.join(legacyRuntime, name);
        const dest = path.join(canonicalRuntime, name);

        let srcStat = null;
        try { srcStat = fs.lstatSync(src); } catch { /* 不存在：本平台没有便携 QQ，正常路径 */ }
        if (!srcStat) { skipped.push({ name, reason: '不存在' }); continue; }
        if (srcStat.isSymbolicLink()) {
          skipped.push({ name, reason: '是符号链接，不搬（不跟链接动别人的文件）' });
          continue;
        }

        // 目标已存在：可能上次已经搬过、或用户手动放了一份。
        // 两个 1.5GB 目录不许合并 —— 合并既慢又会产生"哪份是真的"的歧义。
        // 空目录视为可覆盖（上次搬了一半留下的壳），非空一律跳过并记日志。
        let destStat = null;
        try { destStat = fs.lstatSync(dest); } catch { /* 正常：目标还没有 */ }
        if (destStat) {
          if (!destStat.isDirectory() || !dirIsEmpty(dest)) {
            const reason = `目标已存在且非空，跳过（不合并）：${dest}`;
            skipped.push({ name, reason });
            log.warn(`[upgrade]     ⚠️ ${reason}`);
            continue;
          }
          try { fs.rmdirSync(dest); } catch { /* 删不掉就让下面的 rename 去报错 */ }
        }

        // 跨盘判断：先比 dev，比不出（路径不存在）就交给 rename 的 EXDEV。
        // 两种都覆盖了，先比是为了在日志里给出"跨盘"这个具体原因，而不是
        // 一句笼统的失败。
        const srcDev = deviceOf(src);
        const destDev = deviceOf(dest);
        if (srcDev !== null && destDev !== null && srcDev !== destDev) {
          failed.push({ name, error: `跨磁盘分区（dev ${srcDev} → ${destDev}），不做复制，已放弃` });
          continue;
        }

        try {
          const r = renamePath(src, dest, { roots });
          moved.push(path.relative(dataDir, r.to).replace(/\\/g, '/'));
          log.info(`[upgrade]     已搬移 ${r.from} → ${r.to}`);
        } catch (error) {
          // 常见原因：便携 QQ 正在运行，Windows 上文件被占用，rename 失败。
          // 不为此新增进程扫描 —— 框架本来就是"失败不阻塞、下次启动重试"，
          // 用户关掉 QQ 后重启应用即可。
          const msg = error?.message ?? String(error);
          failed.push({ name, error: msg });
          log.warn(`[upgrade]     ⚠️ 搬移失败 ${src}：${msg}（可能因为便携 QQ 正在运行、文件被占用）`);
        }
      }

      if (failed.length) {
        const detail = failed.map((f) => `${f.name}：${f.error}`).join('；');
        const done = moved.length ? `（已搬走 ${moved.join('、')}）` : '';
        // 整项算失败 → 不进 applied → 下次启动重试。已搬走的那部分不在原位了，
        // 重试会跳过它（源不存在），只处理剩下的。
        throw new Error(`${detail}${done}（若是便携 QQ 正在运行导致文件被占用，完全退出 QQ 后重启应用即可；本条会在下次启动重试）`);
      }

      if (!moved.length) {
        const why = skipped.length ? skipped.map((s) => `${s.name}（${s.reason}）`).join('、') : '没有便携 QQ 目录';
        return { changed: [], note: `无需搬移：${why}` };
      }

      const note = `便携 QQ 运行时目录已搬进数据目录：${moved.join('、')}`
        + `（源目录 ${path.relative(path.resolve(appRoot), legacyRuntime).replace(/\\/g, '/') || 'runtime'} 下已移除）`;
      log.info(`[upgrade]     ${note}`);
      return {
        changed: moved,
        note,
        record: {
          movedTo: path.relative(dataDir, canonicalRuntime).replace(/\\/g, '/'),
          items: moved,
          fromVersion: readAppVersion(appRoot)
        }
      };
    }
  }
];

/**
 * 目录里（含一层 bin/）是否有 ffmpeg 或 ffprobe 的残留。
 *
 * 用于区分"旧随包目录"与同名杂项目录。**认 ffprobe 也算**：上一轮迁移可能只搬走
 * 了 ffmpeg、ffprobe 那一步失败（文件被占用），此时目录里只剩 ffprobe。若只在
 * 有 ffmpeg 时才认，这份 ffprobe 会永远留在旧位置，而它正是"视频抽帧能用、
 * 时长探测退化"那个难以排查的半坏状态。
 */
function dirHasFfmpegResidue(dir, exe) {
  for (const base of [exe, exeName('ffprobe')]) {
    for (const cand of [path.join(dir, base), path.join(dir, 'bin', base)]) {
      try { if (fs.statSync(cand).isFile()) return true; } catch { /* 没有 */ }
    }
  }
  return false;
}

/** 是否是普通文件（目录、坏链、没权限一律 false）。 */
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 旧目录搬空后顺手删掉，只删**空**目录。
 * 目录里还有别的东西（许可证、用户手放的文件）就原样留着：删它没有收益，
 * 而误删一个非空目录的代价是数据。删不掉（被占用/只读）也不报错 —— 下次启动
 * 重跑时它还在，但那已经不是迁移的职责了。
 */
function pruneEmptyDir(dir) {
  if (!dir) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* 不存在、非空、无权限：都当作"不需要清理" */ }
}

/**
 * ffprobe 缺失时的日志说明。
 *
 * 单文件形态的旧随包只有 ffmpeg、没有 ffprobe（最早的包就是这样），搬到正式
 * 位置后视频抽帧 / 时长探测会退回解析 ffmpeg -i 的 stderr，图片压缩照常。
 * 这种"半好"状态最容易被当成 bug 排查半天，所以必须在日志里说清。
 */
function ffprobeNote({ sourceHadFfprobe, movedFfprobe, targetHasFfprobe }) {
  if (!sourceHadFfprobe) {
    return '；旧包里没有 ffprobe（单文件形态），视频抽帧/时长探测将退回解析 ffmpeg -i 输出';
  }
  if (movedFfprobe) return '；ffprobe 已随 ffmpeg 一起搬到正式位置';
  if (targetHasFfprobe) return '；正式位置已有 ffprobe，旧包里那份未保留';
  return '；⚠️ 旧包里的 ffprobe 没能搬过去，视频抽帧/时长探测会退化';
}

/**
 * 执行所有尚未执行过的迁移项。同步、开销极小（几次 stat，最多写一次 config）。
 *
 * @param {object}  [opts]
 * @param {string}  [opts.appRoot]    程序根（默认 ROOT = resources/app）
 * @param {string}  [opts.dataDir]    数据根（默认 DATA_DIR）
 * @param {string}  [opts.version]    当前版本（默认从 appRoot/package.json 读）
 * @param {object}  [opts.log]        分级日志对象 {info,warn}（见 logger.js 的 subLogger）。
 *                                    迁移本身的成功/跳过是 info，单项失败与状态落盘失败是 warn：
 *                                    它们都不阻塞启动，下次启动会重试。
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
  log = console,
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
      // record 是迁移项自报的动作结果（如 movedTo 落点）。老格式只有时间戳字符串，
      // 新格式是对象 —— 两种都能被 readUpgradeState 读回同一个形态。
      if (r?.record && typeof r.record === 'object') Object.assign(entry, r.record);
      state.applied[up.id] = entry;
      ran.push({ id: up.id, title: up.title, ...(r || {}) });
      log.info(`[upgrade] ✅ ${up.title}${r?.note ? ` —— ${r.note}` : ''}`);
    } catch (error) {
      // 不记入 applied → 下次启动重试。也不抛出：迁移是"锦上添花"，
      // 绝不允许它把整个启动流程带下去。
      const msg = error?.message ?? String(error);
      failed.push({ id: up.id, title: up.title, error: msg });
      log.warn(`[upgrade] ❌ ${up.title} 失败（不影响启动，下次启动会重试）：${msg}`);
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
      log.warn(`[upgrade] ⚠️ 迁移状态落盘失败（下次启动会重跑这些项，幂等，无副作用）：${error?.message ?? error}`);
    }
  }

  if (ran.length || failed.length) {
    log.info(`[upgrade] 版本 ${version || '(未知)'}：执行 ${ran.length} 项、失败 ${failed.length} 项、跳过 ${skipped.length} 项`
      + `（状态文件 ${path.relative(appRoot, stateFile) || stateFile}）`);
  } else if (versionChanged) {
    log.info(`[upgrade] 版本变更为 ${version || '(未知)'}：无待执行的迁移项`);
  }

  return { ran, skipped, failed, stateFile };
}

export { readAppVersion, readBuiltinIds, findModuleDir };
// CONFIG_FILE 仅用于排障日志的语义完整性（迁移改的就是它），显式再导出一份便于外部引用
export { CONFIG_FILE };
