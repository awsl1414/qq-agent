// ── 前缀缓存哨兵（self-doctor 的数据源）────────────────────────────────────
//
// 为什么单独一个文件：doctor/index.js 已经有 800+ 行，而这块是**纯取数 + 纯
// 静态分析**，不碰 issues 的判定策略。放一起会让"体检结论怎么定"和"数据从哪
// 来"纠缠，改一个总要担心另一个。
//
// 三件事：
//   ① recentCacheRounds —— 最近几轮各自的 命中 / 未命中 / 输出 token（量表）
//   ② prefixStaticAudit —— 哪些模块往稳定区注入了会变的内容、有没有标 volatile
//   ③ buildSentinel     —— 把两者揉成一份可渲染、可交给模型分析的结构
//
// 全部只读：只读 sessions / cache-warm-prefix / plugin-data，不写盘、不发请求。

import fs from 'node:fs';
import path from 'node:path';
// 跨轮击穿归因（"哪个模块的哪一段把前缀打断了"）。与 here 的分工见该文件头注释：
// 这里算"掉了多少"，那里算"谁干的"。
import { attributeBreaks, attributionText as renderAttribution } from './cache-attribution.js';

// 读文件上限：sessions 目录实测 100 个文件、读 40 个约 300ms。
// 量表只需要"最近几轮"，24 个足够看出趋势，且把体检耗时压在 200ms 内。
const ROUND_SCAN_MAX = 24;

/** 按修改时间取最新的 N 个文件（不解析内容，只 stat）。 */
function newestFiles(dir, ext, max) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; }
  const rows = [];
  for (const f of names) {
    try { rows.push({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }); } catch { /* 坏文件跳过 */ }
  }
  rows.sort((a, b) => b.m - a.m);
  return rows.slice(0, max).map((r) => path.join(dir, r.f));
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 最近几轮的 token 构成。
 *
 * 「轮」= 一次触发（一个 session），不是一次 LLM 调用 —— 一轮里模型可能因为
 * 工具循环调用多次（usage.calls），那是内部细节，用户看到的是"这轮花了多少"。
 *
 * @returns {{ rounds: Array, totals: object, scanned: number, missing: boolean }}
 */
export function recentCacheRounds(dataDir, { limit = 16 } = {}) {
  const dir = path.join(String(dataDir || ''), 'sessions');
  if (!fs.existsSync(dir)) {
    return { rounds: [], totals: {}, scanned: 0, missing: true };
  }
  const rows = [];
  let scanned = 0;
  for (const file of newestFiles(dir, '.json', ROUND_SCAN_MAX)) {
    const s = readJson(file);
    if (!s) continue;
    scanned += 1;
    const u = s.usage || {};
    const prompt = Number(u.promptTokens) || 0;
    if (!prompt) continue;                       // 没跑完/没调用的会话不计入
    const cached = Number(u.cachedTokens) || 0;
    const out = Number(u.completionTokens) || 0;
    rows.push({
      at: Number(s.startedAt) || Number(s.endedAt) || 0,
      chatKey: String(s.chatKey || ''),
      status: String(s.status || ''),
      prompt,
      cached,
      miss: Math.max(0, prompt - cached),
      out,
      calls: Number(u.calls) || 0,
      rate: prompt ? cached / prompt : 0,
      // 思考 token 单列：它算在 completion 里，但账单上要区分"说话"和"想"
      reasoning: Number(u.extra?.reasoningTokens) || 0
    });
  }
  // 时间轴从左到右（旧的在前），便于画趋势
  rows.sort((a, b) => a.at - b.at);
  const rounds = rows.slice(-Math.max(1, limit));

  const sum = (k) => rounds.reduce((s, r) => s + (r[k] || 0), 0);
  const prompt = sum('prompt');
  const cached = sum('cached');
  const totals = {
    rounds: rounds.length,
    prompt,
    cached,
    miss: sum('miss'),
    out: sum('out'),
    reasoning: sum('reasoning'),
    rate: prompt ? cached / prompt : 0,
    // 未命中占了多少输入成本：命中按 1/50 计价，所以这里算"成本占比"而不是
    // token 占比 —— 这才是用户真正关心的那个数（4% 的 token 常占 68% 的钱）。
    missCostShare: prompt
      ? (sum('miss') * 1) / (sum('miss') * 1 + cached * 0.02)
      : 0
  };
  return { rounds, totals, scanned, missing: false };
}

// ── 静态前缀体检 ──────────────────────────────────────────────────────────
//
// 判据（与 prompt.js 的 isVolatileSection 对齐）：
//   · 标了 `volatile: true` → 框架会把它挪到 user 末尾，翻字只污染自己
//   · 没标但内容随运行变化 → 在系统提示里，每变一次整条前缀重算
//
// ⚠️ 这是**启发式**，会误报。实测 video-frames 读的是配置里的帧数（只在用户改
//    设置时变），曾被 regex 的 .length/count 判成"持续抖动"。
//    所以这里只输出"疑似"，最终判据永远是 cache-guard 的 drift 记录（事实）。

