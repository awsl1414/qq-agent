// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { logger } from './logger.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
    // 正在做旧版迁移的会话。#migrateLegacy 的调用链是
    //   #migrateLegacy → #appendRaw → #ensureChat → #migrateLegacy（回到自己）
    // 没有守卫时它会无限递归，只能靠 V8 栈溢出终止（实测 20 条印象 = 138 秒同步阻塞，
    // 且栈溢出被 catch 吞掉 → 迁移"看起来成功了"）。见 #migrateLegacy。
    this.migrating = new Set();
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR, { withFileTypes: true })) {
        if (f.isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /**
   * 失效某个会话的内存缓存（数据移植用）。
   * 磁盘上的成员文件被外部合并写入后，内存里的旧 Map 会在下次写回时
   * 反向覆盖导入内容，必须先丢弃，下次访问重读磁盘。
   */
  invalidate(chatKey) {
    return this.cache.delete(String(chatKey));
  }

  /**
   * 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。
   *
   * 这里曾经有两个 P0（实测复现）：
   *
   * 1) 无界递归。调用链是本方法 → #appendRaw → #ensureChat → 本方法，
   *    且 #ensureChat 里的 `cache.has()` 根本来不及生效，递归发生在填缓存之前。
   *    实测 20 条印象 = 138 秒同步阻塞 + 74 次 "Maximum call stack size exceeded"。
   *    修法：`migrating` 守卫（重入直接返回，交给外层帧继续）。
   *
   * 2) 唯一备份被外层帧删掉。原代码是
   *      if (existsSync(backup)) rmSync(backup);
   *      renameSync(legacy, backup);
   *    最深层帧先完成 rename，回溯时每个外层帧各自重新执行第一行：backup
   *    已存在，于是把唯一一份备份 rmSync 掉，紧接着第二行抛 ENOENT 被 catch 吞掉。
   *    实测终态：旧文件消失、backups/ 为空、零备份（不可逆数据丢失）。
   *    修法：备份路径带时间戳，永不复用同一路径，因此不再有"删除已有备份"这个动作。
   */
  #migrateLegacy(chatKey) {
    // 守卫：已在迁移中 → 直接返回。这一个 if 同时消灭上面两个 P0。
    if (this.migrating.has(chatKey)) return;
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    this.migrating.add(chatKey);
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      // 注意顺序：先全部落盘（#appendRaw），成功后才把旧文件移走。
      // 递归已由 migrating 守卫掐断，所以这里的 #appendRaw 不会回头再触发迁移。
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt);
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      // 备份路径带时间戳：永不复用同一路径 → 不再需要（也绝不能）先删已有备份。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(backupDir, `${path.basename(legacy, '.json')}.${stamp}.json`);
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    } finally {
      this.migrating.delete(chatKey);
    }
  }

  #ensureChat(chatKey) {
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      logger.info('memory', `合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  #appendRaw(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now()
    };
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target } */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content);
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    // 保留每条印象原有的 createdAt。
    //   整表重建、一律写 now 的话，用户改一个字保存，这个群友所有印象的时间戳
    //   都变成"刚刚"，而 UI 是按条显示时间的（05-memory-settings.js 的记忆条目渲染），
    //   整条时间线从此失真。按正文匹配沿用旧时间，只有新增的才盖 now。
    const prevAt = new Map();
    for (const e of (old.impressions || [])) {
      const c = String(e?.content ?? '');
      if (c && !prevAt.has(c)) prevAt.set(c, Number(e?.createdAt) || 0);
    }
    const entries = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => {
        const c = content.slice(0, 300);
        return { content: c, createdAt: prevAt.get(c) || now };
      });
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /**
   * 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。
   * 整理链路不用本方法（它要求数字 QQ 号、整体覆盖）：
   *    - 整理写回 → replaceConsolidatedMember（支持无 QQ 号条目）
   *    - 名字反查合并 → mergeMemberInto（合并去重 + 即时删旧）
   * 本方法保留"必须数字 QQ 号"的严格语义，供管理端编辑类调用使用。
   */
  replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /**
   * 整理路径写回（orchestrator 整理专用）：允许"无 QQ 号"成员。
   *
   * 背景：整理对历史遗留的 `_n_<名字>` 条目（userId 为空）写回时，旧实现直接走
   * replaceMember，其"userId 必须是数字 QQ 号"校验对这类条目必抛错，表现为
   * "N 位失败（已保留原印象）"：用户的旧印象永远无法被整理。
   *
   * 规则：
   *   - userId 是数字 → 与 replaceMember 完全同构（写 <QQ>.json，键为 QQ 号）。
   *   - userId 为空 → 按名字写回 `_n_<名字>.json`（保持"无 QQ 号"状态，绝不
   *     伪造 QQ 号），内存键与 #ensureChat / #appendRaw 的 `_n_<文件名>` 约定一致。
   */
  replaceConsolidatedMember(chatKey, member = {}, contents = []) {
    const uid = String(member.userId ?? '').trim();
    const nm = String(member.name ?? '').trim().slice(0, 60);
    if (uid && !/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    if (!uid && !nm) throw new Error('该成员缺 QQ 号且没有名字，无法定位印象文件');
    const map = this.#ensureChat(chatKey);
    const key = uid || `_n_${memberFileName('', nm)}`;
    const old = map.get(key) || loadMember(chatKey, uid, nm);
    const finalName = nm || String(old.name || '').trim() || uid || '某人';
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const next = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 写前备份原文件（保留最近一次），与 replaceMember 同款
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), next);
    map.set(key, next);
    return {
      userId: next.userId,
      name: next.name,
      impressions: next.impressions.map((e) => ({ ...e })),
      updatedAt: next.updatedAt
    };
  }

  /**
   * 把一条记忆并入指定的 QQ 号（整理"名字反查"专用）。
   *
   * 用途：Orchestrator.#resolveIdentity 用名字反查到目标 QQ 号后，把原条目并过去。
   * 旧实现是 `replaceMember` 整体覆盖目标文件：目标已有内容会被冲掉；且旧
   * `_n_` 文件留在磁盘上，同一个人在列表里出现两份（要重启应用才由
   * #mergeNameDuplicates 合并）。本方法：
   *   - 合并去重（目标原有内容保留，绝不覆盖）；
   *   - 即时删除旧文件与内存条目（不用等重启）；
   *   - 安全阀：目标已有名字且与来源名字不一致时不合并（疑似同名不同人），
   *     调用方保持原身份继续处理，宁可晚一步，绝不混数据。
   *
   * @param {string} chatKey
   * @param {{userId?: string, name?: string}} from 来源条目身份（userId 可为空 = 无 QQ 号条目）
   * @param {string} targetUserId 目标 QQ 号
   * @returns {{merged: boolean, added: number, skipped?: boolean}}
   */
  mergeMemberInto(chatKey, from = {}, targetUserId = '') {
    const to = String(targetUserId ?? '').trim();
    if (!/^\d{1,15}$/.test(to)) return { merged: false, added: 0 };
    const fromUid = String(from.userId ?? '').trim();
    const fromName = String(from.name ?? '').trim();
    const map = this.#ensureChat(chatKey);
    // 按身份找来源条目：有 QQ 号按号找；无号按名字找 _n_ 条目
    let srcKey = null;
    let src = null;
    if (fromUid) {
      src = map.get(fromUid) || null;
      srcKey = src ? fromUid : null;
    }
    if (!src && fromName) {
      for (const [k, m] of map.entries()) {
        if (String(m.userId || '').trim()) continue;
        if (String(m.name || '').trim() !== fromName) continue;
        srcKey = k;
        src = m;
        break;
      }
    }
    if (!src || srcKey === to) return { merged: false, added: 0 };
    const target = map.get(to) || loadMember(chatKey, to, fromName);
    const targetName = String(target.name || '').trim();
    // 安全阀：目标已有名字且与来源不一致 → 疑似不同人，不合并
    if (targetName && fromName && targetName !== fromName) {
      return { merged: false, added: 0, skipped: true };
    }
    if (!targetName && fromName) target.name = fromName;
    const seen = new Set((target.impressions || []).map((e) => e.content));
    let added = 0;
    for (const e of src.impressions || []) {
      if (!e?.content || seen.has(e.content)) continue;
      seen.add(e.content);
      target.impressions.push({ ...e });
      added += 1;
    }
    target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(src.updatedAt) || 0, Date.now());
    writeJson(memberFile(chatKey, to, target.name), target);
    map.set(to, target);
    // 删除旧条目（文件 + 内存），即时生效，不再等重启时的 #mergeNameDuplicates
    try { fs.rmSync(memberFile(chatKey, fromUid, src.name || fromName), { force: true }); } catch { /* ignore */ }
    if (!fromUid && fromName && src.name !== fromName) {
      try { fs.rmSync(memberFile(chatKey, '', fromName), { force: true }); } catch { /* ignore */ }
    }
    map.delete(srcKey);
    logger.info('memory', `整理反查：条目「${src.name || fromName || fromUid}」${fromUid ? `（${fromUid}）` : '（无 QQ 号）'} 并入 ${to}，新增 ${added} 条`);
    return { merged: true, added };
  }

  /** 删除某成员的印象文件。 */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    map.delete(uid);
    try { fs.rmSync(memberFile(chatKey, uid, m.name), { force: true }); } catch { /* ignore */ }
    return true;
  }

  /**
   * 删除一个会话的**全部**记忆（记忆页「删除本会话记忆」按钮）。
   * 成员文件、_meta.json、旧版单文件与备份一并清掉；目录本身保留
   * （可能是挂载点/被占用，删不掉也无妨，里面已空）。
   * @returns {boolean} 是否删掉了东西
   */
  removeChat(chatKey) {
    const dir = chatDir(chatKey);
    let removed = false;
    try {
      for (const f of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        removed = true;
      }
    } catch { /* 目录不存在 = 没有记忆可删 */ }
    // 旧版单文件（迁移前的形态）
    try { fs.rmSync(legacyFile(chatKey), { force: true }); removed = true; } catch { /* ignore */ }
    // 内存缓存同步清掉，否则同进程内 members() 还能读到旧数据
    this.#ensureChat(chatKey).clear();
    return removed;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
  }

  clear(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    // 15 条上限对过滤分支同样生效：大群 + 相关成员注入时不过滤的话，
    // 提示词会被几十上百条印象撑爆（token 白烧）。无 QQ 号的旧数据照旧始终带上。
    const picked = (filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all
    ).slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n');
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map(); // key -> { userId, name, contents }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const content of g.contents) {
        this.#appendRaw(chatKey, g.userId, g.name, content, now);
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
  }
}
