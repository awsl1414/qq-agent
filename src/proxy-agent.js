// ── 全局 LLM 代理开关（2026-10-19，群友需求）────────────────────────────
// 需求：接入国外大模型 API（OpenAI / Anthropic 等）需要走本机代理。
// 实现：undici 的 ProxyAgent 作为 Node 全局 fetch 的 dispatcher ——
// llm.js（对话 / 模型列表）与 providers.js（连通性探测 / 测试请求）的
// 出站 fetch 统一带上 `dispatcher: dispatcherFor()`。
//
// ⚠️ 范围刻意收窄，只覆盖 **LLM 链路**：
//   · 网页阅读（safe-fetch）有自己的 SSRF 安全线，它的 proxy 参数仍是
//     占位（M4，2026-10-14），本次不接 —— 接了等于让任意外网 URL 借道
//     用户代理出去，安全审查没做之前不动它；
//   · OneBot 协议端（SnowLuma）是本机回环地址，永远不该走代理 ——
//     它根本不经过本模块，天然安全。
//
// ⚠️ 仅支持 http:// 代理（undici ProxyAgent 的能力边界）。socks5 需要
//    额外依赖（socks-proxy-agent 一类），检测到时明确警告 + 直连，
//    不做静默降级 —— 群友配了 socks 却"完全没生效"比报错更难排查。
//
// 缓存策略：按代理地址缓存单例。config 每次保存都会走 updateConfig →
// getConfig 返回新对象，这里按**字符串相等**判断是否重建 —— 用户改了
// 代理地址立即生效，没改则复用连接池（ProxyAgent 内部 keep-alive）。

import { ProxyAgent } from 'undici';
import { getConfig } from './config.js';
import { logger } from './logger.js';

let cached = null;        // 当前生效的 ProxyAgent
let cachedSrc = '';       // 它对应的代理地址（字符串相等才复用）
let warnedScheme = '';    // scheme 警告去重（同地址只警告一次）
let warnedInvalid = '';   // 构造失败警告去重

/**
 * 返回当前配置代理对应的 dispatcher；未配置代理 / 地址无效时返回 undefined
 * （fetch 不带 dispatcher = 直连，天然回落）。
 */
export function dispatcherFor() {
  let proxy = '';
  try {
    proxy = String(getConfig()?.api?.proxy || '').trim();
  } catch {
    return undefined;
  }
  if (!proxy) return undefined;
  if (cached && cachedSrc === proxy) return cached;

  // scheme 校验：undici ProxyAgent 只支持 http(s) 代理隧道
  if (!/^https?:\/\//i.test(proxy)) {
    if (warnedScheme !== proxy) {
      warnedScheme = proxy;
      logger.warn('proxy', `代理地址需以 http:// 开头（当前：${proxy}）。socks5 暂不支持，LLM 请求按直连发出`);
    }
    return undefined;
  }

  try {
    cached = new ProxyAgent(proxy);
    cachedSrc = proxy;
    logger.info('proxy', `LLM 请求将走代理 ${proxy}`);
    return cached;
  } catch (error) {
    if (warnedInvalid !== proxy) {
      warnedInvalid = proxy;
      logger.warn('proxy', `代理地址无效（${proxy}）：${error?.message || error}，LLM 请求按直连发出`);
    }
    return undefined;
  }
}

/** 仅供测试：清空缓存状态。 */
export function resetProxyCache() {
  cached = null;
  cachedSrc = '';
  warnedScheme = '';
  warnedInvalid = '';
}
