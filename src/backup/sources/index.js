import { FILE_CATEGORIES, createFileSources, BACKUP_MAX_FILES, BACKUP_MAX_TOTAL_BYTES } from './files.js';
import { CONFIG_FIELD_CATEGORIES, createConfigFieldSources } from './config-fields.js';
import { EXTENSION_CATEGORIES, createExtensionSources } from './extensions.js';
import { DRAFT_CATEGORIES, createDraftSources } from './drafts.js';

export { BACKUP_MAX_FILES, BACKUP_MAX_TOTAL_BYTES } from './files.js';

/**
 * @typedef {object} BackupSource
 * @property {string} key
 * @property {string} label
 * @property {string} desc
 * @property {boolean} defaultOn
 * @property {() => Array<{name:string, data:Buffer}>} collect
 *   空数据返回空数组；保留 buildBackup 的同步契约，调用方也可 await。
 */

// 注册表只在这里组合。四类来源各自独立演进，注册与顺序由本文件统一决定：
//   files         目录/文件类（会话存档、记忆、用量、提醒、表情、壁纸、桌宠）
//   config-fields 从 config.json 抽字段（人设、自定义人设、名单、工具配置）
//   extensions    用户安装的插件与技能（不含内置）
//   drafts        锻造台草稿（默认不勾选）
//
// 顺序即 UI 展示顺序：先数据本体，再配置，最后扩展。
const SOURCE_CATEGORIES = [
  ...FILE_CATEGORIES,
  ...CONFIG_FIELD_CATEGORIES,
  ...EXTENSION_CATEGORIES,
  ...DRAFT_CATEGORIES
];

/** 可备份的数据类别（只读视图，防止调用方改坏来源模块的定义）。 */
export function listBackupCategories() {
  return SOURCE_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    desc: c.desc,
    defaultOn: c.defaultOn !== false,
    dirs: [...(c.dirs || [])],
    files: [...(c.files || [])]
  }));
}

/**
 * 规范化类别选择：只保留已知类别，去重并排序。
 * 排序是为了让"同一组类别"在任何顺序下得到同一个包，便于多目标共用一次构建。
 */
export function normalizeCategories(input) {
  const raw = Array.isArray(input)
    ? input
    : Object.keys(input || {}).filter((k) => input[k]);
  const known = new Set(SOURCE_CATEGORIES.map((c) => c.key));
  return [...new Set(raw.map(String))].filter((k) => known.has(k)).sort();
}

/**
 * 收集选中类别的条目。
 *
 * 限额由本层统一裁决，而不是各来源各自计数 —— 否则每个来源都跑到自己的上限，
 * 整包就会超出 BACKUP_MAX_TOTAL_BYTES。这里是最后一道闸。
 */
export function collect(categories, { includeSecrets = false, skippedCategories = [] } = {}) {
  const fileSources = createFileSources();
  const allSources = [
    ...fileSources.sources,
    ...createConfigFieldSources().sources,
    ...createExtensionSources().sources,
    ...createDraftSources().sources
  ];
  const entries = [];
  let totalBytes = 0;
  const collectedCategories = [];
  for (const key of normalizeCategories(categories)) {
    const source = allSources.find((c) => c.key === key);
    if (!source) continue;
    const files = source.collect();
    for (const entry of files) {
      if (entries.length >= BACKUP_MAX_FILES - 1) throw new Error('文件数量超过备份上限');
      totalBytes += entry.data.length;
      if (totalBytes > BACKUP_MAX_TOTAL_BYTES) throw new Error('备份总量超过上限');
    }
    entries.push(...files);
    if (files.length) {
      collectedCategories.push({
        key,
        label: source.label,
        files: files.length,
        bytes: files.reduce((sum, entry) => sum + entry.data.length, 0)
      });
    } else {
      skippedCategories.push({ key, label: source.label, reason: `本机还没有${source.label}` });
    }
  }
  if (includeSecrets === true) entries.push(...fileSources.collectSecrets());
  return { entries, categories: collectedCategories, skippedCategories };
}
