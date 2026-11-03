// Skill / 插件加载器：扫描 plugins/ 与 skills/ 两个目录。
//
// 两个目录的区别是语义分类，不是格式新旧（两种清单文件功能完全等价，
// 走同一条 normalizeManifest，只有"什么时候会被执行"这件事不同）：
//
//   plugins/   确定性型（kind = 'plugin'）
//              提供能力（providers）或钩子（hooks）。核心代码按能力名取用，
//              满足条件就一定被执行，不经过 LLM，模型想忽略也忽略不掉。
//              例：账号池、图片兼容、思考适配、禁言状态、抽帧、语音转文字、回复安全网。
//
//   skills/    LLM 型（kind = 'skill'）
//              注册工具（registerTool）+ 提示词片段。工具进模型的 function 列表，
//              用不用、什么时候用由模型自己判断。
//              例：计算器、文本工具、天气查询、随机图、表情标注。
//
//   只有工具会进模型的 tools 列表。所以"想接入 LLM"只有一条路：registerTool。
//   只写 providers 的模块放进 skills/ 对模型是完全隐形的，加载器会就这种情况
//   给出明确警告（见 lintKindPlacement），否则它会静默失效得毫无线索。
//
// 安全机制：
//   1. 权限声明：只有声明了 web_fetch 权限才拿得到 fetch
//   2. 错误隔离：单个 Skill 加载/注册失败只影响它自己
//   3. 资源回收：卸载/热重载时按 skillId 批量注销工具 + 清能力 + 调 dispose
//   4. 生命周期真实性：禁用一定调 deactivate，避免"开关关了但监听器还在"

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerTool, unregisterTool, unregisterToolsBySkill, getTool, listTools, beginToolsetBatch, endToolsetBatch } from './tool-registry.js';
import { guardToolExecute } from './tool-guard.js';
import { skillManager } from './skills/manager.js';
import { normalizeManifest, isManifestUsable, SKILL_API_VERSION, kindOfDir } from './skills/manifest.js';
import { logger } from './logger.js';
// 插件界面契约（常量 / 路径校验 / URL 拼装 / CSP），与 src/app.js 的静态服务、
// ui/app/06-settings-render.js 的弹层共用同一份，见 src/skills/panel.js。
import { PANEL_ROUTE_PREFIX, PANEL_DATA_FILE, normalizePanelAsset, panelUrl, panelDataUrl } from './skills/panel.js';
import { skillErrorText } from './skills/errors.js';
import { getConfig, DATA_DIR } from './config.js';
// 受保护 fetch（H3）：扩展的 api.fetch 必须走这里，不能给裸 globalThis.fetch
import { guardedFetch } from './safe-fetch.js';

// 必须以模块自身位置为锚点，不能用 process.cwd()。
// 打包/安装版里 App 文件在 <install>/resources/app/，而快捷方式的"起始位置"
// 通常是 <install>/，用 cwd 会解析到不存在的目录，导致 skills/ 与 plugins/
// 静默加载 0 个（既不报错也不打日志，排查成本极高）。
// 项目内其它模块（app.js 的 UI_DIR、config.js 的 ROOT）都是同一约定。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 导出两个根目录：routes.js 的"删除模块"接口要据此校验
// "目标目录确实在 skills/ 或 plugins/ 之内"，必须与加载器共用同一份路径，
// 否则校验口径会与实际加载位置分叉（自定义 roots 时尤其危险）。
export const SKILLS_DIR = path.resolve(APP_ROOT, 'skills');
export const PLUGINS_DIR = path.resolve(APP_ROOT, 'plugins');

// 由 app.js 在创建 OneBotClient 后注入，供声明了 qq_sticker 权限的插件调用 QQ 协议接口。
let onebotClient = null;
export function setOnebotClient(client) {
  onebotClient = client;
}

// ── 插件静态准入 ────────────────────────────────────────────────────────
//
// 插件是 `await import()` 直接进主进程执行的，与主进程共享同一个 `process`。
// createSkillApi 的 permissions 只拦得住 fetch：fs / child_process 是插件自己
// import 的，权限层根本碰不到。扩展共享宿主权限，仍受宿主账号与 OS 权限约束。
//
// 这里做的不是隔离（那需要 worker_threads / 子进程 + JSON-RPC，工程量大），
// 而是把信任边界显式化：
//   - 随应用分发的模块（列在 builtin-modules.json 基线里）视为可信，一律放行；
//   - 第三方模块（市场 zip / forge 生成 / 本地导入 / 自定义 roots）若触碰
//     进程/网络栈/凭据，默认拒绝加载并给出可操作提示，必须在
//     config.trustedPlugins 里显式登记 id 才放行。
// 因此必须让用户知情选择是否允许第三方扩展使用这些能力。
//
// 判据用「能力」而不是「某段字符串」：字符串黑名单追不上 require('f'+'s')、
// fs['readFileSync'] 这类等价写法，而 import 目标是无法等价改写的。

const BUILTIN_BASELINE_FILE = path.join(APP_ROOT, 'builtin-modules.json');

/**
 * 读内置基线（随包分发的 builtin-modules.json）。
 *
 * 为什么必须是显式基线文件，而不能"目录在 plugins/ 或 skills/ 下就算内置"
 * （两次踩坑的教训）：
 *   ① 第一次用硬编码 id 名单，漏掉 skills/ 下 8 个内置技能，全被拦成"加载失败"，
 *      而且每新增一个内置模块就会再犯一次。
 *   ② 第二次改成"按路径判内置"，第三方安装的插件恰好也装在 ROOT/plugins 与
 *      ROOT/skills 下（见 market.js 的模块落盘与 extension-forge 的安装逻辑），
 *      于是闸门被完全绕过，比原来的漏洞更糟。
 * 只有"随包分发时就在清单里"这个判据才对：它是打包那一刻的事实，
 * 第三方无论叫什么名字、装在哪都进不了这个名单。
 *
 * 兜底：基线文件缺失/损坏时不放行任何模块（fail-closed），
 * 大不了 23 个内置全部走 trustedPlugins 提示，也不能让闸门静默失效。
 */
let _builtinIds = null;
let _builtinMap = null;
let _builtinMtime = -1;
function builtinBaseline() {
  // 带 mtime 校验的缓存：应用内"落地后重算基线"（refreshBuiltinEntry）
  // 会重写 builtin-modules.json，缓存必须能感知文件已变，否则同一进程里刷新完
  // 仍按旧指纹判，模块会被自己刚写的新基线再拦一次。
  let mtime = -1;
  try { mtime = fs.statSync(BUILTIN_BASELINE_FILE).mtimeMs; } catch { mtime = -1; }
  if (_builtinMap && (mtime === -1 || mtime === _builtinMtime)) return _builtinMap;
  _builtinMtime = mtime;
  _builtinMap = new Map();
  _builtinIds = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(BUILTIN_BASELINE_FILE, 'utf8'));
    for (const m of (raw?.modules || [])) {
      const dir = String(m?.dir ?? '').trim();
      if (!dir) continue;
      _builtinMap.set(dir, m);
      _builtinIds.add(dir);
    }
  } catch {
    // fail-closed：读不到基线就不认任何内置（见上方注释）
  }
  return _builtinMap;
}
function builtinModuleIds() {
  if (!_builtinIds) builtinBaseline();
  return _builtinIds;
}

/**
 * 这个目录名是不是随应用分发的内置模块。
 *
 * 给 UI 的"来源"筛选用（内置 / 第三方分开，方便管理）。
 * 只按目录名比对，不校验内容指纹，与 checkPluginTrust 有意不同：
 * 那边判"能不能免检"，被改过的内置模块必须走能力扫描；
 * 这里判"它是不是随应用带的那个"，被「升级扩展」改过的内置模块仍然是
 * 随应用带的那一个（用户要的是"哪些是我后来装的"，不是"哪些被改过"）。
 * 目录名是磁盘上真实的一级目录名，第三方装进来无法自选（安装器遇同名会递增后缀）。
 */
