// 下载上限与构建器一致；列表预算独立，避免异常远端通过 XML 或分页耗尽内存。
import { BACKUP_MAX_ARCHIVE_BYTES } from '../archive.js';

export const BACKUP_DOWNLOAD_MAX_BYTES = BACKUP_MAX_ARCHIVE_BYTES;
export const BACKUP_LIST_PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const BACKUP_LIST_MAX_PAGES_COUNT = 100;
export const BACKUP_LIST_MAX_ENTRIES_COUNT = 10_000;
export const BACKUP_LIST_MAX_DEPTH_LEVELS = 16;
export const BACKUP_READ_CHUNK_BYTES = 64 * 1024;
export const BACKUP_LIMIT_ERROR_CODE = 'ERR_BACKUP_LIMIT';

export function backupLimitError() {
  return Object.assign(new Error('备份下载或列表超过上限'), { code: BACKUP_LIMIT_ERROR_CODE });
}

/** Content-Length 只用于提前拒绝；解压后的实际响应流仍逐块累计并及时取消。 */
export async function readBoundedResponse(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw backupLimitError();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      if (value.byteLength > maxBytes - bytes) throw backupLimitError();
      bytes += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); }
    catch { /* 远端已断开时取消可能失败，保留原始读取错误。 */ }
    throw error;
  } finally { reader.releaseLock(); }
}
