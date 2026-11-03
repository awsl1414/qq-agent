// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { atomicWriteJson } from './atomic-write.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
// 内存缓存的会话数上限。120 个会话 × 单会话消息上限，是"常驻内存不失控"
// 与"活跃会话不反复读盘"的平衡点；被淘汰的会话下次访问重读磁盘（单文件毫秒级），行为无感。
const MAX_CACHED_CHATS = 120;

// 元信息里 lastText 的保留长度（见 getChatMeta 的注释）：它只用于列表预览，
// 消费方最多取前 30 字。定 200 是给 UI 一行留足余量，同时给 4000 条缓存封顶。
const CHAT_META_LAST_TEXT_MAX = 200;

// ── 存档落盘节流 ────────────────────────────────────────────────────────
//
// 问题：saveChat 是同步全量重写（writeFileSync + renameSync），而
// appendIncoming / appendSelf 在 ingest 热路径上每条消息都无条件调用它。
// 单群存档长到 1MB 时一次写约 5~15ms，全部记在主进程的 event loop 账上，
// 群里连续来消息时，排在后面的 SSE 广播 / HTTP 响应 / agent 轮次一起被拖慢。
//
// 对照：sessions.js 早就为会话文件做了 2 秒节流（#persistThrottled），
// 只有 store 的消息存档漏了。
//
// 语义：节流（leading + trailing）而不是防抖。
//   窗口内第一次调用立刻写；窗口内的后续调用只登记"这份状态待写"，由尾随定时器
//   在窗口结束时补写一次。若用防抖，一个持续来消息的群会把落盘无限推迟
//   （每条消息都重置计时器），那不是节流，是"永远不写"。
//
// 可靠性：崩溃/断电最多丢 SAVE_THROTTLE_MS 毫秒的消息。正常退出走
//   flushPendingSaves()（app.js 的 stop() 与两条强制退出兜底都会调），
//   所以"点退出后消息还在"这条不受影响。
const SAVE_THROTTLE_MS = 300;
const saveLastAt = new Map();      // chatKey -> 上次真正落盘的时刻
const savePending = new Map();     // chatKey -> { state, timer }（待落盘）

/** 取消某会话的待落盘（数据移植前必须调，否则旧内容会盖上刚导入的新内容）。 */
function cancelPendingSave(key) {
  const pend = savePending.get(key);
  if (pend) {
    try { clearTimeout(pend.timer); } catch { /* ignore */ }
    savePending.delete(key);
  }
  saveLastAt.delete(key);
}

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function loadChat(chatKey) {
  const file = chatFile(chatKey);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 文件不存在 = 真的新会话，正常返回空状态。
    // 但其它读失败（权限、目录、文件锁）不能一律当"新会话"，
    // 那会让人以为聊天记录是空的，实际上是读不出来，且无处可查。
    if (error?.code !== 'ENOENT') {
      logger.error('store', `读取 ${file} 失败：${error?.message ?? error}`);
    }
    return { chatKey, nextLocalId: 1, messages: [] };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) {
      // 合法 JSON 但缺 nextLocalId（或被手改坏）时兜底为 1。原样返回的话，
      // `st.nextLocalId++` 产出 NaN，之后所有本地 id 都是 NaN，
      // 消息去重、转发展开、金句引用全对不上。
      if (!Number.isFinite(Number(parsed.nextLocalId))) parsed.nextLocalId = 1;
      return parsed;
    }
    throw new Error('结构异常：缺少 messages 数组');
  } catch (error) {
    // 损坏必须显式处理，不能静默回落成"新会话"。
    // 把「文件不存在」和「JSON 解析失败」当成同一件事的话，文件损坏时返回空状态，
    // 而下一条消息到达就会用 1 条内容覆盖写上去，全部历史不可恢复、无日志、无备份。
    // 实测：预先写入截断的 JSON，再 append 一条，文件变成 1 条，损坏前的内容静默消失。
    // store 是「真相源、不可再生」，所以照 config.js 的 `preserveSanitizedSecrets`
    // 已有现成范式做：先备份成 .corrupt-<ts>，再回落，并明确告知用户去抢救。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.corrupt-${stamp}`;
    try {
      fs.copyFileSync(file, backup);
      logger.error('store', `${chatFile(chatKey)} 已损坏（${error?.message ?? error}），原文件已备份到 ${backup}，请尽快人工抢救`);
    } catch (e) {
      logger.error('store', `${chatFile(chatKey)} 已损坏（${error?.message ?? error}），且备份失败：${e?.message ?? e}`);
    }
    // 回落：损坏文件保留在磁盘上不删，只在内存里当作空会话。
    // 绝不能在这里"顺手清理"，否则用户连抢救的原料都没有了。
    return { chatKey, nextLocalId: 1, messages: [], __corrupted: true, __corruptBackup: backup };
  }
}

