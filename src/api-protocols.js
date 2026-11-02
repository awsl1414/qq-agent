// API 协议适配层（2026-10-19）——「API 协议」下拉的下半场。
//
// 为什么单独一个模块：llm.js 已经 1180 行，而且它内部的一切（工具调用、
// Skill 请求改写、前缀缓存指纹、媒体预算、sameBody 预热）都建立在
// **OpenAI 形态**的 body 上。本模块的职责是把边界收窄到"发出去/收回来"两刻：
//
//   发送前：OpenAI 形态 body  →  buildProtocolRequest()  →  目标协议的 URL/headers/body
//   收到后：目标协议的 JSON   →  parseProtocolResponse() →  OpenAI 形态 {choices, usage, model}
//
// 这样 llm.js 的其余机制一字不改：Skill 改写的仍是 OpenAI 形态（各家中转站
// 的思考参数本来就按 OpenAI 兼容网关设计）、req-fp / body-lcp / media-cap
// 看到的仍是同一份 body，sameBody 逐字节预热照旧成立 —— 同一份 OpenAI body
// 经本模块的确定性翻译，落到线上仍是逐字节一致的请求。
//
// 支持的协议：
//   openai           OpenAI Chat Completions（现状，逐字节直通）
//   openai-responses OpenAI Responses API（/responses，DeepSeek 等也在用）
//   anthropic        Anthropic Messages API（x-api-key + content blocks）
//   google           Google Gemini generateContent（functionCall/functionResponse）
//   mistral          Mistral 官方 API（本身就是 OpenAI 兼容格式，仅默认端点不同）
//
// 注意：此项"不总是和模型相关联"——多数中转站（A6API 等）对各家模型都提供
// OpenAI 兼容协议，默认 openai 即可；只有直连官方端点或明确要求原生协议时才需要换。

// ── 协议目录 ────────────────────────────────────────────────────────────────

export const API_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI (Chat Completions)' },
  { id: 'openai-responses', label: 'OpenAI (Responses API)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'mistral', label: 'Mistral' }
];

// 未填 Base URL 时的官方默认端点（openai 不给默认：手动模式历来必须手填）。
export const PROTOCOL_DEFAULT_BASES = {
  openai: '',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1'
};

const KNOWN = new Set(API_PROTOCOLS.map((p) => p.id));

/** 任意历史值 → 合法协议 id（providers[].api 可能是 'openai'，anthropic 类旧值回落 openai）。 */
export function normalizeProtocol(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (KNOWN.has(s)) return s;
  // DSH 导入时 api: anthropic-messages 的旧值：当初按 OpenAI 兼容调用，维持该口径
  return 'openai';
}

export function protocolLabel(id) {
  return API_PROTOCOLS.find((p) => p.id === normalizeProtocol(id))?.label || 'OpenAI (Chat Completions)';
}

/** openai 家族（Chat Completions / Responses / Mistral）——鉴权与 /models 同一套。 */
export function isOpenAiFamily(proto) {
  return proto === 'openai' || proto === 'openai-responses' || proto === 'mistral';
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** 取消息的纯文本（content 可能是 string，也可能是多模态 parts 数组）。 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' ? p.text ?? '' : String(p ?? ''))).join('');
  }
  return '';
}

/** data:image/png;base64,xxx → { mediaType, data }；非 data URL 返回 null。 */
function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

/** Anthropic 官方端点要求 /v1 前缀：仅对"裸域名"自动补 /v1，写明路径的信任用户。 */
function anthroBase(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return PROTOCOL_DEFAULT_BASES.anthropic;
  if (/\/v\d+$/.test(base)) return base;
  try {
    const u = new URL(base);
    if (u.pathname === '' || u.pathname === '/') return `${base}/v1`;
  } catch { /* 非法 URL 交给 fetch 报错 */ }
  return base;
}

// ── 请求侧：OpenAI 形态 → 目标协议 ──────────────────────────────────────────

