// 语义卡：从巩固出的块里启发式抽「计划 / 事实」，注入时按关键词匹配。
// 比"群友印象"更像人的长期常识——不调模型，纯本地正则 + 频次。
//
// ── 相对内置 lib/semantic-cards.js 的三处实质改动 ────────────────────────
//   1. **垃圾在写入时就丢掉**。内置版是先写进去、再靠 purgeJunk() 事后清理，
//      而 purgeJunk() 零调用 —— 实测它自己那 7 张卡里有 2 张按它自己的规则
//      就该删。本插件没有"事后清理"这一步：抽不出干净标题的句子直接不进库。
//   2. **匹配默认按会话隔离**。内置版在 arch.js 里传的是 chatKey: null，
//      于是 A 群抽到的卡会注入到 B 群 —— 多个互不相识的群共用一个机器人时
//      这是实打实的串味。本插件默认 scope='chat'，想要跨群通用得显式打开。
//   3. **有淘汰**。卡片带 lastHitAt；长期没被任何一次注入命中的卡会被 sweep()
//      清掉。内置版只在超过 400 张时按 lastTs 截断，噪声卡只要够新就永远在。
import path from 'node:path';
import { ensureDir, readJson, writeJson, dayKeyOf, num, normText, tokenize } from './util.js';

/** 抽卡用的两套锚点。故意收得紧：宁可少抽，不要噪声。 */
const PLAN_RE = /(明天|后天|下周|周末|约好|说好|定了|要去|要来|一起吃|聚餐|考试|比赛|生日|开黑|上线|发布会|截止|报名)/;
const FACT_RE = /(记住这点|记得我|我是.{0,6}(学生|打工|程序员)|我喜欢.{0,12}|别骂我|雷点是|口头禅|我住在|我叫)/;

/** 写入时的垃圾判据（与内置 purgeJunk 同口径，但用在写之前）。 */
const JUNK_PREFIX_RE = /^(哈哈|草|乐|典|6+|嗯|哦|啊哈|诶嘿|我在的|慢慢来|慢慢聊|旁边看着)/;
const MEDIA_RE = /\[(图片|表情|贴图|语音|视频)\]|【图片|【表情/;

const MIN_TITLE = 8;
const MAX_TITLE = 80;

