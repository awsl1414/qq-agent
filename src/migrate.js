// 数据移植：把另一个 QQ Agent 实例的 data 目录安全搬进当前实例。
//
// Harness 里的「数据移植」页已被「打包 / 接收」取代，本文件现在是数据落地的
// 引擎：
//   · bundle.inspectBundle 用 scanSource() 给出"源有几条 / 本机有几条 / 会多出多少"
//   · /api/bundle/import-data 用 applyImport() 真正写盘（合并/去重/备份/置已读）
//   · /api/migrate/backups|rollback 仍对外，供「接收整包」页回滚
//   /api/migrate/scan 与 /api/migrate/apply 已随页面一起下线。
// 新增数据入口时请复用这里的 applyImport，不要另写一套写盘逻辑。
//
// 搬运范围：
//   messages/    会话存档（真相源，不可再生）：合并 / 覆盖两种策略
//   memory/      群友印象（按成员文件合并，按内容去重）
//                旧版单文件 memory/<会话>.json 一并认（字段 memberImpression），
//                导入时按 memory.js 的同一套规则拆成每成员文件。
//   统计类       cost-guard.json（相加）、telemetry-totals.json（相加）、
//                usage-daily.json（仅补缺：目标没有的"天"才导入）
//   reminders.json / stickers.json 按 id 补缺，同 id 保留本机数据
//   config-fields/ 只合并允许的配置字段，同键保留本机数据
//   壁纸 / 桌宠  文件覆盖，状态同键保留本机数据
//   drafts/       按草稿目录覆盖锻造台暂存区，不自动安装
//   modules/      能力扫描后送锻造台暂存，安装仍需控制台人工确认
//
// 明确不搬的（搬了也是脏数据 / 风险太高）：
//   memory-v2/    messages 的派生物（长时索引）。导入后按会话全量重建，
//                 绝不直接复制，两边水位/块 id 会打架。
//   config.json   含身份字段（selfId/apiKey/provider），整份覆盖等于换魂。
//   sessions/     运行档案（纯历史记录，可再生价值低）。
//   *-cache*.json / *.lock / window-state / telemetry.json / usage-today.json
//                 缓存、运行态、本机状态。
//   semantic-cards/ cross-turn/ plugin-data/  资产类（锻造台草稿除外）。
//
// 安全机制：
//   1. 导入前把每个将被改动/覆盖的文件备份到 data/import-backups/<ts>/，
//      附 manifest.json（来源 / 时间 / 逐条动作），支持一键回滚。
//   2. 所有写盘走 tmp+rename 原子写（见 atomic-write.js）。
//   3. 热生效：写完 messages 后由调用方失效 ChatStore 内存并触发该会话的
//      force 巩固（conversation-memory 的官方重建路径）。本模块不 import
//      store / 插件，通过 hooks 回调注入，保持可独立测试。
//   4. 导入的历史消息一律置 read:true，绝不让机器人在新实例上把几个月的
//      存档当成"未读轰炸"逐条回复。
//
// 已知边界：导入是几百毫秒的批量操作，期间若有新消息写入同一会话文件，
// 会以后写者为准。建议在群里安静时导入（不做写冻结）。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_FILE, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { atomicWriteJson, atomicWriteText } from './atomic-write.js';
import { buildZip } from './zip-build.js';

const REMINDERS_FILE = 'reminders.json';
const STICKERS_FILE = 'stickers.json';
const MERGE_CATEGORIES = ['reminders', 'stickers'];
const CONFIG_FIELDS = {
  persona: ['persona', 'personaByChat', 'personaUnified'],
  customPersonas: ['customPersonas'],
  lists: ['allow', 'deny', 'blocklist', 'globalBlocklist', 'communityExemptions'],
  configSafe: ['tools', 'extensions', 'skills']
};
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_SKILL_IDS = new Set(['account-pool']);
const MODULE_KINDS = ['plugins', 'skills'];
const MODULE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// 与 forge.import-zip 的入站大小、条目数契约对齐，超限拒绝而非截断扩展。
const MODULE_MAX_FILES = 600;
const MODULE_MAX_BYTES = 12 * 1024 * 1024;
const MODULE_MAX_DEPTH = 10;
const FILE_RESTORE_CATEGORIES = {
  wallpaper: {
    paths: ['wallpaper-static', 'wallpaper-state.json', 'wallpaper-imports.json', 'ui'],
    mergeFiles: ['wallpaper-state.json', 'wallpaper-imports.json']
  },
  desktopPet: { paths: ['desktop-pet'], mergeFiles: ['desktop-pet/state.json'] }
};

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const BACKUP_ROOT = path.join(DATA_DIR, 'import-backups');
const BACKUP_ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{6}-\d{3}$/;

// ── 基础工具 ─────────────────────────────────────────────────────────────

function readJson(file, fallback = null) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return j && typeof j === 'object' ? j : fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 兼容旧 data 目录入参；包根目录和 data 的同级前缀都交给同一恢复引擎。 */
function sourcePaths(abs) {
  const packaged = fs.existsSync(path.join(abs, 'data'))
    || fs.existsSync(path.join(abs, 'config-fields')) || fs.existsSync(path.join(abs, 'modules'))
    || fs.existsSync(path.join(abs, 'drafts'));
  const root = packaged ? abs : path.basename(abs) === 'data' ? path.dirname(abs) : abs;
  return { root, data: packaged ? path.join(abs, 'data') : abs };
}

function checkedSourcePath(root, ...parts) {
  const file = path.resolve(root, ...parts);
  const rel = path.relative(root, file);
  if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) throw new Error('源路径越界');
  let cursor = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('恢复源不能包含符号链接或目录联接');
    }
  }
  return file;
}

/** 只收普通文件；每一层都检查链接，避免恢复时读写到边界之外。 */
function restoreFiles(root, relative) {
  const file = checkedSourcePath(root, relative);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isFile()) return [relative.replace(/\\/g, '/')];
  if (!stat.isDirectory()) throw new Error('恢复路径包含非普通文件');
  return fs.readdirSync(file).flatMap((name) => restoreFiles(root, path.join(relative, name)));
}

function removeEmptyParents(file, boundary) {
  let dir = path.dirname(file);
  while (dir !== boundary && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function entryKey(value) {
  if (isRecord(value) && Object.hasOwn(value, 'id')) return `id:${String(value.id).trim()}`;
  return JSON.stringify(value);
}

/** 只补缺：已有标量（含 false、空串、null）保留；数组去重，对象递归按键合并。 */
function fillMissing(target, source) {
  if (Array.isArray(source)) {
    if (target !== undefined && !Array.isArray(target)) return target;
    const out = [...(target || [])];
    const seen = new Set(out.map(entryKey));
    for (const value of source) {
      const key = entryKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fillMissing(undefined, value));
    }
    return out;
  }
  if (isRecord(source)) {
    if (target !== undefined && !isRecord(target)) return target;
    const out = { ...(target || {}) };
    for (const [key, value] of Object.entries(source)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = fillMissing(Object.hasOwn(out, key) ? out[key] : undefined, value);
    }
    return out;
  }
  return target === undefined ? source : target;
}

function moduleZip(root, kind, name) {
  const base = checkedSourcePath(root, 'modules', kind, name);
  const entries = [];
  let bytes = 0;
  const walk = (dir, depth) => {
    if (depth > MODULE_MAX_DEPTH) throw new Error('扩展嵌套过深');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = checkedSourcePath(root, path.relative(root, path.join(dir, entry.name)));
      if (entry.isDirectory()) { walk(file, depth + 1); continue; }
      if (!entry.isFile()) throw new Error('扩展包含非普通文件');
      if (entries.length >= MODULE_MAX_FILES || bytes + fs.statSync(file).size > MODULE_MAX_BYTES) {
        throw new Error('扩展超过锻造台导入限额');
      }
      const data = fs.readFileSync(file);
      bytes += data.length;
      if (bytes > MODULE_MAX_BYTES) throw new Error('扩展超过锻造台导入限额');
      entries.push({ name: path.relative(base, file).replace(/\\/g, '/'), data });
    }
  };
  walk(base, 0);
  const manifest = readJson(path.join(base, 'skill.json')) || readJson(path.join(base, 'plugin.json'));
  if (!isRecord(manifest)) throw new Error('扩展缺少有效清单');
  const entry = checkedSourcePath(base, String(manifest.entry || 'index.js'));
  if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) throw new Error('扩展入口不存在');
  const zip = buildZip(entries);
  if (zip.length > MODULE_MAX_BYTES) throw new Error('扩展压缩包超过锻造台导入限额');
  return { zip, base, manifest };
}

