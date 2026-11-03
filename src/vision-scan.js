// 模型图片输入能力探测（vision scan）。
// 做法：对目录里的每个模型发一条带 1×1 测试图的最小 chat 请求，看网关接不接受 image_url 内容。
// 判定标准（业界通行做法）：OpenAI 兼容网关对纯文本模型通常会直接 4xx 拒绝图片内容，
// 接受（HTTP 200 且有 choices）即视为支持看图。与图片无关的失败（密钥、模型名、网络）记为
// unknown，不武断下结论。
// 结果持久化在 config.modelVision["providerId|||model"]，运行时用它门控看图工具。
import { getConfig, updateConfig } from './config.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { dispatcherFor } from './proxy-agent.js';
import { normalizeProtocol, buildProtocolRequest, parseProtocolResponse } from './api-protocols.js';

// 1×1 像素 PNG（70 字节），足够让视觉模型"看到点什么"，也不会浪费 token。
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 读取已保存的探测结果（含未检测的模型不存在条目）。 */
export function visionResults() {
  return getConfig().modelVision || {};
}

/** 查询某个模型（providerId|||modelId）的探测结论：'vision' | 'no-vision' | 'unknown' | undefined。 */
export function modelVisionVerdict(providerId, modelId) {
  const key = `${providerId || ''}|||${modelId || ''}`;
  return getConfig().modelVision?.[key]?.verdict;
}

/** 查询某个模型的图片输入结论：优先已持久化结论，其次内置官方资料表。 */
export function modelImageVerdict(providerId, modelId) {
  const saved = modelVisionVerdict(providerId, modelId);
  if (saved === 'vision' || saved === 'no-vision') return saved;
  const doc = builtinVisionResults([{ id: providerId, models: [modelId] }]);
  return doc[`${providerId || ''}|||${modelId || ''}`]?.verdict ?? saved;
}

/**
 * 探测单个模型。返回 { verdict, note, httpStatus, latencyMs }。
 * verdict: 'vision' 接受图片内容；'no-vision' 明确拒绝图片内容；'unknown' 无法判定。
 *
 * 请求走 `buildProtocolRequest()`，与真实对话同一条翻译边界，URL / 鉴权头 / body
 * 按 provider 自己的协议生成（图片内容块三家都能翻译，见 anthropicBody / googleBody）。
 * 硬编码 OpenAI 形态的 `/chat/completions` 会让 anthropic / google 的每个模型
 * 打到不存在的路径上，一律判 'unknown'，表现为"配了 Claude / Gemini 就永远探测不出
 * 能不能看图，看图工具被永久门控"。
 * 同时带 `dispatcherFor()`：不走代理的话，配了 proxy 的实例会"实跑能看图、探测 unknown"。
 */
