// 备份包（.qqab）的构建与解析。
//
// 与 bundle.js 的分工：bundle 面向"把一份整包发给别人"，会带上用户扩展；
// 备份面向"这台机器自己的定时存档"，只装数据，装好后交给目标适配器上传，
// 下载回来先校验 sha256 再交给 migrate.applyImport 落地（绝不自己覆盖文件）。
// 数据类别与打包/解包都复用 bundle.js / zip-build.js / zip-install.js，
// 不另起一套分类或压缩实现。
//
// 普通备份只含类别白名单；包含密钥时额外加入 config.json 并强制加密。
// plugin-data/ 始终排除。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { DATA_CATEGORIES } from '../bundle.js';
import { buildZip } from '../zip-build.js';
import { parseZip } from '../zip-install.js';
import { logger } from '../logger.js';
import { encryptPayload } from './crypto.js';

export const BACKUP_FORMAT = 'qq-agent-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_EXT = '.qqab';
/** 目标内的相对路径前缀：与备份文件本身分开，便于本地目标目录混放其他文件。 */
export const BACKUP_KEY_PREFIX = 'qq-agent/';

// 与 bundle 同口径的整包尺度：备份装的是实例存档，不是单个扩展包。
const BACKUP_MAX_FILES = 20000;
const BACKUP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const BACKUP_MAX_FILE_BYTES = 64 * 1024 * 1024;
const BACKUP_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const WALK_MAX_DEPTH = 10;
const MANIFEST_NAME = 'manifest.json';
const EXCLUDED_DATA_DIRS = new Set(['plugin-data', 'logs', 'cache', '.cache', 'node_modules', '.git']);
const EXCLUDED_DATA_FILE = /^(?:config\.json|backup-crypto\.salt)$|\.(?:lock|salt|tmp|bak)$/i;

function readBackupFile(name, file) {
  const stat = fs.lstatSync(file);
  const dataRoot = fs.realpathSync(DATA_DIR);
  const expected = path.resolve(dataRoot, path.relative(DATA_DIR, file));
  if (stat.isSymbolicLink() || path.relative(expected, fs.realpathSync(file))) {
    throw new Error('备份源包含符号链接或目录联接，拒绝读取可能含凭据的文件');
  }
  const data = fs.readFileSync(file);
  if (name !== 'data/config.json') return data;
  let config;
  try { config = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('包含密钥的备份要求 config.json 是有效 JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config.json 必须是配置对象');
  // 每个目标会收到同一份包；不把其他目标的凭据与地址横向复制过去。
  delete config.backup;
  return Buffer.from(JSON.stringify(config));
}

/** 可备份的数据类别（只读视图，防止调用方改坏 bundle.js 的定义）。 */
export function listBackupCategories() {
  return DATA_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    desc: c.desc,
    dirs: [...c.dirs],
    files: [...c.files]
  }));
}

/**
 * 规范化类别选择：只保留已知类别，去重并排序。
 * 排序是为了让"同一组类别"在任何顺序下得到同一个包，便于多目标共用一次构建。
 */
export function normalizeCategories(input) {
  const raw = Array.isArray(input)
    ? input
    : Object.keys(input || {}).filter((k) => input[k]);
  const known = new Set(DATA_CATEGORIES.map((c) => c.key));
  return [...new Set(raw.map(String))].filter((k) => known.has(k)).sort();
}