/**
 * OpenAI 家族的鉴权头。**必须由这里统一给**，不能只靠调用方的 extraHeaders：
 * 2026-10-20 修 —— 此前 buildProtocolRequest 对 openai/openai-responses/mistral
 * 只吐 content-type，Authorization 由 llm.js 的 authHeaders() 经 extraHeaders 注入。
 * 于是「测试连通性」（providers.js → testModelChat，只传了 opencode 路由头）发出去的
 * 是一个**没有任何鉴权信息的请求**，任何 OpenAI 兼容端点都会回 401 —— 用户看到的
 * 是"所有配置都对，测试却报 401"，看起来像 Key 填错了，实际是头根本没带。
 * 顺序：先鉴权、后 extraHeaders，调用方仍可覆盖（llm.js 传的值与这里等价）。
 */
function bearerHeader(apiKey) {
  // 掩码值（前端回传的 ******）绝不能当成真 Key 发出去 —— 那会得到一个
  // "Key 无效"的 401，而真实原因是"这本来就不是 Key"。
  const k = String(apiKey ?? '').trim();
  return (k && k !== '******') ? { authorization: `Bearer ${k}` } : {};
}

/**
 * 把 OpenAI 形态的对话 body 翻译成目标协议的请求。
 * @returns {{ url: string, headers: object, body: object }}
 */
export function buildProtocolRequest(protocol, { baseUrl, apiKey, model, openaiBody, extraHeaders = {} }) {
  const proto = normalizeProtocol(protocol);
  if (isOpenAiFamily(proto)) {
    // Chat Completions 与 Mistral 同一条线；Responses API 换端点与 body 结构。
    const path = proto === 'openai-responses' ? '/responses' : '/chat/completions';
    return {
      url: joinUrl(baseUrl || PROTOCOL_DEFAULT_BASES[proto], path),
      headers: { 'content-type': 'application/json', ...bearerHeader(apiKey), ...extraHeaders },
      body: proto === 'openai-responses' ? responsesBody(openaiBody) : openaiBody
    };
  }
  if (proto === 'anthropic') {
    return {
      url: joinUrl(anthroBase(baseUrl), '/messages'),
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(apiKey ?? ''),
        'anthropic-version': '2023-06-01'
      },
      body: anthropicBody(openaiBody)
    };
  }
  // google
  const base = String(baseUrl || PROTOCOL_DEFAULT_BASES.google).replace(/\/+$/, '');
  return {
    url: joinUrl(base, `/models/${encodeURIComponent(String(model || ''))}:generateContent`),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': String(apiKey ?? '') },
    body: googleBody(openaiBody)
  };
}

/** 连续同角色消息合并（Anthropic 要求 user/assistant 交替）。 */
function anthropicPush(msgs, role, blocks) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else msgs.push({ role, content: blocks });
}

function anthropicBody(openaiBody) {
  const system = [];
  const msgs = [];
  for (const m of Array.isArray(openaiBody?.messages) ? openaiBody.messages : []) {
    if (m?.role === 'system') {
      const t = textOf(m.content).trim();
      if (t) system.push(t);
      continue;
    }
    if (m?.role === 'tool') {
      // OpenAI 的 tool 结果 → Anthropic 的 tool_result（挂在 user 轮上）
      anthropicPush(msgs, 'user', [{
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id ?? ''),
        content: textOf(m.content) || '（工具返回为空）'
      }]);
      continue;
    }
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const blocks = [];
    const parts = Array.isArray(m?.content)
      ? m.content
      : [{ type: 'text', text: String(m?.content ?? '') }];
    for (const part of parts) {
      if (!part || typeof part !== 'object') { if (part) blocks.push({ type: 'text', text: String(part) }); continue; }
      if (part.type === 'text') {
        if (part.text) blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const url = String(part.image_url?.url ?? '');
        const b64 = parseDataUrl(url);
        if (b64) blocks.push({ type: 'image', source: { type: 'base64', media_type: b64.mediaType, data: b64.data } });
        else if (/^https?:\/\//i.test(url)) blocks.push({ type: 'image', source: { type: 'url', url } });
        else blocks.push({ type: 'text', text: '[一张图片输入因格式不支持已被省略]' });
      } else if (part.type === 'video_url') {
        blocks.push({ type: 'text', text: '[视频输入：Anthropic 协议暂不支持，请改用 OpenAI 兼容端点]' });
      }
    }
    if (role === 'assistant' && Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: String(tc?.id ?? ''),
          name: String(tc?.function?.name ?? ''),
          input: safeJsonParse(tc?.function?.arguments) ?? {}
        });
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    anthropicPush(msgs, role, blocks);
  }
  // Anthropic 要求首轮是 user：以 assistant 开头的历史（少见但存在）补一句引导
  if (msgs.length && msgs[0].role === 'assistant') {
    msgs.unshift({ role: 'user', content: [{ type: 'text', text: '（继续之前的对话）' }] });
  }
  const body = {
    model: String(openaiBody?.model ?? ''),
    max_tokens: Number(openaiBody?.max_tokens) > 0 ? Math.floor(Number(openaiBody.max_tokens)) : 8192,
    messages: msgs,
    stream: false
  };
  if (system.length) body.system = system.join('\n\n');
  if (Array.isArray(openaiBody?.tools) && openaiBody.tools.length) {
    body.tools = openaiBody.tools.map((t) => ({
      name: String(t?.function?.name ?? ''),
      description: String(t?.function?.description ?? ''),
      input_schema: t?.function?.parameters && typeof t.function.parameters === 'object'
        ? t.function.parameters
        : { type: 'object' }
    }));
    // tool_choice：'auto'|'none'|'required'|{...}（OpenAI 形态）→ Anthropic 形态
    const tc = openaiBody.tool_choice ?? 'auto';
    body.tool_choice = tc === 'required' ? { type: 'any' }
      : tc === 'none' ? { type: 'none' }
        : (tc && typeof tc === 'object' && tc.function?.name) ? { type: 'tool', name: tc.function.name }
          : { type: 'auto' };
  }
  if (openaiBody?.temperature !== undefined && openaiBody.temperature !== null) {
    body.temperature = Number(openaiBody.temperature);
  }
  return body;
}

