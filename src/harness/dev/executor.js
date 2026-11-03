// 开发工单的执行器：「开发模式」的一轮对话。
//
// 这是一场持续的对话，不是单次产出：
//   · 上下文 = 系统提示 + 历史对话（文本轮） + 本轮用户消息；
//   · 模型边聊边改：文件工具 + dev_run（在项目根执行命令）；
//   · 模型停下（不再调工具）时的文字 = 本轮的回复（会被直接发到 QQ / 显示在页面）。
//
// 权限立场（用户明确要求：白名单就是最大的信任）：
//   · 文件工具以**项目根**为界：项目内任意路径可读可写（含 data/、.workbuddy/）；
//   · dev_run 在项目根**启动 shell 执行任意命令**。
//     cwd 只是**起始目录，不是沙箱**：命令能 cd 到别处、按绝对路径读写项目外文件、
//     执行任意程序、连任意主机。所以"不越出项目目录"只对文件工具有效。
//   · 文件工具还缺 realpath 校验（junction 可绕过），属已知缺口。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getConfig } from '../../config.js';
import { chatCompletionWithRetry, resolveApiKey } from '../../llm.js';
import { toOpenAiTools, executeTool } from '../../tools.js';
import { safeFetch } from '../../safe-fetch.js';
import { marketFetch, MARKET_API_BASE } from '../../market.js';
import { unzipToModuleDir } from '../../zip-install.js';

const MAX_FILE_BYTES = 1024 * 1024;        // 单文件 1MB
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILE_COUNT = 120;
// 这几个"单次工具结果"的上限直接决定**缓存命中率**：前缀缓存只在重复的前缀上命中，
// 每一轮新塞进上下文的字符 100% 是 miss。实测每轮新增的中位数只有 586 字符，
// 但 p90 是 20947：极少数几轮把读文件/命令输出的大块塞进来，就把 miss 预算吃光了。
// 所以读文件改成分页（模型只取需要的那段），命令输出与网页上限一并下调。
const MAX_READ_CHARS = 8000;               // 单页最多多少字符
const MAX_READ_LINES = 400;                // 单页最多多少行
const MAX_RUN_OUTPUT = 6000;               // 命令输出
const MAX_FETCH_CHARS = 12000;             // 网页正文
// 单轮（一次模型回复触发的所有工具调用的结果合计）最多往上下文里塞多少字符。
// 单个工具的上限管不住"一轮里连读 3 个文件"。超了就地截断并告诉模型用更精确的取法
// （offset / findstr），不是静默丢弃。
const MAX_ROUND_ADD_CHARS = 10000;
const DEFAULT_RUN_TIMEOUT = 60;            // 秒

// ── 上下文预算 ─────────────────────────────────────────────────────────────
//
// 开发模式的上下文是**追加式**的（上一轮结束时的完整消息数组 + 本轮新增），
// 这是为了前缀缓存命中率（见 runTurn 里的长注释）。代价是它会一直长：
//   单轮最多能加 maxRounds(120) × MAX_ROUND_ADD_CHARS(10k) = 120 万字符，
//   跑到一半就可能超模型窗口，上游返回 400 context_length_exceeded，
//   而 400 在 isRetryableError 里判为不可重试 → 这一轮直接失败且没有自愈路径。
// 两道闸：
//   ① 每次请求前按预算裁（落点对齐到 user 消息，系统提示与"当前这一轮的 user
//      消息及其之后"永远保留），并把"最初的需求"写进省略提示，任务本身不丢；
//   ② 万一还是撞了 context_length_exceeded → 预算减半再试一次。
// 预算默认 40 万字符（用户拍板"别压"），可在 harness → 开发工单 → 模型设置 里调小；
// 环境变量 QQ_AGENT_DEV_CTX_BUDGET 也可覆盖。
const DEV_CTX_CHAR_BUDGET_DEFAULT = 400 * 1024;
// 读配置时的下限（防止有人把预算填成 100 字符）；撞超限后自愈时可以降得更低
const DEV_CTX_MIN_BUDGET = 32 * 1024;
const DEV_CTX_RESCUE_MIN = 8 * 1024;
// 裁到预算的多少：留出余量，否则每加一轮就再裁一次，前缀每轮都断（缓存全 miss）
const DEV_CTX_TRIM_TARGET = 0.7;
export const CTX_NOTE_PREFIX = '【上下文压力】';

/** 这条消息是不是我们插的"上下文压力"提示（裁剪时不能被当成普通 user 消息）。 */
export function isCtxNote(m) {
  return !!(m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(CTX_NOTE_PREFIX));
}

