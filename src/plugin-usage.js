// 插件用量归因：把 token 花在「哪个插件、哪个功能」上算清楚，并估算对缓存命中率的影响。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 用量页原有三张表（按天 / 按会话 / 按模型）回答的是"花了多少"，
// 但用户最常问的是"是谁花的"——装了一堆插件后，光看总数根本判断不出
// 某个插件值不值、哪个功能在偷偷吃 token。本模块把三块成本拆开：
//
//   ① 固定开销（每次 LLM 调用都要付）
//      · 提示词片段：插件 prompt.sections / promptSections() 注入系统提示或
//        用户提示末尾的那些字；
//      · 工具定义：每个工具的 description + parameters JSON，随请求发给模型；
//   ② 调用开销（真的用了才付）：工具返回结果（toolCall.result）进对话后
//      每一轮都会作为历史重发，是最容易被忽视的一块；
//   ③ 缓存影响：易变片段（prompt.js 的 isVolatileSection）每轮都可能变，
//      它们要么在缓存断点之后（deferVolatile），要么直接击穿系统提示前缀——
//      两者都意味着这部分 token **每轮按全价重算**。
//
// ── 口径与已知边界 ────────────────────────────────────────────────────────
//   · token 是**估算值**（字符数 / 2.5），与 llm.js 的 LCP 日志同口径。
//     中文为主的提示词下误差不大，但别拿它对账账单——精确值看用量页的
//     usage（provider 返回的真实 token）。
//   · 调用统计来自 data/sessions/*.json 里每条 message.toolCall{name,result}。
//     会话文件会被裁剪（store.keepSessionFiles），所以"全部"范围也只覆盖
//     磁盘上还在的会话；这是已知且可接受的边界（账本只存总量，没有工具维度）。
//   · 「影响命中率」是**归因估算**：易变片段 token / 单次调用平均输入。
//     真实命中率由 provider 的 cached_tokens 决定，两者不必然相加等于 100%。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { skillManager } from './skills/manager.js';
import { buildToolDefs } from './tools.js';
import { getToolAvailability, listTools } from './tool-registry.js';
import { isVolatileSection } from './prompt.js';

/** 与 llm.js 的 LCP 日志同口径：中文为主的提示词，2.5 字符 ≈ 1 token。 */
export const CHARS_PER_TOKEN = 2.5;

/** 字符数 → 估算 token。 */
export function estimateTokens(chars) {
  return Math.max(0, Math.round(Number(chars || 0) / CHARS_PER_TOKEN));
}

/** 工具 id 归属：宿主给插件工具加的前缀就是 skillId（`sticker__send_sticker`）。 */
export function skillIdOfTool(toolId) {
  const s = String(toolId || '');
  const i = s.indexOf('__');
  return i > 0 ? s.slice(0, i) : '';
}

/** 把统计窗口的 range 参数翻成起始时间戳（0 = 全部）。 */
export function resolveSince(range, now = Date.now()) {
  const key = String(range || '7').trim().toLowerCase();
  if (key === 'all') return 0;
  if (key === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (key === '24h') return now - 24 * 3600 * 1000;
  const n = Math.max(1, Number(key) || 7);
  return now - n * 24 * 3600 * 1000;
}

/**
 * 扫会话文件，聚合工具维度的调用/返回内容。
 *
 * @returns {{ tools: Map<string,{calls:number,resultChars:number,errors:number}>, sessions:number, calls:number, promptTokens:number, cachedTokens:number }}
 */
export function collectToolUsage({ since = 0, maxFiles = 5000 } = {}) {
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const tools = new Map();
  let sessions = 0, calls = 0, llmCalls = 0, promptTokens = 0, cachedTokens = 0, newTextChars = 0;

  for (const f of files.slice(0, maxFiles)) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const started = Number(s.startedAt) || 0;
    const ended = Number(s.endedAt) || started;
    // 窗口过滤用结束时间（跨零点会话算在结束那天，与账本同口径）
    if (since && ended < since) continue;
    sessions++;
    llmCalls += Number(s.usage?.calls) || 0;
    promptTokens += Number(s.usage?.promptTokens) || 0;
    cachedTokens += Number(s.usage?.cachedTokens) || 0;
    // 本轮「新进来的那几句话」——群友发的新消息（triggerText）。
    // 注意：它只是每轮输入里最小的一块（几十字符），真正吃 token 的是它进入
    // 对话历史后被一轮轮重发。两者分开统计，页面才不会让人误判"少说话就省钱"。
    newTextChars += String(s.triggerText || '').length;
    for (const m of (s.messages || [])) {
      const tc = m && m.toolCall;
      if (!tc || !tc.name) continue;
      calls++;
      const key = String(tc.name);
      const g = tools.get(key) || { calls: 0, resultChars: 0, errors: 0 };
      g.calls++;
      const result = tc.result;
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
      g.resultChars += String(text || '').length;
      // errors 两种来源：工具本身报错（isError），以及"部分成功"（failed>0）。
      // 后者以前不计 —— 发送被 QQ 拒（result=241）时控制台仍显示 0 错误（体检 F8）。
      if (tc.isError || Number(tc.failed) > 0) g.errors++;
      tools.set(key, g);
    }
  }
  return { tools, sessions, calls, llmCalls, promptTokens, cachedTokens, newTextChars };
}

