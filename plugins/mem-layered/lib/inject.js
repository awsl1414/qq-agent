// 每轮注入：把"本轮触发消息"当查询，自动检索一次长时记忆，命中才注入。
//
// ── 为什么这是本插件最值得做的一件事 ────────────────────────────────────
// 内置版把"回忆旧事"完全交给模型主动调用检索工具。但它自己的注释里就承认过
// 「模型日常几乎不主动调 memory_append」——同类工具（memory_search）的调用率
// 只会更低。于是长时库建得很漂亮，实际使用率接近零。
//
// 这里改成：**每轮确定性检索一次**（本地 CPU，不花钱），命中且相关才注入一小段。
// 模型不需要"想起来要查"，它只是发现提示词里多了一行旧事。
//
// ── 为什么不会把提示词撑爆 ───────────────────────────────────────────────
//   · 预算硬上限（默认 220 字符），超了就从后往前砍
//   · 触发文本太短（"哈哈""在吗"）直接不检索
//   · 同一个块在冷却期内不重复注入（避免连续几轮复读同一件旧事）
//   · 注入位置在**最后一条 user 消息的末尾**（见 index.js），不碰 system 前缀
// ⚠️ num 也必须导入：下面「用户钉死行宽」的分支（recallRowWidth > 0）用它取值。
//    曾经这里只 import 了 formatWhen —— 用户一把行宽调成非 0，每轮注入就
//    ReferenceError，再被 buildInject 的 try/catch 吞掉，表现为「自动回忆
//    静默消失、不报错」。是 tools/bench-tokens.mjs 的「三件套全关」配置
//    （recallRowWidth: 90）跑出来的。M9 断言钉住这条路径。
import { formatWhen, num } from './util.js';

const HEADER = '【可能相关的旧事】';
const FOOTER = '（不确定就别提；要更细可以翻归档）';
/** 睡眠重演的段头（v1.7.0）—— 与"相关旧事"分开，读起来是"突然想起"而不是"你查过"。 */
const REPLAY_HEADER = '【突然想起】';

export class Injector {
  /**
   * @param {object} deps
   * @param {import('./recall.js').Recall} deps.recall
   * @param {() => object} deps.settings
   * @param {{bump?: Function}} [deps.stats]
   * @param {import('./store.js').LayeredStore} [deps.store] 睡眠重演挑块用；不传则功能关闭
   */
  constructor({ recall, settings, stats = null, store = null }) {
    this.recall = recall;
    this.settings = settings;
    this.stats = stats;
    this.store = store || null;
    /** @type {Map<string, Map<string, number>>} chatKey -> chunkId -> 上次注入时间 */
    this.recent = new Map();
    /** 上一次 build() 到底注入了哪几条（跨轮记忆用它来防复读）。 */
    this.lastLines = [];
    /**
     * 上一次注入过的碎片身份（mid / localId）—— 本轮同身份的碎片不再给。
     * ⚠️ 必须**按会话**分开：一个插件实例同时服务多个群，共享一张表的话，
     *    B 群的一轮 build 会把 A 群的 stale 记忆整个冲掉 —— 切回 A 群时
     *    「上轮给过的原话」拦不住了，同一批旧事开始重复注入（token 白烧）。
     *    实测由 Q 组断言钉住。
     * @type {Map<string, Set<string>>}
     */
    this.lastMids = new Map();
  }

