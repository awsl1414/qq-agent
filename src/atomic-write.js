/**
 * 原子写工具：全项目唯一的"安全落盘"入口。
 *
 * 收敛到这里的原因：同一件事曾有多份手写实现，其中几份用固定名 `.tmp`。
 * 同 PROFILE 双开或并发写时，两个进程会写同一个 tmp 文件，后写的覆盖先写的，
 * 再各自 rename，磁盘上就留下"半新半旧"的坏文件。
 *
 * 语义保证：
 *   1. 父目录自动创建（recursive）
 *   2. 临时文件名带 pid，同机多进程并发安全
 *   3. 失败时清理临时文件，不在磁盘上留垃圾
 *   4. rename 在同一文件系统内是原子操作：读者要么看到旧内容、要么看到新内容
 *
 * 只做同步写，这是有意为之：调用方大多是配置/状态落盘，需要在返回值前
 * 确保已持久化。不做 fsync：桌面应用不是数据库，fsync 代价高且没必要。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 原子写文本。写 `<file>.<pid>.tmp` 后 rename 覆盖目标；失败抛原始错误。
 *
 * @param {string} file     目标文件绝对路径
 * @param {string} content  文本内容
 * @returns {boolean}       成功返回 true
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
