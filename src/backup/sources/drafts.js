import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { BACKUP_MAX_FILES, walkFiles, readBackupFile } from './files.js';

export const DRAFT_CATEGORIES = [
  {
    key: 'drafts', label: '锻造台草稿', desc: '未安装的扩展草稿及其快照与来源记录',
    // 草稿是尚未安装的中间产物，按需备份，避免默认扩大备份范围。
    defaultOn: false, dirs: [], files: []
  }
];

export function createDraftSources({ dataDir = DATA_DIR } = {}) {
  return {
    sources: DRAFT_CATEGORIES.map((category) => ({
      ...category,
      collect() {
        const staging = path.join(dataDir, 'plugin-data', 'extension-forge', 'staging');
        const entries = [];
        // _snapshots 用于回滚，_meta 记录来源；两者都是草稿完整性的一部分，不能排除。
        for (const file of walkFiles(staging, { anchor: dataDir })) {
          if (!file.rel.includes('/')) continue;
          if (entries.length >= BACKUP_MAX_FILES - 1) throw new Error('文件数量超过备份上限');
          const name = path.posix.join('drafts', file.rel);
          entries.push({ name, data: readBackupFile(name, file.abs, dataDir) });
        }
        return entries;
      }
    }))
  };
}
