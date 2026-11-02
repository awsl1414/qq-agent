// 分片存储 + 倒排索引。
//
// ── 与内置 conversation-memory 的三个关键差别（都是针对实测问题改的）──────
//
// 1) **按会话分片**。内置版把所有会话的倒排塞进一个 index.json：实测 14 个小时块
//    = 671KB，而每次巩固末尾要把整份文件 stringify + 全量重写，启动时还要整份
//    读进内存。块数一多就是"每 10 分钟重写十几 MB"。
//    这里改成 index/<会话>.json —— 巩固某个会话只重写那一个会话的分片，
//    复杂度从 O(全库) 降到 O(该会话)。
//
// 2) **真的会忘**。内置版 Hippocampus.forget() 只在全量重建时被调用一次，
//    排序里 recency 权重是 0.85+0.15*recency（最老的块也只降到 0.85 倍），
//    等于只增不减。这里把"块权重"做成：命中加分 × 距上次命中的指数衰减，
//    并且巩固时把低于阈值、又够老的块真正摘出索引、删掉块文件
//    （原始聊天记录不动 —— 归档仍能按天回读）。
//
// 3) **词表有上限**。内置版没有 df 剪枝也没有词表上限，实测 5021 个词项里
//    3951 个只出现在一个块里（长尾 bigram），索引体积随语料线性增长。
//    这里索引侧剪掉"高频短词"，并给每个会话一个词表上限作为兜底。
import fs from 'node:fs';
import path from 'node:path';
import {
  safeName, ensureDir, readJson, writeJson, removeFile, clamp, num,
  tokenize, formatWhen
} from './util.js';

/**
 * 索引**落盘格式**版本。
 *   v1 → postings 直接存 [块id, tf]，块 id 是一整条字符串
 *   v2 → postings 存 [槽位号, tf]，块 id 统一收进顶层 ids 表（见 packIndex）
 * ⚠️ 内存里的索引结构两者完全一致（永远是 [块id, tf]）——
 *    版本号只描述磁盘上那一份，读写转换全在本文件的两个函数里。
 */
const INDEX_VERSION = 2;
/** 间隔增益的上限（r = log2(1 + 间隔/S)）。防止一次久别重逢把权重和稳定性顶飞。 */
const R_MAX = 4;
/** 共激活联想（v1.7.0）：单块最多记几个"一起被想起"的邻居，防 links 无限长。 */
const LINK_MAX_PER_BLOCK = 12;
/** 共激活联想（v1.7.0）：单个邻居的计数上限，防老交情压过当轮相关性。 */
const LINK_COUNT_MAX = 20;

/**
 * df 剪枝（规则①）的适用面：**只对纯 ASCII 的 1~3 字符 token 生效**。
 *
 * ⚠️ 这是 2026-10-21 第二轮修正的核心。第一版用 `t.length <= 1`（只剪单字），
 *    看起来"只剪功能词"，实际错在前提上 —— **"短词 = 虚词" 在中文里不成立**。
 *    util.js 的 STOP 表已经把「的/了/是/我/在/有/这/那/和/也/就」滤掉了，
 *    所以能留在词表里的中文单字**全是实词**（吃/睡/群/猫/鱼/鱼干），
 *    按 df/n 剪它们等于专挑语料里最常用的实词删。
 *
 *    真正"又短又满篇、没有区分度"的只有英文虚词：the/and/of/in/to/is…
 *    它们必然是纯 ASCII。所以把规则① 收口到 ASCII，中文完全不参与。
 *
 *    中文词表里确实也有 idf→0 的噪声（群号、日期、"qq" 这类块元数据碎片），
 *    但那该由**规则② 的 df×idf 裁剪**自然淘汰 —— 它们 df×idf 极低，
 *    排在被删的尾部；不需要规则① 去"按长度猜它是不是虚词"。
 */
const ASCII_SHORT_TOKEN = /^[a-z0-9_.-]{1,3}$/;

function emptyIndex() {
  return { version: INDEX_VERSION, n: 0, totalLen: 0, postings: {}, blocks: {} };
}

/**
 * 内存索引 → 磁盘格式（v2）。**纯编码变换，不改任何检索语义。**
 *
 * ⚠️ 为什么值得为它专门做一个格式版本：
 *   postings 是索引里唯一的体积大头。实测群 123456789 的索引 2739KB 里
 *   **82% 是 postings**，而其中**光块 id 字符串就占 1109KB** ——
 *   34402 条 posting，每一条都要把 `hour_group_123456789_20261015_16`
 *   这 33 个字原样抄一遍，平均每条 posting 45 字节里 33 字节是重复的 id。
 *   换成「ids 表 + 数字槽位」后一条只剩 `[7,3]`，同样 34402 条的 **df、tf、
 *   词表一个都不变**，所以 BM25 打出来的分、排序、命中集合逐位相同 ——
 *   省的是磁盘和 IO，不是召回。（这条很要紧：之前那版优化清单里
 *   maxVocabPerChat / dfCutoffRatio 才是拿召回换体积的，那些一律没动。）
 *
 * ⚠️ 为什么在**读写边界**上做，而不是把内存索引也改成数字：
 *   内存里保持 `[[blockId, tf]]` 原样，recall.js 的命中循环、tools/selftest.mjs
 *   的编码断言、unindexBlock 的精确摘词**一行都不用改**，改动面被压到本文件。
 *   格式问题就该只在格式边界上解决 —— 越界解决一次，就多一片代码要跟着改。
 *
 * ⚠️ ids 表 = blocks 的键 **∪** postings 里出现过的 id：
 *   后者是"块文件已删、posting 却还留着"的悬挂项，正常不该有（unindexBlock
 *   摘得很干净），但真出现时它对排序没贡献（recall 里取不到 meta 就 continue），
 *   **却会算进 df**（df 直接影响 idf）。所以绝不能借这次改造顺手丢掉，必须原样保住。
 *
 * 槽位号每次落盘按当下 blocks 顺序重排（不留空洞），所以数组是紧的。
 */
