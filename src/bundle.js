// 「打包带走 / 接收整包」——把一个实例的扩展 + 数据装进一个 zip，另一个实例拆开收下。
//
// ── 与 migrate.js 的分工 ──────────────────────────────────────────────────
//   migrate.js 面向"同一台机器上的另一个 data 目录"（路径直读）。
//   本模块面向"发给别人 / 换一台机器"：把同样的数据**装成包**，再加扩展。
//   数据落地仍然复用 migrate.applyImport —— 一套合并/去重/备份逻辑，不另起炉灶。
//
// ── 包里有什么（v1）────────────────────────────────────────────────────────
//   bundle.json                 来源、时间、逐项清单（人可读，脚本也可校验）
//   modules/skills/<dir>/**     勾选的技能
//   modules/plugins/<dir>/**    勾选的插件
//   data/messages/**            会话存档
//   data/memory/**              群友印象
//   data/*.json                 用量统计 / 提醒 / 表情配置
//
// ── 包里**永远没有**什么 ───────────────────────────────────────────────────
//   config.json（含 apiKey、QQ 号、网关 token、身份字段）
//   plugin-data/（插件私有存储 —— account-pool 这类里面就是账号凭据）
//   logs / 各类 cache / *.lock / window-state（运行态，搬过去只会制造脏状态）
//   这条边界写死在这里，不做成开关：一旦能"顺手带上密钥"，包就会被随手发出去。
//
// ── 安全立场 ─────────────────────────────────────────────────────────────
//   解包只解到 data/import-bundles/<id>/ 临时区，**不直接写 skills/ 或 plugins/**。
//   扩展必须由调用方（routes）逐个送进锻造台过闸 + 人工确认，才可能落地。
//   数据导入沿用 migrate 的备份 + 回滚。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { SKILLS_DIR, PLUGINS_DIR, isBuiltinModuleDir } from './plugin-loader.js';
import { buildZip } from './zip-build.js';
import { parseZip } from './zip-install.js';
import { logger } from './logger.js';
import { scanSource } from './migrate.js';

export const BUNDLE_FORMAT = 'qq-agent-bundle';
export const BUNDLE_VERSION = 1;

const EXPORT_ROOT = path.join(DATA_DIR, 'exports');
const IMPORT_ROOT = path.join(DATA_DIR, 'import-bundles');

// 整包要装的是"一个实例的存档"，尺度比单个扩展大一个数量级：
// 100 文件 / 32MB 那套是给插件包定的，直接套上来什么都装不下。
const BUNDLE_MAX_FILES = 20000;
const BUNDLE_MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_ZIP_BYTES = 256 * 1024 * 1024;
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '__pycache__', '.cache', '.forge-tmp']);
// .forge-origin.json 记录的是「这台机器上它从哪来」——跟着包走会让接收端误以为
// 自己也是从那个草稿装出来的。系统垃圾同理，一律不带。
const SKIP_FILE = new Set(['.forge-origin.json', 'Thumbs.db', '.DS_Store']);

/**
 * 可打包的数据类别。
 * dirs 走目录递归；files 是 data 根下的单文件（不存在就跳过，不算错误）。
 */
const DATA_CATEGORIES = [
  {
    key: 'messages', label: '会话存档', dirs: ['messages'], files: [],
    desc: '聊天记录本体（真相源）。接收端按消息 id 合并去重，或整会话覆盖。'
  },
  {
    key: 'memory', label: '群友印象', dirs: ['memory'], files: [],
    desc: '按成员合并、按内容去重。派生索引（memory-v3）不打包，导入后自动重建。'
  },
  {
    key: 'usage', label: '用量统计', dirs: [], files: ['usage-daily.json', 'usage-archived-days.json', 'usage-today.json'],
    desc: '每日用量只补缺；成本/调用累计在接收端相加。'
  },
  {
    key: 'reminders', label: '提醒', dirs: [], files: ['reminders.json'],
    desc: '待触发的提醒事项。'
  },
  {
    key: 'stickers', label: '表情配置', dirs: [], files: ['stickers.json'],
    desc: '表情包索引（素材本体在各插件自己的存储里，不随包走）。'
  }
];

/* ── 基础工具 ───────────────────────────────────────────────────────────── */

