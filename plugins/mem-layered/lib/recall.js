// 检索：BM25 风格打分 + 时间偏好 + 命中反馈 + 多线索（在场的人）+ 梗概墓碑。
//
// ── 为什么是 BM25 而不是内置版的"权重 × (1+log tf)" ──────────────────────
// 内置版的打分里没有 idf：出现在 13/14 个块里的"不""还""大"和只出现在 1 个块里的
// 人名，单位权重是一样的。实测它的索引里 3951/5021 个词只出现在一个块里 ——
// 也就是说真正有区分度的词被高频噪声稀释了。这里补上 idf（df 越大权重越低），
// 高频词自然沉底，不需要再靠"剪枝"硬砍。
//
// ── 时间偏好为什么放在这里 ───────────────────────────────────────────────
// "昨天那事"这种问法在字面检索里本来是无解的，但"昨天/前天/中午/晚上"是
// **可以确定性解析**的少数语义。解析出来给命中块加权，等于白捡一点准确率，
// 且零成本（本地字符串判断，不调模型、不花 token）。
//
// ── 多线索检索（编码特异性）为什么放在这里 ───────────────────────────────
// 认知心理学的**编码特异性原理（encoding specificity）**：提取时的线索与编码时的
// 线索越接近，越容易想起来。人回忆旧事时，"当时谁在场"往往比"当时聊了啥词"更有效
// —— 你会因为看到老朋友而想起十年前那件事，而不是因为想到了那句话。
// 工程上的对应：块里"在场的人"（uid 集合）与触发消息里"在场的人"有交集 → 加权。
// ⚠️ 只对**别人**算（见 store 的 people 派生），机器人自己不算 ——
//    否则每个块都含机器人发言，加权等于没加。
//
// ── 梗概墓碑为什么也在这里排序 ───────────────────────────────────────────
// 活块答不上来时，"我好像记得有这么回事"也该露头（见 lib/gist.js）。
// 墓碑作为**低权重候选**参与同一轮排序：权重默认乘 0.35，所以活块匹配得一样好时
// 永远排在前面；只有活块都答不上来，墓碑才浮上来。命中后再按 id 区间从
// `messages/` 重建整块（节省效应）——能重建就给全文，重建不了就只给一句要旨。
import { parseTimeHint, tokenize, queryTokens, formatWhen, timeOfDayOf, num } from './util.js';

const K1 = 1.2;
const FUZZY_SCAN_MAX = 4000;
const GLOBAL_SHARD_MAX = 40;
/** 共激活联想（v1.7.0）：只有本轮 top 几个命中算"被点燃的火星"，往邻居扩散。 */
const LINK_SPREAD_TOP = 5;
/** 共激活联想（v1.7.0）：链接计数折算成激活度的分母（计数 6 记满）。 */
const LINK_SPREAD_FULL = 6;
/** 共激活联想（v1.7.0）：一次检索最多从链接里"带出"几个字面零匹配的块。 */
const LINK_SEED_MAX = 3;

export class Recall {
  /**
   * @param {object} deps
   * @param {import('./store.js').LayeredStore} deps.store
   * @param {() => object} [deps.settings]
   * @param {{bump?: Function}} [deps.stats]
   * @param {(q: string, o: object) => object[]} [deps.gistSearch]
   *   即席查梗概墓碑（lib/gist.js 的 search）。**用函数注入而不是直接依赖 GistStore**：
   *   GistStore 依赖 store，Recall 依赖 store —— 再互相 import 就成环了。
   *   没注入时一律当成"没有墓碑"，功能自动退化。
   * @param {(chatKey: string, gist: object) => string|null} [deps.revive]
   *   复活一个墓碑（consolidator.reviveBlock）。没注入时只给要旨、不重建。
   */
  constructor({ store, settings = () => ({}), stats = null, gistSearch = null, revive = null }) {
    this.store = store;
    this.settings = settings;
    this.stats = stats;
    this.gistSearch = typeof gistSearch === 'function' ? gistSearch : null;
    this.revive = typeof revive === 'function' ? revive : null;
  }

