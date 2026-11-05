// 详尽日志系统：分级 + 落盘 + 内存环形缓冲（供 UI 查看）。
//
// 设计目标：
//   - 分级：debug / info / warn / error，可配置最低落盘级别
//   - 落盘：data/logs/qq-agent-YYYY-MM-DD.log，按天滚动，自动清理旧文件
//   - 内存缓冲：最近 N 条留在内存，UI「日志」页签实时查看（SSE 推送）
//   - 不丢 console：所有日志同时仍走原 console（开发期习惯不变）
//
// 用法：
//   import { logger } from './logger.js';
//   logger.info('模块', '消息', 可选额外对象);
//   logger.setLevel('debug');
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, onConfigApplied } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
/** 级别取值（由低到高）。路由层校验、前端顺序都以此为准，不再各存一份。 */
export const LOG_LEVELS = Object.freeze(Object.keys(LEVELS));
const MAX_MEMORY = 500;          // 内存里保留最近多少条（UI 查看）
const KEEP_DAYS = 7;             // 日志文件保留天数
export const MAX_QUERY_LIMIT = 500;      // 内存查询单次最多返回条数（与 MAX_MEMORY 同源）
export const DEFAULT_QUERY_LIMIT = 200;  // 查询默认条数

// 单条日志正文上限（字符）。异常对象 / 大 payload 序列化后可能上 MB：
// 截断只在 #writeInner 里做**一次**，内存环形缓冲、SSE 推送、落盘拿到的都是同一份
// 已截断文本。此前只有落盘截断，内存与 SSE 是原样——一条 5MB 的日志会让浏览器
// 整段 JSON.parse，批量时单帧能到 10MB。
const MAX_LOG_TEXT_CHARS = 64 * 1024;
const LOG_TRUNCATED_MARK = '…（过长已截断）';

// 磁盘历史反向读：每次 read 的块大小，以及单次请求最多扫描的字节数。
//
// 内存占用与文件大小无关：块读完就解析、只保留要返回的 ≤ limit+1 条记录
// （含续行），不会把整份文件读进内存；扫描总量设 32MB 上限是 CPU 护栏
// （256MB 的异常文件逐行正则要数秒），正常一天 < 10MB，远在上限之内。
//
// 上限被用满时**必须告诉调用方**（iterTailLines 的 truncated 哨兵）：
// 否则 readHistory 只能按「取到 max+1 条」判断 hasMore，扫描被预算截断时
// 仍报 hasMore=false，界面显示「没有更早的了」，而更早的日志其实根本没读到。
const HISTORY_CHUNK_BYTES = 64 * 1024;
export const HISTORY_SCAN_MAX_BYTES = 32 * 1024 * 1024;

// 落盘行格式：`HH:MM:SS [LEVEL] [module] text`，LEVEL 被 padEnd(5) 补齐
// （`[INFO ]` / `[WARN ]` / `[ERROR]`）。模块名不允许含 `]`（内置模块名只有
// `[a-z0-9:_-]`），正文可含换行（Error 的 stack），换行后的行是续行。
const HISTORY_LINE_RE = /^(\d{2}):(\d{2}):(\d{2}) \[([A-Z]+)\s*\] \[([^\]]*)\] ?(.*)$/;

function logsDir() {
  return path.join(DATA_DIR, 'logs');
}

function dateKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function logFileFor(date) {
  return path.join(logsDir(), `qq-agent-${date}.log`);
}

/**
 * 校验并规范化日志日期（YYYY-MM-DD）。非法值直接拒绝，不拼路径。
 * 这是 history / download 两个端点唯一的路径来源：日期格式错了，拼出来的
 * 文件名必然越不出 logs 目录，用不着再靠 startsWith 兜底补一层校验。
 */
export function parseLogDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const at = new Date(y, mo - 1, d);
  // 2 月 30 日这类会滚动到下个月，用回读一致性判真
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  return raw;
}