// 改走 src/atomic-write.js 的统一实现（原来是本文件自己写的一份）。
// 保持原口径不变：字符串入参原样写、对象按缩进 1 序列化
// （atomicWriteJson 会把字符串也 JSON 编码，那是另一种语义，所以这里分开走）。
function atomicWrite(file, data) {
  if (typeof data === 'string' || Buffer.isBuffer(data)) atomicWriteText(file, data);
  else atomicWriteJson(file, data, 1);
}

function chatKeyFromFile(fileName) {
  const m = /^(group|private)_(\d+)\.json$/.exec(fileName);
  return m ? `${m[1]}:${m[2]}` : null;
}

function chatFileOf(chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function normTs(v) {
  const n = Number(v) || 0;
  return n > 0 ? n : 0;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 消息去重键：mid 是 QQ 服务器全局 id，跨实例可靠；无 mid 的老数据用内容指纹兜底。 */
function msgDedupeKey(m) {
  const mid = m?.mid;
  if (mid !== null && mid !== undefined && String(mid).trim() !== '') return `mid:${mid}`;
  return `fp:${normTs(m?.ts)}|${String(m?.senderId ?? '')}|${String(m?.text ?? '')}|${m?.self ? 1 : 0}`;
}

/**
 * 会话存档加载与规整（scan / apply 共用）。
 * 返回 null 表示文件不存在或结构无效（没有 messages 数组）。
 */
function loadChatFile(file) {
  const raw = readJson(file, null);
  if (!raw || !Array.isArray(raw.messages)) return null;
  const msgs = raw.messages.filter((m) => m && typeof m === 'object');
  const tsList = msgs.map((m) => normTs(m.ts)).filter((n) => n > 0);
  return {
    nextLocalId: Number(raw.nextLocalId) || 0,
    count: msgs.length,
    firstTs: tsList.length ? Math.min(...tsList) : 0,
    lastTs: tsList.length ? Math.max(...tsList) : 0,
    raw
  };
}

// ── 扫描（只读）──────────────────────────────────────────────────────────

/**
 * 扫描源 data 目录或备份包根目录，产出分类清单与差异预览。绝不写任何文件。
 * @param {string} sourceDir 另一实例的 data 目录或解包根目录
 */
export function scanSource(sourceDir) {
  const src = String(sourceDir || '').trim();
  if (!src) return { ok: false, error: '请填写源 data 目录路径' };
  const sourceRoot = path.resolve(src);
  let st = null;
  try { st = fs.statSync(sourceRoot); } catch { /* 不存在 */ }
  if (!st || !st.isDirectory()) {
    return { ok: false, error: `目录不存在或不是文件夹：${sourceRoot}` };
  }
  const { root, data: abs } = sourcePaths(sourceRoot);

  // 自我导入守卫：源 == 本机 data 时，messages 靠 mid 去重还算安全，但统计类
  // 是"同键相加"：cost-guard / telemetry-totals 会自己加自己，导入一次用量
  // 统计直接翻倍（且看不见、只能靠对比发现）。备份也会变成"把本机文件复制成
  // 本机文件的备份"，回滚等于没回滚。这个模块的语义是"两个实例之间搬家"，
  // 所以这里直接拒绝。
  const selfDir = path.resolve(DATA_DIR);
  if (abs === selfDir || sourceRoot === selfDir) {
    return { ok: false, error: `源目录就是当前实例的 data 目录（${selfDir}）。请选**另一个** QQ Agent 实例的 data —— 自我导入会让成本/调用统计翻倍。` };
  }
  if (selfDir.startsWith(sourceRoot + path.sep)) {
    return { ok: false, error: `源目录包含了当前实例的 data 目录（${selfDir}）。请直接指向另一个实例的 data 文件夹本身。` };
  }

  const result = {
    ok: true,
    sourceDir: sourceRoot,
    messages: [],   // 每 chat：{ chatKey, source, target, diff }
    memory: { available: false, chats: [] },
    stats: [],
    excluded: [
      { name: 'memory-v2/', reason: 'messages 的派生索引，导入后自动按会话重建，不直接复制' },
      { name: 'config.json', reason: '含身份字段（selfId/apiKey/provider），仅恢复 config-fields 中的允许字段，不导入整份配置' },
      { name: 'sessions/', reason: '运行档案（纯历史记录），一期不搬' },
      { name: '各缓存与运行态', reason: 'cache-warm-prefix / session-index-cache / price-feed / window-state / *.lock / telemetry / usage-today' },
      { name: '资产类', reason: 'semantic-cards / cross-turn / plugin-data（锻造台草稿除外），二期再议' }
    ]
  };

  // ── 会话存档 ──
  try {
    const files = fs.readdirSync(path.join(abs, 'messages')).filter((f) => /^(group|private)_\d+\.json$/.test(f));
    for (const f of files) {
      const chatKey = chatKeyFromFile(f);
      if (!chatKey) continue;
      const s = loadChatFile(path.join(abs, 'messages', f));
      if (!s || !s.count) continue;
      const t = loadChatFile(chatFileOf(chatKey));
      result.messages.push({
        chatKey,
        source: { count: s.count, firstTs: s.firstTs, lastTs: s.lastTs },
        target: t
          ? { count: t.count, firstTs: t.firstTs, lastTs: t.lastTs }
          : null,                       // null = 目标没有这个会话（全新导入）
        extra: t ? Math.max(0, s.count - overlapEstimate(s, t)) : s.count
      });
    }
  } catch { /* 源没有 messages 目录 */ }
  result.messages.sort((a, b) => (b.source?.lastTs || 0) - (a.source?.lastTs || 0));

  // 群友印象：两种形态都要认。新版是每成员一个文件
  //    （memory/<会话>/<QQ>.json），旧版是每会话一个单文件
  //    （memory/<会话>.json，字段 memberImpression）。
  //    只遍历目录的话，源实例若是旧版形态，界面会显示"没有印象可导入"，
  //    整块印象被静默丢弃。
  try {
    const memDir = path.join(abs, 'memory');
    const byChat = new Map();     // chatKey -> { chatKey, members, notes, legacy }
    const touch = (chatKey) => {
      if (!byChat.has(chatKey)) byChat.set(chatKey, { chatKey, members: 0, notes: 0, legacy: false });
      return byChat.get(chatKey);
    };
    for (const e of fs.readdirSync(memDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const m = /^(group|private)_(\d+)$/.exec(e.name);
        if (!m) continue;
        const row = touch(`${m[1]}:${m[2]}`);
        let members = 0, notes = 0;
        try {
          for (const f of fs.readdirSync(path.join(memDir, e.name))) {
            if (!f.endsWith('.json') || f === '_meta.json') continue;
            const j = readJson(path.join(memDir, e.name, f), null);
            if (!j) continue;
            members += 1;
            notes += Array.isArray(j.impressions) ? j.impressions.length : 0;
          }
        } catch { /* ignore */ }
        row.members += members;
        row.notes += notes;
        continue;
      }
      const m = /^(group|private)_(\d+)\.json$/.exec(e.name);
      if (!m) continue;
      const list = legacyImpressionEntries(path.join(memDir, e.name));
      if (!list.length) continue;
      const row = touch(`${m[1]}:${m[2]}`);
      row.legacy = true;
      row.notes += list.length;
      row.members += new Set(list.map((x) => x.userId || `_n_${x.name}`)).size;
    }
    result.memory.chats = [...byChat.values()].filter((c) => c.members > 0 || c.notes > 0);
    result.memory.available = result.memory.chats.length > 0;
  } catch { /* 源没有 memory 目录 */ }

  // ── 统计类 ──
  const statDefs = [
    { id: 'costGuard', file: 'cost-guard.json', label: '成本守卫（按天按群）', mode: 'add' },
    { id: 'telemetryTotals', file: 'telemetry-totals.json', label: '调用与工具统计（累计）', mode: 'add' },
    { id: 'usageDaily', file: 'usage-daily.json', label: '每日用量（仅补缺：目标缺失的天才导入）', mode: 'fill' },
    { id: 'usageArchivedDays', file: 'usage-archived-days.json', label: '归档用量（按天补缺）', mode: 'fill' },
    { id: 'usageToday', file: 'usage-today.json', label: '当日用量（归档后按天补缺）', mode: 'fill' }
  ];
  for (const def of statDefs) {
    const sp = path.join(abs, def.file);
    const tp = path.join(DATA_DIR, def.file);
    if (!fs.existsSync(sp)) continue;
    result.stats.push({
      ...def,
      sourceExists: true,
      targetExists: fs.existsSync(tp)
    });
  }

  for (const category of MERGE_CATEGORIES) {
    const file = path.join(abs, category === 'reminders' ? REMINDERS_FILE : STICKERS_FILE);
    const raw = readJson(file);
    const entries = category === 'reminders' ? raw?.reminders : raw;
    const valid = Array.isArray(entries);
    const list = valid ? entries.filter((entry) => entry && typeof entry === 'object') : [];
    result[category] = { available: valid, count: list.length, total: list.length };
    if (category === 'reminders') result[category].pending = list.filter((r) => r && !r.fired).length;
  }
  result.configFields = Object.fromEntries(Object.keys(CONFIG_FIELDS).map((key) => [key, {
    available: fs.existsSync(path.join(root, 'config-fields', `${key}.json`))
  }]));
  for (const [category, { paths }] of Object.entries(FILE_RESTORE_CATEGORIES)) {
    result[category] = { available: paths.some((rel) => fs.existsSync(path.join(abs, rel))) };
  }
  result.drafts = { available: fs.statSync(path.join(root, 'drafts'), { throwIfNoEntry: false })?.isDirectory() || false };
  result.modules = [];
  for (const kind of MODULE_KINDS) {
    const base = path.join(root, 'modules', kind);
    if (!fs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) continue;
    // 扫描只显示候选项；实际读文件仍须逐层拒绝符号链接。
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && MODULE_NAME_RE.test(entry.name)) {
        result.modules.push({ key: `${kind.slice(0, -1)}:${entry.name}`, kind, dir: entry.name });
      }
    }
  }
  return result;
}