/** 从既有提示里抠回"最初的需求"（裁剪会反复发生，需求不能一次比一次少）。 */
function noteRequirement(text) {
  const m = /^最初的需求：(.*)$/m.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function ctxNoteText(dropped, requirement) {
  return `${CTX_NOTE_PREFIX}更早的 ${dropped} 条对话（含工具调用足迹）已省略，用来腾出上下文空间。\n`
    + (requirement ? `最初的需求：${requirement}\n` : '')
    + '请以「最初的需求 + 下面保留的最近进度」为准继续手上的工作 —— '
    + '不要因为看不到更早的记录就重头再来，也不要重复已经做完的步骤。';
}

/**
 * 把消息数组裁到字符预算内。
 *
 * 规则（每一条都有原因，别随手改）：
 *   · 系统提示（role:system）永远保留：它是行为约定，丢了模型就不是它了；
 *   · 从最前面丢，**落点必须是 user 消息**：从 assistant(tool_calls) 中间开始会让
 *     "带 tool_calls 的 assistant 后面没有对应 tool 结果"，API 直接 400；
 *   · **最后一条 user 消息及其之后的内容永远保留**：那是"当前这一轮在干什么"；
 *   · 被丢掉的部分用一条 user 提示代替，并把最初的需求带上（防"失忆"）。
 *
 * @param {Array} msgs
 * @param {number} budget 字符预算
 * @param {number} [reserve] 不计入 msgs 但真实请求里存在的字符数（工具 schema）
 * @returns {{messages:Array, dropped:number, chars:number, trimmed:boolean}}
 */
export function trimMessagesToBudget(msgs, budget, reserve = 0) {
  const list = Array.isArray(msgs) ? msgs : [];
  const sizeOf = (a) => { try { return JSON.stringify(a).length; } catch { return 0; } };
  const overhead = Math.max(0, Number(reserve) || 0);
  // 这里**只做 1KB 的防呆**，不套用 DEV_CTX_MIN_BUDGET：下限属于"读配置"的地方
  // （executor 的 budgetNow / index.js 的 ctxBudget）。套在这里会让"预算减半重试"
  // 这类调用悄悄被抬回 32K，自愈就失效了。
  const limit = Math.max(1024, Number(budget) || DEV_CTX_CHAR_BUDGET_DEFAULT);
  const total = sizeOf(list) + overhead;
  if (total <= limit) return { messages: list, dropped: 0, chars: total, trimmed: false };

  const head = (list.length && list[0]?.role === 'system') ? [list[0]] : [];
  const body = (head.length ? list.slice(1) : list).filter((m) => !isCtxNote(m));
  const headSize = head.length ? sizeOf(head) : 0;
  const oldNote = (head.length ? list.slice(1) : list).find(isCtxNote);

  // 按 user 消息切"段"：一段 = [user, ...这一轮的全部 assistant/tool 足迹]。
  // 段的边界必须落在 user 上：从 assistant(tool_calls) 中间开始会被 API 400。
  const segs = [];
  for (const m of body) {
    if (m?.role === 'user' || !segs.length) segs.push([m]);
    else segs[segs.length - 1].push(m);
  }
  const target = Math.max(1024, Math.floor((limit - overhead) * DEV_CTX_TRIM_TARGET));
  const segSizes = segs.map((s) => sizeOf(s));
  const suffix = new Array(segs.length + 1).fill(0);
  for (let i = segs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + segSizes[i];

  // 从最后一段往前贪心：后缀和随下标递减 → 升序扫，第一个装得下的就是"能留最多"的起点。
  // 兜底保留最后一段（= 当前这一轮）。
  let keepFrom = Math.max(0, segs.length - 1);
  for (let i = 0; i < segs.length; i++) {
    if (headSize + suffix[i] <= target) { keepFrom = i; break; }
  }
  let keptSegs = segs.slice(keepFrom);

  // 最后一段自己就超预算（长任务跑到后半程很常见：单轮最多能加 maxRounds×10k 字符）
  // → 段内再裁。段内的最小不可拆单元是"assistant(tool_calls) + 它的 tool 结果"：
  //   拆开就会出现孤儿 tool 消息，API 直接 400。所以按"组"从后往前丢，
  //   但**永远保留这一段的第一条（= 当前指令）**。
  let kept = keptSegs.flat();
  let inTurnDropped = 0;
  if (headSize + sizeOf(kept) > target) {
    const last = keptSegs[keptSegs.length - 1];
    const groups = [];
    for (let i = 1; i < last.length; i++) {
      if (last[i]?.role === 'assistant') groups.push([last[i]]);
      else if (groups.length) groups[groups.length - 1].push(last[i]);
      else groups.push([last[i]]);
    }
    let gFrom = groups.length;
    for (let i = groups.length - 1; i >= 0; i--) {
      const cand = [last[0], ...groups.slice(i).flat()];
      if (headSize + sizeOf(cand) <= target) gFrom = i; else break;
    }
    inTurnDropped = groups.slice(0, gFrom).flat().length;
    if (inTurnDropped > 0) {
      kept = [...keptSegs.slice(0, -1).flat(), last[0], ...groups.slice(gFrom).flat()];
    }
  }

  const dropped = (body.length - kept.length);
  if (dropped <= 0) return { messages: list, dropped: 0, chars: total, trimmed: false };

  // 「最初的需求」：**优先用旧提示里的**：裁剪会反复发生，用"当前还在的第一条 user"
  // 会让需求一轮一轮往后漂（第一次是任务本身，第三次就变成"第 25 轮的需求"了）。
  const firstUser = body.find((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
  const requirement = (oldNote ? noteRequirement(oldNote.content) : '')
    || (firstUser ? String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 300) : '');

  const note = { role: 'user', content: ctxNoteText(dropped, requirement) };
  const out = head.length ? [head[0], note, ...kept] : [note, ...kept];
  const chars = sizeOf(out) + overhead;
  // 连"当前这一轮的 user 消息"都装不下 → 不动手，让上层如实报错（别把当前指令也丢了）
  if (chars > limit) return { messages: list, dropped: 0, chars: total, trimmed: false };
  return { messages: out, dropped, chars, trimmed: true };
}

/** 解析一个必须落在 root 之内的相对路径；越界/绝对路径返回 null。 */
function resolveInRoot(root, rel) {
  const raw = String(rel ?? '').trim().replace(/\\/g, '/');
  if (!raw) return root;   // 空 = 根目录本身（列目录用）
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const segs = raw.split('/').filter((s) => s && s !== '.');
  if (segs.includes('..')) return null;
  const abs = path.resolve(root, ...segs);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return abs;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 给"对话视图"用的一行人话标签（工具调用卡片的标题）。 */
export function toolLabel(name, args = {}) {
  if (name === 'dev_write_file') {
    const bytes = Buffer.byteLength(String(args.content ?? ''), 'utf8');
    return `写文件 ${args.path || '?'}（${fmtBytes(bytes)}）`;
  }
  if (name === 'dev_read_file') return `读文件 ${args.path || '?'}`;
  if (name === 'dev_list_dir') return `列目录 ${args.path || '/'}`;
  if (name === 'dev_delete_file') return `删文件 ${args.path || '?'}`;
  if (name === 'dev_run') return `执行命令 ${String(args.command || '').slice(0, 120)}`;
  if (name === 'dev_fetch') return `查网页 ${String(args.url || '').slice(0, 120)}`;
  if (name === 'dev_screenshot') return `截图 ${String(args.url || args.path || '').slice(0, 120)}`;
  if (name === 'dev_plan') return `更新计划（${(Array.isArray(args.items) ? args.items.length : 0)} 项）`;
  if (name === 'dev_market_search') return `搜拓展广场 ${String(args.query || '').slice(0, 60)}`;
  if (name === 'dev_market_pull') return `拉取广场扩展 ${args.id || '?'}`;
  return name || '工具';
}

/**
 * 极简 HTML → 文本（查文档用：剥脚本/样式/标签，还原常见实体，压空白）。
 *
 * 必须**线性**实现：用 `/<[^>]+>/g`、`/<script[\s\S]*?<\/script>/gi` 这类回溯正则，
 * 遇到"大量 `<` 而缺少 `>`"的输入会逐个位置回扫。实测 20k/40k/60k 个 `<`
 * 耗时 207/837/1865 ms（约平方增长），20 万量级将到约 20 秒。它跑在插件主进程，
 * 一次抓取就能冻住整个应用（QQ 收发全停）。手写单遍扫描后任意输入都是 O(n)。
 */
const MAX_HTML_CHARS = 200000;
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'section', 'article', 'br']);

export function htmlToText(html) {
  let s = String(html || '');
  if (s.length > MAX_HTML_CHARS) s = s.slice(0, MAX_HTML_CHARS);
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out.push(s.slice(i)); break; }        // 后面没有标签了
    if (lt > i) out.push(s.slice(i, lt));               // 标签前的纯文本
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { out.push(s.slice(lt)); break; }       // 没有闭合 → 当普通文本（不回溯）
    const tag = s.slice(lt + 1, gt).toLowerCase();
    const name = tag.replace(/^\/+/, '').split(/[\s/>]/)[0];
    if (name === 'li') out.push('· ');
    else if (BLOCK_TAGS.has(name)) out.push('\n');
    else out.push(' ');                                 // 行内标签 → 空档，保住词间距
    i = gt + 1;
    if (name === 'script' || name === 'style') {        // 内容整块丢弃
      const close = s.slice(i).toLowerCase().indexOf(`</${name}`);
      if (close < 0) break;
      const closeGt = s.indexOf('>', i + close);
      i = closeGt < 0 ? n : closeGt + 1;
    }
  }
  return out.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

/**
 * 把 safeFetch 的返回值渲染成给模型看的文本。
 *
 * safeFetch 返回的是**普通对象** `{ url, statusCode, truncated, body }`
 * （见 src/safe-fetch.js），**不是** fetch 的 Response。按 Response 消费
 * （`res.headers.get()` / `res.text()`）会每次都抛 `res.text is not a function`，
 * 被 catch 成"抓取失败"，这个工具就从未真正工作过。
 * 单独抽成纯函数，是为了能在测试里直接驱动（不依赖网络）。
 */
export function formatFetchedText(res, url) {
  const raw = String(res?.body ?? '');
  const head = raw.slice(0, 300).trimStart().toLowerCase();
  const looksJson = head.startsWith('{') || head.startsWith('[');
  const looksHtml = !looksJson
    && (/^<!doctype|^<html|<head|<body|<div|<p[ >]|<span|<meta|<title/.test(head)
      || /<\/[a-z]+>/.test(raw.slice(0, 4000)));
  let body;
  if (looksJson) { try { body = JSON.stringify(JSON.parse(raw), null, 2); } catch { body = raw; } }
  else if (looksHtml) body = htmlToText(raw);
  else body = raw;
  const clipped = body.slice(0, MAX_FETCH_CHARS);
  return `[${res?.statusCode ?? '?'}] ${url}\n\n${clipped || '(空)'}`
    + (body.length > MAX_FETCH_CHARS ? `\n…（已截断到 ${MAX_FETCH_CHARS} 字符）` : '');
}

// ── 「正在连接 X…」（思考前提示）───────────────────────────────────────────
//
// 开发模式一次回复可能要跑几十秒到几分钟，群里看不出机器人在不在干活。
// 每轮开始思考前先回一句，让人知道「它开始想了」。
//
// 厂商名规则：**英文品牌名保持原文**（Anthropic / OpenAI / Google / xAI …），
// 中文厂商用中文（深度求索 / 智谱 / 通义千问…）；认不出来就回退到**模型名本身**
//。宁可显示「正在连接 some-model…」也不瞎猜厂商。
const PROVIDER_RULES = [
  [/deepseek/i, '深度求索'],
  [/claude|anthropic/i, 'Anthropic'],
  [/gpt|openai|^o[1-9]/i, 'OpenAI'],
  [/gemini|google|palm/i, 'Google'],
  [/glm|zhipu|chatglm/i, '智谱'],
  [/qwen|tongyi|dashscope/i, '通义千问'],
  [/moonshot|kimi/i, '月之暗面'],
  [/grok|\bxai\b/i, 'xAI'],
  [/doubao|volc/i, '豆包'],
  [/ernie|wenxin|baidu/i, '文心一言'],
  [/hunyuan|tencent/i, '腾讯混元'],
  [/minimax|abab/i, 'MiniMax'],
  [/mistral|mixtral/i, 'Mistral'],
  [/llama|meta-?llama/i, 'Meta'],
  [/\bstepfun\b|step-[0-9]/i, '阶跃星辰'],
  [/spark|xinghuo|iflytek/i, '讯飞星火']
];

/** 模型名 → 厂商显示名（纯函数，便于测试）。 */
export function providerLabel(model) {
  const m = String(model || '').trim();
  if (!m) return '模型服务';
  for (const [re, label] of PROVIDER_RULES) {
    if (re.test(m)) return label;
  }
  return m;   // 认不出 → 用模型名本身
}

/** 思考前提示的文案（就一句话，发到群里让人知道它开始思考了）。 */
export function thinkingNoticeText(model) {
  return `正在连接${providerLabel(model)}…`;
}

/**
 * 思考前提示的节流判定（导出便于测试）。
 *
 * 第 0 轮**一定**发。那才是"他开始思考了"的信号；
 * 之后按最小间隔节流：`maxRounds` 默认 120，一个复杂任务能连跑上百个工具轮，
 * 不加间隔会把群刷屏。
 */
export function shouldSendNotice(round, lastAtMs, nowMs, gapMs) {
  if (!Number(round)) return true;
  return Number(nowMs) - Number(lastAtMs || 0) >= Math.max(0, Number(gapMs) || 0);
}

// ── 拓展广场（kondius.cn）搜索 / 拉取 ──────────────────────────────────────
//
// 为什么要它：做新插件时广场里很可能已经有实现得差不多的了，从零搭纯属浪费。
// 所以给开发 agent 一个"先搜广场 → 有就直接拉下来改"的入口。
//
// 拉取**只落开发沙箱**（`<会话>/pulled/`），不直接装进 `resources/app/plugins|skills/`：
//   · 装进去会被文件监听 + 热重载立刻加载，纯逻辑插件会**未经确认就生效**；
//   · 第三方还要过准入闸（含 fs/网络的会被拦下等信任），体验也不顺。
//   落沙箱 → 模型先读先改 → 采用时再把（改过的）文件写进 plugins/ 并重算基线。
const MARKET_FETCH_TIMEOUT_MS = 20000;
const MARKET_MAX_ZIP_BYTES = 8 * 1024 * 1024;   // 与后端 MAX_UPLOAD 对齐

/**
 * 广场条目按关键词排序（纯函数，便于测试）。
 *
 * 中文没有词边界，整串匹配几乎必然落空（广场描述不会正好含用户输入的那一串），
 * 所以除整词外再补一层 **2-gram**（"自动签到插件" → 自动/动签/签到/到插/插件）。
 * 名称/id 命中权重高于描述。
 */
export function rankMarketItems(items, query, limit = 8) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Number(limit) || 8);
  const q = String(query || '').trim();
  if (!q) return list.slice(0, n);

  const terms = q.toLowerCase().split(/[\s,，、;；/|]+/).filter(Boolean);
  const grams = new Set();
  for (const term of terms) {
    if (/[\u4e00-\u9fa5]/.test(term) && term.length >= 3) {
      for (let i = 0; i + 2 <= term.length; i++) grams.add(term.slice(i, i + 2));
    }
  }
  const scored = [];
  for (const it of list) {
    const strong = `${it?.id || ''} ${it?.name || ''}`.toLowerCase();
    const weak = `${it?.description || ''} ${it?.categoryName || ''} ${it?.author || ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (strong.includes(term)) score += 6;
      else if (weak.includes(term)) score += 3;
    }
    for (const g of grams) {
      if (strong.includes(g)) score += 1.5;
      else if (weak.includes(g)) score += 0.5;
    }
    if (score > 0) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((x) => x.it);
}

/** 广场条目 → 给人/给模型看的一行摘要（纯函数）。 */
export function marketItemLine(it) {
  const desc = String(it?.description || '').replace(/\s+/g, ' ').slice(0, 160);
  return `· ${it?.id} —— ${it?.name || ''} v${it?.version || '?'}`
    + `（${it?.categoryName || it?.category || '未分类'}${it?.author ? ' · ' + it.author : ''}）`
    + (desc ? `\n  ${desc}` : '');
}

/** 截图地址解析：http(s) 原样；否则视为项目内相对路径 → file:// URL。 */
function resolveShotUrl(raw, projectRoot) {
  const s = String(raw || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  const abs = resolveInRoot(projectRoot, s);
  if (!abs) throw new Error('截图地址不合法：必须是项目内相对路径或 http(s) 地址');
  return pathToFileURL(abs).href;
}

/** Electron 离屏窗口截图（懒加载 electron：纯 node 环境（测试）里会抛，工具层接住）。 */
async function captureWithElectron(url, { width, height, waitMs }) {
  const mod = await import('electron');
  const BrowserWindow = mod?.BrowserWindow || mod?.default?.BrowserWindow;
  if (typeof BrowserWindow !== 'function') throw new Error('Electron BrowserWindow 不可用');
  const win = new BrowserWindow({
    width: Math.min(1920, Math.max(320, Number(width) || 1280)),
    height: Math.min(1920, Math.max(240, Number(height) || 900)),
    show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  try {
    try {
      await win.loadURL(url);
    } catch (e) {
      if (!String(e?.message || e).includes('ERR_ABORTED')) throw e;   // 页面自行跳转等属正常
    }
    await new Promise((r2) => setTimeout(r2, Math.min(10000, Math.max(200, Number(waitMs) || 1200))));
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    return { png: image.toPNG(), width: size.width, height: size.height };
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
  }
}

/** 在项目根执行一条命令（异步 spawn：不阻塞主进程）。 */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(String(command), { shell: true, cwd, windowsHide: true, env: process.env });
    } catch (e) {
      resolve(`启动失败：${e?.message || e}`);
      return;
    }
    let out = '';
    let err = '';
    const push = (cur, d) => (cur.length < MAX_RUN_OUTPUT ? cur + d.toString('utf8') : cur);
    child.stdout?.on('data', (d) => { out = push(out, d); });
    child.stderr?.on('data', (d) => { err = push(err, d); });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = [
        out ? `stdout:\n${out.trimEnd()}` : '',
        err ? `stderr:\n${err.trimEnd()}` : '',
        `exit=${code}${killed ? '（超时被杀）' : ''}`
      ].filter(Boolean).join('\n');
      resolve((body || '(无输出)').slice(0, MAX_RUN_OUTPUT + 500));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`执行失败：${e?.message || e}`);
    });
  });
}

/**
 * 构造工具集（闭包绑死项目根与计数器：工具自己不可能"忘了"边界）。
 * @returns {{defs: Array, bag: object}}
 */
export function buildDevTools(projectRoot, workDir) {
  const bag = { finished: null, bytes: 0, count: 0 };
  const resolvePath = (p) => resolveInRoot(projectRoot, p);

  const defs = [
    {
      id: 'dev_read_file',
      name: '读文件',
      description: '读项目里的文件（相对项目根的路径，如 resources/app/src/config.js 或 README.md）。'
        + '改任何东西之前先读它。读不了二进制（图片等）。'
        + `大文件请**分页读**：用 offset/limit 只取需要的部分（单次最多 ${MAX_READ_LINES} 行 / ${MAX_READ_CHARS} 字符），`
        + '返回里会告诉你"共多少行、下一页从哪开始"。别一次把整份大文件拖进上下文 —— 又慢又费钱。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的路径' },
          offset: { type: 'number', description: '从第几行开始读（1 起，默认 1）' },
          limit: { type: 'number', description: `最多读多少行（默认 ${MAX_READ_LINES}）` }
        },
        required: ['path']
      },
      async execute(_ctx, args = {}) {
        const abs = resolvePath(args.path);
        if (!abs) return { content: '错误：路径不合法（必须是项目内的相对路径，不带 ..）', isError: true };
        try {
          const stat = fs.statSync(abs);
          if (!stat.isFile()) return { content: '错误：不是文件（列目录用 dev_list_dir）', isError: true };
          if (stat.size > 4 * 1024 * 1024) return { content: '错误：文件太大（>4MB）', isError: true };
          const text = fs.readFileSync(abs, 'utf8');
          if (!text) return { content: '（空文件）' };
          const all = text.split('\n');
          const start = Math.max(1, Number(args.offset) || 1);
          const limit = Math.max(1, Math.min(MAX_READ_LINES, Number(args.limit) || MAX_READ_LINES));
          const from = Math.min(start - 1, Math.max(0, all.length));
          let body = all.slice(from, from + limit).join('\n');
          let cut = '';
          if (body.length > MAX_READ_CHARS) {
            // 按"最后一个完整换行"截断：这样 offset=下一页 能精确接上。
            // 不给模型半行代码，也不会漏掉一行。
            const at = body.lastIndexOf('\n', MAX_READ_CHARS);
            body = at > 0 ? body.slice(0, at) : body.slice(0, MAX_READ_CHARS);
            cut = `（本页超出 ${MAX_READ_CHARS} 字符已截断）`;
          }
          const kept = body ? body.split('\n').length : 0;
          const endLine = Math.min(all.length, from + kept);
          const whole = from === 0 && endLine >= all.length && !cut;
          const tail = whole ? '' : `\n…（已返回第 ${from + 1}–${endLine} 行 / 共 ${all.length} 行`
            + (endLine < all.length ? `；继续读用 offset=${endLine + 1}` : '，已到文件末尾') + `）${cut}`;
          return { content: body + tail };
        } catch (e) {
          return { content: `错误：读取失败 —— ${e?.code === 'ENOENT' ? '文件不存在' : (e?.message || e)}`, isError: true };
        }
      }
    },
    {
      id: 'dev_write_file',
      name: '写文件',
      description: '写项目里的文件（可覆盖，需要时自动建目录）。path 相对项目根。单文件 ≤1MB。'
        + '这是真的写盘 —— 改前先读，改后说明改了什么。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对项目根的路径，如 resources/app/src/util.js' },
          content: { type: 'string', description: '文件的完整内容' }
        },
        required: ['path', 'content']
      },
      async execute(_ctx, args = {}) {
        const abs = resolvePath(args.path);
        if (!abs) return { content: '错误：路径不合法（必须是项目内的相对路径）', isError: true };
        const content = String(args.content ?? '');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_FILE_BYTES) return { content: `错误：单文件超限（${fmtBytes(bytes)} > 1MB）`, isError: true };
        if (bag.count >= MAX_FILE_COUNT) return { content: `错误：单轮文件数已达上限（${MAX_FILE_COUNT}）`, isError: true };
        if (bag.bytes + bytes > MAX_TOTAL_BYTES) return { content: '错误：单轮总体积已达上限（8MB）', isError: true };
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content);
          bag.count += 1;
          bag.bytes += bytes;
          return { content: `已写入 ${args.path}（${fmtBytes(bytes)}）` };
        } catch (e) {
          return { content: `错误：写入失败 —— ${e?.message || e}`, isError: true };
        }
      }
    },
    {
      id: 'dev_list_dir',
      name: '列目录',
      description: '列出项目里的目录内容（相对项目根的路径；留空列项目根）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的目录；留空 = 项目根' } },
        required: []
      },
      async execute(_ctx, args = {}) {
        const abs = resolvePath(args.path || '');
        if (!abs) return { content: '错误：路径不合法', isError: true };
        try {
          const entries = fs.readdirSync(abs, { withFileTypes: true })
            .slice(0, 300)
            .map((e) => {
              if (e.isDirectory()) return `[目录] ${e.name}/`;
              let bytes = 0;
              try { bytes = fs.statSync(path.join(abs, e.name)).size; } catch { /* ignore */ }
              return `${e.name}（${fmtBytes(bytes)}）`;
            });
          return { content: entries.length ? entries.join('\n') : '（空目录）' };
        } catch (e) {
          return { content: `错误：列目录失败 —— ${e?.code === 'ENOENT' ? '目录不存在' : (e?.message || e)}`, isError: true };
        }
      }
    },
    {
      id: 'dev_delete_file',
      name: '删文件',
      description: '删掉项目里的一个文件（相对项目根；只能删文件，目录用 dev_run）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根的路径' } },
        required: ['path']
      },
      async execute(_ctx, args = {}) {
        const abs = resolvePath(args.path);
        if (!abs) return { content: '错误：路径不合法', isError: true };
        try {
          if (!fs.statSync(abs).isFile()) return { content: '错误：只能删文件', isError: true };
          fs.rmSync(abs, { force: true });
          return { content: `已删除 ${args.path}` };
        } catch (e) {
          return { content: `错误：删除失败 —— ${e?.code === 'ENOENT' ? '文件不存在' : (e?.message || e)}`, isError: true };
        }
      }
    },
    {
      id: 'dev_run',
      name: '执行命令',
      description: '在项目根目录执行一条命令（Windows cmd，默认 60 秒超时，可传 timeoutSec 加长到最长 600 秒）。'
        + `用来查文件、git 状态、跑测试与工具脚本（若项目有 .workbuddy/tools 目录，如 node .workbuddy/tools/*.mjs；安装版没有该目录，改用其它方式验证）。会给回 stdout/stderr 和退出码（最多 ${MAX_RUN_OUTPUT} 字符，超了会截断 —— 请用 findstr/head 之类的把输出收窄）。`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 git status 或 node 某脚本.mjs' },
          timeoutSec: { type: 'number', description: '超时秒数（默认 60，最大 300）' }
        },
        required: ['command']
      },
      async execute(_ctx, args = {}) {
        const cmd = String(args.command || '').trim();
        if (!cmd) return { content: '错误：命令为空', isError: true };
        const sec = Math.min(600, Math.max(5, Number(args.timeoutSec) || DEFAULT_RUN_TIMEOUT));
        bag.count += 1;
        const out = await runCommand(cmd, projectRoot, sec * 1000);
        return { content: out };
      }
    },
    {
      id: 'dev_fetch',
      name: '查网页',
      description: '抓取一个公网 http(s) 页面的内容（只读 GET；HTML 自动剥标签，JSON 会美化，超长截断）。'
        + '用来查文档、API 参考、库的用法。内网/私有地址会被安全层拦截。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) 地址' } },
        required: ['url']
      },
      async execute(_ctx, args = {}) {
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { content: '错误：需要 http(s) 地址', isError: true };
        try {
          const res = await safeFetch(url);
          return { content: formatFetchedText(res, url) };
        } catch (e) {
          return { content: `错误：抓取失败 —— ${e?.message || e}`, isError: true };
        }
      }
    },
    {
      id: 'dev_market_search',
      name: '搜拓展广场',
      description: '在 QQ Agent 官方拓展广场（kondius.cn）里按关键词搜现成的插件/技能。'
        + '做**新**插件/技能之前先搜这里 —— 有类似的就别从零写。返回 id / 名称 / 作者 / 版本 / 分类 / 用途摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，中文或英文都行；多个词用空格分开' },
          limit: { type: 'number', description: '最多返回几条（默认 8）' }
        },
        required: ['query']
      },
      async execute(_ctx, args = {}) {
        const q = String(args.query || '').trim();
        if (!q) return { content: '错误：关键词为空', isError: true };
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
        try {
          const data = await marketFetch('/plugins', { timeoutMs: MARKET_FETCH_TIMEOUT_MS });
          const items = Array.isArray(data?.items) ? data.items : [];
          bag.count += 1;
          const hits = rankMarketItems(items, q, limit);
          if (!hits.length) {
            return {
              content: `广场里没有搜到「${q}」相关的扩展（广场共 ${items.length} 个）。`
                + '可以换个关键词再搜一次，或直接从零实现。'
            };
          }
          return {
            content: `广场共 ${items.length} 个扩展，与「${q}」相关的有 ${hits.length} 个（按相关度排序）：\n`
              + hits.map(marketItemLine).join('\n')
              + '\n\n想用哪个就用 dev_market_pull 拉它（传上面的 id）。拉下来先读一遍，再问用户要不要基于它改。'
          };
        } catch (e) {
          return { content: `错误：连不上拓展广场 —— ${e?.message || e}`, isError: true };
        }
      }
    },
    {
      id: 'dev_market_pull',
      name: '拉取广场扩展',
      description: '把拓展广场里的某个插件/技能下载到**本次会话的沙箱**（dev-sandbox/<会话>/pulled/ 下）。'
        + '不会装进项目、不会自动加载 —— 拉下来先读、再按需求改，采用时由你把文件写进 resources/app/plugins|skills/。'
        + 'id 从 dev_market_search 的结果里取。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '广场条目的 id，如 revenge-ledger' } },
        required: ['id']
      },
      async execute(_ctx, args = {}) {
        const want = String(args.id || '').trim();
        if (!want) return { content: '错误：需要 id（先用 dev_market_search 搜）', isError: true };
        try {
          const data = await marketFetch('/plugins', { timeoutMs: MARKET_FETCH_TIMEOUT_MS });
          const items = Array.isArray(data?.items) ? data.items : [];
          const it = items.find((x) => String(x?.id) === want)
            || items.find((x) => String(x?.id || '').toLowerCase() === want.toLowerCase());
          if (!it) return { content: `错误：广场里没有 id 为「${want}」的条目（先用 dev_market_search 搜一下）`, isError: true };
          const code = String(it.installCode || '').trim();
          if (!code) return { content: `错误：「${want}」当前没有可下载的安装口令（可能还在审核中）。`, isError: true };

          const res = await fetch(`${MARKET_API_BASE}/install/${encodeURIComponent(code.toUpperCase())}/download`, {
            signal: AbortSignal.timeout(120000)
          });
          if (!res.ok) return { content: `错误：下载失败 HTTP ${res.status}`, isError: true };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > MARKET_MAX_ZIP_BYTES) return { content: '错误：安装包超过 8MB 上限', isError: true };

          const type = String(it.type || '').toLowerCase() === 'plugin' ? 'plugin' : 'skill';
          const pulledRoot = path.join(workDir, 'pulled');
          fs.mkdirSync(pulledRoot, { recursive: true });
          // 复用安装通道的解压器：自带路径穿越校验 + 目录名冲突递增（永不覆盖）
          const dirName = await unzipToModuleDir(buf, { root: pulledRoot, type, preferId: want });
          const abs = path.join(pulledRoot, type === 'plugin' ? 'plugins' : 'skills', dirName);
          const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
          bag.count += 1;
          return {
            content: `已拉到沙箱：${rel}\n`
              + `来源：${it.name || want} v${it.version || '?'}（${it.author ? '作者 ' + it.author : '未声明作者'}`
              + `${it.categoryName ? ' · ' + it.categoryName : ''}）· 类型 ${type === 'plugin' ? '插件' : '技能'}\n`
              + '下一步：用 dev_list_dir / dev_read_file 读它（路径相对项目根）。\n'
              + '⚠️ 读完先停下来问用户「要不要基于它改」—— 不要直接开写。'
          };
        } catch (e) {
          return { content: `错误：拉取失败 —— ${e?.message || e}`, isError: true };
        }
      }
    },
    {
      id: 'dev_screenshot',
      name: '截图看效果',
      description: '用离屏浏览器打开一个页面并截图，图片会回传给你（你能"看见"渲染效果）。'
        + 'url 可以是项目内相对路径（如 dev-sandbox/dev-1/index.html → 自动转 file://），也可以是 http(s) 地址。'
        + '网页/前端任务：改完截图看一眼再汇报。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '项目内相对路径 或 http(s) 地址' },
          width: { type: 'number', description: '视口宽（默认 1280）' },
          height: { type: 'number', description: '视口高（默认 900）' },
          waitMs: { type: 'number', description: '加载后等待毫秒（默认 1200，等脚本/字体渲染）' }
        },
        required: ['url']
      },
      async execute(_ctx, args = {}) {
        let url;
        try { url = resolveShotUrl(args.url, projectRoot); }
        catch (e) { return { content: `错误：${e?.message || e}`, isError: true }; }
        let shot;
        try {
          shot = await captureWithElectron(url, { width: args.width, height: args.height, waitMs: args.waitMs });
        } catch (e) {
          const msg = String(e?.message || e);
          if (/electron|Cannot find|ERR_MODULE/i.test(msg)) {
            return { content: '错误：截图需要在应用内运行（Electron 环境）。在真实应用里这个工具可用。', isError: true };
          }
          return { content: `错误：截图失败 —— ${msg}`, isError: true };
        }
        bag.count += 1;
        const rel = `dev-sandbox/${path.basename(workDir)}/screenshots/shot-${bag.count}.png`
          .replace(/\\/g, '/');
        const abs = path.join(projectRoot, rel);
        try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, shot.png); }
        catch (e) { return { content: `错误：截图保存失败 —— ${e?.message || e}`, isError: true }; }
        return {
          content: `截图已保存 ${rel}（${shot.width}x${shot.height}），图片见下一条消息。请查看渲染效果是否符合预期。`,
          imageBase64: `data:image/png;base64,${shot.png.toString('base64')}`
        };
      }
    },
    {
      id: 'dev_plan',
      name: '更新计划',
      description: '复杂任务先列计划（3–6 项），做完一项就把对应项的 done 设为 true。计划会显示给用户，也帮你在长任务里不跑偏。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '计划项数组，如 [{"text":"读现有实现","done":true},{"text":"改 util.js","done":false}]',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, done: { type: 'boolean' } },
              required: ['text']
            }
          }
        },
        required: ['items']
      },
      async execute(_ctx, args = {}) {
        const items = (Array.isArray(args.items) ? args.items : [])
          .slice(0, 12)
          .map((x) => ({ text: String(typeof x === 'string' ? x : x?.text || '').slice(0, 200), done: x?.done === true }))
          .filter((x) => x.text);
        if (!items.length) return { content: '错误：计划为空', isError: true };
        bag.plan = items;
        const doneN = items.filter((x) => x.done).length;
        return { content: `计划已更新（${doneN}/${items.length} 完成）`, plan: items };
      }
    }
  ];

  return { defs, bag, workDir };
}

function buildSysPrompt(projectRoot, workDir) {
  return [
    '你是 QQ Agent 项目的「开发模式」agent：白名单用户通过 QQ 群 / 私聊 / harness 页面直连你，',
    '你输出的文字会被**直接发到群里**（本机会话则显示在页面上）——像聊天一样说话。',
    '',
    `项目根目录：${projectRoot}（文件工具以此为界；dev_run 在此目录下启动命令行）`,
    `自己的产出建议放：${path.relative(projectRoot, workDir).replace(/\\/g, '/')}/（不是必须）。`,
    '',
    '工作方式：',
    '1. 对话即开发：用户让改什么就改什么。结合历史对话 + 项目文件定位，别臆测 —— 改前先读。',
    '2. 标准节奏：读相关文件定位 → 小步实现 → 用 dev_run 跑测试/命令验证 → 一句话汇报。',
    '   尽量在一轮里把事情做完；卡住了就换方案继续试，不要中途把问题抛回给用户。',
    '3. 工具：dev_read_file / dev_write_file / dev_delete_file / dev_list_dir（路径都**相对项目根**）、',
    '   dev_run（在项目根执行命令：跑测试、查 git、重算基线等）、dev_fetch（抓公网页面查文档/用法）、',
    '   dev_screenshot（离屏截图，图片会回传给你 —— 你能"看见"渲染效果）、dev_plan（列计划防跑偏）、',
    '   dev_market_search / dev_market_pull（搜 / 拉拓展广场的现成扩展，见第 2b 条）。',
    '2b. **做「新」插件 / 技能前，先搜拓展广场**（用户明确要求，别跳过）：',
    '   · 先 dev_market_search 搜关键词（广场里已有 140+ 个扩展，换个说法多搜一两次 —— 中文没有词边界）；',
    '   · 有类似的 → dev_market_pull 拉到沙箱 → dev_read_file 读一遍 → **先回一句问用户「要不要基于它改」，等答复**；',
    '     用户说要 → 在沙箱里改好，再把（改过的）文件写进 resources/app/plugins|skills/<新目录>/，并跑基线重算；',
    '     用户说不要 → 照常从零做（拉下来的目录先留着，用户没让删就别删）。',
    '   · 没搜到 → 说一句「广场里没有类似的」然后从零做，不要在搜索上反复纠缠。',
    '   · 只有「改现有代码 / 修 bug」这类需求不用搜；纯粹做新东西才搜。',
    '3b. 什么时候用什么：改前端/网页 → 写完必 dev_screenshot 看效果再汇报；',
    '    遇到不熟悉的 API/库 → 先 dev_fetch 查文档，别凭记忆瞎写；',
    '    复杂任务（≥3 步）→ 先 dev_plan 列 3–6 项计划，做完一项更新一次。',
    '4. 文件就是你的记忆：需要事实先读文件或跑命令确认。',
    '5. 常用位置：resources/app/src（核心）、resources/app/plugins|skills（扩展）、data/（运行时数据）、',
    '   .workbuddy/tools（测试与工具脚本，**仅开发环境有该目录**）、dev-sandbox/（其他会话的产出）。',
    '6. 仅当 .workbuddy/tools 存在（开发环境）：改了 resources/app/plugins|skills 里的内置模块后，执行',
    '   node .workbuddy/tools/refresh-builtin-baseline.mjs 重算基线（否则热重载会因基线不符拦下该模块）。',
    '   该目录不存在时（安装版）**不要手改内置模块文件** —— 基线无法重算，改动会被准入闸拦下。',
    '7. 仅当 .workbuddy/tools 存在：改完核心/插件跑对应测试套件验证（fix-test.mjs、review-fix-test.mjs、',
    '   session-path-test.mjs、dev-orders-test.mjs）。目录不存在时改用实际行为验证（跑一次真实调用看结果）。',
    '8. 回复要像聊天：1–3 句话，说清「改了什么 / 在哪 / 怎么验证」；不贴大段代码、不写长篇报告。',
    '9. 用户完全信任你（白名单）——不要问"要不要做"，直接做；不确定就选最合理的解释并在回复里说一句。',
    '   **唯一例外**：从广场拉到现成扩展后，必须先问一句「要不要基于它改」再动手（这是用户明确要求的确认点）。'
  ].join('\n');
}

/**
 * 跑一轮对话。
 * @param {function} notify      「正在连接 X…」的出口（QQ 会话直发回群；本机会话传 null，提示只进 transcript）
 * @param {boolean} noticeEnabled  是否开启思考前提示（默认开）
 * @param {number}  noticeGapSec   同一会话两次提示的最小间隔秒数（默认 20；第 0 轮一定发）
 * @param {object}  abortBox      调用方传进来的空对象：本函数会把 `abort()` 挂上去，
 *                                 供外部（界面的「中止」按钮）打断这一轮。
 * @returns {Promise<string>} 本轮的回复文本（模型的最后一段话；空则返回空串）
 */

/** 只保留 API 认得的字段：存盘再读回来时别夹带多余键（严格端点会 400）。 */
function sanitizeMsg(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: m.content };
  if (m.role === 'assistant') {
    return { role: 'assistant', content: m.content ?? null, ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls } : {}) };
  }
  if (m.role === 'user') return { role: 'user', content: m.content };
  return null;
}

