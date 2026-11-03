// 多提供商模型目录：从 DSH 的 settings.yaml 导入模型列表，统一成 OpenAI 兼容调用。
// DSH 里 api: anthropic-messages 的提供商，本程序按 OpenAI 兼容模式调用
// （A6API 这类中转站两种协议都支持；baseURL 缺 /v1 时自动补上）。
// 密钥来源优先级：DSH .credentials.yaml 的 refs > 环境变量（含别名）。
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { getConfig, updateConfig } from './config.js';
import { dispatcherFor } from './proxy-agent.js';
import {
  normalizeProtocol, protocolLabel, isOpenAiFamily, PROTOCOL_DEFAULT_BASES,
  buildProtocolRequest, parseProtocolResponse, protocolModelsRequest, parseProtocolModels
} from './api-protocols.js';

// DSH 未写 baseURL 的提供商，按官方默认端点补全（可在 UI 修改）：
// - mimo.mi.com/docs Token Plan（tp- 密钥专用网关，与 sk- 开放平台不可混用）
// - help.aliyun.com/zh/model-studio/token-plan-personal-quick-start（sk-sp- 密钥专用网关，与按量付费 sk- 不可混用）
// - opencode.ai/docs/go（OpenCode Go 订阅网关）
const PROVIDER_URL_DEFAULTS = {
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  'qwen-token-plan-cn': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1'
};

// 密钥环境变量的常见别名（如 DSH 写 A6API_API_KEY，本机实际是 A6API_APIKEY）
const KEY_ENV_ALIASES = {
  A6API_API_KEY: ['A6API_API_KEY', 'A6API_APIKEY']
};

function envApiKey(envName) {
  for (const name of KEY_ENV_ALIASES[envName] || [envName]) {
    const value = process.env[name];
    if (value) return { key: String(value), from: `环境变量 ${name}` };
  }
  return { key: '', from: '' };
}

/** 读取 DSH 的 .credentials.yaml（refs.<环境变量名> = 密钥）。 */
export function readDshCredentials(yamlPath) {
  const credPath = path.join(path.dirname(yamlPath), '.credentials.yaml');
  try {
    const doc = loadYaml(fs.readFileSync(credPath, 'utf8'));
    const refs = doc?.refs;
    return refs && typeof refs === 'object' ? refs : {};
  } catch {
    return {};
  }
}

function normalizeBaseURL(raw, { wasAnthropic, providerId }) {
  let url = String(raw || '').trim();
  if (!url) url = PROVIDER_URL_DEFAULTS[providerId] || '';
  if (!url) return '';
  if (wasAnthropic && !/\/v1\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/v1';
  return url.replace(/\/+$/, '');
}

/** 解析 DSH settings.yaml，返回规范化的提供商数组。 */
export function parseDshSettings(yamlPath) {
  const text = fs.readFileSync(yamlPath, 'utf8');
  const doc = loadYaml(text);
  const providers = doc?.['llm-pi-ai']?.providers ?? {};
  const creds = readDshCredentials(yamlPath);
  const out = [];
  for (const [id, p] of Object.entries(providers)) {
    const rawModels = Array.isArray(p?.models) ? p.models : [];
    const models = rawModels
      .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.model || '')))
      .filter(Boolean);
    if (!models.length) continue;
    const wasAnthropic = String(p?.api || '').includes('anthropic');
    const envName = String(p?.apiKeyEnv || '');
    // 密钥优先级：DSH 凭据文件 > 环境变量
    let key = '';
    let keyFrom = '';
    if (creds[envName]) {
      key = String(creds[envName]);
      keyFrom = 'DSH 凭据文件';
    } else {
      ({ key, from: keyFrom } = envApiKey(envName));
    }
    // 命名陷阱：provider 上的字段是 baseURL（大写 URL），而 config.api 上的同名
    // 概念是 baseUrl（小写 url）。两套 schema 只差一个字母却同时存在，写错时不会
    // 报错，只表现为"地址为空 / 需要重填"，极难定位。
    //   · 这里是 provider：p.baseURL
    //   · 那是全局 api 配置：cfg.api.baseUrl
    //   · 转换点在 llm.js 的 `baseUrl: String(p.baseURL)`（发起请求时统一成小写）。
    // 改这一带代码前先确认自己拿的是哪个对象。
    const entry = {
      id,
      displayName: String(p?.displayName || id),
      api: 'openai',
      anthropicOrigin: wasAnthropic,
      baseURL: normalizeBaseURL(p?.baseURL, { wasAnthropic, providerId: id }),
      apiKey: key,
      apiKeyFrom: keyFrom,
      models,
      needsBaseUrl: false
    };
    if (!entry.baseURL) entry.needsBaseUrl = true;
    out.push(entry);  }
  return out;
}