const MUTATOR_HINTS = [
  { re: /Date\.now|new Date\(/, label: '时间' },
  { re: /Math\.random/, label: '随机' },
  { re: /\.length\b/, label: '库存' },
  { re: /useCount/, label: '计数' },
  { re: /getConfig\(|settings\(\)/, label: '配置' }
];

function auditOne(dir, id, meta) {
  const entry = path.join(dir, 'index.js');
  if (!fs.existsSync(entry)) return null;
  let src = '';
  try { src = fs.readFileSync(entry, 'utf8'); } catch { return null; }
  const at = src.indexOf('export function promptSections');
  if (at < 0) return null;
  const body = src.slice(at, at + 8000);
  const end = body.indexOf('\n}');
  const fn = end > 0 ? body.slice(0, end) : body;
  const signals = MUTATOR_HINTS.filter((h) => h.re.test(fn)).map((h) => h.label);
  const declaredVolatile = /volatile:\s*true/.test(fn);
  // 只读配置（settings/getConfig）而没有时间/随机/库存 → 用户改设置才变，相对稳定
  const churny = signals.some((s) => s === '时间' || s === '随机' || s === '库存' || s === '计数');
  return {
    id,
    name: String(meta?.name || id),
    declaredVolatile,
    churny,
    signals,
    verdict: declaredVolatile ? 'volatile' : (churny ? 'suspect' : 'stable')
  };
}

/**
 * 扫插件目录与 harness 目录，找出所有会注入系统提示的模块。
 * @returns {{ sections: Array, suspect: number, untouched: number }}
 */
export function prefixStaticAudit(appRoot) {
  // ⚠️ core 放前面：harness 化之后 plugins/ 里仍可能留着同名旧目录
  //    （本机实测 self-doctor / self-fix / extension-forge / dev-orders 四个都在），
  //    两者同 id 会让体检把它们算成两个"会翻字的模块"，数字虚高一倍。
  //    以 core 为准（它才是实际注册的那份），plugins 里的同名残留跳过。
  const roots = [
    { dir: path.join(appRoot, 'src', 'harness'), kind: 'core' },
    { dir: path.join(appRoot, 'plugins'), kind: 'plugin' }
  ];
  const out = [];
  const seen = new Set();
  for (const { dir, kind } of roots) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const full = path.join(dir, name);
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
      const meta = readJson(path.join(full, 'plugin.json'));
      const id = String(meta?.id || name);
      if (seen.has(id)) continue;
      const row = auditOne(full, id, meta);
      if (!row) continue;
      seen.add(id);
      out.push({ ...row, kind });
    }
  }
  return {
    sections: out,
    suspect: out.filter((r) => r.verdict === 'suspect').length,
    untouched: out.filter((r) => r.verdict === 'stable').length
  };
}

// ── 组合 ──────────────────────────────────────────────────────────────────

/**
 * 哨兵快照：量表 + 静态体检 + 击穿归因 + 真实前缀规模。UI 与模型都吃这一份。
 *
 * @param {object} opt
 * @param {string} opt.dataDir   <DATA> 根（含 sessions/）
 * @param {string} opt.appRoot   代码根（扫插件源码用）
 * @param {number} [opt.limit]   量表的轮数（尾部十几轮够看趋势）
 * @param {Record<string,string>} [opt.sectionOwner] 段标题 → 模块 id
 *        （由 doctor 从 skillManager 取；拿不到时归因里 module 为 null，
 *          UI 显示"未识别来源"而不是编一个）
 */