/**
 * 算当前生效插件的固定开销（提示词片段 + 工具定义）。
 *
 * @param {object} context skillRuntimeContext()（必须与运行时同口径）
 */
export function computeFootprints(context = {}) {
  const bySkill = new Map();
  const ensure = (id) => {
    const key = String(id || '(core)');
    if (!bySkill.has(key)) bySkill.set(key, { stableChars: 0, volatileChars: 0, sections: 0, volatileSections: 0 });
    return bySkill.get(key);
  };

  // ① 提示词片段（只统计**当前生效**的模块 —— skillManager 已按 enabled/可用性过滤）
  let sections = [];
  try { sections = skillManager.getPromptSections(context) || []; } catch { sections = []; }
  for (const s of sections) {
    const g = ensure(s?.skillId || '(core)');
    const chars = String(s?.title || '').length + String(s?.content || '').length;
    if (isVolatileSection(s)) { g.volatileChars += chars; g.volatileSections++; }
    else g.stableChars += chars;
    g.sections++;
  }

  // ② 工具定义（description + parameters 的 JSON 是随请求发出去的真实体积）
  // ⚠️ 必须按 getToolAvailability 过滤（2026-10-19 修）：buildToolDefs() 返回的是
  //    **全部已注册工具**，包括已关闭插件/被单工具开关关掉的。这些工具**不会**发给
  //    模型，算进"固定开销"会让"已关"的插件仍显示 354 tok/次 —— 数字和状态自相矛盾。
  //    可用性判定必须与运行时同一口径（同一个函数、同一份 context）。
  let defs = [];
  try { defs = buildToolDefs() || []; } catch { defs = []; }
  const defChars = new Map();
  for (const d of defs) {
    const id = String(d?.id || d?.name || '');
    if (!id) continue;
    let av = null;
    try { av = getToolAvailability(id, context); } catch { av = null; }
    if (av && av.enabled === false) continue;
    let chars = String(d?.description || '').length;
    try { chars += JSON.stringify(d?.parameters || {}).length; } catch { /* 参数循环引用：忽略 */ }
    chars += id.length + String(d?.name || '').length;
    defChars.set(id, chars);
    // 工具归属：优先前缀（插件工具），没有前缀的算核心工具
    const owner = skillIdOfTool(id);
    const g = ensure(owner || '(core)');
    g.toolDefChars = (g.toolDefChars || 0) + chars;
    g.toolCount = (g.toolCount || 0) + 1;
  }
  return { bySkill, defChars };
}

/**
 * 生成「按插件」统计。
 *
 * @param {{range?:string, context?:object}} opts
 */
