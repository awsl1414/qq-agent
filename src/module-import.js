// 本地导入：把用户拖进来 / 选中的 zip 包或文件夹装进 skills/ 或 plugins/。
//
// 与市场安装（src/market.js）的区别：那个走网络下载，这个走本机路径或前端
// 上传的字节。安全边界与市场安装同等严格，两者最终都是"往会被 require()
// 的目录里写可执行 JS"，所以路径穿越、可执行后缀、zip 炸弹这些检查一处都不能少。
//
// id 与目录名的口径统一在 src/module-id.js 与 src/zip-install.js：
//   · 同 id（内置模块 / 已装扩展 / 注册表里在跑的）→ 拒绝导入，不造第二份；
//   · 不同 id 但撞目录名 → 同样拒绝（独占 mkdir），不再递增出 `_1`。
// 历史实现的"同名递增"会产生磁盘两份、注册表一份的孤儿目录，与本轮从锻造台
// 安装链路上根除的是同一个形态。
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR, PLUGINS_DIR } from './plugin-loader.js';
import { unzipToModuleDir, parseZip, writeModuleDirectory } from './zip-install.js';
import { findModuleIdConflict, ModuleIdConflictError, readManifestFile } from './module-id.js';

const BANNED_EXT = /\.(exe|dll|bat|cmd|com|msi|scr|ps1|vbs|sh|lnk)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store']);
const MAX_FILES = 300;
const MAX_TOTAL = 64 * 1024 * 1024;

/** 目录名合法化：只留 [a-zA-Z0-9._-]，空结果回退 fallback。 */
function safeDirName(name, fallback = 'module') {
  const base = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const cleaned = base.replace(/\.(zip|ZIP)$/, '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[.-]+/, '');
  if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) return fallback;
  return cleaned.slice(0, 64);
}

/**
 * 按内容判断该装到哪一页：plugin.json → 插件，skill.json → 技能。
 * 认不出来才用 kindHint（用户当前所在页）。
 *
 * 为什么要"内容优先"：从市场/别人手里拿到的包，名字和放置位置都不保证对得上；
 * 装错页的代价是"条目在另一页出现、这一页刷新半天没有"，比按内容归档难排查得多。
 */
function detectKind(names, kindHint) {
  const has = (n) => names.some((x) => x === n || x.endsWith('/' + n));
  if (has('plugin.json')) return 'plugin';
  if (has('skill.json')) return 'skill';
  return kindHint === 'plugin' ? 'plugin' : 'skill';
}

const dirOf = (kind) => (kind === 'plugin' ? PLUGINS_DIR : SKILLS_DIR);

/** 应用根：SKILLS_DIR / PLUGINS_DIR 的一级父目录，id 冲突判据以它为准。 */
const APP_ROOT = path.dirname(SKILLS_DIR);

/**
 * 落地前的同 id 检查（与锻造台安装、zip 解压落地同一函数）。
 * 抛出 ModuleIdConflictError，由 importModules 收进 errors 数组给前端逐条展示。
 *
 * @param {object} manifest 清单原文
 * @param {string} source 来源描述（目录名 / 文件名，只用于补全报错语境）
 * @throws {ModuleIdConflictError} id 已被占用
 */
function assertIdFree(manifest, source) {
  const id = String(manifest?.id ?? '').trim();
  if (!id) return;                      // 没有清单的路径由各分支自己的校验报错
  const existing = findModuleIdConflict(id, { appRoot: APP_ROOT });
  if (!existing) return;
  const err = new ModuleIdConflictError(existing);
  // 报错要能让用户直接行动：内置模块只能改 id，已装扩展先卸载。
  err.message = existing.kind === 'core'
    ? `${source}：id「${id}」属于内置模块（${existing.relDir}），第三方扩展不能占用 —— 请修改清单里的 id`
    : `${source}：已安装 ${existing.id}${existing.version ? ` v${existing.version}` : ''}（${existing.relDir}）。请先卸载再导入。`;
  throw err;
}

/**
 * 导入一个 zip 包。
 * @param {Buffer} buffer
 * @param {{ kind?: string, preferId?: string }} o
 * @returns {Promise<{ kind, id, dir, files }>}
 * @throws {ModuleIdConflictError} 清单 id 已被内置模块或已装扩展占用
 */
export async function importZip(buffer, { kind = 'skill', preferId = '' } = {}) {
  // 这里调 parseZip 做的是"探测"（不落盘）。它内部边解析边限额，
  // 体积与数量上限都在里面；下面的 unzipToModuleDir 会再解一次，因为它要的是"落地"。
  // 同 id 检查在 unzipToModuleDir 里（写盘之前，含清单解析），不在这一层重复。
  const entries = parseZip(buffer);
  const detected = detectKind(entries.map((e) => e.name), kind);
  const baseDir = dirOf(detected);
  const id = await unzipToModuleDir(buffer, { root: path.dirname(baseDir), type: detected, preferId });
  return { kind: detected, id, dir: path.join(baseDir, id), files: entries.length };
}

/**
 * 导入本机的一个目录（整包）或单个文件（包一层目录）。
 * @param {string} src
 * @param {{ kind?: string }} o
 */