/** 从 DSH 导入并写入配置（整体替换 providers，并把密钥拆到 dshProviderKeys）。返回导入摘要。 */
export function importFromDsh(yamlPath) {
  const providers = parseDshSettings(yamlPath);
  const dshProviderKeys = {};
  const providersWithoutKeys = providers.map((p) => {
    if (p.apiKey) dshProviderKeys[p.id] = p.apiKey;
    const { apiKey, ...rest } = p;
    return rest;
  });
  updateConfig({ providers: providersWithoutKeys, dshProviderKeys });
  return {
    imported: providersWithoutKeys.length,
    models: providersWithoutKeys.reduce((n, p) => n + p.models.length, 0),
    withKeys: Object.keys(dshProviderKeys).length,
    providers: providersWithoutKeys.map((p) => ({ id: p.id, models: p.models.length, hasKey: !!dshProviderKeys[p.id], baseURL: p.baseURL }))
  };
}

/** 当前生效的提供商目录（配置里的 providers）。 */
export function currentProviders() {
  const cfg = getConfig();
  return (cfg.providers || []).map((p) => withResolvedKey(p, cfg));
}

/** 给指定提供商设置 API Key（存进配置的 dshProviderKeys，不动 providers 数组）。 */
export function setProviderKey(providerId, apiKey) {
  const key = String(apiKey ?? '').trim();
  const keys = { ...(getConfig().dshProviderKeys || {}) };
  if (key) keys[providerId] = key;
  else delete keys[providerId];
  updateConfig({ dshProviderKeys: keys });
  return currentProviders().find((p) => p.id === providerId) || null;
}

// ── 手动管理提供商/模型（设置页"模型 API"）──────────────────────────────

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * 从 Base URL 里取「端点」：host 含端口，不含路径。
 *
 * 为什么是 host 而不是 hostname：hostname 会吞掉端口，于是同时跑着
 * ollama（:11434）与 LM Studio（:1234）时，两个服务商的显示名都是
 * 127.0.0.1，删除确认框也分不清删的是哪一个。
 * URL.host 会保留非默认端口，并对 http/https 的默认端口（80/443）自动省略，
 * 正常的公网域名不会因此变难看。
 */
function endpointHost(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host || '';
  } catch {
    return '';
  }
}

/** 按域名兜底的显示名（新建提供商时不填名称，或老数据没有名称）。 */
function hostDisplayName(baseUrl) {
  return endpointHost(baseUrl) || '自定义提供商';
}

/**
 * 提供商的「显示标识」：用户能认出的那一串字。全仓唯一的拼接规则。
 *
 *   · 有名称 + 有端点 → `名称 · 端点`（本地模型 · 127.0.0.1:11434）
 *   · 只有名称        → `名称`      （老数据 baseURL 为空）
 *   · 只有端点        → `端点`
 *   · 都没有          → `id`
 *
 * 为什么是「名称 + 端点」而不是强制名称唯一：同厂商多账号是真实场景
 * （个人号 + 公司号），要求唯一会逼用户编假名字。名称只用于显示，身份始终是 id；
 * 而破坏性确认框必须能指认具体那一项，所以把端点一起带上。
 *
 * 端点取 host（含端口）而不是原始 Base URL：确认框里塞一句 `/v1/chat/completions`
 * 尾部路径既难读又与本问题无关。
 *
 * ⚠️ 前端 `providerLabelOf`（ui/app/00-core.js）是同一规则的镜像实现，
 *    改这里必须同步改那边；`GET /api/providers` 会直接下发本函数的返回值，
 *    前端优先用下发的 label，只有老缓存/缺字段时才就地拼。
 */