/**
 * 解析 `level` 查询参数（逗号分隔、大小写不敏感），返回命中级别的 Set。
 * 空值返回空 Set。调用方用 `raw && set.size === 0` 判"写了但全是未知级别"，
 * 据此报 400，避免拼错级别时静默退化成"全都不筛"。
 */
export function parseLevels(raw) {
  const out = new Set();
  if (!raw) return out;
  for (const part of String(raw).split(',')) {
    const name = part.trim().toLowerCase();
    if (LEVELS[name] != null) out.add(name);
  }
  return out;
}

/** 读一个字节区间（createReadStream 的 end 含端）。 */
async function readRange(filePath, start, end) {
  const chunks = [];
  for await (const chunk of fs.createReadStream(filePath, { start, end })) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* 反向扫描的截断哨兵。string 之外的取值不会与真实的日志行混淆，
   也不需要调用方记住某个魔法对象。 */
const SCAN_TRUNCATED = Symbol('history-scan-truncated');

/**
 * 从文件末尾（或 `startOffset`）往前分块读取，逐行产出（尾行在前）。
 *
 * 产出两态：
 *   `{ line, end }`  end 是该行结束处的绝对字节偏移（换行符之后），
 *                    供 readHistory 记录偏移锚点（见 historyAnchors）。
 *   SCAN_TRUNCATED   字节预算耗尽而文件头还没读到 —— **必须**让调用方知道，
 *                    否则 readHistory 无从区分"真的到底了"和"预算用完了"。
 *
 * 为什么按行产出而不是"先读一批行再过滤"：带 `before` 游标翻页时，
 * 游标之前的行可能远在几十 KB 之外（当天 1700 行 ≈ 300KB），先按固定行数
 * 读一批再去掉 `>= before` 的行，会把整页都过滤光、返回空。逐行反扫则
 * 一直走到命中游标为止，只要字节预算内就有结果。
 *
 * 行边界按字节找 `\n` 后再逐行转字符串：跨块的多字节 UTF-8 字符不会
 * 因为 Buffer 切分被拆坏。文件头那段没有前导换行，是完整首行。
 *
 * `startOffset` 来自偏移缓存：从锚点位置开始扫，而不是每次都从 EOF 重扫
 * （翻到第 N 页的耗时随页数线性增长，33MB 文件第 600 页要 70ms）。
 */
async function* iterTailLines(filePath, size, startOffset = null) {
  let cursor = startOffset === null ? size : Math.min(startOffset, size);
  let spent = 0;
  let rest = Buffer.alloc(0);   // 还没遇到换行的尾部字节（正在形成的行）
  let restStart = cursor;       // rest 在文件中的绝对起点
  // 文件以换行结尾时，最先 yield 的是末尾那个空串——它不是日志行，
  // 而是最后一条记录的终止符；跳过它，避免被当成上一条的续行。
  let started = false;
  while (cursor > 0 && spent < HISTORY_SCAN_MAX_BYTES) {
    const budget = Math.min(HISTORY_CHUNK_BYTES, HISTORY_SCAN_MAX_BYTES - spent);
    const from = Math.max(0, cursor - budget);
    const buf = await readRange(filePath, from, cursor - 1);
    spent += buf.length;
    cursor = from;
    rest = Buffer.concat([buf, rest]);
    restStart = from;
    let idx = rest.lastIndexOf(0x0a);
    while (idx !== -1) {
      const line = rest.subarray(idx + 1).toString('utf8');
      // 该行在文件中的绝对结束位置（换行符之后）：锚点就记这个位置
      const end = restStart + rest.length;
      rest = rest.subarray(0, idx);
      idx = rest.lastIndexOf(0x0a);
      if (!started && line === '') continue;
      started = true;
      yield { line, end };
    }
    // 未闭合的尾部字节留到下一轮拼接；预算耗尽时它是不完整的行，直接丢弃
  }
  if (cursor === 0) {
    if (rest.length) yield { line: rest.toString('utf8'), end: restStart + rest.length };
    return;
  }
  // 预算用尽但文件头还没到：更早的内容没读到，交给调用方决定怎么提示
  yield SCAN_TRUNCATED;
}

/* ── 反向扫描的偏移缓存 ────────────────────────────────────────────────
 *
 * 翻页时每页都从 EOF 反向扫到游标，耗时随页数线性增长（实测 33MB 单日文件：
 * 第 1 页 3ms、第 300 页 36ms、第 600 页 71ms；界面一次「加载更多」最多连取
 * 40 页 → 最坏 2.8 秒）。缓存记录「某时间戳 → 该秒全部行读完后的字节位置」，
 * 下一次 `before` 命中锚点就直接从那里反向扫，成本与页深无关。
 *
 * 失效按 size + mtimeMs：日志文件只有尾部追加（appendFileSync），mtime 变即
 * 内容变。追加只改文件末尾、不动已扫过的更早部分，所以**旧锚点仍然有效**，
 * 直接把 size/mtime 覆盖即可——不必清空重来；清空会让翻页退化成每页从 EOF 重扫。
 * 唯一会让锚点失效的是 prune() 的异常膨胀截断（整体重写文件），所以它在
 * 截断后显式清缓存；真发生 inode 复用（备份恢复覆盖同名文件）时锚点偏了，
 * 后果也只是少读/多读几行、下一次正常扫描就会把锚点覆盖回来，不会读到脏数据。
 *
 * 每个文件最多 ANCHOR_MAX 个锚点（一天 24 小时 = 86400 个秒级时间戳，只留
 * 翻页走过的 200 个），超出淘汰最早登记的（Map 保持插入序）。
 */
const ANCHOR_MAX = 200;
const ANCHOR_FILE_MAX = 8;    // 最多缓存几个日志文件（KEEP_DAYS 7 天 + 余量）
const historyAnchorCache = new Map();   // file → { size, mtimeMs, anchors: Map<ts, offset> }

/** 取该文件的锚点表：首次建、已存在就刷新 size/mtime 并挪到 LRU 队尾。 */
function historyAnchorCacheFor(file, st) {
  let entry = historyAnchorCache.get(file);
  if (!entry) {
    if (historyAnchorCache.size >= ANCHOR_FILE_MAX) {
      const oldest = historyAnchorCache.keys().next();
      if (!oldest.done) historyAnchorCache.delete(oldest.value);
    }
    entry = { size: st.size, mtimeMs: st.mtimeMs, anchors: new Map() };
    historyAnchorCache.set(file, entry);
    return entry;
  }
  // 追加写：把表观状态挪到最新，保留已记的锚点（见上面注释）
  entry.size = st.size;
  entry.mtimeMs = st.mtimeMs;
  // 挪到队尾：淘汰时留下的是最近翻过的文件
  historyAnchorCache.delete(file);
  historyAnchorCache.set(file, entry);
  return entry;
}

/** 登记一个锚点。已满且是新时间戳时淘汰最早登记的那条（Map 保持插入序）。 */
function rememberAnchor(entry, ts, offset) {
  if (!entry.anchors.has(ts) && entry.anchors.size >= ANCHOR_MAX) {
    entry.anchors.delete(entry.anchors.keys().next().value);
  }
  entry.anchors.set(ts, offset);
}

/**
 * 找「可以跳转到的最大锚点」：只接受 `anchorTs <= beforeTs` 且
 * `beforeTs - anchorTs <= 1000`（锚点那一秒正好是游标所在秒或紧接其下）的锚点。
 *
 * 为什么窗口这么窄：锚点位置之上的行（更新的字节位置）必然有 `ts >= anchorTs`
 * ——翻页命中过的秒里，靠后的行总比先记锚点的行更晚被扫到。若允许从任意更早的
 * 锚点跳转，游标与锚点之间那些**从没返回过**的行就被跳过了。窗口收到一秒以内，
 * 跳转点上方最多只有同秒的行（要么已随上一页返回，要么被 `ts >= beforeTs` 滤掉），
 * 不丢内容。锚点记录的是该记录最新一行之后，所以那一行本身会被重读一遍
 * ——重读是刻意的：客户端的游标本来就按「重叠一秒 + 重数去重」设计（见
 * ui/app/20-logs.js 文件头），少重读反而会破坏「返回所有 ts < before 的行」的契约。
 *
 * 没有命中返回 null → 调用方按老办法从 EOF 开始。
 */
function anchorOffsetBefore(entry, beforeTs) {
  if (beforeTs === null) return null;
  let bestTs = null;
  let bestOffset = null;
  for (const [ts, offset] of entry.anchors) {
    if (ts > beforeTs || beforeTs - ts > 1000) continue;
    if (bestTs === null || ts > bestTs) { bestTs = ts; bestOffset = offset; }
  }
  return bestOffset;
}

/** 日志文件被重写（prune 的膨胀截断）后，偏移锚点全部作废。 */
function invalidateHistoryAnchors(file) {
  historyAnchorCache.delete(file);
}

/* 目录只确保一次。原实现在每条日志的落盘分支里都调一次
   fs.mkdirSync(logsDir(), {recursive:true})，那是一次真实 syscall，而日志是
   热路径（启动期一次能刷几百条）。目录一旦建好就不会消失，缓存一个布尔即可。 */
let logsDirReady = false;
function ensureLogsDir() {
  if (logsDirReady) return;
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    logsDirReady = true;
  } catch { /* 建不出来就让下面的 appendFileSync 自己失败一次 */ }
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function todayFile() {
  const d = new Date();
  const name = `qq-agent-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(logsDir(), name);
}

// ── 脱敏层 ──────────────────────────────────────────────────────────────
//
// 为什么必须放在日志的唯一出口：插件拿到的 `api.log / api.warn / api.error`
// 最终都汇到这里落盘 + 推 SSE，而插件完全可以把任意内容写进日志
// （典型：`api.error(err)` 里带上完整请求 URL、响应体、配置对象）。
// `safe-fetch.js` 的错误文案本身就含 hostname 与完整 URL，query 里常带 token；
// 模型/插件也可能把整个 settings 打出来，那是把 `data/logs/*.log` 变成凭据外泄通道。
//
// 主链路 `llm.js` 只记 key 的 sha1 指纹 + 字符数、不落 key 正文；缺口只在 logger
// 这一层没有兜底，所以补在这里：先脱敏再进内存/SSE/磁盘，三处共用同一份已脱敏
// 文本，不会出现"SSE 里没有但文件里有"。
//
// 取舍：宁可多打几个 `***`（脱敏过头只是少几条排查线索），也绝不放过一次真实泄漏。
// 因此匹配规则刻意宽松：值只要 ≥8 个字符就吃掉，不试图判断"这看起来像不像真 key"。
const REDACT_RULES = [
  // 常见厂商密钥前缀（OpenAI sk-、GitHub gh[pousr]_、AWS AKIA/ASIA、Slack xox）
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***_***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox***-***'],
  // `Bearer <token>` 形态（Authorization 头最常见的写法）
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, '$1 ***'],
  // key / token / password / cookie 等键名后跟的值（JSON、URL query、日志文本三种形态都覆盖）
  [/((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|authorization|token|secret|client[_-]?secret|password|passwd|pwd|cookie|sessdata|psk|credential)\s*["']?\s*[:=]\s*["']?)([^\s"',;}\]]{8,})/gi, '$1***'],
  // URL query 里的敏感参数（?access_token=… / &key=… / &sign=…）
  [/([?&](?:access_token|refresh_token|id_token|api[_-]?key|apikey|key|token|secret|password|passwd|signature|sig|sign|credential)=)([^&\s"'#]{6,})/gi, '$1***']
];

// 热路径快速返回：上面每条规则都要求文本里出现 `[:=]` 或某个密钥前缀，
// 没有这些特征就一定匹配不到，省掉逐条 replace 的整串扫描。
// （日志是热路径，启动期一次能刷几百条，见文件头同类取舍。）
const REDACT_HINT = /[:=]|sk-|bearer|gh[pousr]_|AKIA|ASIA|xox/i;

function redact(text) {
  if (!text) return text;
  const s = String(text);
  if (!REDACT_HINT.test(s)) return s;
  let out = s;
  for (const [re, rep] of REDACT_RULES) {
    try { out = out.replace(re, rep); } catch { /* 单条规则异常不影响其它规则 */ }
  }
  return out;
}