export class Cards {
  /**
   * @param {string} root 数据根（<DATA_DIR>/memory-v3）
   * @param {() => object} settings
   */
  constructor(root, settings) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'cards.json');
    this.settings = settings;
    ensureDir(this.root);
    const raw = readJson(this.file, null);
    this.cards = Array.isArray(raw?.cards) ? raw.cards : [];
  }

  #save() {
    // ⚠️ 这里必须用 num() 而不是 clamp()：clamp(undefined, 20, 2000) 返回 **20**，
    //    于是"没配置 maxCards"被理解成"最多 20 张卡"，卡片库悄悄被截到 20 张。
    const max = num(this.settings().maxCards, 500, 20, 5000);
    if (this.cards.length > max) {
      this.cards.sort((a, b) => (Number(b.lastTs) || 0) - (Number(a.lastTs) || 0));
      this.cards = this.cards.slice(0, max);
    }
    writeJson(this.file, { version: 1, cards: this.cards });
  }

  /**
   * 这句够不够格当一张卡？
   * 这是本模块与内置版最大的分歧点：**在这里拦住，而不是事后清理**。
   * @returns {'plan'|'fact'|null}
   */
  static classify(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length < MIN_TITLE || t.length > 140) return null;
    if (MEDIA_RE.test(t)) return null;
    if (JUNK_PREFIX_RE.test(t)) return null;
    // 连环感叹 / 连环问：情绪不是记忆
    if ((t.match(/[?？！!]/g) || []).length >= 2) return null;
    if (PLAN_RE.test(t)) return 'plan';
    if (FACT_RE.test(t)) return 'fact';
    return null;
  }

  #key(type, chatKey, title) {
    return `${type}|${chatKey}|${normText(title).slice(0, 60)}`;
  }

  /**
   * 从巩固出的块碎片里抽卡。
   * @param {string} chatKey
   * @param {{text?: string, who?: string, self?: boolean, ts?: number}[]} snippets
   * @returns {number} 新增/更新了几张
   */
  ingest(chatKey, snippets = []) {
    if (this.settings().semanticCards === false) return 0;
    if (!Array.isArray(snippets) || !snippets.length) return 0;
    const key = String(chatKey || '');
    if (!key) return 0;

    let n = 0;
    // 同一批里重复的句子只算一次：调用方（巩固）在增量合并时可能把同一段
    // 碎片反复喂进来，不去重的话同一张卡的 hits 会虚高，排序随之失真。
    const seen = new Set();
    for (const s of snippets) {
      const text = String(s?.text || '').replace(/\s+/g, ' ').trim();
      const type = Cards.classify(text);
      if (!type) continue;
      const who = s?.self ? '我' : String(s?.who || '');
      const title = text.slice(0, MAX_TITLE);
      const k = this.#key(type, key, title);
      if (seen.has(k)) continue;
      seen.add(k);
      const existing = this.cards.find((c) => c.key === k);
      const ts = Number(s?.ts) || Date.now();
      if (existing) {
        existing.hits = (Number(existing.hits) || 1) + 1;
        existing.lastTs = Math.max(Number(existing.lastTs) || 0, ts);
        n += 1;
        continue;
      }
      this.cards.unshift({
        key: k,
        type,
        chatKey: key,
        title,
        detail: `${who}: ${text.slice(0, 100)}`,
        hits: 1,
        lastTs: ts,
        lastHitAt: 0,
        source: 'local'
      });
      n += 1;
    }
    if (n) this.#save();
    return n;
  }

  /**
   * 按触发文本匹配。
   *
   * ⚠️ 用 tokenize 的 **bigram** 匹配，不是"整段汉字当一个词"。
   *    内置版用的是 `q.match(/[一-鿿]{2,}/g)` —— 对「下周一起去吃火锅」这种
   *    没有空格的中文，整句会被当成**一个** token 去 includes，于是
   *    「说好了下周末一起去吃火锅」这种带插字的卡根本匹配不上（差一个「末」就废了）。
   *    换成 bigram 之后，「下周/一起/吃火/火锅」四个片各自命中，稳得多。
   *
   * @param {string} query
   * @param {{chatKey?: string|null, scope?: 'chat'|'global', limit?: number}} opts
   */
  match(query, { chatKey = null, scope = null, limit = 2 } = {}) {
    const q = normText(query);
    if (!q) return [];
    // 默认按会话隔离；要跨群通用得显式开 cardsCrossChat（或调用方直接传 scope）
    const effScope = scope || (this.settings().cardsCrossChat === true ? 'global' : 'chat');
    // 只用 2 字及以上的片：单字太吵（「的」「了」），会带来大量假命中
    const words = [...new Set(tokenize(q))].filter((t) => t.length >= 2);
    if (!words.length) return [];

    // ⚠️ 门槛必须随查询长度自适应。写死 `hit < 2` 的后果是：
    //    「火锅」这种两字查询只能切出**一片**，命中数最多 1，于是永远 0 结果 ——
    //    而中文里两字问法（火锅/婚礼/显卡）恰恰是最常见的一类。
    const needHit = Math.min(2, words.length);
    const needRatio = words.length <= 2 ? 0.5 : 0.25;

    const scored = [];
    const now = Date.now();
    for (const c of this.cards) {
      // ⚠️ 会话隔离：这是与内置版最重要的差别（内置版恒为 null → 跨群串味）
      if (effScope === 'chat' && chatKey && String(c.chatKey) !== String(chatKey)) continue;
      const hay = normText(`${c.title} ${c.detail}`);
      let hit = 0;
      for (const w of words) if (hay.includes(w)) hit += 1;
      if (hit < needHit) continue;
      const ratio = hit / words.length;
      if (ratio < needRatio) continue;
      let score = hit * 3 + ratio * 6;
      if (hay.includes(q.slice(0, 12))) score += 4;
      // 新鲜度 + 被命中次数：常被想起的卡更牢
      const ageH = Math.max(1, (now - (Number(c.lastTs) || 0)) / 3600000);
      score += Math.min(3, (Number(c.hits) || 1) / 2) / Math.log2(ageH + 1);
      scored.push({ score, card: c });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, Math.max(1, Number(limit) || 2));
    // 命中反馈：被拿出来用过的卡标记一下，sweep 时不会被当僵尸清掉
    for (const { card } of picked) card.lastHitAt = now;
    if (picked.length) this.#save();
    return picked.map(({ card, score }) => ({
      type: card.type,
      title: card.title,
      detail: card.detail,
      when: dayKeyOf(card.lastTs),
      score: Math.round(score * 10) / 10,
      chatKey: card.chatKey
    }));
  }

  /** 渲染成一行（给提示词）。 */
  render(query, opts = {}) {
    if (this.settings().semanticCards === false) return '';
    const hits = this.match(query, opts);
    if (!hits.length) return '';
    const lines = hits.map((h) => `- [${h.type === 'plan' ? '计划' : '事实'}] ${h.title}`);
    return `【语义卡】${lines.join('；')}（当常识用，别念时间戳）`;
  }

  /**
   * 淘汰：长期没被命中的卡直接删。
   * 内置版没有这一步 —— 噪声卡只要够新就一直留在库里，直到凑满 400 张。
   */
  sweep() {
    // ⚠️ 这里同样不能用 clamp()：clamp(undefined, 1, 3650) 返回 **1**，
    //    于是"没配置 cardIdleDays"被理解成"卡片闲置一天就删" ——
    //    而卡片只在有聊天时才被重新抽到/命中，等于隔一天就清空整个卡片库，
    //    语义卡功能看着是开着的，实际上一张都留不下。
    const maxIdleDays = num(this.settings().cardIdleDays, 90, 1, 3650);
    const cutoff = Date.now() - maxIdleDays * 86400000;
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => {
      const last = Math.max(Number(c.lastHitAt) || 0, Number(c.lastTs) || 0);
      return last >= cutoff;
    });
    const removed = before - this.cards.length;
    if (removed) this.#save();
    return removed;
  }

  stats() {
    const byType = {};
    for (const c of this.cards) byType[c.type] = (byType[c.type] || 0) + 1;
    return { cards: this.cards.length, byType };
  }
}
