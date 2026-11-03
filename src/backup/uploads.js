// 上传区只保留原始备份包；不接受客户端路径。预览/恢复均重新认证包内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKUP_MAX_ARCHIVE_BYTES } from './archive.js';
import { logger } from '../logger.js';

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const MAX_UPLOADS = 4;
// 包括正在接收的上传，限制所有暂存文件的合计磁盘占用。
const MAX_UPLOAD_BYTES = BACKUP_MAX_ARCHIVE_BYTES;
const uploads = new Map();
const receiving = new Map();
let uploadBytes = 0;
let stopped = false;

export function startBackupUploads() { stopped = false; }

export async function stopBackupUploads() {
  stopped = true;
  // 可能仍在等待文件打开，异步迭代器尚未订阅 error；无错误销毁避免未处理事件。
  for (const req of receiving.keys()) req.destroy();
  await Promise.allSettled(receiving.values());
  for (const id of uploads.keys()) discardBackupUpload(id);
}

export function discardBackupUpload(id) {
  const item = uploads.get(id);
  if (!item) return;
  fs.rmSync(item.dir, { recursive: true, force: true });
  clearTimeout(item.timer);
  uploadBytes -= item.bytes;
  uploads.delete(id);
}

export function readBackupUpload(id) {
  const item = uploads.get(id);
  if (!item?.ready) throw new Error('备份文件已过期或不存在，请重新选择文件');
  return fs.readFileSync(item.file);
}

/** 原始二进制流独立于普通 JSON 请求的限额；边接收边限额，不缓冲超限文件。 */
export async function receiveBackupUpload(req) {
  if (stopped) throw new Error('应用正在停止，无法上传备份');
  const task = receiveUpload(req);
  receiving.set(req, task);
  try { return await task; }
  finally { receiving.delete(req); }
}

async function receiveUpload(req) {
  if (uploads.size >= MAX_UPLOADS) throw new Error('待恢复文件过多，请取消已有预览后重试');
  const declared = Number(req.headers?.['content-length']);
  if (declared > BACKUP_MAX_ARCHIVE_BYTES || declared + uploadBytes > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('备份文件体积超过上传上限'), { status: 413 });
  }
  const id = randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-backup-upload-'));
  const item = { dir, file: path.join(dir, 'backup.qqab'), bytes: 0, ready: false };
  uploads.set(id, item);
  let handle;
  try {
    handle = await fs.promises.open(item.file, 'wx', 0o600);
    for await (const chunk of req) {
      if (item.bytes + chunk.length > BACKUP_MAX_ARCHIVE_BYTES || uploadBytes + chunk.length > MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error('备份文件体积超过上传上限'), { status: 413 });
      }
      item.bytes += chunk.length;
      uploadBytes += chunk.length;
      await handle.writeFile(chunk);
    }
    await handle.close();
    handle = null;
    item.ready = true;
    item.timer = setTimeout(() => {
      try { discardBackupUpload(id); }
      catch (error) { logger.warn('backup', `清理上传临时文件失败：${error.message}`); }
    }, UPLOAD_TTL_MS);
    item.timer.unref();
    return id;
  } catch (error) {
    if (handle) await handle.close();
    discardBackupUpload(id);
    throw error;
  }
}
