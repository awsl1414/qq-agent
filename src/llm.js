// OpenAI 兼容 Chat Completions 客户端（非流式）：工具调用、usage 统计、可自选模型。

import { getConfig } from './config.js';
import { dispatcherFor } from './proxy-agent.js';
import { resolveModelPrice, priceAt } from './model-prices.js';
import { skillManager } from './skills/manager.js';
import { describeNetError, previewBody } from './providers.js';
import { annotateApiError } from './error-l10n.js';
import { normalizeProtocol, buildProtocolRequest, parseProtocolResponse, protocolModelsRequest, parseProtocolModels } from './api-protocols.js';
import { logger } from './logger.js';
import crypto from 'node:crypto';

function authHeaders(apiKey, baseUrl = '', model = '') {
  const h = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  // OpenCode Go 强制要求会话头做路由（缺了直接 400）。不能只认域名：走中转站
  // 转发时 baseUrl 不是 opencode.ai，只能靠模型 id 的 opencode-go/ 前缀识别。
  if (/opencode\.ai/i.test(String(baseUrl)) || /^opencode-go\//i.test(String(model || ''))) {
    h['x-opencode-session'] = getOpencodeSessionId();
    h['user-agent'] = 'qq-agent/0.3';   // 官方文档要求客户端自报身份，别用通用库名
  }
  return h;
}

// OpenCode Go 会话 ID：进程级生成一次，全程复用（路由粘性 + 缓存命中）
let opencodeSessionId = '';
function getOpencodeSessionId() {
  if (!opencodeSessionId) {
    opencodeSessionId = `qqagent-${crypto.randomUUID()}`;
  }
  return opencodeSessionId;
}

// ── 工具集合看门狗 ──────────────────────────────────────────────────────
// tools 段占提示词的 40%+，且排在 messages 之前。工具集合任何增删都会让
// byte-LCP 从 tools 段第一字节断掉，后面全部内容（系统提示、人格、全部历史）
// 一次性全价重算。实测每次切换后的第一条请求 miss 15,837~18,083 tok。
//
// 头号成因是人为的：改内置插件 JS → 文件与随包基线不一致 → 准入闸拦截 →
// 该插件的工具静默消失 → 用户点信任 → 工具又回来。每次「消失-回来」都是一次
// 15k+ 的坑。参见 SKILL 记忆：改内置插件 JS 后必须立即点信任。
//
// 放在 llm.js 是因为这里是唯一同时握有 tools 数组与 logger 的位置，且指纹 fp
// 本来就在算 tools 哈希。只记工具名不记 description：description 会因参数微调
// 而变，但那不影响「工具在不在」这个判断维度，混进来会产生大量无意义告警。
const toolsWatch = { sig: '', count: 0 };

/**
 * 观察工具集合签名，变化时打一行 WARN 并列出工具名的增删。
 * 首次见到只记基线不告警。任何异常都吞掉，看门狗绝不允许影响请求本身。
 */
function watchToolset(tls) {
  try {
    if (!Array.isArray(tls)) return;
    const names = tls
      .map((t) => (t && t.function && t.function.name) || t?.name || '')
      .filter(Boolean)
      .sort();
    // 空集合直接跳过：可能是预热/裁剪阶段的中间态，也可能是异常输入。
    // 若把它当成「工具全没了」记进基线，下一次正常请求就会误报一次巨量变化。
    if (!names.length) return;
    const sig = names.join(',');
    if (sig === toolsWatch.sig) return;
    const prev = toolsWatch.sig;
    toolsWatch.sig = sig;
    const first = !prev;
    toolsWatch.count++;
    if (first) {
      logger.info('tools-watch', `基线：${names.length} 个工具 [${names.join(' ')}]`);
      return;
    }
    const before = new Set(prev.split(','));
    const after = new Set(sig.split(','));
    const added = names.filter((n) => !before.has(n));
    const removed = prev.split(',').filter((n) => n && !after.has(n));
    logger.warn(
      'tools-watch',
      `⚠️ 工具集合变化（第 ${toolsWatch.count} 次，${before.size} → ${after.size} 个）：` +
      `+[${added.join(' ')}] -[${removed.join(' ')}]。` +
      'tools 段排在 messages 之前，本次变化会让后续请求全量重算。' +
      '若涉及内置插件，通常是准入闸拦截导致 —— 请到「插件」页确认该模块已信任。'
    );
    } catch { /* 看门狗永不抛错 */ }
}

// ── user 消息分段指纹 ──────────────────────────────────────────────────
// req-fp 只有一个 msgs 整体哈希，只能告诉你"变了"，告诉不了你"哪一段变了"。
// 而 session 快照（systemPrompt/userPrompt）看不到插件注入段：钩子在快照
// 生成之后才改 messages：
//   - mem-layered 的七段注入（冲突提醒/待办/跨轮/重演/旧事/语义卡/旁听）
//   - sticker 的【可用表情包】
//   - keyword-reply 的【关键词自动回复（当前配置）】
// 实测 promptChars（= systemPrompt+userPrompt）≈ 25.5K，而日志里 prompt ≈
// 23,000 tok ≈ 57.5K 字符，差 32K 字符全在这类不可见段里。tools 段稳定（在最
// 前面）不产生 miss，所以嫌疑落在插件注入段上，尤其是那些被搬进【过去状态】
// 之前的段：它们一变，后面整段历史要连累重算。
//
// 做法：对最后一条 user 消息按 `\n\n【` 切段（buildUserPrompt 的
// parts.join('\n\n') 天然产生这个形态），逐段记「段头 + 长度 + 哈希」，
// 与上一次 real 请求逐段对比，任何一段哈希变了就打一行 WARN。
//
// 只记段头名与长度，不落正文，与 req-fp 同规格，不泄露聊天内容。也不做
// "每轮打全量指纹"：那会让日志涨几十倍，而诊断只需要「哪一段变了」这一个信息。
// 稳态时本函数一次 WARN 都不打。
const segWatch = { prev: null, tag: '' };

/** 取消息的纯文本（content 可能是 string，也可能是多模态 parts 数组）。 */
function msgText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => (p && typeof p === 'object' ? p.text ?? '' : String(p ?? ''))).join('');
  }
  return '';
}

/**
 * 记录并对比 user 消息的分段指纹。仅对 tag 以 'real' 开头的调用生效：
 * 预热（warm:shape）用的是另一个 body，对比它只会污染基线。
 */
