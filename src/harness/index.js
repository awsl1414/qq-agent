// ── harness：软件自带的开发工具链（不再是插件）─────────────────────────────
//
// 2026-10-21 内置化：self-doctor / self-fix / extension-forge / dev-orders
// 从 `plugins/` 搬到 `src/harness/`，由 core 在启动时直接注册。
// 2026-10-23：壁纸套件（`src/wallpaper/`，用户功能）也走同一套注册机制 ——
// 它不在本目录，用 MODULES 的 dir 字段指过去，机制完全复用。
//
// 为什么这么改（用户诉求："变成软件自带功能，和插件脱离"）：
//   · 不再经过插件加载器的目录扫描与内置基线校验 —— 改一行不需要重算指纹，
//     也不会因为指纹失配被当成"内置模块被顶替"而拒载；
//   · 不可禁用、不可卸载、不出现在插件/Skill 列表（manifest.kind = 'core'）；
//   · 仍然复用 createSkillApi()，所以工具前缀（self-fix__*）、配置键
//     （config.skills['self-fix']）、storage 路径、能力名全部保持原样 ——
//     63 条路由与前端四个页签零改动。
//
// 代价（明确接受）：不再热重载。改 harness 代码必须重启应用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillApi } from '../plugin-loader.js';
import { SKILL_API_VERSION } from '../skills/manifest.js';

import * as doctor from './doctor/index.js';
import * as fix from './fix/index.js';
import * as forge from './forge/index.js';
import * as dev from './dev/index.js';
// 壁纸套件（2026-10-23 内置化）：用户功能，不是开发工具链，所以放在 src/wallpaper/
// 而不是本目录 —— 由下面的 dir 字段指定位置，注册机制完全复用。
import * as wallpaper from '../wallpaper/index.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 五个模块。id 保持原插件 id —— 这样：
 *   · 工具名仍是 `self-doctor__scan_project` 这类，模型与提示词里已有的引用不作废；
 *   · 老用户的 config.skills['self-fix'] 等配置继续生效（含 fixEnabled 开关）；
 *   · plugin-data/<id>/ 目录沿用，报告/备份/工单不丢。
 * dir：模块目录（相对 src/）。缺省 = harness/<key>；wallpaper 是用户功能而非
 * 开发工具链，单独放 src/wallpaper/，不混在本目录里。
 */
const MODULES = [
  { key: 'doctor', id: 'self-doctor', mod: doctor, permissions: [], toolIds: [] },
  { key: 'fix', id: 'self-fix', mod: fix, permissions: [], toolIds: [] },
  { key: 'forge', id: 'extension-forge', mod: forge, permissions: ['web_fetch'], toolIds: [] },
  { key: 'dev', id: 'dev-orders', mod: dev, permissions: [], toolIds: [] },
  { key: 'wallpaper', id: 'wallpaper', mod: wallpaper, dir: 'wallpaper', permissions: [], toolIds: [] }
];

/** 读模块自带的 plugin.json 作为元数据（名称/版本/能力/默认设置）。读不到不致命。 */
function readMeta(module) {
  const dir = module.dir ? module.dir : path.join('harness', module.key);
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'src', dir, 'plugin.json'), 'utf8'));
  } catch {
    return {};
  }
}

function buildManifest(module, meta) {
  return {
    id: module.id,
    name: String(meta.name || module.id),
    version: String(meta.version || '1.0.0'),
    apiVersion: Number(meta.apiVersion) || SKILL_API_VERSION,
    // ⚠️ kind='core' 是这套迁移的关键：manager.isEnabled 见到它就恒为启用，
    //    前端按 kind 过滤所以不会出现在插件/Skill 列表里。
    kind: 'core',
    category: String(meta.category || 'harness'),
    description: String(meta.description || '内置开发工具链'),
    author: meta.author,
    enabledByDefault: true,
    requires: [],
    capabilities: Array.isArray(meta.capabilities) ? meta.capabilities : [],
    // 默认值来自 plugin.json.settings —— settingsOf() 用它和用户配置合并
    settings: meta.settings || {},
    configSchema: meta.configSchema || {},
    // 内置模块不提供插件面板（页面在主控制台里，不走 /plugin-panel 通道）
    panels: [],
    prompt: null
  };
}