function walkFiles(root) {
  const out = [];
  let total = 0;
  let excluded = 0;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('备份类别目录不能是符号链接或目录联接');
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  const walk = (dir, depth) => {
    if (depth > WALK_MAX_DEPTH) throw new Error('备份目录层级超过上限，拒绝生成不完整备份');
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT' && depth === 0) return;
      throw error;
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink() || EXCLUDED_DATA_FILE.test(e.name) || (e.isDirectory() && EXCLUDED_DATA_DIRS.has(e.name.toLowerCase()))) {
        excluded += 1;
        continue;
      }
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      let st = null;
      st = fs.statSync(abs);
      // 超限必须报错而不是静默跳过：少几个文件的"成功备份"比失败更危险，
      // 用户会以为存档完整。
      if (out.length >= BACKUP_MAX_FILES) {
        throw new Error(`文件数量超过上限 ${BACKUP_MAX_FILES}，请减少备份类别`);
      }
      if (st.size > BACKUP_MAX_FILE_BYTES) {
        throw new Error(`单个文件超过上限 ${Math.round(BACKUP_MAX_FILE_BYTES / 1048576)}MB：${path.relative(root, abs)}`);
      }
      if (total + st.size > BACKUP_MAX_TOTAL_BYTES) {
        throw new Error(`备份总量超过上限 ${Math.round(BACKUP_MAX_TOTAL_BYTES / 1048576)}MB，请减少备份类别`);
      }
      total += st.size;
      out.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, bytes: st.size });
    }
  };
  walk(root, 0);
  if (excluded) logger.warn('backup', `按安全边界排除 ${excluded} 个凭据、运行态或链接条目`);
  return out;
}

function safeRel(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').includes('..')) return '';
  return s;
}

/**
 * 载荷摘要：把除 manifest.json 外的条目按路径排序后逐段哈希。
 * 排序保证同一份内容在任何打包顺序下得到同一摘要；不使用 zip 整体摘要，
 * 因为 zip 头里的时间戳会让同样的内容每次产生不同哈希。
 */
export function computePayloadSha256(entries) {
  const h = crypto.createHash('sha256');
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sorted) {
    h.update(e.name, 'utf8');
    h.update(Buffer.from([0]));
    h.update(e.data);
  }
  return h.digest('hex');
}

/** 延续旧 key 的本地时间口径；提高精度并加随机后缀，避免覆盖已有包。 */
export function backupKeyFor(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const name = `backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${String(date.getMilliseconds()).padStart(3, '0')}-${crypto.randomBytes(4).toString('hex')}${BACKUP_EXT}`;
  return { name, key: BACKUP_KEY_PREFIX + name };
}

/** 目标里的条目是本次功能的备份文件吗（保留策略只清理自己的文件）。 */
export function isBackupKey(key) {
  const k = String(key || '');
  return /^qq-agent\/backup-\d{8}-\d{4}(?:\d{5}-[a-f0-9]{8})?\.qqab$/.test(k);
}

/**
 * 构建备份包。
 *
 * @param {{categories?: string[]|Record<string,boolean>, appVersion?: string,
 *          instanceId?: string, now?: Date, includeSecrets?: boolean, encrypt?: boolean}} opts
 * @param {{encryptPayload?: Function}} deps 仅供测试注入加密失败，不改变强制加密规则
 * @returns {{ok:true, key:string, name:string, buffer:Buffer, manifest:object, bytes:number, skippedCategories:Array<{key:string,label:string,reason:string}>}
 *          | {ok:false, error:string, skippedCategories:Array<{key:string,label:string,reason:string}>}}
 */
