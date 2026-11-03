// 备份包（.qqab）的构建与解析。
//
// 与 bundle.js 的分工：bundle 面向"把一份整包发给别人"，会带上用户扩展；
// 备份面向"这台机器自己的定时存档"，只装数据，装好后交给目标适配器上传，
// 下载回来先认证清单、校验 sha256 再交给 migrate.applyImport 落地（绝不自己覆盖文件）。
// 数据来源由 sources/ 提供；打包/解包复用 zip-build.js / zip-install.js，
// 不另起一套压缩实现。
//
// 普通备份只含类别白名单；包含密钥时额外加入 config.json 并强制加密。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildZip } from '../zip-build.js';
import { parseZip } from '../zip-install.js';
import { logger } from '../logger.js';
import { encryptPayload, signManifest, verifyManifest } from './crypto.js';
import {
  BACKUP_MAX_FILES, BACKUP_MAX_TOTAL_BYTES, collect, listBackupCategories, normalizeCategories
} from './sources/index.js';

export { listBackupCategories, normalizeCategories };

export const BACKUP_FORMAT = 'qq-agent-backup';
export const BACKUP_VERSION = 2;
export const BACKUP_EXT = '.qqab';
/** 目标内的相对路径前缀：与备份文件本身分开，便于本地目标目录混放其他文件。 */
export const BACKUP_KEY_PREFIX = 'qq-agent/';

// 与 bundle 同口径的整包尺度：备份装的是实例存档，不是单个扩展包。
export const BACKUP_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MANIFEST_NAME = 'manifest.json';

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

/**
 * 备份文件名：本地时间到毫秒 + 8 位随机后缀。
 *
 * 本地时间而非 UTC：用户在文件管理器里看到的时间应与自己挂钟一致。
 * 毫秒 + 随机后缀：同一秒内多次备份不能互相覆盖；同时保证字典序仍等于时间序
 * （保留策略依赖这个顺序判断"最旧"）。
 *
 * 格式必须与 isBackupKey 的正则严格对应，改动时两边一起改。
 */
export function backupKeyFor(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const name = `backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${String(date.getMilliseconds()).padStart(3, '0')}-${crypto.randomBytes(4).toString('hex')}${BACKUP_EXT}`;
  return { name, key: BACKUP_KEY_PREFIX + name };
}

/**
 * 目标里的条目是不是本功能生成的备份文件。
 *
 * 边界：只认 backupKeyFor 产出的格式 —— 本地时间到毫秒 + 8 位随机后缀。
 * 保留策略只清理返回 true 的条目，其余一律不动。这是"不碰用户文件"的硬边界，
 * 不是"尽量多清理"的兜底：正则必须与 backupKeyFor 严格对应，两边一起改。
 */
export function isBackupKey(key) {
  const k = String(key || '');
  return /^qq-agent\/backup-\d{8}-\d{9}-[a-f0-9]{8}\.qqab$/.test(k);
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

  let entries;
  let manifestCategories;
  try {
    const collected = collect(cats, {
      includeSecrets,
      skippedCategories
    });
    entries = collected.entries;
    manifestCategories = collected.categories;
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
    // HMAC 绑定清单和摘要；解密时 AES-GCM 另行验证载荷真实性。
    sha256: encrypted ? crypto.createHash('sha256').update(payload[0].data).digest('hex') : computePayloadSha256(entries),
    files: entries
      .map((e) => ({ path: e.name, bytes: e.data.length }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };

  try {
    manifest.hmac = signManifest(manifest);
  } catch {
    return { ok: false, error: '备份清单认证失败：无法使用本机实例密钥', skippedCategories };
  }
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
 * 解析并校验备份包。下载后必须先过这里：清单认证或 sha256 不匹配直接拒绝，
 * 不给后续 applyImport 任何"先写一半再发现坏包"的机会。
 *
 * @param {Buffer} buffer
 * @param {{verify?: boolean}} opts verify=false 仅供已校验过的内部调用方
 * @returns {{ok:true, authenticated:boolean, manifest:object, entries:Array<{name:string,data:Buffer}>, files:number, bytes:number, ciphertext?:Buffer, code?:string}
 *          | {ok:false, error:string, code?:string}}
 */
export function parseBackup(buffer, { verify = true } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: '备份包是空的' };
  }
  if (buffer.length > BACKUP_MAX_ARCHIVE_BYTES) return { ok: false, error: '备份包体积超过上限' };
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
  // 新格式必须认证后才能使用清单字段；verify=false 也不能绕过认证。
  const hasHmac = manifest && Object.hasOwn(manifest, 'hmac');
  let authenticated = false;
  if (hasHmac) {
    try { authenticated = verifyManifest(manifest); }
    catch { /* 本机密钥不可用与认证不匹配都必须拒绝，不能降级读取。 */ }
    if (!authenticated) return { ok: false, code: 'authentication', error: '备份包清单认证失败（HMAC 不匹配，已被篡改或不属于本机实例）' };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.format !== BACKUP_FORMAT) {
    return { ok: false, error: `不是本程序的备份包（format=${manifest?.format ?? '缺失'}）` };
  }
  if (Number(manifest.version) > BACKUP_VERSION) {
    return { ok: false, error: `备份包格式版本 ${manifest.version} 比本机支持的 ${BACKUP_VERSION} 新，请升级应用后再恢复` };
  }
  if (![1, BACKUP_VERSION].includes(manifest.version)) return { ok: false, error: '不支持的备份包格式版本' };
  if (manifest.version === BACKUP_VERSION && !authenticated) return { ok: false, error: '备份包清单缺少 HMAC 认证' };
  if (manifest.encrypted === true) {
    const payload = entries.filter((e) => e.name !== MANIFEST_NAME);
    if (entries.length !== 2 || payload.length !== 1 || payload[0].name !== 'payload.enc') {
      return { ok: false, error: '加密备份包必须只包含 manifest.json 与 payload.enc' };
    }
    const ciphertext = payload[0].data;
    if (verify && manifest.sha256 !== crypto.createHash('sha256').update(ciphertext).digest('hex')) {
      return { ok: false, error: '备份包已损坏、被篡改，或来自另一台机器（sha256 不匹配）' };
    }
    return { ok: true, code: 'encrypted', authenticated, manifest, ciphertext, entries: [], files: 0, bytes: ciphertext.length };
  }

  const payload = entries.filter((e) => e.name !== MANIFEST_NAME);
  if (verify) {
    const actual = computePayloadSha256(payload);
    if (String(manifest.sha256 || '') !== actual) {
      return { ok: false, error: '备份包校验失败（sha256 不匹配），文件可能已损坏或被篡改' };
    }
  }
  if (authenticated) {
    // 旧摘要按路径与内容拼接，文件边界本身没有编码；认证过的文件清单
    // 必须与实际条目一致，防止把内容中的路径字节拆成额外文件而保留同一摘要。
    const files = payload.map(e => ({ path: e.name, bytes: e.data.length })).sort((a, b) => a.path.localeCompare(b.path));
    if (!Array.isArray(manifest.files) || manifest.files.length !== files.length
      || files.some((file, i) => file.path !== manifest.files[i]?.path || file.bytes !== manifest.files[i]?.bytes)) {
      return { ok: false, error: '备份包文件清单与载荷不匹配，文件可能已损坏或被篡改' };
    }
  }
  const bytes = payload.reduce((n, e) => n + e.data.length, 0);
  return { ok: true, authenticated, manifest, entries: payload, files: payload.length, bytes };
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
  return { ...out, authenticated: parsed.authenticated, manifest: parsed.manifest };
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