function googleBody(openaiBody) {
  const sys = [];
  const contents = [];
  let lastToolCalls = [];   // 上一条 assistant 的 tool_calls：tool_call_id → 工具名
  for (const m of Array.isArray(openaiBody?.messages) ? openaiBody.messages : []) {
    if (m?.role === 'system') {
      const t = textOf(m.content).trim();
      if (t) sys.push(t);
      continue;
    }
    if (m?.role === 'tool') {
      // functionResponse 的 name 必须与发起调用的 functionCall.name 一致，
      // 否则 Gemini 直接 400。用 tool_call_id 回上一条 assistant 里找名字。
      const hit = lastToolCalls.find((t) => t.id === m.tool_call_id);
      const name = String(hit?.function?.name ?? m.tool_call_id ?? 'tool');
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { result: textOf(m.content) || '（工具返回为空）' } } }]
      });
      continue;
    }
    if (m?.role === 'assistant') {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t });
      lastToolCalls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
      for (const tc of lastToolCalls) {
        parts.push({
          functionCall: {
            name: String(tc?.function?.name ?? ''),
            args: safeJsonParse(tc?.function?.arguments) ?? {}
          }
        });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    // user
    const parts = [];
    const items = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
    for (const part of items) {
      if (!part || typeof part !== 'object') { parts.push({ text: String(part) }); continue; }
      if (part.type === 'text') {
        if (part.text) parts.push({ text: part.text });
      } else if (part.type === 'image_url' || part.type === 'video_url') {
        const url = String(part.image_url?.url ?? part.video_url?.url ?? '');
        const b64 = parseDataUrl(url);
        if (b64) parts.push({ inlineData: { mimeType: b64.mediaType, data: b64.data } });
        else parts.push({ text: '[媒体输入：该格式无法直连 Gemini，请改用 OpenAI 兼容端点或中转站]' });
      }
    }
    if (!parts.length) parts.push({ text: '' });
    contents.push({ role: 'user', parts });
  }
  const body = { contents };
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n\n') }] };
  if (Array.isArray(openaiBody?.tools) && openaiBody.tools.length) {
    body.tools = [{
      functionDeclarations: openaiBody.tools.map((t) => ({
        name: String(t?.function?.name ?? ''),
        description: String(t?.function?.description ?? ''),
        parameters: t?.function?.parameters && typeof t.function.parameters === 'object'
          ? t.function.parameters
          : { type: 'object' }
      }))
    }];
  }
  const gen = {};
  if (openaiBody?.temperature !== undefined && openaiBody.temperature !== null) gen.temperature = Number(openaiBody.temperature);
  if (Number(openaiBody?.max_tokens) > 0) gen.maxOutputTokens = Math.floor(Number(openaiBody.max_tokens));
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

