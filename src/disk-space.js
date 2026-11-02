// 数据盘空间水位（2026-10-16 外部审查 #9）
//
// ── 病灶 ──────────────────────────────────────────────────────────────
// 全库没有任何 ENOSPC / 磁盘满分支，也没有空间预检（打包器有 3GB 预检，应用本体没有）。
// 磁盘紧张时失败点直接落在写入路径上：会话存档写一半、索引缓存写坏、图片缓存写残，
// 而日志里只会看到一串 ENOENT/EPERM 之类的次级错误，真正的"盘满了"反而看不出。
// 叠加本项目两个会持续增长的消费者 —— 图片缓存（TTL 3 天 + 总量闸 2GB）与
// 会话归档（默认不设上限，项目原则"宁可不删"）—— 长期运行的磁盘需求确实需要预警。
//
// ── 口径 ──────────────────────────────────────────────────────────────
//   ok       剩余 > 2GB
//   warn     剩余 ≤ 2GB     → 记警告（该清理了）
//   critical 剩余 ≤ 500MB  → 记错误，并让图片缓存停止写入（见 image-cache.js 的 enabled）
// 结果缓存 60 秒：statfsSync 虽便宜，但每小时一次的巡检 + 每次入库都查没必要。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CACHE_MS = 60 * 1000;
export const WARN_BELOW_BYTES = 2 * 1024 * 1024 * 1024;        // 2GB
export const CRITICAL_BELOW_BYTES = 500 * 1024 * 1024;         // 500MB

let cache = { at: 0, free: null };

/** 数据目录所在卷的剩余字节；取不到返回 null（老 Node 无 statfsSync / 路径不存在）。 */
export function dataDirFreeBytes() {
  const now = Date.now();
  if (cache.free !== null && now - cache.at < CACHE_MS) return cache.free;
  let free = null;
  try {
    // DATA_DIR 可能还没建（首次启动）：退到它的父目录，卷是同一个
    let probe = DATA_DIR;
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const st = fs.statfsSync(probe || path.parse(DATA_DIR).root);
    free = Number(st.bavail) * Number(st.bsize);
  } catch { /* 取不到就当作未知，由调用方按"不拦"处理 */ }
  cache = { at: now, free };
  return free;
}

/**
 * 由剩余字节数定水位（纯函数，便于测试 —— 没法在测试里造出一块小磁盘）。
 * @param {number|null} free  剩余字节；null = 未知
 * @returns {'ok'|'warn'|'critical'}
 */
export function levelFor(free) {
  if (free === null || free === undefined || !Number.isFinite(Number(free))) return 'ok';
  const n = Number(free);
  if (n <= CRITICAL_BELOW_BYTES) return 'critical';
  if (n <= WARN_BELOW_BYTES) return 'warn';
  return 'ok';
}

/** 当前水位：'ok' | 'warn' | 'critical'。未知（取不到）时按 'ok' —— 不因探测失败停功能。 */
export function diskPressure() {
  return levelFor(dataDirFreeBytes());
}

/** 给人看的一行（日志 / 状态用）。 */
export function diskPressureText() {
  const free = dataDirFreeBytes();
  const level = diskPressure();
  const human = free === null ? '未知' : `${(free / 1024 / 1024 / 1024).toFixed(1)}GB`;
  const mark = level === 'critical' ? '🔴' : (level === 'warn' ? '🟡' : '🟢');
  return `${mark} 数据盘剩余 ${human}（警告线 ${(WARN_BELOW_BYTES / 1024 ** 3).toFixed(0)}GB / `
    + `停写线 ${(CRITICAL_BELOW_BYTES / 1024 ** 2).toFixed(0)}MB）`;
}

/** 测试用：清缓存。 */
export function __resetForTest() { cache = { at: 0, free: null }; }
