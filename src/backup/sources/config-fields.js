import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DATA_DIR } from '../../config.js';

const SENSITIVE_SKILL_IDS = new Set(['account-pool']);
const SENSITIVE_CONFIG_KEYS = [
  'api', 'dshProviderKeys', 'providers', 'protocol', 'server',
  'doctorApi', 'devApi', 'backup', 'update'
];
const CONFIG_FIELDS = {
  persona: ['persona', 'personaByChat', 'personaUnified'],
  customPersonas: ['customPersonas'],
  lists: ['allow', 'deny', 'blocklist', 'globalBlocklist', 'communityExemptions'],
  configSafe: ['tools', 'extensions', 'skills']
};

export const CONFIG_FIELD_CATEGORIES = [
  { key: 'persona', label: '人设', desc: '全局与会话独立人设', defaultOn: true, dirs: [], files: [] },
  { key: 'customPersonas', label: '自定义人设库', desc: '用户保存的自定义人设', defaultOn: true, dirs: [], files: [] },
  { key: 'lists', label: '名单', desc: '允许、拒绝、屏蔽与社区豁免名单', defaultOn: true, dirs: [], files: [] },
  { key: 'configSafe', label: '工具与插件配置', desc: '工具和扩展开关及配置（剥离敏感内容）', defaultOn: true, dirs: [], files: [] }
];

function readConfig() {
  let text;
  try {
    const stat = fs.lstatSync(CONFIG_FILE);
    const expected = path.join(fs.realpathSync(DATA_DIR), path.basename(CONFIG_FILE));
    if (stat.isSymbolicLink() || path.relative(expected, fs.realpathSync(CONFIG_FILE))) {
      throw new Error('配置备份源不能是符号链接或目录联接');
    }
    if (!stat.isFile()) return null;
    text = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const config = JSON.parse(text.replace(/^\uFEFF/, ''));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch (error) {
    // 配置可能尚未写完或已损坏；备份不能调用会迁移、重命名原文件的配置加载器。
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function extractFields(config, key) {
  const fields = {};
  for (const field of CONFIG_FIELDS[key]) {
    // 只允许这些字段出站；新增全局配置不会自动扩大安全配置的备份范围。
    if (SENSITIVE_CONFIG_KEYS.includes(field) || !Object.hasOwn(config, field)) continue;
    const value = config[field];
    if (field === 'customPersonas' && !Array.isArray(value)) continue;
    if (field === 'skills') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      fields.skills = Object.fromEntries(Object.entries(value).filter(([id]) => !SENSITIVE_SKILL_IDS.has(id)));
    } else {
      fields[field] = value;
    }
  }
  return fields;
}

/** 直接抽取磁盘配置，保留空名单与 false 开关，使恢复能还原用户的明确选择。 */
export function createConfigFieldSources() {
  return {
    sources: CONFIG_FIELD_CATEGORIES.map((category) => ({
      ...category,
      collect() {
        const config = readConfig();
        if (!config) return [];
        const fields = extractFields(config, category.key);
        if (!Object.keys(fields).length) return [];
        return [{
          name: path.posix.join('config-fields', `${category.key}.json`),
          data: Buffer.from(JSON.stringify(fields))
        }];
      }
    }))
  };
}
