// 梗概墓碑（gist tombstones）。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 原来的淘汰是"一刀两断"：块够老 + 权重够低 → 摘索引、删块文件。
// 于是 `forgetSweep` 一跑，那天的事就从"想不起来细节"直接跳到"完全不记得有过"。
// 人不是这样的。人的遗忘是**分层**的：
//
//   · **模糊痕迹理论（Fuzzy-Trace Theory）**：记忆同时存两条痕迹 ——
//     逐字痕迹（verbatim，细节）与要旨痕迹（gist，意思）。
//     逐字痕迹先烂，要旨痕迹留得久得多。所以老人能说清"那年谁跟谁吵过架"，
//     但说不出是哪一天、原话是什么。
//   · **节省效应（Savings）**：即使完全想不起来，重新学习也比第一次快得多 ——
//     说明"痕迹"没消失，只是提取不出来。工程上的对应就是：
//     细节虽然删了，但只要还留着一条线索，就能从原始记录里**快速重建**。
//
// 本插件在这件事上有一个别人没有的便利条件：`messages/` 是**只读完整真相源**，
// 块只是它的一个索引视图。所以"删块"从来不是真的丢数据 ——
// 真正丢的是"知道去哪儿找"。墓碑要补的就是这一条线索。
//
// ── 怎么工作 ──────────────────────────────────────────────────────────────
//   淘汰块时：从块的 summary/keywords 压一条 ≤40 字要旨 + 关键词 + id 区间，
//             写进 `gist.json`。块文件与索引项照常删除（体积照样收得回来）。
//   检索时：  墓碑作为**低权重候选**参与排序（默认 0.35 倍）。
//             活块匹配得一样好时永远排在前面 —— 墓碑只在"没有活块能回答"时露头。
//   命中时：  从 `messages/` 按 id 区间把那一段捞回来、重建块、写回索引，
//             然后删掉墓碑。这就是节省效应的落地：线索 → 完整回忆。
//
// ── 为什么墓碑可以活得比块久得多 ──────────────────────────────────────────
// 一条墓碑只有几十字节（块文件是几 KB 起）。所以保留期可以设成 3 年、
// 每会话留几百条，总占用仍然是几十 KB 量级 —— 用极小的体积换"我好像记得有这回事"。
import fs from 'node:fs';
import path from 'node:path';
import { num, readJson, writeJson, tokenize, dayKeyOf } from './util.js';

const GIST_VERSION = 1;
/** 要旨的最大字数（不是字节）。模糊痕迹的特点就是**短而模糊**，不是摘要。 */
const GIST_MAX_CHARS = 40;
/** 一条墓碑最多带几个关键词 —— 这是它唯一的检索线索。 */
const GIST_MAX_KEYWORDS = 12;
/**
 * 重建失败多少次之后就认命（只给要旨，不再去读原文）。
 * 用常量而不是设置项：这是"原文到底还在不在"的判定阈值，
 * 3 次足够排除偶发抖动，再往上调没有意义，不值得占一个 UI 选项。
 */
const GIST_REVIVE_MAX_TRIES = 3;

/**
 * 从块里压出一条要旨。
 *
 * ⚠️ 刻意做成"要旨"而不是"摘要"：
 *    · 不带具体时间、不带原话 —— 那些是逐字痕迹，本来就该烂掉
 *    · 保留"谁 + 干什么 + 主题词"这类骨架
 *    把细节也抄进墓碑，等于把块换个文件存一遍，体积收益就没了。
 */
function makeGist(block) {
  const snippets = Array.isArray(block?.snippets) ? block.snippets : [];
  const who = new Map();
  for (const s of snippets) {
    const name = String(s?.who || '').trim();
    if (!name || name === '我') continue;
    who.set(name, (who.get(name) || 0) + 1);
  }
  const people = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  const kws = (Array.isArray(block?.keywords) ? block.keywords : [])
    .filter((t) => String(t).length >= 2)
    .slice(0, 5);
  // 用 summary 里信息密度最高的那一条兜底（summary 是 "谁: 内容 | 谁: 内容" 形态）
  let lead = '';
  if (block?.summary) {
    const first = String(block.summary).split('|')[0] || '';
    lead = first.replace(/^[^:：]{1,12}[:：]\s*/, '').trim();
  } else if (snippets.length) {
    lead = String(snippets[0].text || '');
  }

  const parts = [];
  if (people.length) parts.push(people.join('、'));
  if (kws.length) parts.push(kws.join(' '));
  if (lead) parts.push(lead);
  let gist = parts.join(' · ').replace(/\s+/g, ' ').trim();
  if (!gist) gist = '（有一段没留下内容的旧事）';
  if (gist.length > GIST_MAX_CHARS) gist = `${gist.slice(0, GIST_MAX_CHARS - 1)}…`;
  return gist;
}

