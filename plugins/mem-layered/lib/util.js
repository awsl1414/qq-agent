// 通用工具：分词、时间键、原子读写。
//
// ⚠️ 本文件（以及本插件所有 .js）会被 plugin-loader 的静态准入闸扫描：
//   它按"能力"而不是字符串黑名单判断 —— 导入了 fs / child_process / net 之类
//   的模块就会被拦（本插件确实需要 fs，所以安装后需要在插件卡片上点一次「信任」）。
//   但另有几条**文本**层面的正则要小心：源码里不要出现核心配置文件名、
//   环境变量读取、凭据字段名之类的字面量，否则会被误判。所以这里一律不写那些词。
import fs from 'node:fs';
import path from 'node:path';

/** 会话 key → 安全文件名（与核心的命名约定保持一致：group_123 / private_456）。 */
export function safeName(chatKey) {
  return String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 读 JSON；不存在 / 损坏 / 空文件都返回 fallback，绝不抛。 */
export function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/**
 * 原子写：先写临时文件再 rename。
 * 崩溃/断电时最坏是留下一个 .tmp，永远不会出现"半截 JSON 把索引写坏"。
 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  // ⚠️（2026-10-17 体积优化）**紧凑序列化，不带缩进**。
  //    原来是 JSON.stringify(value, null, 1)（缩进 1 格）。对本插件的文件来说
  //    缩进是**纯开销**：倒排索引里一个几万条的 postings 数组，光换行和缩进空格
  //    就占 33%（实测 index/group_123456789.json 2739KB → 1836KB），
  //    而 readJson 走的是 JSON.parse —— 它和缩进完全无关，读回来的对象一模一样。
  //    块文件、state、cards、budget 也都是机器读的，一律同受益。
  //    唯一的代价是人肉 cat 这些文件时不好看了；但它们本来就是几十万字的机器数据，
  //    要查看结构应该用 tools/ 里的脚本或 JSON.parse，不该指望缩进。
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

export function removeFile(file) {
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

/**
 * 数值截断。⚠️ 注意它对 **非数值返回 lo** —— 所以只适合"已知有值、只需夹住"的场合
 * （比如块权重、命中加成）。取**设置项**请一律用下面的 num()。
 */
export function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 取设置项数值：**没配就用 fallback**，配了才夹到 [lo, hi]。
 *
 * ⚠️ 为什么不能用 clamp() 代替：clamp 对 undefined 返回 **lo**，
 *    于是"用户没配置"被悄悄解释成"用户配了下限"，而且不报错、只是功能静默失效。
 *    本插件真实踩过这个坑 ——
 *      · cardIdleDays 未配置 → clamp 成 1 天 → 语义卡存活一天就被 sweep 清光；
 *      · maxCards    未配置 → clamp 成 20 张 → 卡片库最多只留 20 张；
 *      · crossTurnMaxChars 未配置 → 80 字符（偏小，跨轮段被砍得太狠）。
 *    三处都不抛错，只是"功能看起来开着、其实没用"。
 */
export function num(value, fallback, lo = -Infinity, hi = Infinity) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

// ── 时间键 ────────────────────────────────────────────────────────────────

/** 毫秒 → YYYY-MM-DD（本地时区）。 */
export function dayKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 毫秒 → "YYYY-MM-DD HH"（本地时区）。 */
export function hourKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${dayKeyOf(ts)} ${String(d.getHours()).padStart(2, '0')}`;
}

/** 小时键或时间戳 → 时段标签：早 / 午 / 下午 / 晚 / 夜。 */
export function timeOfDayOf(tsOrHourKey) {
  let hour;
  if (typeof tsOrHourKey === 'string' && / \d{2}$/.test(tsOrHourKey)) {
    hour = Number(tsOrHourKey.slice(-2));
  } else {
    hour = new Date(Number(tsOrHourKey) || Date.now()).getHours();
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return '';
  if (hour >= 5 && hour < 11) return '早';
  if (hour >= 11 && hour < 14) return '午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚';
  return '夜';
}

export function formatWhen(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shiftDayKey(days) {
  return dayKeyOf(Date.now() + Number(days) * 86400000);
}

// ── 分词 ──────────────────────────────────────────────────────────────────
//
// 中文按「单字 + 相邻 bigram」，ASCII 按整词。不追求语言学正确，
// 只求"给对关键词能搜到"。与内置版同思路，但这里把停用词表做得更全，
// 并在索引侧做 df 剪枝（见 store.js），所以噪声更少。

const STOP = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '有', '在',
  '和', '与', '也', '就', '都', '很', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
  '一个', '一下', '什么', '怎么', '这个', '那个', '可以', '没有', '我们', '你们',
  '他们', '自己', '不是', '如果', '现在', '时候', '然后', '但是', '就是', '还是',
  '因为', '所以', '已经', '这样', '那样', '而且', '或者', '不过', '真的', '好像',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in',
  'on', 'at', 'for', 'it', 'this', 'that', 'with', 'be', 'as', 'by'
]);

/** 规范化：全角半角统一 + 转小写 + 压空白。 */
export function normText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 切 token（去重）。 */
export function tokenize(text) {
  const s = normText(text);
  if (!s) return [];
  const out = new Set();
  const push = (t) => {
    if (!t) return;
    if (STOP.has(t)) return;
    if (t.length > 40) return;
    out.add(t);
  };
  for (const m of s.matchAll(/[a-z0-9_][a-z0-9_.-]*/g)) push(m[0]);
  for (const run of s.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) || []) {
    for (let i = 0; i < run.length; i += 1) {
      push(run[i]);
      if (i + 1 < run.length) push(run.slice(i, i + 2));
    }
  }
  return [...out];
}

/** 查询串 → 带权 token（长词权重更高；整句短的话额外给一档精确短语权重）。 */
export function queryTokens(text) {
  const s = normText(text);
  const weights = new Map();
  for (const t of tokenize(s)) {
    const w = t.length >= 4 ? 2.5 : t.length >= 2 ? 1.5 : 1;
    weights.set(t, Math.max(weights.get(t) || 0, w));
  }
  // ⚠️ C5 修复（2026-10-14）：整串短语权重要过一遍停用词表。
  //    曾经不过：查询「我们」「什么」这类两字停用词时，tokenize 把成分都滤掉了，
  //    只剩这个整串 token 带着权重 4 上场 —— 而停用词永远不进索引
  //    （postings 里没有它），于是它必然落到"子串回退"分支，把 4000 次的
  //    fuzzy 预算整份烧掉，最后零命中返回。中文里两字查询极常见，
  //    这一笔浪费每遇到一次就付一次。（fuzzyBudget 还是跨 token 共享的，
  //    烧完之后同一问句里真正有用的词也得不到回退机会。）
  if (s.length >= 2 && s.length <= 24 && !STOP.has(s)) weights.set(s, 4);
  return weights;
}

// ── 时间偏好：把"昨天/前天/中午/晚上"这类词翻译成检索约束 ─────────────────

const TOD_RULES = [
  [/中午|午饭|午餐|晌午/, '午'],
  [/早上|早晨|早饭|早餐/, '早'],
  [/下午/, '下午'],
  [/晚上|晚饭|晚餐|夜里|晚间/, '晚'],
  [/半夜|凌晨|深夜|夜宵|宵夜/, '夜']
];

/**
 * 从查询串里解析时间偏好。
 * 这是"字面检索"能免费拿到的一点语义：问了"昨天"就不该让今天的碎片抢排名。
 * @returns {{preferDay: string|null, preferTod: string|null, label: string}}
 */
export function parseTimeHint(query) {
  const q = normText(query);
  let preferDay = null;
  let label = '';
  if (/大前天/.test(q)) { preferDay = shiftDayKey(-3); label = '大前天'; }
  else if (/前天/.test(q)) { preferDay = shiftDayKey(-2); label = '前天'; }
  else if (/昨天|昨晚|昨日|前一天/.test(q)) { preferDay = shiftDayKey(-1); label = '昨天'; }
  else if (/今天|今晚|今日/.test(q)) { preferDay = shiftDayKey(0); label = '今天'; }
  let preferTod = null;
  for (const [re, tag] of TOD_RULES) {
    if (re.test(q)) { preferTod = tag; break; }
  }
  return { preferDay, preferTod, label };
}