  /**
   * @param {string} query
   * @param {{chatKey?: string|null, limit?: number, maxSnippets?: number,
   *          dayFrom?: string, dayTo?: string, personIds?: string[],
   *          feedback?: boolean|'off'|'passive'|'full'}} opts
   *   personIds 触发消息里"在场的人"的 uid 列表（多线索加权用；只算别人）。
   *   tod 当前时段（'早'/'午'/'下午'/'晚'/'夜'，v1.7.0 编码特异性·时段用）。
   *       与问句里显式提到"晚上"是两回事：那边是查询线索，这边是无声的提取情境。
   *   feedback 三态（默认 'full'，与旧的 true 等价）：
   *     · 'full'    真的"回忆"了（模型主动调检索工具）→ 按间隔加分 + 增长稳定性
   *     · 'passive' 只是被动看到（每轮自动注入）→ 只记 passiveHits，权重/锚点全不动
   *     · 'off' / false  纯查询，**一个字节都不写**
   *   ⚠️ 自动注入那条路径必须传 'off'（见 recallForPrompt）：
   *      它每轮都会跑一次，如果按 'full' 计权，就形成
   *      "越常被注入 → 权重越高 → 越容易被注入"的正反馈环，
   *      最后提示词里永远只飘着最早那几条旧事。被动计权另行处理（见 inject.js）。
   * @returns {object[]} 与内置版字段一致的结果（宿主自带技能可直接消费）
   */
  search(query, {
    chatKey = null, limit = 5, maxSnippets = 5,
    dayFrom = null, dayTo = null, feedback = 'full', personIds = [], tod = ''
  } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const t0 = Date.now();
    const hint = parseTimeHint(q);
    const weights = queryTokens(q);
    if (!weights.size) return [];

    // ── 多线索：触发消息里在场的人（uid 集合）──
    const people = new Set(
      (Array.isArray(personIds) ? personIds : []).map((x) => String(x)).filter(Boolean)
    );
    const peopleBoost = num(this.settings()?.peopleBoost, 1.3, 1, 3);
    // 时段情境（v1.7.0）：与"在场的人"同源的编码特异性，只是线索换成"现在几点"。
    const todBoost = num(this.settings()?.todBoost, 1.1, 1, 2);

    const shardKeys = chatKey
      ? [String(chatKey)]
      : this.store.activeChatKeys(GLOBAL_SHARD_MAX);

    /** @type {Map<string, {chatKey: string, blockId: string, score: number}>} */
    const scores = new Map();
    let fuzzyBudget = FUZZY_SCAN_MAX;

    for (const key of shardKeys) {
      const index = this.store.index(key);
      const N = Math.max(1, index.n);
      if (!N) continue;

      const applyToken = (tok, w) => {
        const list = index.postings[tok];
        if (!list || !list.length) return;
        const df = list.length;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        for (const [blockId, tf] of list) {
          const meta = index.blocks[blockId];
          if (!meta) continue;
          if (dayFrom && String(meta.dayKey) < String(dayFrom)) continue;
          if (dayTo && String(meta.dayKey) > String(dayTo)) continue;
          const tfFactor = (tf * (K1 + 1)) / (tf + K1);
          const add = w * idf * tfFactor * this.store.effectiveScore(meta);
          const mapKey = `${key}\u0000${blockId}`;
          const cur = scores.get(mapKey);
          if (cur) cur.score += add;
          else scores.set(mapKey, { chatKey: key, blockId, score: add });
        }
      };

      for (const [tok, w] of weights) {
        if (index.postings[tok]) {
          applyToken(tok, w);
          continue;
        }
        // 未命中 → 子串回退（"吃火锅" 命中 "火锅店"）。只对 2~6 字的词做，
        // 且总量封顶：不然长问句会退化成对整个词表的线性扫描。
        if (tok.length < 2 || tok.length > 6 || fuzzyBudget <= 0) continue;
        for (const cand of Object.keys(index.postings)) {
          if (fuzzyBudget <= 0) break;
          fuzzyBudget -= 1;
          if (cand.length < 2) continue;
          if (cand.includes(tok) || tok.includes(cand)) applyToken(cand, w * 0.55);
        }
      }
    }

    const now = Date.now();
    let ranked = [...scores.values()]
      .map((row) => {
        const meta = this.store.blockMeta(row.chatKey, row.blockId) || {};
        const ageDays = Math.max(0, (now - (Number(meta.when) || now)) / 86400000);
        let s = row.score * (0.85 + 0.15 * (1 / (1 + ageDays / 60)));
        if (hint.preferDay && meta.dayKey) {
          if (String(meta.dayKey) === String(hint.preferDay)) s *= 1.8;
          else if (String(meta.dayKey) > String(hint.preferDay)) s *= 0.4;
        }
        if (hint.preferTod && meta.timeOfDay) {
          if (meta.timeOfDay === hint.preferTod) s *= 1.6;
          else if ((hint.preferTod === '午' && meta.timeOfDay === '下午')
            || (hint.preferTod === '晚' && meta.timeOfDay === '夜')) s *= 1.15;
        }
        // 编码特异性：触发消息里在场的人，和块里在场的人有交集 → 加权。
        if (people.size && peopleBoost > 1 && Array.isArray(meta.people) && meta.people.length) {
          for (const u of meta.people) {
            if (people.has(String(u))) { s *= peopleBoost; break; }
          }
        }
        // 编码特异性·时段（v1.7.0）：同一时段发生的事，在当下这个时段更容易被提取。
        // 与上面的 preferTod 是两回事：那边是问句里显式提到的线索，这边是无声的提取情境。
        if (tod && todBoost > 1 && meta.timeOfDay && meta.timeOfDay === tod) s *= todBoost;
        return { ...row, score: s, when: Number(meta.when) || 0 };
      })
      .sort((a, b) => b.score - a.score);

    // ── 共激活联想（v1.7.0，spreading activation）────────────────────────────
    // ACT-R 的激活扩散：本轮 top 几个命中是"已经被点燃的火星"，与它们一起被想起过的
    // 邻居会借到一点光。工程约束：
    //   · 只算**同会话**的链接（links 存在各自的索引分片里，跨会话没有结缘）；
    //   · 只**加分**不替换 —— 相关性永远是主排序，联想只是让"当时一起想到的事"
    //     不容易被埋掉（它可能字面不相关，却是最自然的后续线索）；
    //   · 强度按链接计数封顶（LINK_SPREAD_FULL 记满），老交情压不过当轮相关性。
    const linkBoost = num(this.settings()?.linkBoost, 0.15, 0, 1);
    // ⚠️ 门是 ranked.length > 0 而不是 > 1：只有**一个**命中的时候，
    //    恰恰最需要链接把"当时一起想到的另一件"带出来（字面零匹配的邻居）。
    if (linkBoost > 0 && ranked.length > 0) {
      const byChat = new Map();
      for (const r of ranked) {
        if (!byChat.has(r.chatKey)) byChat.set(r.chatKey, []);
        byChat.get(r.chatKey).push(r);
      }
      for (const rows of byChat.values()) {
        if (!rows.length) continue;
        const lit = new Set(rows.slice(0, LINK_SPREAD_TOP).map((r) => r.blockId));
        const present = new Set(rows.map((r) => r.blockId));
        // ① 已候选块的加分（只有一个候选时没有可加分的对象，跳过）
        if (rows.length > 1) {
          for (const r of rows) {
            if (lit.has(r.blockId)) continue;
            const links = this.store.blockMeta(r.chatKey, r.blockId)?.links || {};
            let act = 0;
            for (const id of lit) act += Number(links[id]) || 0;
            if (act > 0) r.score *= 1 + linkBoost * Math.min(1, act / LINK_SPREAD_FULL);
          }
        }
        // ② 字面零匹配的结缘块，作为"火星"被带出来（fan-out）
        //    —— 只加分不带出的话，联想对"换了关键词的同一件事"毫无用处，
        //    而那正是联想在人身上最有用的样子。
        //    种子分只借 top 命中的一小块（0.12 × 激活度），且总数封顶，
        //    所以它永远排不到真命中前面，自动注入的相关度早停也会滤掉它。
        const seeded = [];
        for (const r of rows) {
          if (!lit.has(r.blockId)) continue;
          const links = this.store.blockMeta(r.chatKey, r.blockId)?.links || {};
          for (const [nid, cnt] of Object.entries(links)) {
            if (present.has(nid)) continue;
            present.add(nid);
            const meta = this.store.blockMeta(r.chatKey, nid);
            if (!meta) continue;
            seeded.push({
              chatKey: r.chatKey,
              blockId: nid,
              score: r.score * 0.12 * Math.min(1, (Number(cnt) || 0) / LINK_SPREAD_FULL),
              when: Number(meta.when) || 0
            });
            if (seeded.length >= LINK_SEED_MAX) break;
          }
          if (seeded.length >= LINK_SEED_MAX) break;
        }
        if (seeded.length) ranked.push(...seeded);
      }
      ranked.sort((a, b) => b.score - a.score);
    }

    // ── 梗概墓碑候选：只在"活块答不上来"时露头 ─────────────────────────────
    const gistRows = [];
    if (this.gistSearch) {
      try {
        const gw = num(this.settings()?.gistWeight, 0.35, 0.05, 1);
        for (const g of this.gistSearch(q, { chatKey, limit: 4 })) {
          // ⚠️ 排序用 **matchHits**（本次检索的关键词命中数），不是 g.hits ——
          //    后者是这块当年攒下的累计回忆次数，归 reviveBlock 继承用（见 gist.js B2 注释）。
          let s = (Number(g.matchHits) || 1) * gw;
          if (people.size && peopleBoost > 1 && Array.isArray(g.people) && g.people.length) {
            for (const u of g.people) {
              if (people.has(String(u))) { s *= peopleBoost; break; }
            }
          }
          gistRows.push({
            chatKey: g.chatKey,
            blockId: `gist:${g.id}`,
            score: s,
            when: Number(g.when) || 0,
            gistOnly: true,
            gist: g
          });
        }
      } catch { /* 墓碑查询失败只是少一类候选，绝不影响活块检索 */ }
    }

    const top = Math.max(1, Math.min(12, Number(limit) || 5));
    const sorted = [...ranked, ...gistRows].sort((a, b) => b.score - a.score);
    // ── 结果多样性（干扰理论）────────────────────────────────────────────
    // 人的记忆里，**相似的记忆会互相干扰**：想起一件就会压住另一件。
    // 工程上不处理的话，top-N 常常是相邻小时的同一段对话 ——
    // 看着像"想起两件事"，其实是一件，白占名额还让注入显得重复。
    const lambda = num(this.settings()?.diversityLambda, 0.3, 0, 1);
    const merged = lambda > 0 ? this.#diversify(sorted, lambda, top) : sorted.slice(0, top);

    // feedback 归一化：true → 'full'；false → 'off'；其余取字面值（不认识的按 'off'）
    const fb = feedback === true ? 'full'
      : feedback === false ? 'off'
        : (feedback === 'full' || feedback === 'passive' ? feedback : 'off');

    const hits = [];
    let healed = 0;
    for (const row of merged) {
      if (row.gistOnly) {
        const h = this.#hitGist(row, { query: q, maxSnippets, fb });
        if (h) hits.push(h);
        continue;
      }
      const hit = this.store.buildHit(row.chatKey, row.blockId, row.score, { query: q, maxSnippets });
      if (!hit) {
        // 索引里有、但块文件没了（手动删过 / 磁盘出错）→ 懒自愈摘掉它。
        // 不修的话它会长期占着一个 top-N 名额，每次命中都白跑一趟。
        if (this.store.dropDangling(row.chatKey, row.blockId)) healed += 1;
        continue;
      }
      hits.push(hit);
      // 命中反馈：常被想起来的块权重上调，长期没人问的自然衰减（见 store.effectiveScore）
      // 'off' 时**根本不调用** —— 不能靠 markHit 内部判断，那会白建索引对象。
      if (fb !== 'off') {
        // 共激活结缘（v1.7.0）：这一轮**一起**被想起的块，互相成为提取线索。
        // ⚠️ 只有 full（模型主动检索）才结缘：被动注入是"被看到"，不是"一起想到"。
        const peers = fb === 'full'
          ? merged.filter((x) => !x.gistOnly && x.chatKey === row.chatKey && x.blockId !== row.blockId)
            .map((x) => x.blockId)
          : [];
        this.store.markHit(row.chatKey, row.blockId, { mode: fb, withIds: peers });
      }
    }
    if (healed) {
      this.store.saveState({ force: false });
      if (this.stats?.bump) this.stats.bump({ selfHealed: healed });
    }

    if (this.stats?.bump) {
      this.stats.bump({
        searches: 1,
        hitSearches: hits.length ? 1 : 0,
        misses: hits.length ? 0 : 1,
        lastQuery: q.slice(0, 60),
        lastDurationMs: Date.now() - t0
      });
    }
    return hits;
  }