export function isBuiltinModuleDir(dirName) {
  return builtinModuleIds().has(String(dirName || ''));
}

/** 递归列出模块目录下全部文件（相对路径，跳过 node_modules 与隐藏项，深度上限 8）。 */
function walkModuleFiles(dir, root = dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkModuleFiles(p, root, out, depth + 1);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 内置模块文件指纹：文本 CRLF 归一化为 LF 后取 SHA-1 前 16 位。
 * 避免检出或打包时的换行差异让内置模块失去豁免；含 NUL 的文件按二进制原样计算。
 * latin1 只作逐字节映射，避免 UTF-8 解码替换无效字节而掩盖真实内容变化。
 */
export function moduleFileSha1(buf) {
  const content = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
}

/**
 * 重算某个内置模块的基线指纹并写回 builtin-modules.json。
 *
 * 为什么需要它：应用内两条用户确认过的改动路径会改内置模块的文件：
 *   - harness → 升级扩展（extension-forge 覆盖安装 / 回滚）
 *   - harness → 自动修复（self-fix 落地 / 回滚）
 * 但随包基线不会跟着变。下一轮热重扫时内容指纹失配，
 * 模块会被本文件的能力闸当"占名顶替"拦下（文案还写着"触碰高危能力"，非常误导）。
 * 落地/回滚成功后立刻重算，让基线与磁盘对齐。
 *
 * 不做的事（有意为之）：不覆盖"装新扩展"。新装的模块本来就该走第三方信任流程
 * （trustedPlugins），自动进基线等于把信任边界悄悄放宽；这里的判据是
 * "目录名已经在内置清单里"，新名字天然不满足。
 *
 * 与校验端共用 moduleFileSha1：文本归一化换行，二进制保持原样。
 * 整目录逐文件计算、跳过 node_modules 与隐藏项、深度上限 8。
 * @returns {{ok:boolean, updated?:boolean, files?:number, skipped?:string, reason?:string}}
 */
export function refreshBuiltinEntry(dirName, { appRoot = APP_ROOT } = {}) {
  const dir = String(dirName ?? '').trim();
  if (!dir) return { ok: false, reason: '目录名为空' };
  const baselineFile = path.join(appRoot, 'builtin-modules.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(baselineFile, 'utf8')); }
  catch (e) { return { ok: false, reason: `读不到基线（${e?.message || e}）` }; }
  const modules = Array.isArray(doc?.modules) ? doc.modules : [];
  const entry = modules.find((m) => String(m?.dir ?? '') === dir);
  if (!entry) return { ok: true, updated: false, skipped: 'not-builtin' };
  const sub = entry.kind === 'skill' ? 'skills' : 'plugins';
  const modDir = path.join(appRoot, sub, dir);
  if (!fs.existsSync(modDir)) return { ok: false, reason: `模块目录不存在：${dir}` };

  const files = {};
  for (const rel of walkModuleFiles(modDir)) {
    try {
      files[rel] = moduleFileSha1(fs.readFileSync(path.join(modDir, rel)));
    } catch { /* 读不了的文件不记账：下次重扫会因"基线缺文件"失败，方向是安全的 */ }
  }
  // 比较不依赖键的顺序（walk 顺序在两个进程里可能不同，但集合相同就不该重写文件）
  const prev = entry.files || {};
  const ka = Object.keys(prev).sort(), kb = Object.keys(files).sort();
  const same = ka.length === kb.length && ka.every((k, i) => k === kb[i] && prev[k] === files[k]);
  if (same) return { ok: true, updated: false, files: kb.length };

  entry.files = files;
  const tmpFile = `${baselineFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmpFile, baselineFile);
  } catch (e) {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: `写基线失败：${e?.message || e}` };
  }
  // 同进程的准入闸缓存显式失效（mtime 校验是兜底，这里让下一次判断立即拿到新指纹）
  if (path.resolve(appRoot) === path.resolve(APP_ROOT)) {
    _builtinMap = null;
    _builtinIds = null;
    _builtinMtime = -1;
  }
  return { ok: true, updated: true, files: kb.length };
}

/**
 * 内置模块的内容是否还是基线里那一份，整目录逐文件比对。
 *
 * 为什么必须比整个目录，不能只比入口文件（安全验证实测）：
 * 只比入口时，把真实的 `plugins/sticker/index.js` 原样拷进来（指纹一致 → 放行），
 * 再把非入口文件 `core.js` 换成恶意代码，就能带着内置豁免在主进程执行。
 * 端到端实测：`{success:1, failed:0}`，恶意代码真的跑起来了。
 * 因为 `index.js` 必然会 import 同目录的 `core.js`/`checks.js`。
 *
 * 判据是双向的：
 *   ① 基线里记录的每个文件都必须存在且指纹一致（防篡改）
 *   ② 目录里不能有基线之外的可执行文件（防新增，否则加个 `extra.js`
 *      让 index.js 去 import 它就绕过了）
 * 任一条不满足就视为"被顶替"，走下面的能力扫描（而不是直接放行）。
 *
 * 代价：改了内置模块的代码就得重算基线（`builtin-modules.json` 的 `_comment` 里写了）。
 * 这正是想要的，内置代码改动应当是一次有意识的"声明它仍然可信"。
 * @returns {{matches:boolean, mismatches:Array<{path:string, type:string}>, lineEndingOnly:string[]}}
 */
export function builtinContentMatches(rec, entryPath) {
  const mismatches = [];
  const lineEndingOnly = [];
  if (!rec?.files || typeof rec.files !== 'object' || Array.isArray(rec.files)) {
    return { matches: false, mismatches: [{ path: 'builtin-modules.json', type: 'invalid-baseline' }], lineEndingOnly };
  }
  const dir = path.dirname(path.resolve(entryPath));

  // ① 基线里的每个文件都要在、且指纹一致
  for (const [rel, want] of Object.entries(rec.files)) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, rel)); }
    catch (error) {
      mismatches.push({ path: rel, type: error.code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    if (moduleFileSha1(buf) !== want) mismatches.push({ path: rel, type: 'content' });
    else if (!buf.includes(0) && buf.includes('\r\n')) lineEndingOnly.push(rel);
  }
  // ② 不能有基线之外的可执行文件
  const known = new Set(Object.keys(rec.files));
  const extras = listExecutables(dir).filter((rel) => !known.has(rel));
  for (const rel of extras) mismatches.push({ path: rel, type: 'extra-executable' });
  return { matches: mismatches.length === 0, mismatches, lineEndingOnly };
}

const FINGERPRINT_MISMATCH_LABELS = {
  'invalid-baseline': '缺少有效的 files 基线',
  missing: '文件缺失',
  unreadable: '文件无法读取',
  content: '内容指纹不一致',
  'extra-executable': '基线之外的可执行文件'
};

/** 列出目录下所有 .js/.mjs/.cjs（相对路径），跳过 node_modules 与隐藏项。 */
function listExecutables(dir, root = dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listExecutables(p, root, out, depth + 1);
    else if (/\.(js|mjs|cjs)$/i.test(e.name)) out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 第三方插件默认禁止触碰的能力（fs/child_process/net/vm/inspector…）。
 *
 * 三条等价写法必须一并拦，静态黑名单追不上改写，
 * 这是早期注释里"import 目标是无法等价改写的"这一论断的错误之处：
 *   ① 拼接：require('node:child' + '_process')、import('node:' + m)
 *      Node 的 require/import 接受运行期拼出来的字符串，正则会漏。
 *   ② 模板串：await import(`node:${m}`) 同理。
 *   ③ process.getBuiltinModule('fs')：Node 22+ 内置，完全不经 import/require，
 *      对任何基于 import/require 形态的正则结构性失明（最干净的一条绕过路径）。
 * 静态检查终究不是沙箱（见文件头部的声明），这里只是把已知等价写法补齐。
 */
const DANGEROUS_MODULE_RE = /(?:^|[^\w$.])(?:import\s[\s\S]{0,80}?from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:node:)?(?:fs(?:\/promises)?|child_process|cluster|dgram|net|tls|worker_threads|inspector|v8|vm|module)['"]/;
/** ① 拼接形式。允许实参里有一层嵌套括号（require(fn(a) + 'x')），
 *  且遇到 `)` 即停，因此 `require('x')` 之后的加法不会被误判。 */
const CONCAT_LOAD_RE = /(?:require|import)\s*\(\s*(?:[^()"'\`;]|\([^()]*\)|['"][^'"]*['"])*?\+/;
/** ② 模板串形式：import(`node:${m}`) */
const TEMPLATE_LOAD_RE = /(?:require|import)\s*\(\s*\`[^\`]*\$\{/;
/** ③ process.getBuiltinModule，绕过所有 import/require 形态的模块检查。 */
const GET_BUILTIN_MODULE_RE = /process\s*\.\s*getBuiltinModule\b/;
/** 凭据文件与进程环境（与 extension-forge/gate.js 同口径，两处都要守）。 */
const CREDENTIAL_RE = /account\.json|config\.json|\.env\b|dshProviderKeys|accessToken|httpAccessToken|process\.env/;

/**
 * 递归读取入口所在目录下的所有 .js（跳过 node_modules）。
 *
 * 返回 `{ files, truncated }`，truncated 必须被调用方当作"不可信"处理。
 * 早期它静默截断（60 个文件 / 6 层目录），调用方见扫描结果为空就放行，
 * 于是"把危险代码放到第 61 个文件"就能绕过整个闸门（已实测）。
 * 上限本身保留（防止恶意目录树拖死扫描），但触顶 = 拒绝而不是放行。
 * 上限设得比任何真实插件都宽：内置最大的 conversation-memory 也只有二十来个 js。
 */
const SCAN_MAX_FILES = 500;
const SCAN_MAX_DEPTH = 12;

function readJsFiles(dir, entry, out = [], depth = 0) {
  if (depth > SCAN_MAX_DEPTH) return { files: out, truncated: true };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { files: out, truncated: false }; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = readJsFiles(p, entry, out, depth + 1);
      if (r.truncated) return r;
    } else if (/\.(js|mjs|cjs)$/i.test(e.name)) {
      if (out.length >= SCAN_MAX_FILES) return { files: out, truncated: true };
      try { out.push({ path: path.relative(dir, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8') }); } catch { /* ignore */ }
    }
  }
  return { files: out, truncated: false };
}

/**
 * 静态准入检查。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkPluginTrust(id, entryPath) {
  // 随应用分发的模块（在 builtin-modules.json 基线里）→ 放行
  // 必须按目录名比对，不能只按 id：id 写在第三方可编辑的清单文件里，
  // 拿 id 当判据等于"自称内置即可免检"。
  // 目录名同样是磁盘上真实的一级目录名，第三方装进来时会带自己的目录名，
  // 想冒充就得占掉内置模块的名字（那会与已安装的内置模块冲突）。
  const dirName = path.basename(path.dirname(path.resolve(entryPath)));
  // 目录名在基线里且整目录内容指纹与基线一致 → 放行。
  // 指纹不符可能是升级、手工改动或占名顶替（见 builtinContentMatches 注释），
  // 这时不能享受豁免，走下面的能力扫描。
  // `nameLooksBuiltin` 留给下面的文案：区分"第三方模块"与"被改动过的内置模块"，
  // 后者多半是 harness → 升级扩展 / 自动修复 的正常产物，提示不该写成抓到马。
  const nameLooksBuiltin = builtinModuleIds().has(dirName);
  const fingerprint = nameLooksBuiltin ? builtinContentMatches(builtinBaseline().get(dirName), entryPath) : null;
  if (fingerprint?.matches) {
    return { ok: true };
  }
  const builtinNote = fingerprint
    ? `内置模块「${id}」的以下文件与随包基线不一致：`
      + fingerprint.mismatches.map((item) => `${item.path}（${FINGERPRINT_MISMATCH_LABELS[item.type]}）`).join('、') + '。'
      + (fingerprint.lineEndingOnly.length
        ? `另有 ${fingerprint.lineEndingOnly.join('、')} 仅换行差异，已归一化且不影响校验。` : '')
      + '该模块失去内置指纹豁免，继续进行能力扫描。'
    : '';

  // 已登记为可信 → 放行（用户知情选择）。
  // 只按目录名匹配。早期同时认清单 id，而 id 是写在第三方自己那份
  // plugin.json/skill.json 里的，攻击者把清单 id 改成用户已信任的某个名字即可免检
  // （实测：目录名 totally-unrelated + 清单 id 写成 legit-plugin + 危险代码 → 放行）。
  // 那一刻 trustedPlugins 从"用户的白名单"变成了"攻击者抄一下就能用的通行证"。
  // 目录名是磁盘上真实的一级目录名，第三方装进来时无法自选
  // （安装器会对同名目录递增后缀），所以它才是可信判据。
  let trusted = [];
  try { trusted = getConfig().trustedPlugins || []; } catch { trusted = []; }
  if (Array.isArray(trusted) && trusted.map(String).includes(dirName)) return { ok: true };

  let files = [];
  let truncated = false;
  try {
    const r = readJsFiles(path.dirname(entryPath), entryPath);
    files = r.files; truncated = r.truncated;
  } catch { files = []; truncated = false; }
  if (!files.length && !truncated) return { ok: true }; // 一个 js 都没有 → 交给加载器自然报错

  // 扫描被截断时必须拒绝，不能放行（安全验证实测）。
  // 早期 `if (!files.length) return {ok:true}` 只在"一个都没扫到"时放行，
  // 但扫描本身有 60 个文件 / 6 层目录的上限，超限后静默停止，
  // 于是把 `require('node:child_process')` 放进第 61 个 .js 或第 7 层子目录，
  // 危险文件根本不在扫描结果里，闸门照样 `{ok:true}`。
  // 这属于"因为看不到所以放行"，方向反了：看不到就该按不可信处理。
  if (truncated) {
    return {
      ok: false,
      reason: builtinNote + `模块「${id}」的文件太多或嵌套太深，无法完成安全扫描（已扫描上限仍未见底）。`
        + '为了不放过暗藏的危险代码，这类模块默认拒绝加载。'
        + `若确认可信，请在 config.trustedPlugins 里加入 "${dirName}"。`
    };
  }

  const bad = [];
  for (const f of files) {
    if (DANGEROUS_MODULE_RE.test(f.text)) bad.push(`${f.path}（导入了高危 Node 模块）`);
    else if (CONCAT_LOAD_RE.test(f.text) || TEMPLATE_LOAD_RE.test(f.text)) bad.push(`${f.path}（运行期拼接/模板串决定加载目标 —— 静态检查覆盖不到）`);
    else if (GET_BUILTIN_MODULE_RE.test(f.text)) bad.push(`${f.path}（process.getBuiltinModule 可绕过模块检查）`);
    else if (CREDENTIAL_RE.test(f.text)) bad.push(`${f.path}（涉及凭据文件或进程环境）`);
    if (bad.length >= 3) break;
  }
  if (!bad.length) return { ok: true };

  return {
    ok: false,
    reason: builtinNote
      + `模块「${id}」的能力扫描命中：${bad.join('、')}。`
      + '扩展与宿主主进程共享权限，仍受宿主账号和操作系统权限约束。'
      + `若确认可信，请在 config.trustedPlugins 里加入它的目录名（这里填 "${dirName}"）。`
  };
}

/**
 * 把旧式 `{ when, examples, instruction }` 的 prompt 适配成 `sections`。
 *
 * 判据必须看 raw（清单原文），不能看 `manifest.prompt`：normalizePrompt 见到
 * 对象里有 `instruction` 就会先合成一个 `sections:[{id:'main', content}]`，
 * 若拿 manifest 判断"已有 sections"就会永远提前返回，`when` 与 `examples` 被静默丢掉，
 * 只剩 instruction。而"何时使用"恰恰是模型决定要不要调这个工具的最高价值线索。
 *
 * 修法：只看 raw 有没有显式写 `sections`。写了就不动；没写就按三段合成。
 */
// 导出是为了能单独测（旧形态的 when/examples 被静默丢掉过一次，见函数头注释）。
export function adaptLegacyPrompt(raw, manifest) {
  const p = raw?.prompt;
  if (!p || typeof p !== 'object') return manifest;
  // 已经是新形态（显式写了 sections）→ 不动
  if (Array.isArray(p.sections) && p.sections.length) return manifest;
  const lines = [];
  if (p.when) lines.push(`何时使用：${String(p.when).trim()}`);
  if (Array.isArray(p.examples) && p.examples.length) {
    const ex = p.examples.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (ex.length) lines.push(`示例：${ex.join(' / ')}`);
  }
  if (p.instruction) lines.push(String(p.instruction).trim());
  if (!lines.length) return manifest;
  manifest.prompt = {
    sections: [{ id: 'legacy', title: manifest.name || manifest.id, content: lines.join('\n'), priority: 50 }]
  };
  return manifest;
}

/**
 * Skill 持久化存储：api.storage.get / set / remove。
 *
 * 为什么必须有它：闸门的"高危模块"文案一直推荐「扩展的数据应当通过 api.storage() 读写」，
 * 但 createSkillApi 根本没提供 storage，模型 import fs 被 block，改用 api.storage()
 * 又不存在，两头都是死路。这里把承诺兑现：一个 key-value 文档，落在
 *   <DATA_DIR>/plugin-data/<skillId>/storage.json
 * 与 plugin-data 目录约定同源（extension-forge 等内置插件同一习惯），
 * 卸载重装不丢数据（storage.json 留在数据目录，不随扩展目录删除）。
 *
 * 设计取舍：
 *   - 同步读写 + 每次整文档落盘：扩展数据量小（配置、计数、缓存元数据），
 *     简单可靠优先；真有大数据需求的扩展本来就该走 requires 能力而非自存储。
 *   - 1MB 软上限：防模型生成的扩展把 base64 大图整进 storage，拖垮每次 set 的落盘。
 *   - key 必须非空字符串；value 为 undefined 时按 JSON 语义存 null。
 */
const SKILL_STORAGE_MAX_BYTES = 1024 * 1024;

function makeSkillStorage(skillId) {
  const dir = path.join(DATA_DIR, 'plugin-data', skillId);
  const file = path.join(dir, 'storage.json');
  const readAll = () => {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }   // 不存在/损坏都从空开始：存储坏了不能拖死整个扩展
  };
  const writeAll = (obj) => {
    const text = JSON.stringify(obj, null, 2);
    if (Buffer.byteLength(text, 'utf8') > SKILL_STORAGE_MAX_BYTES) {
      throw new Error(`storage 写入失败：数据超过 1MB 上限（当前 ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB）。`
        + '大体积内容请存文件并只在这里记路径，或清理旧键后再写。');
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 写文件时再报真实错误 */ }
    fs.writeFileSync(file, text, 'utf8');
  };
  return {
    get: (key, fallback = null) => {
      const all = readAll();
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
    },
    set: (key, value) => {
      if (typeof key !== 'string' || !key.trim()) throw new Error('storage.set：key 必须是非空字符串');
      // 这三个键在 JS 对象上有特殊语义：`all['__proto__'] = v` 不会写入数据，
      // 而是改掉对象原型（数据静默丢失 + 后续读取走原型链），
      // constructor / prototype 也会遮蔽真相。与其"能写不能读"，不如明确拒绝。
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`storage.set：key 不能是 "${key}"（会命中 JS 原型语义，数据无法正常存取）`);
      }
      const all = readAll();
      all[key] = value === undefined ? null : value;
      writeAll(all);
      return true;
    },
    remove: (key) => {
      const all = readAll();
      if (!Object.prototype.hasOwnProperty.call(all, key)) return false;
      delete all[key];
      writeAll(all);
      return true;
    }
  };
}

/**
 * 构造暴露给 Skill 的安全 API。
 * 与旧插件 API 的差别：多了 config / hook 注册 / 能力查询，但仍然只给白名单能力。
 */
// 内置化：harness 模块由核心直接注册，复用同一份 api 工厂。
// 两套实现对 storage/panel/registerTool 的前缀规则一旦分叉，工具名就会出现"两套命名"。
export function createSkillApi(skillId, permissions = []) {
  const has = (name) => permissions.includes(name);
  return {
    // 注册工具（自动加 skillId 前缀 + 绑定来源，便于开关联动与批量清理）
    registerTool: (def) => {
      if (!def?.id) throw new Error('工具必须提供 id');
      // 工具 id 会成为发给模型的 OpenAI function name，只允许 [a-zA-Z0-9_-]：
      // 用 ":" 或 "." 拼接会被严格端点（DeepSeek/OpenAI）以 400 invalid function name
      // 拒掉整个请求。这里统一 sanitize + 双下划线分隔。
      const sanitize = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
      // 总长不能超 64（OpenAI 上限）：skillId 截到 24、工具名截到 38，加 '__' 正好 64 以内
      const sid = sanitize(skillId).slice(0, 24);
      const tid = sanitize(def.id).slice(0, 38);
      const prefixedId = tid.startsWith(`${sid}__`) ? tid : `${sid}__${tid}`;
      // sanitize + 截断后撞名防护：同名工具若来自不同 Skill，后加载者会静默覆盖
      // 先加载者，至少留个告警，别让"谁的工具生效"变成未解之谜
      const existing = getTool(prefixedId);
      if (existing && existing.skillId && existing.skillId !== skillId) {
        console.warn(`[skill] ⚠️ 工具 id 冲突：${prefixedId} 已由 ${existing.skillId} 注册，${skillId} 的同名工具会覆盖它`);
      }
      // 运行时护栏：扩展工具统一套 guardToolExecute（超时 / 返回体截断 /
      // 连续失败熔断）。内置工具（tools.js 静态 defs）不经过 registerTool，
      // 不受影响；execute 不是函数的说明性 def 原样透传。
      // 详见 src/tool-guard.js 头注释：闸门管"装进来之前"，这里管"跑起来之后"。
      const guarded = typeof def.execute === 'function'
        ? guardToolExecute(def.execute, skillId, prefixedId)
        : def.execute;
      registerTool({ ...def, id: prefixedId, skillId, _plugin: skillId, execute: guarded });
      return prefixedId;
    },
    // 读取本 Skill 的配置（默认值已由 manifest.settings 合并）
    config: () => skillManager.settingsOf(skillId),
    // 持久化存储（<DATA_DIR>/plugin-data/<skillId>/storage.json）：
    // 扩展存状态/计数/缓存元数据的唯一正道，不需要 import fs，也不受高危闸拦截。
    //
    // 它同时是插件界面的数据通道：插件自带的页面（见 api.panel）读不到
    // stickers.json 之类的插件私有文件，但能 fetch `../@data/storage.json`。
    // 所以"要给页面看的东西"写进 storage 就够了，不需要新增任何接口。
    storage: makeSkillStorage(skillId),
    /**
     * 插件界面（可选）：把自己插件目录 / 运行时数据变成只读 URL。
     *
     * 什么时候用得上：插件在主进程里想给用户一个能点开的链接
     * （写进日志、塞进消息、或在设置里提示"界面在 XXX"）。页面自己则不需要它，
     * 页面里写相对路径就行（`viewer.js`、`../@data/storage.json`），
     * 那样连自己的 id 都不用知道，整份页面可以直接复制给别的插件用。
     *
     * 界面入口不在这里声明：入口写在 plugin.json 的 configSchema 里
     * （{ type:'action', panel:'panel/x.html' }），由宿主校验并渲染成按钮。
     * 完整契约见 src/skills/panel.js。
     */
    panel: {
      id: skillId,
      prefix: PANEL_ROUTE_PREFIX,
      /** 插件目录下某个资源的只读 URL（相对路径；扩展名要在白名单里）。非法返回 ''。 */
      url: (rel) => {
        const checked = normalizePanelAsset(rel);
        return checked.ok ? panelUrl(skillId, checked.path) : '';
      },
      /** plugin-data 下某个文件的只读 URL（默认就是 api.storage 的落盘文件）。 */
      dataUrl: (rel = PANEL_DATA_FILE) => panelDataUrl(skillId, rel)
    },
    // 查询其它 Skill 是否生效（用于"我依赖的知识库没开就别硬跑"这类判断）
    isSkillActive: (id, ctx = {}) => skillManager.isActive(id, ctx).active,
    /**
     * 软依赖调用：问"谁提供这个能力"，有就调、没有就静默返回 undefined。
     *
     * 与 manifest.requires 的区别（这个区分很重要）：
     *   requires          硬依赖：缺了就把本 Skill 判定为不可用，UI 显示"依赖未就绪"
     *   api.capability()  软依赖：有能力就增强，没有就降级，本 Skill 照常工作
     * 例：发言标签想在有"主人识别"模块时自动加〔主人〕标记，
     *     但没装那个模块时绝不该因此变成不可用，那就该用软依赖。
     *
     * 只取第一个生效的提供者（约定：同类能力只应有一个提供者）。
     */
    capability: (name, args = {}) => {
      for (const p of skillManager.getCapabilityProviders(name, {})) {
        try { return p.fn(args); } catch { return undefined; }
      }
      return undefined;
    },
    hasCapability: (name) => skillManager.hasCapability(name),
    // 日志（改道 logger，落盘 + 分级 + 脱敏）。
    // 原先只进 console：`data/logs/*.log` 里 [skill: 行数为 0，插件写的
    // 「群 X 进入禁言」这类关键证据只出现在 stdout，排障时等于不存在
    // （群禁言排查实测：app 日志全程零禁言记录）。
    // logger 是日志的唯一出口，secret 脱敏（sink）也只在这一层生效。
    log: (...args) => logger.info(`skill:${skillId}`, ...args),
    warn: (...args) => logger.warn(`skill:${skillId}`, ...args),
    error: (...args) => logger.error(`skill:${skillId}`, ...args),
    // 只有声明了 web_fetch 权限才拿得到 fetch。
    //
    // 以前这里直接给 `globalThis.fetch`，那是 Node 原生 fetch，
    // 本项目集中放在 safe-fetch.js 里的 SSRF 防护一条都不生效：声明了 web_fetch 的
    // 扩展可以 `fetch('http://127.0.0.1:3210/api/…')`，或打 `169.254.169.254` 云元数据。
    // UI 上这个权限呈现为"只读联网"，与实际能力面不符。
    // 现在转发到 guardedFetch：scheme 白名单 + 禁止 URL 内嵌凭据 + 域名 DNS 全记录内网
    // 检查 + 逐跳重定向校验 + 浏览锁定（与 web_fetch 工具同一套）；Response 语义
    // （text/json/body 流/headers/signal）原样保留，扩展代码不需要任何改动。
    // 注：本地/内网接口（自建图床等）需要 security.allowPrivateImageHosts = true 才放行。
    fetch: has('web_fetch')
      ? (input, init) => guardedFetch(input, init, { browseLocked: true })
      : () => Promise.reject(new Error(`Skill ${skillId} 未声明 web_fetch 权限`)),
    // 只有声明了 qq_sticker 权限才能调用 QQ 协议接口（取收藏表情、群成员信息等）。
    // 发送表情本身走 ctx.sender.sendSticker，无需额外 API；但同步收藏表情需要
    // onebot.call('fetch_custom_face_detail')，而 onebot 客户端只在主进程里。
    qqCall: has('qq_sticker')
      ? (method, params = {}) => {
          if (!onebotClient) return Promise.reject(new Error('OneBot 客户端尚未初始化'));
          return onebotClient.call(method, params);
        }
      : () => Promise.reject(new Error(`Skill ${skillId} 未声明 qq_sticker 权限`)),
    utils: {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      safeJsonParse: (text, fallback = null) => {
        try { return JSON.parse(text); } catch { return fallback; }
      }
    }
  };
}

/** 读取目录里的清单：优先 skill.json，其次 plugin.json（兼容旧插件）。 */
function readManifest(dir) {
  const skillPath = path.join(dir, 'skill.json');
  const pluginPath = path.join(dir, 'plugin.json');
  let file = null;
  let source = 'skill';
  if (fs.existsSync(skillPath)) file = skillPath;
  else if (fs.existsSync(pluginPath)) { file = pluginPath; source = 'plugin'; }
  if (!file) return { error: '缺少 skill.json / plugin.json', source };
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 去掉 UTF-8 BOM。Windows 上的编辑器（记事本、部分 VS Code 配置、
    // PowerShell 的 Out-File -Encoding utf8）默认会写 BOM，
    // 而 JSON.parse 遇到 \uFEFF 会直接抛 "Unexpected token"，
    // 表现为"清单明明是对的却加载失败"，而且报错信息完全不提 BOM，极难排查。
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return { raw, source, file };
  } catch (error) {
    return { error: `清单解析失败：${error.message}`, source };
  }
}

/**
 * 校验条目是否放在了语义正确的目录里。
 *
 * 只警告，不阻断加载，也不限制工具、providers 或 hooks 的执行。
 * 分类与主要用法不符时提示作者调整目录；能否触发取决于是否有真实调用方。
 *
 * 目录语义定义见 skills/manifest.js 的 DIR_KIND。
 */
function lintKindPlacement(kind, { manifest, toolIds, providers, hooks, promptSections }, log) {
  const warnings = [];
  if (!kind) return warnings;
  const hasTools = (toolIds || []).length > 0;
  const provides = Object.keys(providers || {}).length > 0 || Object.keys(hooks || {}).length > 0;

  if (kind === 'skill' && !hasTools) {
    const w = `${manifest.id} 在 skills/（LLM 型）却没有注册任何工具：模型无法直接调用工具，但已提供的能力、钩子或提示词仍可生效。`
      + '要么 registerTool，要么把它移到 plugins/（确定性型）。';
    warnings.push(w);
  }
  if (kind === 'plugin' && !provides) {
    const w = `${manifest.id} 在 plugins/（确定性型）却没有提供能力或钩子：不能由这些机制触发，但已注册的工具仍可供模型调用。`
      + '要么 export providers / hooks，要么把它移到 skills/（LLM 型，注册工具）。';
    warnings.push(w);
  }
  // 顺带覆盖第三种静默死角：连提示词片段都没有的纯工具技能。工具进了
  // 模型的列表，但策略段只字未提，模型不知道什么时候该用它（实测 sticker
  // 收藏功能 0 调用的根因就是这一类）。这条是提示不是错误。
  if (kind === 'skill' && hasTools && !manifest.prompt && typeof promptSections !== 'function') {
    warnings.push(`${manifest.id} 注册了工具但没有提示词片段（promptSections/prompt）：`
      + '模型能"调"到它，但不知道什么时候该用 —— 无人触发时检查策略段是否缺引导。');
  }
  for (const w of warnings) log(`[skill] ⚠️ ${w}`);
  return warnings;
}

/**
 * 加载单个 Skill 目录。
 *
 * 失败语义（两条都要成立，缺一不可）：
 *   ① 返回 loaded: false，会让 pruneMissing 把它当"存活"处理（不触发磁盘对齐卸载）；
 *   ② 带 loadError 注册进注册表，让 UI/`/api/skills` 能看到"加载失败 + 原因"。
 * 此前失败条目直接 return 不注册，用户放一个写错的插件在界面上的表现是
 * "它不存在"，只有启动日志里有一行 ❌，非常难排查。
 *
 * 重载失败时的旧实例保留：如果旧版本已在运行，先跑新 setup，成功才退役旧实例。
 * 历史实现是"先卸旧再装新"，新 setup 一抛错旧实例也已经被放倒，
 * 表现为"改错一个字母，正在正常工作的插件直接消失，直到修好为止"。
 * 现在失败时旧实例原样继续跑（stale-but-working 优于 down），error 文案会写明"沿用旧版本"。
 *
 * @returns {Promise<{dir, loaded, id?, error?, skill?}>}
 */
async function loadSkillDir(dir, { log = console.log, kind = null } = {}) {
  const dirName = path.basename(dir);
  const found = readManifest(dir);
  const hadPrevious = found.error ? null : skillManager.isLoaded(
    // manifest 还没解析出来时用目录名当 id 兜底（normalizeManifest 的 fallbackId 同源）
    (found.raw?.id ? String(found.raw.id) : dirName)
  );

  // ── 失败也要注册（带 loadError）────────────────────────────────────────
  // 注册后 /api/skills 与技能页就能显示"加载失败 + 原因"，而不是条目凭空消失。
  // 注册的 manifest 用最小骨架（只有 id/dir），能力/工具/钩子一概没有：失败的
  // Skill 不该有任何副作用，只是"可见"。
  const failRegister = (id, error) => {
    const existing = skillManager.registry.get(id);
    // 旧实例还活着且这次只是新版本坏了：保留旧实例（stale-but-working），
    // 只把失败文案挂到旧实例上，UI 显示"上次重载失败，正在沿用旧版本"。
    if (existing && !existing.loadError) {
      skillManager.errors.set(id, `${error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id, error: `${error}（保留旧版本）` };
    }
    skillManager.register({
      manifest: { id, name: id, version: '0.0.0', apiVersion: SKILL_API_VERSION, requires: [], capabilities: [], settings: {}, configSchema: {}, panels: [], prompt: null },
      source: found.source, dir,
      relDir: path.relative(APP_ROOT, dir).replace(/\\/g, '/'),
      kind,
      api: null, toolIds: [],
      available: null, availableReason: '', activate: null, deactivate: null,
      dispose: () => { unregisterToolsBySkill(id); },
      hooks: {}, providers: {}, promptSections: null,
      loadError: error
    });
    skillManager.errors.set(id, error);
    return { dir, loaded: false, id, error };
  };

  if (found.error) {
    const id = dirName;
    // 旧实例在跑（清单这次坏了但上次加载成功）：沿用旧实例，别把它放倒
    if (hadPrevious) {
      skillManager.errors.set(id, `${found.error}（已沿用旧版本继续运行）`);
      // 失败原因必须进日志：这条路径以前只写状态不打日志，
      // 日志里只剩"N 失败"的计数，排查时查不出是谁、为什么（conversation-memory 的现场）。
      log(`[skill] ❌ ${id}：${found.error}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id, error: `${found.error}（保留旧版本）` };
    }
    const r = failRegister(id, found.error);
    log(`[skill] ❌ ${id}：${found.error}`);
    return r;
  }

  const { manifest, problems } = normalizeManifest(found.raw, { fallbackId: dirName });
  for (const p of problems) log(`[skill] ⚠️ ${dirName}：${p}`);
  if (!isManifestUsable(manifest, problems)) {
    const error = `清单不可用：${problems.join('；')}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${error}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }
  // 旧 plugin.json 的 prompt 形态 → 新 prompt.sections，避免旧插件提示词静默失效
  adaptLegacyPrompt(found.raw, manifest);

  // 入口：skill.json 用 entry，旧 plugin.json 也是 entry；默认 index.js
  const entryRel = String(found.raw.entry || 'index.js');
  // entry 必须锁死在 Skill 自己的目录内。
  // id 已经在 manifest 里有正则校验，但 entry 才是权限更大的那个（它被直接 import 执行）。
  // 不校验的话 `"entry": "../../outside.js"` 可以执行 Skill 目录外的任意脚本，
  // 逃出"每个 Skill 自包含"的模型，也让 permissions 白名单形同虚设。
  const entryPath = path.resolve(dir, entryRel);
  const relToDir = path.relative(dir, entryPath);
  if (!relToDir || relToDir.startsWith('..') || path.isAbsolute(relToDir)) {
    // 路径穿越属于安全拒绝，不是普通失败：即使旧实例在跑也不沿用（entry
    // 已经越界，"旧版本"和这次磁盘上的东西未必是一回事），直接登记失败条目。
    const r = failRegister(manifest.id, `entry 必须是 Skill 目录内的相对路径：${entryRel}`);
    log(`[skill] ❌ ${manifest.id}：entry 越界已被拒绝`);
    return r;
  }
  // 符号链接也要挡住（realpath 之后重新判断是否仍在目录内）
  try {
    const realDir = fs.realpathSync(dir);
    const realEntry = fs.realpathSync(entryPath);
    const relReal = path.relative(realDir, realEntry);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      const r = failRegister(manifest.id, `entry 指向了 Skill 目录外（符号链接）：${entryRel}`);
      log(`[skill] ❌ ${manifest.id}：entry 经符号链接越界已被拒绝`);
      return r;
    }
  } catch { /* 文件不存在等情况交给下面统一报错 */ }
  if (!fs.existsSync(entryPath)) {
    const error = `入口文件不存在：${entryRel}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${error}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }

  // ── 静态准入：第三方插件的能力闸 ────────────────────────────────────────
  // 插件是以 `await import()` 直接进主进程的（见下方），与主进程共享同一个
  // `process` 全局。createSkillApi 的 permissions 只拦得住 fetch 一项，因为
  // fs 是插件自己 import 的，拦截层根本碰不到（extension-forge/index.js 里也是
  // 这么承认的）。也就是说：安装一个插件 = 授予它本进程全部权限，
  // 而 `permissions` 字段给人的印象是"权限受控"。
  //
  // 真正的隔离（worker_threads / 子进程 + JSON-RPC）工程量很大，这里先做一层
  // 成本极低、收益明确的静态准入：随应用分发的模块（builtin-modules.json 基线里的
  // 那 23 个）一律放行，它们本来就用 fs/child_process，与主程序同仓同版本。
  // 第三方模块（市场 zip / forge 生成 / 本地导入 / 自定义 roots）若触碰进程/网络栈
  // 则拒绝加载，必须在 config.trustedPlugins 里显式登记才放行。
  //
  // 注意别把判据写成「目录在 plugins/ 或 skills/ 下就算内置」：第三方装的插件
  // 恰好也装在这两个目录里（market.js 与 extension-forge 的安装逻辑），
  // 那样闸门会被完全绕过。判据必须是「打包那一刻就在基线清单里」。
  //
  // 这是"显式化信任边界"，不是"实现隔离"，但它把「装个插件就交出整机」
  // 从默认行为变成了知情选择。见 README 的「插件安全」一节。
  const trust = checkPluginTrust(manifest.id, entryPath);
  if (!trust.ok) {
    const error = trust.reason;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${error}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }

  let mod;
  try {
    const entryUrl = pathToFileURL(entryPath).href;
    // 加时间戳强制重新加载（热重载用）
    mod = await import(`${entryUrl}?t=${Date.now()}`);
  } catch (error) {
    const msg = `加载失败：${error.message}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${msg}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${msg}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${msg}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, msg);
    log(`[skill] ❌ ${manifest.id}：${msg}`);
    return r;
  }

  // register(api) 是旧插件入口；setup(api) 是新入口。两者都支持。
  const setupFn = typeof mod.setup === 'function' ? mod.setup
    : (typeof mod.register === 'function' ? mod.register : null);
  if (!setupFn && !mod.hooks && !mod.providers && !mod.activate) {
    const error = '入口需导出 setup(api)/register(api) 或 hooks/providers';
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${error}（已保留旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }

  // 读归一化后的 manifest.permissions（asArray + 去重），不读 found.raw：
  // 以前从 raw 读且要求恰好是数组，清单写 "permissions": "web_fetch"（字符串）
  // 会静默变成零权限，fetch 永远 reject 且毫无线索。
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const api = createSkillApi(manifest.id, permissions);

  // ── 新旧交替的顺序闸 ────────────────────────────────────────────────────
  // 目标有两个，且互相牵制：
  //   A. 新 setup 抛错 → 旧实例必须完好保留（stale-but-working 优于 down）；
  //   B. 新 setup 成功 → 新工具不能被旧实例的清理误删。
  //
  // 解法：把旧实例的退役拆成两段，夹住新 setup：
  //   第一段（setup 前）：只做"停副作用"，deactivate（停定时器/监听）。
  //     工具和能力先不清：万一 setup 抛错要走"保留旧实例"分支，清了就没了。
  //   第二段（setup 成功后）：清旧能力、从 registry 摘掉旧实例（不走
  //     unregister，它会 dispose + unregisterToolsBySkill(同 id)，把新工具
  //     一起删掉），最后 register 新实例。旧工具里"新版本没再注册"的孤儿 id
  //     由 loadPlugins 末尾的孤儿清扫兜底。
  //   - setup 抛错：deactivate 过了要补一个 activate 把旧实例救活，
  //     工具/能力/注册表全程未动，旧实例恢复原状继续跑。
  //   - setup 成功：新实例接管，无幽灵。
  const prevSkill = skillManager.registry.get(manifest.id);
  const prevWasLive = prevSkill && !prevSkill.loadError;
  if (prevWasLive) {
    try {
      if (typeof prevSkill.deactivate === 'function') prevSkill.deactivate({ reason: 'reload' });
    } catch (error) { log(`[skill] ⚠️ ${manifest.id} 旧实例 deactivate 失败：${error?.message ?? error}`); }
  }

  const toolIds = [];
  const collectingRegister = (def) => {
    const id = api.registerTool(def);
    toolIds.push(id);
    return id;
  };
  const apiWithCollect = { ...api, registerTool: collectingRegister };

  // 跑新 setup。此时旧实例只停了副作用（deactivate），工具/能力/注册表未动，
  // 抛错就走下面的"救活旧实例"分支。
  try {
    if (setupFn) await setupFn(apiWithCollect);
  } catch (error) {
    // 注册失败：把已注册的工具回滚，避免"半个 Skill"残留在工具列表里
    if (toolIds.length) unregisterToolsBySkill(manifest.id);
    const msg = `注册失败：${error.message}`;
    if (hadPrevious) {
      // 救活旧实例：deactivate 过了要补 activate（对话记忆这类 Skill 的
      // 后台定时器就靠它恢复）。工具/能力/注册表全程未动，恢复原状。
      try { if (typeof prevSkill.activate === 'function') prevSkill.activate({ reason: 'reload-failed' }); }
      catch (e2) { log(`[skill] ⚠️ ${manifest.id} 旧实例激活失败：${e2?.message ?? e2}`); }
      skillManager.errors.set(manifest.id, `${msg}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${msg} —— 已保留旧版本继续运行`);
      return { dir, loaded: false, id: manifest.id, error: `${msg}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, msg);
    log(`[skill] ❌ ${manifest.id}：${msg}`);
    return r;
  }

  // setup 成功：完成旧实例退役的第二段。
  // 不能走 skillManager.unregister，它会 dispose（内部 unregisterToolsBySkill
  // 同 id）把新注册的工具一起删掉。这里手动收尾：
  //   - 清旧能力（新 setup 注册的能力马上会在 register() 里重新登记）
  //   - 从 registry 摘掉旧实例，让下面 register() 看不到 prev、不会触发其内置
  //     的 dispose 路径。
  // 旧工具不在这里清：新 setup 用 registerTool 覆盖了同 id 定义，旧版本独有
  // （新版本没注册）的旧 id 由"loader 级孤儿清扫"兜底（见 loadPlugins 末尾）。
  if (prevSkill) {
    skillManager.capabilities.removeOwner(manifest.id);
    skillManager.registry.unregister(manifest.id);
    skillManager.errors.delete(manifest.id);
  }

  // 旧 plugin.json 的 tools[] 是说明性元数据（加载器不消费，工具靠入口 registerTool 注册）。
  // 声明了却没注册说明作者写漏了，明确告警，别让它静默变成一个不存在的工具。
  const declaredTools = Array.isArray(found.raw.tools)
    ? found.raw.tools.map((t) => String(t?.id || t?.name || '')).filter(Boolean)
    : [];
  if (declaredTools.length) {
    const registeredShort = new Set(toolIds.map((id) => {
      const idx = id.indexOf('__');           // 新前缀是 skillId__toolId
      return idx >= 0 ? id.slice(idx + 2) : (id.includes(':') ? id.split(':').pop() : id);
    }));
    const missingTools = declaredTools.filter((d) => !registeredShort.has(d));
    if (missingTools.length) {
      log(`[skill] ⚠️ ${manifest.id}：清单 tools[] 声明了 ${missingTools.join(', ')}，`
        + '但入口没有 registerTool —— 清单里的 tools 只是元数据，不会被自动注册');
    }
  }

  const skill = {
    manifest,
    source: found.source,
    dir,
    // 仓库相对目录 + 目录语义类型，供状态视图/UI/审计使用
    relDir: path.relative(APP_ROOT, dir).replace(/\\/g, '/'),
    // 目录语义类型：'plugin'（确定性型）/ 'skill'（LLM 型）/ null（自定义根，不判定）
    kind,
    api: apiWithCollect,
    toolIds,
    // 生命周期与扩展点（可选）
    available: typeof mod.available === 'function' ? mod.available : null,
    availableReason: '',
    activate: typeof mod.activate === 'function' ? mod.activate : null,
    deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : null,
    dispose: typeof mod.dispose === 'function' ? () => {
      try { mod.dispose(); } finally { unregisterToolsBySkill(manifest.id); }
    } : () => { unregisterToolsBySkill(manifest.id); },
    hooks: (mod.hooks && typeof mod.hooks === 'object') ? mod.hooks : {},
    providers: (mod.providers && typeof mod.providers === 'object') ? mod.providers : {},
    promptSections: typeof mod.promptSections === 'function' ? mod.promptSections : null
  };
  skill.loadError = null;

  const r = skillManager.register(skill);
  if (!r.ok) {
    // 管理器拒绝（如 id 冲突校验失败）：已注册的工具必须回滚，否则留下无 Skill 的孤儿工具
    if (toolIds.length) unregisterToolsBySkill(manifest.id);
    const r2 = failRegister(manifest.id, r.error);
    return r2;
  }

  // 两型语义校验：把"放错目录导致功能静默失效"变成启动时的明确警告。
  // 同时落到 skill.lintWarnings，此前只进 console，
  // 用户在界面上看到"生效中"却不知道模型根本调不到。
  skill.lintWarnings = lintKindPlacement(kind, skill, log);

  log(`[skill] ✅ 加载成功：${manifest.name}（${manifest.id} v${manifest.version}，api v${manifest.apiVersion || SKILL_API_VERSION}）`);
  return { dir, loaded: true, id: manifest.id, skill };
}