function responsesBody(openaiBody) {
  const instructions = [];
  const input = [];
  for (const m of Array.isArray(openaiBody?.messages) ? openaiBody.messages : []) {
    if (m?.role === 'system') {
      const t = textOf(m.content).trim();
      if (t) instructions.push(t);
      continue;
    }
    if (m?.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(m.tool_call_id ?? ''), output: textOf(m.content) || '（工具返回为空）' });
      continue;
    }
    if (m?.role === 'assistant') {
      const t = textOf(m.content);
      if (t) input.push({ role: 'assistant', content: [{ type: 'output_text', text: t }] });
      for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
        input.push({
          type: 'function_call',
          call_id: String(tc?.id ?? ''),
          name: String(tc?.function?.name ?? ''),
          arguments: String(tc?.function?.arguments ?? '{}')
        });
      }
      continue;
    }
    // user：纯文本直接给字符串（对第三方 Responses 网关兼容性最好），带媒体才用 parts
    const items = Array.isArray(m?.content) ? m.content : null;
    if (!items) { input.push({ role: 'user', content: String(m?.content ?? '') }); continue; }
    const parts = [];
    let onlyText = true;
    for (const part of items) {
      if (!part || typeof part !== 'object') { parts.push({ type: 'input_text', text: String(part) }); continue; }
      if (part.type === 'text') parts.push({ type: 'input_text', text: part.text || '' });
      else if (part.type === 'image_url') {
        const url = String(part.image_url?.url ?? '');
        if (url) { parts.push({ type: 'input_image', image_url: url }); onlyText = false; }
      } else if (part.type === 'video_url') {
        parts.push({ type: 'input_text', text: '[视频输入：Responses API 通道暂不支持视频]' });
      }
    }
    input.push({ role: 'user', content: onlyText ? parts.map((p) => p.text || '').join('') : parts });
  }
  const body = { model: String(openaiBody?.model ?? ''), input, stream: false };
  if (instructions.length) body.instructions = instructions.join('\n\n');
  if (Array.isArray(openaiBody?.tools) && openaiBody.tools.length) {
    // Responses API 的 function 工具是"摊平"的（不再嵌套 function 字段）
    body.tools = openaiBody.tools.map((t) => ({
      type: 'function',
      name: String(t?.function?.name ?? ''),
      description: String(t?.function?.description ?? ''),
      parameters: t?.function?.parameters && typeof t.function.parameters === 'object'
        ? t.function.parameters
        : { type: 'object' }
    }));
    const tc = openaiBody.tool_choice ?? 'auto';
    body.tool_choice = (tc && typeof tc === 'object' && tc.function?.name)
      ? { type: 'function', name: tc.function.name }
      : (tc === 'none' || tc === 'required') ? tc : 'auto';
  }
  if (Number(openaiBody?.max_tokens) > 0) body.max_output_tokens = Math.floor(Number(openaiBody.max_tokens));
  if (openaiBody?.temperature !== undefined && openaiBody.temperature !== null) body.temperature = Number(openaiBody.temperature);
  return body;
}

// ── 响应侧：目标协议 → OpenAI 形态 ──────────────────────────────────────────

/**
 * 把目标协议的响应 JSON 归一成 OpenAI 形态。
 * @returns {{ choices: [{ message, finish_reason }], usage, model }} openai 直通原样返回
 */
export function parseProtocolResponse(protocol, data, fallbackModel = '') {
  const proto = normalizeProtocol(protocol);
  if (proto === 'openai' || proto === 'mistral') {
    return { choices: data?.choices ?? [], usage: data?.usage ?? null, model: data?.model ?? fallbackModel };
  }
  if (proto === 'openai-responses') return parseResponses(data, fallbackModel);
  if (proto === 'anthropic') return parseAnthropic(data, fallbackModel);
  return parseGoogle(data, fallbackModel);
}