export function providerDisplayLabel(provider) {
  const p = (provider && typeof provider === 'object') ? provider : {};
  const name = String(p.displayName ?? '').trim();
  const host = endpointHost(p.baseURL ?? p.baseUrl);
  // 名称与端点字面相同（老数据：名称就是域名）时不再拼一遍，
  // 「127.0.0.1:11434 · 127.0.0.1:11434」既噪音又让人以为有两个服务商。
  if (name && host && name !== host) return `${name} · ${host}`;
  if (name) return name;
  if (host) return host;
  return String(p.id ?? '') || '未命名提供商';
}

// 提供商显示名上限：列表项是单行排版，超长会把「管理服务商」左列与页面上的
// 「当前：…」摘要撑破。前端同名输入框的 maxlength 与此值一致，改一处要改两处。
const PROVIDER_DISPLAY_NAME_MAX_LEN = 40;

/**
 * 规范化用户填写的提供商显示名（trim + 长度校验）。
 * 空串原样返回：新建时要落到域名兜底，改名时要被调用方拒绝，语义不同，
 * 所以「空名是否合法」留给调用方决定，这里只统一格式。
 */
function normalizeDisplayName(raw) {
  const name = String(raw ?? '').trim();
  if (name.length > PROVIDER_DISPLAY_NAME_MAX_LEN) {
    throw new Error(`名称不能超过 ${PROVIDER_DISPLAY_NAME_MAX_LEN} 个字符`);
  }
  return name;
}

function normalizeModelInput(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m) continue;
    if (typeof m === 'string') {
      const id = m.trim();
      if (id) out.push({ id, name: '' });
    } else if (typeof m === 'object') {
      const id = String(m.id ?? m.model ?? '').trim();
      // name 缺失时不要兜底成 id：兜底会让 modelNames 存成 { id: id }，而模型
      // 列表的渲染是「显示名 + 灰色 id」两列，名字等于 id 时同一个 id 出现两遍。
      // 空串由下游 `names[m] || m` 统一兜底成 id，只显示一次。
      if (id) out.push({ id, name: String(m.name ?? '').trim() });
    }
  }
  return out;
}

/** 从当前配置里取 provider.apiKey 对应的真实值（含旧版 top-level key 回退）。 */
function providerKeyValue(provider, cfg) {
  if (provider && typeof provider === 'object') {
    const top = String(provider.apiKey ?? '').trim();
    if (top && top !== '******') return top;
    const dshKey = String(cfg?.dshProviderKeys?.[provider.id] ?? '').trim();
    if (dshKey && dshKey !== '******') return dshKey;
  }
  return '';
}

/** 提供商对象里 apiKey 可能是掩码/引用，请求前必须解出真实 key。 */
function withResolvedKey(p, cfg = getConfig()) {
  const real = providerKeyValue(p, cfg);
  return { ...p, apiKey: real };
}

/** OpenCode Go 路由头：omen alpha 等模型缺 x-opencode-session 直接 400。
 *  中转站转发时域名不是 opencode.ai，要靠模型 id 的 opencode-go/ 前缀识别。 */
