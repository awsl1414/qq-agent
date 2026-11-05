// 扩展 id 的唯一判据：同一个 id 在整机上只能有一份。
//
// 三处必须同一口径，任何一处各自实现都会重新长出"磁盘两份、注册表一份"：
//   · 安装：src/harness/forge/index.js 的 forge.install（锻造台落地）
//   · 导入：src/module-import.js（扩展页「导入 zip / 文件夹」）
//   · 落地：src/zip-install.js（unzipToModuleDir 写目录前）
//
// 三份真源，按优先级判定（命中即返回，后面的不再看）：
//   ① 内置模块名单（src/core-modules.js）。kind='core' 的模块不落 skills/ 与
//      plugins/，也不在 builtin-modules.json 基线里（那份基线只收随包分发的
//      扩展目录）。它们的 id 所有权是静态的：与磁盘上有没有同名目录无关。
//      启动早期 loadPlugins 先于 registerHarness，那一刻注册表里还没有 core
//      条目 —— 所以这一份不能省、也不能只用注册表代替。
//   ② SkillManager 注册表：覆盖"正在生效的"条目，含 kind='core' 与自定义
//      roots 里的扩展（不在默认目录里，磁盘索引看不到）。
//   ③ 磁盘目录：<appRoot>/skills 与 <appRoot>/plugins 下的清单 id。按清单 id
//      而不是目录名判定：目录名只是载体，配置键 / 工具前缀 / 扩展间引用用的
//      全是 manifest.id（历史实现的 `_1` 恰好在这里分叉）。放在最后是因为它
//      不依赖运行期状态 —— 仅拿得到 appRoot 的调用方（zip 落地）也能完整判定。
//
// 目录名冲突（不同 id、同一个目录名）不在这里管：写入方用独占 mkdir 拒绝，
// 语义是"不覆盖任何已存在的目录"。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { CORE_MODULE_IDS, isCoreModuleId, coreModuleRelDir } from './core-modules.js';

/** 清单文件名，与 plugin-loader 的读取顺序一致（skill.json 优先）。 */
const MANIFEST_FILES = ['skill.json', 'plugin.json'];

/**
 * id 冲突的专用错误：调用方要能区分"这个包有安全问题/读不了"和"这个 id 已经
 * 被占用"（前端提示语与后续动作完全不同）。
 * conflict/existing 两个字段是给上层透传给界面的，不写进 message。
 */
export class ModuleIdConflictError extends Error {
  constructor(existing) {
    super(`扩展 id 已被占用：${existing.id}（${existing.relDir}）`);
    this.name = 'ModuleIdConflictError';
    this.conflict = true;
    this.existing = existing;
  }
}

/**
 * 读一个清单文件的字节并解析。
 * 含 BOM 处理：Windows 编辑器（记事本 / PowerShell）写出的清单常带 BOM，
 * JSON.parse 会直接抛 "Unexpected token"，报错信息完全不提 BOM。
 * @returns {object|null} 解析失败返回 null（由调用方决定是报错还是按"没有清单"处理）
 */
export function readManifestFile(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 读一个扩展目录的清单（skill.json 优先，plugin.json 兜底）。
 * @returns {{kind: 'skill'|'plugin', manifest: object, file: string}|null}
 */
export function readManifestOf(base) {
  for (const name of MANIFEST_FILES) {
    const manifest = readManifestFile(path.join(base, name));
    if (manifest) return { kind: name === 'skill.json' ? 'skill' : 'plugin', manifest, file: name };
  }
  return null;
}

/**
 * 已装扩展索引：清单 id → { kind, dir, relDir, manifest }。
 *
 * 同一 id 有多份目录时只保留排序最前的那一份：readdir 顺序随文件系统变化，
 * 不排序会让"报告哪一个"在两次启动间漂移。另一份的处置见 forge 的 scanOrphans。
 */
export function installedModules(appRoot = ROOT) {
  const map = new Map();
  for (const kind of ['skill', 'plugin']) {
    const sub = kind === 'plugin' ? 'plugins' : 'skills';
    const base = path.join(appRoot, sub);
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const hit = readManifestOf(path.join(base, e.name));
      if (!hit?.manifest?.id) continue;
      const id = String(hit.manifest.id);
      if (!map.has(id)) map.set(id, { kind, dir: e.name, relDir: `${sub}/${e.name}`, manifest: hit.manifest });
    }
  }
  return map;
}