function readManifest(dir) {
  for (const name of ['skill.json', 'plugin.json']) {
    const fp = path.join(dir, name);
    if (!fs.existsSync(fp)) continue;
    try {
      let t = fs.readFileSync(fp, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      const j = JSON.parse(t);
      if (j && typeof j === 'object') return { manifest: j, file: name };
    } catch { /* 清单坏了就当没有 —— 打包侧不做修复，那是锻造台的事 */ }
  }
  return null;
}

function walkFiles(root, { limit = BUNDLE_MAX_FILES } = {}) {
  const out = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 10) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (SKIP_FILE.has(e.name)) continue;
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      total += st.size;
      if (total > BUNDLE_MAX_TOTAL) return;
      out.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, bytes: st.size });
    }
  };
  walk(root, 0);
  return out;
}

function dirSize(files) {
  return files.reduce((n, f) => n + f.bytes, 0);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function moduleKey(kind, dir) { return `${kind}:${dir}`; }

function kindBase(kind) { return kind === 'plugin' ? PLUGINS_DIR : SKILLS_DIR; }

function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').includes('..')) return '';
  return s;
}

/* ── 导出 ───────────────────────────────────────────────────────────────── */

/** 列出可打包的扩展与数据类别（含体积，供界面显示"这个有多大"）。 */
export function listBundleOptions() {
  const modules = [];
  for (const kind of ['skill', 'plugin']) {
    const base = kindBase(kind);
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(base, e.name);
      const m = readManifest(dir);
      if (!m) continue;
      const files = walkFiles(dir);
      modules.push({
        key: moduleKey(kind, e.name),
        kind,
        dir: e.name,
        id: String(m.manifest.id || e.name),
        name: String(m.manifest.name || e.name),
        version: String(m.manifest.version || ''),
        description: String(m.manifest.description || '').slice(0, 140),
        builtin: isBuiltinModuleDir(e.name),
        files: files.length,
        bytes: dirSize(files)
      });
    }
  }
  modules.sort((a, b) => (Number(a.builtin) - Number(b.builtin)) || a.name.localeCompare(b.name));

  const data = DATA_CATEGORIES.map((c) => {
    let files = 0;
    let bytes = 0;
    for (const d of c.dirs) {
      const list = walkFiles(path.join(DATA_DIR, d));
      files += list.length;
      bytes += dirSize(list);
    }
    for (const f of c.files) {
      try {
        const st = fs.statSync(path.join(DATA_DIR, f));
        if (st.isFile()) { files += 1; bytes += st.size; }
      } catch { /* 不存在 */ }
    }
    return { key: c.key, label: c.label, desc: c.desc, files, bytes };
  });

  return { ok: true, modules, data, exportsDir: EXPORT_ROOT, importDir: IMPORT_ROOT };
}

/**
 * 打包。
 * @param {{modules?: string[], data?: string[]|Record<string,boolean>, note?: string, appVersion?: string}} opts
 * @returns {{ok:true, file:string, name:string, bytes:number, modules:number, dataFiles:number}}
 */
export function exportBundle({ modules = [], data = [], note = '', appVersion = '' } = {}) {
  const picked = new Set((Array.isArray(modules) ? modules : []).map(String));
  const dataKeys = new Set(
    (Array.isArray(data) ? data : Object.keys(data || {}).filter((k) => data[k])).map(String)
  );
  if (!picked.size && !dataKeys.size) {
    return { ok: false, error: '没有勾选任何内容（至少选一个扩展或一类数据）' };
  }

  const entries = [];
  const manifestModules = [];
  let dataFiles = 0;

  for (const key of picked) {
    const [kind, dir] = String(key).split(':');
    if (kind !== 'skill' && kind !== 'plugin') continue;
    if (!dir || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dir)) continue;
    const base = path.join(kindBase(kind), dir);
    if (!fs.existsSync(base)) continue;
    const m = readManifest(base);
    if (!m) continue;
    const files = walkFiles(base);
    if (!files.length) continue;
    const prefix = `modules/${kind}s/${dir}/`;
    for (const f of files) {
      entries.push({ name: prefix + f.rel, data: fs.readFileSync(f.abs) });
    }
    manifestModules.push({
      key: moduleKey(kind, dir),
      kind,
      dir,
      id: String(m.manifest.id || dir),
      name: String(m.manifest.name || dir),
      version: String(m.manifest.version || ''),
      files: files.length,
      bytes: dirSize(files)
    });
  }

  const manifestData = [];
  for (const cat of DATA_CATEGORIES) {
    if (!dataKeys.has(cat.key)) continue;
    let n = 0;
    let bytes = 0;
    for (const d of cat.dirs) {
      const root = path.join(DATA_DIR, d);
      const files = walkFiles(root);
      for (const f of files) {
        entries.push({ name: `data/${d}/${f.rel}`, data: fs.readFileSync(f.abs) });
        n += 1;
        bytes += f.bytes;
      }
    }
    for (const f of cat.files) {
      const abs = path.join(DATA_DIR, f);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) continue;
        entries.push({ name: `data/${f}`, data: fs.readFileSync(abs) });
        n += 1;
        bytes += st.size;
      } catch { /* 不存在 */ }
    }
    if (n) {
      dataFiles += n;
      manifestData.push({ key: cat.key, label: cat.label, files: n, bytes });
    }
  }

  if (!entries.length) return { ok: false, error: '勾选的内容都是空的，没有可打包的文件' };

  const createdAt = new Date().toISOString();
  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt,
    appVersion: String(appVersion || ''),
    note: String(note || '').slice(0, 500),
    modules: manifestModules,
    data: manifestData,
    // 写进包里的一行承诺：接收端可以据此告诉用户"里面没有凭据"
    excludes: ['config.json（含 API Key / QQ 号 / 网关 token）', 'plugin-data（插件私有存储，可能含账号凭据）',
      'logs / cache / *.lock（运行态）']
  };

  const zip = buildZip([
    { name: 'bundle.json', data: JSON.stringify(manifest, null, 2) },
    ...entries
  ]);
  if (zip.length > MAX_BUNDLE_ZIP_BYTES) {
    return { ok: false, error: `包体积 ${(zip.length / 1048576).toFixed(1)}MB 超过上限 ${Math.round(MAX_BUNDLE_ZIP_BYTES / 1048576)}MB，请减少勾选项` };
  }

  fs.mkdirSync(EXPORT_ROOT, { recursive: true });
  const name = `qqagent-bundle-${stamp()}.zip`;
  const file = path.join(EXPORT_ROOT, name);
  fs.writeFileSync(file, zip);
  logger.info('bundle', `导出整包：${name}（${manifestModules.length} 个扩展 / ${dataFiles} 个数据文件 / ${(zip.length / 1024).toFixed(0)}KB）`);
  return {
    ok: true,
    file,
    name,
    bytes: zip.length,
    modules: manifestModules.length,
    dataFiles,
    manifest
  };
}

