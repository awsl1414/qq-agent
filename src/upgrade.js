// 版本迁移：处理"跨版本升级后留在用户磁盘/配置里的残留"。
//
// ── 为什么需要这一层（2026-10-17 新增）────────────────────────────────────
// 用户数据（data/）**不在安装清单里**：exe 安装器升级时不碰它，免安装 zip
// 覆盖更不会。于是"程序目录里已经被删掉的模块"会以两种形式继续存在：
//   ① 它的**目录**还在 —— 免安装覆盖路径（解压只写新文件、不删旧文件）；
//   ② 指向它的**配置引用**还在 —— config.json 的 trustedPlugins / skills。
// 两者叠加就出事。0.4.8.5 的真实例子：内置记忆插件从 `conversation-memory`
// 整体换血为 `mem-layered`，而老用户 config 的 trustedPlugins 里还留着
// `conversation-memory` —— 而信任闸（plugin-loader.js 的 checkPluginTrust）
// **按目录名直接放行、不看基线指纹**，于是残留的旧插件照常加载，与新插件
// 争同名能力。后果是三条叠加（详见 plugins/mem-layered/lib/conflict.js）：
//   · 钩子叠加：runHook 遍历**所有**已激活 Skill → 两边都往最后一条 user
//     消息追加记忆 → 内容重复、token 翻倍；
//   · 能力先注册者赢：api.capability 只取第一个提供者，`conversation-memory`
//     (c) 按目录名排在 `mem-layered`(m) **之前** → 模型主动检索查到的是旧
//     数据根，新插件的数据在磁盘上却查不到，**且不报错**；
//   · 双定时器：两边各跑一份后台巩固。
//
// ── 与 config.js 的 LEGACY_SKILL_MIGRATIONS 的分工（两者不重叠）──────────
//   · 那边是**纯字段映射**：无副作用、每次启动都跑、靠"目标字段不存在"幂等。
//   · 这边是**有副作用的动作**：要 stat 磁盘、要改配置、要打日志，
//     幂等靠 data/upgrade-state.json 里的"已执行 id"。
//   纯映射能表达的事情继续留在那边，不要搬进来 —— 否则两套幂等机制会打架。
//
// ── 三条硬约束 ───────────────────────────────────────────────────────────
//   ① **不删用户文件**：只改配置与本模块自己的状态文件。想动磁盘上别的东西
//      的迁移项，先在这里把备份写进动作里，否则不许加。
//   ② **幂等**：已执行过的 id 永不重跑；动作本身也要能重复执行而不叠加。
//   ③ **失败不阻塞启动**：单项抛错只记日志（且**不记入 applied**，下次重试），
//      其余项与整个启动流程照常继续。
//
// 调用点：src/app.js 的 start() 开头 —— 必须在 reloadSkills({reason:'boot'})
// 之前，因为插件扫描会读 trustedPlugins，晚一步就白做。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, CONFIG_FILE, updateConfig } from './config.js';

/** 迁移状态文件（放在 DATA_DIR：它是"这台机器的本次安装"的状态，不是出厂内容）。 */
export function upgradeStatePath(dataDir = DATA_DIR) {
  return path.join(dataDir, 'upgrade-state.json');
}

/** 读迁移状态。坏文件/不存在一律当"从没跑过" —— 迁移项自身幂等，重跑无害。 */
export function readUpgradeState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') throw new Error('not an object');
    return {
      version: String(j.version || ''),
      applied: (j.applied && typeof j.applied === 'object' && !Array.isArray(j.applied)) ? { ...j.applied } : {},
      updatedAt: String(j.updatedAt || '')
    };
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

/** 读当前应用版本（package.json）。读不到返回空串 —— 只影响状态记录，不影响是否执行。 */
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

// ── 迁移注册表 ────────────────────────────────────────────────────────────
// 加一项只需在此追加一个对象。惯例：
//   · id 一旦发布**永不修改**（它是幂等账本的键，改了等于让它再跑一次）；
//   · run() 里只做"读判断 + 改配置"，动磁盘要先备份；
//   · 返回 { changed: string[], note?: string } 供日志与测试断言。

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

        // ① 移出可信清单。信任闸按**目录名**匹配后直接放行（checkPluginTrust），
        //    留着这一项 = 给残留目录一张长期免检通行证，正好抵消基线闸的作用。
        const trusted = Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins.map(String) : [];
        if (trusted.includes(LEGACY)) {
          patch.trustedPlugins = trusted.filter((x) => x !== LEGACY);
          changed.push('trustedPlugins');
        }

        // ② 目录还在 → 显式关掉。`config.skills[id].enabled === false` 会让
        //    reloadSkills 里的 `if (st.enabled && st.loaded)` 不成立 → **不 activate**，
        //    于是不挂 after-response 钩子、不起后台巩固定时器 —— 冲突被从根上切断，
        //    即使它仍被读进内存也不产生任何行为。
        //    ⚠️ 只在目录**确实存在**时才写这一条：给一个不存在的插件留配置，
        //       只会让「插件」页多出一条"已配置但未安装"的噪音，而它什么也挡不住。
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
          // 空项（手改配置留下的 ""）顺手清掉 —— 它挡不住也放不行任何东西
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
      // 为什么值得清：一条指向空名字的白名单项当前**什么也挡不住、也什么也不放行**，
      // 但它占着名字 —— 将来谁把目录改成这个名字，就直接绕过了能力扫描。
      // 这正是 checkPluginTrust 注释里点名的那类攻击形态（"占掉内置模块的名字"）。
      const shown = orphans.map((x) => x || '(空项)');
      const note = `已清掉 ${orphans.length} 项无主信任：${shown.join('、')}（对应的插件目录已不存在）`;
      log(`[upgrade]     ${note}`);
      return { changed: ['trustedPlugins'], removed: orphans, note };
    }
  }
];

/**
 * 执行所有尚未执行过的迁移项。**同步**、开销极小（几次 stat，最多写一次 config）。
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
 * @returns {{ran:Array, skipped:string[], failed:Array, stateFile:string}}
 */
export function runUpgrades({
  appRoot = ROOT,
  dataDir = DATA_DIR,
  version = readAppVersion(appRoot),
  log = console.log,
  now = Date.now(),
  saveConfig = (mutator) => { updateConfig(mutator); }
} = {}) {
  const stateFile = upgradeStatePath(dataDir);
  const state = readUpgradeState(stateFile);
  const ran = [];
  const skipped = [];
  const failed = [];

  for (const up of UPGRADES) {
    if (state.applied[up.id]) { skipped.push(up.id); continue; }
    try {
      const r = up.run({ appRoot, dataDir, log, saveConfig, now });
      state.applied[up.id] = new Date(now).toISOString();
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

export { readAppVersion, readBuiltinIds, findModuleDir };
// CONFIG_FILE 仅用于排障日志的语义完整性（迁移改的就是它），显式再导出一份便于外部引用
export { CONFIG_FILE };
