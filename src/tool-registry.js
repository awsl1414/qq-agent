// 工具注册表：每个工具是一个可插拔的模块。
// 新增工具只需调用 registerTool()，无需改其他代码。
//
// 工具定义字段：
//   id: 唯一标识（如 'send_message'）
//   name: 显示名（如 '发送消息'）
//   description: 功能描述（给模型看的提示词）
//   category: 分类（messaging/sticker/query/memory/web/system）
//   icon: 图标（emoji）
//   defaultEnabled: 默认是否启用
//   requiresVision: 是否需要视觉模型（true 时模型不支持图片则自动禁用）
//   requiresSearch: 是否需要搜索服务（true 时搜索关闭则自动禁用）
//   parameters: OpenAI function 参数 schema
//   execute: 执行函数 (ctx, args) => { content, isError }
//
// ── Skill 化之后的职责划分 ────────────────────────────────────────────────
//   registry（本文件）：存定义 + 算可用性 + 提供查询
//   skills/manager.js ：提供"开关的唯一来源"和"能力依赖"
//   调用方（orchestrator/routes）：只问 getToolAvailability()，不再自己拼条件
//
// 为什么可用性判断必须集中在这里：以前 orchestrator 里散落着
// "全局开关 + 分类开关 + 单工具开关 + vision + search" 五层条件，
// 加了 Skill 开关后如果再散落一处，就会变成六层条件、两个地方各判一半，
// 必然出现"UI 说能用、运行时空工具列表"的割裂。现在只有这一处口径。

import { SKILL_ERROR, skillErrorText } from './skills/errors.js';
// 默认用全局 SkillManager 单例：见下面 getToolAvailability 里的说明。
// 无循环依赖 —— manager.js 只 import registry/capabilities/config/errors，不碰本文件。
import { skillManager as defaultSkillManager } from './skills/manager.js';

const registry = new Map();

/** 注册一个工具。重复注册同 id 会覆盖（后注册的生效）。 */
export function registerTool(def) {
  if (!def?.id) throw new Error('工具必须提供 id');
  if (!def?.name) throw new Error(`工具 ${def.id} 必须提供 name`);
  if (typeof def?.execute !== 'function') throw new Error(`工具 ${def.id} 必须提供 execute 函数`);
  // id 会成为发给模型的 OpenAI function name：字符集 [a-zA-Z0-9_-]、最长 64。
  // 违规 id 会触发严格端点 400，连带整个请求失败——入口直接拒绝，比事后调试便宜。
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(def.id))) {
    throw new Error(`工具 id 不符合 OpenAI 函数名规范 [a-zA-Z0-9_-]{1,64}：${def.id}`);
  }
  registry.set(def.id, Object.freeze({
    category: 'system',
    icon: '🔧',
    defaultEnabled: true,
    requiresVision: false,
    requiresSearch: false,
    // skillId：该工具属于哪个 Skill（内置工具为 null）。
    // 用途：Skill 被禁用时，它注册的工具自动不可用；卸载时按 skillId 批量清理。
    skillId: null,
    // requires：需要的能力名（如 'knowledge.search'）。
    // 与 skillId 的区别：skillId 是"谁注册的"，requires 是"运行时必须有什么能力"。
    requires: [],
    ...def
  }));
}

/** 注销单个工具。 */
export function unregisterTool(id) {
  return registry.delete(String(id));
}