/* ── 接收 ───────────────────────────────────────────────────────────────── */

function newBundleId() {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

/** 只保留最近 N 个解包临时区，避免 data 目录越堆越大。 */
function pruneImportRoot(keep = 5) {
  try {
    const ents = fs.readdirSync(IMPORT_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, at: fs.statSync(path.join(IMPORT_ROOT, e.name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const e of ents.slice(keep)) {
      fs.rmSync(path.join(IMPORT_ROOT, e.name), { recursive: true, force: true });
    }
  } catch { /* 清理失败不影响本次接收 */ }
}

/**
 * 检查一个包并解到临时区（不安装任何东西）。
 *
 * @param {{filePath?:string, buffer?:Buffer}} src 二选一；filePath 是主路径
 *   （存档包动辄几十 MB，走 HTTP upload 会撞 readBody 的上限，本机直接读盘更实在）。
 * @returns {{ok:true, bundleId:string, manifest:object, modules:Array, data:Array, scan:object}}
 */
export function inspectBundle({ filePath = '', buffer = null } = {}) {
  let p = String(filePath || '').trim();
  let buf = buffer;
  if (!Buffer.isBuffer(buf)) {
    if (!p) return { ok: false, error: '缺少包文件路径' };
    const abs = path.resolve(p);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* 不存在 */ }
    if (!st || !st.isFile()) return { ok: false, error: `文件不存在：${abs}` };
    if (st.size > MAX_BUNDLE_ZIP_BYTES) {
      return { ok: false, error: `包体积 ${(st.size / 1048576).toFixed(1)}MB 超过上限 ${Math.round(MAX_BUNDLE_ZIP_BYTES / 1048576)}MB` };
    }
    buf = fs.readFileSync(abs);
    p = abs;
  }
  if (!buf.length) return { ok: false, error: '包是空的' };

  let entries = [];
  try {
    entries = parseZip(buf, { maxFiles: BUNDLE_MAX_FILES, maxTotal: BUNDLE_MAX_TOTAL });
  } catch (e) {
    return { ok: false, error: `不是有效的压缩包：${e.message}` };
  }

  const bj = entries.find((e) => e.name === 'bundle.json');
  if (!bj) {
    return {
      ok: false,
      error: '这个包里没有 bundle.json —— 它不是「整包」（可能是单个扩展包或普通 zip）。'
        + '单个扩展请用锻造台的「改别人的包」导入。'
    };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(bj.data.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, error: `bundle.json 不是合法 JSON：${e.message}` };
  }
  if (!manifest || manifest.format !== BUNDLE_FORMAT) {
    return { ok: false, error: `不是本程序的整包（format=${manifest?.format ?? '缺失'}）` };
  }
  if (Number(manifest.version) > BUNDLE_VERSION) {
    return { ok: false, error: `包格式版本 ${manifest.version} 比本机支持的 ${BUNDLE_VERSION} 新，请升级应用后再接收` };
  }

  const bundleId = newBundleId();
  const root = path.join(IMPORT_ROOT, bundleId);
  let files = 0;
  let bytes = 0;
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const e of entries) {
      if (e.name === 'bundle.json') continue;
      const rel = safeRel(e.name);
      if (!rel) continue;
      const dest = path.join(root, ...rel.split('/'));
      const relCheck = path.relative(root, dest);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
      files += 1;
      bytes += e.data.length;
    }
  } catch (e) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `解包失败：${e.message}` };
  }

  // 以**磁盘上实际存在的目录**为准列模块（不照抄清单：清单可能被改过，
  // 而且用户要看到的是"这个包里真的有什么可以装"）。
  const modules = [];
  for (const kind of ['skill', 'plugin']) {
    const base = path.join(root, 'modules', `${kind}s`);
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      const m = readManifest(dir);
      if (!m) continue;
      const list = walkFiles(dir);
      const declared = (manifest.modules || []).find((x) => x.dir === e.name && x.kind === kind) || null;
      modules.push({
        key: moduleKey(kind, e.name),
        kind,
        dir: e.name,
        id: String(m.manifest.id || e.name),
        name: String(m.manifest.name || e.name),
        version: String(m.manifest.version || ''),
        description: String(m.manifest.description || '').slice(0, 140),
        files: list.length,
        bytes: dirSize(list),
        declaredVersion: declared ? String(declared.version || '') : ''
      });
    }
  }

  // 数据侧复用 migrate 的扫描：能给出"源有几条 / 目标有几条 / 会多出多少"，
  // 接收端据此决定要不要导、导哪些会话。
  // 只有模块、没有数据的包是合法形态（有人只想送扩展）—— 不要把它报成"扫描失败"。
  const dataRoot = path.join(root, 'data');
  let scan = null;
  if (fs.existsSync(dataRoot)) {
    try {
      scan = scanSource(dataRoot);
    } catch (e) {
      scan = { ok: false, error: String(e?.message ?? e) };
    }
  } else {
    scan = { ok: true, messages: [], memory: { available: false, chats: [] }, stats: [], excluded: [] };
  }

  pruneImportRoot();
  logger.info('bundle', `接收整包：${p || '(upload)'} → ${bundleId}（${modules.length} 个扩展 / ${files} 个文件 / ${(bytes / 1024).toFixed(0)}KB）`);
  return {
    ok: true,
    bundleId,
    manifest: {
      createdAt: manifest.createdAt || '',
      appVersion: manifest.appVersion || '',
      note: manifest.note || '',
      modules: manifest.modules || [],
      data: manifest.data || [],
      excludes: manifest.excludes || []
    },
    modules,
    data: (manifest.data || []).map((d) => ({
      ...d,
      present: fs.existsSync(path.join(root, 'data')) && (
        DATA_CATEGORIES.find((c) => c.key === d.key)?.dirs || []
      ).some((dir) => fs.existsSync(path.join(root, 'data', dir)))
    })),
    files,
    bytes,
    scan
  };
}

