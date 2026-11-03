// 前缀缓存保活。
//
// 问题：会话存档里每个会话的第 1 次调用只有约 36% 命中缓存，同一会话第 2 次
// 就有 97%+。「工具 schema + 系统提示」这段前缀（约 6600 token）本身跨会话
// 字节一致，但服务商要先有请求写过它才会命中，而用户的实际会话大多是被叫一次、
// 回一句就结束，于是每个新会话都在为这段前缀付全价。
//
// 做法：后台按固定间隔发一次与真实调用前缀完全相同、尾部极短的请求：
//   messages = [ { role:'system', content: <真实系统提示> } ,
//                { role:'user',   content: '.' } ]
//   tools    = <与真实调用完全相同的工具集>
// 服务商把这段前缀缓存住，此后任何新会话的第一次调用都能命中。
//
// 与真实调用的前缀必须字节一致，这是本模块唯一的正确性要求：系统提示用同一个
// buildSystemPrompt、工具集用同一个 getToolAvailability，任何顺序/字段差异都会
// 让保活白做。所以下面直接复用 core 的构造函数，不另写一份。
//
// 保活请求不经过 orchestrator，因此不创建会话、不写 data/sessions、不进用量统计，
// 不经过 sender，不可能误发消息；失败只记一行日志。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, personaForChat, DATA_DIR } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { buildToolDefs, toOpenAiTools } from './tools.js';
import { getToolAvailability } from './tool-registry.js';
import { skillManager } from './skills/manager.js';
import { chatCompletion, addUsage, emptyUsage } from './llm.js';
import { modelImageVerdict } from './vision-scan.js';
import { logger } from './logger.js';

/** 保活用的会话上下文。取值只需保证"与真实调用同构"，不需要真实存在。 */
function warmContext() {
  const cfg = getConfig();
  const visionEnabled = cfg.api?.vision !== false
    && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision';
  return {
    // 用私聊形态：真实调用里私聊没有 chatName，群聊才有；
    // 而 chatName 不进系统提示（实测三个会话的系统提示字节一致），所以两者等价。
    chatKey: 'private:0-warm',
    kind: 'private',
    chatId: '0',
    chatName: '',
    model: cfg.api?.model || '',
    provider: cfg.api?.provider || '',
    visionEnabled,
    searchEnabled: cfg.webSearch?.enabled !== false,
    proactive: false,
    sessionId: 'cache-warm'
  };
}

/**
 * 最近一次真实运行实际发送的 system prompt。
 *
 * 保活原先是"自己重新构造一份 system prompt"。这看起来等价，实际不等价：插件
 * 可以有自己的运行时状态，构造结果会随探测进度变化。实测过的例子：video-frames
 * 的 available() 是「首次乐观放行 + 后台探测 ffmpeg」，启动后 20 秒的保活请求
 * 多注入了一段「视频理解」，而 3 分钟后真实调用的探测已完成（本机没装 ffmpeg），
 * 那一段消失，两者前缀差一段，缓存白写。
 *
 * 这种事无法靠"把构造参数写对"根治：任何插件都可能引入类似的时间相关状态。
 * 所以改为采集真实值：orchestrator 每次运行把实际发出去的 system prompt 记在
 * 这里，保活直接复用。逐字节一致由构造保证，而不是靠约定。
 */
let lastRealSystemPrompt = '';
let lastRealToolsJson = '';
// 真实调用实际发出的完整请求体与端点（含账号池挑的 baseUrl、专用模型等）。
// 预热必须原样复用它们：自己重造 body 会打到别的端点/模型，缓存键不同，
// 缓存写进别处，真实调用读不到。
let lastRealBody = null;
let lastRealBodyApi = null;

/**
 * 采集真实调用实际发出的请求（body + 端点）。由 orchestrator 调用。
 *
 * 必须连同 api 一起存：账号池（llm.endpoint-pick）会给每次真实请求重新挑端点，
 * 专用模型逻辑也可能换模型。若预热自己拼 body 或换端点，缓存键就与真实调用不同。
 * @param {{body:object, api:object}} p
 */
export function captureRealBody({ body, api } = {}) {
  try {
    if (body && Array.isArray(body.messages)) lastRealBody = JSON.parse(JSON.stringify(body));
    if (api && api.baseUrl) lastRealBodyApi = { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model };
  } catch { /* 采集失败不影响 */ }
  // 同时把这一份样本交回给调用方：lastRealBody 是模块级单槽，两个会话并发时
  // （群里同时被叫到两次）后采集的会覆盖先采集的，先发的那次预热就会拿着别人的
  // body 去写缓存，写完也是白写。实测症状是"命中档位在 2688 与 6784 之间无规律
  // 跳变"。调用方拿着返回值交给 warmBeforeRealCall({ sample })，从此不依赖单槽。
  return {
    body: body && Array.isArray(body.messages) ? JSON.parse(JSON.stringify(body)) : null,
    api: api && api.baseUrl ? { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model } : null
  };
}

/**
 * 采集到新前缀后，多久补一次保活。
 *
 * 保活循环的首次 tick 在启动后 20 秒，那时一次真实运行都还没发生，按"没有真实
 * 样本就不发"的规则直接跳过，下一个 tick 却要等一整个 interval（默认 60 分钟）。
 * 实测表现：启动后的会话第 1 次调用命中仅 2688（35%），要等真实调用自己把缓存
 * 写热才升到 6656（86%），保活迟到了一小时。
 *
 * 所以前缀一确定就尽快补一次：延迟 20 秒（避开这次运行自身的请求高峰），
 * 且同一前缀只补一次（避免每次运行都触发一次保活请求）。
 */
const EARLY_WARM_DELAY_MS = 20000;
let earlyWarmTimer = null;           // 已排期的 early-warm（同一时刻只排一个）
let cycleTick = null;           // 由 startCacheWarm 注入的 tick（未启动时为空）

