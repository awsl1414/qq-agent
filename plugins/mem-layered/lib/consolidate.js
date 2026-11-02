// 巩固：把新消息压成小时块，再把老的小时块合成日块，最后淘汰没人想起的块。
//
// 这一层完全确定性 —— 不调模型、不花 token，所以模型想忽略也忽略不掉。
// （内置版的"整理"是调 LLM 做的，每整理一位群友要一次请求；这里不做 LLM 整理：
//   代价太高、还引入幻觉风险。压缩靠的是分块 + 权重 + 时间衰减，都是本地计算。）
import fs from 'node:fs';
import path from 'node:path';
import {
  safeName, dayKeyOf, hourKeyOf, timeOfDayOf, tokenize, clamp, num
} from './util.js';

/** 空占位（图片/表情/语音…）没有可检索内容，不入块。 */
const PLACEHOLDER_RE = /^\[(图片|表情|贴图|语音|视频)\]$/;

/**
 * 日块碎片上限。
 * 日块是"一天的摘要"，不是"一天的全文"——所以它比小时块的
 * maxSnippetsPerBlock（默认 120）收得紧。原来这是个散在 rollupChat 里的
 * 魔法数 40；提成常量至少让"这是刻意收窄的"有据可查。
 * ⚠️ 不做成设置项：它和 maxSnippetsPerBlock 是同一个语义的两个刻度，
 *    多一个滑块只会让人困惑。真要调，改这个常量。
 */
const DAY_SNIPPETS_MAX = 40;

function messagesFile(messagesDir, chatKey) {
  return path.join(messagesDir, `${safeName(chatKey)}.json`);
}

