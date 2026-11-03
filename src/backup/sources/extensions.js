import path from 'node:path';
import { ROOT } from '../../config.js';
import { isBuiltinModuleDir } from '../../plugin-loader.js';
import { BACKUP_MAX_FILES, BACKUP_MAX_TOTAL_BYTES, walkFiles, readBackupFile } from './files.js';

export const EXTENSION_CATEGORIES = [
  {
    key: 'extensions', label: '用户扩展', desc: '用户安装的插件与技能，不含内置模块',
    defaultOn: true, dirs: [], files: []
  }
];

/** 根目录可注入，避免测试为了构造用户扩展而修改应用自带的插件与技能。 */
export function createExtensionSources({ root = ROOT } = {}) {
  return {
    sources: EXTENSION_CATEGORIES.map((category) => ({
      ...category,
      collect() {
        const entries = [];
        let totalBytes = 0;
        for (const kind of ['plugins', 'skills']) {
          for (const file of walkFiles(path.join(root, kind), { anchor: root })) {
            const parts = file.rel.split('/');
            if (parts.length < 2 || isBuiltinModuleDir(parts[0])) continue;
            const name = path.posix.join('modules', kind, file.rel);
            // 两个扩展目录共用类别限额，不能各自收满后才发现整类无法恢复。
            if (entries.length >= BACKUP_MAX_FILES - 1) throw new Error('文件数量超过备份上限');
            if (totalBytes + file.bytes > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份总量超过上限');
            const data = readBackupFile(name, file.abs, root);
            if (totalBytes + data.length > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份总量超过上限');
            totalBytes += data.length;
            entries.push({ name, data });
          }
        }
        return entries;
      }
    }))
  };
}