/** 由 orchestrator 在每次运行开始时调用（见 src/orchestrator.js）。 */
export function noteRealPrompt({ systemPrompt, tools } = {}) {
  try {
    if (typeof systemPrompt === 'string' && systemPrompt) lastRealSystemPrompt = systemPrompt;
    if (Array.isArray(tools)) lastRealToolsJson = JSON.stringify(tools);
  } catch { return; /* 记不下来不影响主流程 */ }
  // 顺手落盘：下次启动时可以直接用它预热，不必等第一条消息
  persistPrefix();
  scheduleEarlyWarm();
  // 形状变化检测：systemPrompt 或工具集变了 → 安排一次按新形状的预热。
  // 放在 scheduleEarlyWarm 之后：earlyWarm 是「尽快补一次」，本函数是「形状变了
  // 才补」。两者都走 warmOnce，靠各自的时间窗去重，不会重复发。
  noteShapeChange({ systemPrompt, tools });
}

// ── 前缀持久化 ──────────────────────────────────────────────────────────
// 预热必须知道"这次调用会发什么前缀"。只能等本次运行构造完 system prompt 才知道
// 的话，本会话的第一次调用永远赶不上预热。把上次的前缀落盘，启动时就能先暖好，
// 第一条消息的调用即可命中。
//
// 只存 system 文本与工具名（不存用户消息、不含聊天内容），工具按名字从当前注册表
// 重建描述。描述可能随版本变化，但 system+工具名足以覆盖绝大部分前缀 token。
const PREFIX_FILE = path.join(DATA_DIR, 'cache-warm-prefix.json');