export function importPath(src, { kind = 'skill' } = {}) {
  if (!src || typeof src !== 'string') throw new Error('缺少路径');
  const abs = path.resolve(src);
  const stat = fs.statSync(abs);            // 不存在/无权限 → 抛错，由路由转成 400

  if (stat.isFile() && /\.zip$/i.test(abs)) {
    return importZip(fs.readFileSync(abs), { kind, preferId: safeDirName(abs, '') });
  }

  // 单文件（skill.json / index.js …）：包一层以文件名命名的目录，
  // 否则装进去就是散落在 skills/ 根目录里的孤儿文件，永远不会被扫描到。
  // 单个 .json 文件可能是某份清单，但模块目录里没有它的入口 / 其余文件，
  // 装上也永远加载不起来 —— 这里只按目录名独占（不与任何现有目录合并）。
  if (stat.isFile()) {
    if (BANNED_EXT.test(abs)) throw new Error(`不支持的文件类型：${path.basename(abs)}`);
    const detected = detectKind([path.basename(abs)], kind);
    const baseDir = dirOf(detected);
    const installed = writeModuleDirectory(baseDir, safeDirName(abs, 'module'), (target) => {
      fs.copyFileSync(abs, path.join(target, path.basename(abs)));
    });
    return { kind: detected, ...installed, files: 1 };
  }

  // 目录：先整棵扫一遍（順便校验），再复制
  const collected = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(ent.name)) continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(path.join(dir, ent.name), relPath); continue; }
      if (BANNED_EXT.test(ent.name)) throw new Error(`包含禁止的文件类型：${relPath}`);
      const st = fs.statSync(path.join(dir, ent.name));
      collected.push({ abs: path.join(dir, ent.name), rel: relPath, size: st.size });
    }
  };
  walk(abs, '');
  if (!collected.length) throw new Error('这个文件夹是空的');
  if (collected.length > MAX_FILES) throw new Error(`文件数量过多（${collected.length} > ${MAX_FILES}）`);
  const total = collected.reduce((s, f) => s + f.size, 0);
  if (total > MAX_TOTAL) throw new Error('文件总大小超过 64MB');

  const detected = detectKind(collected.map((f) => f.rel), kind);
  const baseDir = dirOf(detected);

  // 以清单为锚点定位模块根（与 zip-install.js 同口径）。
  // 用户可能选的是父文件夹（里面才是一个或多个模块目录），整棵复制会把
  // 模块套进一层子目录 → loader 在模块根找不到 plugin.json/skill.json
  // → 报"缺少 skill.json / plugin.json"。这里取最浅的清单所在目录为模块根，
  // 剥掉它上面的层级、丢掉根外的杂物（README/LICENSE 之类）。
  const want = detected === 'plugin' ? 'plugin.json' : 'skill.json';
  let best = null;
  for (const f of collected) {
    const base = f.rel.split('/').pop();
    if (base !== want) continue;
    const depth = f.rel.split('/').length - 1;
    if (!best || depth < best.depth) best = { f, depth };
  }
  let prefix = '';
  let nameHint = '';
  if (best && best.depth > 0) {
    prefix = best.f.rel.split('/').slice(0, best.depth).join('/') + '/';
    nameHint = best.f.rel.split('/')[best.depth - 1] || '';
  }
  const keep = prefix ? collected.filter((f) => f.rel.startsWith(prefix)) : collected;
  if (!keep.length) throw new Error('这个文件夹里没有可安装的模块文件');

  // 读模块根下的清单：同 id 必须在落地前拒绝（判据与锻造台安装同一函数）。
  // best 是最浅的那份清单文件，它的所在目录就是模块根（与下面 prefix 的计算同源）。
  // 整个文件夹都没有清单时不在这里报 —— 那是"导入任意目录"的既有行为，loader 会说明。
  if (best) assertIdFree(readManifestFile(best.f.abs), path.basename(abs));

  const installed = writeModuleDirectory(baseDir, safeDirName(nameHint || path.basename(abs), 'module'), (target) => {
    for (const f of keep) {
      const rel = f.rel.slice(prefix.length);
      const dest = path.join(target, ...rel.split('/'));
      // 二次防线：解析后必须仍在本次独占创建的 target 内。
      const relCheck = path.relative(target, dest);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new Error(`包含非法路径：${f.rel}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
  });
  return { kind: detected, ...installed, files: keep.length };
}

/**
 * 批量导入：一个失败不影响其它（返回 errors 逐个说明原因）。
 *
 * 冲突条目额外带 conflict/existing：前端据此说清"和哪一份撞了、该去哪处理"，
 * 而不是笼统的"导入失败"（见 routes 的 /api/skills/import）。
 *
 * @param {{ paths?: string[], zipBase64?: string, zipName?: string, kind?: string }} body
 * @returns {Promise<{ installed: Array, errors: Array }>}
 */
export async function importModules({ paths = [], zipBase64 = '', zipName = '', kind = 'skill' } = {}) {
  const installed = [];
  const errors = [];
  const fail = (source, e) => {
    const row = { source, error: String(e?.message ?? e) };
    if (e?.conflict === true) { row.conflict = true; row.existing = e.existing || null; }
    errors.push(row);
  };
  for (const p of paths) {
    try {
      const r = await importPath(p, { kind });
      installed.push(r);
    } catch (e) {
      fail(path.basename(String(p)), e);
    }
  }
  if (zipBase64) {
    try {
      const buffer = Buffer.from(String(zipBase64), 'base64');
      if (!buffer.length) throw new Error('内容为空');
      const r = await importZip(buffer, { kind, preferId: safeDirName(zipName, '') });
      installed.push(r);
    } catch (e) {
      fail(zipName || '上传的包', e);
    }
  }
  return { installed, errors };
}