/** 按 Skill 批量注销（Skill 卸载 / 热重载时用）。返回被删除的 id 列表。 */
export function unregisterToolsBySkill(skillId) {
  const ids = [];
  for (const [id, def] of registry) {
    if (def.skillId && def.skillId === skillId) {
      registry.delete(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 获取所有已注册工具（按注册顺序）。 */
export function listTools() {
  return [...registry.values()];
}

/** 按 id 获取工具定义。 */
export function getTool(id) {
  return registry.get(id) ?? null;
}

/** 按分类获取工具列表。 */
export function listToolsByCategory(category) {
  return listTools().filter((t) => t.category === category);
}

/** 获取所有分类（去重）。 */
export function listCategories() {
  const cats = new Set(listTools().map((t) => t.category));
  return [...cats];
}

/** 清空注册表（测试用）。 */
export function clearRegistry() {
  registry.clear();
}

// ── 可用性：唯一口径 ───────────────────────────────────────────────────────

/**
 * 计算某个工具当前是否可用，并给出**机器可读的原因**。
 *
 * 判断顺序（上游不通过就不再看下游，保证 reason 指向真正的原因）：
 *   1. tools.enabled 全局开关
 *   2. 所属 Skill 是否生效（loaded + enabled + available）
 *   3. requires 声明的能力是否可用
 *   4. 分类开关
 *   5. 单工具 overrides
 *   6. requiresVision / requiresSearch 等运行期依赖
 *   7. Skill 提供的 tool.guard 附加否决（可选）
 *
 * @param {string} toolId
 * @param {object} context {
 *   skills,          SkillManager 实例（可选；没有则跳过 Skill 判断）
 *   toolsCfg,        config.tools
 *   visionEnabled,   boolean
 *   searchEnabled,   boolean
 *   runtimeContext,  传给 Skill available/guard 的上下文
 * }
 * @returns {{id: string, enabled: boolean, code: string|null, reason: string, skillId: string|null}}
 */
export function getToolAvailability(toolId, context = {}) {
  const def = registry.get(String(toolId));
  if (!def) {
    return { id: String(toolId), enabled: false, code: SKILL_ERROR.NOT_FOUND, reason: '工具未注册', skillId: null };
  }
  const {
    // skills 缺省时回落到全局单例，**而不是跳过技能检查**。
    //
    // 这是一个真实存在的坑：原来写成 skills = null，而下面的技能判定是
    // `if (def.skillId && skills)` —— 也就是说"调用方忘了传 skills"会让整段
    // 技能开关检查**静默失效**，所有属于技能的工具都被报成可用。
    // 少传一个参数就关掉一道安全检查，这种默认值方向是反的。
    // 现在默认取单例（生产行为的正确来源），需要注入的测试仍然可以显式传。
    skills = defaultSkillManager,
    toolsCfg = {},
    visionEnabled = true,
    searchEnabled = true,
    runtimeContext = {}
  } = context;

  const deny = (code, reason) => ({ id: def.id, enabled: false, code, reason, skillId: def.skillId ?? null });

  // 1) 全局开关
  if (toolsCfg.enabled === false) {
    return deny('tools-disabled', '工具总开关已关闭');
  }

  // 2) 所属 Skill 是否生效
  if (def.skillId && skills) {
    const st = skills.isActive(def.skillId, runtimeContext);
    if (!st.active) {
      return deny(st.code || SKILL_ERROR.DISABLED, `${skillLabel(skills, def.skillId)}：${st.reason}`);
    }
  }

  // 3) 声明的能力
  const requires = Array.isArray(def.requires) ? def.requires : [];
  if (requires.length && skills) {
    for (const cap of requires) {
      const ex = skills.explainCapability(cap, runtimeContext);
      if (!ex.available) {
        return deny(SKILL_ERROR.CAPABILITY_MISSING, `缺少能力 ${cap}：${ex.reason}`);
      }
    }
  }

  // 4) 分类开关
  if (toolsCfg.categories?.[def.category] === false) {
    return deny('category-disabled', `分类「${def.category}」已关闭`);
  }

  // 5) 单工具开关
  const override = toolsCfg.overrides?.[def.id];
  const enabled = override === undefined ? (def.defaultEnabled !== false) : override !== false;
  if (!enabled) {
    return deny('tool-disabled', '该工具已被单独关闭');
  }

  // 5.5) 跨会话发送：send_to 是社交敏感工具，受独立开关管辖（默认关）。
  // 在可用性层拦（而不是只靠描述提示）—— 关闭时模型连工具都看不见。
  if (def.id === 'send_to' && toolsCfg.crossChatSend !== true) {
    return deny('tool-disabled', '跨会话发送未开启（设置 → 工具与技能）');
  }

  // 6) 运行期依赖
  if (def.requiresVision && !visionEnabled) {
    return deny('no-vision', '当前模型不支持图片输入');
  }
  if (def.requiresSearch && !searchEnabled) {
    return deny('no-search', '联网搜索已关闭');
  }

  // 7) Skill 附加否决（tool.guard）
  if (skills) {
    for (const { fn, skillId } of skills.getToolGuards(runtimeContext)) {
      try {
        const r = fn({ toolId: def.id, tool: def, context: runtimeContext });
        if (r === false) return deny('skill-guard', `${skillLabel(skills, skillId)}：运行时否决`);
        if (r && typeof r === 'object' && r.ok === false) {
          return deny('skill-guard', String(r.reason || `${skillLabel(skills, skillId)}：运行时否决`));
        }
      } catch { /* guard 异常不阻断工具，只在别处记日志 */ }
    }
  }

  return { id: def.id, enabled: true, code: null, reason: '', skillId: def.skillId ?? null };
}

/** 列出当前可用的工具定义。 */
export function listAvailableTools(context = {}) {
  return listTools().filter((t) => getToolAvailability(t.id, context).enabled);
}

/** 批量可用性（UI 一次拿全，避免 N 次 IPC/HTTP）。 */
export function availabilityOf(context = {}) {
  return listTools().map((t) => getToolAvailability(t.id, context));
}

function skillLabel(skills, skillId) {
  const st = skills?.status?.(skillId);
  return st?.name || skillId;
}

/** 兼容旧调用：给一个只有 toolsCfg 的调用方算"传统可用性"（不含 Skill 层）。 */
export function isToolEnabledLegacy(def, toolsCfg = {}) {
  return getToolAvailability(def?.id, { toolsCfg }).enabled;
}

// ── 工具集粘滞窗（2026-10-19）──────────────────────────────────────────────
//
// ── 为什么需要它（全部来自 2026-10-18 的实测日志）──────────────────────────
// tools 段在请求体里排在 messages 之前，**工具集合每变一次，从那一刻起整个
// 前缀缓存全部作废重算**（15~20k tok 全价）。而实测一天里工具集合抖了 7 次
// （37→47→50→44→40→38→35）：13:07 一瞬间冒出 10 个 meme/music 工具，
// 13:33 起又分三批全撤 —— 插件装得越多，重扫/信任/开关状态的碰撞概率越高，
// 群友反馈"装多了插件命中率暴跌"的第一主因就是它。
//
// ── 做法：变化不立即生效，等窗口平静 ──────────────────────────────────────
// 每次构造请求前把「期望的 enabled 集合」交给本函数：
//   · 与生效集相同 → 原样放行（绝大多数请求走这条路，零开销）
//   · 不同 → 不立即生效，先记为候选；候选**连续稳定 90 秒**才真正生效，
//     期间沿用上一次生效的集合 —— 热装卸风暴被折叠成一次变化。
//   · 抖动保护：候选每变一次（又想改成别的）计一次 flip，flip 满 3 次
//     说明集合在持续抖动，放弃粘滞按最新走 —— 宁可多付缓存，不可卡死变化。
//   · 安全例外（两条都不粘滞，立即生效）：
//       ① 期望集为空 —— 全局关工具/全部不可用，必须马上生效；
//       ② 期望集比生效集缩小过半 —— 大面积消失多半是注册表异常，立即跟随。
//
// ⚠️ 位置约定：只给 orchestrator 的请求构造用。UI（设置页/排障面板）必须
//    继续直接问 getToolAvailability() 显示**真实**状态 —— 粘滞窗是"发送层"
//    的缓冲，不能反过来污染"状态层"，否则用户关了开关界面却显示还开着。
const TOOLSET_STICKY_MS = 90000;   // 候选需稳定多久才生效
const TOOLSET_MAX_FLIPS = 3;       // 候选被重置几次后放弃粘滞、立即生效
const TOOLSET_SCOPES_MAX = 32;     // 会话桶上限（LRU，超出淘汰最久未用的）

// ── 批量加载静默期（2026-10-23）───────────────────────────────────────────
//
// ── 为什么需要它（"新加插件之后缓存爆炸"的真实成因）─────────────────────
// 上面那个 90 秒粘滞窗只解决"单点漂移"，解决不了"一次重扫期间的连续增长"：
// plugin-loader.js 的 loadSkillRoot 是**串行**加载的（源码注释：并行 import 时
// 两个 Skill 抢同一 id 顺序不确定），而每个插件的 setup() 在 import 期间就把
// 自己的工具注册进表。于是 N 个带工具的插件会产生 **N 次工具集增长**：
//
//     35 → 38 → 41 → 44 → …
//
// 只要这期间群里有消息进来（活跃群聊几秒一条），每一级增长都会被某个请求
// 看见，就是一次 17k 全价重算。装 5 个插件 = 最多 5 次击穿。
// 用户说的"加插件后缓存爆炸"就是这个，**不是"插件让前缀变大"**。
//
// 更糟的是 epoch 通道会绕过粘滞窗：安装流程里 setSkillEnabled / trustedPlugins
// 每次都 updateConfig → configVersion++ → 各桶立即重建基线。设计本意是
// "用户主动操作不该被缓冲 90 秒"，但一次安装包含多次配置写入，于是这条
// "立即生效"的通道反而变成了"每次都立即断"。
//
// ── 做法：把整个重扫包进 batch，结束时一次性生效 ─────────────────────────
//   · batch 期间：stabilizeToolset 一律沿用旧集合（没有基线时才建基线，
//     否则 boot 阶段会拿到空集合）；
//   · endToolsetBatch()：把**所有**会话桶标脏，让下一次请求立即按最终集合
//     重建基线 —— 不粘滞、不等 90 秒，所以"装完就能用"的体验不变，
//     延迟上限只是"一次重扫的耗时"（通常几百毫秒）。
//   · 结果：N 次增长折叠成 1 次，装 5 个插件从 5 次击穿降到 1 次。
//
// ⚠️ 兜底：万一某个插件 setup() 挂死（第三方插件用未 catch 的 promise 卡住
//    import），batch 会一直开着 → 工具集永久冻结。因此记时间戳，超过
//    TOOLSET_BATCH_MAX_MS 自动视为过期放行，宁可多断一次也不能卡死功能。
const TOOLSET_BATCH_MAX_MS = 30000;
let toolsetBatchDepth = 0;
let toolsetBatchSince = 0;
// 本批次内被吸收的"真实差异"次数 —— 直接对应"原本会击穿几次缓存"。
// 只在 sig 与生效集**确实不同**时 +1，绝不把"没变化"算进来（否则日志虚高）。
let toolsetBatchSuppressed = 0;

function toolsetBatchActive(now = Date.now()) {
  if (toolsetBatchDepth <= 0) return false;
  if (now - toolsetBatchSince > TOOLSET_BATCH_MAX_MS) {
    // 超时兜底：当作批次已废，放行后续变化（并在下次 begin 时重建时间戳）
    toolsetBatchDepth = 0;
    toolsetBatchSince = 0;
    return false;
  }
  return true;
}

/**
 * 进入工具集批量加载静默期。与 endToolsetBatch 配对，支持嵌套（计数）。
 * 调用方：app.js 的 reloadSkills（整个重扫流程）。
 */
export function beginToolsetBatch() {
  if (toolsetBatchDepth <= 0) {
    toolsetBatchSince = Date.now();
    toolsetBatchSuppressed = 0;
  }
  toolsetBatchDepth += 1;
}

/**
 * 退出静默期。计数归零时把全部会话桶标脏 —— 下一次请求立即按最新集合
 * 重建基线（等价于 epoch 变化的"立即生效"，但只发生这一次）。
 */
export function endToolsetBatch() {
  if (toolsetBatchDepth > 0) toolsetBatchDepth -= 1;
  if (toolsetBatchDepth > 0) return null;   // 还有外层批次
  toolsetBatchSince = 0;
  const absorbed = toolsetBatchSuppressed;
  toolsetBatchSuppressed = 0;
  let touched = 0;
  for (const st of toolsetStickyScopes.values()) {
    // ⚠️ 保留 effectiveSig（它是"击穿前的旧前缀"），只把世代号标脏：
    //    下一次请求会走 epoch 分支重建基线，并**如实报告一次 transition**。
    //    若这里直接把 effectiveSig 清成 ''，旧基线就丢了 —— 日志上看起来
    //    像"首次建基线"，装插件造成的击穿又变成隐形的了。
    st.epoch = -1;   // 不等于任何真实世代（自 0 起），强制触发重建
    st.candidateSig = null;
    st.candidateIds = null;
    st.candidateSince = 0;
    st.flips = 0;
    touched += 1;
  }
  // absorbed = 本轮扫描期间被折叠掉的中间变化次数（= 原本会击穿缓存的次数）
  return { absorbed, scopes: touched };
}

/** 仅供诊断：当前是否处于批量静默期 + 已持续多久。 */
export function peekToolsetBatch() {
  return {
    active: toolsetBatchActive(),
    depth: toolsetBatchDepth,
    elapsedMs: toolsetBatchSince ? Date.now() - toolsetBatchSince : 0
  };
}

// ⚠️ 状态必须**按会话分桶**，不能用全局单例：
//    getToolAvailability 的 runtimeContext 是 per-chat 的（开发模式会话比普通
//    会话多一批 dev 工具、人设不同 guard 也不同），工具集合天然按会话有差异。
//    若用全局一份状态，A 会话的集合会经粘滞窗强加给 B 会话 —— dev 工具跑进
//    普通会话是权限泄漏，普通会话拿不到自己的工具是功能故障。
const toolsetStickyScopes = new Map();   // scope -> { effectiveIds, effectiveSig, candidateSig, candidateIds, candidateSince, flips, epoch }

function stickyStateFor(scope) {
  let st = toolsetStickyScopes.get(scope);
  if (!st) {
    st = { effectiveIds: null, effectiveSig: '', candidateSig: null, candidateIds: null, candidateSince: 0, flips: 0, epoch: -1 };
    toolsetStickyScopes.set(scope, st);
    // LRU：Map 迭代序即插入序，重插一次就是"刚使用"；超限删最旧
    if (toolsetStickyScopes.size > TOOLSET_SCOPES_MAX) {
      const oldest = toolsetStickyScopes.keys().next().value;
      toolsetStickyScopes.delete(oldest);
    }
  } else {
    // 刚使用，挪到迭代序末尾（LRU touch）
    toolsetStickyScopes.delete(scope);
    toolsetStickyScopes.set(scope, st);
  }
  return st;
}

/**
 * 对「本轮期望发送的工具集合」应用粘滞窗。
 * @param {string[]} desiredIds 本轮可用性判定通过的 id（顺序不敏感）
 * @param {{scope?:string, now?:number, epoch?:number}} [opt]
 *   epoch = 配置世代号（config.js 的 getConfigVersion()）。世代变了说明发生了
 *   用户主动的配置写入（开/关插件、安装、信任）—— 本桶状态立即作废、按新集合
 *   重建基线，**不粘滞**；没传或不变则走粘滞（吸收 fs.watch 重扫一类的自动抖动）。
 * @returns {{
 *   ids: string[],        // 实际应发送的 id（排序后）
 *   suppressed: boolean,  // true = 本轮期望集被窗口吸收，沿用了旧集
 *   transition: {from:string,to:string,waitedMs:number,flips:number}|null
 * }}
 */
export function stabilizeToolset(desiredIds, { scope = 'global', now = Date.now(), epoch = 0 } = {}) {
  const desired = [...(desiredIds || [])].sort();
  const sig = desired.join(',');
  const st = stickyStateFor(String(scope || 'global'));

  // 批量加载静默期：重扫期间的一切中间态都不生效，沿用上一次生效的集合。
  // ⚠️ 判断必须在 epoch 检查**之前** —— 一次插件安装包含多次 updateConfig
  //    （setSkillEnabled、trustedPlugins…），每次都会让世代号 +1；若先走 epoch
  //    分支，这多次写入就会各自立即断一次缓存，正是本机制要消灭的场景。
  if (toolsetBatchActive(now)) {
    if (!st.effectiveSig) {
      // 还没有基线（boot 首扫）：必须建，否则整轮请求一个工具都没有
      st.effectiveSig = sig;
      st.effectiveIds = desired;
      st.epoch = epoch;
      return { ids: desired, suppressed: false, transition: null, batching: true };
    }
    if (desired.length === 0) {
      // 安全例外：全部工具都不可用时仍要立即跟随（哪怕正在重扫），
      // 否则模型会对着已卸载的工具反复调用。
      const from = st.effectiveSig;
      st.effectiveSig = sig;
      st.effectiveIds = desired;
      st.epoch = epoch;
      st.candidateSig = null;
      st.candidateIds = null;
      st.candidateSince = 0;
      st.flips = 0;
      return { ids: desired, suppressed: false, transition: { from, to: sig, waitedMs: 0, flips: 0 }, batching: true };
    }
    if (sig === st.effectiveSig) {
      // 与生效集一致：这次请求没有观察到任何变化，正常放行。
      // ⚠️ 必须单独处理：否则扫描期间每条群消息都会命中下面的 suppressed
      //    分支、打一条"暂不生效"日志，日志会被刷爆且数字全是假的。
      return { ids: st.effectiveIds, suppressed: false, transition: null, batching: true };
    }
    // 其余一律沿用旧集合：本轮的"期望集"是一次扫描中间态，不代表最终结果。
    // 同一级中间态被多个请求重复看到时只计一次（按 candidateSig 判重）——
    // 否则群聊一活跃，absorbed 会虚高成"消息条数"而不是"真实变化次数"。
    if (sig !== st.candidateSig) {
      st.candidateSig = sig;
      toolsetBatchSuppressed += 1;   // 记一笔：这一次差异原本会击穿一次缓存
    }
    return { ids: st.effectiveIds, suppressed: true, transition: null, batching: true };
  }

  // 配置世代变化（用户开/关插件、市场安装/信任等 updateConfig 路径）→ 本桶
  // 立即按新集合重建基线。用户意图明确的操作不该被缓存保活缓冲 90 秒 ——
  // 那会把"刚启用的插件"变成"装了却调不到"的新故障形态。
  //
  // ⚠️ 重建时必须记住"旧基线"，否则这次变化在 tools-sticky 日志里是隐形的
  //    （见下方 transition 注释）—— 装插件击穿缓存却没有一条归因日志，
  //    正是"反馈爆炸但排不出原因"的一半根源。
  let epochResetFrom = null;
  if (st.epoch !== epoch) {
    epochResetFrom = st.effectiveSig || null;
    st.effectiveIds = null;
    st.effectiveSig = '';
    st.candidateSig = null;
    st.candidateIds = null;
    st.candidateSince = 0;
    st.flips = 0;
    st.epoch = epoch;
  }

  // 首次：直接生效，建立基线
  if (!st.effectiveSig) {
    st.effectiveSig = sig;
    st.effectiveIds = desired;
    // 世代变化把基线清空后重建：如果旧基线确实与新集合不同，这就是**一次真实
    // 的前缀击穿**，必须带 transition 返回 —— 否则 orchestrator 不打 tools-sticky，
    // 排障时只看到命中率掉了、却找不到"是谁在什么时候换的工具集"。
    const transition = (epochResetFrom && epochResetFrom !== sig)
      ? { from: epochResetFrom, to: sig, waitedMs: 0, flips: 0 }
      : null;
    return { ids: desired, suppressed: false, transition };
  }

  // 与生效集一致：清掉挂着的候选（说明抖动结束了），原样放行
  if (sig === st.effectiveSig) {
    st.candidateSig = null;
    st.candidateIds = null;
    st.flips = 0;
    return { ids: st.effectiveIds, suppressed: false, transition: null };
  }

  const empty = desired.length === 0;
  const halved = desired.length * 2 <= st.effectiveIds.length;
  if (empty || halved) {
    // 安全例外：立即生效
    const from = st.effectiveSig;
    st.effectiveSig = sig;
    st.effectiveIds = desired;
    st.candidateSig = null;
    st.flips = 0;
    return { ids: desired, suppressed: false, transition: { from, to: sig, waitedMs: 0, flips: 0 } };
  }

  const stableFor = now - st.candidateSince;
  if (st.candidateSig === sig && stableFor >= TOOLSET_STICKY_MS) {
    // 候选已稳定满窗口：生效
    const from = st.effectiveSig;
    st.effectiveSig = sig;
    st.effectiveIds = desired;
    st.candidateSig = null;
    st.candidateIds = null;
    st.flips = 0;
    return { ids: desired, suppressed: false, transition: { from, to: sig, waitedMs: stableFor, flips: 0 } };
  }

  if (st.candidateSig !== sig) {
    // 候选又变了（或在生效后第一次出现差异）：重记候选
    st.candidateSig = sig;
    st.candidateIds = desired;
    st.candidateSince = now;
    st.flips += 1;
    if (st.flips >= TOOLSET_MAX_FLIPS) {
      // 持续抖动：放弃粘滞，按最新走（每次变化重置计时会把窗口拖到永远）
      const from = st.effectiveSig;
      st.effectiveSig = sig;
      st.effectiveIds = desired;
      st.candidateSig = null;
      st.flips = 0;
      return { ids: desired, suppressed: false, transition: { from, to: sig, waitedMs: 0, flips: TOOLSET_MAX_FLIPS } };
    }
  }

  // 窗口内：沿用上一次生效的集合（吸收本次变化）
  return { ids: st.effectiveIds, suppressed: true, transition: null };
}

/** 仅供测试：清空粘滞窗状态（全部会话桶）。 */
export function resetToolsetSticky() {
  toolsetStickyScopes.clear();
}

/** 仅供诊断/体检：粘滞窗状态快照（按会话桶）。 */
export function peekToolsetSticky() {
  const out = [];
  for (const [scope, st] of toolsetStickyScopes) {
    out.push({
      scope,
      size: st.effectiveIds ? st.effectiveIds.length : 0,
      pending: st.candidateSig ? st.candidateSig.split(',').length : 0,
      pendingForMs: st.candidateSig ? Date.now() - st.candidateSince : 0,
      flips: st.flips
    });
  }
  return out;
}

// ── 分类元数据（设置页展示用） ──
export const CATEGORY_META = {
  messaging: { name: '消息发送', icon: '💬', description: '发送文字、表情、戳一戳等' },
  sticker: { name: '表情管理', icon: '😀', description: '收藏、查看、备注表情包' },
  query: { name: '消息查询', icon: '🔍', description: '查看历史消息、成员列表等' },
  memory: { name: '记忆系统', icon: '🧠', description: '记录和查询对群友的长期印象' },
  web: { name: '联网搜索', icon: '🌐', description: '搜索网页、抓取内容' },
  knowledge: { name: '知识库', icon: '📚', description: '检索本地知识库并注入上下文' },
  media: { name: '媒体理解', icon: '🎞️', description: '视频抽帧、图片标注等' },
  system: { name: '系统反馈', icon: '⚙️', description: '向控制台反馈、结束会话等' }
};

/** skillErrorText 转出，便于 UI/调用方不额外 import errors.js。 */
export { skillErrorText };