export function packIndex(data) {
  const idSet = new Set(Object.keys(data.blocks || {}));
  for (const list of Object.values(data.postings || {})) {
    for (const p of list) idSet.add(p[0]);
  }
  const ids = [...idSet];
  const slot = new Map(ids.map((id, i) => [id, i]));
  const postings = {};
  for (const t of Object.keys(data.postings || {})) {
    const list = data.postings[t];
    const arr = new Array(list.length);
    for (let i = 0; i < list.length; i += 1) arr[i] = [slot.get(list[i][0]), list[i][1]];
    postings[t] = arr;
  }
  return { version: INDEX_VERSION, n: data.n, totalLen: data.totalLen, ids, postings, blocks: data.blocks };
}

/**
 * 磁盘格式 → 内存索引。
 *
 * v2（有 ids 表）→ 把槽位号还原成块 id；v1 或任何认不出的形状 → **原样返回**。
 * 这就是全部的兼容策略：老索引不需要任何迁移脚本，读进来照常检索，
 * 等它下一次因为巩固/命中被写盘时自然变成 v2（见 index() 里的 legacyFormat）。
 */
export function unpackIndex(data) {
  if (!data || !Array.isArray(data.ids) || !data.postings) return data;
  const postings = {};
  for (const t of Object.keys(data.postings)) {
    const list = data.postings[t];
    const arr = new Array(list.length);
    for (let i = 0; i < list.length; i += 1) {
      const e = list[i];
      // 槽位号 → id；万一文件被手改成了字符串（半新半旧），也认，原样留着
      arr[i] = [typeof e[0] === 'number' ? data.ids[e[0]] : e[0], e[1]];
    }
    postings[t] = arr;
  }
  return {
    version: INDEX_VERSION, n: data.n, totalLen: data.totalLen, postings, blocks: data.blocks || {}
  };
}

/** 会话目录名 → chatKey（group_123 → group:123）。 */
function chatKeyOfDirName(dirName) {
  const m = /^(group|private)_(\d+)$/.exec(String(dirName || ''));
  return m ? `${m[1]}:${m[2]}` : null;
}

export class LayeredStore {
  /**
   * @param {string} root            数据根（默认 <DATA_DIR>/memory-v3）
   * @param {() => object} settings  实时读插件设置（热更不用重建实例）
   */
  constructor(root, settings = () => ({})) {
    this.root = path.resolve(root);
    this.settings = typeof settings === 'function' ? settings : () => ({});
    this.indexDir = path.join(this.root, 'index');
    this.blockRoot = path.join(this.root, 'blocks');
    this.stateFile = path.join(this.root, 'state.json');
    ensureDir(this.indexDir);
    ensureDir(this.blockRoot);
    this.state = readJson(this.stateFile, { version: 1, chats: {} });
    if (!this.state.chats) this.state.chats = {};
    /** state.json 有未落盘的改动（权重同步等）。 */
    this.stateDirty = false;
    /** 上次真正写 state.json 的时间（节流用）。 */
    this.lastStateSaveAt = 0;
    /** @type {Map<string, {data: object, dirty: boolean, at: number}>} */
    this.cache = new Map();
  }

  // ── 状态（水位线 + 块元数据）────────────────────────────────────────────

  chatState(chatKey) {
    const k = String(chatKey);
    if (!this.state.chats[k]) {
      this.state.chats[k] = { lastIndexedId: 0, lastTs: 0, lastConsolidatedAt: 0, blocks: {} };
    }
    const s = this.state.chats[k];
    if (!s.blocks) s.blocks = {};
    return s;
  }

  /**
   * 落盘 state.json。
   * ⚠️ 带节流：state.json 是**单文件**（所有会话的块元数据都在里面），
   *    而 markHit / noteBlock 每轮都可能置脏 —— 不节流的话活跃群里就是
   *    "每轮对话重写一次全库元数据"。真需要立刻落盘时传 force。
   */
  saveState({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - (this.lastStateSaveAt || 0) < 30000) {
      this.stateDirty = true;
      return false;
    }
    writeJson(this.stateFile, this.state);
    this.lastStateSaveAt = now;
    this.stateDirty = false;
    return true;
  }

  /**
   * 记一块的元数据，**保留已有字段**（尤其是 score/hits/lastHitAt）。
   *
   * ⚠️ 为什么不能直接赋值 `state.blocks[id] = {...}`：巩固每 10 分钟重写一次块，
   *    如果顺手把元数据覆盖成只有 {kind, dayKey, when}，块积累的"记忆强度"
   *    就每十分钟被抹一次 —— 衰减永远追不上，权重恒等于 1。
   */
  noteBlock(chatKey, blockId, patch = {}) {
    const st = this.chatState(chatKey);
    st.blocks[blockId] = { ...(st.blocks[blockId] || {}), ...patch };
    this.stateDirty = true;
    return st.blocks[blockId];
  }

  listChatKeys() {
    const out = new Set(Object.keys(this.state.chats));
    try {
      for (const f of fs.readdirSync(this.blockRoot, { withFileTypes: true })) {
        if (!f.isDirectory()) continue;
        const k = chatKeyOfDirName(f.name);
        if (k) out.add(k);
      }
    } catch { /* 目录还没建 */ }
    return [...out];
  }

