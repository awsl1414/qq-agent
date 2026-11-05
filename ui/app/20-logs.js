// 〔日志页〕工具 → 日志：当天内存首屏 + 磁盘历史翻页 + SSE 实时流
'use strict';
/* ══════════════════════════════════════════════════════════════
 为什么单独一页（而不是继续用「连接 → 应用日志」那个 <pre>）：
   · 内存只留最近 500 条，而一天落盘 1000+ 行，那个面板看不到更早的；
   · 面板里 WARN 与 INFO 长得一模一样，排错时只能肉眼翻；
   · app 模块占全部日志的 45%，不按模块筛等于没筛。

 数据来源两段 + 一路实时流，与 H1a 的后端契约一一对应：
   ① GET /api/logs          内存窗口，level/module/q/since 全部在**服务端**过滤；
                            首屏用它（limit 取满内存上限）。
   ② GET /api/logs/history  磁盘按天反向读，**没有**过滤参数、游标是毫秒 ts。
                            首屏之后一律走它：今天从内存接上磁盘，更早的日期
                            直接从磁盘尾部读。本地按同一套语义过滤。
   ③ SSE event: log         服务端 200ms 合并成一批（data 是数组）。本地只留
                            最近 200 条、丢弃溢出，并按 200ms 节流插入 DOM。

 模块下拉另有一路 GET /api/logs/modules：它回答的是「这一天、这批级别下有哪些
 模块」，因此**不接受** module / q，与上面两段列表取数的筛选条件无关。选项来自
 已加载数据时，选一个模块就会让其余模块从下拉里消失；服务端按文件算一次才
 能让选项与条数在任何筛选组合下保持同一口径。

 ── 分页为什么用「重叠一秒 + 重数去重」──
 磁盘接口的行时间戳只精确到秒（文件行只有 HH:MM:SS），`before` 的语义是
 「ts 严格更早」。若直接把「已显示的最旧一条」当游标，服务端按条数切页时
 会把某一秒切成两半：下一页用同一秒的 ts 作游标，剩下的那些行（ts 相等）
 全被排除，表现为**滚到底丢行**。
 所以游标取「最旧一条所在秒的**末尾**」（logsCursorAfter）：下一页会重读这一秒，
 多出来的重复行由 logsInsertRows 的重数去重抵掉，一秒内其余未被读到的行则补回来。
 若某一页一行新内容都没带回来（整页落在同一秒、或全被本地筛掉），游标改取
 「这一秒的开头」（exclusive），保证不原地打转。
 ══════════════════════════════════════════════════════════════ */

/* 一次取满内存窗口：服务端 MAX_QUERY_LIMIT 与 MAX_MEMORY 同为 500，取满后
   不再用 before 在内存里翻页——内存条目没有自增 id，同毫秒多条时游标会跳过
   其余条目（src/logger.js query 的已知边界）。更早的一律交给磁盘接口。 */
const LOG_MEMORY_LIMIT = 500;
const LOG_HISTORY_LIMIT = 200;    // 磁盘单页条数：渲染量与响应体积的折中
/* 单页上限的最大值，与 src/logger.js 的 MAX_QUERY_LIMIT 同值（服务端会截断到它）。
 * 用来兜住「某一秒里的行数超过单页」：见 logsFetchPage 里的 pageLimit 升级。 */
const LOG_HISTORY_LIMIT_MAX = 500;
const LOG_LIVE_MAX = 200;         // 实时流本地缓冲上限（需求：只保留最近 200 条）
const LOG_RENDER_MS = 200;        // 实时日志合批插入的节流窗口
const LOG_DEBOUNCE_MS = 300;      // 搜索框防抖
const LOG_SCROLL_EDGE_PX = 80;    // 距列表底部多少像素开始预取下一页
/* 一次「加载更多」最多连续取几页。
 *
 * 为什么不能只取一页：磁盘接口每页固定 200 条原始行，而筛选（级别/模块/关键字）、
 * 以及「整页都落在同一秒」都可能让一页只留下个位数命中。命中太少时列表撑不出
 * 滚动条，用户滚不动 → 永远触发不了下一次 scroll，页面就卡在几十行上。
 * 所以这里一直取到「有内容且铺满可视区」或「没有更早的了」为止；40 页 ≈ 8000
 * 条原始行（约 1MB），是防止超稀有关键字把当天文件整份扫一遍的护栏，
 * 到顶后仍有滚动条可继续手动翻。 */
const LOG_PAGE_BUDGET = 40;
/* 级别取值来自 00-core.js 的 LOG_LEVELS（全前端唯一一份，按低 → 高排列）。
   日志页默认勾选「info 及以上」，debug 单独记忆：用户在连接页把落盘级别开到
   debug 后，这里能多出一个勾选框把 debug 行筛出来，而不是永远看不到。 */
const LOG_DEFAULT_LEVELS = LOG_LEVELS.filter((lv) => lv !== 'debug');
const LOG_DEBUG_PREF_KEY = 'qqa-logs-debug';

