// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { atomicWriteText } from './atomic-write.js';
import { appendUsageLedger } from './usage-ledger.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 索引缓存：启动加速的关键。没有它时 #loadIndex 要逐个 readFileSync+JSON.parse
// 全部会话文件（用户实测 2277 个文件 / 178MB 要 25 秒）；有了它启动只读这一个
// ~0.5MB 的单文件（3ms 级）。缓存与磁盘文件的增量校验在后台异步做（见
// reconcileInBackground），所以缓存缺失/过期都只是"首次启动慢"，不会错。
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');
// v2：摘要里新增了 toolCalls（工具调用次数）。旧缓存里的条目没有这个字段，
//     而这正是"缓存只有摘要、没有 messages"所以算不出来的情况 —— 只能让版本号失效，
//     启动时从会话文件重建一次索引把计数补上。一次性代价，之后照旧走缓存。
const INDEX_CACHE_VERSION = 2;
// r92（R78-1）：僵尸回收改为只处理索引里仍为 running/waiting 的条目
//（见 #reclaimZombies 注释），不再需要 mtime 窗口常量。

/**
 * 会话文件的原子写（tmp + rename）。
 *
 * 裸 writeFileSync 在中断/崩溃时会留下**截断的 JSON**，而读取侧
 * （#loadOne / reconcileInBackground）的 catch 会静默跳过它 →
 * 该会话在索引里永久消失，且**没有任何补救入口**（文件已坏、索引也建不出来）。
 * 启动扫描路径（僵尸回收）尤其不能这么写 —— 那正是最容易被断电/强杀打断的地方。
 */
// 2026-10-16（外部审查 #13）：改走 src/atomic-write.js 的统一实现。
// 原来是本文件自己写的一份（tmp + rename），与 store.js / migrate.js 各有一份、
// 口径不一（缺 mkdir、失败不留清理）。atomicWriteText 是它们的严格超集：
// 同样的 tmp+rename 语义，另加父目录自动创建与失败时清掉临时文件。
function atomicWriteSessionFile(fileName, data) {
  atomicWriteText(path.join(SESSIONS_DIR, fileName), JSON.stringify(data));
}
// 变更后写缓存的防抖间隔：写缓存本身也是 ~0.5MB 的同步 IO，不值得每次
// update 都写。掉电最坏情况 = 缓存落后几秒，下次启动靠后台对账/补读修正。
const INDEX_CACHE_WRITE_DEBOUNCE_MS = 5000;

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 一条会话调用了多少次工具。
 * 优先用会话对象上的 `toolCalls` 计数器（运行中的会话在 orchestrator 里逐个累加）；
 * 缺失时（早于该字段的老会话文件）现数一次 —— 文件里带 messages，能算准。
 * ⚠️ 口径必须与用量页/遥测一致：数 `messages` 里带 `toolCall` 的条目，
 *    不是数 assistant 的 `tool_calls` 数组（一轮可以并发多个工具，
 *    但每条 tool 结果都会单独 push 一条 toolCall 消息）。
 */
export function toolCallCount(s) {
  const n = Number(s?.toolCalls);
  if (Number.isFinite(n) && n > 0) return n;
  return Array.isArray(s?.messages) ? s.messages.filter((m) => m && m.toolCall).length : 0;
}