/** 扫描一个目录下的所有 Skill。 */
async function loadSkillRoot(rootDir, { log = console.log, label = 'skill' } = {}) {
  if (!fs.existsSync(rootDir)) {
    // 不再静默：目录找不到必须打日志（历史上这里返回 missing 后被丢弃，
    // 表现为"安装版一个 Skill 都没有，且日志里毫无线索"）。
    log(`[${label}] ⚠️ 目录不存在，已跳过：${rootDir}`);
    return { loaded: [], failed: [], missing: true, rootDir };
  }
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(rootDir, e.name));
  if (!dirs.length) {
    log(`[${label}] ${path.basename(rootDir)}/ 为空：${rootDir}`);
    return { loaded: [], failed: [], empty: true, rootDir };
  }

  const results = [];
  const kind = kindOfDir(rootDir);
  for (const dir of dirs) {
    // 逐个串行加载：并行 import 时若两个 Skill 抢同一 id，顺序不确定
    results.push(await loadSkillDir(dir, { log, kind }));
  }
  const loaded = results.filter((r) => r.loaded);
  const failed = results.filter((r) => !r.loaded);
  log(`[${label}] ${path.basename(rootDir)}/（${rootDir}）：${loaded.length} 成功，${failed.length} 失败`);
  return { loaded, failed, rootDir };
}

