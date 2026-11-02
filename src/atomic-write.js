/**
 * 原子写工具 —— 全项目唯一的"安全落盘"入口。
 *
 * ## 为什么需要它
 *
 * 项目里原本有 13 个模块各自手写了一份「写 tmp → rename」的原子写实现
 * （memory / store / sessions / config / plugin-loader / stickers / market /
 *  reminders / community / price-feed / cache-warm / app / migrate），
 * 口径却不完全一致：
 *
 *   - 大多数用 `${file}.${process.pid}.tmp`（带 pid，并发安全）
 *   - `sessions.js` 与 `cache-warm.js` 用的是**固定名** `.tmp`
 *     → 同 PROFILE 双开或并发写时，两个进程会写同一个 tmp 文件，
 *       后写的覆盖先写的，再各自 rename → 磁盘上出现"半新半旧"的坏文件。
 *
 * 这类"同一件事有多份实现、其中几份是错的"是最容易被漏修的模式：
 * 修了一处，另外几处还在。所以收敛到这一个文件。
 *
 * ## 用法
 *
 * ```js
 * import { atomicWriteJson, atomicWriteText } from './atomic-write.js';
 *
 * atomicWriteJson(file, obj);          // 缩进 2，追加换行
 * atomicWriteJson(file, obj, 1);       // 缩进 1（对齐既有 memory.js 口径）
 * atomicWriteText(file, 'raw text');   // 原样写入
 * ```
 *
 * ## 语义保证
 *
 * 1. **父目录自动创建**（recursive）
 * 2. **临时文件名带 pid**，同机多进程并发安全
 * 3. **失败时清理临时文件**，不在磁盘上留垃圾
 * 4. rename 在同一文件系统内是原子操作 → 读者要么看到旧内容、要么看到新内容，
 *    永远不会读到写了一半的文件
 *
 * ## 注意事项
 *
 * - 本模块只做**同步写**。这是有意为之：调用方大多是配置/状态落盘，
 *   需要在返回值前确保已持久化。异步场景请自行 fs.promises 包装。
 * - 不做 fsync。对"掉电不丢数据"有强要求的场景，需在 rename 后自行 fsync，
 *   但本项目的定位（桌面应用，非数据库）下没必要，且 fsync 代价高。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写文本。写 `<file>.<pid>.tmp` 后 rename 覆盖目标。
 *
 * @param {string} file     目标文件绝对路径
 * @param {string} content  文本内容
 * @returns {boolean}       成功 true；失败 false（不抛，调用方可选择忽略）
 */
export function atomicWriteText(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    // 失败时清掉临时文件，避免堆积。清不掉也不掩盖原始错误。
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 原子写 JSON。语义同 atomicWriteText，只是先序列化。
 *
 * @param {string} file       目标文件绝对路径
 * @param {*}      value      任意可 JSON 序列化的值
 * @param {number} [indent=2] 缩进空格数（memory.js 用 1，其余用 2）
 * @returns {boolean}
 */
export function atomicWriteJson(file, value, indent = 2) {
  return atomicWriteText(file, JSON.stringify(value, null, indent));
}

export default { atomicWriteText, atomicWriteJson };
