// ── 缓存击穿归因：把"这一轮为什么没命中"落到「哪个模块的哪一段」────────────
//
// 为什么单独一个文件：cache-sentinel 回答"掉了多少"，这里回答"谁干的"。
// 两件事的数据源不同（前者看 usage，后者要读 systemPrompt 做 diff），
// 算法也不同（前者是求和，后者是分段指纹对比）。混在一起会互相牵制。
//
// ── 数据源（两个，互补）──────────────────────────────────────────────
//   ① sessions/*.json  —— 每次会话存档一份完整 systemPrompt（字节级真相）。
//      本机实测（2026-10-23，98 会话全窗口）：两次「表情包」翻字在相邻存档
//      之间都留了痕，会话间 diff 全部抓到，且带改前/改后全文。
//  ② plugin-data/cache-guard/stats.json 的 drift 数组 —— cache-guard 在
//      **每次 LLM 调用前**都对系统提示做分段指纹，翻字即记一条（段名级）。
//      它的不可替代性在另一个方向：会话**内部**翻字又翻回时，相邻两份存档
//      一模一样，① 看不见，只有 ② 留得下记录。两者判重后合并（同一起事件
//      保留字节级更好的 ①）。
//
// ── 算法 ───────────────────────────────────────────────────────────────
//   A. 会话间 diff：相邻两轮各取 systemPrompt，按「▸ 标题」切段（与 cache-guard
//      同一套规则），逐段比 hash，找**第一个变了的段**：
//        · 段内容变了 → 断点 = 该段起点
//        · 新增一段   → 断点 = 新段起点（其后的段只是位置后移，内容没变）
//        · 删掉一段   → 断点 = 被删段在上一轮的位置
//      断点之后的一切（后面的段 + userPrompt 全部）都要全价重算。
//   B. drift 记录合并：每条 drift 是一次真实的按调用击穿。与 A 判重
//      （翻字时刻落在相邻两轮存档之间 + 同名段 → 同一起事件，保留字节级
//      更好的 A），否则作为独立事件并入，断点位置取"翻字后最近一次存档"
//      里该段的位置，before/after 原文取翻字前后的最近存档。
//   C. 归因出口：
//        · breaks   —— 时间线（含 before/after 原文预览、断点字符位置、代价）
//        · byModule —— 按模块汇总（谁累计造成最多击穿）
//        · sections —— 模块清单（哪个模块带来了什么：段名/字节数/翻字次数）
//
//   这个算法的关键在于：**它不需要猜测**。systemPrompt 是逐字节存在 session
//   存档里的，diff 出来的断点就是真实断点。唯一的不确定性是 tools 段 ——
//   它不在存档里，所以工具集变化无法在这里归因（那是 llm.js 的 tools-watch
//   与 [req-fp] 日志的领域）。
//
// ⚠️ 与 body-lcp 日志的分工：那条日志记的是**每次请求**的断点（含 tools），
//    但只在当次有效、不落盘、不能跨轮对比。这里做的是**跨轮归因**，代价是
//    看不到 tools 段。

import fs from 'node:fs';
import path from 'node:path';