/**
 * 加载全部 Skill（skills/ + plugins/）。
 * 幂等：重复调用会重新加载并覆盖同 id 的 Skill（热重载依赖这个语义）。
 */
export async function loadPlugins({ log = console.log, roots = null } = {}) {
  const skillsRoot = roots?.skills ? path.resolve(roots.skills) : SKILLS_DIR;
  const pluginsRoot = roots?.plugins ? path.resolve(roots.plugins) : PLUGINS_DIR;
  skillManager.setLog(log);
  const skillRes = await loadSkillRoot(skillsRoot, { log, label: 'skill' });
  const pluginRes = await loadSkillRoot(pluginsRoot, { log, label: 'plugin' });
  // 与磁盘对齐：把已经不存在于任何目录里的 Skill 卸掉（开发期删目录/改名的幽灵残留）。
  // 注意"存活集合"包含加载失败的 id：文件还在只是这次没加载成功，不触发卸载。
  // 加载失败的 Skill 现在分两种：
  //   - 有旧实例在跑 → 旧实例保留继续工作（loadSkillDir 的 stale-but-working 分支）；
  //   - 首次就失败   → 带 loadError 注册进表（UI 可见），不产生任何副作用。
  const aliveIds = [
    ...skillRes.loaded.map((r) => r.id), ...skillRes.failed.map((r) => r.id),
    ...pluginRes.loaded.map((r) => r.id), ...pluginRes.failed.map((r) => r.id)
  ].filter(Boolean);
  const pruned = skillManager.pruneMissing(aliveIds, {});
  if (pruned.length) log(`[skill] 已卸载磁盘上不存在的 Skill：${pruned.join(', ')}`);

  // 孤儿工具清扫：热重载覆盖注册后，旧版本独有（新版本没再注册）的工具
  // 不会有人清。unregisterToolsBySkill 会连新工具一起删（同 skillId 分不清
  // 彼此），所以只能在全部条目加载完之后，按"每个 Skill 声明的 toolIds"
  // 对账一遍。孤儿 = 注册表里有 skillId、但该 Skill 本轮没注册这个 id。
  const declaredToolIds = new Set();
  for (const s of skillManager.registry.list()) {
    for (const tid of s.toolIds || []) declaredToolIds.add(tid);
  }
  const orphanTools = listTools().filter((t) => t.skillId && !declaredToolIds.has(t.id));
  for (const t of orphanTools) unregisterTool(t.id);
  if (orphanTools.length) {
    log(`[skill] 已清理旧版本遗留的工具：${orphanTools.map((t) => t.id).join(', ')}`);
  }
  return {
    loaded: [...skillRes.loaded, ...pluginRes.loaded],
    failed: [...skillRes.failed, ...pluginRes.failed],
    pruned,
    dirs: { skills: skillsRoot, plugins: pluginsRoot }
  };
}

