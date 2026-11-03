// 本地目录备份目标。
//
// 安全性：dir 来自用户配置，key 来自内部生成（archive.backupKeyFor）或目标 list()，
// 但恢复流程会把用户/目标返回的 key 原样传回 get/remove，所以每次拼接后都要
// 做 path.relative 校验，把路径锁死在 dir 内 —— 备份目录若位于可写共享盘，
// 住在那台机器上的人可以伪造 list 结果诱导任意路径读写。
//
// 写入用「临时文件 + rename」：备份包可能几十 MB，直接写目标文件时若中途失败，
// 目标里会留下一个能被 list() 看见、下载后必然 sha256 校验失败的半截文件。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../logger.js';

/** 临时文件后缀：downloads/list 必须忽略，否则恢复列表里会混进 .tmp 条目。 */
const TEMP_SUFFIX = '.part';
const TEMP_STALE_MS = 24 * 60 * 60 * 1000;   // 超过一天没动过的残片视为上次失败遗留

function normalizeKey(key) {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

/** key → 绝对路径；逃出 root 时抛错（不返回 null：静默跳过会让 put 看起来成功）。 */
function resolveInside(root, key) {
  const rel = normalizeKey(key);
  if (!rel) throw new Error('备份目标 key 不能为空');
  const abs = path.resolve(root, ...rel.split('/').filter(Boolean));
  const check = path.relative(root, abs);
  if (!rel.split('/').includes('..') && check && !check.startsWith('..') && !path.isAbsolute(check)) {
    return abs;
  }
  throw new Error(`备份目标 key 非法（越出备份目录）：${rel.slice(0, 200)}`);
}

async function pruneStaleParts(root) {
  let ents = [];
  try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - TEMP_STALE_MS;
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith(TEMP_SUFFIX)) continue;
    try {
      const fp = path.join(root, e.name);
      const st = await fsp.stat(fp);
      if (st.mtimeMs < cutoff) await fsp.rm(fp, { force: true });
    } catch { /* 单个残片删不掉不影响本次操作 */ }
  }
}

/**
 * 建本地目标。
 * @param {{id?:string, name?:string, dir?:string}} entry
 * @returns {object} BackupTarget
 */
export function createLocalTarget(entry = {}) {
  const rawDir = String(entry?.dir || '').trim();
  const root = rawDir ? path.resolve(rawDir) : '';

  function requireDir() {
    if (!root) throw new Error('本地备份目标未设置目录（backup.targets[].dir）');
    return root;
  }

  return {
    type: 'local',

    /** 只检查目录能否建出来、能否写 —— 不要求它已经是备份目录。 */
    async test() {
      if (!root) return { ok: false, message: '未设置备份目录（dir）' };
      const probe = path.join(root, `.probe-${process.pid}-${Date.now()}`);
      try {
        await fsp.mkdir(root, { recursive: true });
        await fsp.writeFile(probe, 'ok', 'utf8');
        await fsp.rm(probe, { force: true });
        return { ok: true, message: `目录可写：${root}`, detail: { dir: root } };
      } catch (error) {
        return { ok: false, message: `目录不可写：${error?.message ?? error}`, detail: { dir: root } };
      }
    },

    /** 列出备份文件（含子目录），目录不存在 = 空列表而不是错误。 */
    async list() {
      const dir = requireDir();
      const out = [];
      const walk = async (cur) => {
        let ents = [];
        try { ents = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const abs = path.join(cur, e.name);
          if (e.isDirectory()) { await walk(abs); continue; }
          if (!e.isFile() || e.name.endsWith(TEMP_SUFFIX)) continue;
          let st = null;
          try { st = await fsp.stat(abs); } catch { continue; }
          out.push({
            key: path.relative(dir, abs).replace(/\\/g, '/'),
            size: Number(st.size) || 0,
            // 取不到 mtime 的极少数情况给 0：调用方排序时把它排在最后，
            // 不能拿 Date.now() 冒充，那会让坏条目看起来是"刚备份的"。
            mtimeMs: Number(st.mtimeMs) || 0
          });
        }
      };
      await walk(dir);
      out.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.key.localeCompare(b.key));
      return out;
    },

    async put(key, buffer) {
      const dir = requireDir();
      if (!Buffer.isBuffer(buffer)) throw new Error('put 需要 Buffer');
      const abs = resolveInside(dir, key);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}${TEMP_SUFFIX}`;
      try {
        await fsp.writeFile(tmp, buffer);
        await fsp.rename(tmp, abs);
      } catch (error) {
        try { await fsp.rm(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
        throw error;
      }
      logger.info('backup', `写入本地备份：${normalizeKey(key)}（${(buffer.length / 1024).toFixed(0)}KB → ${dir}）`);
      await pruneStaleParts(dir);
    },

    async get(key) {
      const dir = requireDir();
      const abs = resolveInside(dir, key);
      return fsp.readFile(abs);
    },

    async remove(key) {
      const dir = requireDir();
      const abs = resolveInside(dir, key);
      await fsp.rm(abs, { force: true });
      logger.info('backup', `删除本地备份：${normalizeKey(key)}`);
    }
  };
}

/** 备份目录是否已存在（界面用：区分"没配"与"配了还没备份过"）。 */
export function localTargetDirExists(entry = {}) {
  const dir = String(entry?.dir || '').trim();
  if (!dir) return false;
  try { return fs.statSync(path.resolve(dir)).isDirectory(); } catch { return false; }
}

export default { createLocalTarget, localTargetDirExists };