/** 粗估两边重叠条数（按 mid 集合交集，无 mid 的忽略）。 */
function overlapEstimate(s, t) {
  if (!s?.raw || !t?.raw) return 0;
  const tMids = new Set();
  for (const m of t.raw.messages) {
    if (m?.mid !== null && m?.mid !== undefined && String(m.mid).trim() !== '') tMids.add(String(m.mid));
  }
  let n = 0;
  for (const m of s.raw.messages) {
    const mid = m?.mid;
    if (mid !== null && mid !== undefined && String(mid).trim() !== '' && tMids.has(String(mid))) n += 1;
  }
  return n;
}

// ── 备份 ─────────────────────────────────────────────────────────────────

/** 备份一个目标文件（存在才备份）。返回 { backup } 或 { absent: true }。 */
function backupFile(backupDir, absTarget) {
  if (!fs.existsSync(absTarget)) return { absent: true };
  const rel = path.relative(DATA_DIR, absTarget).replace(/\\/g, '/');
  const dst = path.join(backupDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(absTarget, dst);
  return { backup: rel };
}

// 必须是命名导出：routes.js 用的是
//   import { scanSource, applyImport, rollbackImport, listBackups } from './migrate.js'
// 少了 export 关键字时，ESM 在模块实例化阶段就抛
// "does not provide an export named 'listBackups'"，整个 app.js → routes.js
// 链路加载失败，表现是 Electron 主进程启动即崩、窗口根本打不开。
// 下面的 migrateAdmin 对象仍然引用这一个函数，两处共用同一份实现。
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_ROOT)
      .filter((f) => BACKUP_ID_PATTERN.test(f))
      .sort()
      .reverse()
      .map((id) => {
        const manifest = readJson(path.join(BACKUP_ROOT, id, 'manifest.json'), null);
        return { id, manifest };
      });
  } catch {
    return [];
  }
}