export function buildBackup({ categories = [], appVersion = '', instanceId = '', now = new Date(), includeSecrets = false, encrypt = false } = {}, { encryptPayload: encryptData = encryptPayload } = {}) {
  // includeSecrets 不允许通过 encrypt=false 绕过加密，更不能失败后降级明文。
  const encrypted = includeSecrets === true || encrypt === true;
  const cats = normalizeCategories(categories);
  const skippedCategories = [];
  if (!cats.length) return { ok: false, error: '没有选中任何数据类别', skippedCategories };

  const entries = [];
  let totalBytes = 0;
  const appendFile = (name, file) => {
    const size = fs.statSync(file).size;
    if (size > BACKUP_MAX_FILE_BYTES) throw new Error(`单个文件超过备份上限：${name}`);
    if (entries.length >= BACKUP_MAX_FILES - 1) throw new Error('文件数量超过备份上限');
    if (totalBytes + size > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份总量超过上限');
    const data = readBackupFile(name, file);
    if (data.length > BACKUP_MAX_FILE_BYTES || totalBytes + data.length > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份数据超过大小上限');
    totalBytes += data.length;
    entries.push({ name, data });
    return data.length;
  };
  const manifestCategories = [];
  try {
    for (const key of cats) {
      const cat = DATA_CATEGORIES.find((c) => c.key === key);
      let files = 0;
      let bytes = 0;
      for (const d of cat.dirs) {
        for (const f of walkFiles(path.join(DATA_DIR, d))) {
          if (f.bytes === 0) continue;
          const size = appendFile(`data/${d}/${f.rel}`, f.abs);
          files += 1;
          bytes += size;
        }
      }
      for (const f of cat.files) {
        const abs = path.join(DATA_DIR, f);
        let st = null;
        try { st = fs.statSync(abs); } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (!st.isFile() || st.size === 0) continue;
        const size = appendFile(`data/${f}`, abs);
        files += 1;
        bytes += size;
      }
      if (files) manifestCategories.push({ key, label: cat.label, files, bytes });
      else skippedCategories.push({ key, label: cat.label, reason: `本机还没有${cat.label}` });
    }
    if (includeSecrets === true && !entries.some((e) => e.name === 'data/config.json')) {
      const file = path.join(DATA_DIR, 'config.json');
      if (fs.existsSync(file)) {
        appendFile('data/config.json', file);
      }
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), skippedCategories };
  }
  if (!entries.length) {
    return { ok: false, error: '选中的类别目前都没有数据（可能是刚安装或还没产生聊天记录），没有可备份的内容', skippedCategories };
  }

  let payload = entries;
  try {
    if (encrypted) payload = [{ name: 'payload.enc', data: encryptData(buildZip(entries)) }];
  } catch (error) {
    return { ok: false, error: `备份加密失败：${error?.message ?? error}`, skippedCategories };
  }
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    appVersion: String(appVersion || ''),
    instanceId: String(instanceId || ''),
    encrypted,
    categories: manifestCategories,
    // 加密包哈希 payload.enc 的原始字节；明文包沿用排序条目集合摘要。
    // parseBackup 验证两种摘要；解密时 AES-GCM 另行验证真实性。
    sha256: encrypted ? crypto.createHash('sha256').update(payload[0].data).digest('hex') : computePayloadSha256(entries),
    files: entries
      .map((e) => ({ path: e.name, bytes: e.data.length }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };

  const manifestText = JSON.stringify(manifest, null, 2);
  if (payload.reduce((sum, entry) => sum + entry.data.length, Buffer.byteLength(manifestText)) > BACKUP_MAX_TOTAL_BYTES) {
    return { ok: false, error: '备份总量（含清单）超过上限', skippedCategories };
  }
  const zip = buildZip([
    { name: MANIFEST_NAME, data: manifestText },
    ...payload
  ]);
  if (zip.length > BACKUP_MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      skippedCategories,
      error: `备份包体积 ${(zip.length / 1048576).toFixed(1)}MB 超过上限 `
        + `${Math.round(BACKUP_MAX_ARCHIVE_BYTES / 1048576)}MB，请减少备份类别`
    };
  }

  const { name, key } = backupKeyFor(now);
  logger.info('backup', `构建备份包：${name}（${manifestCategories.length} 类 / ${entries.length} 个文件 / ${(zip.length / 1024).toFixed(0)}KB）`);
  return { ok: true, key, name, buffer: zip, manifest, bytes: zip.length, skippedCategories };
}

/**
 * 解析并校验备份包。下载后必须先过这里：sha256 不匹配直接拒绝，
 * 不给后续 applyImport 任何"先写一半再发现坏包"的机会。
 *
 * @param {Buffer} buffer
 * @param {{verify?: boolean}} opts verify=false 仅供已校验过的内部调用方
 * @returns {{ok:true, manifest:object, entries:Array<{name:string,data:Buffer}>, files:number, bytes:number, ciphertext?:Buffer, code?:string}
 *          | {ok:false, error:string, code?:string}}
 */
export function parseBackup(buffer, { verify = true } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: '备份包是空的' };
  }
  let entries = [];
  try {
    entries = parseZip(buffer, { maxFiles: BACKUP_MAX_FILES, maxTotal: BACKUP_MAX_TOTAL_BYTES });
  } catch (error) {
    return { ok: false, error: `不是有效的备份包：${error.message}` };
  }

  const manifestEntry = entries.find((e) => e.name === MANIFEST_NAME);
  if (!manifestEntry) return { ok: false, error: '备份包里没有 manifest.json' };

  let manifest = null;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8').replace(/^﻿/, ''));
  } catch (error) {
    return { ok: false, error: `manifest.json 不是合法 JSON：${error.message}` };
  }
  if (!manifest || typeof manifest !== 'object' || manifest.format !== BACKUP_FORMAT) {
    return { ok: false, error: `不是本程序的备份包（format=${manifest?.format ?? '缺失'}）` };
  }
  if (Number(manifest.version) > BACKUP_VERSION) {
    return { ok: false, error: `备份包格式版本 ${manifest.version} 比本机支持的 ${BACKUP_VERSION} 新，请升级应用后再恢复` };
  }
  if (manifest.encrypted === true) {
    const payload = entries.filter((e) => e.name !== MANIFEST_NAME);
    if (entries.length !== 2 || payload.length !== 1 || payload[0].name !== 'payload.enc') {
      return { ok: false, error: '加密备份包必须只包含 manifest.json 与 payload.enc' };
    }
    const ciphertext = payload[0].data;
    if (verify && manifest.sha256 !== crypto.createHash('sha256').update(ciphertext).digest('hex')) {
      return { ok: false, error: '备份包已损坏、被篡改，或来自另一台机器（sha256 不匹配）' };
    }
    return { ok: true, code: 'encrypted', manifest, ciphertext, entries: [], files: 0, bytes: ciphertext.length };
  }

  const payload = entries.filter((e) => e.name !== MANIFEST_NAME);
  if (verify) {
    const actual = computePayloadSha256(payload);
    if (String(manifest.sha256 || '') !== actual) {
      return { ok: false, error: '备份包校验失败（sha256 不匹配），文件可能已损坏或被篡改' };
    }
  }
  const bytes = payload.reduce((n, e) => n + e.data.length, 0);
  return { ok: true, manifest, entries: payload, files: payload.length, bytes };
}