/** 真正落盘一份存档（同步全量重写）。失败返回 false，不抛。 */
function saveChatNow(state) {
  // 改走 src/atomic-write.js 的统一实现（原来是本文件自己写的一份 tmp+rename）。
  // atomicWriteText 语义是其严格超集：同样的原子 rename，另加失败时清掉临时文件，
  // 写失败（磁盘满 / 权限）时不再往存档目录堆 .tmp 垃圾。
  if (!atomicWriteJson(chatFile(state.chatKey), state, 1)) return false;
  return true;
}

/**
 * 落盘一份存档（按会话节流，见 SAVE_THROTTLE_MS 的注释）。
 *
 * @param {object} state
 * @param {{immediate?: boolean}} [opts] immediate=true 跳过节流立刻写（测试 / 关键路径用）
 */
function saveChat(state, { immediate = false } = {}) {
  // 损坏判定必须在写 tmp 之前。放在后面的话，损坏状态会在内存缓存里长期为真，
  // 于是每条消息都会先写一个 <file>.<pid>.tmp 再被拒绝，磁盘上持续堆积无用文件。
  //
  // 这里选择拒绝写入并保留原文件：宁可"这条消息暂时存不下"，
  // 也不能悄悄毁掉别人整段群聊历史（原实现会静默覆盖成 1 条）。
  // 这条判定不参与节流，必须在每次调用时立刻生效。
  if (state.__corrupted) {
    logger.error('store', `会话 ${state.chatKey} 的存档此前已损坏，为避免覆盖原始内容，本次写入已被拒绝。请先处理备份文件 ${state.__corruptBackup || '(无)'}。`);
    return false;
  }

  const key = String(state.chatKey);
  const now = Date.now();
  const last = saveLastAt.get(key) || 0;

  // 立刻写：显式要求，或已出节流窗口
  if (immediate || now - last >= SAVE_THROTTLE_MS) {
    saveLastAt.set(key, now);
    const pend = savePending.get(key);
    if (pend) {                     // 有尾随定时器挂着 → 本次已是最新内容，取消它
      try { clearTimeout(pend.timer); } catch { /* ignore */ }
      savePending.delete(key);
    }
    return saveChatNow(state);
  }

  // 窗口内：登记待写。同一会话只挂一个定时器。state 是活对象（缓存里那一份），
  // 期间发生的后续改动会自动包含在这次写入里，不需要重新入队。
  const pend = savePending.get(key);
  if (pend) { pend.state = state; return true; }
  const timer = setTimeout(() => {
    savePending.delete(key);
    saveLastAt.set(key, Date.now());
    try { saveChatNow(state); } catch (e) { logger.error('store', `延迟落盘 ${key} 失败：${e?.message ?? e}`); }
  }, Math.max(1, SAVE_THROTTLE_MS - (now - last)));
  // 不因"等落盘"把进程钉住：这个定时器不该阻止进程退出（退出前有显式 flush）。
  try { timer.unref?.(); } catch { /* 某些运行时不支持 */ }
  savePending.set(key, { state, timer });
  return true;
}