function usageOf(prompt, completion, total, cached = 0) {
  return {
    prompt_tokens: Number(prompt) || 0,
    completion_tokens: Number(completion) || 0,
    total_tokens: Number(total) || ((Number(prompt) || 0) + (Number(completion) || 0)),
    ...(Number(cached) ? { prompt_tokens_details: { cached_tokens: Number(cached) } } : {})
  };
}

function parseResponses(data, fallbackModel) {
  let text = '';
  const toolCalls = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'message') {
      for (const c of Array.isArray(item.content) ? item.content : []) {
        if (c?.type === 'output_text') text += String(c.text ?? '');
        else if (c?.type === 'refusal') text += `\n[模型拒绝] ${String(c.refusal ?? '')}`;
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`),
        type: 'function',
        function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') }
      });
    }
    // reasoning 等其它 item 类型：不进正文
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const u = data?.usage ?? {};
  return {
    choices: [{
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : (data?.status === 'incomplete' ? 'length' : 'stop')
    }],
    usage: usageOf(u.input_tokens, u.output_tokens, u.total_tokens, u.input_tokens_details?.cached_tokens),
    model: data?.model ?? fallbackModel
  };
}

function parseAnthropic(data, fallbackModel) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  let text = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (b?.type === 'text') text += String(b.text ?? '');
    else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id ?? `call_${toolCalls.length}`),
        type: 'function',
        function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) }
      });
    }
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const stop = data?.stop_reason;
  const finish = toolCalls.length ? 'tool_calls'
    : stop === 'max_tokens' ? 'length'
      : stop === 'refusal' ? 'content_filter' : 'stop';
  const u = data?.usage ?? {};
  return {
    choices: [{ message, finish_reason: finish }],
    usage: usageOf(u.input_tokens, u.output_tokens, null, u.cache_read_input_tokens),
    model: data?.model ?? fallbackModel
  };
}

function parseGoogle(data, fallbackModel) {
  const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.thought === true) continue;   // 思考模型的思考段不进正文
    if (typeof p.text === 'string') text += p.text;
    if (p.functionCall?.name) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: String(p.functionCall.name),
          arguments: JSON.stringify(p.functionCall.args ?? {})
        }
      });
    }
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const fr = String(cand?.finishReason ?? '');
  const finish = toolCalls.length ? 'tool_calls'
    : fr === 'MAX_TOKENS' ? 'length'
      : (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'PROHIBITED_CONTENT') ? 'content_filter' : 'stop';
  const u = data?.usageMetadata ?? {};
  return {
    choices: [{ message, finish_reason: finish }],
    usage: usageOf(u.promptTokenCount, u.candidatesTokenCount, u.totalTokenCount, u.cachedContentTokenCount),
    model: data?.modelVersion ?? fallbackModel
  };
}

// ── 模型列表：按协议拉 /models ──────────────────────────────────────────────

/**
 * 目标协议的"列模型"请求描述。
 * @returns {{ url: string, headers: object }}
 */
export function protocolModelsRequest(protocol, baseUrl, apiKey) {
  const proto = normalizeProtocol(protocol);
  if (proto === 'anthropic') {
    return {
      url: `${joinUrl(anthroBase(baseUrl), '/models')}?limit=1000`,
      headers: { 'x-api-key': String(apiKey ?? ''), 'anthropic-version': '2023-06-01' }
    };
  }
  if (proto === 'google') {
    const base = String(baseUrl || PROTOCOL_DEFAULT_BASES.google).replace(/\/+$/, '');
    return { url: joinUrl(base, '/models'), headers: { 'x-goog-api-key': String(apiKey ?? '') } };
  }
  // openai / openai-responses / mistral：同一套 /models
  return {
    url: joinUrl(baseUrl || PROTOCOL_DEFAULT_BASES[proto], '/models'),
    headers: { ...bearerHeader(apiKey) }
  };
}

/** 解析各协议的模型列表响应 → [id]。解析不出返回 []（调用方给用户可操作的报错）。 */
export function parseProtocolModels(protocol, data) {
  const proto = normalizeProtocol(protocol);
  if (proto === 'google') {
    const list = Array.isArray(data?.models) ? data.models : [];
    return list
      .filter((m) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  // anthropic 与 openai 家族都是 { data: [{ id }] }（anthropic 也有 data 数组）
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => String(m?.id ?? m?.model ?? m ?? '')).filter(Boolean);
}