function watchUserSegments(msgs, tag) {
  try {
    if (!String(tag || '').startsWith('real')) return;
    if (!Array.isArray(msgs) || !msgs.length) return;
    let target = null;
    for (const m of msgs) if (m && m.role === 'user') target = m;
    if (!target) return;
    const text = msgText(target.content);
    if (!text) return;

    const h = (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 8);
    // 按 \n\n【 切段；段头取到第一个】为止，无【 的开头归为「(角色设定)」。
    const parts = text.split('\n\n【');
    const segs = parts.map((p, i) => {
      const head = i === 0 ? '(首段)' : p.slice(0, p.indexOf('】') + 1);
      return { head, len: p.length, hash: h(p) };
    });
    const total = text.length;

    // 启动预热阶段会发一个只有首段的探针 body（用来确认 tools 能不能通），
    // 拿它当基线会让紧随其后的第一条正常请求报假「段结构变化」。
    // 判据：user 消息短到装不下完整提示词（真实段序至少 6 段、近万字符）。
    if (segs.length < 3 || total < 2000) return;

    const prev = segWatch.prev;
    // parts 一起留着：算"段内真正变了多少字节"要用原文（只看长度不够）。
    segWatch.prev = { segs, total, parts };
    if (!prev) {
      // 首轮只记基线：打印每段体积，装机后第一次就能看清提示词结构。
      logger.info(
        'seg-fp',
        `基线：user ${total} 字符 / ${segs.length} 段 → ` +
        segs.map((s) => `${s.head}:${s.len}B`).join(' ')
      );
      return;
    }
    // 段数或段头集合变了，说明提示词结构被改动（插件段增删），最严重。
    const prevHeads = prev.segs.map((s) => s.head).join('|');
    const curHeads = segs.map((s) => s.head).join('|');
    if (prevHeads !== curHeads) {
      logger.warn(
        'seg-fp',
        `⚠️ 提示词**段结构**变化：\n  旧: ${prevHeads}\n  新: ${curHeads}\n` +
        '段增删会让其后全部内容重算。若是插件注入段（如表情包/记忆）在' +
        '【过去状态】之前，请确认该段内容是否真的恒定。'
      );
      return;
    }
    // 结构一致，逐段比对哈希。
    const changed = [];
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].hash !== prev.segs[i].hash) {
        changed.push(`${segs[i].head} ${prev.segs[i].len}→${segs[i].len}B`);
      }
    }
    if (changed.length) {
      // 缓存断点 = 最早发生变化的那一段的段首。前缀缓存保留的是最长公共前缀，
      // 一旦某段变了，它后面的一切都算新内容，所以断点由「最早的变段」决定，
      // 与后面还有几段变无关。从后往前找未变段会算出"其后 0 段需重算"这种
      // 自相矛盾的输出。
      let fromIdx = segs.findIndex((s, i) => s.hash !== prev.segs[i].hash);
      if (fromIdx < 0) fromIdx = segs.length - 1;
      // 只计真的变了的字节：旧实现把变化段整段计入，但【过去状态】是尾部追加的
      // 滚动段，段内只动了最后 ~300B 却把整段 4,635B 报成"需重算"，比 cache-stat
      // 实测值虚高 4 倍。这里对首个变化段求段内 LCP，只计 LCP 之后的部分。
      const prevParts = prev.parts || prev.segs.map(() => '');
      let tailBytes = 0;
      let inSeg = 0;          // 首个变化段的段内 LCP：断点其实落在段内第几字
      for (let i = fromIdx; i < segs.length; i++) {
        if (i === fromIdx) {
          const a = String(prevParts[i] ?? '');
          const b = String(parts[i] ?? '');
          let k = 0;
          while (k < a.length && k < b.length && a[k] === b[k]) k++;
          inSeg = k;
          tailBytes += Math.max(0, b.length - k);
        } else {
          tailBytes += segs[i].len;
        }
      }
      const anchor = fromIdx > 0 ? segs[fromIdx - 1].head : '(无稳定段)';
      // tok 口径：本项目实测 15,088 字符 ≈ 14,819 tok（中文密集，约 1.02 字/tok），
      // 所以这里直接用字节数当 tok 数。
      logger.warn(
        'seg-fp',
        `⚠️ ${changed.length}/${segs.length} 段内容变化：${changed.join(' | ')}\n` +
        `  ⇒ 断点在【${segs[fromIdx].head}】段内第 ${inSeg} 字（段长 ${segs[fromIdx].len}，前一稳定段为【${anchor}】），` +
        `其后 ${segs.length - fromIdx} 段需重算（${tailBytes}B ≈${Math.round(tailBytes)}tok）` +
        (fromIdx === 0 ? '\n  ⚠️ 断点已推到最前 —— 检查是否有段被搬进稳定区却仍在变化。' : '')
      );
    }
  } catch { /* 永不抛错 */ }
}

// ── body 级 byte-LCP 观测 ───────────────────────────────────────────────
// watchUserSegments 只能告诉你「哪一段变了」，答不了「断点前到底有多少字节真的
// 命中了」。实测两者差着一个量级：seg-fp 算出的 Σ段增量 p50 = 188B（≈75 tok），
// 同一时刻 cache-stat 的 miss p50 = 596 tok，有约 500 tok 的全价字节不在任何
// user 分段里。
//
// 候选去处（都不在 user 消息分段内）：
//   ① systemPrompt（session 有快照，但 tools 之后的拼接方式未知）
//   ② tools 段的 description/parameters（watchToolset 只比对了工具名）
//   ③ media-cap 裁剪后 body 的整体重排
//
// 这里直接对整个 body 求与上一轮的字节 LCP，把差额一次性定位：
// LCP 落在 body 的哪个偏移、那里前后是什么。不猜。
const bodyLcp = { prev: null };

/**
 * 描述 body 里某个字符偏移所处的位置（粗粒度，够定位用）。
 *
 * 回看窗口必须覆盖整个前缀而不是固定 4000 字符：断点可能落在 messages 段很靠后
 * 的地方（实测能到 99%），固定窗口会看不到 `"messages":[` 标记，从而把一个明显
 * 在 messages 里的断点误报成「body 头部」。从串首扫一遍比开窗更简单。
 */
function offsetHint(s, off) {
  const before = s.slice(0, off);
  const last = (re) => {
    let m, r = null;
    while ((m = re.exec(before))) r = m;
    return r;
  };
  const msgIdx = last(/"messages":\[/g);
  const toolIdx = last(/"tools":\[/g);
  if (toolIdx && (!msgIdx || toolIdx.index > msgIdx.index)) {
    const seg = before.slice(toolIdx.index);
    const name = (seg.match(/"name":"([^"]+)"/g) || []).pop();
    return `tools 段${name ? `（最后一个工具定义 ${JSON.stringify(name).slice(0, 40)}）` : ''}`;
  }
  if (msgIdx) {
    const seg = before.slice(msgIdx.index);
    const role = (seg.match(/"role":"(system|user|assistant|tool)"/g) || []).pop();
    return `messages 段（断点前最后一个 role=${role || '?'}）`;
  }
  return 'body 头部（model/temperature 等标量字段）';
}

function watchBodyLcp(body, tag) {
  try {
    if (!String(tag || '').startsWith('real')) return;
    const s = JSON.stringify(body);
    const prev = bodyLcp.prev;
    bodyLcp.prev = s;
    if (prev === null) {
      logger.info('body-lcp', `基线：body ${s.length} 字符`);
      return;
    }
    if (s === prev) return;
    // 二分求最长公共前缀（两串都按字节切分，等价于 byte-LCP）。
    let lo = 0, hi = Math.min(prev.length, s.length);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prev.slice(0, mid) === s.slice(0, mid)) lo = mid; else hi = mid - 1;
    }
    // 断点之后若还有 tools 段，它通常完全命中（tools 指纹没变，watchToolset 会报
    // 变化）。把整段 tools 计进"断点后全价"会让估算虚高一个量级：实测报 5067tok，
    // 同一时刻 cache-stat 的真实 miss 只有 484tok。所以只算到 `"tools":[` 之前。
    const toolsAt = s.indexOf('"tools":[');
    const tailEnd = toolsAt > lo ? toolsAt : s.length;
    const tail = tailEnd - lo;
    const hint = offsetHint(s, lo);
    // 断点处取一小段上下文，便于肉眼确认「变的是什么」，只取 60 字符。
    // 识图请求的断点常落在 data:image/...;base64, 数据段里，60 字符的窗口会带出
    // 图片字节碎片落进日志文件（logs 会随排查/分享扩散），所以长 base64 串一律
    // 脱敏成占位符：定位「变的是哪一段」不需要图片内容本身。
    // 阈值取 16：JSON 键名/工具名都含下划线或不足长，段指纹/工具指纹 ≤12 位，不会误伤。
    const around = s.slice(Math.max(0, lo - 30), lo + 30).replace(/\s+/g, ' ')
      .replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (m) => `<base64:${m.length}B>`);
    logger.info(
      'body-lcp',
      `body ${prev.length}→${s.length} 字符  LCP=${lo} (${(lo / s.length * 100).toFixed(1)}%)  ` +
      `断点后全价=${tail}B ≈${Math.round(tail)}tok  位置=${hint}  附近="${around}"`
    );
  } catch { /* 永不抛错 */ }
}