/**
 * 墓碑库。一个 `gist.json`，按会话分组。
 *
 * 存的是"去哪儿找"，不是内容本身 —— 所以每条都很小，且永远可以按 id 区间重建。
 */
export class GistStore {
  /**
   * @param {string} root            数据根（与 store 同一个）
   * @param {() => object} settings  实时读插件设置
   */
  constructor(root, settings = () => ({})) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'gist.json');
    this.settings = typeof settings === 'function' ? settings : () => ({});
    this.doc = readJson(this.file, null);
    if (!this.doc || typeof this.doc !== 'object') this.doc = { version: GIST_VERSION, chats: {} };
    if (!this.doc.chats || typeof this.doc.chats !== 'object') this.doc.chats = {};
    /** 有未落盘的改动。 */
    this.dirty = false;
    this.lastSaveAt = 0;
  }

  enabled() { return this.settings()?.gistEnabled !== false; }

  /** 按节流落盘（30 秒），force 时立即写。 */
  save({ force = false } = {}) {
    if (!this.dirty) return false;
    const now = Date.now();
    if (!force && now - (this.lastSaveAt || 0) < 30000) return false;
    writeJson(this.file, this.doc);
    this.lastSaveAt = now;
    this.dirty = false;
    return true;
  }

  list(chatKey) {
    const k = String(chatKey);
    if (!Array.isArray(this.doc.chats[k])) this.doc.chats[k] = [];
    return this.doc.chats[k];
  }

  /**
   * 记一条墓碑（幂等：同 id 覆盖，刷新 evictedAt）。
   * @returns {boolean} 是否记下
   */
  remember(chatKey, block, meta = {}) {
    if (!this.enabled()) return false;
    if (!block?.id) return false;
    const k = String(chatKey);
    const list = this.list(k);
    const ids = (block.snippets || [])
      .map((s) => Number(s.localId))
      .filter((n) => Number.isFinite(n) && n > 0);
    // "在场的人"：与 store 的 people 同口径（排除机器人自己）——
    // 墓碑也要参与多线索加权，否则"因为看到老朋友而想起那件事"这条路径
    // 一旦块被淘汰就断了。
    const people = [...new Set(
      (block.snippets || [])
        .filter((s) => !s?.self)
        .map((s) => String(s?.uid || '').trim())
        .filter(Boolean)
    )].slice(0, 24);
    const entry = {
      id: String(block.id),
      kind: String(block.kind || 'hour'),
      dayKey: String(block.dayKey || meta.dayKey || ''),
      hourKey: String(block.hourKey || ''),
      when: Number(block.when) || Number(meta.when) || 0,
      gist: makeGist(block),
      keywords: (Array.isArray(block.keywords) ? block.keywords : [])
        .map(String).filter((t) => t.length >= 2).slice(0, GIST_MAX_KEYWORDS),
      // 在场的人（uid）：多线索检索（编码特异性）在墓碑这一层也要能对上
      people,
      // id 区间 = 重建时要读的消息范围（节省效应的落地）
      minId: ids.length ? Math.min(...ids) : 0,
      maxId: ids.length ? Math.max(...ids) : 0,
      msgCount: Number(block.msgCount) || ids.length || 0,
      // 曾经攒到的记忆强度：复活时还给它，别让"被想起过的老事"复活后从头开始
      score: num(meta.score, 1, 0.05, 3),
      S: num(meta.S, 0, 0, 36500),
      hits: Number(meta.hits) || 0,
      evictedAt: Date.now()
    };
    const at = list.findIndex((g) => g.id === entry.id);
    if (at >= 0) list.splice(at, 1);
    list.push(entry);
    this.#cap(k);
    this.dirty = true;
    return true;
  }

  remove(chatKey, id) {
    const list = this.list(chatKey);
    const at = list.findIndex((g) => g.id === String(id));
    if (at < 0) return false;
    list.splice(at, 1);
    this.dirty = true;
    return true;
  }

  /**
   * 记一次"重建失败"。累计到 `gistReviveMaxTries` 次就标成"救不回来了"，
   * 之后检索命中它时**不再尝试重建**，只给要旨。
   *
   * ── 为什么必须记 ────────────────────────────────────────────────────────
   * 原文被清掉之后，这条墓碑永远重建不出来。不记的话，它每被命中一次，
   * 就要把整个会话文件 `readFileSync` + `JSON.parse` 一遍 ——
   * 在一个活跃群、一个几十 MB 的会话文件上，这等于给每一次检索挂一个同步 IO。
   * 而这条墓碑可能永远躺在那儿（保留期 3 年），于是这个开销会一直付下去。
   *
   * ⚠️ 只有"原文真的没了"才记。体积超过 `gistReviveMaxMb` **不记** ——
   *    那是配置问题，用户把上限调大之后它就又能重建了，不该被永久判死。
   *
   * @returns {number} 记完之后的失败次数
   */
  markReviveFail(chatKey, id) {
    const g = this.list(chatKey).find((x) => x.id === String(id));
    if (!g) return 0;
    g.reviveFails = (Number(g.reviveFails) || 0) + 1;
    if (g.reviveFails >= GIST_REVIVE_MAX_TRIES) g.unrevivable = true;
    this.dirty = true;
    return g.reviveFails;
  }

  /** 超过每会话上限就从最老的开始丢（墓碑也要会忘）。 */
  #cap(chatKey) {
    const max = num(this.settings()?.gistMaxPerChat, 400, 10, 5000);
    const list = this.list(chatKey);
    if (list.length <= max) return 0;
    list.sort((a, b) => Number(a.evictedAt) - Number(b.evictedAt));
    const dropped = list.length - max;
    list.splice(0, dropped);
    this.dirty = true;
    return dropped;
  }

  /** 按保留期清理：墓碑是"最后一点痕迹"，但也终归要没。 */
  sweep({ now = Date.now() } = {}) {
    const days = num(this.settings()?.gistRetainDays, 1095, 7, 36500);
    const cutoff = now - days * 86400000;
    let dropped = 0;
    for (const [k, list] of Object.entries(this.doc.chats)) {
      const keep = list.filter((g) => Number(g.evictedAt) >= cutoff);
      dropped += list.length - keep.length;
      if (keep.length) this.doc.chats[k] = keep;
      else delete this.doc.chats[k];
    }
    if (dropped) this.dirty = true;
    return dropped;
  }

  /**
   * 拿查询去墓碑库里找线索。
   *
   * 打分刻意保持简单（词命中数），因为墓碑的数量级是几百条、
   * 而且它本来就只该在"活块答不上来"时露头 —— 排序精度不是这里的重点。
   *
   * ⚠️⚠️ B2 修复（2026-10-14）：检索打分的命中数必须放在 **matchHits** 里，
   *    绝不能覆盖 `hits`。`hits` 是这块**当年攒下的累计回忆次数**，
   *    reviveBlock 要靠它把记忆强度还给复活出来的块
   *    （`hits: (gist.hits || 0) + 1`）。曾经这里写成 `{...g, hits: 关键词命中数}`，
   *    于是"被想起过 20 次"的块一复活就只剩"关键词命中 5 次 + 1"——
   *    注释承诺的"把当初攒下的记忆强度还给它"对 hits 悄悄没了。
   *    （score / S 不被覆盖，所以排序损失有限；但 hits 是 rollup 继承与
   *    墓碑再存储的输入，且 J4 断言只查下限，抓不到这个。）
   * @returns {object[]} 命中项（含 score / matchHits），已按 matchHits 降序
   */
  search(query, { chatKey = null, limit = 3 } = {}) {
    if (!this.enabled()) return [];
    const tokens = new Set(tokenize(String(query || '')));
    if (!tokens.size) return [];
    const keys = chatKey ? [String(chatKey)] : Object.keys(this.doc.chats);
    const out = [];
    for (const k of keys) {
      for (const g of this.list(k)) {
        let hit = 0;
        // 关键词权重更高：那是写墓碑时特意留下的"索引"
        for (const kw of g.keywords || []) if (tokens.has(kw)) hit += 2;
        for (const t of tokenize(`${g.gist || ''} ${g.gist || ''}`)) if (tokens.has(t)) hit += 1;
        if (!hit) continue;
        out.push({ ...g, chatKey: k, matchHits: hit });
      }
    }
    out.sort((a, b) => (b.matchHits - a.matchHits) || (Number(b.when) - Number(a.when)));
    return out.slice(0, Math.max(1, Number(limit) || 3));
  }

  /** 墓碑数量（状态页用）。 */
  stats() {
    let total = 0;
    for (const list of Object.values(this.doc.chats)) total += list.length;
    return { chats: Object.keys(this.doc.chats).length, gists: total, file: this.file };
  }

  /** 磁盘体积（状态页用；墓碑的意义就在于它一直很小）。 */
  size() {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }
}

export { GIST_MAX_CHARS, GIST_REVIVE_MAX_TRIES, dayKeyOf };