class Logger {
  constructor() {
    this.level = LEVELS.info;         // 默认 info 及以上落盘
    this.memory = [];                 // 环形缓冲 [{ts, level, module, text}]
    this.listeners = new Set();       // onLog 监听（SSE 推送）
    this.mirrorConsole = true;        // 是否同时走 console
    this.writing = false;             // 重入标记：监听器若再打日志，直接丢弃（防递归爆炸）
  }

  setLevel(level) {
    if (LEVELS[level] != null) this.level = LEVELS[level];
  }

  getLevel() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || 'info';
  }

  /**
   * 从内存缓冲里按条件过滤（UI 日志页的查询层）。
   *
   * 过滤语义：
   *   level  逗号分隔多值（`warn,error`），命中任一即可；未知级别忽略
   *   module 前缀匹配，`skill` 命中 `skill:random-image`；大小写不敏感
   *   q      子串搜索，大小写不敏感，同时匹配 text 与 module
   *   since  只保留 ts >= since
   *   until  只保留 ts <= until
   *   before 游标：只保留 ts < before（分页用）
   *   limit  默认 200、上限 500
   *
   * 返回 `{ logs, total, hasMore }`：logs 按新到旧排列；total 为 `before` 之后的
   * 命中总数（内存上限只有 MAX_MEMORY 条，全量计数不构成开销）；hasMore 表示
   * 命中的还有更早的一批未随本次返回。内存条目不带自增 id，同毫秒多条时用
   * before=最后一条的 ts 翻页会跳过同毫秒的其余条目——这是已知边界，
   * 内存查询本就只用于"看最近发生了什么"，完整历史走磁盘接口。
   */
  query({ level, module, q, since, until, limit, before } = {}) {
    const levels = parseLevels(level);
    const modPrefix = module ? String(module).toLowerCase() : '';
    const needle = q ? String(q).toLowerCase() : '';
    const sinceTs = toTs(since);
    const untilTs = toTs(until);
    const beforeTs = toTs(before);
    const max = clampLimit(limit, DEFAULT_QUERY_LIMIT);

    const hits = [];
    for (let i = this.memory.length - 1; i >= 0; i--) {
      const entry = this.memory[i];
      if (beforeTs !== null && entry.ts >= beforeTs) continue;
      if (sinceTs !== null && entry.ts < sinceTs) continue;
      if (untilTs !== null && entry.ts > untilTs) continue;
      if (levels.size && !levels.has(entry.level)) continue;
      if (modPrefix && !String(entry.module).toLowerCase().startsWith(modPrefix)) continue;
      if (needle) {
        const text = String(entry.text).toLowerCase();
        const mod = String(entry.module).toLowerCase();
        if (!text.includes(needle) && !mod.includes(needle)) continue;
      }
      hits.push(entry);
    }
    return { logs: hits.slice(0, max), total: hits.length, hasMore: hits.length > max };
  }

  /**
   * 读某一天的磁盘日志（新到旧），用于"内存只有 500 条、当天有上千行"的场景。
   *
   * 从文件末尾反向分块读，不会把整份文件读进内存；单次读取受
   * HISTORY_SCAN_MAX_BYTES 约束。行格式与 #writeInner 落盘的一致。
   *
   * before 是毫秒时间戳游标（返回严格更早的条目）。因为行里只有时分秒，
   * 日期由文件名给出，所以按"文件日 + 行内时分秒"还原时间戳。
   *
   * 返回值里两个"没读完"的信号必须分开：
   *   hasMore        本次之后还有更多（页长限制），照常翻页就能拿到；
   *   scanTruncated  扫描撞上 HISTORY_SCAN_MAX_BYTES，更早的内容**本次没读到**。
   *                  此时不能报成"到底了"——33MB～256MB 的单日文件正是异常膨胀、
   *                  最需要日志的时候，静默返回空页会把排查线索藏起来。
   *
   * @returns {Promise<{logs: object[], hasMore: boolean, date: string, scanTruncated: boolean}>}
   */
  async readHistory({ date = dateKeyOf(), limit, before } = {}) {
    const key = parseLogDate(date);
    if (!key) throw Object.assign(new Error('日期格式无效（应为 YYYY-MM-DD）'), { expose: true, status: 400 });
    const max = clampLimit(limit, DEFAULT_QUERY_LIMIT);
    const file = logFileFor(key);
    if (!fs.existsSync(file)) return { logs: [], hasMore: false, date: key, scanTruncated: false };

    const beforeTs = toTs(before);
    // 起点时间：该日 00:00:00 的本地时间戳
    const [y, mo, d] = key.split('-').map(Number);
    const dayStart = new Date(y, mo - 1, d).getTime();
    const dayEnd = dayStart + 86400000;
    const st = await fs.promises.stat(file);
    const cache = historyAnchorCacheFor(file, st);

    // 偏移缓存命中就从锚点开始反向扫，而不是每次都从 EOF 重扫——后者让每页耗时
    // 随页深线性增长（33MB 文件第 600 页 71ms）。命不中（首页、或游标不贴合任何
    // 已扫过的秒）才回落到 EOF，语义与从前一致。
    const startOffset = anchorOffsetBefore(cache, beforeTs);

    // 反向逐行扫描：续行（stack 等多行正文）属于它上面那条完整记录，
    // 所以先压栈，遇到"HH:MM:SS [LEVEL] [module]"开头才组装成一条。
    const out = [];
    let lines = [];            // 当前记录的续行（读取顺序是自下而上）
    let pendingEnd = 0;        // 该记录最低一行（反扫最先遇到）之后的字节位置
    let truncated = false;
    let scanTruncated = false;
    for await (const item of iterTailLines(file, st.size, startOffset)) {
      if (item === SCAN_TRUNCATED) { scanTruncated = true; break; }
      const m = HISTORY_LINE_RE.exec(item.line);
      if (!m) {
        if (!lines.length) pendingEnd = item.end;
        lines.push(item.line);
        continue;
      }
      const entry = {
        ts: dayStart + (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000,
        level: m[4].toLowerCase(),
        module: m[5],
        text: lines.length ? `${m[6]}\n${lines.reverse().join('\n')}` : m[6]
      };
      // 锚点记「整条记录（含续行）之后」的位置：跳转回来时这条记录会被完整重读
      // 一遍，绝不出现"只有头、丢了 stack 续行"的半条记录。同一秒只记反扫最先
      // 遇到的那条 = 该秒最新记录的位置。
      rememberAnchor(cache, entry.ts, lines.length ? pendingEnd : item.end);
      lines = [];
      if (entry.ts < dayStart || entry.ts >= dayEnd) continue;   // 非本日行（跨零点残留）
      if (beforeTs !== null && entry.ts >= beforeTs) continue;
      out.push(entry);
      if (out.length > max) { truncated = true; break; }         // 多取一条判 hasMore
    }
    return { logs: out.slice(0, max), hasMore: truncated, date: key, scanTruncated };
  }

  /** 可查询的日志日期列表（新到旧），只做 readdir + 文件名解析。 */
  listHistoryDates() {
    const dates = [];
    let names = [];
    try { names = fs.readdirSync(logsDir()); } catch { return dates; }
    for (const name of names) {
      const m = /^qq-agent-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && parseLogDate(m[1])) dates.push(m[1]);
    }
    return dates.sort().reverse();
  }

  /** 某日的日志文件路径；日期非法返回 null（调用方据此拒绝）。 */
  historyFile(date) {
    const key = parseLogDate(String(date ?? dateKeyOf()));
    return key ? { date: key, file: logFileFor(key) } : null;
  }

  /** 订阅新日志（返回退订函数）。 */
  onLog(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 内存里最近的日志（UI 首次加载用）。 */
  recent(limit = 200) {
    return this.memory.slice(-Math.max(1, Number(limit) || 200));
  }

  #write(level, module, args) {
    /* 重入防护：onLog 监听器里如果再调 logger.*（例如把日志转发回 logger），
       会形成 #write → 监听器 → #write 的无限递归，每条递归都给文本包一层
       模块前缀，曾经一次事故把单日日志写到 15GB（97.7% 都是重复前缀）。
       重入的调用直接丢弃：外层那条日志已经包含了全部信息。 */
    if (this.writing) return;
    this.writing = true;
    try {
      this.#writeInner(level, module, args);
    } finally {
      this.writing = false;
    }
  }

  #writeInner(level, module, args) {
    const lv = LEVELS[level] ?? LEVELS.info;
    // 脱敏放在唯一出口：下面内存环形缓冲 / console 镜像 / 落盘三处共用这份
    // 已脱敏文本，不会出现"SSE 里脱敏了但文件里没有"的漏口。
    // 详见 redact() 的注释：插件日志是凭据外泄通道（错误文案含完整 URL、query 带 token）。
    //
    // 截断同样必须在这一个出口、进内存**之前**做一次（见 MAX_LOG_TEXT_CHARS 的注释）：
    // 原先只有落盘分支截断，内存与 SSE 拿的是原样文本，一条 5MB 日志实测
    // 内存 5242880 字符 / 磁盘 65561 字节，两边口径不一致；批量时单帧 SSE 能到 10MB。
    // 先截断，内存环形缓冲、SSE 推送、落盘、历史读回拿到的就是同一份文本。
    const raw = redact(args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' '));
    const text = raw.length > MAX_LOG_TEXT_CHARS
      ? raw.slice(0, MAX_LOG_TEXT_CHARS) + LOG_TRUNCATED_MARK
      : raw;
    const entry = { ts: Date.now(), level, module: String(module || 'app'), text };

    // 内存环形缓冲（UI 查看 + SSE 推送）。
    // 按条数封顶（MAX_MEMORY）：单条正文已有 MAX_LOG_TEXT_CHARS 上限，
    // 「条数 × 单条上限」现在是有实际约束力的预算（500 × 64KB ≈ 32MB 上界），
    // 不再需要另设字节闸。
    this.memory.push(entry);
    if (this.memory.length > MAX_MEMORY) this.memory.splice(0, this.memory.length - MAX_MEMORY);
    for (const fn of [...this.listeners]) {
      try { fn(entry); } catch { /* ignore */ }
    }

    // console 镜像（开发期）
    if (this.mirrorConsole) {
      const line = `[${entry.module}] ${text}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    // 落盘（达到最低级别才写）。正文已在上面截断，这里不再重复截一次。
    if (lv >= this.level) {
      try {
        // 目录只确保一次 + 时间戳手工拼。每条日志都调 fs.mkdirSync（真实
        // syscall，启动期一次刷几百条全记在主进程账上）；toLocaleTimeString
        // ('zh-CN',…) 每次调用都新建一个 Intl.DateTimeFormat（贵对象构造，比
        // 字符串拼接慢一到两个数量级）。输出与它完全一致（本地时区 24 小时制零填充）。
        ensureLogsDir();
        const d = new Date(entry.ts);
        const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
        const line = `${time} [${level.toUpperCase().padEnd(5)}] [${entry.module}] ${text}\n`;
        fs.appendFileSync(todayFile(), line, 'utf8');
      } catch { /* 写盘失败不影响运行 */ }
    }
  }

  debug(module, ...args) { this.#write('debug', module, args); }
  info(module, ...args) { this.#write('info', module, args); }
  warn(module, ...args) { this.#write('warn', module, args); }
  error(module, ...args) { this.#write('error', module, args); }

  /**
   * 用配置里的 logs.level 覆盖当前级别（级别唯一的读取端）。
   *
   * 配置是唯一真源：级别不由任何接口直接 setLevel，而是配置写入后从配置派生
   * （见文件末尾的 onConfigApplied 订阅）。这样 POST /api/config、
   * /api/logs/level、备份恢复的 setRuntimeConfig、脚本直调 updateConfig
   * 都走同一条派生路径，不会出现"配置说 info、logger 还是 debug"的分裂。
   *
   * 配置缺失/非法就保持当前级别，不在这里兜底写盘。
   */
  applyConfiguredLevel() {
    try {
      this.setLevel(getConfig()?.logs?.level);
    } catch { /* 配置读失败时保持当前级别 */ }
  }

  /** 清理超过 KEEP_DAYS 的旧日志文件；同时给单个日志文件设上限（防爆盘）。 */
  prune() {
    try {
      const dir = logsDir();
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue;
        try {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); continue; }
          /* 单文件超过 256MB 即视为异常（正常一天 < 10MB）：
             截断保留尾部最近的内容，并留一行说明。
             曾经递归事故把单文件写到 15GB，97.7% 是重复前缀。 */
          if (st.size > 256 * 1024 * 1024) {
            const keep = 16 * 1024 * 1024;
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(keep);
            try { fs.readSync(fd, buf, 0, keep, st.size - keep); }
            finally { fs.closeSync(fd); }
            const head = `（日志异常膨胀，已截断：原 ${(st.size / 1024 / 1024 / 1024).toFixed(2)}GB，保留尾部 16MB）\n`;
            fs.writeFileSync(fp, head + buf.toString('utf8'), 'utf8');
            // 整份重写，之前的字节偏移全部作废（追加写不会，见锚点缓存注释）
            invalidateHistoryAnchors(fp);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

export const logger = new Logger();

/* 级别的派生：配置是唯一真源。任何写入配置的路径（POST /api/config、
   /api/logs/level、备份恢复的 setRuntimeConfig、脚本直调 updateConfig）都会
   走到这里刷新，不再依赖各调用方自己记得 setLevel。 */
onConfigApplied(() => logger.applyConfiguredLevel());

/**
 * 查询参数的公共解析：毫秒时间戳与条数上限。
 * 空串/null/undefined 一律视为"未提供"（返回 null），非法数值同样视为未提供。
 */
function toTs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function clampLimit(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_QUERY_LIMIT, n);
}

/**
 * 生成一个"绑定模块名"的分级日志对象：`{ debug, info, warn, error }`，每项签名
 * 与 logger 的同名方法一致但省掉 module 参数（`sub.warn('文案')`）。
 *
 * 这是核心子系统接收日志回调的唯一形态。子系统在自己的调用点按语义给出级别，
 * 而不是只传一段文案、由装配点用中文关键字猜 —— 后者会漏（新增文案没带
 * "失败/错误"就静默降级成 INFO），也不该由日志层解释业务含义。
 *
 *   const log = subLogger('app');
 *   log.warn('[skill] …');           // → logger.warn('app', '[skill] …')
 *
 * `logger` 的方法都接收 module 参数，不是这个形状；各子系统的默认值写 `console`
 * （同一组方法、自动带 [module] 前缀交给终端），测试则注入同形状的假对象。
 */
export function subLogger(module) {
  return {
    debug: (...args) => logger.debug(module, ...args),
    info: (...args) => logger.info(module, ...args),
    warn: (...args) => logger.warn(module, ...args),
    error: (...args) => logger.error(module, ...args)
  };
}