function opencodeHeaders(baseUrl, model = '') {
  if (!/opencode\.ai/i.test(String(baseUrl)) && !/^opencode-go\//i.test(String(model || ''))) return {};
  return { 'x-opencode-session': `qqagent-probe-${process.pid}`, 'user-agent': 'qq-agent/0.3' };
}

/**
 * 把底层网络异常翻译成用户能照着排查的话。
 *
 * 原先失败一律冒成 `TypeError: fetch failed`：Node 的原始错误（ECONNREFUSED /
 * ENOTFOUND / 证书错误）藏在 error.cause 里，上层只看 .message，界面上只有
 * 「拉取失败：fetch failed」，用户无法区分"地址写错 / 没网 / 端口不通 / 证书过期 / 超时"。
 */
export function describeNetError(error, target) {
  // 超时：AbortSignal.timeout 抛 TimeoutError；主动 abort 抛 AbortError
  const name = String(error?.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `连接超时（15 秒无响应）：${target}\n`
      + '· 地址是否可达？本地/内网端点注意别写成 https\n'
      + '· 是否需要走代理？本程序默认直连，不读系统代理';
  }
  // Node 把真正的失败原因放在 cause 上（可能嵌套一层）
  const cause = error?.cause || {};
  const code = String(cause.code || cause.errno || '');
  const detail = String(cause.message || error?.message || '');
  const map = {
    ECONNREFUSED: '对方拒绝连接 —— 地址或端口不对，或服务没在跑',
    ENOTFOUND: '域名解析不了 —— 主机名拼错了，或本机 DNS 有问题',
    EAI_AGAIN: 'DNS 查询超时 —— 网络不通或 DNS 服务器没响应',
    ECONNRESET: '连接被重置 —— 中间有防火墙/代理拦截，或服务端主动断开',
    EHOSTUNREACH: '主机不可达 —— 路由或网络问题',
    ETIMEDOUT: 'TCP 连接超时 —— 网络不通，或被防火墙丢包',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书 —— 若这是你自己的网关，需改用 http 或换受信任证书',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链不完整，无法验证',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名与地址不匹配'
  };
  if (map[code]) return `${map[code]}（${code}）：${target}`;
  if (code) return `网络错误 ${code}：${target}\n${detail.slice(0, 200)}`;
  return `网络请求失败：${target}\n${detail.slice(0, 300)}`;
}

/** 截断并压平一段响应体，供错误提示展示。 */
export function previewBody(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 用指定 baseUrl/key 获取模型列表（按 API 协议分端点）。
 * @param {string} [protocol='openai'] API 协议（anthropic/google 的 /models 形状不同）
 */
export async function fetchModelsFrom(baseUrl, apiKey, timeoutMs = 15000, protocol = 'openai') {
  const proto = normalizeProtocol(protocol);
  const base = normalizeBaseUrl(baseUrl) || PROTOCOL_DEFAULT_BASES[proto] || '';
  if (!base) throw new Error('请先填写 Base URL');
  // 提前挡住"填成完整接口地址"这类高频误填：拼出来的 URL 必然 404，
  // 但原始报错只说 HTTP 404，用户想不到是地址多写了后缀。
  // （仅 OpenAI 兼容家族适用；anthropic/google 的端点形状不同，不做此假设）
  if (isOpenAiFamily(proto)) {
    if (/\/chat\/completions\/?$/i.test(base)) {
      throw new Error(`Base URL 填成了完整的对话接口地址：\n${base}\n`
        + `请去掉末尾的 /chat/completions，只填到版本号为止（如 https://api.deepseek.com/v1）`);
    }
    if (/\/models\/?$/i.test(base)) {
      throw new Error(`Base URL 末尾多了 /models：\n${base}\n`
        + '程序会自己拼 /models，去掉它即可');
    }
  }
  const { url, headers } = protocolModelsRequest(proto, base, apiKey);
  if (isOpenAiFamily(proto)) Object.assign(headers, opencodeHeaders(base));   // OpenCode Go 路由头（openai 家族需要）
  let res;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: dispatcherFor()   // 网络代理：与对话请求同一条通道
    });
  } catch (error) {
    // 连请求都没发出去 / 没拿到响应
    throw new Error(describeNetError(error, url));
  }
  if (!res.ok) {
    // 带上响应体：服务端通常会说清楚（invalid api key / model not found / 余额不足…）
    const text = await res.text().catch(() => '');
    const hint = res.status === 401 || res.status === 403
      ? '\n· 密钥被拒：确认该提供商的 Key 已保存（模型管理里 Key 显示为 ****** 才是已存）'
      : res.status === 404
        ? '\n· 404：多数是该端点没有 /models 接口。换个地址试试，或直接用「手动添加模型」填模型 id'
        : res.status === 429
          ? '\n· 被限流：稍后重试'
          : '';
    throw new Error(`获取模型列表失败：HTTP ${res.status} ${res.statusText || ''}\n`
      + `请求地址：${url}${text ? `\n服务端返回：${previewBody(text)}` : ''}${hint}`);
  }
  // 先取文本再解析：直接 res.json() 在服务端返回 HTML（反代欢迎页/错端口）时
  // 只会冒一句 "Unexpected token '<'"，看不出到底连到了什么。
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`端点返回的不是 JSON（可能是反向代理页面或错误端口）：\n`
      + `请求地址：${url}\n`
      + `响应开头：${previewBody(raw, 160)}`);
  }
  const models = parseProtocolModels(proto, data);
  if (!models.length) {
    throw new Error(`端点返回成功，但没解析出任何模型：\n`
      + `请求地址：${url}\n`
      + `响应结构：${previewBody(raw, 200)}\n`
      + '· 该端点可能不遵循标准模型列表格式，请用「手动添加模型」直接填模型 id');
  }
  return models;
}