/**
 * 注册全部内置工具链模块。由 app.js 在 loadPlugins() 之后调用。
 *
 * 幂等：手动重扫（/api/skills/reload）也会走到这里，但 setup/activate 只跑一次 ——
 * 模块里的定时器、store 加载、沙箱初始化都不是可重入的，跑两遍会双份副作用。
 * 后续调用只重新登记 skill 对象（若注册表被清空能恢复），不重跑 setup。
 *
 * @returns {{ok:boolean, modules:Array<{id:string,ok:boolean,error?:string}>}}
 */
let bootstrapped = false;
export function registerHarness({ skillManager, log = console.log } = {}) {
  if (!skillManager) throw new Error('registerHarness 需要 skillManager');
  const results = [];

  for (const module of MODULES) {
    const meta = readMeta(module);
    const manifest = buildManifest(module, meta);
    const mod = module.mod;
    try {
      const base = createSkillApi(module.id, module.permissions);
      const api = {
        ...base,
        // 收集本次 setup 注册的工具 id：skill.toolIds 是孤儿清扫的唯一依据，
        // 不填的话重扫时这 2 个工具会被当成"旧版本遗留"删掉（实测 50→48）。
        registerTool: (def) => {
          const id = base.registerTool(def);
          if (!module.toolIds.includes(id)) module.toolIds.push(id);
          return id;
        },
        // 路径由宿主注入：内置模块的 import.meta 层级和插件期不同，
        // 各自反推 appRoot 一定会算错（src/harness/<mod> → src → app 才是根）
        appRoot: APP_ROOT,
        dataRoot: path.join(String(process.env.QQ_AGENT_DATA_DIR || '').trim() || '.'),
        core: true
      };
      if (!bootstrapped && typeof mod.setup === 'function') mod.setup(api);
      const skill = {
        manifest,
        kind: 'core',
        source: 'core',
        relDir: `src/${module.dir || `harness/${module.key}`}`,
        // 工具归属：重扫后新 skill 对象也要带上，否则孤儿清扫会删掉它们
        toolIds: module.toolIds,
        providers: mod.providers || {},
        hooks: mod.hooks || {},
        promptSections: mod.promptSections,
        configSchema: mod.configSchema,
        setup: mod.setup,
        activate: mod.activate,
        deactivate: mod.deactivate,
        dispose: mod.dispose
      };
      const r = skillManager.register(skill);
      if (!r.ok) throw new Error(r.error || '注册失败');
      // ⚠️ activate 必须每次注册都跑：重扫时 manager.register 会先对旧实例调
      //    deactivate（停掉 doctor 的周期体检定时器），不重新激活就永久停了。
      //    setup 则只在首次执行（模块内的 store 加载 / 沙箱初始化不可重入）。
      if (typeof mod.activate === 'function') mod.activate({ reason: bootstrapped ? 'core-rescan' : 'core-boot' });
      results.push({ id: module.id, ok: true });
      if (!bootstrapped) log(`[harness] ✅ ${manifest.name}（${module.id} ${manifest.version}，${manifest.capabilities.length} 项能力）`);
    } catch (error) {
      const msg = String(error?.message ?? error);
      results.push({ id: module.id, ok: false, error: msg });
      log(`[harness] ❌ ${module.id}：${msg}`);
    }
  }

  const ok = results.every((r) => r.ok);
  if (!bootstrapped) log(`[harness] 内置工具链注册完成：${results.filter((r) => r.ok).length}/${results.length}`);
  bootstrapped = true;
  return { ok, modules: results };
}