/**
 * 解析某个提供商记录的 API 协议（「API 协议」下拉）。
 * 旧数据没有 apiProtocol 字段 → 'openai'，行为与从前一致。
 */
function protocolForProvider(cfg, providerId) {
  const pid = String(providerId ?? '').trim();
  if (!pid) return '';
  const p = (cfg?.providers || []).find((x) => x.id === pid);
  return normalizeProtocol(p?.apiProtocol || p?.api) === 'openai' ? '' : normalizeProtocol(p?.apiProtocol || p?.api);
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：当前选中的目录提供商的 Key > 顶层 api.apiKey。
 *
 * 顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个目录
 * 提供商，就该用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的 Key
 * 去请求 openrouter.ai」的情况，表现为全部会话 401 Missing Authentication。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromDsh = String(cfg?.dshProviderKeys?.[pid] ?? '').trim();
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  // protocol：当前选中提供商的 API 协议；空串 = openai（默认直通，与旧版为同一行为）
  return { ...cfg.api, apiKey: resolveApiKey(cfg), protocol: protocolForProvider(cfg, cfg.api?.provider) };
}

// ── 请求体媒体预算（一次内存事故的兜底）────────────────────────────────
// 群友发一张图之后，它的 base64 会常驻在会话历史里，后面每一轮都原样重发，
// 单请求体曾从常态 ~30KB 涨到 1,819,852 字符（60 倍）。主线程每次都要拼一份
// 1.8MB 的字符串再 JSON.stringify，多群并发时内存曲线直接顶上去。
//
// 策略：只在真的超预算时才动手，且从最早的媒体开始丢，保证"这次刚发的那张图"
// 一定还在，机器人的看图能力不受影响。被丢的那部分换成一句话占位符，模型仍能
// 知道"这里曾经有张图"，不会莫名失忆。
//
// 控制在 post() 里而不是改会话历史：历史序列的前缀是前缀缓存的命脉，一旦就地
// 改动就会污染后续所有请求。这里深拷贝后再发，绝不回写。
const MEDIA_CHAR_BUDGET = Number(process.env.QQ_AGENT_MEDIA_BUDGET) || 512 * 1024;

export function capRequestBodyMedia(body) {
  const none = { body, dropped: 0, before: 0, after: 0 };
  if (!body || !Array.isArray(body.messages)) return none;
  const items = [];
  let total = 0;
  for (let mi = 0; mi < body.messages.length; mi++) {
    const content = body.messages[mi]?.content;
    if (!Array.isArray(content)) continue;
    for (let pi = 0; pi < content.length; pi++) {
      const part = content[pi];
      if (!part || (part.type !== 'image_url' && part.type !== 'video_url')) continue;
      const url = String(part?.image_url?.url ?? part?.video_url?.url ?? '');
      if (!url) continue;
      total += url.length;
      items.push({ mi, pi, len: url.length });
    }
  }
  if (total <= MEDIA_CHAR_BUDGET || items.length === 0) return { body, dropped: 0, before: total, after: total };
  // 深拷贝：原对象属于调用方的会话历史，改它会把裁剪结果带回后续所有请求。
  const messages = JSON.parse(JSON.stringify(body.messages));
  let remaining = total;
  let dropped = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (remaining <= MEDIA_CHAR_BUDGET) break;
    // 最新那个媒体无论如何保留：本次对话要看的就是它，丢了机器人就"瞎了"。
    // 单张图本身就可能大于预算，一路丢到只剩文本会让用户刚发的那张也看不见。
    // 宁可让它超预算，也不能当着图说没看见。
    if (i === items.length - 1) break;
    const content = messages[it.mi]?.content;
    if (!Array.isArray(content)) continue;
    const wasVideo = content[it.pi]?.type === 'video_url';
    content[it.pi] = { type: 'text', text: wasVideo ? '[此处是较早的一张视频输入，因请求体超出预算已省略]' : '[此处是较早的一张图片输入，因请求体超出预算已省略]' };
    remaining -= it.len;
    dropped += 1;
  }
  return { body: { ...body, messages }, dropped, before: total, after: remaining };
}

/**
 * 按请求里的模态挑选专用模型。
 *
 * 设置页有「图片输入专用模型」和「视频输入专用模型」两个字段，允许用一个便宜的
 * 纯文本模型聊天、只在真的要看图/看视频时才切到贵的多模态模型。
 *
 * 扫描本次 messages：出现 video 部分就优先用 videoModel，出现图片部分就用
 * visionModel（视频优先，因为视频能同时包含图片部分）。
 *
 * 位置放在 effectiveApi 之后、只在主调用路径生效：
 *   · 记忆整理等显式传 overrides 的调用不受影响（它有自己指定的模型）
 *   · 备选模型降级也不受影响（overrides 已由候选序列给出）
 * 这样"切专用模型"不会意外覆盖用户明确指定的模型。
 */