/**
 * 用用户提供的 baseUrl + apiKey + modelId 发送一次最小 chat 测试请求。
 * @param {string} [protocol='openai'] API 协议。测试必须与实跑同协议，
 *   否则会出现"测试通过、实跑失败"（或反过来）的假象。
 */
export async function testModelChat({ baseUrl, apiKey, model, protocol = 'openai' }) {
  const proto = normalizeProtocol(protocol);
  const base = normalizeBaseUrl(baseUrl) || PROTOCOL_DEFAULT_BASES[proto] || '';
  if (!base) throw new Error('请先填写 Base URL');
  if (!String(model || '').trim()) throw new Error('请先填写模型 ID');
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), 20000);
  try {
    const openaiBody = {
      model: String(model).trim(),
      messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
      max_tokens: 16,
      stream: false
    };
    const built = buildProtocolRequest(proto, {
      baseUrl: base,
      apiKey,
      model: String(model).trim(),
      openaiBody,
      extraHeaders: isOpenAiFamily(proto) ? opencodeHeaders(base, model) : {}
    });
    const res = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: controller.signal,
      dispatcher: dispatcherFor()   // 网络代理：测试也要走用户配的通道，否则"测试通过、实跑失败"
    });
    const latencyMs = Date.now() - startedAt;
    const body = await res.json();
    if (!res.ok) {
      const errText = String(body?.error?.message ?? body?.message ?? '').slice(0, 200);
      // 401/403 单独给一句可操作的话：这是"测试"最常见的失败，而原文（invalid api key）
      // 会让人以为 Key 打错了，实际也可能是这个提供商的 Key 根本没保存成功。
      const hint = (res.status === 401 || res.status === 403)
        ? ' —— 端点拒绝了鉴权：确认这个提供商的 Key 已保存（模型管理里显示 ****** 才算已存），且 Base URL 与 Key 属于同一家'
        : '';
      return { ok: false, httpStatus: res.status, latencyMs, note: `HTTP ${res.status}${errText ? `：${errText}` : ''}${hint}` };
    }
    const norm = parseProtocolResponse(proto, body, String(model).trim());
    const reply = String(norm?.choices?.[0]?.message?.content ?? '').trim().slice(0, 60);
    return { ok: true, httpStatus: res.status, latencyMs, note: reply ? `模型回复：「${reply}」` : '请求成功（无文本返回）' };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 测试一个提供商端点（按 providerId 查目录，或直接给 baseUrl/apiKey [+ protocol]）。 */
export async function testOneProvider({ providerId = '', baseUrl = '', apiKey = '', protocol = '' } = {}) {
  let p = currentProviders().find((x) => x.id === providerId);
  if (!p) {
    const proto = normalizeProtocol(protocol);
    const base = normalizeBaseUrl(baseUrl) || PROTOCOL_DEFAULT_BASES[proto] || '';
    if (!base) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
    p = { id: providerId || '__tmp__', displayName: hostDisplayName(base), baseURL: base, apiKey: apiKey || '', models: [], apiProtocol: proto };
  } else if (apiKey && apiKey !== '******') {
    p = { ...p, apiKey };
  }
  return testProvider(p);
}

/**
 * 新建提供商；若同 baseURL 已存在则合并模型。返回 { provider, created }。
 * @param {string} [protocol='openai'] API 协议（openai/openai-responses/anthropic/google/mistral）。
 *   选了带官方默认端点的协议且 Base URL 留空时，自动落默认端点。
 * @param {string} [displayName] 显示名。新建时留空 → 兜底成域名（旧行为）；
 *   已存在时只有传了非空名称才更新——不能因为这次没传就把用户起的名字改回域名。
 */