  /**
   * 按"最近活跃"排序的会话 key（全局检索用）。
   *
   * ⚠️ 不能直接 `listChatKeys().slice(0, N)`：那个顺序基本等于"索引建立的先后"，
   *    会话数超过上限时被截掉的恰好可能是**最活跃**的那几个 ——
   *    表现为"明明前几天还聊过，全局搜索就是搜不到"。
   */
  activeChatKeys(limit = 40) {
    const score = (k) => {
      const st = this.state.chats?.[k] || {};
      return Math.max(Number(st.lastConsolidatedAt) || 0, Number(st.lastTs) || 0);
    };
    return this.listChatKeys()
      .map((k) => ({ k, at: score(k) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, Number(limit) || 40))
      .map((x) => x.k);
  }

  // ── 块文件 ──────────────────────────────────────────────────────────────

  chatBlockDir(chatKey) {
    return path.join(this.blockRoot, safeName(chatKey));
  }

  blockPath(chatKey, blockId) {
    return path.join(this.chatBlockDir(chatKey), `${safeName(blockId)}.json`);
  }

  readBlock(chatKey, blockId) {
    return readJson(this.blockPath(chatKey, blockId), null);
  }

  writeBlock(chatKey, block) {
    writeJson(this.blockPath(chatKey, block.id), block);
    return block;
  }

  deleteBlock(chatKey, blockId) {
    return removeFile(this.blockPath(chatKey, blockId));
  }

  listBlockIds(chatKey) {
    try {
      return fs.readdirSync(this.chatBlockDir(chatKey))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  // ── 索引分片 ────────────────────────────────────────────────────────────

  indexPath(chatKey) {
    return path.join(this.indexDir, `${safeName(chatKey)}.json`);
  }

  /**
   * 取内存索引。缺失或为空时**从块文件重建** ——
   * 这样"块写完了但索引没来得及落盘"（崩溃 / 强杀）不会变成永久搜不到，
   * 不需要用户手动触发重建。
   */
  index(chatKey) {
    const k = String(chatKey);
    const hit = this.cache.get(k);
    if (hit) return hit.data;

    const onDisk = readJson(this.indexPath(k), null);
    // ⚠️（2026-10-17 体积优化）磁盘上还是 v2 之前的格式（没有 ids 表）→ 读进来照常
    //    检索，但同时**标脏**：让它下一次落盘就升级成 v2。
    //    这样存量索引不需要任何迁移脚本 —— 被碰到的会话在下一次巩固时自己瘦下来。
    //    没被碰到的会话继续用 v1，也完全正常（unpackIndex 原样返回）。
    const legacy = Boolean(onDisk && onDisk.postings && !Array.isArray(onDisk.ids));
    let data = unpackIndex(onDisk);
    if (!data || !data.postings) {
      data = emptyIndex();
      const ids = this.listBlockIds(k);
      if (ids.length) {
        for (const id of ids) {
          const block = this.readBlock(k, id);
          if (block) this.#indexInto(data, block, k);
        }
      }
    }
    if (!data.blocks) data.blocks = {};
    if (!data.postings) data.postings = {};
    this.cache.set(k, { data, dirty: legacy, at: Date.now() });
    return data;
  }

  /** 标脏 + 按节流落盘。maxAgeMs=0 表示立即写。 */
  flushIndex(chatKey, { force = false, maxAgeMs = 60000 } = {}) {
    const k = String(chatKey);
    const hit = this.cache.get(k);
    if (!hit || !hit.dirty) return false;
    if (!force && Date.now() - (hit.at || 0) < Math.max(0, maxAgeMs)) return false;
    // 内存里是 [块id, tf]，落盘走 v2 编码（块 id 收进 ids 表）——见 packIndex
    writeJson(this.indexPath(k), packIndex(hit.data));
    hit.dirty = false;
    hit.at = Date.now();
    return true;
  }

  flushAll({ force = false } = {}) {
    let n = 0;
    for (const k of [...this.cache.keys()]) if (this.flushIndex(k, { force })) n += 1;
    // 权重/元数据改动过就顺手把 state 落盘（saveState 自己带 30 秒节流）
    if (this.stateDirty) this.saveState({ force });
    return n;
  }

  /**
   * 把一个块写进倒排索引。
   *
   * ⚠️ 记忆强度（score / hits / lastHitAt）**不在块文件里**，而在 state.json 的
   *    块元数据里 —— 所以这里必须带上 chatKey 把它们读回来。否则"索引文件丢失 →
   *    从块文件重建"这条恢复路径会把所有块打回 score=1、hits=0，
   *    正好在崩溃恢复这种最需要保住权重的时刻把权重清空。
   */
  #indexInto(data, block, chatKey) {
    // ⚠️ 2026-10-21：**不把 title 放进索引正文**。
    //    hour 块的 title 固定是 `group:1130798724 @ 2026-10-18 10:00` 这种纯元数据
    //    （实测 107 个块全部如此，零语义），分词后会稳定产出 `group`、群号、
    //    `2026-10-18`、`00` 等 token —— 它们出现在**每一个**块里，df=n、idf→0，
    //    检索时一分都加不出来，却把词表位置占满。实测在"按 df 升序保留"的
    //    第一版裁剪里，排最优先保留位的三个词正是 `1130798724`/`group`/`00`。
    //    块的语义全在 summary / keywords / snippets 里，去掉 title 不损失召回。
    const body = [
      block.summary || '',
      (block.keywords || []).join(' '),
      (block.snippets || []).map((s) => s.text).join('\n')
    ].join('\n');
    const tf = new Map();
    for (const t of tokenize(body)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      if (!data.postings[t]) data.postings[t] = [];
      data.postings[t].push([block.id, n]);
    }
    const first = block.snippets?.[0]?.ts || block.when || 0;
    // 权重来源优先级：内存索引里已有的 > state.json 里记着的 > 出厂值
    const mem = data.blocks[block.id];
    // ⚠️ 2026-10-21：state.chats 用**原始 chatKey** 作键（如 `group:1130798724`），
    //    而块目录 / 索引文件名走 safeName() 转换（`group_1130798724`）。
    //    两者不一致，调用方一旦传成 safeName 形式（离线重建脚本很容易这么干），
    //    这里就静默查不到 → score/hits/S/links 全部退回出厂值，
    //    **整库记忆被重置成"新记忆"而没有任何报错**。加一层 safeName 兜底。
    const rawKey = chatKey ? String(chatKey) : '';
    const saved = rawKey
      ? (this.state.chats?.[rawKey]?.blocks?.[block.id]
        || this.state.chats?.[safeName(rawKey)]?.blocks?.[block.id]
        || null)
      : null;
    const scoreOf = Number(mem?.score) || Number(saved?.score) || 1;
    const hitsOf = Number(mem?.hits) || Number(saved?.hits) || 0;
    const hitAtOf = Number(mem?.lastHitAt) || Number(saved?.lastHitAt) || 0;
    // S（稳定性）与 passiveHits 也必须读回来：
    // ⚠️ 少了 S，"索引文件丢失 → 从块文件重建"这条恢复路径会把每块自己的稳定性
    //    一起清空，全部退回全局 decayHalfLifeDays —— 刚靠间隔重复长出来的"记得牢"
    //    在崩溃恢复时被抹平。这正是第七轮修过的同类 bug（权重归零），
    //    只是换了个字段。0 表示"没有，用全局默认"（见 stabilityOf）。
    const sOf = Number(mem?.S) || Number(saved?.S) || 0;
    const passiveOf = Number(mem?.passiveHits) || Number(saved?.passiveHits) || 0;
    // 共激活链接（v1.7.0）：与其它块"一起被想起"的次数。索引丢了也要从 state 捡回来，
    // 否则崩溃恢复会把联想关系清空 —— 与 score/S 同一个道理（见上面 S 的注释）。
    // 空对象 = 没有邻居，向后兼容老数据。
    const linksOf = (mem?.links && typeof mem.links === 'object') ? mem.links
      : ((saved?.links && typeof saved.links === 'object') ? saved.links : {});
    // 上次被"睡眠重演"带出来的时间（冷却用，v1.7.0）
    const replayAtOf = Number(mem?.lastReplayAt) || Number(saved?.lastReplayAt) || 0;
    // "在场的人"：多线索检索（编码特异性）靠它。从块碎片里现算，不进 state ——
    // 它是块的**派生属性**，块文件才是真相源；写进 state 反而会两边漂移。
    // ⚠️ 必须排除机器人自己（sn.self）：它几乎每个块都出现，
    //    算进去的话"在场的人有交集"就变成"块里有人说过话"，加权等于没加。
    const people = [...new Set(
      (block.snippets || [])
        .filter((sn) => !sn?.self)
        .map((sn) => String(sn?.uid || '').trim())
        .filter(Boolean)
    )].slice(0, 24);
    // 块指纹：检索结果多样性（MMR / 干扰理论）靠它算"这两块是不是同一件事"。
    // ⚠️ 只存前 8 个关键词，且只存在索引元数据里 —— 块文件里本来就有完整 keywords，
    //    这里多存一份是为了让 MMR **不必为了算相似度去读块文件**（每命中一次读一次 IO）。
    //    每块多约 80 字节，相比块文件（几 KB 起）可以忽略。老索引没有这个字段 →
    //    退化成"重叠度 0"，即不惩罚，行为与关闭 MMR 一致（安全降级）。
    const kw = (Array.isArray(block.keywords) ? block.keywords : [])
      .map(String).filter((t) => t.length >= 2).slice(0, 8);
    data.blocks[block.id] = {
      kind: block.kind || 'hour',
      dayKey: block.dayKey || '',
      hourKey: block.hourKey || '',
      timeOfDay: block.timeOfDay || '',
      when: block.when || first,
      title: block.title || '',
      summary: String(block.summary || '').slice(0, 200),
      length: body.length,
      // score 是"命中加权的累计值"，实际排序用 effectiveScore()（再乘时间衰减）
      score: scoreOf,
      hits: hitsOf,
      lastHitAt: hitAtOf,
      S: sOf,
      passiveHits: passiveOf,
      links: linksOf,
      lastReplayAt: replayAtOf,
      people,
      kw,
      // 每块贡献的词清单（= tokenize(body) 的去重结果，与上面写 postings 同一个循环产出）。
      // ⚠️ 为什么在索引里多存一份：unindexBlock 按它精确摘词（O(块内词数)），
      //    否则要遍历整个词表过滤 —— 实测 1000 块 / 10 万词表单次 51ms、
      //    全量重索引 21s，而按清单摘是微秒级。代价约 1~1.5KB/块；
      //    每块在 postings 里本来就占 4~5KB（~250 条 [id, tf]），同量级。
      //    ⚠️ 只进索引、不进 state：它是块的派生属性（块文件才是真相源），
      //    与 kw / people 同一道理。索引丢了就从块文件重建，清单随之重生。
      //    ⚠️ pruneVocab 剪掉的词这里仍列着：摘除时 postings[t] 不存在就跳过，
      //    绝不能为了摘除把被剪掉的词重建回来（见 unindexBlock）。
      terms: [...tf.keys()],
      msgCount: Number(block.msgCount) || 0
    };
    data.totalLen += body.length;
    data.n += 1;
  }

  indexBlock(chatKey, block) {
    const data = this.index(chatKey);
    if (data.blocks[block.id]) this.unindexBlock(chatKey, block.id, { flush: false });
    this.#indexInto(data, block, chatKey);
    this.cache.get(String(chatKey)).dirty = true;
    return true;
  }

  unindexBlock(chatKey, blockId, { flush = true } = {}) {
    const k = String(chatKey);
    const data = this.index(k);
    const meta = data.blocks[blockId];
    if (meta) {
      data.totalLen = Math.max(0, data.totalLen - (Number(meta.length) || 0));
      data.n = Math.max(0, data.n - 1);
      delete data.blocks[blockId];
    }
    // ── 摘词 ──────────────────────────────────────────────────────────────
    // 优先按块自己的词清单精确摘除（O(块内词数)）。没有清单（老索引 / 块不在索引里）
    // 才回退全表扫描 —— 正确但 O(总词表)，该块下次被重新索引时就带上清单了。
    // ⚠️ 每 (词, 块) 正常只有一条 posting（#indexInto 一个词只 push 一次，
    //    且 indexBlock 重索引前会先摘），但数据被手工改坏时可能留多条 ——
    //    用 while 摘干净，与旧的全表 filter 语义保持一致。
    // ⚠️ postings[t] 不存在（已被 pruneVocab 剪掉）就跳过：
    //    摘除绝不重建被剪掉的词，否则剪枝白做。
    const terms = meta && Array.isArray(meta.terms) ? meta.terms : null;
    const scanAll = !terms;
    const keys = scanAll ? Object.keys(data.postings) : terms;
    for (const t of keys) {
      const list = data.postings[t];
      if (!list) continue;
      let i = list.findIndex((p) => p[0] === blockId);
      if (i < 0) continue;
      do {
        list.splice(i, 1);
        i = list.findIndex((p) => p[0] === blockId);
      } while (i >= 0);
      if (!list.length) delete data.postings[t];
    }
    const hit = this.cache.get(k);
    if (hit) hit.dirty = true;
    if (flush) this.flushIndex(k, { force: true });
    return Boolean(meta);
  }

  // ── 剪枝 ────────────────────────────────────────────────────────────────

  /**
   * 词表剪枝：① 高频短词直接扔（它们对检索没区分度，只占体积）
   *              ② 词表超上限时，从 df 最高的开始扔（最没区分度的先走）
   * 长词（≥4 字）不参与 ① —— 那多半是人名/专有名词，即使常见也得留着。
   *
   * ⚠️ 2026-10-21 修「词表塌缩」：旧规则①是 `df/n > 0.7 && t.length <= 3`，
   *    没有样本量下限。块是逐小时累积的，早期 n=2 时任意出现在两个块里的词
   *    df/n 都是 1.0，于是二字实词（旅行/照片/特产…）在库还很小的时候就被
   *    整批删掉；而删除是**永久**的，库变大后不会回来 —— 实测某群 51 块里
   *    「照片」df 仅 2/51 = 3.9%，却不在 postings（块的 terms 里明明有它，
   *    说明是分词产出了、被剪枝删了）。后果：词表 20000 项中中文单字 0 个、
   *    常见二字词大量缺失；查询词不在词表 = 含它的块永远检索不到。
   *
   * ⚠️ 2026-10-21 第二轮（收口到 ASCII）：第一版把长度阈值收到 `t.length <= 1`，
   *    仍然错在同一个前提上 —— **"短词 = 虚词" 在中文里不成立**。
   *    util.js 的 STOP 表已经把「的/了/是/我/在/有/这/那/和/也/就」滤掉了，
   *    所以能留在词表里的中文单字**全是实词**（吃/睡/群/猫/鱼）——
   *    按 df/n 剪它们，剪的不是噪声，是语料里最常用的实词。
   *    真正的"短虚词"只有英文的 the/and/of/in 那批，它们必然是纯 ASCII。
   *    因此规则① 收口成**只对纯 ASCII 短 token 生效**，中文完全不参与。
   *
   *    修法：① 只在 n ≥ minBlocksForCutoff 时启用（小库的 df/n 没有统计意义，
   *          "出现在 2 个块里" 不等于 "出现在 70% 的块里"）；
   *         ② 只剪纯 ASCII 的 1~3 字符 token；中文词一律交给 ② 的上限裁剪，
   *           而上限裁剪按 df×idf 保留（见下）。
   */
  pruneVocab(chatKey, { maxVocab = 100000, dfCutoffRatio = 0.7, minBlocksForCutoff = 2000 } = {}) {
    const k = String(chatKey);
    const data = this.index(k);
    const n = Math.max(1, data.n);
    let dropped = 0;
    // 样本量不足时禁用规则①：n 很小时 df/n 恒为 1.0，按比例剪等于把词表剃光。
    const dfCutoffEnabled = n >= Math.max(1, Number(minBlocksForCutoff) || 2000);
    // ⚠️ 用 for...in 而不是 Object.entries()：后者会把整个词表物化成一个
    //    10 万元素的数组再遍历（实测 65ms/次，而它每个会话每次巩固都跑）。
    const left = [];
    for (const t in data.postings) {
      const list = data.postings[t];
      if (dfCutoffEnabled && list.length / n > dfCutoffRatio && ASCII_SHORT_TOKEN.test(t)) {
        delete data.postings[t];
        dropped += 1;
      } else left.push(t);
    }
    const cap = Math.max(500, Number(maxVocab) || 100000);
    if (left.length > cap) {
      // ⚠️ 2026-10-21 修「超限裁剪方向反了」：旧实现按 df **降序**排、从头删，
      //    删掉的正好是 df 最高的一批词 —— 也就是检索价值最大的那批。
      //    实测后果：词表被削成"只剩 df=1~2 的罕见词"（df 最大值 2），
      //    「照片」「显卡」这类高频实词全部消失，而错别字、偶发短语全留着。
      //
      // ⚠️ 2026-10-21 第二轮：第一版改成"df 升序、从头删"，方向对了但价值函数仍糙 ——
      //    纯按 df 排会让 **idf→0 的词霸占保留位**：实测 df 升序下排最前的三个是
      //    `1130798724`/`group`/`00`（块 id 碎片，df=n，检索零区分度），
      //    而虚词「不」「好」分列第 6、11 名。改成按 **df × idf** 降序保留：
      //      极高频（idf→0）被自身压掉；df=1 的噪声系数只有 1；
      //      中间层实词的乘积最大 —— 正是"剪枝时觉得值得留"与"检索时真能加分"
      //      的同一批词。公式与检索打分用的 idf 完全一致，不留两套口径。
      const idfOf = (df) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const worth = new Map();
      for (const t of left) {
        const df = data.postings[t].length;
        worth.set(t, df * idfOf(df));
      }
      left.sort((a, b) => worth.get(b) - worth.get(a));
      for (let i = cap; i < left.length; i += 1) {
        delete data.postings[left[i]];
        dropped += 1;
      }
    }
    if (dropped) this.cache.get(k).dirty = true;
    return dropped;
  }

  // ── 记忆强度：命中加分 + 时间衰减 ────────────────────────────────────────

  /**
   * 块自己的稳定性 S（天）—— 相当于"这块的半衰期"。
   *
   * ⚠️ 为什么不能再用全局常量：人的遗忘速度不是一个全局常数。
   *    反复成功提取的东西，衰减本身就变慢了；插件原来给每个块都发 45 天，
   *    于是"被想起 10 次的老朋友"和"上周刚听说的闲话"衰减得一样快。
   *    S 随每次成功回忆增长（见 markHit），这里只是读。
   *
   * 向后兼容：老块没有 S 字段 → 回落到全局 decayHalfLifeDays（= 旧行为）。
   *
   * ⚠️ 必须自己判断"有没有 S"，不能直接 `num(meta.S, fallback, 1, 3650)`：
   *    num() 只对 undefined/null/'' 用 fallback，`S: 0`（索引重建时"没有就写 0"）
   *    会被夹成下限 **1** —— 于是"没有稳定性"变成"半衰期 1 天"，
   *    老块会在两天内被衰减到淘汰线以下然后删光。0 与"缺失"必须同义。
   */
  stabilityOf(meta) {
    const fallback = num(this.settings()?.decayHalfLifeDays, 45, 1, 3650);
    const raw = Number(meta?.S);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.min(3650, Math.max(1, raw));
  }

  /**
   * 有效权重 = 累计命中分 × 衰减(距上次命中的天数, 稳定性 S)。
   *
   * 衰减用 **Weibull 形状**：`0.5 ^ ((t/S) ^ q)`，q 默认 0.7。
   *   · q = 1 → 就是原来的纯指数 `0.5^(t/S)`，语义不变（t = S 时仍是 0.5）
   *   · q < 1 → **早期掉得更快、后面拖一条长尾**，这才是人类保持率的实测形状。
   *     纯指数掉得太干净：90 天 0.250 → 180 天 0.063（8 倍），而人是 0.324 → 0.161（2 倍）。
   *
   * **自发恢复（v1.7.0）**：人的保持率不是单调下降的 —— 忘得死死的记忆搁置一阵后，
   * "突然又有点想起来"（Humphreys 痕迹复苏）。于是在深忘区（t > 3S）之后叠加一个
   * 自己也随时间衰减的复苏项，整体呈"沉下去 → 弹一下 → 归于没有"。
   *
   * 注意是**派生值**，不在每次巩固时反复相乘 —— 否则衰减会被重复施加，
   * 块会在几天内被"衰减到死"（内置版没这个问题只是因为它压根没衰减）。
   */
  effectiveScore(meta, now = Date.now()) {
    if (!meta) return 0;
    const base = clamp(meta.score || 1, 0.05, 3);
    const anchor = Number(meta.lastHitAt) || Number(meta.when) || now;
    const ageDays = Math.max(0, (now - anchor) / 86400000);
    const S = this.stabilityOf(meta);
    const q = num(this.settings()?.decayShape, 0.7, 0.1, 1);
    let decayed = base * Math.pow(0.5, Math.pow(ageDays / S, q));
    // ── 自发恢复（痕迹复苏，v1.7.0）────────────────────────────────────────
    // ⚠️ 复苏幅度必须远小于淘汰线：两项最终都趋 0，终局淘汰是有保证的，
    //    但幅度不封顶的话（用户把 minForgetScore 调到 0.05 之类），
    //    "弹一下"就能把块永久托在淘汰线之上 —— 库只进不出。
    //    这里按 minForgetScore 的 40% 封顶，帽子只是让"弹一下"别太夸张。
    const amp = Math.min(
      num(this.settings()?.reminiscenceAmp, 0.12, 0, 1),
      0.4 * num(this.settings()?.minForgetScore, 0.25, 0.01, 3)
    );
    if (amp > 0 && ageDays > 3 * S) {
      decayed += amp * Math.pow(0.5, (ageDays - 3 * S) / (4 * S));
    }
    return clamp(decayed, 0.05, 3);
  }

  /**
   * 检索命中 → 记忆增强。
   *
   * ── 为什么增益要看"间隔"而不是固定 ×1.15 ────────────────────────────────
   * 人的记忆里，**间隔**才是决定强度的变量（间隔重复效应）：隔了两个月突然想起来，
   * 比一分钟内连想八遍记得牢得多。原来固定 ×1.15 + 封顶 3，导致
   * 「半小时内被反复注入 8 次」和「八个月里陆续想起 8 次」**结果完全一样**
   * （都封顶 3、半衰期都是 45 天）—— 正好和人相反。
   *
   * 现在：r = log2(1 + 间隔天数 / S)，间隔 = S 时退化成原来的 1.15（严格推广）。
   *   · 间隔 ≈ 0（同一轮里被反复注入）→ 增益 ≈ 1.00，顺手掐断
   *     "越被注入越强 → 越强越被注入"那个正反馈环
   *   · 间隔 = S → 增益 = hitBoost（= 旧行为）
   *   · 间隔 ≫ S → 增益更大，但被 R_MAX 封住，免得一次久别重逢就把权重顶飞
   *
   * 稳定性同步增长：ΔS ≈ gain × 1.4427 × 间隔（S ≫ 间隔 时），
   * 也就是"每成功回忆一次，稳定性大约增加 1.4 倍间隔"。
   *
   * @param {{mode?: 'full'|'passive', boost?: number}} [opts]
   *   full    = 真的"回忆"了（模型主动调检索工具）→ 按间隔加分 + 增长稳定性
   *   passive = 只是被动看到（每轮自动注入塞进提示词）→ **一个字节都不改**
   */
  markHit(chatKey, blockId, opts = {}) {
    const k = String(chatKey);
    const data = this.index(k);
    const meta = data.blocks[blockId];
    if (!meta) return false;

    const mode = typeof opts === 'string' || typeof opts === 'number'
      ? 'full'                                    // 兼容旧签名 markHit(k, id, 1.15)
      : (opts?.mode || 'full');
    const s = this.settings();

    // ── 被动看到：只记一个计数，不动权重、不动稳定性、**也不动衰减锚点** ──
    // ⚠️ 曾经想让它"刷新 lastHitAt 但不加分"（听着更像人：看过就眼熟）。
    //    实测推演下来那是错的：锚点一刷新，effectiveScore ≈ score ≈ 1 永远大于淘汰阈值，
    //    于是**凡是被自动注入过的块全都长生不老** —— 库会无限膨胀。
    //    人的"眼熟"确实存在，但它换来的是**识别**不是**回忆**，工程上不该拿权重表达。
    if (mode !== 'full') {
      meta.passiveHits = (Number(meta.passiveHits) || 0) + 1;
      this.noteBlock(k, blockId, { passiveHits: meta.passiveHits });
      return true;
    }

    const now = Date.now();
    const anchor = Number(meta.lastHitAt) || Number(meta.when) || now;
    const gapDays = Math.max(0, (now - anchor) / 86400000);
    const S0 = this.stabilityOf(meta);
    const r = Math.min(R_MAX, Math.log2(1 + gapDays / S0));
    const boost = num(opts?.boost ?? s.hitBoost, 1.15, 1, 2);

    meta.hits = (Number(meta.hits) || 0) + 1;
    meta.lastHitAt = now;
    meta.score = clamp((Number(meta.score) || 1) * (1 + (boost - 1) * r), 0.05, 3);
    const gain = num(s.stabilityGain, 1.0, 0, 5);
    meta.S = clamp(S0 * (1 + gain * r), 1, num(s.stabilityMax, 3650, 45, 36500));
    // 睡眠重演记账（v1.7.0）：这次是"被主动带出来复习"，冷却按它算
    if (opts.replay === true) meta.lastReplayAt = now;
    // ── 共激活联想（v1.7.0）：一起被想起的块结缘 ──
    // 人的记忆里，"当时一起想到的事"会互相成为提取线索（Hebb：一起激活的连在一起）。
    // ⚠️ 只有**主动检索**（full）才结缘：被动注入是"被看到"，不是"一起想到"，
    //    那条路径的纪律（见上面 passive 分支）在这里同样适用。
    if (opts.linkLearn !== false && Array.isArray(opts.withIds) && opts.withIds.length) {
      this.#linkTogether(data, k, blockId, opts.withIds);
    }
    this.cache.get(k).dirty = true;
    // 同步进 state：索引文件万一丢了/坏了，重建时还能把"记忆强度"捡回来
    this.noteBlock(k, blockId, {
      score: meta.score, hits: meta.hits, lastHitAt: meta.lastHitAt, S: meta.S,
      ...(meta.links ? { links: meta.links } : {}),
      ...(meta.lastReplayAt ? { lastReplayAt: meta.lastReplayAt } : {})
    });
    return true;
  }

  /**
   * 共激活结缘：把 blockId 与 withIds 互相记进对方的 links（计数 +1）。
   * 双重上限：单块最多 LINK_MAX_PER_BLOCK 个邻居（超出踢计数最小的），
   * 单个邻居计数最多 LINK_COUNT_MAX（防老交情压过当轮相关性）。
   * ⚠️ 两边都要写 state —— links 和 score/S 一样活在"索引 + state"两份里，
   *    只写索引的话崩溃重建就把联想关系清了（见 #indexInto 里 S 的注释）。
   */
  #linkTogether(data, chatKey, blockId, withIds) {
    const seen = new Set([blockId]);
    for (const raw of withIds) {
      const other = String(raw || '');
      if (!other || seen.has(other)) continue;
      seen.add(other);
      for (const [a, b] of [[blockId, other], [other, blockId]]) {
        const meta = data.blocks[a];
        if (!meta) continue;
        const links = meta.links || (meta.links = {});
        const prev = Number(links[b]) || 0;
        if (prev > 0 && prev >= LINK_COUNT_MAX) continue;
        links[b] = prev + 1;
        const keys = Object.keys(links);
        if (keys.length > LINK_MAX_PER_BLOCK) {
          keys.sort((p, q2) => (Number(links[q2]) || 0) - (Number(links[p]) || 0));
          delete links[keys[keys.length - 1]];
        }
        this.noteBlock(chatKey, a, { links: data.blocks[a].links });
      }
    }
  }

  /**
   * 睡眠重演（v1.7.0）：挑"现在该复习了"的块 —— 间隔重复的最优难度区间。
   *
   * 人的睡眠巩固会重放"还没忘干净、但也快忘了"的记忆（gap ≈ S，R ≈ 0.6~0.9）：
   * 太熟的（gap ≪ S）重放没收益，太生的（R 太低）重放也救不回来。
   * 挑选条件全部按当前公式实算，不另存一套状态：
   *   · 距上次命中 gap ∈ [0.8S, 2.5S]（中心 S，与 markHit 的增益峰值对齐）
   *   · 有效权重 R ∈ [0.5, 0.95]（"还想得起来"区间）
   *   · 距上次重演 ≥ replayCooldownDays（防连着几轮重演同一块）
   * 返回按 |log(gap/S)| 升序的块 id —— 越接近最优间隔越优先。
   *
   * @param {string} chatKey
   * @param {{now?: number, limit?: number}} [opts]
   * @returns {string[]}
   */
  dueReviews(chatKey, { now = Date.now(), limit = 1 } = {}) {
    const data = this.index(String(chatKey));
    const s = this.settings();
    const cooldownMs = num(s.replayCooldownDays, 3, 0.5, 30) * 86400000;
    const out = [];
    for (const [id, meta] of Object.entries(data.blocks)) {
      const S = this.stabilityOf(meta);
      const anchor = Number(meta.lastHitAt) || Number(meta.when) || now;
      const gapDays = Math.max(0, (now - anchor) / 86400000);
      if (gapDays < 0.8 * S || gapDays > 2.5 * S) continue;
      const R = this.effectiveScore(meta, now);
      if (R < 0.5 || R > 0.95) continue;
      const lastReplay = Number(meta.lastReplayAt) || 0;
      if (lastReplay && now - lastReplay < cooldownMs) continue;
      out.push({ id, dist: Math.abs(Math.log((gapDays + 1) / S)) });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, Math.max(1, Number(limit) || 1)).map((x) => x.id);
  }

  /**
   * 淘汰扫描：把"够老 + 有效权重低于阈值"的块摘出索引并删掉块文件。
   *
   * @param {{forgetAfterDays?: number, minScore?: number|null, onEvict?: Function}} opts
   *   onEvict(blockId, meta, block) 在**删块之前**调用 —— 梗概墓碑靠它留线索。
   *   ⚠️ 回调抛错不能中断淘汰：墓碑只是"额外的线索"，留不下来也不该让库删不动。
   * @returns {string[]} 被淘汰的块 id
   */
  forgetSweep(chatKey, { forgetAfterDays = 120, minScore = null, onEvict = null } = {}) {
    if (!(Number(forgetAfterDays) > 0)) return [];
    const floor = num(minScore, num(this.settings()?.minForgetScore, 0.25, 0.01, 3), 0.01, 3);
    const now = Date.now();
    const cutoff = now - Number(forgetAfterDays) * 86400000;
    const data = this.index(chatKey);
    const doomed = [];
    for (const [id, meta] of Object.entries(data.blocks)) {
      const when = Number(meta.when) || 0;
      if (when && when > cutoff) continue;
      if (this.effectiveScore(meta, now) > floor) continue;
      doomed.push(id);
    }
    for (const id of doomed) {
      // 先留墓碑再删块：反过来就读不到块内容了
      if (typeof onEvict === 'function') {
        try {
          const block = this.readBlock(chatKey, id);
          if (block) onEvict(id, data.blocks[id] || {}, block);
        } catch { /* 墓碑失败不阻塞淘汰 */ }
      }
      this.unindexBlock(chatKey, id, { flush: false });
      this.deleteBlock(chatKey, id);
      delete this.chatState(chatKey).blocks[id];
      this.stateDirty = true;
    }
    return doomed;
  }

  /**
   * 摘掉一个"索引里有、块文件却没了"的项（懒自愈）。
   *
   * ⚠️ 只在**真的检索撞上它**的时候才修，**不做全量扫描** ——
   *    全量扫描要在每次巩固时把每个会话的每个块都 stat 一遍，
   *    而这种不一致在真实场景里极罕见（只有手动删文件 / 磁盘出错才会出现），
   *    为它付出固定开销不划算。不做自愈的后果只是"这一轮少一条命中"，
   *    放任不管则会让 `stats().blocks` 长期虚高、每次都白占一个 top-N 名额。
   *
   * @returns {boolean} 是否真的摘掉了
   */
  dropDangling(chatKey, blockId) {
    const k = String(chatKey);
    const data = this.index(k);
    if (!data.blocks[blockId]) return false;
    this.unindexBlock(k, blockId, { flush: false });
    delete this.chatState(k).blocks[blockId];
    this.stateDirty = true;
    return true;
  }

  /** 索引规模（记忆状态页 / memory.status 用）。 */
  stats(chatKey = null) {
    const keys = chatKey ? [String(chatKey)] : this.listChatKeys();
    let blocks = 0;
    let vocab = 0;
    let postings = 0;
    for (const k of keys) {
      const data = this.index(k);
      blocks += Object.keys(data.blocks).length;
      vocab += Object.keys(data.postings).length;
      for (const list of Object.values(data.postings)) postings += list.length;
    }
    return { chats: keys.length, blocks, vocab, postings, root: this.root };
  }

  /** 块元数据（检索排序用，不读块文件）。 */
  blockMeta(chatKey, blockId) {
    return this.index(chatKey).blocks[blockId] || null;
  }

  /** 把块元数据转成"给模型看"的碎片（复用内置的字段形状，便于宿主技能直接消费）。 */
  buildHit(chatKey, blockId, score, { query = '', maxSnippets = 5 } = {}) {
    const block = this.readBlock(chatKey, blockId);
    if (!block) return null;
    const meta = this.blockMeta(chatKey, blockId) || {};
    const q = new Set(tokenize(query));
    const isQuestiony = (text) => /(吗|么|呢|什么|啥|谁|哪|几|多少|来着|是不是|还记得)/.test(String(text || ''));
    let snippets = [...(block.snippets || [])];
    if (q.size) {
      snippets = snippets.sort((a, b) => {
        const sa = tokenize(a.text || '').filter((t) => q.has(t)).length + (a.self ? 0.2 : 0) - (isQuestiony(a.text) ? 0.8 : 0);
        const sb = tokenize(b.text || '').filter((t) => q.has(t)).length + (b.self ? 0.2 : 0) - (isQuestiony(b.text) ? 0.8 : 0);
        return sb - sa;
      });
    }
    return {
      // 字段名与内置版保持一致：宿主自带的 skills/memory-recall 不需要任何改动
      chunkId: blockId,
      chatKey: block.chatKey,
      dayKey: block.dayKey,
      hourKey: block.hourKey || '',
      kind: block.kind,
      title: block.title,
      when: formatWhen(meta.when || block.when),
      score: Math.round(score * 100) / 100,
      hits: Number(meta.hits) || 0,
      summary: String(block.summary || '').slice(0, 80),
      snippets: snippets.slice(0, maxSnippets).map((s) => ({
        when: formatWhen(s.ts).slice(5, 16),
        ts: s.ts,
        // ⚠️ mid / localId 必须一起带出来：调用方（inject.js）靠它做**碎片级**
        //    跨轮去重。只带 chunkId 不够 —— 同一个块这一轮是小时块、下一轮被
        //    rollup 成日块后 chunkId 就变了，靠块 id 判"这条给过了"会漏，
        //    于是同一句原话隔一轮又被注入一遍（纯浪费 token，还没有新信息）。
        mid: s.mid ?? null,
        localId: s.localId ?? null,
        who: s.who,
        self: !!s.self,
        text: String(s.text || '').slice(0, 120)
      }))
    };
  }
}