/** 只保留 API 认得的字段（导出仅供测试）。 */
export { sanitizeMsg };

export async function runTurn({ session, userText, userFrom, history, priorMessages = null, workDir, projectRoot, maxRounds, timeoutSec, ctxCharBudget = 0, log = () => {}, onEvent = null, notify = null, noticeEnabled = true, noticeGapSec = 20, abortBox = null, usageBox = null, ctxOut = null }) {
  const emit = (e) => { try { onEvent?.(e); } catch { /* 记录失败不影响执行 */ } };
  const { defs, bag } = buildDevTools(projectRoot, workDir);
  const openAiTools = toOpenAiTools(defs);
  // 工具 schema 不在 messages 里，但真实请求体里有：算预算时必须带上
  const toolsChars = (() => { try { return JSON.stringify(openAiTools).length; } catch { return 0; } })();
  // 本轮的上下文预算（可被"撞了超限"这一步减半，见下面的 catch）
  let budgetNow = Math.max(DEV_CTX_MIN_BUDGET,
    Number(ctxCharBudget) || Number(process.env.QQ_AGENT_DEV_CTX_BUDGET) || DEV_CTX_CHAR_BUDGET_DEFAULT);

  // 模型凭据优先级：开发模式对模型能力要求高，可单独指强模型。
  //   「开发工单 → 模型设置」（devApi） > 自检专用（doctorApi） > 全局聊天模型
  const cfg = getConfig();
  const pick = (o) => (o && o.enabled === true && String(o.model || '').trim() ? o : null);
  const src = pick(cfg.devApi) || pick(cfg.doctorApi);
  const overrides = src ? {
    baseUrl: String(src.baseUrl || cfg.api?.baseUrl || ''),
    apiKey: String(src.apiKey || '').trim() || resolveApiKey(cfg),
    model: String(src.model).trim()
  } : null;
  const modelName = overrides ? overrides.model : (cfg.api?.model || '');
  if (!modelName) {
    throw new Error(src === cfg.devApi && cfg.devApi?.enabled
      ? '开发专用模型未填 model（harness → 开发工单 → 模型设置）'
      : '尚未配置聊天模型（设置 → 模型与搜索 → 模型 API）');
  }
  // 与正常对话**共用同一个模型**时，两者的前缀缓存会互相挤占
  // （前缀缓存的容量按账号/模型共享，谁的上下文大谁挤谁）。开发模式的上下文
  // 更长（追加式），更容易把正常对话的前缀挤出去。给一个明确警告 + 指路
  // （不强制：换模型是用户的选择）。
  if (!overrides?.model || overrides.model === cfg.api?.model) {
    log(`⚠️ 开发模式与正常对话共用模型「${modelName}」—— 两者的前缀缓存会互相挤占。`
      + '建议在 harness → 开发工单 → 模型设置 里给开发模式配一个**不同的模型**（缓存池就分开了）。');
  }

  const messages = [{ role: 'system', content: buildSysPrompt(projectRoot, workDir) }];
  // ── 上下文 = **上一次请求的完整消息数组**（含 assistant/tool），只在尾部追加 ──
  // 为什么这样写（借鉴 DSH）：前缀缓存只认"严格扩展"。
  //   请求 N+1 必须是请求 N 的前缀 + 新尾部，才会命中。
  //   用 `loadHistory` 的 {role,text} 文本历史重建 messages 会**把 tool 消息全丢了**
  //   → 每一轮的前缀都在 `user_N` 处断掉，上一轮整段工具足迹白付。
  //   DSH 是同一条路走到底：整段对话作为只追加的事件流一直带着
  //   （实测它的 context 46 万 token、cacheRead 2.45 亿 / uncached 39.6 万 = 99.84%）。
  // 兼容：调用方只给老的文本历史时（首轮迁移），映射进来。
  const prior = (Array.isArray(priorMessages) && priorMessages.length)
    ? priorMessages.map(sanitizeMsg).filter(Boolean)
    : (Array.isArray(history)
      ? history.filter((m) => m?.role === 'user' || m?.role === 'assistant')
        .map((m) => ({ role: m.role, content: String(m.text || '') }))
      : []);
  for (const m of prior) messages.push(m);
  messages.push({
    role: 'user',
    content: `${userFrom ? `（来自 ${userFrom}）` : ''}${userText}`
  });

  // ── 请求前的第一道闸：先按预算裁，别等上游 400 才反应（那次调用是白花钱的）──
  {
    const fit = trimMessagesToBudget(messages, budgetNow, toolsChars);
    if (fit.trimmed) {
      messages.length = 0;
      messages.push(...fit.messages);
      log(`⚠️ 上下文超预算（${Math.round(fit.chars / 1024)}K > ${Math.round(budgetNow / 1024)}K 字符）`
        + `→ 省略较早的 ${fit.dropped} 条记录（最初的需求已写进省略提示）`);
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(30, Number(timeoutSec) || 300) * 1000);
  // 把"中止"这个动作交给调用方（界面的「中止」按钮）。没有它，跑飞的一轮只能干等
  // 最长 turnTimeoutSec（默认 1 小时），而且全局单飞会把**其它**会话一起堵住，
  // 用户看到的就是"卡死"。
  if (abortBox && typeof abortBox === 'object') {
    abortBox.abort = (reason) => {
      try { ac.abort(reason instanceof Error ? reason : new Error(String(reason || '用户中止'))); } catch { /* ignore */ }
    };
  }

  let lastText = '';
  let rounds = 0;
  let lastNoticeAt = 0;
  // 本轮用量（累计后交给调用方并进会话）。字段名与项目既有口径一致：
  //   命中率 = cachedTokens / promptTokens（见 llm.js 的 cacheHitRate / app.js 的成本看板）。
  const turnUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
  const noticeGapMs = Math.max(0, Number(noticeGapSec) || 0) * 1000;
  try {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      // ── 「正在连接 X…」：让人知道它开始思考了 ──
      // 第 0 轮必发（那才是"开始思考"的信号）；后续轮次按最小间隔节流，
      // 否则一个上百轮的任务会把群刷屏。
      if (noticeEnabled !== false) {
        const nowMs = Date.now();
        if (shouldSendNotice(round, lastNoticeAt, nowMs, noticeGapMs)) {
          lastNoticeAt = nowMs;
          const line = thinkingNoticeText(modelName);
          emit({ kind: 'notice', at: nowMs, round: rounds, text: line });
          // 提示失败绝不能影响执行（发不出去也就少一句，不该把整轮搞挂）
          if (typeof notify === 'function') { try { notify(line); } catch { /* ignore */ } }
        }
      }
      const left = maxRounds - round;
      if (left <= 1) {
        messages.push({ role: 'user', content: '【系统提醒】工具轮次快用完了，请收尾：停止调用工具，用一段话说明当前状态。' });
      }
      let imageIdx = [];
      let r = null;
      // 每一轮请求前都再过一次闸：单轮最多能加 maxRounds × 10k 字符，
      // 跑到后半程很容易把"开始时还合规"的上下文顶出窗口（见 DEV_CTX_CHAR_BUDGET 的注释）
      const midFit = trimMessagesToBudget(messages, budgetNow, toolsChars);
      if (midFit.trimmed) {
        messages.length = 0;
        messages.push(...midFit.messages);
        imageIdx = [];     // 裁过之后旧的图片下标全失效
        log(`上下文增长超预算 → 中途省略较早的 ${midFit.dropped} 条（第 ${round + 1} 轮）`);
      }
      try {
        r = await chatCompletionWithRetry({
          messages,
          tools: openAiTools,
          temperature: 0.2,
          signal: ac.signal,
          overrides,
          skillContext: { thinkingMode: 'off' },
          tag: `dev-turn:${session.id}:r${round}`
        });
      } catch (e) {
        if (e?.code === 'context_length_exceeded') {
          // 自愈：预算减半、丢掉更早的历史再试一次，不再硬失败（见 DEV_CTX_CHAR_BUDGET 的注释）
          const smaller = Math.max(DEV_CTX_RESCUE_MIN, Math.floor(budgetNow / 2));
          const fit = trimMessagesToBudget(messages, smaller, toolsChars);
          if (!fit.trimmed) throw e;      // 连"当前这一轮"都装不下 → 只能如实报错
          messages.length = 0;
          messages.push(...fit.messages);
          imageIdx = [];
          budgetNow = smaller;
          emit({ kind: 'notice', at: Date.now(), text: `上下文超出模型上限：已省略更早的 ${fit.dropped} 条记录后重试` });
          log(`⚠️ 上游报上下文超限 → 预算减半到 ${Math.round(smaller / 1024)}K 字符后重试（第 ${round + 1} 轮）`);
          r = await chatCompletionWithRetry({
            messages,
            tools: openAiTools,
            temperature: 0.2,
            signal: ac.signal,
            overrides,
            skillContext: { thinkingMode: 'off' },
            tag: `dev-turn:${session.id}:r${round}c`
          });
        } else if (imageIdx.length) {
          // 模型可能不吃图片：撤掉截图消息，降级为纯文本重试一次
          emit({ kind: 'info', at: Date.now(), text: '模型未接受截图，本轮降级为纯文本继续' });
          for (let k = imageIdx.length - 1; k >= 0; k--) messages.splice(imageIdx[k], 1);
          r = await chatCompletionWithRetry({
            messages,
            tools: openAiTools,
            temperature: 0.2,
            signal: ac.signal,
            overrides,
            skillContext: { thinkingMode: 'off' },
            tag: `dev-turn:${session.id}:r${round}b`
          });
        } else {
          throw e;
        }
      }
      // 计一次用量（这一轮**成功**那次调用的 usage；失败重试拿不到，属会计上的已知缺口）
      const u = r?.usage;
      if (u) {
        turnUsage.calls += 1;
        turnUsage.promptTokens += Number(u.prompt_tokens) || 0;
        turnUsage.completionTokens += Number(u.completion_tokens) || 0;
        turnUsage.cachedTokens += Number(u.prompt_tokens_details?.cached_tokens) || 0;
        turnUsage.totalTokens += Number(u.total_tokens) || 0;
        // 逐轮打一行缓存命中。没有它，开发模式的命中率根本没法定位
        //（查"是第几轮掉的、那一轮新增了什么大块"，见 MAX_READ_CHARS 上的注释）
        const pt = Number(u.prompt_tokens) || 0;
        const ct = Number(u.prompt_tokens_details?.cached_tokens) || 0;
        log(`  r${round} 缓存 ${ct}/${pt}${pt ? `（${Math.round(100 * ct / pt)}%）` : ''}`);
      }
      const msg = r?.message || {};
      if (typeof msg.content === 'string' && msg.content.trim()) {
        lastText = msg.content.trim();
        emit({ kind: 'assistant', round: rounds, text: lastText.slice(0, 4000) });
      }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        // 模型停下 = 本轮结束。把这条 assistant 回复也并进上下文，
        // 否则下一轮的请求里"看不到自己上一轮说了什么"（既丢连续性，也让前缀断在这里）。
        if (typeof msg.content === 'string' && msg.content) messages.push({ role: 'assistant', content: msg.content });
        break;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      let roundAdded = 0;         // 本轮已往上下文里塞了多少字符（见 MAX_ROUND_ADD_CHARS）
      for (const call of calls) {
        const name = call?.function?.name || '';
        const argsRaw = call?.function?.arguments ?? '{}';
        let argsObj = {};
        try { argsObj = JSON.parse(argsRaw) || {}; } catch { argsObj = {}; }
        const result = await executeTool(defs, {}, name, argsRaw);
        let text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
        // 每轮预算：超了就地截断并说明怎么取（工具本身的上限管不住"一轮读 3 个文件"）
        if (roundAdded + text.length > MAX_ROUND_ADD_CHARS) {
          const keep = Math.max(0, MAX_ROUND_ADD_CHARS - roundAdded);
          text = text.slice(0, keep)
            + `\n…（本轮上下文预算已用满，这里省略了 ${Math.max(0, text.length - keep)} 字符；`
            + '请改用更精确的取法：dev_read_file 的 offset/limit、或 findstr/head 收窄命令输出）';
        }
        roundAdded += text.length;
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: text });
        if (result?.plan) emit({ kind: 'plan', at: Date.now(), items: result.plan });
        if (result?.imageBase64) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '（工具返回的截图 —— 请查看渲染效果是否符合预期）' },
              { type: 'image_url', image_url: { url: result.imageBase64 } }
            ]
          });
          imageIdx.push(messages.length - 1);
        }
        emit({
          kind: 'tool',
          round: rounds,
          name,
          label: toolLabel(name, argsObj),
          ok: !result.isError,
          brief: text.replace(/\s+/g, ' ').slice(0, 200),
          full: text.slice(0, 8000)
        });
        log(`  · ${name} ${result.isError ? '（错误）' : ''}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      const why = String(ac.signal.reason?.message || ac.signal.reason || '');
      if (why.includes('用户中止')) throw new Error('已被用户中止');
      throw new Error(`超时（${timeoutSec}s）：这一轮没跑完`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (abortBox && typeof abortBox === 'object') abortBox.abort = null;   // 收干净，别留悬空句柄
    // 用量在这里统一交出去：**失败/中止也要交**。那些 token 是真花了的
    if (usageBox && typeof usageBox === 'object') Object.assign(usageBox, turnUsage);
    // 把"这一轮结束时的完整消息数组（不含 system）"交出去，下次请求直接接在它后面，
    // 这样每次请求都是上一次的严格扩展，前缀缓存才能一路命中。
    if (ctxOut && typeof ctxOut === 'object') {
      try { ctxOut.messages = messages.slice(1).map(sanitizeMsg).filter(Boolean); } catch { /* ignore */ }
    }
  }

  const hit = turnUsage.promptTokens ? Math.round(100 * turnUsage.cachedTokens / turnUsage.promptTokens) : 0;
  log(`turn 完成：${rounds} 轮 / 模型 ${modelName} / 回复 ${lastText.length} 字`
    + ` / 输入 ${turnUsage.promptTokens} 输出 ${turnUsage.completionTokens} 命中 ${turnUsage.cachedTokens}（${hit}%）`);
  return lastText;
}