function specializedModelFor(messages, cfg) {
  if (!Array.isArray(messages)) return '';
  let hasImage = false;
  let hasVideo = false;
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'video_url') hasVideo = true;
      else if (part?.type === 'image_url') hasImage = true;
      if (hasVideo) break;
    }
    if (hasVideo) break;
  }
  if (hasVideo) {
    const v = String(cfg?.api?.videoModel ?? '').trim();
    if (v) return v;
  }
  if (hasImage || hasVideo) {
    const v = String(cfg?.api?.visionModel ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * 解析某个提供商 id 对应的 { baseUrl, apiKey }。
 * 用于备选模型跨提供商切换：备选项指定了 provider 时，要用那个提供商的
 * baseUrl + Key 发请求，而不是主模型的。
 * 找不到该提供商时返回 null（调用方应跳过这个备选）。
 */
function resolveProviderEndpoint(providerId) {
  const cfg = getConfig();
  const pid = String(providerId ?? '').trim();
  if (!pid) return null;
  const p = (cfg.providers || []).find((x) => x.id === pid);
  if (!p || !String(p.baseURL ?? '').trim()) return null;
  const key = String(cfg.dshProviderKeys?.[pid] ?? p.apiKey ?? '').trim();
  return {
    baseUrl: String(p.baseURL).trim(),
    apiKey: key === '******' ? '' : key,
    // 备选模型切提供商时协议跟着走：Anthropic 提供商的备选必须仍走 Messages API
    protocol: normalizeProtocol(p.apiProtocol || p.api)
  };
}

/**
 * 构建"主模型 + 备选模型"的候选请求序列。
 * 第一项永远是当前主模型；之后按 api.fallbackModels 顺序追加。
 * 每项是一个可直接传给 chatCompletion 的 overrides 对象。
 */
function buildCandidateApis() {
  const cfg = getConfig();
  const main = effectiveApi();
  const candidates = [{ overrides: null, label: main.model || '(未设置模型)' }];   // null = 用 effectiveApi()
  const fallbacks = Array.isArray(cfg.api?.fallbackModels) ? cfg.api.fallbackModels : [];
  for (const fb of fallbacks) {
    const model = String(fb?.model ?? '').trim();
    if (!model) continue;
    const pid = String(fb?.provider ?? '').trim();
    if (pid) {
      const ep = resolveProviderEndpoint(pid);
      if (!ep) continue;   // 提供商不存在/无 baseUrl，跳过这个备选
      candidates.push({
        overrides: { ...main, ...ep, model, provider: pid },
        label: `${model} @ ${pid}`
      });
    } else {
      // 未指定 provider：沿用主模型的 baseUrl + Key，只换模型 id
      candidates.push({ overrides: { ...main, model }, label: model });
    }
  }
  return candidates;
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');

  // 请求已发出后的超时一律不重试。那种超时多半意味着"上游已计费、响应没回来"，
  // 重发等于重复计费。error.noRetry 由抛出方标记，优先于下面所有关键词规则。
  if (error?.noRetry === true) return false;

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障（408 请求超时同样值得退避重试一次）
  if (/HTTP\s*(5\d\d|408)/i.test(msg)) return true;                  // 5xx + 408
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 两层容错：
 *   1. 同模型重试：网络抖动/5xx/429 时，同一模型指数退避重试（1s→2s）。
 *   2. 备选模型降级：主模型重试后仍失败，且错误可重试时，
 *      逐个用 api.fallbackModels 里的备选模型重试，直到某个成功。
 *
 * 这里重试的是同一轮请求，messages 不变，所以是幂等的，不会造成重复发言。
 * 会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 每个端点最多额外重试几次（默认 2，即最多 3 次尝试）
 * @param {{ onAttempt?: (() => void) | null }} [opts] onAttempt 在每次真实尝试前回调。
 *   orchestrator 用它实时扣减"单次唤醒的请求预算"：按轮扣会低估 (1+重试)×(备选数) 倍。
 * @returns {Promise<{message, usage, raw, model, _usedModel, _usedApi}>}
 *   额外带 _usedModel（实际成功的模型 id）与 _usedApi（实际使用的端点配置），
 *   调用方据此同步 session.model / session.vendor，保证成本看板的「渠道:模型」同源。
 */
export async function chatCompletionWithRetry(args, retries = 2, { onAttempt = null } = {}) {
  const candidates = buildCandidateApis();
  let lastError = null;

  for (let ci = 0; ci < candidates.length; ci++) {
    const { overrides, label } = candidates[ci];
    // 主模型失败且要切备选时，先提示一次（让用户在日志里看到降级发生）
    if (ci > 0) {
      console.warn(`[llm] 主模型重试仍失败，切换到备选模型 ${ci}/${candidates.length - 1}：${label}`);
      try { logger.warn('llm', `主模型重试仍失败，切换备选模型 ${ci}/${candidates.length - 1}：${label}`); } catch { /* ignore */ }
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 外部已中断（如调用方的 AbortSignal）就别再发起注定失败的请求：
      // 曾经退避 sleep 期间不看中断，最多再白打一次 API（白花一份钱）
      if (args?.signal?.aborted) throw args.signal.reason ?? new Error('aborted');
      try {
        // M3：记账回调绝不允许影响请求本身（它只是计数器），异常一律吞掉
        try { onAttempt?.(); } catch { /* ignore */ }
        const r = await chatCompletion({ ...args, overrides });
        r._usedModel = r.model || (overrides?.model ?? getConfig().api?.model ?? '');
        // 把"这次实际用的端点"一并带回去：备选模型可能来自另一个 provider，
        // 调用方要据此同步 vendor，否则成本看板的「渠道：模型」聚合会串味。
        // 优先用 chatCompletion 内部记下的 _usedApi（它包含账号池挑中的端点），
        // 没有才退回 overrides / 主配置。
        r._usedApi = r._usedApi ?? overrides ?? getConfig().api;
        return r;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryableError(error)) break;   // 换下一个候选模型
        const wait = 1000 * Math.pow(2, attempt);   // 1s, 2s
        console.warn(`[llm] 请求失败（${label}，第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
        try { logger.warn('llm', `请求失败（${label}，第 ${attempt + 1} 次尝试），${wait}ms 后重试：${String(error?.message ?? error).slice(0, 300)}`); } catch { /* ignore */ }
        // 退避等待可被 signal 打断：中止时立刻抛出，不再等下一次注定失败的请求
        const signal = args?.signal ?? null;
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, wait);
          const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); };
          if (signal?.aborted) { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); return; }
          signal?.addEventListener?.('abort', onAbort, { once: true });
        });
      }
    }
    // 该候选的所有重试都失败了：只有错误可重试才值得试下一个备选；
    // 4xx（密钥错/参数错）换模型通常也没用，但备选可能用不同提供商，仍继续尝试。
  }
  throw lastError ?? new Error('模型请求失败（主模型与全部备选均不可用）');
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 *
 * Skill 扩展点（本函数只做"发送"，不实现任何厂商特有逻辑）：
 *   llm.request-params   在发请求前改写 body（如各家的 thinking/reasoning 参数）
 *   llm.response         在解析响应后加工结果（如提取 reasoning_content）
 *   llm.usage            额外统计 usage（如 reasoning tokens）
 *   llm.retry-advisor    请求被网关拒绝时，判断"去掉某些参数重发一次"是否值得
 *
 * 关键边界：Skill 不能自己发起请求或自己重试。超时、abort、重试次数、计费、
 * 日志、fallback 模型都必须留在这里，否则会出现"Skill 悄悄多打一次 API"这种
 * 既难发现又烧钱的问题。Skill 只能给函数（改 body / 给建议），重试动作由本函数执行。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, overrides = null, skillContext = null, maxTokens = 0, buildOnly = false, tag = 'call', sameBody = null, timeoutMs: timeoutMsOpt = 0 }) {
  const baseApi = overrides || effectiveApi();
  // 主调用路径才切"图片/视频专用模型"（见 specializedModelFor 注释）
  let api = baseApi;
  let poolAccountId = '';
  if (!overrides) {
    // 账号池（account-pool Skill）：在主调用路径上挑一个端点。每次真实请求都
    // 重新挑，所以多轮对话里自然轮转，而不是整轮锁死一个端点。池子为空 / 全部
    // 冷却时返回 null，行为与没有这个 Skill 时完全一致。备选模型降级路径
    // （overrides 非空）刻意不走池：那些候选是用户显式排队指定的。
    try {
      for (const p of skillManager.getCapabilityProviders('llm.endpoint-pick', {})) {
        const picked = p.fn({ model: baseApi.model });
        if (picked?.baseUrl) {
          poolAccountId = picked.id || '';
          api = {
            ...baseApi,
            baseUrl: picked.baseUrl,
            apiKey: picked.apiKey || baseApi.apiKey,
            model: picked.model || baseApi.model
          };
        }
        break;
      }
    } catch (error) {
      skillManager.recordError('account-pool', error);
    }
    const forced = specializedModelFor(messages, getConfig());
    if (forced && forced !== api.model) api = { ...api, model: forced };
  }
  const ctx = skillContext || { api, model: api.model, messages };

  // API 协议优先级：overrides 显式带的（备选模型切提供商时由
  // resolveProviderEndpoint 填入）> api.provider 对应提供商记录的 > 当前选中
  // 主提供商的 > openai。这样记忆整理等只传 {baseUrl, apiKey, model} 的
  // overrides 也不会用错协议。
  const cfgForProto = getConfig();
  const proto = normalizeProtocol(
    api.protocol
    || protocolForProvider(cfgForProto, api.provider)
    || protocolForProvider(cfgForProto, cfgForProto.api?.provider)
    || 'openai'
  );

  const buildBaseBody = () => {
    const body = {
      model: api.model,
      messages,
      stream: false
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    // maxTokens：限制输出长度。判分类请求（如回复安全网的裁判）必须限制，
    // 否则"会思考"的模型会把预算全用在 reasoning 上，正文为空或 JSON 被截断。
    const mt = Number(maxTokens) || 0;
    if (mt > 0) body.max_tokens = Math.floor(mt);
    return body;
  };
  const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;

  // 让 Skill 改写请求体。转换器串行，后者看到前者的输出；
  // 任何一个转换器抛错只记日志并跳过（不能因为 Skill 坏了就发不出请求）。
  const applyRequestTransforms = async (base) => {
    let body = base;
    // 记录"因为与思考参数互斥而被删掉的 temperature"，降级时好还原。不记录的话，
    // 降级路径会永久丢掉用户设的采样温度，表现为"偶尔回复风格突变"，很难复现。
    let removedTemperature;
    // 取器本身也要 try：原实现只隔离了每个 fn() 的抛错，取器
    // （getRequestTransforms）抛错时会从下方 await 那行直接上窜，跳过 cleanup()
    // 泄漏一个最长 180s 的 AbortController 定时器 + 堆在会话级 signal 上的 abort
    // 监听器（Node 默认上限 10）。取不到转换器就按"没有转换"继续。
    let transforms;
    try {
      transforms = skillManager.getRequestTransforms(ctx) || [];
    } catch (error) {
      skillManager.recordError('llm.request-transforms', error);
      return { body, removedTemperature };
    }
    for (const fn of transforms) {
      try {
        const next = await fn({ body, api, model: api.model, messages, tools, temperature: temp, context: ctx });
        if (!next || typeof next !== 'object') continue;
        body = next.body || next;
        // 思考模式与 temperature 在部分厂商互斥（OpenAI o 系、DeepSeek 思考），
        // Skill 只能"声明互斥"，删字段这个动作留在核心做，避免 Skill 意外删掉别的键。
        if (next.omitTemperature && body.temperature !== undefined) {
          removedTemperature = body.temperature;
          delete body.temperature;
        }
      } catch (error) {
        skillManager.recordError('llm.request-params', error);
      }
    }
    return { body, removedTemperature };
  };

  const startedAt = Date.now();
  const controller = new AbortController();
  // timeoutMs 入参优先于 api.timeoutMs（预热用：服务端饱和时预热请求排队 90-180s
  // 会一直占着上游并发位，把限流越滚越紧；预热宁可早断）。下限 5s。
  const timeoutMs = Math.max(5000, Number(timeoutMsOpt) || Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  // 外层 abort 监听必须持有句柄并在所有出口统一摘掉。若只靠 once，它只在真的
  // abort 时才移除监听器，正常跑完的请求会把它永久留在会话 signal 上：
  // orchestrator 一轮会话把同一个 signal 复用 12 次、每次最多 3 个候选 × 3 次尝试，
  // 一次完整会话最高 108 个监听器堆在同一个 AbortSignal 上（Node 默认上限 10）。
  let onOuterAbort = null;
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else {
      onOuterAbort = () => controller.abort(signal.reason ?? new Error('aborted'));
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }
  /** 所有出口统一收口：清定时器 + 摘监听器（buildOnly 分支也必须走，否则每次预热漏一个 180s 定时器）。 */
  const cleanup = () => {
    clearTimeout(timer);
    if (onOuterAbort && signal) { try { signal.removeEventListener('abort', onOuterAbort); } catch { /* ignore */ } }
  };
  /**
   * 本次请求是否已经发出。超时发生在发出之后时，重试等于重复计费
   * （上游可能已生成完毕、账单已记，只是响应没回来）。见 isRetryableError。
   */
  let requestSent = false;

  /**
   * 失败留痕：打包版没有终端，重试警告只走 console 等于不存在；用户报"超时/
   * 没反应"时，日志里能自证"请求发没发出、卡在哪一步"。只记一行、截 300 字符；
   * 任何异常都吞掉，日志绝不允许影响请求本身。
   */
  const logFailure = (msg) => { try { logger.warn('llm', `[${tag}] ${String(msg).slice(0, 300)}`); } catch { /* ignore */ } };

  /** 发一次请求。返回 { ok, status, text, headers }，网络层错误直接抛。 */
  const post = async (rawBody) => {
    // 发之前先看一眼体重要不要减：超预算时丢掉最早的历史媒体。
    const cap = capRequestBodyMedia(rawBody);
    const body = cap.body;
    if (cap.dropped > 0) {
      logger.info('media-cap', `请求体超预算，已省略 ${cap.dropped} 个较早的媒体：${cap.before} → ${cap.after} 字符（预算 ${MEDIA_CHAR_BUDGET}）`);
    }
    // 请求指纹：核心请求体的逐字节一致性是前缀缓存的全部前提。此前只能靠"命中
    // 多少 tok"反推是否一致，属于黑盒猜谜。这里把真正要发出去的 body 摘要成一行
    // 日志，让"预热发的"与"真实发的"可以直比：
    //   msgs / tools 分开哈希：若 msgs 同而 cached 不同，说明差异不在消息里；
    //   若 msgs 哈希不同，直接说明前缀漂移。
    // 只记 sha1 与长度，不落任何正文，排障面板与日志都不会泄露聊天内容。
    let fp = '';
    try {
      watchToolset(Array.isArray(body.tools) ? body.tools : null);
      watchUserSegments(Array.isArray(body.messages) ? body.messages : null, tag);
      watchBodyLcp(body, tag);
      const h = (v) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 10);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const tls = Array.isArray(body.tools) ? body.tools : [];
      // 采样参数单独列出：它们与缓存键的因果关系最容易被人反复怀疑（已排除，留证）。
      const tempStr = body.temperature === undefined ? 'omit' : String(body.temperature);
      fp = `${h(JSON.stringify(msgs))} msgs=${msgs.length} tools=${tls.length}/${h(JSON.stringify(tls))} temp=${tempStr} mt=${body.max_tokens ?? 0} model=${body.model ?? api.model ?? ''} chars=${JSON.stringify(body).length}`;
    } catch { fp = '(指纹计算失败)'; }
    requestSent = true;
    // 协议翻译在发送边界完成：body（内部恒为 OpenAI 形态）→ 目标协议的 URL/headers/body。
    // openai 协议下 built.body 就是原 body 本身，线上字节与旧版完全一致。
    const built = buildProtocolRequest(proto, {
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      openaiBody: body,
      extraHeaders: authHeaders(api.apiKey, api.baseUrl, api.model)
    });
    const res = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: controller.signal,
      // 网络代理：配置了 api.proxy 时走本机代理接入国外 API；
      // dispatcherFor() 未配置时返回 undefined，fetch 按直连发出，行为不变。
      dispatcher: dispatcherFor()
    });
    logger.info('req-fp', `[${tag}] status=${res.status} ${fp}`);
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') || '' };
  };

  const baseBody = buildBaseBody();
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) baseBody.temperature = Number(temp);
  const transformed = await applyRequestTransforms(baseBody);
  let body = transformed.body;
  const removedTemperature = transformed.removedTemperature;

  // 原样发出（供前缀缓存预热使用）。与 buildOnly 的区别：buildOnly 只是"构造好
  // 交出去"，真正的发送仍会走 buildBaseBody + applyRequestTransforms 再算一遍，
  // 调用方哪怕只是把 temperature 写成 0、maxTokens 写成 1，得到的也是另一个 body：
  // 预热与真实调用各占一个缓存档位、互相驱逐，真实调用依然打不中。
  // sameBody 让调用方直接交出最终 body，这里逐字节发送，不再重构。
  if (sameBody && sameBody.messages) {
    // 必须拷贝：直传引用的话，下面 `body.max_tokens = …` 会改掉调用方持有的那个
    // 对象。预热复用的正是 cache-warm 里那份 lastRealBody，一旦被写上
    // max_tokens=1，之后每次真实调用都会带着只剩 1 个 token 的输出上限，
    // 表现为机器人突然只说半句话。拷贝一次，代价可忽略。
    body = JSON.parse(JSON.stringify(sameBody));
    if (Number(maxTokens) > 0) body.max_tokens = Math.floor(Number(maxTokens));
  }

  // 只构造、不发送（供前缀缓存预热使用）。为什么必须走这里而不是在预热模块里
  // 自己拼 body：上面这段会改变实际发出的请求：
  //   ① llm.endpoint-pick（账号池）：真实请求每次都重新挑端点
  //   ② specializedModelFor：满足条件时切到图片/视频专用模型
  // 预热若自己拼 body，就会打到另一个端点/另一个模型上，缓存键不同，缓存写进了
  // 别处，真实调用自然读不到。所以预热必须复用真实调用同一份 body 与同一个 api。
  if (buildOnly) { cleanup(); return { body, api, model: api.model, baseBody }; }

  let res;
  try {
    res = await post(body);
  } catch (error) {
    cleanup();
    // 网络/超时失败也要回报账号池（只报 HTTP 失败的话，死端点永远不冷却，调度反复踩坑）
    if (poolAccountId) {
      reportPoolFeedback({ accountId: poolAccountId, ok: false, status: 0, error: String(error?.cause?.message ?? error?.message ?? error).slice(0, 300) });
    }
    // 外部 signal 中止（会话级「中止」按钮）：controller.abort(signal.reason) 的
    // reason 会成为 error.cause，必须原样上抛（消息含"中止"），isRetryableError
    // 才能判为不可重试、会话才会立刻收尾而不是再打下一发。
    // 不能走下面的"AbortError → 模型请求超时"分支：那条文案会被当成可重试的超时。
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    // 判据必须是 `error === controller.signal.reason`，只判 name 永远不成立。
    // 实测（Node 22 / undici）：`controller.abort(new Error('请求超时'))` 之后，
    // fetch 抛出的就是那个 reason 对象本身，`error.name === 'Error'`，而不是
    // 'AbortError'（只有 abort() 不带 reason 时才得到 AbortError）。只判 name
    // 会让这段分支变成死代码，超时仍走"模型请求失败"被当成可重试，重复计费。
    const isOwnTimeout = error === controller.signal.reason || error?.name === 'AbortError';
    if (isOwnTimeout) {
      // 已发出之后的超时不自动重试：典型成因是「上游已开始生成、账单已记，只是
      // 响应没在 timeoutMs 内回来」，原样重发等于同一份 prompt 再付一遍。
      // 连接未建立就失败（requestSent=false）仍然可重试，那时上游根本没开始算。
      const e = new Error(requestSent
        ? `模型请求超时（${timeoutMs}ms，请求已发出，可能已被上游计费，未自动重试以避免重复计费）`
        : `模型请求超时（${timeoutMs}ms）`);
      e.afterSend = requestSent;
      e.noRetry = requestSent;
      logFailure(`${e.message}（requestSent=${requestSent}）`);
      throw e;
    }
    const wrapped = new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    logFailure(wrapped.message);
    throw wrapped;
  }

  // 参数被网关拒绝时的一次性降级重试：Skill 加上了 thinking/reasoning 参数，
  // 但该网关/模型不认（400/422）。由 Skill 通过 llm.retry-advisor 给建议，
  // 重试动作仍然在这里执行，所以超时预算、abort、日志、计费口径都不变。
  let degradeNote = null;
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const retry = await withoutRejectedParams(body, res.text, ctx, res.status);
    if (retry) {
      degradeNote = retry.reason || '网关拒绝扩展参数，已去掉后重试';
      // 思考参数被摘掉后，"与 temperature 互斥"的前提就不成立了，
      // 把用户原本设置的温度还回去，让降级路径等价于"该 Skill 从未生效"。
      if (removedTemperature !== undefined && retry.body.temperature === undefined) {
        retry.body.temperature = removedTemperature;
      }
      try {
        res = await post(retry.body);
      } catch (error) {
        cleanup();
        // 降级重试的网络失败同样回报账号池
        if (poolAccountId) {
          reportPoolFeedback({ accountId: poolAccountId, ok: false, status: 0, error: String(error?.cause?.message ?? error?.message ?? error).slice(0, 300) });
        }
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        // 同上面的超时判据：必须比对象本身，不能只比 name
        if (error === controller.signal.reason || error?.name === 'AbortError') {
          const e = new Error(requestSent
            ? `模型请求超时（${timeoutMs}ms，请求已发出，可能已被上游计费，未自动重试以避免重复计费）`
            : `模型请求超时（${timeoutMs}ms）`);
          e.noRetry = requestSent;
          logFailure(`${e.message}（降级重试路径，requestSent=${requestSent}）`);
          throw e;
        }
        const wrapped = new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
        logFailure(wrapped.message);
        throw wrapped;
      }
    }
  }
  cleanup();

  if (!res.ok) {
    // 回报账号池：失败要降权，限流还要冷却
    if (poolAccountId) {
      reportPoolFeedback({ accountId: poolAccountId, ok: false, status: res.status, error: res.text.slice(0, 300) });
    }
    // 上下文超限要给可操作的诊断。这类 400 此前被原样抛出，isRetryableError 判为
    // 不可重试，会话直接 error，用户只看到一大段英文 API 报错，且无任何自愈路径
    // （retrySession 在发过消息后被拒），只能改配置重启。而它的唯一成因是"本次
    // 提示词太长"，那是可以在提示词层面直接调的量。
    if (res.status === 400 && /context[_ ]length|maximum context|too many tokens|reduce the length|上下文超|超出.*上限/i.test(res.text)) {
      const chars = (() => { try { return JSON.stringify(body).length; } catch { return 0; } })();
      const e = new Error(
        `上下文超出模型上限（${api.model || '当前模型'}）：本次请求体约 ${(chars / 1024).toFixed(0)}K 字符 / ${messages.length} 条消息。`
        + '请调小「全部响应」档的历史条数（设置 → 聊天 →「⚡ 活跃设置」→「⚙ 档位设置」→ ④ 其余情况），或关闭图片输入、'
        + '减少启用中的 Skill 提示词片段。原始错误：' + res.text.slice(0, 200)
      );
      e.code = 'context_length_exceeded';
      logFailure(e.message);
      throw e;
    }
    logFailure(`模型 API HTTP ${res.status}：${res.text.slice(0, 300)}`);
    // HTTP 错误本地化：error-l10n.js 的规则（429/401/402/5xx/模型不存在/接口地址错
    // 等全都有中文「原因 + 怎么办」）此前从未被调用，用户实际看到的一直是
    // "模型 API HTTP 429: {"error":...}" 这种英文原文。
    // · err.human = {title, what, fix, target} → orchestrator 挂到 session.errorHuman，
    //   前端详情页渲染成中文解释卡片（前端早就按这个契约写好了）。
    // · message 前置中文标题：日志、QQ 提示、老前端等只读 message 的路径也能看懂；
    //   技术原文完整保留在后面，isRetryableError 的 /HTTP 429|rate limit|quota/ 照常匹配。
    const err = new Error(`模型 API HTTP ${res.status}：${res.text.slice(0, 500)}`);
    err.status = res.status;
    annotateApiError(err, { status: res.status, text: res.text, model: api.model });
    if (err.human?.title) err.message = `${err.human.title}\n${err.message}`;
    throw err;
  }

  // "返回了无法解析的 JSON"根因治理：中转站/网关在高负载或流式截断时，会返回
  // 非 JSON 的响应体（空串、HTML 错误页、或被截断的半截 JSON）。res.json() 直接抛
  // SyntaxError，上层只看到一句"无法解析的 JSON"，完全不知道实际收到了什么。
  // 所以先读原文，尝试解析；失败时把实际收到的内容摘要（前 200 字符 + 内容类型 +
  // 长度）写进错误，便于定位是网关返回了 HTML、空响应还是截断。
  const rawText = res.text;
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    // 坏响应（HTML 错误页/空体/截断）是典型坏端点信号，同样回报账号池
    if (poolAccountId) {
      reportPoolFeedback({ accountId: poolAccountId, ok: false, status: res.status, error: 'JSON 解析失败（坏响应体）' });
    }
    const preview = rawText.replace(/\s+/g, ' ').trim().slice(0, 200);
    const looksLikeHtml = /^\s*</.test(rawText);
    const hint = !rawText.trim()
      ? '响应体为空（网关可能提前断流）'
      : looksLikeHtml
        ? '响应是 HTML 而非 JSON（可能是网关错误页/鉴权页）'
        : '响应不是合法 JSON（可能被截断）';
    const parseFail = new Error(`模型 API 返回了无法解析的 JSON：${hint}。content-type=${res.contentType || '未知'}，长度=${rawText.length}，内容预览：${preview || '（空）'}`);
    logFailure(parseFail.message);
    throw parseFail;
  }
  // 协议归一：openai 直通原样；anthropic/google/responses 翻译成 OpenAI 形态的
  // {choices, usage, model}，下游（工具调用执行、usage 统计、成本估算）零改动。
  const norm = parseProtocolResponse(proto, data, api.model);
  const choice = norm?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);

  const result = {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: norm.usage ?? data.usage ?? null,
    model: norm.model ?? data.model ?? api.model,
    raw: data,
    // 本次请求是否因为参数被拒而走了降级路径（UI/排障可见）
    degraded: Boolean(degradeNote),
    degradeNote,
    // 把实际使用的端点带出去：账号池可能在 endpoint-pick 里把 api 换成了池中
    // 挑中的端点。chatCompletionWithRetry 若只用 `overrides ?? 主配置` 回填
    // _usedApi，"池子挑了非主端点"的调用会被记到主渠道名下，成本看板按渠道
    // 拆分时串味（model 本身是对的）。
    _usedApi: api
  };

  // 响应加工：让 Skill 提取 reasoning、补统计等。同样是错误隔离 + 串行。
  await applyResultTransforms(result, ctx);
  // 回报账号池：这次用了哪个端点、耗时多少（用于动态调权）
  if (poolAccountId) {
    reportPoolFeedback({ accountId: poolAccountId, ok: true, latencyMs: Date.now() - startedAt });
  }
  return result;
}

/**
 * 回报账号池一次调用的结果（成功延迟 / 失败原因）。
 *
 * 单独抽成函数是因为它有两个调用点，而且必须错误隔离：账号池统计坏了绝不能影响
 * 模型调用本身：统计丢了只是调度不够聪明，而抛错会直接让整轮对话失败，
 * 代价完全不对等。
 */
function reportPoolFeedback(payload) {
  try {
    for (const p of skillManager.getCapabilityProviders('llm.endpoint-feedback', {})) {
      p.fn(payload);
      break;
    }
  } catch (error) {
    skillManager.recordError('account-pool', error);
  }
}

/** 依次执行 llm.response / llm.usage 转换器（错误隔离）。 */
async function applyResultTransforms(result, ctx) {
  // 取器本身也要包 try，与请求侧对称。getResponseTransforms / getUsageTransforms
  // 内部会遍历 Skill 的 isActive（热重载竞态 / Skill 自身抛错都可能把它们带崩），
  // 而这里一旦抛错，一个已经计过费的成功响应会被整条丢弃并向上冒泡，触发会话级
  // 重试/备选模型，白花钱还可能把会话记成 error。转换器失败只该降级成"没有转换"。
  let responseTransforms = [];
  try { responseTransforms = skillManager.getResponseTransforms(ctx) || []; } catch (error) {
    skillManager.recordError('llm.response', error);
  }
  for (const fn of responseTransforms) {
    try {
      const next = await fn({ result, ...ctx });
      if (next && typeof next === 'object' && next.result) Object.assign(result, next.result);
    } catch (error) {
      skillManager.recordError('llm.response', error);
    }
  }
  // reasoning tokens 这类附加统计：写进 result.extraUsage，由 orchestrator 决定怎么累加
  const extra = {};
  let hasExtra = false;
  let usageTransforms = [];
  try { usageTransforms = skillManager.getUsageTransforms(ctx) || []; } catch (error) {
    skillManager.recordError('llm.usage', error);
  }
  for (const fn of usageTransforms) {
    try {
      const add = await fn({ result, usage: result.usage, ...ctx });
      if (add && typeof add === 'object') {
        for (const [k, v] of Object.entries(add)) {
          const n = Number(v) || 0;
          if (n) { extra[k] = (extra[k] || 0) + n; hasExtra = true; }
        }
      }
    } catch (error) {
      skillManager.recordError('llm.usage', error);
    }
  }
  if (hasExtra) result.extraUsage = extra;
}

/**
 * 询问 Skill 是否应该"去掉被拒参数后重试一次"。
 * 返回 { body, reason } 或 null（不重试）。
 *
 * 只询问一次、只重试一次：避免参数互斥时来回重试把配额烧穿。
 */
async function withoutRejectedParams(body, errorText, ctx, status = 400) {
  // 同 applyRequestTransforms：取器抛错不能让降级重试路径炸掉（会跳过 llm 主流程
  // 的 cleanup，泄漏定时器/监听器）。取不到建议就按"不降级"返回，调用方按原响应继续。
  let advisors;
  try {
    advisors = skillManager.getRetryAdvisors(ctx) || [];
  } catch (error) {
    skillManager.recordError('llm.retry-advisor', error);
    return null;
  }
  for (const { fn, skillId } of advisors) {
    try {
      // 把真实状态码传下去：不同顾问关心的码不同
      // （思考参数只看 400/422，图片兼容还要看 415）。
      // 顾问返回 null 表示"这个错误不归我管"，继续问下一个。
      const r = await fn({ body, errorText, status, ...ctx });
      if (!r) continue;
      if (r.body && typeof r.body === 'object') {
        return { body: r.body, reason: String(r.reason || `已按 ${skillId} 建议降级重试`) };
      }
    } catch (error) {
      skillManager.recordError(skillId, error);
    }
  }
  return null;
}

/** 获取模型列表（按当前提供商的 API 协议拉 /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const proto = normalizeProtocol(cfg.protocol);
  const { url, headers } = protocolModelsRequest(proto, cfg.baseUrl, cfg.apiKey);
  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
      dispatcher: dispatcherFor()   // 网络代理：与对话请求同一条通道
    });
  } catch (error) {
    // 与 providers.fetchModelsFrom 同源诊断：裸抛 "fetch failed" 对用户毫无用处
    throw new Error(describeNetError(error, url));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 401 || res.status === 403
      ? '\n· 密钥被拒：检查当前选中提供商的 Key'
      : res.status === 404
        ? '\n· 404：该端点可能没有 /models 接口，改用「模型管理」手动添加模型'
        : '';
    throw new Error(`获取模型列表失败：HTTP ${res.status} ${res.statusText || ''}\n`
      + `请求地址：${url}${text ? `\n服务端返回：${previewBody(text)}` : ''}${hint}`);
  }
  const raw = await res.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('端点返回的不是 JSON（可能是反向代理页面或错误端口）：\n'
      + `请求地址：${url}\n响应开头：${previewBody(raw, 160)}`);
  }
  // 优先按协议解析（anthropic/google 形状不同）；解析不出再走 OpenAI 兼容兜底
  const byProto = parseProtocolModels(proto, data);
  if (byProto.length) return byProto.map((id) => ({ id }));
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）：中转站会在
 * usage.prompt_tokens_details.cached_tokens 里返回它，成本看板与缓存命中率统计都依赖这个数。
 */
// 缓存字段"缺字段"与"真 0 命中"必须分开看：实测有 6 次调用在同一群上一次成功
// 命中 14000+ tok 之后 7~600 秒就报 cached=0，而 system/tools 字节完全一致，
// 那种 0 不可能是真的失效，更像上游某条返回路径没带这个字段。缺字段时仍按 0 计
// （不能虚报命中率），但打一行日志把原始 usage 摊开，下次再出现就能分辨。
let cacheFieldWarned = 0;
const CACHE_FIELD_WARN_MAX = 20;
function usageHasCacheField(usage) {
  if (!usage || typeof usage !== 'object') return false;
  const d = usage.prompt_tokens_details;
  return Boolean(
    (d && typeof d === 'object' && 'cached_tokens' in d)
    || 'prompt_cache_hit_tokens' in usage
    || 'cached_tokens' in usage
  );
}

export function addUsage(target, usage) {
  if (!usage) return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  // 各家返回路径不同，逐个兼容
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0;
  if (prompt >= 8000 && !usageHasCacheField(usage) && cacheFieldWarned < CACHE_FIELD_WARN_MAX) {
    cacheFieldWarned += 1;
    let raw = '';
    try { raw = JSON.stringify(usage).slice(0, 400); } catch { raw = String(usage).slice(0, 400); }
    logger.warn('cache-stat', `上游 usage 里没有缓存字段（按 0 计，prompt=${prompt}）：${raw}`);
  }
  target.cachedTokens = (Number(target.cachedTokens) || 0) + (Number(cached) || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}

/**
 * 按配置单价折算成本（元）。
 *
 * 三种单价来源：
 *   1. useOfficialPrice=true 且模型 id 在内置价格表里 → 用官方价（缓存部分单独计价）
 *   2. 否则用用户手填的 priceInputPerM / priceOutputPerM / priceCachedPerM
 *   3. 都没有 → 0（不估算）
 *
 * 缓存命中部分优先走 cached 单价；官方价里 cached 为 null 时（该模型无缓存优惠）
 * 退回按普通输入价计算。
 *
 * 峰谷分时：opts.at 传调用时刻（毫秒时间戳）时，对支持分时的厂商（DeepSeek）
 * 按该时刻自动取高峰价或闲时价。不传 at 则按闲时计价（保守估值，会偏低）。
 * 历史统计请看 sumCostByTime()，它按每条记录的时刻分别计价后汇总，更准。
 */
export function estimateCost(usage, opts = {}) {
  const cfg = effectiveApi();
  // 成本只与"实际调用的模型"有关。opts.model 优先（统计时逐条传入各自的模型），
  // 不传才回退到当前选中的模型。
  const model = String(opts.model ?? cfg.model ?? '');

  const promptTokens = Number(usage?.promptTokens) || 0;
  const completionTokens = Number(usage?.completionTokens) || 0;
  const cachedTokens = Math.min(Number(usage?.cachedTokens) || 0, promptTokens);
  // 未命中缓存的输入 = 总输入 - 命中部分
  const freshTokens = Math.max(0, promptTokens - cachedTokens);

  // 统一走 resolveModelPrice：自定义 > 内置官方表 > 全局兜底。
  // 第二个参数要传完整配置对象（内部读 cfg.api.*），传 effectiveApi() 的返回值
  // （它就是 api 本身）会导致取不到字段。
  const p = resolveModelPrice(model, getConfig());

  // 峰谷：传了 at（调用时刻）且该模型有 peak 档位就取对应档
  const tier = p.peak && opts.at ? priceAt(p, opts.at) : null;
  const inPrice = tier ? tier.in : p.in;
  const outPrice = tier ? tier.out : p.out;
  const cachedPrice = tier ? tier.cached : p.cached;

  const source = p.source;
  const matched = p.matched;
  const peak = Boolean(tier?.peak);
  const hasPeakTiers = Boolean(p.peak);

  const cost =
    (freshTokens / 1_000_000) * inPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outPrice;

  return {
    cost,
    source,
    breakdown: {
      fresh: (freshTokens / 1_000_000) * inPrice,
      cached: (cachedTokens / 1_000_000) * cachedPrice,
      output: (completionTokens / 1_000_000) * outPrice
    },
    prices: { in: inPrice, out: outPrice, cached: cachedPrice },
    matched,
    // 峰谷信息：hasPeakTiers 表示这个模型是否分时段计价
    peak,
    hasPeakTiers
  };
}