/** 取某个模块的独立 zip（交给 forge.import-zip：它会剥层、校验、写暂存区）。 */
export function moduleZipOf(bundleId, key) {
  const id = String(bundleId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const [kind, dir] = String(key || '').split(':');
  if (!id || (kind !== 'skill' && kind !== 'plugin') || !dir) return null;
  const base = path.join(IMPORT_ROOT, id, 'modules', `${kind}s`, dir);
  if (!fs.existsSync(base)) return null;
  const files = walkFiles(base);
  if (!files.length) return null;
  return buildZip(files.map((f) => ({ name: f.rel, data: fs.readFileSync(f.abs) })));
}

/** 数据侧的"源目录"：结构上等同另一个实例的 data，可直接喂给 migrate。 */
export function dataDirOf(bundleId) {
  const id = String(bundleId || '').replace(/[^a-zA-Z0-9-]/g, '');
  return path.join(IMPORT_ROOT, id, 'data');
}

/** 丢弃解包临时区（用户取消 / 装完清理）。 */
export function discardBundle(bundleId) {
  const id = String(bundleId || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!id) return { ok: false, error: '缺少 bundleId' };
  try { fs.rmSync(path.join(IMPORT_ROOT, id), { recursive: true, force: true }); }
  catch (e) { return { ok: false, error: `清理失败：${e.message}` }; }
  return { ok: true };
}