/**
 * 监听目录变化（热重载）。
 * 重载策略：只重载"变化的那个 Skill"不可靠（Node 的 fs.watch 只给文件名、不给语义），
 * 因此整体重新扫描；但不会清空工具注册表。逐个 Skill 注册时会覆盖同 id，
 * 旧 Skill 若已删除则需要显式清理，所以先按现存目录对比出被删除的 id。
 */
export function watchPlugins({ log = console.log, onReload, roots: rootsOpt = null, quietMs = 0 } = {}) {
  const skillsRoot = rootsOpt?.skills ? path.resolve(rootsOpt.skills) : SKILLS_DIR;
  const pluginsRoot = rootsOpt?.plugins ? path.resolve(rootsOpt.plugins) : PLUGINS_DIR;
  const roots = [skillsRoot, pluginsRoot].filter((d) => fs.existsSync(d));
  if (!roots.length) return null;

  let reloadTimer = null;
  let reloading = false;      // 重入保护：一次 reload 超 500ms 时，防抖计时器可能再触发第二次
  let pendingAgain = false;   // reload 期间又来了变化 → 结束后再补一轮
  // 静默期可由调用方预置（reloadSkills 重建 watcher 时传 2500）：
  // 重扫自己会 import/触碰 skill 目录，新 watcher 没有静默期就会被自己的
  // 余波立刻再触发一轮全量重扫（旧 watcher 的静默期随 close 作废）。
  let quietUntil = quietMs > 0 ? Date.now() + quietMs : 0;
  const watchers = [];
  const QUIET_MS = 2500;
  const runReload = async (filename) => {
    if (reloading) { pendingAgain = true; return; }
    reloading = true;
    // ── 批量静默期必须从 loadPlugins 之前开始 ──────────────────────────────
    // loadSkillRoot 串行 await 每个插件，setup() 在 import 期间注册自己的工具，
    // 于是 N 个插件 = N 次工具集增长。这个循环就在下面一行，所以 begin 必须在
    // try 之前，放在 onReload 里（reloadSkills）已经太晚，那时中间态早就
    // 被活跃群聊的请求看见并各断一次缓存了。
    // onReload 内部的 reloadSkills 还会再 begin 一次（嵌套计数），两层都安全。
    beginToolsetBatch();
    try {
      log(`[skill] 检测到变化：${filename || ''}，重新扫描…`);
      const result = await loadPlugins({ log, roots: { skills: skillsRoot, plugins: pluginsRoot } });
      if (typeof onReload === 'function') onReload(result);
    } catch (error) {
      log(`[skill] 热重载失败：${error?.message ?? error}`);
    } finally {
      endToolsetBatch();
      reloading = false;
      // 静默期：重扫本身会 import/触碰 skill 目录里的文件（实测 conversation-memory
      // 的 lib/ 触发了第二轮全量重扫，连扫两遍 → 系统提示重建 → 缓存断裂 ×2）。
      // 紧跟重扫结束的文件事件几乎都是重扫自己的余波，直接忽略，不再 pendingAgain。
      quietUntil = Date.now() + QUIET_MS;
      if (pendingAgain) { pendingAgain = false; scheduleReload('(补一轮)'); }
    }
  };
  const scheduleReload = (filename) => {
    if (Date.now() < quietUntil) {
      log(`[skill] 忽略重扫余波事件（静默期）：${filename || ''}`);
      return;
    }
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { runReload(filename).catch(() => {}); }, 500);
  };

  for (const root of roots) {
    try {
      const watcher = fs.watch(root, { recursive: true }, (_e, filename) => scheduleReload(filename));
      // 防御操作系统在监听建立后报告的权限/目录失效：这些异步 error 不会
      // 被外层 try/catch 接住，缺少监听器会让 EventEmitter 直接终止进程。
      watcher.on('error', (error) => {
        try { log(`[skill] 目录监听失效 ${root}：${error?.message ?? error}（请手动刷新扩展以重建监听）`); }
        catch { /* 日志出口故障不能让 watcher 的错误处理再次抛出 */ }
      });
      watchers.push(watcher);
    } catch (error) {
      log(`[skill] 无法监听 ${root}：${error?.message ?? error}`);
    }
  }
  log(`[skill] 热重载已启用（监听 ${roots.map((r) => path.basename(r)).join(' + ')}）`);
  return {
    close: () => {
      // pending 的防抖定时器也必须清。原实现只关 fs.watch 句柄，
      // close 时若有一个 500ms 后待触发的 reloadTimer，它仍会跑完一整轮
      // loadPlugins + onReload（reloadSkills 每次重建 watcher 都会 close 旧的，
      // 于是一次文件变更最多触发 3 轮全量加载：旧 timer 一发 + runReload 一发
      // + 新 watcher 若再收到事件）。
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
    }
  };
}

/** 卸载一个 Skill（含工具回收）。 */
export function unloadSkill(id, context = {}) {
  return skillManager.unregister(id, context);
}

// ── 内部工具：给测试/排障用 ──
export const SKILL_DIRS = { skills: SKILLS_DIR, plugins: PLUGINS_DIR };
export { skillErrorText };
