// 文件来源与读取安全边界；包格式由 archive.js 负责。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { DATA_CATEGORIES } from '../../bundle.js';
import { logger } from '../../logger.js';

export const FILE_CATEGORIES = [
  ...DATA_CATEGORIES,
  {
    key: 'wallpaper', label: '壁纸', dirs: ['wallpaper-static', 'ui'],
    files: ['wallpaper-state.json', 'wallpaper-imports.json'],
    desc: '静态壁纸、壁纸状态与导入记录，以及用户背景图。'
  },
  {
    key: 'desktopPet', label: '桌宠', dirs: ['desktop-pet'], files: [],
    desc: '桌宠模型、预览图与状态。'
  }
];
// 收集与解包共用同一组限额，预留一个条目给 manifest.json。
export const BACKUP_MAX_FILES = 20000;
export const BACKUP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const BACKUP_MAX_FILE_BYTES = 64 * 1024 * 1024;
const WALK_MAX_DEPTH = 10;
const EXCLUDED_DATA_DIRS = new Set(['plugin-data', 'logs', 'cache', '.cache', 'node_modules', '.git']);
const EXCLUDED_DATA_FILE = /^(?:config\.json|backup-crypto\.salt)$|\.(?:lock|salt|tmp|bak)$/i;

function validateBackupPath(file, anchor) {
  const relative = path.relative(path.resolve(anchor), path.resolve(file));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('备份源路径超出锚点目录范围');
  }
  const stat = fs.lstatSync(file);
  const expected = path.resolve(fs.realpathSync(anchor), relative);
  if (stat.isSymbolicLink() || path.relative(expected, fs.realpathSync(file))) {
    throw new Error('备份源包含符号链接或目录联接，拒绝读取可能含凭据的文件');
  }
}

export function readBackupFile(name, file, anchor = DATA_DIR) {
  validateBackupPath(file, anchor);
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

export function walkFiles(root, { anchor = DATA_DIR } = {}) {
  const out = [];
  let total = 0;
  let excluded = 0;
  try {
    validateBackupPath(root, anchor);
  } catch (error) {
    if (error.code === 'ENOENT') return out;
    throw error;
  }
  const walk = (dir, depth) => {
    if (depth > WALK_MAX_DEPTH) throw new Error('备份目录层级超过上限，拒绝生成不完整备份');
    validateBackupPath(dir, anchor);
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

/** 每次收集独立计数，所有类别与密钥配置共用整包限额。 */
export function createFileSources() {
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
  const sources = FILE_CATEGORIES.map((cat) => ({
    ...cat,
    defaultOn: true,
    collect() {
      const start = entries.length;
      for (const d of cat.dirs) {
        for (const f of walkFiles(path.join(DATA_DIR, d))) {
          if (f.bytes === 0) continue;
          appendFile(`data/${d}/${f.rel}`, f.abs);
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
        appendFile(`data/${f}`, abs);
      }
      return entries.slice(start);
    }
  }));
  return {
    sources,
    collectSecrets() {
      const start = entries.length;
      if (!entries.some((e) => e.name === 'data/config.json')) {
        const file = path.join(DATA_DIR, 'config.json');
        if (fs.existsSync(file)) appendFile('data/config.json', file);
      }
      return entries.slice(start);
    }
  };
}