/** debug 勾选状态的本地记忆（仅界面偏好，不进配置：落盘级别由连接页决定）。 */
function logsLoadDebugPref() {
  try { return localStorage.getItem(LOG_DEBUG_PREF_KEY) === '1'; } catch { return false; }
}
function logsSaveDebugPref(on) {
  try { localStorage.setItem(LOG_DEBUG_PREF_KEY, on ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
}

const logsState = {
  mounted: false,          // 外壳（工具栏 + 列表）是否已渲染
  loading: false,          // 正在拉首屏
  paging: false,           // 正在向下翻页
  error: '',
  level: new Set(logsLoadDebugPref() ? LOG_LEVELS : LOG_DEFAULT_LEVELS),
  module: '',              // '' = 全部；否则服务端按前缀匹配（skill 命中 skill:xxx）
  q: '',
  date: '',                // '' = 今天；否则 YYYY-MM-DD
  follow: true,
  fromMemory: true,        // 今天：首屏还没走内存窗口
  cursor: null,            // 下一页的 before 游标（毫秒 ts）
  pageLimit: LOG_HISTORY_LIMIT, // 当前请求的磁盘单页条数（同秒行太多时会临时放大）
  hasMore: false,
  /* 后端 readHistory 的 scanTruncated：扫描撞上 32MB 字节预算，更早的内容
     本次没读到。与 hasMore=false 组合时**不是**「到底了」，界面要明说。 */
  scanTruncated: false,
  /* 列表有内容但要附注的提示（如单秒行数超页被跳过）。null = 无。
     { text, count } —— count 是同一文案累计出现次数。 */
  notice: null,
  dates: [],               // 可选日期（新到旧）
  /* 模块分布快照：`module → 条数`，来自 GET /api/logs/modules。
     它由服务端按「这一天 + 当前级别」算一次，**与当前选中的模块、搜索关键字
     无关**（理由见 logsLoadModuleStats）。记忆的是哪一份快照：切换日期或级别
     时 keys 不匹配就重取。 */
  moduleCounts: new Map(),
  moduleStatsKey: '',      // 快照对应的「日期|级别」标识，空串 = 还没有快照
  moduleStatsNote: '',     // 快照自身的不完整/失败说明，显示在模块下拉的 title 上
  seen: new Map(),         // 重数去重表：行键 → 已显示条数（见 logsRowKey）
  seq: 0,                  // 请求序号：切筛选/切日期后丢弃过期响应
  live: [],                // 实时日志待插入缓冲
  liveInserted: 0,         // 由实时流插入、仍在列表里的行数（封顶 LOG_LIVE_MAX）
  flushTimer: null,
  qTimer: null
};

/* ══════════ 时间与行键 ══════════ */
const logsPad2 = (n) => String(n).padStart(2, '0');

function logsDateKey(d) {
  return `${d.getFullYear()}-${logsPad2(d.getMonth() + 1)}-${logsPad2(d.getDate())}`;
}

function logsToday() { return logsDateKey(new Date()); }

function logsYesterday() { return logsDateKey(new Date(Date.now() - 86400000)); }

function logsIsToday() { return !logsState.date || logsState.date === logsToday(); }

/** 今天 00:00:00 的本地时间戳：进程跑过零点后内存里还留着昨天的尾巴，用它当 since。 */
function logsDayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 行的去重键：**秒级**时间 + 级别 + 模块 + 正文。
 *
 * 秒级而不是毫秒级，是因为磁盘行的 ts 由「文件日 + 行内时分秒」还原，毫秒恒为 0；
 * 内存里的同一条记录带毫秒，两者用毫秒比较永远不相等，内存→磁盘接续的那一秒
 * 会整段重复。
 */
function logsRowKey(e) {
  return `${Math.floor(Number(e.ts) / 1000)}|${e.level}|${e.module}|${e.text}`;
}

/**
 * 游标：已显示的最旧一条所在秒的末尾（默认）或开头（exclusive）。
 * 末尾 → 下一页重读该秒、补回被切掉的行；开头 → 该秒已处理完，严格往更早走。
 */
function logsCursorAfter(ts, { exclusive = false } = {}) {
  const secStart = Math.floor(Number(ts) / 1000) * 1000;
  return exclusive ? secStart : secStart + 1000;
}

function logsDateLabel(date) {
  if (date === logsToday()) return `今天（${date}）`;
  if (date === logsYesterday()) return `昨天（${date}）`;
  return date;
}

/* ══════════ 过滤（与服务端 /api/logs 的语义一致） ══════════ */
/** 模块族：`skill:sticker` → `skill`。服务端 module 参数本来就是前缀匹配。 */
function logsFamily(mod) {
  const i = mod.indexOf(':');
  return i > 0 ? mod.slice(0, i) : mod;
}

/** 一条日志是否命中当前筛选。磁盘页与实时流共用（内存页由服务端筛好）。 */
function logsMatches(e) {
  if (logsState.level.size && !logsState.level.has(String(e.level || '').toLowerCase())) return false;
  // 模块按前缀匹配，与 GET /api/logs 的 module 参数同一语义：下拉里的族值
  // （skill）就是靠前缀命中 skill:sticker 这类具体模块。内存页由服务端筛、
  // 磁盘页与实时流用这里筛，两处必须同一个判定。
  const mod = String(e.module || '').toLowerCase();
  if (logsState.module && !mod.startsWith(logsState.module.toLowerCase())) return false;
  const q = logsState.q.trim().toLowerCase();
  if (q && !String(e.text || '').toLowerCase().includes(q) && !mod.includes(q)) return false;
  return true;
}

/* ══════════ 请求参数 ══════════ */
function logsMemoryQuery() {
  const p = new URLSearchParams();
  const lv = LOG_LEVELS.filter((x) => logsState.level.has(x));
  if (lv.length) p.set('level', lv.join(','));
  if (logsState.module) p.set('module', logsState.module);
  const q = logsState.q.trim();
  if (q) p.set('q', q);
  p.set('since', String(logsDayStart()));
  p.set('limit', String(LOG_MEMORY_LIMIT));
  return p.toString();
}

function logsHistoryQuery(date) {
  // 每秒行数超过单页时要临时把页放大（见 logsFetchPage），否则同一秒会被
  // 反复切在页边界上，剩下的行永远读不到。
  const p = new URLSearchParams({ date, limit: String(logsState.pageLimit) });
  if (logsState.cursor != null) p.set('before', String(logsState.cursor));
  return p.toString();
}

/* ══════════ 下拉数据源 ══════════ */
/**
 * 模块下拉的数据来源：`GET /api/logs/modules` 的一次服务端聚合，**不是**当前
 * 已加载数据的副产品。
 *
 * 为什么这么做（旧实现的两个死结）：
 *   · 从已加载的行里累计计数 → 选了模块后服务端/本地只返回命中的那部分，选项
 *     集合跟着塌缩，用户再也切不回别的模块；
 *   · 改成「保留已有计数、只清空不重算」→ 刷新后计数翻倍（app（2000）），
 *     跨日期切换还会把昨天的模块混进今天。
 * 下拉要回答的是一个与筛选无关的问题：「这份数据（这一天、这些级别）里有哪些
 * 模块，各多少条」。这个问题只有数据源自己能回答，所以由服务端在文件上算一次。
 *
 * 口径的两条边界：
 *   · 与 `module` 无关 —— 选中哪个模块都不改变选项集合（否则无法切换）；
 *   · 与 `q` 无关 —— 关键字是在当前模块筛选**之内**再缩小列表，若让选项跟随
 *     关键字收缩，用户删不掉关键字之前就找不到自己要切的模块了。
 *
 * 切换日期或级别时重取（同一份分布不可能同时属于两天、两套级别）；切换模块或
 * 关键字不重取，也不清空。内存首屏与磁盘翻页共用这一份快照。
 *
 * 实时流进来的新日志不即时计入分布：那份分布描述的是「进页面那一刻的数据」，
 * 逐条累加就把口径又变回「已加载数据的副产品」。点「刷新」或切换日期/级别时
 * 连同列表一起重算。
 */
function logsModuleStatsKey() {
  return `${logsIsToday() ? logsToday() : logsState.date}|${LOG_LEVELS.filter((lv) => logsState.level.has(lv)).join(',')}`;
}

async function logsLoadModuleStats(seq) {
  const key = logsModuleStatsKey();
  if (key === logsState.moduleStatsKey) return;   // 同一份口径已经有了
  try {
    const p = new URLSearchParams({ date: logsIsToday() ? logsToday() : logsState.date });
    const lv = LOG_LEVELS.filter((x) => logsState.level.has(x));
    if (lv.length) p.set('level', lv.join(','));
    const data = await api('/api/logs/modules?' + p.toString());
    if (seq !== logsState.seq) return;
    const counts = new Map();
    for (const it of Array.isArray(data.modules) ? data.modules : []) {
      if (!it || !it.module) continue;
      counts.set(String(it.module), Number(it.count) || 0);
    }
    logsState.moduleCounts = counts;
    logsState.moduleStatsKey = key;
    // 分布被 32MB 扫描预算截断时，选项只覆盖较新的那部分：说清楚，
    // 否则用户会以为某个模块今天没打过日志。
    logsState.moduleStatsNote = data.scanTruncated
      ? '模块分布未覆盖当日全部日志（扫描达到 32MB 上限），更早的模块可能未列出'
      : '';
  } catch (e) {
    // 下拉拿不到分布不该连带整页报错：列表本身是好的。
    if (seq !== logsState.seq) return;
    // 手上的快照属于另一天/另一套级别时不能继续挂着——那是另一份数据的计数，
    // 比空列表更误导。只有「同一份口径重取失败」（点刷新）才保留旧值。
    if (logsState.moduleStatsKey !== key) {
      logsState.moduleCounts = new Map();
      logsState.moduleStatsKey = '';
    }
    logsState.moduleStatsNote = `模块分布加载失败：${e?.message || e}`;
  }
  logsSyncToolbar();
}

/**
 * 模块下拉的选项：族（`skill`）聚合成 `skill:*（N）`，其余模块按条数降序。
 *
 * `module` / `q` 只影响列表内容，不影响这里的选项集合——这正是本函数不读
 * 它们的原因。选中的模块若不在快照里（该模块在这份数据里 0 条，或快照还没
 * 回来），补一条不带条数的：否则 <select> 落值失败会退成空白按钮，用户看不出
 * 当前在筛什么。
 */
function logsModuleItems() {
  const counts = logsState.moduleCounts;
  const families = new Map();
  const plains = [];
  for (const [mod, n] of counts) {
    if (mod.includes(':')) {
      const fam = logsFamily(mod);
      families.set(fam, (families.get(fam) || 0) + n);
    } else {
      plains.push([mod, n]);
    }
  }
  const byCount = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const items = [{ value: '', label: '全部模块' }];
  for (const [fam, n] of [...families].sort(byCount)) items.push({ value: fam, label: `${fam}:*（${n}）` });
  for (const [mod, n] of plains.sort(byCount)) items.push({ value: mod, label: `${mod}（${n}）` });
  if (logsState.module && !items.some((it) => it.value === logsState.module)) {
    items.push({ value: logsState.module, label: logsState.module });
  }
  return items;
}

function logsDateItems() {
  const today = logsToday();
  const items = [{ value: '', label: logsDateLabel(today) }];
  for (const d of logsState.dates) {
    if (d === today) continue;
    items.push({ value: d, label: logsDateLabel(d) });
  }
  // 选中的日期可能不在列表里（日志文件被清理），补一条，否则下拉会显示成「今天」
  if (logsState.date && logsState.date !== today && !logsState.dates.includes(logsState.date)) {
    items.push({ value: logsState.date, label: logsDateLabel(logsState.date) });
  }
  return items;
}

/* ══════════ 渲染 ══════════ */
function logsShellHtml() {
  return `
    <div class="logs-toolbar" role="toolbar" aria-label="日志筛选">
      <div class="logs-lv-group" role="group" aria-label="日志级别">
        ${LOG_LEVELS.map((lv) => `<label class="logs-lvchk" data-lv="${lv}">`
          + `<input type="checkbox" data-log-level="${lv}"${logsState.level.has(lv) ? ' checked' : ''}>`
          + `<span>${lv.toUpperCase()}</span></label>`).join('')}
      </div>
      <div class="logs-ctl">
        <label class="logs-ctl-t" for="logs-module">模块</label>
        <select id="logs-module"></select>
      </div>
      <label class="logs-search" for="logs-q">
        <span class="logs-ctl-t">搜索</span>
        <input id="logs-q" type="search" placeholder="正文或模块名" autocomplete="off" spellcheck="false">
      </label>
      <div class="logs-ctl">
        <label class="logs-ctl-t" for="logs-date">日期</label>
        <select id="logs-date"></select>
      </div>
      <label class="logs-follow" for="logs-follow">
        <input class="sw" type="checkbox" id="logs-follow" checked>
        <span>自动跟随</span>
      </label>
      <button class="btn btn-small" type="button" id="logs-refresh" title="重新拉取当前筛选下的日志">刷新</button>
      <button class="btn btn-small" type="button" id="logs-download" title="下载所选日期的完整日志文件">下载</button>
    </div>
    <div class="logs-meta">
      <span id="logs-meta" class="logs-meta-text">正在读取日志…</span>
      <button class="btn btn-small logs-newbtn" type="button" id="logs-newbtn" hidden></button>
    </div>
    <div class="logs-list" id="logs-list" role="region" aria-label="日志列表"></div>`;
}

function logsRowHtml(e, live) {
  const lv = String(e.level || 'info').toLowerCase();
  const mod = String(e.module || '-');
  return `<button type="button" class="logs-row" data-level="${esc(lv)}" tabindex="-1"`
    + ' aria-expanded="false"'
    + `${live ? ' data-live="1"' : ''}>`
    + `<span class="logs-time">${esc(fmtClock(e.ts))}</span>`
    + `<span class="logs-lv">${esc(lv.toUpperCase())}</span>`
    + `<span class="logs-mod" title="${esc(mod)}">${esc(mod)}</span>`
    + `<span class="logs-text">${esc(String(e.text ?? ''))}</span>`
    + '</button>';
}

/* 行元素 → 去重行键。插入时写入，回收时据此回退 seen 计数。
   为什么不写 data 属性：正文单条最长 64KB，塞进属性等于再复制一份 DOM 字符串，
   且 dataset 还要额外做转义；WeakMap 随元素移除自动回收，不留残余。 */
const logRowKeyOf = new WeakMap();

function logsRowCount() {
  const list = $('#logs-list');
  return list ? list.querySelectorAll('.logs-row').length : 0;
}

/**
 * 把一批日志插进列表，去重后返回真正插入的条数。
 *
 * 去重口径是「这个行键已经出现过几次」（logsState.seen 的计数），而不是
 * 一个集合：同一秒里出现 N 条完全相同的行是真实存在的（插件批量刷日志就是
 * 这种形态），用 Set 会把第 2 条起全部吃掉。分页重叠带来的重复则靠同一份
 * 计数抵掉——本批第 n 次出现，只有 n > 已出现过次数时才算新行。
 *
 * ⚠️ 计数与「列表里实际显示的行」严格对应：行被摘出 DOM（logsTrimLive 回收、
 *    刷新清空、切换日期重建）时，对应计数必须同步减回去（logsDropRowCounts）。
 *    早先只增不减的写法会让被回收的行之后从磁盘翻页读到也被吞掉——实时流刷得
 *    快时列表会缺一截最旧的实时行，而「已显示 N 条」照常统计，用户察觉不到。
 */
function logsInsertRows(logs, where, { live = false } = {}) {
  const list = $('#logs-list');
  if (!list || !logs.length) return 0;
  const batchCounts = new Map();
  const fresh = [];
  for (const e of logs) {
    const k = logsRowKey(e);
    const n = (batchCounts.get(k) || 0) + 1;
    batchCounts.set(k, n);
    const seen = logsState.seen.get(k) || 0;
    if (n <= seen) continue;
    fresh.push(e);
  }
  for (const e of fresh) {
    const k = logsRowKey(e);
    logsState.seen.set(k, (logsState.seen.get(k) || 0) + 1);
  }
  if (!fresh.length) return 0;
  list.querySelector('.logs-empty')?.remove();
  const html = fresh.map((e) => logsRowHtml(e, live)).join('');
  if (where === 'top') list.insertAdjacentHTML('afterbegin', html);
  else list.insertAdjacentHTML('beforeend', html);
  // 给新插入的每行记下它对应的行键（回收时要按行键回退 seen 计数）。
  // 用 WeakMap 挂在元素上而不是写 data 属性：正文最长 64KB，塞进属性会再复制
  // 一份 DOM 字符串，且 dataset 还要额外做一次转义；元素被移除后条目自动回收。
  const allRows = list.querySelectorAll('.logs-row');
  const inserted = where === 'top'
    ? Array.from(allRows).slice(0, fresh.length)
    : Array.from(allRows).slice(-fresh.length);
  for (let i = 0; i < inserted.length; i++) logRowKeyOf.set(inserted[i], logsRowKey(fresh[i]));

  logsEnsureRoving(list);
  return fresh.length;
}

/** 列表里始终有且只有一行可 Tab 命中：键盘用户进得去、又不会被几百个按钮淹没。 */
function logsEnsureRoving(list) {
  if (!list || !list.querySelector('.logs-row[tabindex="0"]')) return;
  const first = list.querySelector('.logs-row');
  if (first) first.tabIndex = 0;
}

/**
 * 回退若干行的 seen 计数（行从 DOM 摘掉时调用）。
 *
 * 为什么必须回退：决定「要不要插入」的唯一依据就是这份计数。列表里的行被回收
 * 后计数仍记着"见过"，那条日志之后从磁盘翻页读回来就会被当成重复吞掉，
 * 列表永久缺一段（实测灌 250 条实时行：显示 200、丢失 50、之后翻页补回 0 条）。
 */
function logsDropRowCounts(rows) {
  for (const row of rows) {
    const k = logRowKeyOf.get(row);
    if (!k) continue;
    logRowKeyOf.delete(row);
    const n = (logsState.seen.get(k) || 0) - 1;
    if (n > 0) logsState.seen.set(k, n);
    else logsState.seen.delete(k);
  }
}

/**
 * 实时行封顶：超出 LOG_LIVE_MAX 时回收最旧的几行。
 *
 * 回收必须连同 seen 计数一起回退（logsDropRowCounts）：否则被回收的行之后即使
 * 又从磁盘读到也算"见过"，永远补不回来。
 *
 * 回收的是列表**最下面**（最旧）的实时行：列表新 → 旧排列，最新的在顶部，
 * 超出「最近 200 条」的部分就是从底部滑出去的那批旧行。
 */
function logsTrimLive() {
  const extra = logsState.liveInserted - LOG_LIVE_MAX;
  if (extra <= 0) return;
  const list = $('#logs-list');
  if (!list) return;
  const liveEls = Array.from(list.querySelectorAll('.logs-row[data-live="1"]'));
  const drop = liveEls.slice(Math.max(0, liveEls.length - extra));
  logsDropRowCounts(drop);
  for (const el of drop) el.remove();
  logsState.liveInserted -= drop.length;
}

function logsShowNotice(text, actionLabel, onAction) {
  const list = $('#logs-list');
  if (!list) return;
  list.innerHTML = '<div class="logs-empty"><span>' + esc(text) + '</span>'
    + (actionLabel ? `<button class="btn btn-small" type="button" id="logs-notice-btn">${esc(actionLabel)}</button>` : '')
    + '</div>';
  if (actionLabel) {
    $('#logs-notice-btn')?.addEventListener('click', () => { if (onAction) onAction(); });
  }
}

/**
 * 提示通道：单秒行数超页被跳过这类"列表有内容但不完整"的附注。
 *
 * 与 logsShowNotice 的分工：那个是"列表为空"时的整块占位，会清空列表；
 * 这个只把文案记进 logsState.notice，由 logsRenderMeta 拼在计数条上，
 * 不碰列表 DOM。同一条文案连续出现只保留一条（count 累加），
 * 避免每次翻页都刷出一条一模一样的。用户下一次刷新/切换筛选时清空。
 */
function logsShowInlineNotice(text) {
  const notice = logsState.notice;
  if (notice && notice.text === text) { notice.count += 1; return; }
  logsState.notice = { text, count: 1 };
  logsRenderMeta();
}

function logsRenderMeta() {
  const el = $('#logs-meta');
  if (!el) return;
  const n = logsRowCount();
  let text;
  if (logsState.loading) {
    text = n ? '正在加载…' : '正在读取日志…';
  } else if (logsState.paging) {
    text = `已显示 ${n} 条 · 正在加载更早的…`;
  } else if (logsState.error) {
    text = `已显示 ${n} 条 · 加载更早的失败`;
  } else if (!n) {
    text = '';
  } else {
    text = `已显示 ${n} 条 · ${logsTailLabel()}`;
  }
  // 附注（单秒超页被跳过这类"列表不完整"的警告）接在计数后面而不是替换它：
  // 两者都要看得见。
  if (logsState.notice) {
    const { text: msg, count } = logsState.notice;
    text = (text ? `${text} · ` : '') + (count > 1 ? `${msg}（共 ${count} 次）` : msg);
  }
  el.textContent = text;
  logsUpdateNewBtn();
}

/**
 * 「到底了」的三种状态必须分开说 —— 否则扫描被预算截断时用户会以为日志就这么多。
 *
 *   hasMore                            还有更早的，滚动即可
 *   !hasMore && !scanTruncated         真的到底了
 *   !hasMore && scanTruncated          本次扫描撞上 32MB 上限，更早的**没读**，
 *                                      不是没有；必须给出缩小范围/搜索的出路
 */
function logsTailLabel() {
  if (logsState.hasMore) return '向下滚动加载更早';
  if (logsState.scanTruncated) {
    return '已到本次扫描上限（32MB），更早的日志未加载。请缩小日期范围或用关键字搜索。';
  }
  return '没有更早的了';
}

function logsUpdateNewBtn() {
  const btn = $('#logs-newbtn');
  if (!btn) return;
  const n = logsState.live.length;
  btn.hidden = !(n > 0 && !logsState.follow);
  if (!btn.hidden) {
    btn.textContent = `↑ ${n} 条新日志`;
    btn.title = '自动跟随已关闭：点击查看并回到最新';
  }
}

/**
 * 程序化设置 <select> 的选项与选中值，同时让自绘下拉（.sel）刷新显示。
 *
 * 显示同步不能靠派发 change：重建 options 后原生 select 会自己选中第一项，
 * 「要选的值恰好也是第一项」时没有任何值变化，change 无从触发，而自绘下拉的
 * 文案只在 change 上更新 —— 结果就是按钮停在旧文案（首屏是空白按钮）。
 * 所以这里显式调用 enhanceOneSelect 暴露的同步点（sel._selSyncHead），
 * 渲染细节走渲染通道，不借业务事件。mute 也随之不再需要。
 */
function logsSetSelect(sel, value, items) {
  if (!sel) return;
  const sig = items.map((it) => `${it.value}|${it.label}`).join('\n');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = items.map((it) => `<option value="${esc(it.value)}">${esc(it.label)}</option>`).join('');
  }
  // 重建后必须重新落值：innerHTML 会把 selectedIndex 归零，即使 value 没变，
  // 选中的也可能是别的项。
  sel.value = value;
  sel._selSyncHead?.();
}

function logsSyncToolbar() {
  $$('input[data-log-level]').forEach((cb) => {
    cb.checked = logsState.level.has(cb.dataset.logLevel);
  });
  logsSetSelect($('#logs-module'), logsState.module, logsModuleItems());
  // 分布自身的边界（扫描截断 / 取数失败）不能混进列表计数条——那条讲的是
  // 「已显示多少行」，与下拉选项是两回事。挂在控件提示上，鼠标悬停可查。
  const modSel = $('#logs-module');
  if (modSel) modSel.title = logsState.moduleStatsNote;
  logsSetSelect($('#logs-date'), logsState.date, logsDateItems());
  const follow = $('#logs-follow');
  if (follow) follow.checked = logsState.follow;
  logsRenderMeta();
}

/* ══════════ 取数 ══════════ */
/**
 * 取一页并插入，返回新插入的行数。
 *
 * 今天的第一页来自内存（服务端已按筛选条件过滤），之后一律读磁盘；
 * 其他日期从磁盘尾部读。磁盘页没有服务端过滤，本地按同一套语义筛，
 * 游标推进规则见文件头的「重叠一秒」说明。
 */
async function logsFetchPage(seq) {
  if (logsIsToday() && logsState.fromMemory) {
    const data = await api('/api/logs?' + logsMemoryQuery());
    if (seq !== logsState.seq) return 0;
    const logs = Array.isArray(data.logs) ? data.logs : [];
    if (Array.isArray(data.dates)) { logsState.dates = data.dates; logsSyncToolbar(); }
    logsState.fromMemory = false;
    // 内存窗口覆盖到「最旧一条」所在秒的中间，磁盘从这一秒的末尾接上
    logsState.cursor = logs.length ? logsCursorAfter(logs[logs.length - 1].ts) : null;
    logsState.hasMore = true;     // 内存以外还有磁盘，先当作还有更早的，由下一页定论
    return logsInsertRows(logs, 'bottom');
  }

  const date = logsIsToday() ? logsToday() : logsState.date;
  const prevCursor = logsState.cursor;
  const data = await api('/api/logs/history?' + logsHistoryQuery(date));
  if (seq !== logsState.seq) return 0;
  const raw = Array.isArray(data.logs) ? data.logs : [];
  logsState.hasMore = !!data.hasMore;
  // 与 hasMore 并列的第二个"没读完"信号：扫描撞上 32MB 字节预算。
  // 它**不是**「到底了」，界面必须明说（见 logsTailLabel）。
  logsState.scanTruncated = !!data.scanTruncated;

  let added = 0;
  if (raw.length) {
    const oldest = raw[raw.length - 1].ts;
    const secOf = (ts) => Math.floor(Number(ts) / 1000);
    // 整页落在同一秒、且被页长截断 → 这一秒里还有没读到的行。
    // 单一秒的行数超过页长时，「重读该秒」（默认游标）永远读不全，「越过该秒」
    // （exclusive）又会把剩下的行丢掉（实测重扫突发日志时一秒 372 条，丢了 172 行）。
    // 正确做法是把页放大后**用同一游标重读**，直到这一秒整个装进一页。
    if (secOf(raw[0].ts) === secOf(oldest) && raw.length >= logsState.pageLimit
        && logsState.pageLimit < LOG_HISTORY_LIMIT_MAX) {
      logsState.pageLimit = Math.min(LOG_HISTORY_LIMIT_MAX, logsState.pageLimit * 2);
      return logsFetchPage(seq);
    }
    const next = logsCursorAfter(oldest);
    // 与上一轮游标相同 = 这一秒里的行都见过了，必须越过它才不会原地打转。
    // 能走到这里说明页长已到服务端上限仍装不下这一秒：那一秒里超出 500 条的部分
    // 本轮无法显示，只能越过，并在页面上留痕 —— 这是数据被丢弃的唯一痕迹，
    // 只进 devtools 等于用户永远看不到（列表看起来完整，实际缺了几百条）。
    const stuck = next === prevCursor;
    if (stuck) {
      logsShowInlineNotice(`单秒日志超过单页上限（${logsState.pageLimit} 条），已跳过 `
        + `${new Date(oldest).toLocaleString('zh-CN', { hour12: false })} 这一秒的其余行`);
    }
    logsState.cursor = stuck ? logsCursorAfter(oldest, { exclusive: true }) : next;
    // 回到常规页长：只有卡在同一秒时才需要大页，之后的大页只是白传体积
    logsState.pageLimit = LOG_HISTORY_LIMIT;
    added = logsInsertRows(raw.filter(logsMatches), 'bottom');
  }
  return added;
}

/**
 * 加载更多：连续取页，直到「铺满可视区且有内容」或「没有更早的了」或「用完页预算」。
 *
 * ⚠️ 「铺满可视区」这个条件不能省：内容不足一屏就没有滚动条，scroll 事件永远
 *    不会来，筛得很窄的关键字（当天 1793 行只有 14 条命中）会停在十几行上再
 *    也长不出来。首屏（loading）与滚动到底走的是同一个函数，条件也就一致。
 *
 * 首屏也走这里——同一套游标推进逻辑。并发由 paging 挡：loading 期间 paging
 * 为真，滚动事件进不来。
 */
async function logsLoadMore({ auto = false } = {}) {
  // 条件只认 hasMore：scanTruncated 且 hasMore=false 时不能再翻页——
  // 后端已经把可扫的 32MB 扫完了，再请求只会拿到同样的空页，原地打转。
  // 那种状态下给用户的出路是缩小日期范围或搜索（见 logsTailLabel 的文案）。
  if (!logsState.hasMore || logsState.paging || !logsState.level.size) return 0;
  const list = $('#logs-list');
  const seq = logsState.seq;
  logsState.paging = true;
  if (!auto) logsRenderMeta();
  let total = 0;
  try {
    for (let i = 0; i < LOG_PAGE_BUDGET && logsState.hasMore; i++) {
      // 已经有内容且铺满一屏：剩下的交给滚动
      if (total > 0 && list && list.scrollHeight > list.clientHeight + LOG_SCROLL_EDGE_PX) break;
      total += await logsFetchPage(seq);
      if (seq !== logsState.seq) return 0;
      if (logsState.error) break;
    }
    if (seq === logsState.seq) logsState.error = '';
  } catch (e) {
    if (seq === logsState.seq) logsState.error = e?.message || String(e);
  } finally {
    if (seq === logsState.seq) {
      logsState.paging = false;
      // 模块下拉的选项来自刚取回的数据：这里必须重画工具栏，
      // 否则首屏之后下拉里永远只有「全部模块」一项（后续翻页只累计计数、
      // 不重建 DOM，用户根本选不到 app / skill 这些模块）。
      logsSyncToolbar();
    }
  }
  return total;
}

async function logsReload({ refreshStats = false } = {}) {
  if (refreshStats) logsState.moduleStatsKey = '';   // 「刷新」要连分布一起重算
  const seq = ++logsState.seq;
  logsState.error = '';
  logsState.loading = true;
  logsState.paging = false;        // 上一轮的翻页请求已废弃，别把状态卡在 paging
  logsState.fromMemory = logsIsToday();
  logsState.cursor = null;
  logsState.pageLimit = LOG_HISTORY_LIMIT;
  // 先当作「还有更早的」：首屏这一取本身就要走 logsLoadMore，
  // 由 logsFetchPage 用它拿到的数据改写（内存页恒为 true，磁盘页看 hasMore）
  logsState.hasMore = true;
  logsState.scanTruncated = false;
  logsState.notice = null;         // 上一轮的"不完整"附注属于上一份数据，跟着清掉
  logsState.live = [];
  logsState.liveInserted = 0;
  logsState.seen = new Map();
  // 模块下拉的计数**不在**这里清空：它是「这一天 + 这批级别」的分布快照，与
  // 当前选中的模块、关键字无关。切换模块时清空会让选项塌缩成一项（切不回去），
  // 逐页累加又会让计数翻倍。快照只在日期/级别变化时由 logsLoadModuleStats 重取，
  // 见那里的说明。
  const list = $('#logs-list');
  if (list) list.innerHTML = '';
  logsSyncToolbar();

  // 没勾级别就不发请求：服务端「不带 level」等于全都不筛，会把已排除的日志捞回来
  if (!logsState.level.size) {
    logsState.loading = false;
    logsShowNotice('至少勾选一个日志级别');
    logsRenderMeta();
    return;
  }

  try {
    await logsLoadMore({ auto: true });
  } catch (e) {
    if (seq === logsState.seq) logsState.error = e?.message || String(e);
  }
  if (seq !== logsState.seq) return;
  logsState.loading = false;
  if (list) list.scrollTop = 0;
  logsRenderMeta();
  // 分布快照与列表取数并行，只依赖日期与级别。单独 await 不影响列表首屏，
  // 但必须在 reload 结束前回来，否则用户刚进页面时下拉只有「全部模块」。
  await logsLoadModuleStats(seq);

  if (!logsRowCount()) {
    if (logsState.error) {
      logsShowNotice(`加载失败：${logsState.error}`, '重试', () => logsReload());
    } else if (logsState.hasMore) {
      logsShowNotice('这一段没有匹配的日志', '继续查更早的', () => logsLoadMore());
    } else if (logsState.scanTruncated) {
      // 空列表 + 扫描被截断：更早的没读到，不是没有。给出可执行的出路。
      logsShowNotice('已到本次扫描上限（32MB），更早的日志未加载。请缩小日期范围或用关键字搜索。');
    } else {
      logsShowNotice('没有匹配的日志');
    }
  }
}

/* ══════════ 实时流 ══════════ */
/**
 * SSE `log` 事件的唯一入口（02-sse-sessions.js 转发）。
 * data 是服务端 200ms 合并成的一批数组。不在日志页时调用方已经拦掉。
 */
function handleLogSseBatch(ev) {
  if (!logsState.mounted || typeof state === 'undefined' || state.tab !== 'logs') return;
  // 正在看历史日期时不插今天的实时行：它们属于「今天」，插进昨天的列表就是错位
  if (!logsIsToday()) return;
  let batch;
  try { batch = JSON.parse(ev.data); } catch { return; }
  if (!Array.isArray(batch) || !batch.length) return;
  for (const raw of batch) {
    if (!raw || !Number.isFinite(raw.ts)) continue;
    const e = {
      ts: raw.ts,
      level: String(raw.level || 'info'),
      module: String(raw.module || ''),
      text: String(raw.text ?? '')
    };
    // 实时行也要过一遍当前筛选，否则「只看 WARN」时会冒出一堆 INFO
    if (!logsMatches(e)) continue;
    logsState.live.push(e);
  }
  if (logsState.live.length > LOG_LIVE_MAX) {
    // 需求：本地缓冲只保留最近 200 条，溢出丢最旧的
    logsState.live.splice(0, logsState.live.length - LOG_LIVE_MAX);
  }
  if (logsState.live.length) logsScheduleFlush();
}

function logsScheduleFlush() {
  if (logsState.flushTimer) return;
  logsState.flushTimer = setTimeout(() => {
    logsState.flushTimer = null;
    logsFlushLive();
  }, LOG_RENDER_MS);
}

function logsFlushLive() {
  if (!logsState.live.length) return;
  if (!logsState.follow) { logsUpdateNewBtn(); return; }
  const list = $('#logs-list');
  if (!list) return;
  const batch = logsState.live.splice(0, logsState.live.length);
  // 服务端批次是「旧 → 新」、列表是「新 → 旧」，倒序后插到顶部；
  // 与已加载快照重复的行由 logsInsertRows 的重数去重抵掉
  const ordered = batch.slice().reverse();
  const atTop = list.scrollTop <= 4;
  const beforeH = list.scrollHeight;
  const added = logsInsertRows(ordered, 'top', { live: true });
  if (added) {
    logsState.liveInserted += added;
    logsTrimLive();
    // 用户正停在更早的位置阅读时，把新增高度补进 scrollTop，画面不跳
    if (!atTop) list.scrollTop += list.scrollHeight - beforeH;
    logsRenderMeta();
  }
  logsUpdateNewBtn();
}

/* ══════════ 下载 ══════════ */
/**
 * 先探一次状态码，再用浏览器原生下载。
 *
 * 为什么不直接把 <a download> 点掉：没有日志文件时下载接口返回 404 JSON，
 * 浏览器会把它当成一次失败的下载，用户什么也看不到——从日志页点到昨天、
 * 文件刚好被保留策略清理掉，表现就是「点下载没反应」。
 * 也不能只靠 logsState.dates 预判：那是上一次刷新时的快照，可能已经过期。
 *
 * 为什么用 GET 而不是 HEAD：下载路由只注册了 GET（见 src/routes.js 的
 * `{ method: 'GET', pattern: '/api/logs/download' }`），HEAD 走不到 handler，
 * 会一律回 404，拿它当探针等于把「有文件」也判成没有。
 * 所以发 GET 拿到响应头后立刻 cancel 掉 body：不占用内存读完整个文件，
 * 真正的下载仍交给浏览器的原生下载器（带 filename、走下载栏）。
 */
function logsDownload() {
  const date = logsIsToday() ? logsToday() : logsState.date;
  const url = withToken('/api/logs/download?' + new URLSearchParams({ date }).toString());
  fetch(url, { headers: { 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER } })
    .then(async (res) => {
      if (res.ok) {
        try { await res.body?.cancel(); } catch { /* 已读完或已关闭：不影响状态码判断 */ }
        const a = document.createElement('a');
        a.href = url;
        a.download = `qq-agent-${date}.log`;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }
      if (res.status === 404) { qaAlert(`${date} 没有日志文件（可能已被保留策略清理）。`); return; }
      // 413/400 等错误的正文是 JSON，浏览器下载看不出来，这里读出来转述
      const data = await res.json().catch(() => ({}));
      qaAlert(`下载失败：${data.error || `HTTP ${res.status}`}`);
    })
    .catch((e) => {
      qaAlert(`下载失败：${e?.message || e}`);
    });
}

/* ══════════ 事件绑定 ══════════ */
function logsBindToolbar(box) {
  box.querySelectorAll('input[data-log-level]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) logsState.level.add(cb.dataset.logLevel);
      else logsState.level.delete(cb.dataset.logLevel);
      if (cb.dataset.logLevel === 'debug') logsSaveDebugPref(cb.checked);
      logsReload();
    });
  });

  // 程序化改选中项（logsSetSelect）不派发 change，只有用户操作会走到这里。
  const modSel = $('#logs-module', box);
  if (modSel) {
    modSel.addEventListener('change', () => {
      logsState.module = modSel.value;
      logsReload();
    });
  }

  const dateSel = $('#logs-date', box);
  if (dateSel) {
    dateSel.addEventListener('change', () => {
      logsState.date = dateSel.value;
      logsReload();
    });
  }

  const qInput = $('#logs-q', box);
  if (qInput) {
    // 状态跟着输入即时更新，只把「发请求」防抖 300ms：
    // 否则工具栏重绘（如日期列表返回）会把还没到点的输入回写成旧值。
    qInput.addEventListener('input', () => {
      logsState.q = qInput.value;
      clearTimeout(logsState.qTimer);
      logsState.qTimer = setTimeout(() => { logsReload(); }, LOG_DEBOUNCE_MS);
    });
  }

  const follow = $('#logs-follow', box);
  if (follow) {
    follow.addEventListener('change', () => {
      logsState.follow = follow.checked;
      if (logsState.follow) logsFlushLive();
      logsUpdateNewBtn();
    });
  }

  $('#logs-refresh', box)?.addEventListener('click', () => logsReload({ refreshStats: true }));
  $('#logs-download', box)?.addEventListener('click', () => logsDownload());
  $('#logs-newbtn', box)?.addEventListener('click', () => {
    logsState.follow = true;
    if (follow) follow.checked = true;
    logsFlushLive();
    const list = $('#logs-list');
    if (list) list.scrollTop = 0;
  });

  const list = $('#logs-list', box);
  if (!list) return;

  // 滚到底自动加载更多
  list.addEventListener('scroll', () => {
    if (logsState.loading || logsState.paging || !logsState.hasMore) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - LOG_SCROLL_EDGE_PX) {
      logsLoadMore();
    }
  }, { passive: true });

  // 点一行展开完整正文（长消息、堆栈都是多行的）
  list.addEventListener('click', (ev) => {
    const row = ev.target.closest('.logs-row');
    if (!row) return;
    const open = row.classList.toggle('is-open');
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // 行间键盘导航：只让一行进 Tab 序列，上下键/Home/End 在行间移动
  list.addEventListener('keydown', (ev) => {
    const row = ev.target.closest('.logs-row');
    if (!row) return;
    let next = null;
    if (ev.key === 'ArrowDown') next = row.nextElementSibling;
    else if (ev.key === 'ArrowUp') next = row.previousElementSibling;
    else if (ev.key === 'Home') next = list.querySelector('.logs-row');
    else if (ev.key === 'End') next = list.lastElementChild;
    if (!next || !next.classList || !next.classList.contains('logs-row')) return;
    ev.preventDefault();
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
}

/* ══════════ 页面入口 ══════════ */
async function loadLogsPage() {
  const box = $('#logs-page');
  if (!box) return;
  if (!logsState.mounted) {
    box.innerHTML = logsShellHtml();
    logsBindToolbar(box);
    logsState.mounted = true;
  }
  // 每次进页都重新拉：离开期间实时事件不订阅，屏幕上那份必然是旧的
  await logsReload();
}