function persistPrefix() {
  try {
    const names = [];
    try {
      for (const t of (lastRealToolsJson ? JSON.parse(lastRealToolsJson) : [])) {
        const n = t?.function?.name;
        if (n) names.push(n);
      }
    } catch { /* 忽略 */ }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 临时名带 pid（理由同 config.js）
    const tmp = `${PREFIX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      system: lastRealSystemPrompt,
      toolNames: names,
      savedAt: Date.now()
    }), 'utf8');
    fs.renameSync(tmp, PREFIX_FILE);
  } catch { /* 落盘失败不影响 */ }
}

/** 启动时载入上次的前缀。返回是否载入成功。 */
export function loadPersistedPrefix() {
  try {
    const d = JSON.parse(fs.readFileSync(PREFIX_FILE, 'utf8'));
    if (typeof d?.system === 'string' && d.system) {
      lastRealSystemPrompt = d.system;
      // 用名字从当前注册表重建 tools（描述按当前代码为准）
      const names = Array.isArray(d.toolNames) ? d.toolNames : [];
      if (names.length) {
        const defs = buildToolDefs().filter((x) => names.includes(x.id));
        lastRealToolsJson = JSON.stringify(toOpenAiTools(defs));
      }
      return true;
    }
  } catch { /* 首次运行没有这个文件 */ }
  return false;
}

/**
 * 从会话存档里"借"一份 system prompt 来播种前缀。
 *
 * 落盘文件只在一次真实运行之后才存在，于是"启动预热"在第一次安装/第一次重启后
 * 总是没有样本可预热，而第一次调用恰恰是最需要它的那一次。会话存档里已经有真实
 * 发出去过的 systemPrompt，直接借来用即可打破这个循环。
 *
 * 只读 systemPrompt 字段（不含任何聊天内容），工具用当前注册表重建。
 * @returns {boolean} 是否播种成功
 */
export function seedPrefixFromSessions() {
  try {
    const dir = path.join(DATA_DIR, 'sessions');
    if (!fs.existsSync(dir)) return false;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return false;
    // 取修改时间最新的几个里第一个带 systemPrompt 的
    const sorted = files
      .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of sorted.slice(0, 5)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (typeof s?.systemPrompt === 'string' && s.systemPrompt) {
          lastRealSystemPrompt = s.systemPrompt;
          // 工具必须跑与真实调用相同的可用性过滤，不能用全部工具：真实调用会
          // 排掉未开启的（例如 send_to 默认关），少一个工具就是另一段 tools
          // 前缀，预热白做。这里复用 warmContext()，与 buildWarmPayload 的回退
          // 分支同源。
          try {
            const c = warmContext();
            const tc = getConfig().tools || {};
            const kept = buildToolDefs().filter((d) => getToolAvailability(d.id, {
              skills: skillManager,
              toolsCfg: tc,
              visionEnabled: c.visionEnabled,
              searchEnabled: c.searchEnabled,
              runtimeContext: c
            }).enabled);
            lastRealToolsJson = JSON.stringify(toOpenAiTools(kept));
          } catch {
            lastRealToolsJson = JSON.stringify(toOpenAiTools(buildToolDefs()));
          }
          logger.info('cache-warm', `已从会话存档播种前缀（system ${s.systemPrompt.length} 字符，tools ${
            (() => { try { return JSON.parse(lastRealToolsJson).length; } catch { return '?'; } })()} 个）`);
          return true;
        }
      } catch { /* 坏文件跳过 */ }
    }
  } catch { /* 忽略 */ }
  return false;
}

/** 新前缀确定后尽快补一次保活（同一前缀只补一次，按前缀集合判重）。 */
function scheduleEarlyWarm() {
  if (typeof cycleTick !== 'function') return;          // 保活循环没启动
  if (!lastRealSystemPrompt) return;
  if (earlyWarmDone.has(lastRealSystemPrompt)) return;  // 这份前缀已经补过
  if (earlyWarmTimer) return;                            // 已排期，等它跑
  earlyWarmTimer = setTimeout(() => {
    earlyWarmTimer = null;
    // 只在真的成功之后才标记。原实现先置位再跑 cycleTick() 且成功后不清零，
    // 一旦这次预热因网络/Key 失效失败，这份前缀在整个进程生命周期内都不会再走
    // early warm（只剩周期 tick），缓存命中白白少一档，日志上还看不出失败过。
    // 判重用 Set 而不是单槽：单槽在多群交替下永远"不等于上一份"，每个群都被
    // 反复 early-warm。
    const forPrompt = lastRealSystemPrompt;
    Promise.resolve(cycleTick())
      .then((r) => {
        if (r?.ok !== false) {
          earlyWarmDone.add(forPrompt);
          if (earlyWarmDone.size > 64) earlyWarmDone.delete(earlyWarmDone.values().next().value);
        }
      })
      .catch(() => { /* 失败不置位，下一次前缀事件还会再试 */ });
  }, EARLY_WARM_DELAY_MS);
  earlyWarmTimer.unref?.();
}

/** 供诊断/测试查看当前采集到的真实前缀。 */
export function peekRealPrompt() {
  return {
    hasSystem: Boolean(lastRealSystemPrompt),
    systemLen: lastRealSystemPrompt.length,
    hasTools: Boolean(lastRealToolsJson),
    toolsLen: lastRealToolsJson.length
  };
}

// ── 形状变化预热 ────────────────────────────────────────────────────────
// 前缀缓存按「前缀逐字节比对」计费。有三类事件会让下一枪的前缀与上一枪不同，
// 而保活缓存里存的还是上一枪的形状，于是必然错位一次：
//
//   应用重启     ：systemPrompt / 工具集/段落顺序都可能随代码版本变
//   工具集变化   ：加载/卸载扩展 → tools 数组变化
//   上下文档变化 ：contextTier 从 1(读20条) 跳到 4(读80条) →
//                  【过去状态】窗口起点变 → 历史块整体错位
//
// 三者本质是同一件事：保活缓存的形状 ≠ 真实调用的形状。所以合并成一个基础设施：
// 一旦检测到形状变化，立刻按「新形状」预热一次。
//
// 所有状态都按形状（systemPrompt 哈希）分桶：多群同时在线时，单槽状态会让群与群
// 之间互相"顶"：A 群预热完，B 群一跑就算"形状变了"，A 群再跑又变一次，实测每个
// 群每来一条消息都触发一次形状预热，既烧钱又给服务端并发限额添堵。
// 每个形状独立记：已预热指纹 / 上下文档档位 / 已 early-warm。
//
// 能力边界：预热时不知道下一条真实消息的内容（【本次唤醒】是新消息），所以只能
// 做到「system + tools + 历史窗口形状」一致，做不到逐字节一致。收益是把 cached
// 从 3200(20%) 提到 system+tools 边界(~12.6k) 那一档，而不是提到 96%。这是设计
// 使然，不是实现缺陷。
//
// 形状指纹 = systemPrompt + 工具名序列 + 窗口起点。任一变化就重预热，
// 同一指纹只预热一次。
const SHAPE_MAP_MAX = 128;              // 分桶 Map 的容量上限（超出抛最旧的）
const SHAPE_WARM_DELAY_MS = 3000;       // 略等一拍，让并发变化合并成一次预热
const warmedShapeByShape = new Map();   // shapeKey -> 上次预热成功的指纹
const tierByShape = new Map();          // shapeKey -> 最近一次已知的上下文档档位
const earlyWarmDone = new Set();        // 已补过 early-warm 的 systemPrompt 原文
// shapeKey -> 上次预热成功的时刻。warmOnce 的统一去重窗口用它（见 warmOnce 里
// 「同形状预热去重」一节：四条路径各自判重曾导致同一 shape 8 秒内被暖 5 次）。
const lastWarmOkByShape = new Map();

/** 有界写入：Map 超容时抛掉最旧的一条（Map 保序，first 即最旧）。 */
function boundedMapSet(map, key, val) {
  if (!map.has(key) && map.size >= SHAPE_MAP_MAX) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
  map.set(key, val);
}

/** systemPrompt 的形状键（内容哈希）。同一群的 systemPrompt 跨轮稳定。 */
function shapeKeyOfSystem(systemPrompt) {
  return typeof systemPrompt === 'string' && systemPrompt ? strHash(systemPrompt) : '';
}

/** 滚动哈希（systemPrompt 的内容也要参与指纹）。 */
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * 计算当前前缀的形状指纹。
 * @param {{systemPrompt?:string, tools?:Array}} p
 * @returns {string}
 */
function shapeFingerprint(p) {
  const sys = typeof p?.systemPrompt === 'string' ? p.systemPrompt : lastRealSystemPrompt;
  let toolSig = '';
  try {
    const arr = Array.isArray(p?.tools) ? p.tools : (lastRealToolsJson ? JSON.parse(lastRealToolsJson) : []);
    toolSig = arr.map((t) => t?.function?.name || '').join(',');
  } catch { toolSig = ''; }
  // systemPrompt 的内容必须参与哈希，不能只放 sys.length：systemPrompt 变了但
  // 长度恰好不变（改错别字、同长度换词）时指纹会相同，变化检测不到。
  const s = `${sys.length}|${strHash(sys)}|${toolSig.length}|${toolSig}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `sys${sys.length}-tool${toolSig.length}-${(h >>> 0).toString(16)}`;
}

/**
 * 通知「前缀形状变了」，安排一次按新形状的预热。
 *
 * 调用点：noteRealPrompt()（每次真实运行后）与启动预热之后。
 *
 * 实现要点：按形状分桶 + 延迟 + 去重。
 *   · 延迟 3 秒：变化可能在几百毫秒内连续发生（工具集刷新同时档位也在变），
 *     合并成一次预热请求。
 *   · 去重按形状判：同一形状"已预热指纹相同"或"已排队"就跳过。多群在线时
 *     单槽判重会让 A 群每来一条消息都算"形状变了"（因为 B 群刚改过）。
 */
export function noteShapeChange({ systemPrompt, tools, log = () => {}, force = false, shapeKey = '' } = {}) {
  if (getConfig().cacheWarm?.enabled !== true) return;
  const key = shapeKey || shapeKeyOfSystem(systemPrompt) || shapeKeyOfSystem(lastRealSystemPrompt);
  if (!key) return;
  const fp = shapeFingerprint({ systemPrompt, tools });
  // force 跳过"形状没变"短路。noteContextTier 场景下 system/tools 都不传（回退到
  // lastReal*，必然等于上次预热所用的形状），不带 force 时这里永远 return，
  // "tier 变化触发一次预热"就是死路径。
  if (warmedShapeByShape.get(key) === fp && !force) return;   // 这个形状没变，不用预热
  // 同一形状同一指纹已排队就不重排。原实现每次调用都 clearTimeout + 重设 3 秒，
  // 而"已预热"只在预热成功后才更新："形状已变但还没预热"的窗口里，每次真实调用
  // 都会把定时器往后推，群消息间隔 < 3s 的活跃群永远等不到触发。
  const queued = pendingShapeWarms.get(key);
  if (queued && queued.fp === fp && !force) return;
  pendingShapeWarms.set(key, { fp, systemPrompt, tools, log, force });
  if (shapeWarmTimer) clearTimeout(shapeWarmTimer);          // 合并同一批变化
  shapeWarmTimer = setTimeout(flushShapeWarms, SHAPE_WARM_DELAY_MS);
  shapeWarmTimer.unref?.();
}

// 待预热的形状队列（shapeKey -> { fp, systemPrompt, tools, log }）+ 一个合并定时器。
const pendingShapeWarms = new Map();
let shapeWarmTimer = null;

/** 3 秒到点：把这一批形状**各自**暖一次（串行，避免并发把服务端限额打满）。 */
async function flushShapeWarms() {
  shapeWarmTimer = null;
  const entries = [...pendingShapeWarms.entries()];
  pendingShapeWarms.clear();
  for (const [key, e] of entries) {
    try {
      // 档位跳变走 force：指纹里没有历史窗口分量，档位变而指纹不变时不能按
      // "形状没变"跳过，要暖的正是新档位的历史块（真实 body 那条路）。
      if (!e.force && warmedShapeByShape.get(key) === e.fp) continue;
      // systemPrompt 传这个形状自己的：warmOnce 默认暖 lastRealBody（单槽，多群下
      // 可能是别人的），显式传入才能保证暖的是触发预热的那个群。
      // force 透传：档位跳变要暖的是新历史窗口，必须绕过 warmOnce 的同形状去重。
      const r = await warmOnce({
        log: e.log,
        systemPrompt: e.systemPrompt || lastRealSystemPrompt,
        tools: e.tools,
        force: Boolean(e.force)
      });
      if (r?.ok !== false) {
        boundedMapSet(warmedShapeByShape, key, e.fp);
        if (r?.dedup) logger.info('cache-warm', `形状变化预热跳过（${r.reason}）`);
        else logger.info('cache-warm', `形状变化预热完成（${r.prompt} tok，命中 ${r.cached}）`);
      }
      // 失败不置位：下一次形状事件还会再试（与 early-warm 的教训一致）。
    } catch { /* 单形状失败不影响同批其他形状 */ }
  }
}

/**
 * 通知「上下文档（历史窗口）变了」。
 *
 * tier 从 1→4 时【过去状态】窗口起点变化，system+tools 形状其实没变（所以
 * shapeFingerprint 认不出来），但历史块要重写。这里独立记录 tier，变化时也
 * 触发一次预热。
 *
 * 档位按形状分桶记：lastTier 曾是单槽，多群交替调用时它每秒都在"变"，每个群都被
 * 误判成档位跳变。现在 key 由调用方传入该次运行的 systemPrompt，只有这个群自己的
 * 档位真的变了才触发。
 *
 * 真实调用的 messages 里含具体历史内容，预热无法逐字节复刻。这里能做到的是
 * "把 system+tools 段写热 + 让历史块的起点与真实调用一致"，收益有限但成本也低。
 */
export function noteContextTier(tier, { log = () => {}, systemPrompt = '' } = {}) {
  if (getConfig().cacheWarm?.enabled !== true) return;
  const key = shapeKeyOfSystem(systemPrompt) || shapeKeyOfSystem(lastRealSystemPrompt);
  if (!key) return;
  const t = tier === null || tier === undefined ? null : Number(tier);
  if (tierByShape.get(key) === t) return;
  const first = !tierByShape.has(key);   // 这个形状第一次见：只记录（启动预热已覆盖）
  boundedMapSet(tierByShape, key, t);
  if (first) return;
  logger.info('cache-warm', `上下文档变化（${t}），安排一次预热`);
  // 必须带 force：不传 system/tools 时指纹必然等于已预热指纹，不带 force 这条路
  // 在 noteShapeChange 的短路处永远返回（死路径）。
  noteShapeChange({ log, force: true, shapeKey: key, systemPrompt: systemPrompt || lastRealSystemPrompt });
}

/**
 * 把「当前采集到的真实前缀」登记为已预热形状。
 *
 * 用途：`loadPersistedPrefix` / `seedPrefixFromSessions` 把落盘前缀装进
 * lastRealSystemPrompt 之后调用它：这样启动预热完成时，形状指纹就被记为
 * 「已预热」，真实运行若形状没变就不会重复预热；若形状变了（重启后代码/工具
 * 集不同）则 noteShapeChange 会检测到差异并补一次。
 */
export function markCurrentShapeWarmed() {
  if (!lastRealSystemPrompt) return;
  boundedMapSet(warmedShapeByShape, shapeKeyOfSystem(lastRealSystemPrompt), shapeFingerprint({}));
}

// ── 调用前预热 ──────────────────────────────────────────────────────────
// 实测 A/B/C 三组对照：直接发真实调用首轮命中 91.8%，先发同前缀预热再发是
// 97.1%。原理是真实调用作为"这个前缀的第一次请求"时只能命中服务商恰好已有的
// 部分，先让一次没有后续负担的请求把前缀写进缓存，真实调用就能读到完整前缀。
//
// 成本：一次预热约 7000 token 输入，命中率 90%+（按缓存价计费），约 0.00035
// 元/次，相对一次真实调用的 0.008 元可忽略。
//
// 触发条件（三条同时满足，避免滥用）：
//   ① 配置里 cacheWarm.enabled 且 cacheWarm.preCall !== false
//   ② 已经有真实前缀样本（否则不知道要预热什么）
//   ③ 这份前缀最近没有预热过（preCallGapSec 秒内不重复，默认 45 秒）
// 开小（如 5-10s）接近"每条消息都预热"，真实调用能冲到 97-100%，代价是请求数
// 翻倍、上游限流时适得其反（429 冷却会自动兜底暂停）。
const PRE_CALL_GAP_SEC_DEFAULT = 45;
function preCallGapMs() {
  const sec = Number(getConfig().cacheWarm?.preCallGapSec);
  const v = Number.isFinite(sec) ? Math.max(0, sec) : PRE_CALL_GAP_SEC_DEFAULT;
  return v * 1000;
}
// 按「前缀形状 + 端点」分桶。旧实现只有一个全局槽（lastPreCallPrefix /
// lastPreCallWarmAt / preCallInFlight），并发会话下有两个洞：
//   ① 群聊的 system prompt 含群名（【场景】稳定段），每个群是不同的前缀，但
//      lastRealSystemPrompt 是模块级单槽，B 群的 gap 判定和 in-flight 合并都是
//      拿 A 群的形状做的；
//   ② preCallInFlight 互斥让 B 群"蹭"A 群的预热，等来的是写给 A 群 body 的缓存，
//      B 群自己的形状一个字节都没暖，那一枪真实调用必掉档。
// 现在每个形状独立记 warmedAt / inFlight：同形状并发仍然合并成一次，不同形状
// 并行各暖各的（有并发上限，超过就让真实调用自己写缓存）。
const PRE_CALL_MAX_CONCURRENT = 5;   // 同时在飞的预热请求上限（活跃多群 burst 时放宽，单次预热仅 ~0.00035 元）
const PRE_CALL_BUCKET_TTL_MS = 10 * 60 * 1000;   // 桶的保留时长（超过且空闲就清）
const preCallBuckets = new Map();    // key -> { warmedAt:number, inFlight:Promise|null }

// ── 限流自保 ────────────────────────────────────────────────────────────
// 上游限流（HTTP 429 / concurrency limit）时预热还在往里冲：预热请求在队列里
// 排 90-180 秒，占着上游并发位不放，限流越滚越紧（真实调用也开始 429）。
// 两道自保：
//   ① 预热超时压到 30 秒：排不上就早断，快速释放并发位（llm.js 的 timeoutMs 入参）；
//   ② 触发限流后全局冷却 2 分钟：冷却期内一切预热（调用前/形状/保活）都不发，
//      只留真实调用：真实调用有 WithRetry 兜底，预热没有。
const WARM_TIMEOUT_MS = 30000;
const WARM_429_COOLDOWN_MS = 120000;
let warmCooldownUntil = 0;
function warmCooldownActive(now = Date.now()) { return now < warmCooldownUntil; }
function noteWarmFailure(error) {
  const msg = String(error?.message ?? error ?? '');
  if (/429|rate.?limit|too many|太频繁|concurrency/i.test(msg)) {
    warmCooldownUntil = Date.now() + WARM_429_COOLDOWN_MS;
    logger.info('cache-warm', `预热触发限流冷却（${WARM_429_COOLDOWN_MS / 1000}s 内暂停一切预热，只保真实调用）：${msg.slice(0, 120)}`);
  }
}

/**
 * 算这次调用前预热对应的桶键。入参必须是发送路径真正会用的那两个值
 * （resolvedBody / resolvedApi），键与请求必须同源：键算 A、请求发 B，
 * 等于把一个并发洞换成另一个。
 * 键 = system prompt 内容哈希 + 端点（baseUrl|model）+ 上下文档档位（该形状自己的）。
 * 端点必须进键：账号池/渠道不同就是不同的缓存键，白暖。
 * 档位必须进键：档位跳变（tier1→tier4，群从冷变热）时【过去状态】窗口起点改变，
 * 历史块整体错位，缓存只能吃到 system+tools 边界（实测掉到 60%）。档位不变时桶键
 * 不变（间隔内不重复暖），档位一变就是另一个桶，新档位的第一枪也能拿到带真实
 * 历史的预热。
 */
function preCallBucketKey(resolvedBody, resolvedApi) {
  const reuse = Boolean(resolvedBody && Array.isArray(resolvedBody.messages) && resolvedBody.messages.length && resolvedApi?.baseUrl);
  // 复用分支发的是 body 里的 system；自建分支发的是单槽里的 system。
  const sys = reuse
    ? (resolvedBody.messages[0]?.role === 'system' ? String(resolvedBody.messages[0].content || '') : '')
    : (typeof lastRealSystemPrompt === 'string' ? lastRealSystemPrompt : '');
  if (!sys) return '';
  // 自建分支不带 overrides，走的是默认端点，端点串必须与之一致（空串）。
  const endpoint = reuse ? `${resolvedApi.baseUrl}|${resolvedApi.model || ''}` : '';
  // 档位从这个形状自己的桶里取（tierByShape 由 noteContextTier 维护）。
  // 值为 null（该群还没报过档位）时记为 '-'，与任何数字档位都不同，不会把
  // "没档位信息"误并进某个真实档位的桶。
  const shapeKey = shapeKeyOfSystem(sys);
  const t = tierByShape.has(shapeKey) ? tierByShape.get(shapeKey) : null;
  const tier = (t === null || t === undefined) ? '-' : String(t);
  return `${shapeKey}|${endpoint.length}|${strHash(endpoint)}|t${tier.length}-${strHash(tier)}`;
}

/** 顺手清掉过期且空闲的桶，避免 Map 随形状种类无限长。 */
function prunePreCallBuckets(now) {
  if (preCallBuckets.size < 64) return;
  for (const [k, b] of preCallBuckets) {
    if (!b.inFlight && now - b.warmedAt > PRE_CALL_BUCKET_TTL_MS) preCallBuckets.delete(k);
  }
}

/**
 * 预热请求的发送：失败后快重试一次（250ms，不指数退避，因为 orchestrator 会
 * await 预热，退避等待直接加在真实调用的延迟上）。
 * 刻意不用 chatCompletionWithRetry：它内部会把 args.overrides 换成备选渠道的
 * 端点，而预热必须钉死在真实调用那个端点上，否则缓存键不同、白写。
 * 重试只可能是同端点同参数（幂等，只写缓存不产生发言）。
 */
async function sendWarmRequest(args) {
  try {
    return await chatCompletion(args);
  } catch (error) {
    // 限流（429）不重试：上游明说"retry later"，250ms 后原样再打只是给并发限额
    // 添堵，还会让 noteWarmFailure 的冷却晚一个来回。直接放行让上层记失败 + 进冷却。
    if (/429|rate.?limit|too many|太频繁|concurrency/i.test(String(error?.message ?? error))) throw error;
    await new Promise((r) => setTimeout(r, 250));
    return await chatCompletion(args);
  }
}

/**
 * 在真实调用前预热缓存。**不阻塞主流程**：调用方 await 它也只是等它发出请求，
 * 失败/超时都不影响后续真实调用。
 */
export async function warmBeforeRealCall({ log = () => {}, label = '', sample = null } = {}) {
  const cfg = getConfig();
  if (cfg.cacheWarm?.enabled !== true) return { ok: false, reason: '未启用' };
  if (cfg.cacheWarm?.preCall === false) return { ok: false, reason: '调用前预热已关闭' };
  if (warmCooldownActive()) return { ok: false, reason: '限流冷却中，跳过预热' };
  // 先定发送路径真正会用的两个输入（优先调用方当场交回的样本，并发安全），
  // 再算桶键：顺序不能反，键必须与请求同源。
  const sampleBody = sample?.body || lastRealBody;
  const sampleApi = sample?.api || lastRealBodyApi;
  const bucketKey = preCallBucketKey(sampleBody, sampleApi);
  if (!bucketKey) return { ok: false, reason: '还没有真实前缀样本' };

  const now = Date.now();
  prunePreCallBuckets(now);
  const bucket = preCallBuckets.get(bucketKey) || { warmedAt: 0, inFlight: null };
  if (bucket.inFlight) return bucket.inFlight;   // 同一形状并发只发一次
  if (now - bucket.warmedAt < preCallGapMs()) {
    return { ok: false, reason: `该前缀 ${Math.round((now - bucket.warmedAt) / 1000)} 秒前刚预热过` };
  }
  // 并发上限：不同形状同时预热最多 PRE_CALL_MAX_CONCURRENT 个。超了就跳过，
  // 预热只是"提前写缓存"，跳过不会更差，真实调用自己会把缓存写热。
  let inFlightCount = 0;
  for (const b of preCallBuckets.values()) if (b.inFlight) inFlightCount++;
  if (inFlightCount >= PRE_CALL_MAX_CONCURRENT) {
    preCallBuckets.set(bucketKey, bucket);
    return { ok: false, reason: '预热并发已满，跳过（真实调用会自行写缓存）' };
  }

  bucket.warmedAt = now;
  bucket.inFlight = (async () => {
    try {
      // 首选：原样复用真实调用的请求体与端点。两条实测教训：
      //   ① 只留「system + 一个句号」→ 预热自身只命中 2688（40%），等于没暖到；
      //      必须带上真实调用的完整 user 消息，才能落到高价值那一档。
      //   ② 尾部不要再加任何东西。实测"尾部相同"与"尾部多个句号"的命中量完全
      //      一样，说明服务商按前缀分档，尾部差异不影响；但消息与真实调用完全
      //      一致能保证两者共享同一份缓存档位，不再各占一档互相驱逐。
      //      所以这里逐字节复用真实消息，只改 max_tokens / temperature / thinking。
      if (sampleBody && sampleApi) {
        const warmBody = JSON.parse(JSON.stringify(sampleBody));
        const msgs = Array.isArray(warmBody.messages) ? warmBody.messages : [];
        // 逐字节复用真实消息（含 system + user），不增不减不做尾部替换，
        // 这是"与真实调用共享同一缓存档位"的唯一保证。
        if (!msgs.length) return { ok: false, reason: '没有可复用的消息' };
        // 关键：把整份真实 body 原样交给 llm 发送（sameBody），而不是只交
        // messages/tools 让它重新构造。只交 messages 的话，核心会用
        // temperature/maxTokens 两个入参再算一遍 buildBaseBody + 各 Skill 的
        // request-params，得到的是另一个 body，与真实调用各占一个缓存档位并互相
        // 驱逐。现在唯一允许的差异是 max_tokens=1（只写缓存、不要它说话），它在
        // messages 之后，不影响前缀哈希。
        const res = await sendWarmRequest({
          messages: msgs,
          tools: warmBody.tools || null,
          temperature: null,
          maxTokens: 1,
          sameBody: warmBody,
          tag: `warm${label ? ':' + label : ''}`,
          timeoutMs: WARM_TIMEOUT_MS,
          // 用真实调用用的那个端点（含账号池的决定），否则缓存键不同，白写
          overrides: sampleApi
        });
        const acc = addUsage(emptyUsage(), res?.usage);
        // 带上会话 id：预热与真实调用必须能精确配对，否则只能靠时间戳猜。
        // 实测过这个坑：只按顺序配对时出现过"预热 8537 / 真实 8546"这种差几个
        // token 的组合，无法判断是配对错了还是真的前缀不同。
        logger.info('cache-warm', `调用前预热完成${label ? ` [${label}]` : ''}（${acc.promptTokens} tok，命中 ${acc.cachedTokens}）`);
        return { ok: true, prompt: acc.promptTokens, cached: acc.cachedTokens, mode: 'reuse-real-body', label };
      }

      // 回退：用采集到的 system + tools 自建（启动初期还没跑过真实调用时）
      let tools = [];
      try { tools = lastRealToolsJson ? JSON.parse(lastRealToolsJson) : []; } catch { tools = []; }
      const res = await sendWarmRequest({
        messages: [
          { role: 'system', content: lastRealSystemPrompt },
          { role: 'user', content: '。' }
        ],
        tools,
        maxTokens: 1,
        temperature: 0
      });
      const acc = addUsage(emptyUsage(), res?.usage);
      // 走 logger 而不是调用方传进来的 log：orchestrator 传的是
      // skillManager.recordError(id, msg)，它每个 id 只保留最后一条消息，连续两次
      // 预热会把第一条覆盖掉，日志里就永远看不到预热成功。
      logger.info('cache-warm', `调用前预热完成（${acc.promptTokens} tok，命中 ${acc.cachedTokens}）[自建前缀]`);
      void log;
      return { ok: true, prompt: acc.promptTokens, cached: acc.cachedTokens, mode: 'built' };
    } catch (error) {
      // 预热失败绝不能影响真实调用，只记一行
      noteWarmFailure(error);
      logger.info('cache-warm', `调用前预热失败（忽略）：${error?.message ?? error}`);
      return { ok: false, reason: String(error?.message ?? error) };
    } finally {
      bucket.inFlight = null;   // 同形状的下一次预热等 45 秒 gap 过后自然来
    }
  })();
  preCallBuckets.set(bucketKey, bucket);
  return bucket.inFlight;
}

/**
 * 构造一次保活请求的 { system, tools }。
 *
 * 优先用真实运行采集到的那份（保证逐字节一致）；还没采集到（刚启动、一次真实
 * 运行都没发生过）才回退到自行构造，并且此时不发送，因为自行构造的前缀很可能与
 * 真实前缀不一致，发了也是白写缓存、还花钱。
 *
 * @returns {{system:string, tools:Array, source:'real'|'built'}}
 */
export function buildWarmPayload() {
  // ① 优先：真实运行采集到的（唯一能保证逐字节一致的来源）
  if (lastRealSystemPrompt) {
    let tools = [];
    try { tools = lastRealToolsJson ? JSON.parse(lastRealToolsJson) : []; } catch { tools = []; }
    return { system: lastRealSystemPrompt, tools, source: 'real' };
  }
  // ② 回退：自行构造（仅供诊断；warmOnce 会因 source !== 'real' 而跳过发送）
  const cfg = getConfig();
  const skillContext = warmContext();
  // 必须与 orchestrator 的真实调用同样 deferVolatile: true，预热的前缀只有与真实
  // systemPrompt 逐字节一致才有意义（见 src/prompt.js 方案 A 注释）。
  const system = buildSystemPrompt({
    skillContext,
    persona: personaForChat(skillContext.chatKey),
    deferVolatile: true
  });
  const toolsCfg = cfg.tools || {};
  const defs = buildToolDefs().filter((d) => getToolAvailability(d.id, {
    skills: skillManager,
    toolsCfg,
    visionEnabled: skillContext.visionEnabled,
    searchEnabled: skillContext.searchEnabled,
    runtimeContext: skillContext
  }).enabled);
  return { system, tools: toOpenAiTools(defs), source: 'built' };
}

/** 静默时段判断（quietHours 里的小时不发请求）。空数组 = 全天保活。 */
function inQuietHours(now = new Date()) {
  const q = getConfig().cacheWarm?.quietHours;
  if (!Array.isArray(q) || !q.length) return false;
  return q.map(Number).includes(now.getHours());
}

/**
 * 发一次保活请求。
 * @param {{log?:Function, systemPrompt?:string, tools?:Array, force?:boolean}} args
 *   force=true 绕过「同形状去重」（档位跳变 R3 要暖的是新历史窗口，不是同一份前缀）
 * @returns {{ok:boolean, reason?:string, cached?:number, prompt?:number, dedup?:boolean}}
 */
export async function warmOnce({ log = () => {}, systemPrompt = '', tools = null, force = false } = {}) {
  const cfg = getConfig();
  if (cfg.cacheWarm?.enabled !== true) return { ok: false, reason: '未启用' };
  if (warmCooldownActive()) return { ok: false, reason: '限流冷却中，跳过预热' };
  if (!String(cfg.api?.model || '').trim()) return { ok: false, reason: '模型未设置' };
  if (inQuietHours()) return { ok: false, reason: '静默时段' };

  let payload;
  try {
    payload = buildWarmPayload();
  } catch (error) {
    return { ok: false, reason: `构造前缀失败：${error?.message ?? error}` };
  }
  // 定向预热（flushShapeWarms 用）：调用方指名要暖某个形状的 system+tools。
  // 判据是"传入的 systemPrompt 与当前单槽里的不是同一份"：同一份时走下面原有
  // 的形状感知路径（连真实 body 一起暖，覆盖更全）。
  const targeted = Boolean(systemPrompt) && systemPrompt !== lastRealSystemPrompt;
  if (targeted) {
    payload = { system: systemPrompt, tools: Array.isArray(tools) ? tools : payload.tools, source: 'real' };
  }
  // ── 同形状预热去重 ────────────────────────────────────────────────────
  // 实测：应用重启后 8 秒内对同一个 shape（18773 tok）连发了 5 次预热，四条路径
  // （启动 / 保活 tick / early-warm / 形状变化）各走各的判重，互相看不见。每次要
  // 1.5~6 秒，等于把 5 个上游并发位占掉十几秒，而该模型的并发上限只有 16，同一
  // 时段有 41 次真实调用被 429 打回。重复暖同一份前缀没有任何收益（缓存里已经
  // 写进去了），所以在 warmOnce 这个唯一收口处按形状做一次时间窗判重。
  // 配置项 cacheWarm.warmDedupSec（默认 20；设 0 关闭）。
  const dedupKey = `${String(payload.system || '').length}:${shapeKeyOfSystem(payload.system || '') || '(none)'}`;
  const dedupMs = (() => {
    const sec = Number(getConfig().cacheWarm?.warmDedupSec);
    return (Number.isFinite(sec) ? Math.max(0, sec) : 20) * 1000;
  })();
  if (!force && dedupMs > 0) {
    const gap = Date.now() - (lastWarmOkByShape.get(dedupKey) || 0);
    if (gap < dedupMs) {
      return { ok: true, dedup: true, prompt: 0, cached: 0, ms: 0,
        reason: `同形状 ${(gap / 1000).toFixed(0)}s 前刚暖过（<${dedupMs / 1000}s 去重窗口）` };
    }
  }
  // 没有真实样本就不发：自行构造的前缀很可能与真实调用不一致，发了只会白写一段
  // 没人读的缓存，还照样花掉输入 token。
  //
  // 判定放宽（形状感知路径）：lastRealBody（真实调用的完整请求体）是比
  // lastRealSystemPrompt 更强的"真实样本"，有它就能走形状感知路径（连历史块一起
  // 预热）。所以只要任一真实样本存在就放行。
  const hasRealBody = Boolean(lastRealBody && Array.isArray(lastRealBody.messages) && lastRealBody.messages.length);
  if (payload.source !== 'real' && !hasRealBody) {
    return { ok: false, reason: '还没有真实运行可作为前缀样本（等下一次群消息后再保活）' };
  }
  if (!payload.system && !hasRealBody) return { ok: false, reason: '系统提示为空' };

  const startedAt = Date.now();
  try {
    // 形状感知：优先级是真实 body > 自建。
    //
    // 为什么优先用真实 body：前缀缓存按逐字节前缀计费。真实 body 里的 user 消息含
    // 完整历史块（【过去状态】+【本次唤醒】+ 末尾动态段），用它预热能让
    // 「system + tools + 历史窗口」整体落在同一缓存档；只发 system + '。' 的话，
    // 服务商那边 system+tools 是一档、历史块是另一档，真实调用读历史块时仍然 miss。
    //
    // 但【本次唤醒】是新消息、预热时拿不到，无法完全复刻。所以这里用「真实 body
    // 的形状」而不是「真实 body 的内容」：只改 max_tokens（在 messages 之后，
    // 不影响前缀哈希），其余原样复用，与 warmBeforeRealCall 的做法一致。
    const body = lastRealBody;
    const api = lastRealBodyApi;
    // targeted 时 lastRealBody 是别的形状的（多群交替调用），绝不能拿来暖本形状，
    // 写进去的是别人的缓存档。定向预热只走 system+tools。
    if (!targeted && body && Array.isArray(body.messages) && body.messages.length && api?.baseUrl) {
      const warmBody = JSON.parse(JSON.stringify(body));
      const res = await chatCompletion({
        messages: warmBody.messages,
        tools: warmBody.tools || payload.tools,
        temperature: null,
        maxTokens: 1,
        sameBody: warmBody,
        tag: 'warm:shape',
        timeoutMs: WARM_TIMEOUT_MS,
        overrides: api
      });
      const acc = addUsage(emptyUsage(), res?.usage);
      const cached = acc.cachedTokens;
      const prompt = acc.promptTokens;
      const ms = Date.now() - startedAt;
      const rate = prompt ? (cached / prompt * 100).toFixed(0) : '?';
      boundedMapSet(lastWarmOkByShape, dedupKey, Date.now());
      log(`[cache-warm] 已保活前缀（形状=真实body，${prompt} tok，命中 ${cached} = ${rate}%，${ms}ms）`);
      return { ok: true, cached, prompt, ms, mode: 'shape-real-body' };
    }

    // 回退：只有 system+tools 样本时（启动初期还没跑过真实调用）
    const res = await chatCompletion({
      messages: [
        { role: 'system', content: payload.system },
        // 尾部越短越省：这一句不参与缓存，只用来让请求合法。
        { role: 'user', content: '。' }
      ],
      tools: payload.tools,
      // 不让它思考、不要它输出：这只是"写缓存"的动作
      maxTokens: 1,
      temperature: 0,
      timeoutMs: WARM_TIMEOUT_MS
    });
    // chatCompletion 返回的 usage 是服务端原始字段（snake_case），不是项目内部的
    // 驼峰结构。必须走 addUsage 归一化，直接读 usage.cachedTokens 会永远拿到 0。
    const acc = addUsage(emptyUsage(), res?.usage);
    const cached = acc.cachedTokens;
    const prompt = acc.promptTokens;
    const ms = Date.now() - startedAt;
    const rate = prompt ? (cached / prompt * 100).toFixed(0) : '?';
    boundedMapSet(lastWarmOkByShape, dedupKey, Date.now());
    log(`[cache-warm] 已保活前缀（${prompt} tok，命中 ${cached} = ${rate}%，${ms}ms）`);
    return { ok: true, cached, prompt, ms, mode: 'system-only' };
  } catch (error) {
    // 失败不抛出：保活是尽力而为的后台动作，绝不能影响主流程。但也不能静默，
    // 一直失败说明配置有问题（Key 失效 / 余额不足），用户需要能在日志里看到。
    // 限流类失败额外触发冷却（见 WARM_429_COOLDOWN_MS）。
    noteWarmFailure(error);
    log(`[cache-warm] 保活失败（忽略，不影响使用）：${error?.message ?? error}`);
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 启动保活循环。
 *
 * 配置热生效：每次 tick 都重新读 getConfig().cacheWarm.enabled，用户在设置页
 * 打开/关闭开关后不需要重启，下一次 tick 就按新值走。
 *
 * @returns {{stop:Function, warmNow:Function}} 句柄
 */
export function startCacheWarm(log = console.log) {
  let timer = null;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;      // 防重入：一次保活没跑完就别再发
    // 热读开关：关掉后不再发请求（但保留定时器，以便再次打开时立即生效）
    if (getConfig().cacheWarm?.enabled !== true) return;
    running = true;
    try { await warmOnce({ log }); }
    finally { running = false; }
  };

  const min = Math.max(1, Number(getConfig().cacheWarm?.intervalMin) || 10);
  // 把 tick 暴露给 noteRealPrompt：前缀一确定就补一次保活，不必等下一个整周期。
  cycleTick = tick;
  // 首次延迟 20 秒：避开启动高峰（与遥测的 90 秒同理，但保活要早点建立缓存）
  const first = setTimeout(() => { tick().catch(() => {}); }, 20000);
  first.unref?.();
  timer = setInterval(() => { tick().catch(() => {}); }, min * 60000);
  timer.unref?.();

  log(getConfig().cacheWarm?.enabled === true
    ? `[cache-warm] 前缀缓存保活已启用：每 ${min} 分钟一次`
    : '[cache-warm] 前缀缓存保活未启用（可在 设置 → 模型 API 打开）');

  return {
    stop: () => {
      stopped = true;
      cycleTick = null;
      clearTimeout(first);
      if (earlyWarmTimer) { clearTimeout(earlyWarmTimer); earlyWarmTimer = null; }
      if (timer) clearInterval(timer);
      timer = null;
    },
    warmNow: () => warmOnce({ log })
  };
}