/** 会话文件的大小与修改时间；读不到返回 null。 */
function statMessages(messagesDir, chatKey) {
  try {
    const st = fs.statSync(messagesFile(messagesDir, chatKey));
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 读原始消息（真相源，永不改写）。
 *
 * ── 两种读法，别混 ────────────────────────────────────────────────────────
 *   · `tail: true`  —— 取**最后** cap 条。归档用（要的是"最近的记录"）。
 *   · 默认（fromId）—— 取 id > fromId 的**前** cap 条。巩固用，配合水位线
 *     一条条往前推。
 *
 * ⚠️ 巩固**不能**用 tail 读法：会话超过 cap 条时，`all` 永远只是文件末尾那一段，
 *    而水位线又只会往前走 —— 早期消息于是**永远进不了记忆库**，而且不报错。
 *    这是只有"消息数超过 consolidateBatchMax 的会话"才会暴露的静默丢失。
 */
export function loadMessages(messagesDir, chatKey, { batchMax = 20000, fromId = 0, tail = false } = {}) {
  try {
    let text = fs.readFileSync(messagesFile(messagesDir, chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const j = JSON.parse(text);
    const all = Array.isArray(j.messages) ? j.messages : [];
    const cap = Math.max(100, Number(batchMax) || 20000);
    if (tail) return all.length > cap ? all.slice(-cap) : all;
    const pool = Number(fromId) > 0 ? all.filter((m) => Number(m.id) > Number(fromId)) : all;
    return pool.length > cap ? pool.slice(0, cap) : pool;
  } catch {
    return [];
  }
}

function isWorthKeeping(msg) {
  const text = String(msg.text || '').trim();
  if (!text) return false;
  if (PLACEHOLDER_RE.test(text)) return false;
  if (/^\[合并转发聊天记录\]$/i.test(text) || /^\[转发消息\s*[^\]]*\]$/.test(text)) return false;
  return true;
}

/**
 * 碎片权重：只根据**可判定的结构信号**决定谁更值得留。
 *
 * 长度（信息量）、提问/约定/链接（可执行内容）、展开的转发（成块的信源）。
 * 刻意**不解读情绪、不猜意图** —— 一靠启发式给"激动的话"加权就会悄悄
 * 改变整套记忆的取舍，而寒暄与日常恰恰是记忆的主体。
 */
function weightOf(msg) {
  const text = String(msg.text || '');
  let w = 1;
  if (text.length >= 12) w += 1;
  if (msg.self) w += 0.2;
  if (/[?？]|为什么|怎么|计划|约定|明天|记得|别忘|推荐|链接|http/i.test(text)) w += 1;
  if (/\[合并转发\s*共/.test(text)) w += 2;
  if (text.length <= 2) w *= 0.4;
  return w;
}

function snippetOf(m) {
  return {
    ts: Number(m.ts) || 0,
    mid: m.mid ?? null,
    localId: m.id ?? null,
    who: m.self ? '我' : (m.senderName || m.senderId || '?'),
    // ⚠️ 昵称会改，uid 不会。多线索检索（"在场的人"）必须按 uid 匹配，
    //    否则同一个人在块里叫"阿甲"、在触发消息里叫"阿甲（新）"，就永远对不上。
    uid: String(m.senderId ?? ''),
    self: !!m.self,
    text: String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    w: weightOf(m)
  };
}

function snippetKey(s) {
  return String(s.mid ?? s.localId ?? s.ts);
}

/**
 * 合并共激活链接（v1.7.0）：计数相加、邻居数封顶。
 * 口径与 store.js 的 #linkTogether 保持一致（计数上限 20、邻居上限 12）——
 * 两处对不上会出现"rollup 之后 links 比索引里的还多"的漂移。
 */
function mergeLinks(a, b, maxNeighbors = 12, maxCount = 20) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = Math.min(maxCount, (Number(out[k]) || 0) + (Number(v) || 0));
  }
  const keys = Object.keys(out);
  if (keys.length > maxNeighbors) {
    keys.sort((p, q) => (Number(out[q]) || 0) - (Number(out[p]) || 0));
    for (const k of keys.slice(maxNeighbors)) delete out[k];
  }
  return out;
}

/**
 * 按权重裁剪到上限，但保持时间顺序（信息密度高的先留下）。
 */
function capSnippets(list, max) {
  const sorted = [...list].sort((a, b) => Number(a.ts) - Number(b.ts));
  if (sorted.length <= max) return sorted;
  const keep = new Set(
    [...sorted].sort((a, b) => (b.w || 1) - (a.w || 1)).slice(0, max).map(snippetKey)
  );
  return sorted.filter((s) => keep.has(snippetKey(s)));
}

function keywordsOf(snippets, limit = 16) {
  const freq = new Map();
  for (const s of snippets) {
    for (const t of tokenize(s.text)) {
      if (t.length < 2 && !/[a-z0-9]/.test(t)) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([t, n]) => n >= 2 && t.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

function summaryOf(snippets) {
  return [...snippets]
    .sort((a, b) => (b.w || 1) - (a.w || 1))
    .slice(0, 6)
    .map((l) => `${l.who}: ${l.text}`)
    .join(' | ')
    .slice(0, 320);
}

export function hourBlockId(chatKey, hourKey) {
  const [day, hour] = String(hourKey).split(' ');
  return `hour_${safeName(chatKey)}_${String(day).replace(/-/g, '')}_${String(hour || '0').padStart(2, '0')}`;
}

export function dayBlockId(chatKey, dayKey) {
  return `day_${safeName(chatKey)}_${String(dayKey).replace(/-/g, '')}`;
}

export class Consolidator {
  /**
   * @param {object} deps
   * @param {import('./store.js').LayeredStore} deps.store
   * @param {string} deps.messagesDir
   * @param {() => object} deps.settings
   * @param {import('./gist.js').GistStore} [deps.gist] 梗概墓碑（淘汰时留线索、检索时按需重建）
   */
  constructor({ store, messagesDir, settings, onBlock = null, gist = null }) {
    this.store = store;
    this.messagesDir = path.resolve(messagesDir);
    this.settings = settings;
    /** 梗概墓碑。可选 —— 没有它一切照旧，只是淘汰后不留线索。 */
    this.gist = gist;
    /**
     * 每写成一个小时块就回调一次（index.js 用它喂语义卡）。
     * ⚠️ 回调抛错绝不能影响巩固 —— 抽卡只是附带产物。
     */
    this.onBlock = typeof onBlock === 'function' ? onBlock : null;
  }

  /**
   * 巩固一个会话（增量）。
   * @param {string} chatKey
   * @param {{force?: boolean}} opts force=true 时清掉该会话的块与索引全量重建
   */
  consolidateChat(chatKey, { force = false } = {}) {
    const t0 = Date.now();
    const s = this.settings();
    const batchMax = num(s.consolidateBatchMax, 20000, 100, 500000);
    const maxSnippets = num(s.maxSnippetsPerBlock, 120, 20, 5000);

    if (force) {
      for (const id of this.store.listBlockIds(chatKey)) {
        this.store.unindexBlock(chatKey, id, { flush: false });
        this.store.deleteBlock(chatKey, id);
      }
      const st = this.store.chatState(chatKey);
      st.blocks = {};
      st.backlog = false;
      this.store.stateDirty = true;
    }

    const state = this.store.chatState(chatKey);
    const start = force ? 0 : Math.max(0, Number(state.lastIndexedId) || 0);
    const stat = statMessages(this.messagesDir, chatKey);

    // 文件没动过就不读了 —— 定时器每 10 分钟把一个几 MB 的 JSON 读进来再 parse
    // 一遍是巩固里最贵的一步，而绝大多数 tick 其实没有新消息。
    // ⚠️ 但 `state.backlog` 为真时必须继续读：那表示上一批被 batchMax 截断了、
    //    后面还有历史没扫完。只看"文件没变"会把回填卡死在第一批 ——
    //    这正是历史回填上线后立刻踩到的坑（只巩固了第一批就再也不动了）。
    // 注意只跳过"读消息"这一步；下面的汇总/淘汰是时间驱动的，照跑。
    const unchanged = !force && !state.backlog && stat
      && Number(state.fileSize) === stat.size
      && Number(state.fileMtimeMs) === stat.mtimeMs;

    let added = 0;
    let touched = 0;
    // 「出生即超龄」的小时块（回填的历史）不落盘，先进这个桶，再由 rollupChat
    // 一次性合成日块。⚠️ 否则首日回填要给每个历史小时块做 写→读→删 三次文件
    // 操作，而它们下一秒就被合并成日块 —— 实测本机 rmSync ≈ 21ms/次，
    // 720 个历史小时块光删除就 15s+（soak 基准 tools/bench-soak.mjs 实测）。
    /** @type {Map<string, Array<{id: string, block: object, onDisk: boolean}>>} */
    const rollupPending = new Map();
    const afterDays = num(s.rollupAfterDays, 7, 0, 36500);
    const rollupCutoff = afterDays > 0 ? Date.now() - afterDays * 86400000 : 0;

    if (!unchanged) {
      const batch = loadMessages(this.messagesDir, chatKey, { batchMax, fromId: start });

      if (batch.length) {
        /** @type {Map<string, object[]>} */
        const byHour = new Map();
        for (const m of batch) {
          if (!isWorthKeeping(m)) continue;
          const hk = hourKeyOf(m.ts);
          if (!byHour.has(hk)) byHour.set(hk, []);
          byHour.get(hk).push(m);
        }

        for (const [hourKey, msgs] of byHour) {
          const blockId = hourBlockId(chatKey, hourKey);
          // ⚠️ 增量必须与已有块**合并**，不能整块覆盖：同一自然小时内分两次巩固，
          //   后者只带着新消息就把块重写，此前已巩固的碎片会从索引里永久消失
          //   （内置版踩过这个坑，见其 consolidator 的 H3 注释）。
          const existing = this.store.readBlock(chatKey, blockId);
          const merged = new Map();
          for (const sn of existing?.snippets || []) merged.set(snippetKey(sn), sn);
          // 只有这一轮**新加进来**的碎片才算新 —— 否则每巩固一次就把整块的碎片
          // 重喂一遍语义卡，同一张卡的 hits 会被反复 +1 而虚高。
          const freshSnips = [];
          for (const m of msgs) {
            const sn = snippetOf(m);
            if (!sn.text) continue;
            const k = snippetKey(sn);
            if (!merged.has(k)) freshSnips.push(sn);
            merged.set(k, sn);
          }
          const snippets = capSnippets([...merged.values()], maxSnippets);
          const block = {
            id: blockId,
            kind: 'hour',
            chatKey: String(chatKey),
            dayKey: String(hourKey).slice(0, 10),
            hourKey,
            timeOfDay: timeOfDayOf(hourKey),
            when: snippets.length ? snippets[snippets.length - 1].ts : Date.now(),
            title: `${chatKey} @ ${hourKey}:00`,
            summary: summaryOf(snippets),
            keywords: keywordsOf(snippets),
            snippets,
            msgCount: merged.size,
            consolidatedAt: Date.now()
          };
          // 「出生即超龄」：回填出来的历史小时块直接进日汇总桶，不落盘。
          // onDisk = 之前某轮巩固时它还年轻、已经写过盘 —— 那种仍要照常清理。
          const aged = afterDays > 0 && block.when <= rollupCutoff;
          if (aged) {
            const day = block.dayKey;
            if (!rollupPending.has(day)) rollupPending.set(day, []);
            rollupPending.get(day).push({ id: blockId, block, onDisk: existing != null });
          } else {
            this.store.writeBlock(chatKey, block);
            this.store.indexBlock(chatKey, block);
            // noteBlock 而不是直接赋值：要保住块已经积累的 score/hits/lastHitAt
            this.store.noteBlock(chatKey, blockId, {
              kind: 'hour', dayKey: block.dayKey, when: block.when
            });
          }
          // 附带产物：从**新增**碎片里抽语义卡（失败忽略）。
          // ⚠️ 走桶的块也要抽 —— 语义卡是碎片的派生属性，与块落不落盘无关。
          if (this.onBlock && freshSnips.length) {
            try {
              this.onBlock(String(chatKey), { ...block, snippets: freshSnips });
            } catch { /* 抽卡失败不影响巩固 */ }
          }
          added += msgs.length;
          touched += 1;
        }
      }

      // 水位线推到这一批的最后一条 —— 哪怕这一批被 batchMax 截断，
      // 下一轮也会从这条之后接着读，最终把整个会话扫完。
      const last = batch[batch.length - 1];
      if (last) {
        state.lastIndexedId = Math.max(Number(state.lastIndexedId) || 0, Number(last.id) || 0);
        state.lastTs = Number(last.ts) || state.lastTs || 0;
      }
      // 这一批正好顶到上限 → 后面还有历史，下一轮接着扫（见上面 unchanged 的注释）
      state.backlog = batch.length >= batchMax;
      if (stat) {
        state.fileSize = stat.size;
        state.fileMtimeMs = stat.mtimeMs;
      }
    }

    const rolled = this.rollupChat(chatKey, rollupPending);
    const forgotten = this.store.forgetSweep(chatKey, {
      forgetAfterDays: num(s.forgetAfterDays, 120, 0, 36500),
      // 删块之前先留一条梗概墓碑：细节可以烂，但"我好像记得有这么回事"要留住。
      // 墓碑很小（几十字节），所以它能比块活得久得多。
      onEvict: this.gist
        ? (id, meta, block) => this.gist.remember(chatKey, block, meta)
        : null
    });
    if (this.gist) {
      try {
        // 墓碑也要会忘，只是慢得多（默认 3 年）
        this.gist.sweep();
        // 节流落盘（30 秒）：remember 只标 dirty，真正写盘在这里 ——
        // 让"任何走巩固的路径"都能把墓碑带上盘，而不只是定时器那条。
        this.gist.save({ force: false });
      } catch { /* 清理/落盘失败不影响巩固 */ }
    }
    const pruned = this.store.pruneVocab(chatKey, {
      maxVocab: num(s.maxVocabPerChat, 100000, 500, 1000000),
      // 上限允许到 1 = 不剪（调参/排障时用）。注意块数少的时候，
      // 大部分词本来就会出现在多数块里 —— 这时 0.9 也可能剪得很凶。
      dfCutoffRatio: num(s.dfCutoffRatio, 0.7, 0.2, 1)
    });

    state.lastConsolidatedAt = Date.now();
    state.granularity = 'hour';
    this.store.saveState();
    this.store.flushIndex(chatKey, { force: true });

    return {
      chatKey,
      added,
      blocks: touched,
      rolledUp: rolled.length,
      forgotten: forgotten.length,
      prunedTokens: pruned,
      skippedRead: unchanged,
      durationMs: Date.now() - t0
    };
  }

  /**
   * 小时块 → 日块。
   * 超过 rollupAfterDays 的小时块合并成一块：只保留权重最高的一批碎片，
   * 索引随之收缩（这是"体积不随语料线性膨胀"的主要手段）。
   *
   * @param {string} chatKey
   * @param {Map<string, Array<{id: string, block: object, onDisk: boolean}>>} [pending]
   *   「出生即超龄」还没落盘的小时块（回填历史走这条，省掉 写→读→删 三连）。
   *   onDisk=true 的条目在合并后要照常摘索引 + 删文件 + 清 state。
   */
  rollupChat(chatKey, pending = null) {
    const s = this.settings();
    const afterDays = num(s.rollupAfterDays, 7, 0, 36500);
    if (!(afterDays > 0)) return [];
    const cutoff = Date.now() - afterDays * 86400000;
    const index = this.store.index(chatKey);

    /** @type {Map<string, Array<{id: string, block?: object, onDisk: boolean}>>} dayKey -> 待合并条目 */
    const byDay = new Map();
    const push = (day, entry) => {
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(entry);
    };
    // ① 内存桶（没落过盘的历史小时块）在前 —— 内容按 mid 去重，先后无所谓
    if (pending && pending.size) {
      for (const [day, list] of pending) for (const e of list) push(day, e);
    }
    // ② 磁盘上已存在的小时块（老路径）
    for (const [id, meta] of Object.entries(index.blocks)) {
      if (meta.kind !== 'hour') continue;
      if (!(Number(meta.when) > 0) || Number(meta.when) > cutoff) continue;
      const day = meta.dayKey || dayKeyOf(meta.when);
      push(day, { id, onDisk: true });
    }

    const done = [];
    for (const [day, entries] of byDay) {
      const dayId = dayBlockId(chatKey, day);
      const merged = new Map();
      // ⚠️ 顺带把被合并小时块的"记忆强度"接过来。
      //    否则"某天被反复想起的那段"一合并成日块就被打回出厂权重 score=1/hits=0，
      //    越重要的记忆反而越容易被 forgetSweep 清掉 —— 正好反了。
      let score = 1;
      let hits = 0;
      let lastHitAt = 0;
      // S（稳定性）与 passiveHits 同理要接过来：
      // ⚠️ 漏掉 S 的话，一个"每两周被想起一次、稳定性已经长到 200 天"的老块，
      //    在第 7 天滚成日块时 S 会被重置回全局默认 45 天 —— 越老的块滚得越多、
      //    稳定性丢得越狠，等于"记得越久反而越快被忘掉"。passiveHits 只是计数，
      //    但一起接过来免得它每次 rollup 都归零、变成一个永远长不大的数字。
      let S = 0;
      let passiveHits = 0;
      // 共激活链接（v1.7.0）与上次重演时间：小时块一合并就没了，
      // 不接过来的话"那天和哪些事一起被想起"连同重演冷却一起归零。
      let links = {};
      let lastReplayAt = 0;
      for (const entry of entries) {
        if (entry.onDisk) {
          const id = entry.id;
          const meta = index.blocks[id];
          if (meta) {
            score = Math.max(score, Number(meta.score) || 1);
            hits += Number(meta.hits) || 0;
            lastHitAt = Math.max(lastHitAt, Number(meta.lastHitAt) || 0);
            S = Math.max(S, Number(meta.S) || 0);
            passiveHits += Number(meta.passiveHits) || 0;
            links = mergeLinks(links, meta.links);
            lastReplayAt = Math.max(lastReplayAt, Number(meta.lastReplayAt) || 0);
          }
          const block = this.store.readBlock(chatKey, id);
          for (const sn of block?.snippets || []) merged.set(snippetKey(sn), sn);
        } else {
          // 内存桶里的块从没落过盘：没有 meta（权重本就是出厂值），
          // 也没有索引条目/文件要清理 —— 它唯一的去处就是并进这个日块。
          for (const sn of entry.block?.snippets || []) merged.set(snippetKey(sn), sn);
        }
      }
      // ⚠️⚠️ B1 修复（2026-10-14）：**已存在的日块必须一起合并**。
      //    迟到的旧时间戳消息（历史回放 / 二次补拉 / 时钟偏差）会在某天汇总成日块
      //    **之后**才进来，形成该天新的小时块；下一次汇总若只合并这批新小时块，
      //    就会用它们**整块覆盖**已存在的日块 —— 该日此前汇总的碎片从索引与块文件
      //    里静默消失（无墓碑、无日志，连 forgetSweep 都没参与）。
      //    真实群消息乱序概率低（实测 0/156），但静默丢失 + 修复只要几行，必须堵。
      const existingDay = this.store.readBlock(chatKey, dayId);
      if (existingDay) {
        const dayMeta = index.blocks[dayId];
        if (dayMeta) {
          score = Math.max(score, Number(dayMeta.score) || 1);
          hits += Number(dayMeta.hits) || 0;
          lastHitAt = Math.max(lastHitAt, Number(dayMeta.lastHitAt) || 0);
          S = Math.max(S, Number(dayMeta.S) || 0);
          passiveHits += Number(dayMeta.passiveHits) || 0;
          links = mergeLinks(links, dayMeta.links);
          lastReplayAt = Math.max(lastReplayAt, Number(dayMeta.lastReplayAt) || 0);
        }
        for (const sn of existingDay.snippets || []) merged.set(snippetKey(sn), sn);
      }
      if (!merged.size) {
        for (const entry of entries) {
          if (!entry.onDisk) continue;
          this.store.unindexBlock(chatKey, entry.id, { flush: false });
          this.store.deleteBlock(chatKey, entry.id);
          delete this.store.chatState(chatKey).blocks[entry.id];
        }
        continue;
      }
      // 日汇总同理：合并后的碎片也要受"首因/近因"影响（那一天的开场与收尾）
      const snippets = capSnippets([...merged.values()], DAY_SNIPPETS_MAX);
      const block = {
        id: dayId,
        kind: 'day',
        chatKey: String(chatKey),
        dayKey: day,
        hourKey: '',
        timeOfDay: '',
        when: snippets.length ? snippets[snippets.length - 1].ts : Date.now(),
        title: `${chatKey} @ ${day}（日汇总）`,
        summary: summaryOf(snippets),
        keywords: keywordsOf(snippets, 24),
        snippets,
        msgCount: merged.size,
        consolidatedAt: Date.now()
      };
      this.store.writeBlock(chatKey, block);
      // 先 noteBlock 再 indexBlock：#indexInto 会从 state 里把权重读回来
      this.store.noteBlock(chatKey, dayId, {
        kind: 'day',
        dayKey: day,
        when: block.when,
        score: clamp(score, 0.05, 3),
        hits,
        lastHitAt,
        // S=0 表示"子块都没有 S"，此时 stabilityOf 会回落到全局 decayHalfLifeDays。
        // 不能写成全局默认值 —— 那会让"本来就没 S"和"显式设成 45"不可区分。
        S,
        passiveHits,
        links,
        lastReplayAt
      });
      this.store.indexBlock(chatKey, block);
      for (const entry of entries) {
        if (!entry.onDisk) continue;
        this.store.unindexBlock(chatKey, entry.id, { flush: false });
        this.store.deleteBlock(chatKey, entry.id);
        delete this.store.chatState(chatKey).blocks[entry.id];
      }
      this.store.stateDirty = true;
      done.push(day);
    }
    return done;
  }

  /**
   * 按墓碑重建一个块 —— 节省效应的落地。
   *
   * ── 为什么这件事在本插件里特别划算 ──────────────────────────────────────
   * 块只是 `messages/` 的一个**索引视图**，而 `messages/` 是只读完整真相源。
   * 所以"删块"从来没有真的丢过数据，丢的是"知道去哪儿找"。
   * 墓碑补上这条线索之后，"想不起来细节"就变成"稍微费点劲就能想起来"。
   *
   * @param {string} chatKey
   * @param {{id: string, dayKey?: string, hourKey?: string, minId?: number, maxId?: number}} gist
   * @returns {string|null} 重建出来的块 id；重建不了返回 null（调用方退化成只给要旨）
   */
  reviveBlock(chatKey, gist = {}) {
    const blockId = String(gist?.id || '');
    if (!blockId) return null;
    const key = String(chatKey);

    // 已经在库里（被别人复活过 / 从来没删干净）→ 直接用，顺手把墓碑摘掉
    if (this.store.readBlock(key, blockId)) {
      this.gist?.remove(key, blockId);
      return blockId;
    }

    // ⚠️ 复活要读整个会话文件（JSON.parse 是同步的，会阻塞事件循环）。
    //    在 5 秒钩子预算里读一个几十 MB 的文件足以把这一轮对话拖垮，
    //    所以超过上限就**只给要旨**，不重建 —— 用户仍然能看到"有这么回事"。
    //    ⚠️ 这一条**不记失败**：它是配置问题（gistReviveMaxMb 太小），
    //    用户把上限调大之后这条墓碑还能救回来，不该被永久判死。
    const s = this.settings();
    const stat = statMessages(this.messagesDir, key);
    const maxBytes = num(s.gistReviveMaxMb, 24, 0.01, 512) * 1024 * 1024;
    if (stat && stat.size > maxBytes) return null;

    const minId = Number(gist.minId) || 0;
    const maxId = Number(gist.maxId) || 0;
    // 按墓碑记下的 id 区间只取那一段（墓碑是"去哪儿找"的线索，不是内容）
    const useRange = minId > 0 && maxId >= minId;
    const pool = loadMessages(this.messagesDir, key, {
      batchMax: useRange ? Math.max(100, maxId - minId + 16) : num(s.consolidateBatchMax, 20000, 100, 500000),
      fromId: useRange ? minId - 1 : 0
    });

    const dayKey = String(gist.dayKey || '').slice(0, 10);
    const hourKey = String(gist.hourKey || '');
    const msgs = pool.filter((m) => {
      if (!isWorthKeeping(m)) return false;
      if (useRange && (Number(m.id) < minId || Number(m.id) > maxId)) return false;
      const hk = hourKeyOf(m.ts);
      if (hourKey) return hk === hourKey;
      if (dayKey) return String(hk).slice(0, 10) === dayKey;
      return true;
    });
    // 原文真的没了（记录被清 / id 区间对不上）→ 记一次失败。
    // 累计几次之后这条墓碑会被标成"救不回来"，以后只给要旨，
    // 免得每次命中都白读一遍整个会话文件。
    if (!msgs.length) { this.gist?.markReviveFail(key, blockId); return null; }

    const maxSnippets = num(s.maxSnippetsPerBlock, 120, 20, 5000);
    const snippets = capSnippets(
      msgs.map((m) => snippetOf(m)).filter((sn) => sn.text),
      maxSnippets
    );
    if (!snippets.length) { this.gist?.markReviveFail(key, blockId); return null; }

    const hk0 = hourKeyOf(snippets[snippets.length - 1].ts);
    // 墓碑记的是日块就重建日块，记的是小时块就重建小时块 —— 不能张冠李戴，
    // 否则 indexBlock 会把块 id 和块内容对不上，检索回来的东西是错位的。
    const kind = gist.kind === 'day' ? 'day' : 'hour';
    const block = kind === 'day'
      ? {
        id: blockId,
        kind: 'day',
        chatKey: key,
        dayKey: String(hk0).slice(0, 10),
        hourKey: '',
        timeOfDay: '',
        when: snippets[snippets.length - 1].ts,
        title: `${key} @ ${String(hk0).slice(0, 10)}（日汇总·已复活）`,
        summary: summaryOf(snippets),
        keywords: keywordsOf(snippets, 24),
        snippets,
        msgCount: snippets.length,
        consolidatedAt: Date.now(),
        revived: true
      }
      : {
        id: blockId,
        kind: 'hour',
        chatKey: key,
        dayKey: String(hk0).slice(0, 10),
        hourKey: hk0,
        timeOfDay: timeOfDayOf(hk0),
        when: snippets[snippets.length - 1].ts,
        title: `${key} @ ${hk0}:00（已复活）`,
        summary: summaryOf(snippets),
        keywords: keywordsOf(snippets, 16),
        snippets,
        msgCount: snippets.length,
        consolidatedAt: Date.now(),
        revived: true
      };

    this.store.writeBlock(key, block);
    // 把当初攒下的记忆强度还给它：被想起过的老事复活之后不该从头开始。
    // ⚠️ 但 lastHitAt 用**现在** —— 复活本身就是一次成功的提取（测试效应），
    //    衰减从这一刻重新起算才合理。
    // ⚠️ 先 noteBlock 再 indexBlock：#indexInto 会从 state 里把权重读回来，
    //    顺序反了的话，复活出来的块在索引里是 score=1 / hits=0 / S=0 ——
    //    攒下的记忆强度白攒，而且下一次 forgetSweep 会立刻把它当"低权重老块"删掉。
    //    （rollupChat 里也是这个顺序，别只改一处。）
    this.store.noteBlock(key, blockId, {
      kind: block.kind,
      dayKey: block.dayKey,
      hourKey: block.hourKey || '',
      when: block.when,
      score: num(gist.score, 1, 0.05, 3),
      S: num(gist.S, 0, 0, 36500),
      hits: (Number(gist.hits) || 0) + 1,
      lastHitAt: Date.now()
    });
    this.store.indexBlock(key, block);
    this.store.stateDirty = true;
    this.gist?.remove(key, blockId);
    return blockId;
  }

  /**
   * 磁盘上有哪些会话 —— 真相源是 `messages/`，**不是索引**。
   *
   * ⚠️ 这一条是端到端测试逼出来的：`store.listChatKeys()` 只知道"索引里已经有的"
   *    会话（state.chats + 块目录），而全新安装时这两处都是空的 —— 于是定时器
   *    调 consolidateAll() 会拿到空列表、什么都不做，插件永远不会自己启动。
   *    离线自测之所以没发现，是因为它每次都直接调 consolidateChat(某个 chatKey)，
   *    从来没走过"从零自举"这条路径。
   */
  listMessageChatKeys() {
    try {
      return fs.readdirSync(this.messagesDir)
        .filter((f) => /^(group|private)_\d+\.json$/.test(f))
        .map((f) => {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          return `${m[1]}:${m[2]}`;
        });
    } catch {
      return [];
    }
  }

  /**
   * 全库巩固（定时器用）。失败隔离到单个会话，一个坏了不影响其它。
   * 会话列表 = messages/ 里有的 ∪ 索引里已有的（后者用于"原文被删但索引还在"的清理）。
   */
  consolidateAll({ force = false, log = () => {} } = {}) {
    const keys = new Set([...this.listMessageChatKeys(), ...this.store.listChatKeys()]);
    const results = [];
    for (const chatKey of keys) {
      try {
        results.push(this.consolidateChat(chatKey, { force }));
      } catch (error) {
        log(`巩固 ${chatKey} 失败：${error?.message ?? error}`);
        results.push({ chatKey, error: String(error?.message ?? error) });
      }
    }
    this.store.flushAll({ force: true });
    return results;
  }
}