  /**
   * 贪心 MMR：依次挑「相关度高 **且** 与已选块内容重叠低」的块。
   *
   * `score = (1-λ) × 归一化相关度 − λ × 与已选块的最大重叠度`
   *   · λ = 0 → 退化成原来的"纯按分数取前 N"（严格推广，不会变差）
   *   · λ 越大 → 越强调"别给我同一件事的第二面"
   *
   * 重叠度是 **IDF 加权 Jaccard**，读索引元数据里的 `kw` 指纹 + `postings` 的词频，
   * **不读块文件** —— 为了算相似度给每次命中挂一次 IO 不划算。
   *
   * ⚠️ 为什么必须 IDF 加权：纯 Jaccard 会被"两个块都含『讨论』『事情』『相关』这类
   *    通用词"误导成高度重叠，于是**真正不同的两件事也被判成同一件**，MMR 就白做了。
   *    （实测：聊火锅和聊显卡的两个块，纯 Jaccard 算出 0.67 —— 因为 5 个关键词里
   *    4 个是通用的。加权后降到 0.06。只有"共享一个**罕见**话题词"才算真重叠。）
   *
   * @param {object[]} rows 已按分数降序的候选（活块 + 墓碑）
   * @param {number} lambda
   * @param {number} top 取几条
   */
  #diversify(rows, lambda, top) {
    if (rows.length <= top) return rows.slice(0, top);
    const maxScore = Math.max(...rows.map((r) => Number(r.score) || 0)) || 1;
    /** 块指纹：token → 罕见度权重（df 越大越不算数）。取不到 → 空表 → 不惩罚。 */
    const sigOf = (r) => {
      const arr = r.gistOnly
        ? (r.gist?.keywords || [])
        : (this.store.blockMeta(r.chatKey, r.blockId)?.kw || []);
      const postings = this.store.index(r.chatKey)?.postings || {};
      const w = new Map();
      for (const raw of arr) {
        const t = String(raw);
        if (!t) continue;
        const df = postings[t] ? postings[t].length : 0;
        w.set(t, 1 / (1 + Math.log(1 + df)));   // df=1 → 0.59；df=5 → 0.36；df=50 → 0.20
      }
      return w;
    };
    /** 加权 Jaccard：交集权重 / 并集权重 */
    const simOf = (a, b) => {
      if (!a.size || !b.size) return 0;
      let inter = 0;
      let uni = 0;
      const toks = new Set([...a.keys(), ...b.keys()]);
      for (const t of toks) {
        const wa = a.get(t) || 0;
        const wb = b.get(t) || 0;
        const wt = (wa + wb) / 2;
        if (wa > 0 && wb > 0) inter += wt;
        uni += wt;
      }
      return uni > 0 ? inter / uni : 0;
    };
    const chosen = [];
    const rest = [...rows];
    const chosenSig = [];
    while (chosen.length < top && rest.length) {
      let bestAt = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < rest.length; i += 1) {
        const r = rest[i];
        const rel = (Number(r.score) || 0) / maxScore;
        let maxSim = 0;
        if (chosenSig.length) {
          const a = sigOf(r);
          for (const b of chosenSig) maxSim = Math.max(maxSim, simOf(a, b));
        }
        const val = (1 - lambda) * rel - lambda * maxSim;
        if (val > bestVal) { bestVal = val; bestAt = i; }
      }
      chosen.push(rest[bestAt]);
      chosenSig.push(sigOf(rest[bestAt]));
      rest.splice(bestAt, 1);
    }
    return chosen;
  }

  /**
   * 命中一条墓碑：先试复活（节省效应），不行就只给要旨。
   *
   * ── 为什么复活放在检索里、而不是"让调用方自己去查" ──────────────────────
   * 因为复活的触发条件就是"检索命中了墓碑"。分开做的话，每个调用方都要自己记得
   * 检查 `gistOnly` 再调 reviveBlock —— 迟早有一处忘了写。
   *
   * ⚠️ 复活会写盘（写块 + 写索引），所以它是**有副作用的检索**。
   *    这是刻意的：一次成功的提取本来就会改变记忆痕迹（测试效应）。
   *    而且墓碑命中一次就被摘掉，不会每轮都复活。
   * @returns {object|null} 与 buildHit 同形状的命中项
   */
  #hitGist(row, { query, maxSnippets, fb }) {
    const g = row.gist || {};
    // ⚠️ 救不回来的墓碑别再试了。原文被清掉之后它永远重建不出来，
    //    每命中一次就要把整个会话文件同步读一遍 —— 这个开销会一直付到墓碑过期。
    //    （`unrevivable` 由 markReviveFail 累计 3 次后置上，与"失败未满 3 次"
    //     等价 —— 所以这里只查这一个flag就够，不需要额外的 canRevive。）
    if (this.revive && !g.unrevivable) {
      let revivedId = null;
      try { revivedId = this.revive(row.chatKey, g); } catch { revivedId = null; }
      if (revivedId) {
        const hit = this.store.buildHit(row.chatKey, revivedId, row.score, { query, maxSnippets });
        if (hit) {
          // 复活 = 一次成功的回忆 → 按正常命中计权（除非调用方要求 off）
          if (fb !== 'off') this.store.markHit(row.chatKey, revivedId, { mode: fb });
          if (this.stats?.bump) this.stats.bump({ gistRevived: 1 });
          return { ...hit, revivedFromGist: true };
        }
      }
    }
    // 重建不了（会话文件太大 / 原文已不在）→ 退化成"只给要旨"。
    // 这一条仍然有价值：模型能知道"有这么回事"，并据此决定要不要翻归档。
    // ⚠️ hits 用**累计回忆次数**（g.hits，B2 修复后不再被检索打分覆盖）——
    //    与 buildHit 的字段同义："这块当年被想起过几次"，而不是"这次检索命中几片"。
    const when = Number(g.when) || 0;
    return {
      chunkId: row.blockId,                 // 前缀 gist:，调用方可据此识别
      chatKey: row.chatKey,
      dayKey: String(g.dayKey || ''),
      hourKey: String(g.hourKey || ''),
      kind: String(g.kind || 'gist'),
      title: `${String(g.dayKey || '')}（只剩梗概）`,
      when: formatWhen(when),
      score: Math.round((Number(row.score) || 0) * 100) / 100,
      hits: Number(g.hits) || 0,
      summary: String(g.gist || ''),
      gistOnly: true,
      snippets: [{
        when: formatWhen(when).slice(5, 16),
        ts: when,
        who: '',
        self: false,
        text: String(g.gist || '')
      }].slice(0, Math.max(1, Number(maxSnippets) || 1))
    };
  }

  /**
   * 只取"最相关的一两条碎片"，给每轮自动注入用（省 token）。
   *
   * ⚠️ 这里**必须** feedback:'off'。自动注入每轮都跑，一旦计权就是正反馈环：
   *    "越常被注入 → 权重越高 → 越容易被注入"。被动"看到过"的计数由调用方
   *    在**确认注入成功之后**单独记（mode:'passive'），与检索计权分开。
   *
   * ⚠️ 这一步比 search() 更省 token 的两个取舍，都**只作用于自动注入**：
   *    · 相关度早停：归一化相关度低于最高项 `autoRecallMinRel` 的候选直接丢掉。
   *      低分块对模型回答的贡献极小，却实打实吃掉一行 90 字符。
   *    · 模型主动调 `memory.search` 时**不**做这个裁剪（宁多勿少）——
   *      那是它明确要"翻一下"，跟被动塞给它是两回事。
   *    minRel 不传时从 settings 读 `autoRecallMinRel`（默认 0.25），
   *    所以设置项不会空转；显式传 0 即临时关闭。
   *
   * ⚠️ lines 里要带**原始 ts**：调用方（inject.js）需要它来格式化时间。
   *    只传已经格式化过的 when 字符串，调用方再 formatWhen 一次会解析失败、
   *    悄悄退回"当前时间" —— 于是自动注入的旧事永远显示成"刚刚发生"。
   *    mid / localId 同理：碎片级跨轮去重靠它（见 inject.js）。
   */
  recallForPrompt(query, { chatKey, maxBlocks = 2, maxLines = 2, personIds = [], minRel = null } = {}) {
    const hits = this.search(query, {
      chatKey, limit: maxBlocks, maxSnippets: maxLines, feedback: 'off', personIds,
      // 编码特异性·时段：自动注入发生在"当下"，提取情境就是现在几点（v1.7.0）
      tod: timeOfDayOf(Date.now())
    });
    // ── 相关度早停 ────────────────────────────────────────────────────────
    // 归一化基准是"本轮最相关的那个块"而不是一个绝对分数：不同查询的绝对分
    // 数量级差很多，绝对阈值无法跨查询复用。
    // 不传 minRel 时从 settings 读 —— 否则插件面板上那个滑块就是个空转开关。
    const rel = num(
      minRel === null ? this.settings()?.autoRecallMinRel : minRel,
      0, 0, 0.95
    );
    const best = hits.length ? Math.max(...hits.map((h) => Number(h.score) || 0)) : 0;
    const kept = rel > 0 && best > 0 ? hits.filter((h) => (Number(h.score) || 0) >= best * rel) : hits;
    if (kept.length !== hits.length && this.stats?.bump) {
      this.stats.bump({ skippedLowScore: hits.length - kept.length });
    }
    return kept.map((h) => ({
      chunkId: h.chunkId,
      chatKey: h.chatKey,
      dayKey: h.dayKey,
      // ⚠️ C3 修复（2026-10-14）：不能写 formatWhen(h.snippets?.[0]?.ts || h.when) ——
      //    h.when 已经是 "YYYY-MM-DD HH:MM" **字符串**，Number() 出来是 NaN，
      //    formatWhen 对 NaN 会悄悄回落 Date.now()，于是"旧事"显示成"刚刚发生"。
      //    这正是 inject.js 里钉住过的同一个坑，只是换了个文件。
      //    ts 拿不到时（老数据 / 梗概）就直接用原字符串，别再过一遍格式化。
      when: (h.snippets?.[0]?.ts ? formatWhen(h.snippets[0].ts) : String(h.when || '')),
      gistOnly: !!h.gistOnly,
      revived: !!h.revivedFromGist,
      lines: (h.snippets || []).slice(0, maxLines).map((s) => ({
        ts: Number(s.ts) || 0,
        when: s.when,
        who: s.self ? '我' : s.who,
        mid: s.mid ?? null,
        localId: s.localId ?? null,
        // 只有梗概时标一句，让模型知道"这不是原话，是印象" —— 免得它当逐字引述用
        text: h.gistOnly ? `（只记得大概）${s.text}` : s.text
      }))
    }));
  }
}