export function sessionFile(id) {
  // r92：函数自我保护。当前唯一 HTTP 调用方（routes.js）用路由正则挡住了
  // `..` 与 `/`，但这是调用方自觉 —— 任何未来调用方（内部代码/插件）传入含
  // 路径分隔符的 id 就是任意文件读/删。与 store.js 的 chatFile 同款消毒口径。
  const safe = String(id ?? '');
  if (!/^[\w-]+$/.test(safe)) throw new Error(`非法会话 id：${safe.slice(0, 40)}`);
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  /**
   * 运行时改保留上限（配置里改了 keepSessionFiles 要立即生效）。
   * 原来是"只在构造时读一次"，导致用户在设置页改了这个值后，
   * 要重启才生效 —— 磁盘上的会话文件会一直按旧值（默认 0 = 不限）增长。
   */
  setKeepFiles(keepFiles) {
    const next = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.keepFiles = next;
    if (next > 0) {
      this.index = this.index.slice(0, next);
      this.#pruneFiles();
    }
    this.#scheduleIndexCacheWrite(0);
  }

  /** 按 keepFiles 清理磁盘上的旧会话文件（保留最新 N 个）。 */
  #pruneFiles() {
    if (!(this.keepFiles > 0)) return;
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // 运行中/等待中的会话文件不在删除范围：UI 还指着它，删了会出现"详情 404"
      const activeIds = new Set(
        [...(this.current?.values?.() ?? [])].map((s) => String(s?.id ?? '')).filter(Boolean)
      );
      for (const f of files.slice(this.keepFiles)) {
        const id = f.replace(/\.json$/, '');
        if (activeIds.has(id)) continue;
        // ⚠️（2026-10-17）删文件之前必须先把用量补进账本。
        //    账本是"会话文件被删也不丢"的唯一凭据；少了这一步，被裁掉的会话
        //    在用量页里永远少算 —— 用户报"今日 200 次运行只算 120 次"，
        //    根因就是默认 keepSessionFiles=120 裁文件、而统计只认文件。
        //    appendUsageLedger 按 id 幂等，正常路径下这里已是空操作。
        try { appendUsageLedger(this.#ledgerSourceOfFile(id)); } catch { /* 兜底失败不阻塞清理 */ }
        try { fs.rmSync(path.join(SESSIONS_DIR, f), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /** 读磁盘上的会话文件对象（供删文件前补账本；读不到返回 null）。 */
  #ledgerSourceOfFile(id) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${id}.json`), 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch { /* 文件不存在/损坏：无从补账 */ }
    return null;
  }

  #loadIndex() {
    // ── 快路径：读索引缓存（单文件，毫秒级）──
    // 缓存条目 = 磁盘上全部会话的 summary；启动直接用它当 this.index，
    // 后台再异步对账（#rebuildIndexInBackground）修正差异（外部删文件/
    // 缓存写坏/版本变更）。任何缓存问题都会在几秒后被真值覆盖。
    let diskFiles = null;
    try {
      diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
    } catch { /* 目录还没建 */ }
    if (diskFiles) {
      const cached = this.#readIndexCache();
      if (cached && Array.isArray(cached.entries)) {
        const cachedIds = new Set(cached.entries.map((e) => e?.id).filter(Boolean));
        // r92（R78-7）：先建 Set 再过滤。原实现是 `cached.entries.filter((e) => diskFiles.includes(...))`
        // —— Array.includes 是线性查找，外面又套一层 filter，整体 O(N²)。
        // 2277 个会话文件时就是 500 万次字符串比较（纯浪费在主进程启动路径上）。
        const diskSet = new Set(diskFiles);
        // 只保留磁盘上确实存在的条目（外部删了文件/清理脚本跑过）
        this.index = cached.entries.filter((e) => e?.id && diskSet.has(`${e.id}.json`));
        // 磁盘上有、缓存里没有的文件（缓存之后新产生的）→ 同步补读
        // 通常很少（上次运行结束到缓存写入之间的窗口），大量缺失走后台
        const missing = diskFiles.filter((f) => !cachedIds.has(f.replace(/\.json$/, '')));
        if (missing.length > 0 && missing.length <= 200) {
          for (const f of missing) this.#loadOne(f, /* zombieScan */ false);
          this.#sortIndex();
        } else if (missing.length > 200) {
          // 大量缺失（换数据目录/缓存超老）：直接走慢路径全量读
          this.index = [];
          this.#loadAll(diskFiles);
        } else {
          this.#sortIndex();
        }
        // 僵尸回收：只处理索引里仍为 running/waiting 的条目（r92 / R78-1）
        this.#reclaimZombies();
        this.#writeIndexCache();
        return;
      }
    }
    // ── 慢路径：无缓存（首次/缓存损坏）── 全量读 + 写缓存
    if (diskFiles) this.#loadAll(diskFiles);
    this.#writeIndexCache();
  }

  /** 全量读磁盘文件建索引（慢路径，与旧版 #loadIndex 行为一致）。 */
  #loadAll(diskFiles) {
    for (const f of diskFiles) this.#loadOne(f, /* zombieScan */ false);
    this.#reclaimZombies();
    this.#sortIndex();
  }

  /** 读单个会话文件进索引。zombieScan=true 时顺带做僵尸回收写回。 */
  #loadOne(file, zombieScan) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (!data?.id) return;
      if (zombieScan && (data.status === 'running' || data.status === 'waiting')) {
        // 僵尸会话回收：进程上次退出时正在运行/等待的会话，运行循环已不存在，
        // 状态却停留在 running/waiting —— UI 里既不结束也无法中止（中止按钮
        // 找不到活对象）。这里启动即改判 aborted 并写回文件，让会话页能看到
        // 真实状态。不改内存 current（启动时它是空的，这些会话本来就不在其中）。
        data.status = 'aborted';
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedOnBoot = true;   // 标记来源，UI/排障能分清"用户中止"和"重启遗留"
        // 原子写（2026-10-07）：启动扫描路径上尤其不能用裸 writeFileSync ——
        // 中断/崩溃会留下截断的会话文件，之后 #loadOne 的 catch 会静默跳过它
        // → 该会话在索引里**永久消失**（reconcileInBackground 也读不回来，文件已坏）。
        try { atomicWriteSessionFile(file, data); } catch { /* 写不回就只改内存视图 */ }
      }
      this.index.push(this.#summary(data));
    } catch (error) {
      // r92：坏文件不能无声跳过 —— 那意味着这条会话从索引里静默消失，
      // 用户看不到任何迹象。至少留一行日志供排障。
      logger.warn('sessions', `会话文件读取失败，已跳过：${file}（${String(error?.message ?? error).slice(0, 120)}）`);
    }
  }

  /**
   * 僵尸回收（r92 / R78-1 重写）。
   *
   * 上次进程异常退出时正在 running/waiting 的会话，运行循环已不存在、状态却停在
   * running/waiting —— UI 里既不结束也无法中止（中止按钮找不到活对象）。启动时改判
   * aborted 并写回文件，让会话页看到真实状态。不改内存 current（启动时它是空的）。
   *
   * ⚠️ 为什么重写：原实现遍历**全部**磁盘文件 → 逐个 statSync → 对最近 3 天改过的
   *    逐个 readFileSync + JSON.parse。而"只有 running/waiting 才可能是僵尸"这个
   *    事实索引里已经带着（#summary 的 status），于是全量读盘完全是白付：
   *      实测 data/sessions 数百文件时每次启动全量 parse 一遍，且这段在
   *      createApp() 内、**建窗之前**跑 —— 直接表现成"双击后迟迟不出窗"。
   *    现在只对"索引里 status 仍是 running/waiting"的条目读文件，典型 0~3 个。
   *    顺带不再依赖 mtime 窗口：10 天前遗留的 running 同样是僵尸，本来就该收。
   */
  #reclaimZombies() {
    const targets = this.index.filter((e) => e && (e.status === 'running' || e.status === 'waiting'));
    for (const entry of targets) {
      const file = `${entry.id}.json`;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        if (!data?.id || (data.status !== 'running' && data.status !== 'waiting')) continue;   // 文件已被外部改写
        data.status = 'aborted';
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedOnBoot = true;   // 标记来源，UI/排障能分清"用户中止"和"重启遗留"
        // 原子写（2026-10-07）：启动扫描路径上尤其不能用裸 writeFileSync ——
        // 中断/崩溃会留下截断的会话文件，之后 #loadOne 的 catch 会静默跳过它
        // → 该会话在索引里**永久消失**（reconcileInBackground 也读不回来，文件已坏）。
        try { atomicWriteSessionFile(file, data); } catch { /* 写不回就只改内存视图 */ }
        const idx = this.index.findIndex((e) => e.id === data.id);
        if (idx >= 0) this.index[idx] = this.#summary(data);
      } catch { /* 跳过坏文件 */ }
    }
  }

  #sortIndex() {
    this.index.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  /** 读索引缓存；版本不匹配/损坏返回 null。 */
  #readIndexCache() {
    try {
      const data = JSON.parse(fs.readFileSync(INDEX_CACHE_FILE, 'utf8'));
      if (data?.version === INDEX_CACHE_VERSION && Array.isArray(data.entries)) return data;
    } catch { /* 无缓存/坏缓存 */ }
    return null;
  }

  /** 写索引缓存（写前剔除运行中的：它们还没落成最终态，写进去是过期视图）。 */
  #writeIndexCache() {
    try {
      const currentIds = new Set(this.current.keys());
      const entries = this.index.filter((e) => !currentIds.has(e.id));
      const tmp = `${INDEX_CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_CACHE_VERSION, savedAt: Date.now(), entries }), 'utf8');
      fs.renameSync(tmp, INDEX_CACHE_FILE);
    } catch { /* 写缓存失败不影响功能 */ }
  }

  /**
   * 防抖写缓存：索引有变动时调这个，而不是直接 #writeIndexCache ——
   * 运行中的会话每次 update 都会改索引条目，逐次写 0.5MB 同步 IO 太亏。
   * flushIndexCache()（进程退出前）会立刻落盘。
   */
  #scheduleIndexCacheWrite(delay = INDEX_CACHE_WRITE_DEBOUNCE_MS) {
    if (this.#indexCacheTimer) clearTimeout(this.#indexCacheTimer);
    this.#indexCacheTimer = setTimeout(() => {
      this.#indexCacheTimer = null;
      this.#writeIndexCache();
    }, delay);
    this.#indexCacheTimer.unref?.();
  }
  #indexCacheTimer = null;

  /** 立即落盘缓存（stop() 调用；清掉防抖定时器当场写）。 */
  flushIndexCache() {
    if (this.#indexCacheTimer) { clearTimeout(this.#indexCacheTimer); this.#indexCacheTimer = null; }
    this.#writeIndexCache();
  }

  /**
   * 后台对账：异步全量重扫磁盘，修正缓存路径可能漏掉的差异
   * （运行中被外部删文件、缓存写入竞态等）。启动毫秒级返回，对账在
   * 事件循环空闲时进行，不阻塞请求。
   * @returns {Promise<void>} 完成时 resolve（供测试等待）
   */
  reconcileInBackground() {
    if (this.#reconcileStarted) return Promise.resolve();
    this.#reconcileStarted = true;
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const diskFiles = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
          const known = new Set(this.index.map((e) => `${e.id}.json`));
          let changed = false;
          for (const f of diskFiles) {
            if (known.has(f)) continue;
            // 缓存里没有的新文件（上一进程运行后期产生的）
            this.#loadOne(f, /* zombieScan */ true);
            changed = true;
          }
          // 缓存里有、磁盘上没有的（外部删除）→ 摘掉
          const diskSet = new Set(diskFiles);
          const filtered = this.index.filter((e) => diskSet.has(`${e.id}.json`));
          if (filtered.length !== this.index.length) { this.index = filtered; changed = true; }
          if (changed) {
            this.#sortIndex();
            this.#writeIndexCache();
          }
        } catch { /* 对账失败保持现状 */ }
        resolve();
      });
    });
  }
  #reconcileStarted = false;

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      toolCalls: toolCallCount(s),            // 工具调用次数（列表行要显示，见 toolCallCount 的说明）
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      // 2026-10-18：错误连同本地化解释一起进摘要 —— 列表/索引从磁盘重建时
      // 也能显示中文错误摘要，而不是刷新后只剩一条没有原因的失败。
      error: s.error ?? null,
      errorHuman: s.errorHuman ?? null,
      errorRaw: s.errorRaw ?? null
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      toolCalls: 0,                            // 工具调用次数（每条 toolCall 消息 +1，见 orchestrator）
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    this.#scheduleIndexCacheWrite();
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status, error) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    if (error != null) s.error = String(error);
    // 终态时把瞬时 activity（如「正在思考…」）替换成有意义的结尾，否则会话索引会永久残留该文案。
    // error 态优先用错误摘要，其它终态按 status 填中文。
    if (status !== 'running' && status !== 'waiting') {
      if (status === 'error' && s.error) {
        // 优先用本地化标题（errorHuman.title），没有才退回错误原文前 100 字 ——
        // 会话索引/列表行的简短摘要要能一眼看懂（2026-10-18）。
        s.activity = `⚠️ 出错：${s.errorHuman?.title || s.error.slice(0, 100)}`;
      } else if (!s.activity || s.activity === '正在思考…') {
        s.activity = ({ done: '已完成', noreply: '无回复', aborted: '已中止' })[status] || s.activity;
      }
    }
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    this.#scheduleIndexCacheWrite();
    // 清理超出保留数的旧文件
    // ⚠️（2026-10-17）必须走 #pruneFiles()：它删文件前会先把用量补进账本
    //    （appendUsageLedger 按 id 幂等），并跳过运行中/等待中的会话。
    //    曾经这里内联了一份"只删不补账"的裁剪，被裁掉的会话用量直接消失，
    //    就是"今日 200 次运行只算 120 次"的直接原因。
    try { this.#pruneFiles(); } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // r92：节流时间戳随会话删除清理（finish 有，这里原先漏了）
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) {
        // ⚠️（2026-10-17）兜底补账本：discard 的既定用途是"从未真正运行"的
        //    会话（无用量，ledgerRecordOf 直接返回 null，这里是空操作）；
        //    但进程被杀留下的"僵尸 waiting 会话"可能带部分用量，补一行
        //    再删，避免这部分 token 凭空消失。
        try { appendUsageLedger(this.#ledgerSourceOfFile(id)); } catch { /* 兜底失败不阻塞删除 */ }
        fs.unlinkSync(f);
      }
    } catch { /* ignore */ }
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 主动删除一条会话记录（含已结束的）。
   * 与 discard 的区别：discard 只允许删"等待中"的（保护用量记录）；
   * remove 是用户主动清理历史，允许删任何状态，但**不删正在运行的**（那会丢账）。
   * @returns {boolean} 是否真的删了
   */
  remove(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 正在运行的会话不能删（usage 还在累加，删了账就乱了）；等待中的可以
    if (s && s.status === 'running') return false;
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // r92：节流时间戳随会话删除清理（finish 有，这里原先漏了）
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) {
        // ⚠️（2026-10-17）与 #pruneFiles 同理：删之前先补账本。
        //    用户主动清历史，不该让"真花掉的 token"从用量统计里消失。
        //    appendUsageLedger 按 id 幂等，结束态落盘时通常已入账。
        try { appendUsageLedger(this.#ledgerSourceOfFile(id)); } catch { /* 兜底失败不阻塞删除 */ }
        fs.unlinkSync(f);
      }
    } catch { /* ignore */ }
    this.#scheduleIndexCacheWrite();
    return this.index.length < before;
  }

  /**
   * 清空全部已结束的会话记录（保留正在运行/等待的）。
   * @returns {number} 删掉了多少条
   */
  clearFinished() {
    const keepIds = new Set();
    for (const [id, s] of this.current) {
      if (s && (s.status === 'running' || s.status === 'waiting')) keepIds.add(id);
    }
    let removed = 0;
    const remaining = [];
    for (const e of this.index) {
      if (keepIds.has(e.id)) { remaining.push(e); continue; }
      removed++;
      this._lastPersistAt?.delete(e.id);   // r92：节流时间戳随会话删除清理
      // ⚠️（2026-10-17 N8）**删文件之前必须先补账本**。
      //    账本是会话文件之外唯一能给出"这天花了多少"的长期凭据，
      //    而 app.js 的 aggregateDayFromArchive / authoritativeGapForDay 会用它
      //    给历史日补差（否则这些用量只剩"已生成快照的那几天"还能查到）。
      //    正常路径下会话在结束态 #persist 时就已入过账，appendUsageLedger 按 id
      //    幂等 → 这里是空操作；只有"结束那次落盘失败"或"旧版本遗留的会话文件"
      //    才会真正补上一行。反过来看，这段代码让界面那句
      //    "不影响用量统计的历史数据"从**空话**变成了**事实**。
      try { appendUsageLedger(this.#usageSourceOf(e)); } catch { /* 兜底失败不阻塞清理 */ }
      try {
        const f = path.join(SESSIONS_DIR, `${e.id}.json`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    this.index = remaining;
    this.#scheduleIndexCacheWrite();
    return removed;
  }

  /**
   * 取一个会话的"账本源对象"（供 clearFinished 补账用）。
   *
   * 优先读磁盘上的会话文件：只有它带 `retriedUsage`（重试归档的 token 也算钱）
   * 与 `vendor`，用索引摘要会少算或字段缺失。
   * 文件缺失/损坏时退回索引摘要 —— 它至少有 id/chatKey/startedAt/endedAt/
   * usage/model/webSearchCount，足以构成一条可用的账本记录。
   */
  #usageSourceOf(entry) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${entry.id}.json`), 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch { /* 退回索引摘要 */ }
    return entry;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    // ── 把重试归档的用量并进来（2026-10-07）──
    // orchestrator 的 #resetSessionForRetry 会把"已消耗但本轮作废"的 token 归档到
    // retriedUsage（因为重试时 live.usage 被归零）。那笔钱是真花了，不并进来
    // → 成本看板**系统性偏低**，且偏低程度取决于重试次数（无法对账）。
    const archived = s.retriedUsage || null;
    const eff = {
      calls: (Number(s.usage?.calls) || 0) + (Number(archived?.calls) || 0),
      promptTokens: (Number(s.usage?.promptTokens) || 0) + (Number(archived?.promptTokens) || 0),
      completionTokens: (Number(s.usage?.completionTokens) || 0) + (Number(archived?.completionTokens) || 0),
      totalTokens: (Number(s.usage?.totalTokens) || 0) + (Number(archived?.totalTokens) || 0),
      cachedTokens: (Number(s.usage?.cachedTokens) || 0) + (Number(archived?.cachedTokens) || 0)
    };
    /* 零消耗会话（aborted 的等待会话：从未调用模型、token 全 0）不计 runs，
       否则"今日运行次数"会被暂停/未命中等中止事件虚增，与 LLM 调用次数脱节。 */
    if (eff.calls === 0 && eff.totalTokens === 0) return;
    // ⚠️ dayKey 必须用**结束**时间，不是开始时间（2026-10-07 修）。
    //   usage-today.json 是单槽文件：跨零点的会话若最后才 finish，用 startedAt 会把
    //   dayKey 打回昨天，下面 `parsed?.dayKey === dayKey` 不匹配 → data 保持全零初始值
    //   → **整体覆盖写回，今天的用量凭空消失**。
    //   实测序列（A昨天/B今天/C昨天最后结束/D今天）：真实消耗 600，文件显示 100，
    //   runs 显示 1（真实 2）。方向取决于会话结束顺序，不可预测、无法通过对比发现。
    const dayKey = localDayKey(s.endedAt ?? Date.now());
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    let stale = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
      else stale = parsed;
    } catch { /* 新的一天 */ }
    // dayKey 不匹配时**不丢弃旧槽位**：先按天归档（usage-archived-days.json）再开新槽，
    // 否则跨零点那部分的用量就永久查不到了。
    if (stale && (Number(stale.totalTokens) || 0) > 0) {
      try { this.#archiveDayUsage(stale); } catch { /* 归档失败不阻塞主流程 */ }
    }
    data.promptTokens += eff.promptTokens;
    data.completionTokens += eff.completionTokens;
    data.totalTokens += eff.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + eff.cachedTokens;
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    // r92（R78-6）：临时名带 pid。固定名 `.tmp` 在双开/两个核心指向同一数据目录时，
    // A 进程写一半、B 进程 rename 走的是 A 的半截内容 —— 落一个半新半旧文件。
    const tmp = path.join(DATA_DIR, `usage-today.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));

    // 累计总量（匿名遥测的唯一数据源：调用次数 + 三档 token 数，无任何身份信息）
    try {
      const tPath = path.join(DATA_DIR, 'telemetry-totals.json');
      let t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
      try { t = { ...t, ...JSON.parse(fs.readFileSync(tPath, 'utf8')) }; } catch { /* 首次 */ }
      // ⚠️ calls 的口径是「LLM 调用次数」（与用量页一致：带 token 用量的 raw 条目数），
      //    不是会话数；与 telemetry.js 的重建逻辑保持同一算法。
      //    重试归档的调用也要计入（那些 raw 已被 messages=[] 清掉，不数就少记）。
      let llmCalls = (Number(archived?.calls) || 0);
      for (const m of (s.messages || [])) {
        const ru = m?.raw?.usage || {};
        if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) llmCalls += 1;
      }
      t.calls += llmCalls;
      t.promptTokens += eff.promptTokens;
      t.completionTokens += eff.completionTokens;
      t.totalTokens += eff.totalTokens;
      // 工具调用明细：会话结束时按消息里的 toolCall 逐个点名一次（与用量页同一口径）
      if (!t.toolCounts || typeof t.toolCounts !== 'object') t.toolCounts = {};
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
      // 原子写（2026-10-07）：原先是裸 writeFileSync，中途被杀会留下截断文件。
      // 而 loadTotals() 对损坏的兜底是**全量重扫sessions/**（实测 185MB / 1963 文件
      // 要 20+ 秒同步阻塞），反复损坏会把启动拖垮；且重建只统计磁盘上还留着的会话，
      // 清理过的历史无法区分"被清理"与"未发生" → 累计量永久缺口。
      const tTmp = `${tPath}.${process.pid}.tmp`;
      fs.writeFileSync(tTmp, JSON.stringify(t), 'utf8');
      fs.renameSync(tTmp, tPath);
    } catch { /* 遥测记账失败不影响主流程 */ }
  }

  /**
   * 把 usage-today.json 的旧槽位按天归档到 usage-archived-days.json（2026-10-07 新增）。
   *
   * 背景：usage-today.json 是**单槽**文件（只存"今天"）。跨零点时若直接覆盖，
   * 昨天那部分用量就消失了（见 #bumpTodayUsage 里的说明）。所以 dayKey 不匹配时
   * 先把旧槽位按天归档再开新槽 —— 归档后历史仍可在用量页查到。
   *
   * ⚠️ 归档写到**独立文件** usage-archived-days.json，不写 usage-daily.json。
   *
   * 曾经两者共用 usage-daily.json，踩了大坑：app.js 的日快照层
   * （src/app.js 的 loadUsageDaily/saveUsageDaily）与本方法对同一个文件做
   * read-modify-write，两边写入的结构还不兼容 —— 本方法写的是扁平
   * {promptTokens, runs, webSearchCount, ...}，app.js 读的是嵌套的
   * { sig, aggregates: { totals, chats, models, searchCount, toolCounts } }。
   * 后果是 app.js 每次判定这些条目失效 → 从 sessions 档案重算该日 →
   * 用自己的结构**覆盖掉**本方法累加进去的 webSearchCount（重算路径里
   * 根本没有这个字段），于是跨零点的搜索次数被静默丢弃。
   * 分文件后：app.js 只管自己的快照，本方法只管本文件，互不干扰。
   *
   * 本文件是"结算流水"，不是统计快照 —— 统计口径以 app.js 的重算为准，
   * 本文件只在 sessions 原始文件被清理后仍留一份底。
   */
  #archiveDayUsage(stale) {
    if (!stale?.dayKey) return;
    const file = path.join(DATA_DIR, 'usage-archived-days.json');
    let days = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.days && typeof parsed.days === 'object') days = parsed.days;
    } catch { /* 无快照则新建 */ }
    // 已存在则累加，不覆盖（跨零点那部分必须保住）
    const cur = days[stale.dayKey] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    for (const k of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'runs', 'webSearchCount']) {
      cur[k] = (Number(cur[k]) || 0) + (Number(stale[k]) || 0);
    }
    days[stale.dayKey] = cur;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, days }), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      if (s.status !== 'running' && s.status !== 'waiting') {
        // ⚠️ 顺序要紧：账本必须在 #pruneFiles/finish 的删除之前写。
        //   会话文件一旦被 keepFiles 裁掉，它携带的用量就再也读不到了
        //   （这正是"用量估算不更新"的根因，见 src/usage-ledger.js）。
        //   账本是这里唯一的长期凭据，先写它才安全。
        appendUsageLedger(s);
        this.#bumpTodayUsage(s);
      }
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