/** SkillManager 的注册表键就是 manifest.id（见 src/skills/registry.js），这里统一取。 */
function registryGet(registry, id) {
  const reg = registry?.registry && typeof registry.registry.get === 'function' ? registry.registry : registry;
  if (typeof reg?.get !== 'function') return null;
  try { return reg.get(id) || null; } catch { return null; }
}

/**
 * 查这个 id 是否已被占用。
 * @param {string} manifestId
 * @param {{appRoot?: string, registry?: object|null}} opts
 *   appRoot 缺省为进程根目录；registry 传 SkillManager（运行期）。
 * @returns {{id, kind: 'core'|'skill'|'plugin'|null, version, dir, relDir}|null}
 *   dir 是可操作的目标：内置模块给源码目录，已装扩展给一级目录名。
 */
export function findModuleIdConflict(manifestId, { appRoot = ROOT, registry = null } = {}) {
  const id = String(manifestId ?? '').trim();
  if (!id) return null;

  // ① 内置模块：id 的所有权与磁盘无关，先判。
  if (isCoreModuleId(id)) {
    const relDir = coreModuleRelDir(id);
    return { id, kind: 'core', version: '', dir: relDir, relDir };
  }

  // ② 注册表：正在生效的条目（含 core 与自定义 roots 里的扩展）。
  //    排在磁盘之前，是因为它说的是"现在真的有一份在跑"。
  const reg = registryGet(registry, id);
  if (reg?.manifest) {
    const relDir = String(reg.relDir || '');
    return {
      id,
      kind: reg.kind || reg.manifest.kind || null,
      version: String(reg.manifest.version || ''),
      dir: relDir,
      relDir
    };
  }

  // ③ 磁盘目录：给出用户能直接去扩展页处理的路径。
  //    不依赖运行期状态，只拿得到 appRoot 的落地路径（zip 安装）靠它兜底。
  const hit = installedModules(appRoot).get(id);
  if (hit) {
    return {
      id,
      kind: hit.kind,
      version: String(hit.manifest.version || ''),
      dir: hit.dir,
      relDir: hit.relDir
    };
  }
  return null;
}

/**
 * 当前"被占用"的全部 id 及其占用者（给闸门的环境快照用）。
 * 口径与 findModuleIdConflict 完全一致：同一 id 只出一条，优先级 core > 注册表 > 磁盘。
 * 一次遍历全部真源再合并，而不是对每个 id 各调一次 findModuleIdConflict ——
 * 后者会对磁盘目录做 N 次重复扫描（闸门每次预检都要跑）。
 *
 * @returns {Map<string, {id, kind, version, dir, relDir}>}
 */
export function knownModules({ appRoot = ROOT, registry = null } = {}) {
  const out = new Map();
  // ① 内置模块：恒在，且优先级最高（与 findModuleIdConflict 同序）。
  for (const id of CORE_MODULE_IDS) {
    out.set(id, { id, kind: 'core', version: '', dir: coreModuleRelDir(id), relDir: coreModuleRelDir(id) });
  }
  // ② 磁盘目录：先铺底，让"注册表里没有它"的已装扩展也被算进来。
  for (const [id, hit] of installedModules(appRoot)) {
    if (out.has(id)) continue;
    out.set(id, {
      id,
      kind: hit.kind,
      version: String(hit.manifest.version || ''),
      dir: hit.dir,
      relDir: hit.relDir
    });
  }
  // ③ 注册表：说明"现在真的有一份在跑"，覆盖磁盘那条（含自定义 roots）。
  let list = [];
  try { list = registry?.registry?.list?.() || registry?.list?.() || []; } catch { /* 不可读就只用前两份真源 */ }
  for (const s of list) {
    const id = s?.manifest?.id;
    if (!id) continue;
    if (out.get(String(id))?.kind === 'core') continue;   // 内置模块的说明不被动摇
    const relDir = String(s.relDir || '');
    out.set(String(id), {
      id: String(id),
      kind: s.kind || s.manifest.kind || null,
      version: String(s.manifest.version || ''),
      dir: relDir,
      relDir
    });
  }
  return out;
}