/**
 * 把所有待落盘的存档立刻写下去，返回写了几份。
 *
 * 必须在进程退出前调用（app.js 的 stop()、以及 main.js 两条强制退出兜底）。
 * 不调的话，退出前最后 SAVE_THROTTLE_MS 毫秒内收到的消息会丢，
 * 那正是用户"刚看到消息就关程序"的场景，丢得最容易被察觉。
 */
export function flushPendingSaves() {
  let n = 0;
  for (const [key, pend] of [...savePending]) {
    savePending.delete(key);
    try { clearTimeout(pend.timer); } catch { /* ignore */ }
    saveLastAt.set(key, Date.now());
    try {
      if (saveChatNow(pend.state)) n += 1;
    } catch (e) {
      logger.error('store', `退出落盘 ${key} 失败：${e?.message ?? e}`);
    }
  }
  return n;
}

export class ChatStore {
  constructor(maxPerChat = 0, maxCachedChats = MAX_CACHED_CHATS) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    // 内存缓存上限。只增不减、且 listChats() 把磁盘上每个会话文件都读进缓存
    // （/api/chats 走这条路，UI 每 15 秒轮询一次）的话，群多/运行久时内存线性无界增长。
    // 最小 1，避免配成 0 后退化成"每次访问都读盘"。
    this.maxCachedChats = Math.max(1, Number(maxCachedChats) || MAX_CACHED_CHATS);
    this.chats = new Map(); // chatKey -> state（按最近使用排序，见 #state）
    // 会话元信息缓存（键 = chatKey，值 = { stamp, meta }）。
    // 见 getChatMeta() 的注释，这是"卡界面"的主修之一。
    this.chatMeta = new Map();
    // 元信息缓存的条数上限。
    //
    // 4000 与相邻 MAX_CACHED_CHATS=120 差 33 倍，但两个缓存服务的对象不同：
    //   - chats（120）缓存整个消息数组，很贵；只让活跃会话留在内存。
    //   - chatMeta（本项）缓存的是"文件 (mtime,size) → 摘要"，唯一用途是让
    //     /api/chats 与 list-chats 不必对磁盘上每个会话 readFileSync + JSON.parse。
    //     而那个循环天然要遍历磁盘上的全部会话（本机实测 2277 个），上限若压到 120
    //     会让缓存每轮全部失配，退回每次轮询解析上千个文件，正是修掉的那个"界面卡死"。
    // 所以 4000 是有依据的：要盖住"磁盘上所有会话"并给历史增长留余量。
    // 单条目成本由 CHAT_META_LAST_TEXT_MAX 兜住（见 getChatMeta）。
    this.maxChatMeta = 4000;
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  /**
   * 失效某个会话的内存缓存（数据移植用）。
   * 磁盘上的 messages/<会话>.json 被外部改写后，内存里的旧状态会在下次
   * saveChat 时反向覆盖导入内容，必须先丢掉缓存，下次访问重读磁盘。
   * @returns {boolean} 该会话此前是否在内存中
   */
  invalidate(chatKey) {
    // 元信息缓存必须一起失效：数据移植/外部改写后它记的是旧条数与旧末条。
    this.chatMeta.delete(String(chatKey));
    // 待落盘的存档也必须取消：否则那个尾随定时器会在导入完成后
    // 把导入前的旧内容写回去，把刚移植进来的数据当场盖掉。
    cancelPendingSave(String(chatKey));
    return this.chats.delete(String(chatKey));
  }

  /** 立刻落盘所有待写存档（进程退出前调用）。见 saveChat 的节流注释。 */
  flushPendingSaves() {
    return flushPendingSaves();
  }