export function upsertProvider({ baseUrl, apiKey, models = [], protocol = 'openai', displayName = '' }) {
  const proto = normalizeProtocol(protocol);
  const base = normalizeBaseUrl(baseUrl) || PROTOCOL_DEFAULT_BASES[proto] || '';
  if (!base) throw new Error('Base URL 不能为空');
  const name = normalizeDisplayName(displayName);
  const providers = currentProviders().map((p) => { const { apiKey: _ak, ...rest } = p; return { ...rest, models: [...(p.models || [])] }; });
  const existing = providers.find((p) => normalizeBaseUrl(p.baseURL) === base);
  const entries = normalizeModelInput(models);
  if (existing) {
    for (const m of entries) {
      if (!existing.models.includes(m.id)) existing.models.push(m.id);
    }
    // 协议显式传入且与已存不同 → 以本次为准（UI 上改协议后重新添加同地址时生效）
    if (protocol !== undefined && protocol !== null && String(protocol).trim()) {
      existing.apiProtocol = proto;
    }
    if (name) existing.displayName = name;
    // ⚠️ modelNames 的合并必须在 updateConfig 之前完成：曾经先 updateConfig
    // （内部 structuredClone 出配置快照落盘）、再改局部 existing.modelNames，
    // 返回值（内存对象）带着新名字，但 currentConfig 与磁盘上都没有，重启后
    // 新增模型的显示名丢失。
    existing.modelNames = { ...(existing.modelNames || {}) };
    for (const m of entries) existing.modelNames[m.id] = m.name;
    if (apiKey) {
      const keys = { ...(getConfig().dshProviderKeys || {}) };
      keys[existing.id] = String(apiKey).trim();
      updateConfig({ providers, dshProviderKeys: keys });
    } else {
      updateConfig({ providers });
    }
    return { provider: withResolvedKey(existing), created: false };
  }
  const id = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const modelNames = {};
  for (const m of entries) modelNames[m.id] = m.name;
  const provider = {
    id,
    displayName: name || hostDisplayName(base),
    api: 'openai',
    apiProtocol: proto,
    anthropicOrigin: false,
    baseURL: base,
    apiKey: '',
    apiKeyFrom: apiKey ? 'manual' : '',
    models: entries.map((m) => m.id),
    modelNames,
    needsBaseUrl: false
  };
  providers.push(provider);
  const keys = { ...(getConfig().dshProviderKeys || {}) };
  if (apiKey) keys[id] = String(apiKey).trim();
  updateConfig({ providers, ...(apiKey ? { dshProviderKeys: keys } : {}) });
  return { provider: withResolvedKey(provider), created: true };
}

