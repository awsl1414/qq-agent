// 从协议端 WS 地址解析「端口探测目标（host + port）」。
//
// 为什么需要它：界面上的「收消息（WS）端口是否监听」与连接恢复轮询，都靠一次
// TCP connect 判断协议端在不在。这类判断曾经只从 wsUrl 取了端口、把主机写死成
// 127.0.0.1——协议端跑在局域网另一台机器（或本机非回环地址）时，探测打的本机
// 永远没有监听，而 OneBot 客户端按完整 wsUrl 连是通的，UI 于是长期显示
// 「端口未监听」，与实际连接状态相反。
//
// 放在独立模块而不是 config.js：这是纯粹的字符串 → 探测目标换算，不含配置
// 读取与落盘；不 import config 也就不用关心数据目录是否已初始化，测试可单独
// 加载。callers（app.js / routes.js）本来就在各自作用域里读 getConfig()。
import { logger } from './logger.js';

// 协议默认端口。ws/wss 没写端口时按 URL 规范的默认值走——不要用 3001，
// 那是 NapCat / SnowLuma 的默认端口，不是协议默认端口。
const SCHEME_DEFAULT_PORT = { 'ws:': 80, 'wss:': 443 };

// 配置完全不可解析时的兜底目标：与 DEFAULT_CONFIG.protocol.wsUrl 的缺省值一致，
// 让"配置坏了"退化成"按出厂默认探一次"，而不是让探测整体失败。
const FALLBACK_TARGET = Object.freeze({ host: '127.0.0.1', port: 3001 });

// 坏配置的告警按原始字符串去重：轮询每 2 秒调一次、/api/status 每次刷新也调，
// 不去重会把日志刷成瀑布，真正有用的信息反而被埋掉。
const warnedUrls = new Set();

function stripBrackets(hostname) {
  // URL.hostname 对 IPv6 会带着方括号（实测 Node 24：'ws://[::1]:3001' →
  // '[::1]'）。去掉方括号后是 net.Socket.connect 直接接受的写法。
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHost(hostname) {
  const h = stripBrackets(String(hostname || '').trim());
  // 监听地址不是连接地址：用户从协议端配置里抄来 0.0.0.0 / :: 时，本机回环才是
  // 那个端口的可达地址（与 protocol-detect.js 的 hostOf 同一处理）。
  if (h === '0.0.0.0' || h === '::') return '127.0.0.1';
  return h;
}

function warnOnce(raw) {
  const key = raw || '(空)';
  if (warnedUrls.has(key)) return;
  warnedUrls.add(key);
  logger.warn('probe', `protocol.wsUrl 无法解析为探测目标（${key}），端口探测回落到 ${FALLBACK_TARGET.host}:${FALLBACK_TARGET.port}`);
}

/**
 * 把 `config.protocol.wsUrl` 换算成一次 TCP 探测的 (host, port)。
 *
 * 规则：
 *   · `ws://host:port/path`  → { host, port }
 *   · 省略端口               → ws 80 / wss 443
 *   · `[::1]` 形式的 IPv6    → host 为不带方括号的 `::1`
 *   · 解析失败 / 空配置 / 端口非法 / 非 ws(s) 协议且没写端口
 *     → 兜底 127.0.0.1:3001 并记一条日志
 *
 * 永不抛异常：探测是"锦上添花"的诊断，配置写坏了只应等于"探不到"，不该让调用方
 * （/api/status、连接恢复轮询）整条崩掉。
 *
 * @param {unknown} wsUrl 用户可改的 WebSocket 地址
 * @returns {{host: string, port: number}}
 */
export function parseProbeTarget(wsUrl) {
  const raw = String(wsUrl ?? '').trim();
  if (!raw) {
    warnOnce(raw);
    return { ...FALLBACK_TARGET };
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    warnOnce(raw);
    return { ...FALLBACK_TARGET };
  }

  const host = normalizeHost(u.hostname);
  let port = 0;
  if (u.port) {
    const n = Number(u.port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
  } else {
    port = SCHEME_DEFAULT_PORT[u.protocol] || 0;
  }

  if (!host || !port) {
    warnOnce(raw);
    return { ...FALLBACK_TARGET };
  }
  return { host, port };
}