  /** 取某个会话的 stale 碎片表（没有就建）。 */
  #midsFor(chatKey) {
    let s = this.lastMids.get(chatKey);
    if (!s) { s = new Set(); this.lastMids.set(chatKey, s); }
    return s;
  }

  #recentlyInjected(chatKey, chunkId, cooldownMs) {
    const m = this.recent.get(chatKey);
    const at = m?.get(chunkId) || 0;
    return Date.now() - at < cooldownMs;
  }

  #markInjected(chatKey, chunkId) {
    if (!this.recent.has(chatKey)) this.recent.set(chatKey, new Map());
    const m = this.recent.get(chatKey);
    m.set(chunkId, Date.now());
    // 顺手清掉过期条目，别让这张表随会话数无限长
    if (m.size > 64) {
      const cutoff = Date.now() - 6 * 3600000;
      for (const [k, at] of m) if (at < cutoff) m.delete(k);
    }
  }

  /**
   * @param {{chatKey: string, triggerText: string, kind?: string, budgetScale?: number,
   *          personIds?: string[]}} ctx
   * @returns {{text: string, chunkIds: string[], cooldownIds: string[]}}
   *   text        注入文本（可能是空串；**不带前后空行**，由调用方拼接）
   *   chunkIds    真正被写进 text 的块 id（经过冷却过滤 + 预算裁剪之后剩下的）。
   *               ⚠️ 计权只能记这些 —— 检索命中了但被预算砍掉的块，模型根本没见过，
   *               给它记"被动命中"等于凭空加分。
   *   cooldownIds 该进冷却的块（= chunkIds + 内容被展示覆盖的块）。送达后传给 markInjected。
   */
  build({ chatKey, triggerText = '', budgetScale = 1, personIds = [], minRel = 0 }) {
    this.lastLines = [];
    const s = this.settings();
    const empty = { text: '', chunkIds: [], cooldownIds: [] };
    if (s.enabled === false || s.autoRecall === false) return empty;
    // 成本护栏降到 2 档时直接不注入（recallBudgetScale = 0）
    const scale = Number(budgetScale);
    if (Number.isFinite(scale) && scale <= 0) return empty;
    const query = String(triggerText || '').trim();
    if (query.length < Math.max(2, Number(s.minTriggerChars) || 6)) return empty;
    const key = String(chatKey || '');
    if (!key) return empty;

    const base = Math.max(60, Number(s.autoRecallBudget) || 220);
    const budget = Math.max(60, Math.round(base * (Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1)));
    const cooldownMs = Math.max(1, Number(s.autoRecallCooldownMin) || 30) * 60000;
    let blocks = [];
    try {
      blocks = this.recall.recallForPrompt(query, {
        chatKey: key,
        maxBlocks: Math.max(1, Number(s.autoRecallTopBlocks) || 2),
        maxLines: 2,
        // 多线索：把"本轮在场的人"一路透传到检索，命中同批人的旧事加权
        personIds,
        // 相关度早停：低分候选连名额都不给它（见 recall.recallForPrompt）。
        // 传 null → 让 recallForPrompt 自己去读 settings.autoRecallMinRel，
        // 插件面板上那个滑块才不会变成空转开关。
        minRel: s.autoRecallMinRel === undefined ? null : s.autoRecallMinRel
      });
    } catch {
      return empty;
    }
    if (!blocks.length) return empty;

    // ── 碎片级跨轮去重（stale skip）──────────────────────────────────────
    // 连续讨论同一件事时，这一轮的"相关旧事"常常与上一轮注入的**原话是同一批**。
    // 块级冷却抓不到这种情况：同一句原话这一轮装在小时块里，下一轮被 rollup 进
    // 日块后 chunkId 就变了，于是同一句话换个容器又被注入一遍 ——
    // 纯浪费 token，模型那边一点新信息都没有。
    // 判据用 **mid**（宿主消息 id）：它跨块、跨 rollup 都不变，是最稳的身份。
    // ⚠️ 只跳过"已经被给过的碎片"，绝不因此拒绝整轮新内容。
    const staleSkip = s.staleSnippetSkip !== false;
    const stale = this.#midsFor(key);
    let staleHits = 0;

    const lines = [];
    // 与 lines 平行的"这条是谁贡献的"，预算裁剪后据此回溯出 chunkIds
    const owners = [];
    // 自己没贡献新内容（全是别处已经给过的）的块 —— 内容等价于"已经展示过"
    const covered = new Set();
    const seen = new Set();
    for (const b of blocks) {
      // 块级冷却：同一个块在冷却期内不重复注入（防连续几轮复读同一件旧事）。
      // ⚠️ 这条与下面的"碎片级跨轮去重"是两层不同的防线，别合并：
      //    冷却按 **chunkId** 判，管"这个块刚给过"；
      //    mid 去重按**碎片身份**判，管"这句原话刚给过、哪怕换了块"。
      if (this.#recentlyInjected(key, b.chunkId, cooldownMs)) continue;
      let contributed = false;
      for (const l of b.lines) {
        const text = String(l.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (seen.has(text)) continue;
        if (staleSkip) {
          const mid = l.mid ?? l.localId;
          if (mid != null && stale.has(String(mid))) { staleHits += 1; continue; }
        }
        seen.add(text);
        contributed = true;
        // ⚠️ 时间必须用**原始 ts** 格式化（l.ts）。曾经写成 formatWhen(l.when) ——
        //    而 l.when 已经是 "MM-DD HH:MM" 字符串，Number() 出来是 NaN，
        //    于是 formatWhen 悄悄回落到 Date.now()：自动注入的旧事**永远显示成刚刚发生**。
        //    模型据此判断"这是新事"，正好把"旧事"这件事说反了。
        const whenLabel = l.ts
          ? formatWhen(l.ts).slice(5, 16)
          : String(l.when || '').slice(5, 16);
        // who 为空 = 梗概墓碑（没有具体说话人），此时不要输出 "：" 前面那个空格
        const who = String(l.who || '').trim();
        // ⚠️ mid / localId 必须一路带到这里：下面记录 lastMids 靠它。
        //    漏带的话 lastMids 永远是空集，碎片级跨轮去重静默失效 ——
        //    表现为"每轮都在重复注入同一批原话"，而从日志上看不出任何异常。
        lines.push({ text, whenLabel, who, mid: l.mid ?? null, localId: l.localId ?? null });
        owners.push(b.chunkId);
        if (lines.length >= 4) break;
      }
      // ⚠️ 必须标记"被覆盖"的块：日块与小时块常常装着同一句话，
      //    只锁真正展示的那个块的话，下一轮另一个块换个名次上来，
      //    会把同一件旧事**再念一遍** —— 正是冷却要防的事。
      // 碎片全被跨轮去重跳过的块也算"被覆盖"：它的内容刚刚给过。
      if (!contributed) covered.add(b.chunkId);
      if (lines.length >= 4) break;
    }
    if (!lines.length) {
      // 全是上轮给过的原话 → 这一段整个不注入。省下的不只是 HEADER/FOOTER，
      // 更重要的是不让模型每轮都看一遍同一批旧事（那会挤占真正的新内容）。
      if (staleHits && this.stats?.bump) {
        this.stats.bump({ skippedStale: staleHits, autoInjectSkipAll: 1 });
      }
      return empty;
    }

    // ── 预算内的行宽联动 ─────────────────────────────────────────────────
    // 旧做法：每条固定最多 90 字符，超预算就从后往前整条砍。
    // 220 字符预算下实际只能放 1 条完整的 + 半条，剩下两条直接没了 ——
    // 钱花了（固定开销 + 头一条），信息面反而窄。
    // 现在反过来：**先按预算算能放几条，再把行宽摊到每条上**。
    // 同样 220 字符能放 3 条完整（每条约 60 字）而不是 1 长 + 2 没，
    // token 不涨、覆盖的话题面变宽，命中率只升不降。
    const cap = Math.max(1, Math.min(4, lines.length));
    const fixed = HEADER.length + FOOTER.length + cap * 6 + 8;
    // recallRowWidth：0 = 按预算自动摊（默认）；> 0 = 用户钉死的行宽（见 index.js DEFAULTS）
    const autoRow = Number(s.recallRowWidth) > 0 ? num(s.recallRowWidth, 90, 20, 400) : 0;
    const rowW = autoRow > 0
      ? autoRow
      : Math.max(40, Math.min(90, Math.floor((budget - fixed) / cap)));
    const fmt = (l) => `- ${l.whenLabel}${l.who ? ` ${l.who}` : ''}：${l.text.slice(0, rowW)}`;

    // 预算裁剪：超了就从后往前砍，至少保留一条
    let picked = lines.slice(0, cap).map(fmt);
    let pickedOwners = owners.slice(0, cap);
    const size = (arr, foot = true) => HEADER.length + (foot ? FOOTER.length : 0) + arr.join('\n').length + 4;
    while (picked.length > 1 && size(picked) > budget) {
      picked = picked.slice(0, -1);
      pickedOwners = pickedOwners.slice(0, -1);
    }
    if (size(picked) > budget) {
      // 只剩一条仍然超预算：**截断这一条**，而不是整段丢掉。
      // ⚠️ 丢掉的话，把 autoRecallBudget 调到 100 这类小值时自动回忆会完全
      //    不工作 —— 而且从外面完全看不出原因（命中是有的，只是全被预算拒了）。
      //    截断至少保住"时间 + 谁 + 半句话"，信息密度远高于空手而归。
      const room = budget - HEADER.length - FOOTER.length - 8;
      const only = picked[0];
      if (!only || room < 20) return empty;
      picked = [`${only.slice(0, room - 1)}…`];
      pickedOwners = pickedOwners.slice(0, 1);
      if (size(picked) > budget) return empty;
    }

    // ⚠️ 这里**不**记冷却。冷却由调用方在"确认送达"之后调 markInjected 记账：
    //    在 build 里记账的话，appendToLastUser 找不到 user 消息（返回 false）时
    //    冷却已经被吃掉 —— 这条旧事被白锁 30 分钟，而模型根本没看到它。
    //    和冲突提醒的 markAnnounced 是同一个坑。
    // 回传给跨轮记忆：下一轮别把同一件旧事再提一遍
    // ⚠️ 前缀宽度用 [^：]{1,24} 而不是 \S+\s+\S+：后者要求"时间 谁"两段，
    //    梗概墓碑没有说话人（只有时间），会匹配不上、把整行原样留下。
    this.lastLines = picked.map((l) => l.replace(/^- [^：]{1,24}：/, '').slice(0, 50));
    // 碎片身份留给下一轮判"这条给过了"（按会话各记各的）
    // ⚠️ 只记**真的写进提示词的那些行**的 mid。预算裁掉的行模型根本没看到，
    //    把它算成"给过了"，下一轮该给的也不给 —— 白丢命中。
    const mids = this.#midsFor(key);
    mids.clear();
    for (let i = 0; i < picked.length; i += 1) {
      const l = lines[i];
      const mid = l?.mid ?? l?.localId;
      if (mid != null) mids.add(String(mid));
    }
    // 只有一条时可省掉免责尾注 —— 15 个字符，单条命中时占比 7%，
    // 而"不确定就别提"这句忠告在有多条候选时才真的有用。
    const footer = picked.length > 1;
    const text = `${HEADER}\n${picked.join('\n')}${footer ? `\n${FOOTER}` : ''}`;
    if (this.stats?.bump) {
      this.stats.bump({
        autoInject: 1,
        injectedChars: text.length,
        injectedLines: picked.length,
        lastInject: picked.length
      });
      if (staleHits) this.stats.bump({ skippedStale: staleHits });
    }
    // 去重（两条碎片可能来自同一个块）
    const shown = [...new Set(pickedOwners)];
    return {
      text,
      // 真的写进提示词的块 —— 只有这些记"被动命中"
      chunkIds: shown,
      // 进冷却的块 = 展示过的 + 内容被展示覆盖的。冷却范围比"展示过的"大是**故意的**：
      // 冷却管的是"这句话刚给过"，不是"这个块刚给过"。
      cooldownIds: [...new Set([...shown, ...covered])]
    };
  }

  /**
   * 睡眠重演（v1.7.0）：把"现在该复习了"的旧事主动带出来一句。
   *
   * ── 为什么这更像人 ──────────────────────────────────────────────────────
   * 人的记忆在睡眠中会重放"还没忘干净、但也快忘了"的内容（间隔重复），
   * 于是某天你会"突然想起"一件早就不在眼前的事。本插件对应：
   * 后台巩固就是"睡眠"，`store.dueReviews()` 挑出最优难度区间（gap≈S、R≈0.6~0.9）
   * 的那一块，下次激活时带一句 —— 不是因为它和本轮话题相关，而是因为它该复习了。
   *
   * ── 为什么不担心它撑爆提示词 ────────────────────────────────────────────
   *   · 一次最多一块、两行，字符预算按 autoRecallBudget 的 60% 另算；
   *   · 复用自动注入的冷却与碎片级跨轮去重（刚给过的不重播）；
   *   · 护栏降到 2 档（recallBudgetScale=0）时直接不播；
   *   · 它是**追加**不是替换：相关旧事照旧检索，重演只是多露一面。
   *
   * ⚠️ 返回的 chunkIds 只代表"打算播"，播出后由调用方按 full 计权
   *    （测试效应：被带出来复习 = 一次成功的提取）—— 与被动注入的记账分开。
   *
   * @param {{chatKey: string, budgetScale?: number, maxChars?: number}} ctx
   * @returns {{text: string, chunkIds: string[]}}
   */
  buildReplay({ chatKey, budgetScale = 1, maxChars = 140 } = {}) {
    const empty = { text: '', chunkIds: [] };
    const s = this.settings();
    if (s.enabled === false || s.autoRecall === false || s.sleepReplay === false) return empty;
    const scale = Number(budgetScale);
    if (Number.isFinite(scale) && scale <= 0) return empty;
    const key = String(chatKey || '');
    if (!key || !this.store?.dueReviews) return empty;

    let id = null;
    try {
      const due = this.store.dueReviews(key, { limit: 1 });
      id = due[0] || null;
    } catch {
      return empty;
    }
    if (!id) return empty;
    // 这块刚刚作为"相关旧事"给过 → 不重播（同一轮里同一条旧事出现两次很怪）
    const cooldownMs = Math.max(1, Number(s.autoRecallCooldownMin) || 30) * 60000;
    if (this.#recentlyInjected(key, id, cooldownMs)) return empty;

    let hit = null;
    try {
      hit = this.store.buildHit(key, id, 1, { query: '', maxSnippets: 2 });
    } catch {
      return empty;
    }
    if (!hit || !Array.isArray(hit.snippets) || !hit.snippets.length) return empty;

    const lines = [];
    for (const sn of hit.snippets) {
      const text = String(sn.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const mid = sn.mid ?? sn.localId;
      // 这句原话上一轮刚给过（本会话）→ 整块不播（内容零新增，纯占token）
      if (mid != null && this.#midsFor(key).has(String(mid))) return empty;
      lines.push(text);
      if (lines.length >= 2) break;
    }
    if (!lines.length) return empty;

    const whenLabel = hit.snippets[0].ts
      ? formatWhen(hit.snippets[0].ts).slice(5, 16)
      : String(hit.when || '').slice(5, 16);
    const budget = Math.max(40, Math.min(Number(maxChars) || 140,
      Math.round((Number(s.autoRecallBudget) || 220) * 0.6)));
    let body = lines.map((t) => `- ${whenLabel}：${t.slice(0, budget)}`).join('\n');
    if (body.length > budget) body = `${body.slice(0, budget - 1)}…`;
    if (this.stats?.bump) this.stats.bump({ sleepReplay: 1 });
    return { text: `${REPLAY_HEADER}\n${body}`, chunkIds: [id] };
  }

  /** 送达之后记账：这几个块进入冷却期，避免连续几轮复读同一件旧事。 */
  markInjected(chatKey, chunkIds = []) {
    const key = String(chatKey || '');
    if (!key) return 0;
    let n = 0;
    for (const id of chunkIds) {
      if (!id) continue;
      this.#markInjected(key, String(id));
      n += 1;
    }
    return n;
  }

  /** 换会话/调试用：清掉冷却记录。 */
  clear(chatKey = null) {
    if (chatKey) {
      this.recent.delete(String(chatKey));
      this.lastMids.delete(String(chatKey));
    } else {
      this.recent.clear();
      this.lastMids.clear();
      this.lastLines = [];
    }
  }
}