/** 设置指定提供商的 API 协议（「API 协议」下拉的保存动作）。返回更新后的提供商；不存在返回 null。 */
export function setProviderProtocol(providerId, protocol) {
  const proto = normalizeProtocol(protocol);
  const providers = currentProviders().map((p) => ({ ...p }));
  const p = providers.find((x) => x.id === String(providerId ?? '').trim());
  if (!p) return null;
  p.apiProtocol = proto;
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

/**
 * 设置指定提供商的显示名（「管理服务商」右列的改名保存动作）。
 *
 * 不走 upsertProvider：那个函数按 baseURL 判重，改名会命中"同一地址只合并模型"
 * 的分支，改完与其它调用方的语义打架（例如添加同地址提供商时顺带把名字覆盖掉）。
 *
 * @returns {object|null} 更新后的提供商；不存在返回 null
 * @throws 名称为空或超长时抛错——空名称会让列表里出现空白项，必须明确拒绝
 */
export function setProviderDisplayName(providerId, displayName) {
  const name = normalizeDisplayName(displayName);
  if (!name) throw new Error('名称不能为空');
  const providers = currentProviders().map((p) => ({ ...p }));
  const p = providers.find((x) => x.id === String(providerId ?? '').trim());
  if (!p) return null;
  p.displayName = name;
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

/** 给指定提供商追加模型（合并 modelNames）。 */
export function addModelsToProvider(providerId, models = []) {
  const entries = normalizeModelInput(models);
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.modelNames = { ...(p.modelNames || {}) };
  for (const m of entries) {
    if (!p.models.includes(m.id)) p.models.push(m.id);
    p.modelNames[m.id] = m.name;
  }
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

/** 从提供商移除一个模型。 */
export function removeModelFromProvider(providerId, modelId) {
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.models = p.models.filter((id) => id !== modelId);
  if (p.modelNames) {
    p.modelNames = { ...p.modelNames };
    delete p.modelNames[modelId];
  }
  const patch = { providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) };
  // 删掉的正好是当前生效的模型 → 一并清空选中态。只改 providers 的话，
  // api.model 仍指向一个已经不存在的 id：之后每次对话都被上游 400，设置页
  // 「模型」框还显示着它。与 removeProvider 的处理保持一致。
  const cfg = getConfig();
  if (String(cfg.api?.model ?? '') === String(modelId)) {
    patch.api = { provider: '', model: '' };
  }
  updateConfig(patch);
  return p;
}

/**
 * 删除整个提供商（含它的 Key 与模型目录）。
 * 若当前选中的模型正好属于这个提供商，同时清空 api.provider / api.model，
 * 避免配置指向一个已不存在的提供商（那样 resolveApiKey 会拿到死 Key）。
 * @returns {boolean} 是否真的删掉了（提供商不存在返回 false）
 */
export function removeProvider(providerId) {
  const pid = String(providerId ?? '').trim();
  if (!pid) return false;
  const cfg = getConfig();
  const providers = (cfg.providers || []).filter((p) => p.id !== pid);
  if (providers.length === (cfg.providers || []).length) return false;   // 没找到

  // 清掉这个提供商的 Key（__replace__ 整体替换：普通深合并传 {} 删不掉已有键）
  const keys = { ...(cfg.dshProviderKeys || {}) };
  delete keys[pid];

  const patch = {
    providers: { __replace__: providers },
    dshProviderKeys: { __replace__: keys }
  };
  // 当前选中的提供商被删 → 一并清空选中态，回落到"未选择"
  if (String(cfg.api?.provider ?? '') === pid) {
    patch.api = { provider: '', model: '' };
  }
  updateConfig(patch);
  return true;
}

// ── 连通性测试：GET {baseURL}/models（OpenAI 兼容探测）────────────────────

/**
 * 测试一个提供商的端点连通性与密钥有效性。
 * 返回 { ok, httpStatus, modelCount, latencyMs, verdict, note }。
 * verdict: ok（可用）/ bad-key（密钥被拒）/ no-models-route（端点可达但无 /models 路由）/ no-endpoint / error
 */
export async function testProvider(p, timeoutMs = 12000) {
  if (!p.baseURL) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
  const proto = normalizeProtocol(p.apiProtocol || p.api);
  const { url, headers } = protocolModelsRequest(proto, p.baseURL, p.apiKey);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), timeoutMs);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      dispatcher: dispatcherFor()   // 网络代理：连通性探测同样要走代理才有意义
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      let count = 0;
      try {
        count = parseProtocolModels(proto, await res.json()).length;
      } catch { /* body 不是 JSON */ }
      return { ok: true, httpStatus: res.status, modelCount: count, latencyMs, verdict: 'ok', note: count ? `列到 ${count} 个模型` : '端点可用（未返回模型列表）' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, httpStatus: res.status, latencyMs, verdict: 'bad-key', note: `HTTP ${res.status}：密钥无效或无权限` };
    }
    if (res.status === 404) {
      return { ok: false, httpStatus: 404, latencyMs, verdict: 'no-models-route', note: '端点可达但没有 /models 路由（chat/completions 未必不可用）' };
    }
    return { ok: false, httpStatus: res.status, latencyMs, verdict: 'error', note: `HTTP ${res.status}` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, verdict: 'error', note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发测试全部提供商（限 4 并发）。 */
export async function testAllProviders(providers, limit = 4) {
  const results = {};
  const queue = [...providers];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      results[p.id] = { ...(await testProvider(p)), displayName: p.displayName };
    }
  });
  await Promise.all(workers);
  return results;
}