  /**
   * 取（必要时读盘并缓存）某会话的状态。
   *
   * LRU 淘汰 + 键归一化：
   *   - Map 的迭代顺序 = 插入顺序，所以"删掉再插回"即把该项移到最新端；
   *     需要淘汰时从头部（最久未用）开始删。
   *   - 键统一 String(chatKey)：invalidate() 本来就按 String 删，两处口径原本不一致
   *     （非字符串键会漏删，留下一个永远不会被访问到的幽灵条目）。
   *   - 损坏态（__corrupted）不淘汰：loadChat 每次读到坏文件都会再写一份
   *     .corrupt-<ts> 备份，若把它反复淘汰/重读，就会不断产生备份文件。
   */
  #state(chatKey) {
    const key = String(chatKey);
    const cached = this.chats.get(key);
    if (cached === undefined) {
      const st = loadChat(key);
      this.chats.set(key, st);
      this.#evictIfNeeded(key);
      return st;
    }
    // LRU 触碰：移到最新端
    this.chats.delete(key);
    this.chats.set(key, cached);
    return cached;
  }

  /** 超出上限时从最久未用的开始淘汰（跳过刚加入的与损坏态）。 */
  #evictIfNeeded(justAdded) {
    if (this.chats.size <= this.maxCachedChats) return;
    for (const [key, st] of this.chats) {
      if (this.chats.size <= this.maxCachedChats) return;
      if (key === justAdded) continue;
      if (st && st.__corrupted) continue;   // 见 #state 注释：损坏态必须常驻
      // 有待落盘内容的会话不能淘汰：尾随定时器还持着这份 state 引用，
      // 淘汰后它下次访问会从磁盘（还没含本次改动）重读，然后被延迟写入覆盖，
      // 表现为"某条消息写了又没了"。等落盘完成后自然可淘汰。
      if (savePending.has(key)) continue;
      this.chats.delete(key);
    }
  }

  /**
   * 列出磁盘上的全部会话（而不是"内存缓存里幸存的那些"）。
   *
   * 本方法若走"逐个 #state() 再返回缓存 keys"，加上 120 的缓存上限后返回值会悄悄
   * 从"磁盘上全部会话"变成"缓存里幸存的 ≤120 个"（曾踩过的回归：淘汰从 Map 头部
   * 开始、磁盘列目录是字典序，活下来的就成了字典序最大的 120 个，与活跃度完全无关）。
   * 正确语义本就是"磁盘上的会话清单"，直接从文件名还原即可：不读文件内容，
   * 也不该借道缓存，顺手还避免了"为了列个清单把所有会话都灌进缓存再淘汰掉"。
   * 调用方拿到 key 后按需走 #state()。
   */
  listChats() {
    try {
      const out = [];
      for (const f of fs.readdirSync(MESSAGES_DIR)) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) out.push(`${m[1]}:${m[2]}`);
      }
      return out;
    } catch (error) {
      // 目录还不存在（一条消息都没收到过）→ 退回"缓存里已知的"，至少不是空。
      // 其它失败（EACCES/EMFILE/占用）不能静默吞掉，那会返回不完整的会话
      // 列表且无任何日志。与 loadChat 的处理范式对齐。
      if (error?.code !== 'ENOENT') {
        logger.error('store', `列举会话目录失败：${error?.message ?? error}`);
      }
      return [...this.chats.keys()];
    }
  }

  /**
   * 会话摘要（条数 / 未读数 / 最后一条）。
   *
   * 本方法原来是"纯读盘"：`#state()` 对不在 LRU 缓存里的会话一律 readFileSync +
   * JSON.parse 一整份。而 /api/chats 与 list-chats 工具都是对磁盘上每个会话循环
   * 调用它（routes.js 的用量接口 / tools.js 的 `send_message`），UI 又每 15 秒
   * 轮询一次 /api/chats。于是历史会话一多（实测有 2277 个文件的实例，单群存档可达
   * 1MB），主进程每 15 秒就同步读+解析上千个文件，事件循环被占满，
   * 窗口/HTTP/agent 一起卡住，用户看到的就是"界面卡死不动"。
   *
   * 修法：摘要只依赖文件内容，所以拿 (mtimeMs, size) 当版本号做缓存。
   * 文件没变就直接返回（一次 statSync，比 read+parse 便宜两三个数量级）；
   * 文件变了（新消息落盘 / 数据移植）自然失效重算。stat 本身失败（文件还没
   * 写过）时不缓存，走原来的实读路径。
   */
  getChatMeta(chatKey) {
    const key = String(chatKey);
    let stamp = null;
    try {
      const st = fs.statSync(chatFile(key));
      stamp = `${st.mtimeMs}:${st.size}`;
      const hit = this.chatMeta.get(key);
      if (hit && hit.stamp === stamp) {
        // 返回浅拷贝：调用方（routes/tools）会做 { ...meta } 展开，
        // 但别让任何一处意外改到缓存里的那份。
        return { ...hit.meta };
      }
    } catch { /* 文件不存在/读不到 stat → 不缓存，走下面的实读 */ }

    const st = this.#state(key);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    // lastText 是每条元信息里唯一不定长的字段，而条目上限 4000：一条长消息
    // （转发的合并聊天记录、长文）就是几千字符，乘 4000 是实打实的内存。
    // 它的用途只有两处：列表页的一行预览（CSS 本来就会截断）与 list-chats 工具的
    // 前 30 字摘要，没有任何消费者需要全文。所以在构建时统一截断，
    // 缓存命中与未命中两条路径走同一个 meta，不会出现"有时截有时不截"。
    const meta = {
      chatKey: key,
      total: st.messages.length,
      unread,
      lastTs: last?.ts ?? 0,
      lastText: String(last?.text ?? '').slice(0, CHAT_META_LAST_TEXT_MAX)
    };
    if (stamp) {
      this.chatMeta.set(key, { stamp, meta });
      // 超上限：按插入顺序淘汰最旧的（与 #evictIfNeeded 同一思路，但这里
      // 没有"损坏态必须常驻"的例外，元信息随时可重算，淘汰零风险）。
      while (this.chatMeta.size > this.maxChatMeta) {
        const oldest = this.chatMeta.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        this.chatMeta.delete(oldest);
      }
    }
    return meta;
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, pokeSelf = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【过去状态】
      isPoke: Boolean(isPoke),
      // 拍一拍是不是拍机器人自己（入库时的身份判定真值）。
      // 档位判定用它而不是正则猜文本：被拍者名字以"我"开头时
      // （如"我还能哈气喵"）正则 /拍了拍\s*我/ 会误判成"拍我"。
      // null = 老存档（没有该字段），下游按正则兜底。
      ...(pokeSelf === null || pokeSelf === undefined ? {} : { pokeSelf: Boolean(pokeSelf) })
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    saveChat(st);
    return unread;
  }

  /**
   * 把当前所有未读标记为已读，但不取走它们。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) saveChat(st);
    return n;
  }

  /**
   * 把时间窗内的已读消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束。窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
    }
    if (n) saveChat(st);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于"等待中"会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    m.recalled = true;
    m.read = true;   // 撤回的消息也算"已读"，不再触发回复
    saveChat(st);
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本，
   * 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    saveChat(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    if (removed) saveChat(st);
    return removed;
  }

  /**
   * 把某会话的本地 id 重排成 1..n（消除 removeByLocalIds 留下的空洞）。
   *
   * 用途：buildPastState 的窗口锚定把窗口起点对齐到本地 id 的整倍数上，
   * 前提是 id 稠密。删除消息打出空洞后，锚定退化成滑动窗口，历史块
   * 第一行每轮都在变，整个历史块无法命中前缀缓存（每轮多付 2~3K token）。
   * densify 一次即可让锚定恢复。
   *
   * 安全性：模型引用的 #id 每轮随提示词重新渲染，重排后立即一致；
   * reply 只存 {sender,text} 摘要不存 id；唯一受影响的是 UI 已打开的
   * 消息列表里的旧 id（刷新即愈）。
   * @returns {{before:number, after:number, holes:number}}
   */
  densify(chatKey) {
    const st = this.#state(chatKey);
    const before = st.nextLocalId;
    let n = 0;
    for (const m of st.messages) m.id = ++n;
    st.nextLocalId = n + 1;
    saveChat(st);
    return { before, after: n + 1, holes: before - (n + 1) };
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed) {
      st.messages = [];
      saveChat(st);
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