export function buildPluginUsage({ range = '7', context = {} } = {}) {
  const now = Date.now();
  const since = resolveSince(range, now);
  const usage = collectToolUsage({ since });
  const { bySkill } = computeFootprints(context);

  // 插件元信息（名称/版本/开关）——只列已注册的；(`(core)` 单独一行)
  const skills = (() => { try { return skillManager.list(context) || []; } catch { return []; } })();
  const meta = new Map(skills.map((s) => [s.id, s]));

  // 工具维度：按前缀归到插件
  // 中文显示名（如「收藏表情」）从注册表补上 —— 明细弹窗里给普通人看的是这个名字，
  // 工具 id（sticker__collect_sticker）只作为副标题。
  const toolNameOf = new Map();
  try { for (const t of listTools()) toolNameOf.set(String(t.id), String(t.name || '')); } catch { /* 忽略 */ }
  const toolsBySkill = new Map();
  let totalToolCalls = 0, totalResultChars = 0;
  for (const [name, u] of usage.tools) {
    const owner = skillIdOfTool(name) || '(core)';
    if (!toolsBySkill.has(owner)) toolsBySkill.set(owner, []);
    toolsBySkill.get(owner).push({
      id: name,
      name: toolNameOf.get(name) || '',
      calls: u.calls,
      resultTokens: estimateTokens(u.resultChars),
      errors: u.errors
    });
    totalToolCalls += u.calls;
    totalResultChars += u.resultChars;
  }
  for (const list of toolsBySkill.values()) list.sort((a, b) => b.resultTokens - a.resultTokens || b.calls - a.calls);

  const llmCalls = usage.llmCalls;       // LLM 调用次数（会话 usage.calls 之和）
  const avgInputPerCall = llmCalls > 0 ? Math.round(usage.promptTokens / llmCalls) : 0;

  const plugins = [];
  for (const [id, fp] of bySkill) {
    const m = meta.get(id) || null;
    const promptStable = estimateTokens(fp.stableChars);
    const promptVolatile = estimateTokens(fp.volatileChars);
    const toolDefTokens = estimateTokens(fp.toolDefChars || 0);
    const fixedPerCall = promptStable + promptVolatile + toolDefTokens;
    const periodFixed = fixedPerCall * llmCalls;      // 区间内"光这段固定内容"的 token 量
    const tools = toolsBySkill.get(id) || [];
    const resultTokens = tools.reduce((a, t) => a + t.resultTokens, 0);
    plugins.push({
      id,
      name: m?.name || (id === '(core)' ? '核心（非插件）' : id),
      version: m?.version || '',
      enabled: m?.enabled !== false,
      active: m ? m.active !== false : id === '(core)',
      promptStable,
      promptVolatile,
      promptTotal: promptStable + promptVolatile,
      sections: fp.sections,
      volatileSections: fp.volatileSections,
      toolDefTokens,
      toolCount: fp.toolCount || 0,
      fixedPerCall,
      periodFixed,
      // 区间总消耗 = 固定部分（每次都有）× 调用次数 + 工具结果。
      // 这是"这个插件这段时间实际花掉多少"的估算：只排固定开销会漏掉"用得越频繁越贵"
      // 与"工具返回内容"，用户反馈要的就是这半边。
      periodTotal: periodFixed + resultTokens,
      toolCalls: tools.reduce((a, t) => a + t.calls, 0),
      resultTokens,
      errors: tools.reduce((a, t) => a + t.errors, 0),
      // 命中率影响：易变部分每轮全价重算，占单次平均输入的比例
      hitImpactPct: avgInputPerCall > 0 ? Math.round((promptVolatile / avgInputPerCall) * 1000) / 10 : 0,
      tools
    });
  }
  plugins.sort((a, b) => b.fixedPerCall - a.fixedPerCall || b.toolCalls - a.toolCalls);

  const sum = (k) => plugins.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const fixedAll = sum('fixedPerCall');            // 全部固定开销（插件 + 核心工具），每次调用都要付
  return {
    range: String(range),
    days: range === 'all' ? 'all' : range,
    generatedAt: now,
    window: { from: since || null, to: now, sessions: usage.sessions },
    totals: {
      llmCalls,
      promptTokens: usage.promptTokens,
      cachedTokens: usage.cachedTokens,
      hitRate: usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 1000) / 10 : 0,
      avgInputPerCall,
      toolCalls: totalToolCalls,
      resultTokens: estimateTokens(totalResultChars)
    },
    summary: {
      fixedPerCall: fixedAll,
      // 只算插件（排除核心工具）—— 卡片上的「插件固定开销」用这个口径，
      // 否则把 23 个核心工具的体积算成"插件开销"，数字会吓人且不准。
      pluginFixedPerCall: plugins.filter((p) => p.id !== '(core)').reduce((a, p) => a + p.fixedPerCall, 0),
      coreFixedPerCall: plugins.filter((p) => p.id === '(core)').reduce((a, p) => a + p.fixedPerCall, 0),
      volatilePerCall: sum('promptVolatile'),
      periodFixed: sum('periodFixed'),
      periodTotal: sum('periodTotal'),
      // 只算插件（排除核心工具）的区间口径 —— 摘要行用的是这组，
      // 否则"插件固定消耗"不含核心、而"区间总消耗"含核心，两个数对不上。
      pluginPeriodFixed: plugins.filter((p) => p.id !== '(core)').reduce((a, p) => a + p.periodFixed, 0),
      pluginResultTokens: plugins.filter((p) => p.id !== '(core)').reduce((a, p) => a + p.resultTokens, 0),
      pluginPeriodTotal: plugins.filter((p) => p.id !== '(core)').reduce((a, p) => a + p.periodTotal, 0),
      pluginCalls: sum('toolCalls'),
      resultTokens: sum('resultTokens'),
      pluginCount: plugins.filter((p) => p.id !== '(core)' && p.fixedPerCall > 0).length,

      // ── 对话侧的输入（2026-10-19 用户明确要求补上）─────────────────────────
      // 口径：每次输入的真实 token（provider 返回的 promptTokens 平均值）减去已归因的
      // 固定开销（插件说明 + 工具说明），剩下的就是**聊天记录、人设、运行时状态**这些
      // "对话本身"的东西。是倒推值，但总量用的是最真实的那个数，所以不会低估。
      // 单独拎出来的意义：让「插件占 22%」这句话有个参照——剩下 65% 是聊天内容，
      // 而且里面绝大部分是**之前聊过的内容在被一轮轮重发**，不是本轮新说的那几句。
      chatPerCall: Math.max(0, avgInputPerCall - fixedAll),
      chatPeriod: Math.max(0, usage.promptTokens - fixedAll * llmCalls),
      chatSharePct: avgInputPerCall > 0
        ? Math.round(Math.max(0, avgInputPerCall - fixedAll) / avgInputPerCall * 100)
        : 0,
      // 本轮新进来的消息（triggerText）：平均几十字符，与"历史重发"是两回事，
      // 分开列出来，免得用户以为"少说两句就能省一大截"。
      newTextPerCall: llmCalls > 0 ? Math.round(estimateTokens(usage.newTextChars) / llmCalls) : 0,
      newTextPeriod: estimateTokens(usage.newTextChars)
    },
    plugins
  };
}