function newBackupDir(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const id = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const dir = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

// ── 会话存档导入 ─────────────────────────────────────────────────────────

/**
 * 合并两个会话存档：目标消息原样保留（id 不变），源里目标没有的消息
 * 追加新 id；数组按 ts 重排（store 的"过去状态"按数组顺序拼接）。
 * 源引入的消息一律 read:true（历史存档，不许触发轰炸）。
 */
function mergeChatState(targetState, sourceState) {
  const tMsgs = Array.isArray(targetState?.raw?.messages) ? targetState.raw.messages : [];
  const sMsgs = Array.isArray(sourceState?.raw?.messages) ? sourceState.raw.messages : [];

  const seen = new Set(tMsgs.map(msgDedupeKey));
  // 新 id 从 max(现有消息 id, nextLocalId-1) 之后连续分配；
  // nextLocalId 的语义是"下一个可用的 id"，最终回落到最后分配 id + 1。
  // 目标已有消息的 id 一律不动（UI / 工具可能持有引用，空洞无碍）。
  const maxUsed = Math.max(
    0,
    ...tMsgs.map((m) => Number(m?.id) || 0),
    (Number(targetState?.nextLocalId) || 1) - 1
  );
  let nextId = maxUsed;

  const additions = [];
  for (const m of sMsgs) {
    const key = msgDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    nextId += 1;
    additions.push({
      ...m,
      id: nextId,
      read: true            // 导入的历史消息必须已读：防止触发轰炸
    });
  }

  const merged = [...tMsgs, ...additions].sort((a, b) => (normTs(a?.ts) - normTs(b?.ts)) || ((Number(a?.id) || 0) - (Number(b?.id) || 0)));
  return {
    chatKey: targetState?.raw?.chatKey || sourceState?.raw?.chatKey,
    nextLocalId: nextId + 1,
    messages: merged,
    added: additions.length
  };
}

/** 覆盖导入：整文件替换，全部置已读（保留 recalled 等标记）。 */
function overwriteChatState(sourceState) {
  const msgs = (sourceState.raw.messages || []).map((m) => ({ ...m, read: true }));
  const maxId = Math.max(0, ...msgs.map((m) => Number(m?.id) || 0));
  return {
    chatKey: sourceState.raw.chatKey,
    nextLocalId: Math.max(maxId + 1, Number(sourceState.nextLocalId) || 1),
    messages: msgs,
    added: msgs.length
  };
}

// ── 群友印象导入 ─────────────────────────────────────────────────────────

/** 按成员文件合并印象（按 content 去重，createdAt 取更早者）。返回 { members, added }。 */
function mergeMemoryChat(srcChatDir, dstChatDir, beforeWrite) {
  let members = 0, added = 0;
  let files = [];
  try {
    files = fs.readdirSync(srcChatDir).filter((f) => f.endsWith('.json'));
  } catch {
    // 源这边只有旧版单文件（没有同名文件夹），不是错误，交给 mergeLegacyMemoryFile
    return { members, added };
  }
  for (const f of files) {
    const srcMember = readJson(path.join(srcChatDir, f), null);
    if (!srcMember || f === '_meta.json') continue;
    const dstPath = path.join(dstChatDir, f);
    const dstMember = readJson(dstPath, null);
    fs.mkdirSync(dstChatDir, { recursive: true });
    if (!dstMember || !Array.isArray(dstMember.impressions)) {
      // 目标没有这个成员：直接复制（置已读不适用这里；印象无已读概念）
      beforeWrite(dstPath);
      atomicWrite(dstPath, fs.readFileSync(path.join(srcChatDir, f), 'utf8'));
      members += 1;
      added += Array.isArray(srcMember.impressions) ? srcMember.impressions.length : 0;
      continue;
    }
    const seen = new Set(dstMember.impressions.map((e) => String(e?.content ?? '')));
    let n = 0;
    for (const e of Array.isArray(srcMember.impressions) ? srcMember.impressions : []) {
      const c = String(e?.content ?? '');
      if (!c || seen.has(c)) continue;
      seen.add(c);
      dstMember.impressions.push({ content: c, createdAt: Number(e?.createdAt) || Date.now() });
      n += 1;
    }
    if (n) {
      dstMember.impressions.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
      dstMember.updatedAt = Math.max(Number(dstMember.updatedAt) || 0, Number(srcMember.updatedAt) || 0);
      beforeWrite(dstPath);
      atomicWrite(dstPath, dstMember);
      added += n;
    }
    members += 1;
  }
  return { members, added };
}

// ── 旧版单文件印象（memory/<会话>.json）───────────────────────────────────
// 字段映射**必须**与 src/memory.js 的 #migrateLegacy 逐条对齐：同一份旧数据，
// 走"首次访问自动迁移"和走"数据移植导入"如果落到不同文件名上，机器人的记忆里
// 就会出现同一个人两份文件（印象分裂、总数虚高），而且两边都自认为迁移完成。

/** 成员文件名：与 src/memory.js 的 memberFileName 保持一致。 */
function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

/**
 * 解析旧版单文件里的 memberImpression。target 是纯数字（5~15 位）就当 QQ 号，
 * 否则落成"无 QQ 号"条目（_n_<名字>.json），与 memory.js 完全同规则。
 * @returns {Array<{ userId: string, name: string, content: string, createdAt: number }>}
 */
function legacyImpressionEntries(file) {
  const raw = readJson(file, null);
  const out = [];
  for (const e of Array.isArray(raw?.memberImpression) ? raw.memberImpression : []) {
    const content = String(e?.content ?? '').trim();
    if (!content) continue;
    const target = String(e?.target ?? '').trim();
    out.push({
      userId: /^\d{5,15}$/.test(target) ? target : '',
      name: target,
      content: content.slice(0, 300),
      createdAt: Number(e?.createdAt) || Date.now()
    });
  }
  return out;
}

/** 把旧版单文件里的印象并入目标的每成员文件（按 content 去重）。返回 { members, added }。 */
function mergeLegacyMemoryFile(srcFile, dstChatDir, beforeWrite) {
  const entries = legacyImpressionEntries(srcFile);
  if (!entries.length) return { members: 0, added: 0 };
  const groups = new Map();      // 成员文件名 -> { userId, name, entries }
  for (const e of entries) {
    const fileName = memberFileName(e.userId, e.name);
    if (!groups.has(fileName)) groups.set(fileName, { userId: e.userId, name: e.name, entries: [] });
    groups.get(fileName).entries.push({ content: e.content, createdAt: e.createdAt });
  }
  fs.mkdirSync(dstChatDir, { recursive: true });
  let added = 0;
  for (const [fileName, g] of groups) {
    const dstPath = path.join(dstChatDir, fileName);
    const dstMember = readJson(dstPath, null);
    if (!dstMember || !Array.isArray(dstMember.impressions)) {
      // 目标没有这个成员：整份建出来（与目录形态的"直接复制"等价）
      beforeWrite(dstPath);
      atomicWrite(dstPath, {
        userId: g.userId,
        name: g.name || g.userId,
        impressions: g.entries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
        updatedAt: Date.now(),
        lastConsolidatedAt: 0
      });
      added += g.entries.length;
      continue;
    }
    const seen = new Set(dstMember.impressions.map((e) => String(e?.content ?? '')));
    let n = 0;
    for (const e of g.entries) {
      if (!e.content || seen.has(e.content)) continue;
      seen.add(e.content);
      dstMember.impressions.push({ content: e.content, createdAt: e.createdAt });
      n += 1;
    }
    if (n) {
      dstMember.impressions.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
      dstMember.updatedAt = Math.max(Number(dstMember.updatedAt) || 0, Date.now());
      beforeWrite(dstPath);
      atomicWrite(dstPath, dstMember);
      added += n;
    }
  }
  return { members: groups.size, added };
}

// ── 统计合并 ─────────────────────────────────────────────────────────────

function addNumeric(a, b) {
  return (Number(a) || 0) + (Number(b) || 0);
}

function mergeCostGuard(srcObj, dstObj) {
  const out = { ...(dstObj || { day: srcObj.day, chats: {}, totalPrompt: 0 }) };
  out.day = String(srcObj?.day || out.day || '');
  out.chats = { ...(out.chats || {}) };
  // 两个实例各自记录的消耗都真实发生过：同键相加（搬家场景目标通常为空，无冲突）
  for (const [k, v] of Object.entries(srcObj?.chats || {})) {
    out.chats[k] = addNumeric(out.chats[k], v);
  }
  let sum = 0;
  for (const v of Object.values(out.chats)) sum += Number(v) || 0;
  out.totalPrompt = sum;
  return out;
}

function mergeTelemetryTotals(srcObj, dstObj) {
  const out = { ...(dstObj || {}) };
  for (const [k, v] of Object.entries(srcObj || {})) {
    if (k === 'toolCounts') {
      const tc = { ...(out.toolCounts || {}) };
      for (const [tool, n] of Object.entries(v || {})) tc[tool] = addNumeric(tc[tool], n);
      out.toolCounts = tc;
    } else if (typeof v === 'number') {
      out[k] = addNumeric(out[k], v);
    }
  }
  return out;
}

/** usage-daily 只补缺：目标没有的"天"整块导入，冲突天原样保留目标数据。 */
function mergeUsageDaily(srcObj, dstObj) {
  const out = { ...(dstObj || { version: 1, savedAt: Date.now(), days: {} }) };
  out.days = { ...(out.days || {}) };
  let filled = 0, skipped = 0;
  for (const [day, block] of Object.entries(srcObj?.days || {})) {
    if (out.days[day]) { skipped += 1; continue; }
    out.days[day] = block;
    filled += 1;
  }
  out.savedAt = Date.now();
  return { out, filled, skipped };
}

// ── memory-v2 磁盘级重置（插件未启用时的兜底重建路径）───────────────────────
// 正常路径走 conversation-memory 的 memory.rebuild 能力（force 巩固）。
// 插件没开时直接清盘：删该会话的块文件 + 倒排摘除 + 水位归零；
// 插件下次启用时 boot 巩固会从 messages 全量重建（水位 0 = 全部重压）。

function resetMemoryV2ForChat(chatKey) {
  const root = path.join(DATA_DIR, 'memory-v2');
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  const prefixes = [`hour_${safe}_`, `day_${safe}_`, `ep_${safe}_`];
  let chunks = 0;

  // 1) 删块文件
  try {
    for (const f of fs.readdirSync(path.join(root, 'chunks'))) {
      if (prefixes.some((p) => f.startsWith(p))) {
        try { fs.unlinkSync(path.join(root, 'chunks', f)); chunks += 1; } catch { /* ignore */ }
      }
    }
  } catch { /* 目录不存在 */ }

  // 2) 倒排索引摘除该会话的所有块
  const indexFile = path.join(root, 'index.json');
  const index = readJson(indexFile, null);
  if (index && index.chunks && index.postings) {
    const dead = new Set(Object.keys(index.chunks).filter((id) => prefixes.some((p) => id.startsWith(p))));
    for (const id of dead) delete index.chunks[id];
    for (const t of Object.keys(index.postings)) {
      const next = index.postings[t].filter((p) => !dead.has(p.chunkId));
      if (next.length === 0) delete index.postings[t];
      else if (next.length !== index.postings[t].length) index.postings[t] = next;
    }
    atomicWrite(indexFile, index);
  }

  // 3) 水位归零
  const stateFile = path.join(root, 'state.json');
  const state = readJson(stateFile, null);
  if (state && state.chats) {
    state.chats[chatKey] = { lastIndexedId: 0, lastTs: 0, dayKeys: {} };
    atomicWrite(stateFile, state);
  }
  return { chunksRemoved: chunks };
}

// ── 执行导入 ─────────────────────────────────────────────────────────────

async function reloadStickers(hooks) {
  if (hooks.stickersReload) await hooks.stickersReload();
  else logger.warn('[migrate] 磁盘已更新但运行中的表情库仍是旧的，需重启或重新同步才能生效');
}

let importInFlight = false;

/**
 * 执行导入。
 * @param {string} sourceDir 源 data 目录或解包根目录
 * @param {object} selection 用户勾选：
 *   { messages: { chatKeys: string[], strategy: 'merge'|'overwrite' },
 *     memory: boolean, reminders: boolean, stickers: boolean, stats: { costGuard, telemetryTotals, usageDaily },
 *     persona?: boolean, customPersonas?: boolean, lists?: boolean, configSafe?: boolean,
 *     wallpaper?: boolean, desktopPet?: boolean, drafts?: boolean,
 *     extensions?: boolean, modules?: string[] }
 * @param {object} hooks 热生效回调（由 routes 层注入）：
 *   { remindersReload(), stickersReload(), storeInvalidate(chatKey), rebuildChat(chatKey), configReload(),
 *     forgeImportZip({zipBase64, zipName, draftId}), forgeGate({draftId}), forgeDiscard({draftId}) }
 *   forge 回调对应同名能力；这里只暂存，不签票、不安装，后续必须由控制台人工确认。
 */
export async function applyImport(sourceDir, selection = {}, hooks = {}) {
  // 重入闸：导入是"备份 → 覆盖 → 回填缓存"的多步长流程，并发两次会把
  // 两份备份互相交错、缓存回填互相踩（第二次 invalidate 掉第一次刚 rebuild 的）。
  if (importInFlight) return { ok: false, error: '已有一个导入正在进行，请等它完成' };
  importInFlight = true;
  try {
    return await applyImportInner(sourceDir, selection, hooks);
  } finally {
    importInFlight = false;
  }
}

async function applyImportInner(sourceDir, selection = {}, hooks = {}) {
  const src = String(sourceDir || '').trim();
  const sourceRoot = path.resolve(src);
  if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return { ok: false, error: `目录不存在：${sourceRoot}` };
  }
  const scan = scanSource(sourceRoot);
  if (!scan.ok) return scan;
  const { root, data: abs } = sourcePaths(sourceRoot);

  const { id: backupId, dir: backupDir } = newBackupDir();
  const manifest = {
    id: backupId,
    at: Date.now(),
    sourceDir: sourceRoot,
    actions: [],
    version: 1
  };
  const report = {
    ok: true, backupId, backupDir: path.relative(DATA_DIR, backupDir).replace(/\\/g, '/'),
    messages: [], memory: null, stats: {}, rebuilt: []
  };
  const recordAction = (action) => {
    // 持久化失败就停止该文件的写入；不能产生没有回滚依据的修改。
    manifest.actions.push(action);
    try { atomicWrite(path.join(backupDir, 'manifest.json'), manifest); }
    catch (error) { manifest.actions.pop(); throw error; }
  };
  try { atomicWrite(path.join(backupDir, 'manifest.json'), manifest); }
  catch (error) { return { ...report, ok: false, error: `无法保存回滚清单：${error?.message ?? error}` }; }

  // ── 1. 会话存档 ──
  const msgSel = selection.messages || {};
  const strategy = msgSel.strategy === 'overwrite' ? 'overwrite' : 'merge';
  const wanted = new Set(Array.isArray(msgSel.chatKeys) ? msgSel.chatKeys.map(String) : []);
  for (const item of scan.messages) {
    if (!wanted.has(item.chatKey)) continue;
    const srcFile = path.join(abs, 'messages', `${String(item.chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
    const dstFile = chatFileOf(item.chatKey);
    const sourceState = loadChatFile(srcFile);
    if (!sourceState) {
      report.messages.push({ chatKey: item.chatKey, ok: false, error: '源文件读取失败' });
      continue;
    }
    try {
      const bk = backupFile(backupDir, dstFile);
      recordAction({ type: 'messages', chatKey: item.chatKey, strategy, target: 'messages/' + path.basename(dstFile), backup: bk.backup || null });

      const targetState = loadChatFile(dstFile);
      let nextState;
      if (strategy === 'overwrite' || !targetState) {
        nextState = overwriteChatState(sourceState);
      } else {
        nextState = mergeChatState(targetState, sourceState);
      }
      atomicWrite(dstFile, nextState);

      // 热生效：内存失效 + 索引重建
      try { hooks.storeInvalidate?.(item.chatKey); } catch (e) { logger.warn('[migrate] 内存失效失败:', e?.message ?? e); }
      let rebuild = null;
      try { rebuild = hooks.rebuildChat ? await hooks.rebuildChat(item.chatKey) : null; } catch { /* ignore */ }
      if (!rebuild) {
        // 插件没开 / 回调缺位：磁盘级重置兜底（下次启用时 boot 巩固自动全量重建）
        const r = resetMemoryV2ForChat(item.chatKey);
        rebuild = { mode: 'disk-reset', ...r };
      }
      report.rebuilt.push({ chatKey: item.chatKey, ...rebuild });

      report.messages.push({
        chatKey: item.chatKey, ok: true, strategy,
        sourceCount: sourceState.count,
        targetCount: targetState?.count || 0,
        added: nextState.added,
        total: nextState.messages.length
      });
    } catch (error) {
      report.messages.push({ chatKey: item.chatKey, ok: false, error: String(error?.message ?? error) });
    }
  }

  // ── 2. 群友印象 ──
  if (selection.memory && scan.memory.available) {
    const memSummary = { chats: 0, added: 0, failed: 0 };
    try {
      for (const c of scan.memory.chats) {
  // 逐会话 try：整个循环共用一个 try 的话，任何一个会话出问题（比如源那边
  // 只有旧版单文件、没有同名文件夹）都会把后面所有会话的印象一起丢掉，
  // 而报告只留一句 error。
        try {
          const safeChat = String(c.chatKey).replace(/[^a-z0-9_]/gi, '_');
          const srcChatDir = path.join(abs, 'memory', safeChat);
          const srcLegacyFile = path.join(abs, 'memory', `${safeChat}.json`);
          const dstChatDir = path.join(MEMORY_DIR, safeChat);
          const recorded = new Set();
          const beforeWrite = (file) => {
            if (recorded.has(file)) return;
            const bk = backupFile(backupDir, file);
            recordAction({ type: 'memory', chatKey: c.chatKey, target: path.relative(DATA_DIR, file).replace(/\\/g, '/'), backup: bk.backup || null });
            recorded.add(file);
          };
          const r = mergeMemoryChat(srcChatDir, dstChatDir, beforeWrite);
          const l = fs.existsSync(srcLegacyFile)                              // 旧版：每会话单文件
            ? mergeLegacyMemoryFile(srcLegacyFile, dstChatDir, beforeWrite)
            : { members: 0, added: 0 };
          memSummary.chats += 1;
          memSummary.added += r.added + l.added;
          try { hooks.memoryInvalidate?.(c.chatKey); } catch { /* ignore */ }
        } catch (error) {
          memSummary.failed += 1;
          logger.warn('[migrate]', `群友印象导入失败（${c.chatKey}）：`, error?.message ?? error);
        }
      }
      report.memory = { ok: memSummary.failed === 0, ...memSummary };
    } catch (error) {
      report.memory = { ok: false, error: String(error?.message ?? error) };
    }
  }

  // ── 3. 统计合并 ──
  const statSel = selection.stats || {};
  const statTargets = {
    costGuard: 'cost-guard.json',
    telemetryTotals: 'telemetry-totals.json',
    usageDaily: 'usage-daily.json',
    usageArchivedDays: 'usage-archived-days.json',
    usageToday: 'usage-today.json'
  };
  for (const [key, fileName] of Object.entries(statTargets)) {
    if (!statSel[key]) continue;
    const srcFile = path.join(abs, fileName);
    // 单槽的当天计数不能覆盖本机正在累计的数据，转入按天归档作为补缺来源。
    const targetName = key === 'usageToday' ? 'usage-archived-days.json' : fileName;
    const dstFile = path.join(DATA_DIR, targetName);
    if (!fs.existsSync(srcFile)) continue;
    try {
      let srcObj = readJson(srcFile, null);
      if (!srcObj) throw new Error('源统计文件损坏或结构无效');
      if (key === 'usageToday') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(srcObj.dayKey || '')) throw new Error('源当日用量缺少日期');
        srcObj = { days: { [srcObj.dayKey]: srcObj } };
      }
      const dstObj = readJson(dstFile, null);
      // 多个源可能补入同一个归档文件，只保留恢复前的那份快照。
      if (!manifest.actions.some((action) => action.target === targetName)) {
        const bk = backupFile(backupDir, dstFile);
        recordAction({ type: 'stats', file: fileName, target: targetName, backup: bk.backup || null });
      }
      let detail = {};
      if (key === 'costGuard') {
        atomicWrite(dstFile, mergeCostGuard(srcObj, dstObj));
      } else if (key === 'telemetryTotals') {
        atomicWrite(dstFile, mergeTelemetryTotals(srcObj, dstObj));
      } else {
        const r = mergeUsageDaily(srcObj, dstObj);
        atomicWrite(dstFile, r.out);
        detail = { filled: r.filled, skipped: r.skipped };
      }
      report.stats[key] = { ok: true, ...detail };
    } catch (error) {
      report.stats[key] = { ok: false, error: String(error?.message ?? error) };
    }
  }

  // stickers-hidden.json 是本机软删除习惯，跨实例合并会隐藏对方的条目，语义不成立；后续单独处理。
  // StickerManager.entries 是构造时加载的常驻缓存，写盘不会自动生效；由调用方注入 hook 刷新。
  for (const category of MERGE_CATEGORIES) {
    if (!selection[category]) continue;
    const fileName = category === 'reminders' ? REMINDERS_FILE : STICKERS_FILE;
    const sourceFile = path.join(abs, fileName);
    const targetFile = path.join(DATA_DIR, fileName);
    const detail = { ok: false, added: 0, total: 0, skipped: 0 };
    report[category] = detail;
    try {
      const raw = readJson(sourceFile);
      let sourceEntries = category === 'reminders' ? raw?.reminders : raw;
      if (!Array.isArray(sourceEntries)) {
        if (category === 'reminders') throw new Error('源文件不存在、损坏或结构无效');
        logger.warn('[migrate] 表情源文件不存在、损坏或结构无效，按空数组处理');
        sourceEntries = [];
      }
      const targetRaw = readJson(targetFile);
      let targetEntries = category === 'reminders' ? targetRaw?.reminders : targetRaw;
      if (category === 'stickers' && fs.existsSync(targetFile) && !Array.isArray(targetEntries)) {
        logger.warn('[migrate] 表情目标文件损坏或结构无效，按空数组处理（写入前备份原文件）');
        targetEntries = [];
      }
      if (fs.existsSync(targetFile) && !Array.isArray(targetEntries)) throw new Error('目标文件损坏或结构无效，拒绝覆盖');
      // 只依赖 id 最小契约；保留原条目，字段归一化交给插件运行时，避免两套规则漂移。
      const entryId = (entry) => String(category === 'stickers' ? (entry?.id || entry?.emoji_id || entry?.resId || '') : (entry?.id || '')).trim();
      const merged = [...(targetEntries || [])];
      const seen = new Set(merged.map(entryId));
      for (const entry of sourceEntries) {
        const id = entryId(entry);
        if (!id || seen.has(id)) { detail.skipped += 1; continue; }
        seen.add(id);
        merged.push(entry);
        detail.added += 1;
      }
      detail.total = merged.length;
      const bk = backupFile(backupDir, targetFile);
      recordAction({ type: category, target: fileName, backup: bk.backup || null });
      if (category === 'stickers') atomicWrite(targetFile, merged);
      else atomicWrite(targetFile, { ...(targetRaw || {}), reminders: merged });
      if (category === 'reminders') await hooks.remindersReload?.();
      else await reloadStickers(hooks);
      detail.ok = true;
    } catch (error) {
      detail.error = String(error?.message ?? error);
      report.ok = false;
      logger.warn('[migrate]', category, detail.error);
    }
  }

  // 多个配置类别共写一个文件，快照必须是整次导入之前的原始字节。
  let configBackup;
  let configTouched = false;
  for (const [category, fields] of Object.entries(CONFIG_FIELDS)) {
    if (!selection[category]) continue;
    const detail = { ok: false };
    (report.configFields ||= {})[category] = detail;
    try {
      const sourceFile = checkedSourcePath(root, 'config-fields', `${category}.json`);
      if (!fs.existsSync(sourceFile)) { Object.assign(detail, { ok: true, skipped: true }); continue; }
      const sourceConfig = readJson(sourceFile);
      if (!isRecord(sourceConfig)) throw new Error('源配置字段文件损坏或结构无效');
      checkedSourcePath(DATA_DIR, path.basename(CONFIG_FILE));
      const targetConfig = readJson(CONFIG_FILE);
      if (fs.existsSync(CONFIG_FILE) && !isRecord(targetConfig)) throw new Error('本机配置损坏或结构无效，拒绝覆盖');
      const patch = {};
      for (const field of fields) {
        if (!Object.hasOwn(sourceConfig, field)) continue;
        let value = sourceConfig[field];
        if (field === 'customPersonas') {
          if (!Array.isArray(value)) throw new Error('自定义人设必须是数组');
          value = value.filter((entry) => isRecord(entry) && entry.id != null && String(entry.id).trim());
        }
        if (category === 'configSafe' && field === 'skills' && isRecord(value)) {
          value = Object.fromEntries(Object.entries(value).filter(([id]) => !SENSITIVE_SKILL_IDS.has(id)));
        }
        patch[field] = value;
      }
      const nextConfig = fillMissing(targetConfig || {}, patch);
      if (JSON.stringify(nextConfig) !== JSON.stringify(targetConfig || {})) {
        configBackup ||= backupFile(backupDir, CONFIG_FILE);
        recordAction({ type: 'config-fields', category, target: path.basename(CONFIG_FILE), backup: configBackup.backup || null });
        atomicWrite(CONFIG_FILE, nextConfig);
        configTouched = true;
      }
      detail.ok = true;
    } catch (error) {
      detail.error = String(error?.message ?? error);
      report.ok = false;
    }
  }
  if (configTouched) {
    try { await hooks.configReload?.(); }
    catch (error) { report.ok = false; report.configReloadError = String(error?.message ?? error); }
  }

  // 壁纸、桌宠按文件覆盖；只有状态 JSON 沿用配置类的本机优先补缺。
  for (const [category, { paths, mergeFiles }] of Object.entries(FILE_RESTORE_CATEGORIES)) {
    if (!selection[category]) continue;
    const detail = report[category] = { ok: false, files: 0 };
    try {
      checkedSourcePath(root, path.relative(root, abs));
      const files = paths.flatMap((rel) => restoreFiles(abs, rel));
      for (const rel of files) {
        const sourceFile = checkedSourcePath(abs, rel);
        const targetFile = checkedSourcePath(DATA_DIR, rel);
        let data = fs.readFileSync(sourceFile);
        if (mergeFiles.includes(rel)) {
          const sourceState = readJson(sourceFile);
          const targetState = readJson(targetFile);
          if (!isRecord(sourceState)) throw new Error('源状态文件损坏或结构无效');
          if (fs.existsSync(targetFile) && !isRecord(targetState)) throw new Error('本机状态文件损坏或结构无效，拒绝覆盖');
          data = fillMissing(targetState || {}, sourceState);
        }
        const bk = backupFile(backupDir, targetFile);
        recordAction({ type: category, target: rel, backup: bk.backup || null });
        atomicWrite(targetFile, data);
        detail.files += 1;
      }
      detail.ok = true;
      if (!files.length) detail.skipped = true;
    } catch (error) {
      detail.error = String(error?.message ?? error);
      report.ok = false;
    }
  }

  // 草稿只落暂存区；同名目录整体替换，未出现在包中的本机草稿保留。
  if (selection.drafts) {
    const detail = report.drafts = { ok: false, files: 0, drafts: 0 };
    try {
      const sourceBase = checkedSourcePath(root, 'drafts');
      if (fs.existsSync(sourceBase)) {
        const staging = path.join('plugin-data', 'extension-forge', 'staging');
        for (const entry of fs.readdirSync(sourceBase, { withFileTypes: true })) {
          checkedSourcePath(root, 'drafts', entry.name);
          if (!entry.isDirectory()) throw new Error('草稿必须按目录存放');
          const sourceRel = path.join('drafts', entry.name);
          const targetRel = path.join(staging, entry.name);
          const targetDir = checkedSourcePath(DATA_DIR, targetRel);
          if (fs.existsSync(targetDir) && !fs.statSync(targetDir).isDirectory()) throw new Error('本机草稿路径不是目录');
          const files = restoreFiles(root, sourceRel);
          const incoming = new Set(files.map((rel) => path.relative(sourceRel, rel).replace(/\\/g, '/')));
          const existing = restoreFiles(DATA_DIR, targetRel);
          // 删除旧目录中不属于这份草稿的文件前，同样逐文件快照并持久化动作。
          for (const rel of existing) {
            if (incoming.has(path.relative(targetRel, rel).replace(/\\/g, '/'))) continue;
            const targetFile = checkedSourcePath(DATA_DIR, rel);
            const bk = backupFile(backupDir, targetFile);
            recordAction({ type: 'drafts', target: rel, backup: bk.backup || null });
            fs.rmSync(targetFile);
            removeEmptyParents(targetFile, targetDir);
          }
          for (const rel of files) {
            const targetFile = checkedSourcePath(DATA_DIR, targetRel, path.relative(sourceRel, rel));
            const data = fs.readFileSync(checkedSourcePath(root, rel));
            const bk = backupFile(backupDir, targetFile);
            recordAction({ type: 'drafts', target: path.relative(DATA_DIR, targetFile).replace(/\\/g, '/'), backup: bk.backup || null });
            atomicWrite(targetFile, data);
            detail.files += 1;
          }
          detail.drafts += 1;
        }
      }
      detail.ok = true;
      if (!detail.drafts) detail.skipped = true;
    } catch (error) {
      detail.error = String(error?.message ?? error);
      report.ok = false;
    }
  }

  const moduleKeys = new Set(Array.isArray(selection.modules) ? selection.modules.map(String) : []);
  if (selection.extensions || moduleKeys.size) {
    report.modules = [];
    for (const item of scan.modules) {
      if (!selection.extensions && !moduleKeys.has(item.key)) continue;
      const detail = { key: item.key, ok: false, needConfirm: true };
      report.modules.push(detail);
      try {
        if (![hooks.forgeImportZip, hooks.forgeGate, hooks.forgeDiscard].every((fn) => typeof fn === 'function')) {
          throw new Error('扩展锻造台未就绪（需要导入、闸门和丢弃草稿能力）');
        }
        const { zip, base, manifest: moduleManifest } = moduleZip(root, item.kind, item.dir);
        const checkTrust = hooks.checkPluginTrust || (await import('./plugin-loader.js')).checkPluginTrust;
        // 扫整个扩展目录，避免 entry 放在子目录时遗漏其同级代码。
        const trust = await checkTrust(String(moduleManifest.id || item.dir), path.join(base, 'index.js'));
        if (!trust?.ok) throw new Error(trust?.reason || '扩展未通过能力扫描');
        const draftId = `restore-${randomUUID()}`;
        const draftPath = path.join(DATA_DIR, 'plugin-data', 'extension-forge', 'staging', draftId);
        if (fs.existsSync(draftPath)) throw new Error('暂存草稿已存在，拒绝覆盖');
        // 先记录确定的草稿 id，连导入抛错留下的半成品也能回滚。
        recordAction({ type: 'modules', key: item.key, draftId });
        detail.draftId = draftId;
        const out = await hooks.forgeImportZip({ draftId, zipBase64: zip.toString('base64'), zipName: `${item.key.replace(':', '-')}.zip` });
        if (!out?.ok) throw new Error(out?.error || '导入暂存区失败');
        if (out.draftId !== draftId) throw new Error('锻造台未使用请求的草稿 id');
        detail.gate = await hooks.forgeGate({ draftId });
        if (!detail.gate?.ok) throw new Error(detail.gate?.error || '扩展未通过锻造台闸门');
        detail.ok = true;
      } catch (error) {
        detail.error = String(error?.message ?? error);
        report.ok = false;
      }
    }
  }

  report.ok = report.ok && report.messages.every((item) => item.ok)
    && report.memory?.ok !== false && Object.values(report.stats).every((item) => item.ok);
  if (!report.ok) report.error = '部分数据导入失败，已完成的修改可使用 backupId 回滚';
  logger.info('[migrate]', `导入完成：backup=${backupId}，messages=${report.messages.filter((m) => m.ok).length}，memory=${report.memory?.added ?? 0}`);
  return report;
}

// ── 回滚 ─────────────────────────────────────────────────────────────────

/**
 * 回滚一次导入：按 manifest 把备份文件复制回原位。
 * 新增文件（backup=null）直接删除。回滚后同样触发失效与重建：
 * messages 走 ChatStore 失效 + memory-v2 重建；memory 走 MemoryStore 失效
 * （不失效的话，内存里的合并结果会在下次写记忆时把回滚内容覆盖回去）。
 */
export async function rollbackImport(backupId, hooks = {}) {
  if (importInFlight) return { ok: false, error: '已有一个导入或回滚正在进行，请等它完成' };
  importInFlight = true;
  try { return await rollbackImportInner(backupId, hooks); }
  finally { importInFlight = false; }
}

async function rollbackImportInner(backupId, hooks = {}) {
  const id = String(backupId || '').trim();
  if (!BACKUP_ID_PATTERN.test(id)) return { ok: false, error: '非法备份 id' };
  let dir, manifest;
  const rollbackPath = (root, relative) => {
    if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)
        || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new Error('回滚路径必须是边界内的相对文件路径');
    }
    const file = checkedSourcePath(root, relative);
    if (file === path.resolve(root)) throw new Error('回滚路径不能是根目录');
    return file;
  };
  try {
    dir = checkedSourcePath(DATA_DIR, 'import-backups', id);
    manifest = readJson(checkedSourcePath(dir, 'manifest.json'), null);
    // 清单整体预检后才执行：后面的恶意路径不能让前面的合法文件先被删除。
    for (const action of manifest?.actions ?? []) {
      if (action.type === 'modules') continue;
      rollbackPath(DATA_DIR, action.target);
      if (action.backup) rollbackPath(dir, action.backup);
    }
  } catch (error) {
    return { ok: false, error: `回滚清单不安全：${error.message}` };
  }
  if (!manifest || !Array.isArray(manifest.actions)) {
    return { ok: false, error: `备份不存在或缺少 manifest：${id}` };
  }
  // 两类会话要分开失效：
  //   messages 改动 → ChatStore 内存 + memory-v2 长时索引（后者要重建）；
  //   群友印象改动 → MemoryStore 内存（与 memory-v2 无关，不需要重建）。
  //   只收 messages 类型的话，只勾了"群友印象"的导入回滚后 MemoryStore 缓存
  //   还留着合并后的状态，下一次写记忆（append/整理）就把回滚内容原样写回磁盘
  //   回滚看起来成功、实际被内存缓存悄悄撤销。
  const msgChats = new Set();
  const memChats = new Set();
  let remindersTouched = false;
  let stickersTouched = false;
  let configTouched = false;
  let restored = 0, removed = 0, failed = 0;

  // 草稿目录替换可能把文件变成子目录，先撤新增路径再还原旧文件。
  // 只倒序撤销草稿，其他类别保留原有的回滚与 hook 调用顺序。
  const actions = manifest.actions.filter((a) => a.type !== 'drafts');
  actions.push(...manifest.actions.filter((a) => a.type === 'drafts').reverse());
  for (const a of actions) {
    try {
      if (a.type === 'modules') {
        if (typeof hooks.forgeDiscard !== 'function') throw new Error('扩展锻造台丢弃草稿能力未就绪');
        const out = await hooks.forgeDiscard({ draftId: a.draftId });
        if (!out?.ok) throw new Error(out?.error || '删除暂存草稿失败');
        removed += 1;
        continue;
      }
      const target = rollbackPath(DATA_DIR, a.target);
      if (a.backup) {
        const src = rollbackPath(dir, a.backup);
        if (!fs.existsSync(src)) { failed += 1; continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // 原文件即使损坏也须逐字节还原；原子写的底层同样接受 Buffer。
        atomicWriteText(target, fs.readFileSync(src));
        restored += 1;
      } else {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true });
          removed += 1;
          // 群友印象按会话建目录：新建的成员文件被删空之后要把目录一起收掉，
          // 否则 MemoryStore.listChats() 会把空目录当成"这个会话有记忆"，
          // 记忆页里留下一串导入已撤回的幽灵会话（rmdir 对非空目录会失败，
          // 所以只会收掉真正空掉的那一个）。
          if (a.type === 'memory') {
            try {
              const dir = path.dirname(target);
              if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
            } catch { /* ignore */ }
          }
        }
        if (Object.hasOwn(FILE_RESTORE_CATEGORIES, a.type) || a.type === 'drafts') {
          const boundary = a.type === 'drafts'
            ? path.join(DATA_DIR, 'plugin-data', 'extension-forge', 'staging') : DATA_DIR;
          removeEmptyParents(target, boundary);
        }
      }
      if (a.type === 'stickers') stickersTouched = true;
      if (a.type === 'reminders') remindersTouched = true;
      if (a.type === 'config-fields') configTouched = true;
      if (a.type === 'messages' && a.chatKey) msgChats.add(a.chatKey);
      if (a.type === 'memory' && a.chatKey) memChats.add(a.chatKey);
    } catch {
      failed += 1;
    }
  }

  for (const chatKey of memChats) {
    try { hooks.memoryInvalidate?.(chatKey); } catch { /* ignore */ }
  }

  for (const chatKey of msgChats) {
    try { hooks.storeInvalidate?.(chatKey); } catch { /* ignore */ }
    let rebuild = null;
    try { rebuild = hooks.rebuildChat ? await hooks.rebuildChat(chatKey) : null; } catch { /* ignore */ }
    if (!rebuild) {
      try { resetMemoryV2ForChat(chatKey); } catch { /* ignore */ }
    }
  }

  if (remindersTouched) {
    try { await hooks.remindersReload?.(); } catch (error) {
      failed += 1;
      logger.warn('[migrate] 提醒重新加载失败:', error?.message ?? error);
    }
  }
  if (stickersTouched) {
    try { await reloadStickers(hooks); } catch (error) {
      failed += 1;
      logger.warn('[migrate] 表情重新加载失败:', error?.message ?? error);
    }
  }
  if (configTouched) {
    try { await hooks.configReload?.(); } catch (error) {
      failed += 1;
      logger.warn('[migrate] 配置重新加载失败:', error?.message ?? error);
    }
  }
  const touchedChats = [...new Set([...msgChats, ...memChats])];
  logger.info('[migrate]', `回滚 ${id}：恢复 ${restored}，删除 ${removed}，失败 ${failed}`);
  return { ok: failed === 0, backupId: id, restored, removed, failed, touchedChats };
}

export const migrateAdmin = {
  scanSource,
  applyImport,
  rollbackImport,
  listBackups,
  resetMemoryV2ForChat
};