export function buildSentinel({ dataDir, appRoot, limit = 16, window = 0, sectionOwner = {} } = {}) {
  const rounds = recentCacheRounds(dataDir, { limit });
  const statics = prefixStaticAudit(appRoot);

  // 归因窗口比量表大得多：本机 98 个会话里只有 2 次系统提示变化，且都在几小时前，
  // 只对比最近 16 轮会得出"没有插件击穿"的假结论（实测踩过）。
  // window 不传 → 交给归因模块用它的默认上限（尽量往前看）。
  // 模块展示名：归因里写 "sticker" 不如写 "表情系统" 好读。
  // ⚠️ 不能只从静态体检派生 —— 它只收录**导出 promptSections 函数**的模块，
  //    而 speaker-identity 故意不导出（段由 manifest 声明，2026-09-20 修），
  //    会漏。这里直接扫三个根的 manifest 拿 id→name，与 buildSectionOwner
  //    （读 registry，含技能）的口径对齐。
  const moduleNames = {};
  for (const root of ['plugins', 'src/harness', 'skills']) {
    try {
      for (const name of fs.readdirSync(path.join(appRoot, root))) {
        try { if (!fs.statSync(path.join(appRoot, root, name)).isDirectory()) continue; } catch { continue; }
        const meta = readJson(path.join(appRoot, root, name, root === 'skills' ? 'skill.json' : 'plugin.json'));
        if (meta?.id && meta?.name) moduleNames[String(meta.id)] = String(meta.name);
      }
    } catch { /* 根不存在就算了，展示名退化为 id */ }
  }
  let attribution = null;
  try {
    attribution = attributeBreaks({
      dataDir,
      ...(Number(window) > 0 ? { window: Number(window) } : {}),
      sectionOwner,
      moduleNames
    });
  } catch { /* 归因失败不该让整份快照不可用 */ }

  // 真实前缀规模：保活落盘的那份（system 文本 + 工具名），用来回答
  // "这一轮 17k 里有多少是工具、多少是提示词"这类问题。
  let prefix = null;
  try {
    const p = readJson(path.join(dataDir, 'cache-warm-prefix.json'));
    if (p) {
      prefix = {
        systemChars: String(p.system || '').length,
        toolNames: Array.isArray(p.toolNames) ? p.toolNames.length : 0,
        savedAt: Number(p.savedAt) || 0,
        // 中文按 0.65 tok/字、工具 JSON 按约 0.3 tok/字符的经验折算
        estSystemTokens: Math.round(String(p.system || '').length * 0.65)
      };
    }
  } catch { /* 没落盘过就算了 */ }

  return {
    at: Date.now(),
    rounds,
    statics,
    attribution,
    prefix,
    // 一眼可读的结论，供 UI 顶部与模型 prompt 复用
    headline: buildHeadline(rounds.totals, statics)
  };
}

function buildHeadline(totals, statics) {
  if (!totals?.rounds) return { level: 'unknown', text: '还没有可统计的轮次（最近没有完整对话）。' };
  const rate = totals.rate || 0;
  const level = rate >= 0.95 ? 'good' : (rate >= 0.85 ? 'warn' : 'bad');
  const pct = (rate * 100).toFixed(1);
  const suspect = statics?.suspect || 0;
  const text = `最近 ${totals.rounds} 轮命中率 ${pct}%，未命中 ${totals.miss.toLocaleString()} tok`
    + `（按价折算占输入成本 ${(totals.missCostShare * 100).toFixed(0)}%）`
    + (suspect ? `；${suspect} 个模块注入了疑似会变的提示词段且未标 volatile` : '');
  return { level, text, rate, suspect };
}

/** 交给模型（或日志）的纯文本版；结构与 reportText 的风格一致。 */
export function sentinelText(s) {
  if (!s) return '（无数据）';
  const lines = [];
  lines.push(`【前缀缓存哨兵】${new Date(s.at).toLocaleString('zh-CN')}`);
  lines.push(s.headline.text);
  const t = s.rounds.totals || {};
  if (t.rounds) {
    lines.push('');
    lines.push(`合计：prompt ${t.prompt.toLocaleString()} / 命中 ${t.cached.toLocaleString()}`
      + ` / 未命中 ${t.miss.toLocaleString()} / 输出 ${t.out.toLocaleString()}`
      + (t.reasoning ? `（其中思考 ${t.reasoning.toLocaleString()}）` : ''));
    lines.push('最近 8 轮：');
    for (const r of s.rounds.rounds.slice(-8)) {
      const time = r.at ? new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--';
      lines.push(`  ${time}  prompt ${String(r.prompt).padStart(6)}  命中 ${String(r.cached).padStart(6)}`
        + `  未命中 ${String(r.miss).padStart(5)}  输出 ${String(r.out).padStart(4)}`
        + `  ${(r.rate * 100).toFixed(1)}%${r.calls > 1 ? `（${r.calls} 次调用）` : ''}`);
    }
  }
  if (s.prefix) {
    lines.push('');
    lines.push(`前缀规模：system ${s.prefix.systemChars} 字符（≈${s.prefix.estSystemTokens} tok）`
      + ` + ${s.prefix.toolNames} 个工具`);
  }
  const sus = (s.statics?.sections || []).filter((x) => x.verdict === 'suspect');
  if (sus.length) {
    lines.push('');
    lines.push('疑似会持续翻字的提示词段（在稳定区，未标 volatile）：');
    for (const x of sus) lines.push(`  · ${x.id}（${x.name}）：命中 ${x.signals.join('/')}`);
  } else if (s.statics?.sections?.length) {
    lines.push('');
    lines.push('静态体检：没有被判为"持续翻字"的提示词段。');
  }
  // 归因段：这是"谁干的"那一半，必须在文本版里也出现 —— 模型被问
  // "哪个插件导致击穿"时，靠的就是这几行。
  if (s.attribution) {
    lines.push('', renderAttribution(s.attribution));
  }
  lines.push('');
  lines.push('注：静态判断是启发式（会误报）；事实判据是 cache-guard 的 drift 记录。');
  return lines.join('\n');
}