// 归因要跨天才有意义：本机实测 98 个会话里只有 2 次 system 变化，且都在
// 几小时前 —— 窗口取小了（比如最近 16 轮）会得出"没有插件击穿"的假结论。
// 所以默认尽量往前看（上限就是读文件数上限），代价只有几十毫秒。
const ATTRIBUTION_MAX_FILES = 120;
const DEFAULT_WINDOW = ATTRIBUTION_MAX_FILES;
// cache-guard 的数据文件（相对 DATA_DIR 根）。只读，不存在就跳过 B 数据源。
const DRIFT_STATS_FILE = path.join('plugin-data', 'cache-guard', 'stats.json');
// drift 与 session-diff 的判重窗口：翻字时刻落在"相邻两轮存档之间"（含少量
// 容差）且段名相同 → 同一起事件。容差给的是"存档可能滞后于翻字"。
const DEDUP_WINDOW_MS = 3 * 60 * 1000;
// before/after 原文预览长度（"详细到断点"的权衡：够看出换了什么，又不把 UI
// 撑爆）。全文在 session 存档里，需要时可以再取。
const PREVIEW_SPAN = 45;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function sha1Short(s) {
  // 只用于"等不等"的比较，不需要抗碰撞强度，用长度+简单滚动哈希足够快。
  // 120 个 session × 每段几千字符，用 crypto 会慢一个数量级。
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c) * 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}${s.length.toString(16)}`;
}

/**
 * 按「▸ 标题」切段。规则与 cache-guard/index.js 的 fingerprintSystem 完全一致
 * —— 两处必须同源，否则"哨兵说 A 段变了、归因说 B 段"会互相打脸。
 */
export function sliceSections(text) {
  const src = String(text || '');
  const marks = [];
  const re = /^▸\s*(.+)$/gm;
  let m;
  while ((m = re.exec(src))) marks.push({ title: m[1].trim(), idx: m.index });
  const out = [];
  const headEnd = marks.length ? marks[0].idx : src.length;
  out.push({ title: '(核心头部)', idx: 0, end: headEnd, hash: sha1Short(src.slice(0, headEnd)) });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : src.length;
    out.push({
      title: marks[i].title,
      idx: marks[i].idx,
      end,
      hash: sha1Short(src.slice(marks[i].idx, end))
    });
  }
  return out;
}

/** 取某份 systemPrompt 里指定段的原文（段不存在返回 ''）。 */
export function sectionSlice(text, title) {
  const src = String(text || '');
  const s = sliceSections(src).find((x) => x.title === title);
  return s ? src.slice(s.idx, s.end) : '';
}

/**
 * 找两轮之间第一个"实质性变化"的段。
 * @returns {{title:string, idx:number, change:'changed'|'added'|'removed',
 *            prev:{idx,end}|null, next:{idx,end}|null}|null}
 *   prev/next 是该段在旧轮/新轮里的字符区间（removed 时 next 为 null，added 时
 *   prev 为 null），调用方据此取 before/after 原文。
 */
export function firstSectionChange(prevText, nextText) {
  const a = sliceSections(prevText);
  const b = sliceSections(nextText);
  const aMap = new Map(a.map((s) => [s.title, s]));
  const bMap = new Map(b.map((s) => [s.title, s]));

  // 按**新一轮**的段顺序走：前缀是线性字节流，断点由"最早出现在流里的差异"决定
  for (const sb of b) {
    const sa = aMap.get(sb.title);
    if (!sa) return { title: sb.title, idx: sb.idx, change: 'added', prev: null, next: { idx: sb.idx, end: sb.end } };
    if (sa.hash !== sb.hash) {
      return {
        title: sb.title, idx: sb.idx, change: 'changed',
        prev: { idx: sa.idx, end: sa.end }, next: { idx: sb.idx, end: sb.end }
      };
    }
  }
  // 新一轮全部对得上 → 是"删了一段"：断点取被删段在旧轮里的位置
  for (const sa of a) {
    if (!bMap.has(sa.title)) return { title: sa.title, idx: sa.idx, change: 'removed', prev: { idx: sa.idx, end: sa.end }, next: null };
  }
  return null;
}

/** 取断点附近的少量文本，供 UI 显示"具体换了什么字"。 */
function excerptAround(text, pos, span = 36) {
  const s = String(text || '');
  const lo = Math.max(0, pos - span);
  const hi = Math.min(s.length, pos + span);
  return s.slice(lo, hi).replace(/\s+/g, ' ').trim();
}

/**
 * 两段文本第一个不同的字符偏移。一个是另一个的前缀时返回公共长度
 * （差异在较长者的下一个字符）。
 */
function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  return n;
}

/**
 * 以"第一个差异点"为中心的预览：段可能几百字符，变化只在其中一两行，
 * 从段首截断会前后看起来一模一样（实测第二次翻字就是这样）。窗口对准
 * 差异点，"换的到底是什么"才看得见。
 */
function previewAt(text, pos, span = PREVIEW_SPAN) {
  const s = String(text || '');
  if (!s) return '';
  const lo = Math.max(0, pos - span);
  const hi = Math.min(s.length, pos + span);
  const body = s.slice(lo, hi).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  return `${lo > 0 ? '…' : ''}${body}${hi < s.length ? '…' : ''}`;
}

/** 读 cache-guard 的 drift 记录（按调用指纹的翻字日志，本函数内按时间升序）。 */
function readDriftRecords(dataDir) {
  const d = readJson(path.join(String(dataDir || ''), DRIFT_STATS_FILE));
  const arr = d && Array.isArray(d.drift) ? d.drift : [];
  return arr
    .filter((x) => x && Number(x.at) > 0)
    .map((x) => ({
      at: Number(x.at),
      chatKey: String(x.chatKey || ''),
      sections: (Array.isArray(x.sections) ? x.sections : []).map(String),
      added: (Array.isArray(x.added) ? x.added : []).map(String),
      removed: (Array.isArray(x.removed) ? x.removed : []).map(String)
    }))
    .sort((a, b) => a.at - b.at);
}

/** 找覆盖某时刻的会话（拿不到就取开始时间最近的），用于给 drift 事件配代价。 */
function sessionCovering(rows, at) {
  if (!rows.length) return null;
  const cover = rows.find((r) => r.at <= at && (r.endAt || r.at) >= at);
  if (cover) return cover;
  return rows.reduce((best, r) => (Math.abs(r.at - at) < Math.abs(best.at - at) ? r : best), rows[0]);
}

/**
 * 跨轮击穿归因。
 *
 * @param {object} opt
 * @param {string} opt.dataDir        <DATA> 根（含 sessions/ 与 plugin-data/）
 * @param {number} [opt.window=120]   往前对比多少轮（默认=读文件上限，尽量往前看）
 * @param {Record<string,string>} [opt.sectionOwner]  段标题 → 模块 id
 * @param {Record<string,string>} [opt.moduleNames]   模块 id → 展示名
 * @returns {{breaks:Array, byModule:Array, sections:Array, tail:object,
 *            sources:object, scanned:number, compared:number, windowRounds:number}}
 */
export function attributeBreaks({ dataDir, window = DEFAULT_WINDOW, sectionOwner = {}, moduleNames = {} } = {}) {
  const dir = path.join(String(dataDir || ''), 'sessions');
  const empty = {
    breaks: [], byModule: [], sections: [], tail: { rounds: 0, miss: 0, medianMiss: 0 },
    sources: { sessions: 0, drift: 0, driftUsed: 0, deduped: 0 }, scanned: 0, compared: 0, windowRounds: 0
  };
  if (!fs.existsSync(dir)) return empty;

  // 按 mtime 取最新的 N 个（只 stat，不解析）；随后按 startedAt 重排
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return empty; }
  const stamped = [];
  for (const f of names) {
    try { stamped.push({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }); } catch { /* 跳过 */ }
  }
  stamped.sort((x, y) => y.m - x.m);

  const rows = [];
  for (const { f } of stamped.slice(0, ATTRIBUTION_MAX_FILES)) {
    const d = readJson(path.join(dir, f));
    if (!d) continue;
    const u = d.usage || {};
    const prompt = Number(u.promptTokens) || 0;
    if (!prompt || typeof d.systemPrompt !== 'string' || !d.systemPrompt) continue;
    rows.push({
      at: Number(d.startedAt) || 0,
      endAt: Number(d.endedAt) || 0,
      sys: d.systemPrompt,
      user: String(d.userPrompt || ''),
      prompt,
      cached: Number(u.cachedTokens) || 0,
      miss: Math.max(0, prompt - (Number(u.cachedTokens) || 0))
    });
  }
  rows.sort((a, b) => a.at - b.at);
  const seq = rows.slice(-Math.max(2, window));

  const breaks = [];
  let compared = 0;
  let tailRounds = 0;
  const tailMisses = [];

  // ── A. 会话间 diff（字节级，优先级最高）──────────────────────────────
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const cur = seq[i];
    compared += 1;
    const change = firstSectionChange(prev.sys, cur.sys);
    if (!change) {
      // 系统提示一字未动：这一轮的未命中全是"尾部必变"（历史滚动 + 唤醒），
      // 属于架构固有成本，不该算在任何插件头上。
      tailRounds += 1;
      tailMisses.push(cur.miss);
      continue;
    }
    // 断点落在整条前缀的什么位置：system 内部的字符占比，
    // 用来告诉用户"从这儿往后全废"，比只报段名直观。
    // removed 的断点在**旧轮**字节流里（新轮已经没有这段了），分母跟着用旧轮长度。
    const totalForPos = change.change === 'removed' ? prev.sys.length : cur.sys.length;
    const ratio = totalForPos ? change.idx / totalForPos : 0;
    const afterText = change.next ? cur.sys.slice(change.next.idx, change.next.end) : '';
    const beforeText = change.prev ? prev.sys.slice(change.prev.idx, change.prev.end) : '';
    // 预览窗口对准段内第一个差异点：几百字的段里只改了一行时，从段首
    // 截断会显得"什么都没变"（实测踩过）。
    const dOff = firstDiffOffset(beforeText, afterText);
    breaks.push({
      at: cur.at,
      prevAt: prev.at,
      title: change.title,
      titles: [change.title],
      change: change.change,
      atChar: change.idx,
      totalChars: totalForPos,
      ratio,
      // 段标题 → 模块；映射不到时保留 null，UI 会显示"未识别来源"
      module: sectionOwner[change.title] || null,
      miss: cur.miss,
      prompt: cur.prompt,
      rate: cur.prompt ? cur.cached / cur.prompt : 0,
      source: 'session',
      before: previewAt(beforeText, dOff),
      after: previewAt(afterText, dOff),
      excerpt: excerptAround(cur.sys, change.idx)
    });
  }

  // ── B. drift 记录合并（会话内部翻字，会话间 diff 抓不到的那类）──────────
  const driftAll = readDriftRecords(dataDir);
  let driftUsed = 0;
  let deduped = 0;
  for (const d of driftAll) {
    const titles = [...d.sections, ...d.added, ...d.removed];
    const title = titles[0];
    if (!title) continue;
    // 判重：同名段 + 翻字时刻被某对相邻存档覆盖（含容差）→ 同一起事件，
    // 已有字节级更好的 session 记录，drift 跳过（否则一次击穿算两回）。
    const dup = breaks.some((b) => b.title === title && d.at >= b.prevAt - 60000 && d.at <= b.at + DEDUP_WINDOW_MS);
    if (dup) { deduped += 1; continue; }
    // 翻字前后的最近存档：用来取该段的 before/after 原文与断点位置。
    // 注意这是"最近快照"而非"翻字那一瞬的原文"——drift 只存了指纹，
    // 原文以存档为准（UI 标注来源，用户能分辨精度）。
    const beforeRow = [...seq].reverse().find((r) => r.at <= d.at) || null;
    const afterRow = seq.find((r) => r.at >= d.at) || null;
    const afterText = afterRow ? sectionSlice(afterRow.sys, title) : '';
    const beforeText = beforeRow ? sectionSlice(beforeRow.sys, title) : '';
    const dOff = firstDiffOffset(beforeText, afterText);
    const host = sessionCovering(seq, d.at);
    const atChar = afterRow ? (sliceSections(afterRow.sys).find((s) => s.title === title)?.idx ?? 0) : 0;
    driftUsed += 1;
    breaks.push({
      at: d.at,
      prevAt: beforeRow ? beforeRow.at : d.at,
      title,
      titles,
      change: d.added.includes(title) ? 'added' : (d.removed.includes(title) ? 'removed' : 'changed'),
      atChar,
      totalChars: afterRow ? afterRow.sys.length : 0,
      ratio: afterRow && afterRow.sys.length ? atChar / afterRow.sys.length : 0,
      module: sectionOwner[title] || null,
      miss: host ? host.miss : 0,
      prompt: host ? host.prompt : 0,
      rate: host && host.prompt ? host.cached / host.prompt : 0,
      source: 'drift',
      chatKey: d.chatKey,
      before: previewAt(beforeText, dOff),
      after: previewAt(afterText, dOff),
      excerpt: excerptAround(afterRow ? afterRow.sys : '', atChar)
    });
  }

  breaks.sort((a, b) => a.at - b.at);

  // 按模块汇总（"谁累计造成最多击穿"）
  const agg = new Map();
  for (const b of breaks) {
    const key = b.module || `?${b.title}`;
    const row = agg.get(key) || { module: b.module, name: moduleNames[b.module] || null, count: 0, miss: 0, prompt: 0, sections: [] };
    row.count += 1;
    row.miss += b.miss;
    row.prompt += b.prompt;
    if (!row.sections.includes(b.title)) row.sections.push(b.title);
    agg.set(key, row);
  }
  const byModule = [...agg.values()].sort((a, b) => b.miss - a.miss || b.count - a.count);

  // 模块清单（"哪个模块带来了什么"）：最新一份存档里的每一段，
  // 标出归属、字节数、观测期内翻字次数。没有归属的段（核心头部）模块为 null。
  const flipCount = new Map();
  for (const b of breaks) {
    for (const t of (b.titles || [b.title])) flipCount.set(t, (flipCount.get(t) || 0) + 1);
  }
  const sections = [];
  const latest = seq.length ? seq[seq.length - 1] : null;
  if (latest) {
    const total = latest.sys.length || 1;
    for (const s of sliceSections(latest.sys)) {
      const owner = sectionOwner[s.title] || null;
      sections.push({
        title: s.title,
        chars: s.end - s.idx,
        share: (s.end - s.idx) / total,
        module: owner,
        name: owner ? (moduleNames[owner] || owner) : null,
        flips: flipCount.get(s.title) || 0
      });
    }
  }

  tailMisses.sort((a, b) => a - b);
  const tail = {
    rounds: tailRounds,
    miss: tailMisses.reduce((s, x) => s + x, 0),
    medianMiss: tailMisses.length ? tailMisses[Math.floor(tailMisses.length / 2)] : 0
  };

  return {
    breaks, byModule, sections, tail,
    sources: { sessions: rows.length, drift: driftAll.length, driftUsed, deduped },
    scanned: rows.length, compared, windowRounds: seq.length
  };
}

/** 文本版：给模型看，也给日志用。 */
export function attributionText(attr, { maxBreaks = 8 } = {}) {
  if (!attr || !attr.compared) return '【击穿归因】没有足够的会话做跨轮对比（至少要两轮完整对话）。';
  const lines = [];
  const src = attr.sources || {};
  lines.push(`【击穿归因】跨轮对比 ${attr.compared} 对（读取 ${attr.scanned} 个会话，取最近 ${attr.windowRounds || attr.compared + 1} 轮）`
    + `，另读 cache-guard 漂移记录 ${src.drift ?? 0} 条（采用 ${src.driftUsed ?? 0}，判重掉 ${src.deduped ?? 0}）`);
  if (!attr.breaks.length) {
    lines.push('系统提示在观察窗口内一字未动 —— 没有插件造成击穿。');
  } else {
    lines.push(`发现 ${attr.breaks.length} 次系统提示击穿：`);
    for (const b of attr.breaks.slice(-maxBreaks)) {
      const t = b.at ? new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--';
      const who = b.module || '未识别来源';
      const how = { changed: '段内容变化', added: '新增段', removed: '删除段' }[b.change] || b.change;
      const from = b.source === 'drift' ? '按调用指纹' : '会话间对比';
      lines.push(`  ${t}  「${(b.titles || [b.title]).join('、')}」← ${who}（${how}，${from}）`
        + `  断点 ${b.atChar}/${b.totalChars} 字符（${(b.ratio * 100).toFixed(0)}%）`
        + `  本轮 miss ${b.miss.toLocaleString()} tok`);
      if (b.before || b.after) {
        lines.push(`      改前：${b.before || '（无此段）'}`);
        lines.push(`      改后：${b.after || '（段已删除）'}`);
      } else if (b.excerpt) {
        lines.push(`      变点附近：${b.excerpt.slice(0, 70)}`);
      }
    }
    lines.push('');
    lines.push('按模块汇总（累计 miss 降序）：');
    for (const m of attr.byModule) {
      lines.push(`  ${m.module || `?${m.title}`}：${m.count} 次，累计 ${m.miss.toLocaleString()} tok`
        + `，涉及段：${(m.sections || []).join('、')}`);
    }
    lines.push('');
    lines.push('模块清单（最新存档各段归属与体量）：');
    for (const s of (attr.sections || [])) {
      const who = s.module ? `${s.module}${s.name ? `（${s.name}）` : ''}` : '核心';
      lines.push(`  「${s.title}」 ${s.chars} 字符（${(s.share * 100).toFixed(0)}%）← ${who}`
        + `${s.flips ? `  ⚠️ 观测期内翻字 ${s.flips} 次` : ''}`);
    }
  }
  lines.push('');
  lines.push(`尾部成本（无插件责任）：${attr.tail.rounds} 轮，合计 ${attr.tail.miss.toLocaleString()} tok`
    + `，中位 ${attr.tail.medianMiss.toLocaleString()} tok/轮`);
  lines.push('（工具集变化不在本归因范围内 —— tools 段不进 session 存档，需看 [req-fp] 与 tools-watch 日志。）');
  return lines.join('\n');
}