/**
 * 把已解析的条目写到目录（只用于恢复前的临时解包区，数据落地仍走 applyImport）。
 * 路径逐条做二次校验，与 bundle.inspectBundle 同口径。
 */
export function extractEntries(entries, destDir) {
  if (!destDir) return { ok: false, error: '缺少解包目录' };
  const root = path.resolve(String(destDir));
  try {
    fs.mkdirSync(root, { recursive: true });
    let files = 0;
    for (const e of entries || []) {
      const rel = safeRel(e?.name);
      if (!rel) continue;
      const dest = path.join(root, ...rel.split('/'));
      const check = path.relative(root, dest);
      if (!check || check.startsWith('..') || path.isAbsolute(check)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
      files += 1;
    }
    return { ok: true, dir: root, files };
  } catch (error) {
    return { ok: false, error: `解包失败：${error.message}` };
  }
}

/** 解析 + 解包的便捷入口。 */
export function extractBackup(buffer, destDir, { verify = true } = {}) {
  const parsed = parseBackup(buffer, { verify });
  if (!parsed.ok) return parsed;
  if (parsed.manifest.encrypted === true) return { ok: false, code: 'encrypted', error: '加密备份包请通过恢复入口解密' };
  const out = extractEntries(parsed.entries, destDir);
  if (!out.ok) return out;
  return { ...out, manifest: parsed.manifest };
}

export default {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_EXT,
  BACKUP_KEY_PREFIX,
  listBackupCategories,
  normalizeCategories,
  computePayloadSha256,
  backupKeyFor,
  isBackupKey,
  buildBackup,
  parseBackup,
  extractEntries,
  extractBackup
};