export async function detectModelVision({ baseUrl, apiKey, model, protocol = '' }, timeoutMs = 25000) {
  const started = Date.now();
  const base = { verdict: 'unknown', note: '', httpStatus: null, latencyMs: null };
  if (!baseUrl || !model) return { ...base, note: '缺端点地址或模型名' };

  const proto = normalizeProtocol(protocol);
  const modelId = String(model).trim();
  const openaiBody = {
    model: modelId,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图片里是什么？用一句不超过十个字的话回答。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } }
      ]
    }],
    max_tokens: 24,
    stream: false
  };
  const built = buildProtocolRequest(proto, {
    baseUrl: String(baseUrl).trim(), apiKey, model: modelId, openaiBody
  });

  let res;
  try {
    res = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherFor()   // 网络代理：与真实对话同一条通道
    });
  } catch (error) {
    return { ...base, note: error?.name === 'TimeoutError' ? '探测请求超时' : `网络错误：${error?.message ?? error}` };
  }
  const latencyMs = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  const errText = String(body?.error?.message ?? body?.message ?? body?.detail?.error?.message ?? '');

  if (res.ok) {
    const reply = String(parseProtocolResponse(proto, body, modelId)?.choices?.[0]?.message?.content ?? '').trim();
    return { verdict: 'vision', note: reply ? `接受图片并回复：「${reply.slice(0, 30)}」` : '接受图片内容', httpStatus: res.status, latencyMs };
  }

  const looksImageRelated = /image|图片|multimodal|multi-modal|visual|vision|modality|图像|看图|多模态/i.test(errText);
  const looksAuthOrModel = /unauthorized|api key|forbidden|quota|billing|余额|权限|密钥|not found|does not exist|不存在|无可用渠道|no available channel/i.test(errText);

  if (looksAuthOrModel && !looksImageRelated) {
    return { verdict: 'unknown', note: `无法判定：${errText.slice(0, 80) || `HTTP ${res.status}`}`, httpStatus: res.status, latencyMs };
  }
  if ([400, 404, 422, 415].includes(res.status)) {
    // 4xx 且不像鉴权/模型名问题 → 视为网关拒绝该请求形态（典型：文本模型拒图片）
    return { verdict: 'no-vision', note: `HTTP ${res.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: res.status, latencyMs };
  }
  return { verdict: 'unknown', note: `HTTP ${res.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: res.status, latencyMs };
}

/**
 * 扫描目录（providerId 过滤可选）。并发受控，结果逐个写进 config 并通过 emit 汇报进度。
 * 返回 { total, results }。
 */
export async function scanModelsVision({ providers, emit = null, limit = 3, timeoutMs = 25000, onlyProviderIds = null } = {}) {
  const tasks = [];
  for (const p of providers || []) {
    if (onlyProviderIds && !onlyProviderIds.includes(p.id)) continue;
    if (!p.baseURL || !p.apiKey) continue; // 缺端点/密钥的提供商无从探测
    for (const model of p.models || []) {
      // 协议必须一起带上：探测请求与真实对话同源（见 detectModelVision 的注释）
      tasks.push({ providerId: p.id, model, baseURL: p.baseURL, apiKey: p.apiKey, protocol: p.apiProtocol || p.api || '' });
    }
  }
  const total = tasks.length;
  let done = 0;

  // 结果先在内存累积，每满 5 条 / 每 2 秒统一写一次盘。
  // 每个模型都调一次 updateConfig 的话，每次 deepMerge + structuredClone 全量配置
  // + fs.writeFileSync 同步落盘。扫 50 个模型 = 50 次全量序列化 + 50 次阻塞写盘，
  // 扫描期间主线程被 I/O 拖住，中途崩溃还会留下半写状态。
  const pending = new Map();
  const flushPending = () => {
    if (!pending.size) return;
    const patch = {};
    for (const [key, v] of pending) patch[key] = v;
    pending.clear();
    updateConfig({ modelVision: patch });
  };
  const flushTimer = setInterval(flushPending, 2000);
  flushTimer.unref?.();   // 别拖住进程退出

  const runTask = async (task) => {
    const key = `${task.providerId}|||${task.model}`;
    const r = await detectModelVision({ baseUrl: task.baseURL, apiKey: task.apiKey, model: task.model, protocol: task.protocol }, timeoutMs);
        pending.set(key, {
          providerId: task.providerId,
          model: task.model,
          verdict: r.verdict,
          note: r.note,
          httpStatus: r.httpStatus,
          latencyMs: r.latencyMs,
          source: 'probe',
          checkedAt: Date.now()
        });
        if (pending.size >= 5) flushPending();
    done += 1;
    emit?.('vision-scan', { key, providerId: task.providerId, model: task.model, verdict: r.verdict, done, total });
  };

  // 简单并发池
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length || 1)) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await runTask(task).catch((error) => {
        done += 1;
        emit?.('vision-scan', { key: `${task.providerId}|||${task.model}`, providerId: task.providerId, model: task.model, verdict: 'unknown', done, total, error: String(error?.message ?? error) });
      });
    }
  });
  // clearInterval + flushPending 必须在 finally 里：只在正常收尾路径做这两步的话，
  // 扫描中途抛错（updateConfig 失败等）会漏掉定时器，每 2 秒一次的 flushPending
  // 拖住进程不退出。
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(flushTimer);
    flushPending();   // 收尾：剩余结果一次写盘，确保不丢
  }
  return { total, results: { ...builtinVisionResults(providers || []), ...visionResults() } };
}
