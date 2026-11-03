// 备份包（.qqab）的构建与解析。
//
// 与 bundle.js 的分工：bundle 面向"把一份整包发给别人"，会带上用户扩展；
// 备份面向"这台机器自己的定时存档"，只装数据，装好后交给目标适配器上传，
// 下载回来先校验 sha256 再交给 migrate.applyImport 落地（绝不自己覆盖文件）。
// 数据类别与打包/解包都复用 bundle.js / zip-build.js / zip-install.js，
// 不另起一套分类或压缩实现。
//
// 包里永远没有 config.json 与 plugin-data/：这两处由 DATA_CATEGORIES 的
// 白名单决定 —— 只有明确列出的类别才会进包。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { DATA_CATEGORIES } from '../bundle.js';
import { buildZip } from '../zip-build.js';
import { parseZip } from '../zip-install.js';
import { logger } from '../logger.js';

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
  const walk = (dir, depth) => {
    if (depth > WALK_MAX_DEPTH) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      if (!e.isFile()) continue;
      let st = null;
      try { st = fs.statSync(abs); } catch { continue; }
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

/** 备份文件名与目标内 key。时间戳到分钟，与规格里的 key 形态一致。 */
export function backupKeyFor(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const name = `backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${BACKUP_EXT}`;
  return { name, key: BACKUP_KEY_PREFIX + name };
}

/** 目标里的条目是本次功能的备份文件吗（保留策略只清理自己的文件）。 */
export function isBackupKey(key) {
  const k = String(key || '');
  return k.startsWith(BACKUP_KEY_PREFIX) && k.endsWith(BACKUP_EXT);
}

/**
 * 构建备份包。
 *
 * @param {{categories?: string[]|Record<string,boolean>, appVersion?: string,
 *          instanceId?: string, now?: Date}} opts
 * @returns {{ok:true, key:string, name:string, buffer:Buffer, manifest:object, bytes:number}
 *          | {ok:false, error:string}}
 */
export function buildBackup({ categories = [], appVersion = '', instanceId = '', now = new Date() } = {}) {
  const cats = normalizeCategories(categories);
  if (!cats.length) return { ok: false, error: '没有选中任何数据类别' };

  const entries = [];
  const manifestCategories = [];
  try {
    for (const key of cats) {
      const cat = DATA_CATEGORIES.find((c) => c.key === key);
      let files = 0;
      let bytes = 0;
      for (const d of cat.dirs) {
        for (const f of walkFiles(path.join(DATA_DIR, d))) {
          entries.push({ name: `data/${d}/${f.rel}`, data: fs.readFileSync(f.abs) });
          files += 1;
          bytes += f.bytes;
        }
      }
      for (const f of cat.files) {
        const abs = path.join(DATA_DIR, f);
        let st = null;
        try { st = fs.statSync(abs); } catch { continue; }
        if (!st.isFile()) continue;
        entries.push({ name: `data/${f}`, data: fs.readFileSync(abs) });
        files += 1;
        bytes += st.size;
      }
      if (files) manifestCategories.push({ key, label: cat.label, files, bytes });
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  if (!entries.length) {
    return { ok: false, error: '选中的数据类别都是空的，没有可备份的文件' };
  }

  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    appVersion: String(appVersion || ''),
    instanceId: String(instanceId || ''),
    // B1 只做明文包；勾选「包含密钥」时的整包加密由 B2 的 crypto.js 补齐。
    encrypted: false,
    categories: manifestCategories,
    sha256: computePayloadSha256(entries),
    files: entries
      .map((e) => ({ path: e.name, bytes: e.data.length }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };

  const zip = buildZip([
    { name: MANIFEST_NAME, data: JSON.stringify(manifest, null, 2) },
    ...entries
  ]);
  if (zip.length > BACKUP_MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      error: `备份包体积 ${(zip.length / 1048576).toFixed(1)}MB 超过上限 `
        + `${Math.round(BACKUP_MAX_ARCHIVE_BYTES / 1048576)}MB，请减少备份类别`
    };
  }

  const { name, key } = backupKeyFor(now);
  logger.info('backup', `构建备份包：${name}（${manifestCategories.length} 类 / ${entries.length} 个文件 / ${(zip.length / 1024).toFixed(0)}KB）`);
  return { ok: true, key, name, buffer: zip, manifest, bytes: zip.length };
}

/**
 * 解析并校验备份包。下载后必须先过这里：sha256 不匹配直接拒绝，
 * 不给后续 applyImport 任何"先写一半再发现坏包"的机会。
 *
 * @param {Buffer} buffer
 * @param {{verify?: boolean}} opts verify=false 仅供已校验过的内部调用方
 * @returns {{ok:true, manifest:object, entries:Array<{name:string,data:Buffer}>, files:number, bytes:number}
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
    // 加密载荷的格式由 B2 定义；这里明确拒绝而不是尝试按明文解析，
    // 否则会得到"sha256 不匹配"这种误导性的错误。
    return { ok: false, code: 'encrypted', error: '这是加密备份包，本版本尚未提供解密支持' };
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
