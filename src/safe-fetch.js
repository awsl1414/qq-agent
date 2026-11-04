// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 代理 fake-ip 合成地址（RFC 2544 / RFC 5180 基准测试保留段）不是内网，
//   放行并记录一次；见 isProxyFakeIp；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程；
// - 大文件（视频）走 safeFetchBinaryToFile：边收边写盘，内存占用与文件大小无关。
//
// 例外开关：security.allowPrivateImageHosts = true 时，本模块所有出站路径
// （网页抓取 / 图片下载 / 扩展 fetch / 流式下载）统一跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。开关名沿用了历史名称，
// 语义已统一为「允许出站访问内网地址」。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from './config.js';
import { logger } from './logger.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

// 6to4（2002::/16）把 IPv4 嵌在第 2、3 组：2002:AABB:CCDD::/48 ↔ AABB.CCDD 对应的 IPv4。
// 提取逻辑必须与下面 isProxyFakeIp / isPrivateIp 共用：两份正则各自维护时，
// 基准测试段从内网分类移出后，isProxyFakeIp 没跟上 6to4 解析，6to4 内嵌的
// fake-ip（2002:c612:1::1）就变成两边都不判定的覆盖缺口。
function ipv4From6to4(h) {
  const m = String(h || '').match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
  if (!m) return null;
  const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  const sixToFour = ipv4From6to4(lower);
  if (sixToFour) return sixToFour;
  return null;
}

// RFC 2544 网络设备基准测试保留段。IANA 保留、公网不可路由，
// 正常 DNS 不会返回这些地址；只有 Clash/Mihomo 等代理的 fake-ip
// 模式会把任意域名映射到这里（实测 6 个互不相关的域名全部命中）。
// 见 https://www.rfc-editor.org/rfc/rfc2544 与 RFC 5180（IPv6 对应段）。
const FAKE_IP_TEST_NETS_V4 = '198.18.0.0/15';
const FAKE_IP_TEST_NETS_V6 = '2001:2::/48';

// 用 net.BlockList 而不是字符串前缀比较：IPv6 有多种等价写法
// （2001:2::9e / 2001:0002::9e / 2001:2:0::9e），前缀比较会既漏判又误判。
const FAKE_IP_NETS = new net.BlockList();
for (const [cidr, family] of [[FAKE_IP_TEST_NETS_V4, 'ipv4'], [FAKE_IP_TEST_NETS_V6, 'ipv6']]) {
  const [address, prefix] = cidr.split('/');
  FAKE_IP_NETS.addSubnet(address, Number(prefix), family);
}

/**
 * 是否为代理 fake-ip 合成地址（RFC 2544 / RFC 5180 基准测试保留段）。
 *
 * 这两个段不属于内网语义：攻击者无法让它们指向本机或内网服务（公网不可路由），
 * 正常 DNS 也不可能返回；命中即说明是本地代理在替外部域名合成地址，
 * 连接目标仍然是代理隧道里的那个公网域名（Host / SNI 不变）。
 * 只认这两个段，不做任何放宽。
 */
export function isProxyFakeIp(ip) {
  const h = String(ip ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h.includes(':')) {
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isProxyFakeIp(embedded);
  }
  const family = net.isIP(h);
  if (family === 4) return FAKE_IP_NETS.check(h, 'ipv4');
  if (family === 6) return FAKE_IP_NETS.check(h, 'ipv6');
  return false;
}

/**
 * 真实内网地址判定：本机 / 私网 / 链路本地 / CGNAT / 组播 / 文档保留段。
 *
 * 基准测试保留段（198.18.0.0/15、2001:2::/48）见 isProxyFakeIp，不放这里：
 * 它们不是内网，且只有代理 fake-ip 会产生。
 */
export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// 放行 fake-ip 是正常用法，不是异常：只在首次遇到时说明一次，避免刷屏。
let fakeIpNoticeLogged = false;
function noteProxyFakeIp(address, hostname) {
  if (fakeIpNoticeLogged) return;
  fakeIpNoticeLogged = true;
  logger.info('safe-fetch', `检测到代理 fake-ip 合成地址 ${address}（${hostname}），已放行。`
    + '这通常说明本机启用了 Clash/Mihomo 等代理的 TUN + fake-ip 模式。');
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    // fake-ip 字面量也允许：它是代理对外部域名的合成，不是本机服务；
    // 真实内网字面量仍然拦。
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    if (!allowPrivate && isProxyFakeIp(h)) noteProxyFakeIp(h, h);
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isProxyFakeIp(address)) { noteProxyFakeIp(address, h); continue; }   // 代理合成地址，放行
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

/**
 * 内网例外开关的唯一读取点。
 *
 * 开关语义是「本模块是否允许出站访问内网地址」，与具体抓取的是网页还是图片
 * 无关。历史上只有图片路径读了它、网页抓取没读，于是勾选该选项后
 * 「图片能下载但图片搜索仍被 SSRF 拒绝」——同一个开关在两条路径上行为相反。
 * 现在所有出站路径统一从这里取。
 */
function allowPrivateOutbound() {
  return getConfig().security?.allowPrivateImageHosts === true;
}

// 浏览锁定（browseLock）
//
// 作用：把"机器人能访问哪些域名"收成一个白名单，给用户一个硬边界
// （家长/老师/自用场景：只让它上这几个站）。
//
// 最关键的一点：白名单必须逐跳校验。只看入口 URL 是不够的，
// 一个站内链接 302 到站外就绕过去了。所以 safeFetch / safeFetchBinary
// 在每一次重定向之后都重新查一遍白名单，而不是只在开始查一次。

/** 域名归一化：去协议/去路径/去端口/转小写，只留主机名。 */
export function normalizeDomain(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    // 带协议的写法直接解析
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    return u.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch {
    return '';
  }
}

/** 读当前锁定配置（每次现读，保证改配置立即生效）。 */
export function browseLockState() {
  const lock = getConfig().security?.browseLock || {};
  const enabled = lock.enabled === true;
  const domains = (Array.isArray(lock.hosts) ? lock.hosts : [])
    .map(normalizeDomain)
    .filter(Boolean);
  return { enabled, domains, siteSearchUrl: String(lock.siteSearchUrl || '').trim() };
}

/**
 * 主机是否在白名单内。支持子域：白名单里有 `example.com` 时
 * `img.example.com` 也算通过，否则一个图床的 CDN 域名就把正常使用挡死了。
 * 但反向不成立：白名单写 `img.example.com` 不会放行 `example.com`。
 */
export function hostAllowed(host, state = browseLockState()) {
  if (!state.enabled) return true;          // 没开锁定 = 不限制
  const h = String(host ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h) return false;
  if (!state.domains.length) return false;  // 开了锁定但没填域名 = 全部拒绝（比"全部放行"安全）
  return state.domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 锁定开启时校验一个 URL 的主机；未开启则直接通过。返回 { enabled, host, allowed }。 */
export function checkBrowseLock(rawUrl, state = browseLockState()) {
  if (!state.enabled) return { enabled: false, host: '', allowed: true };
  let host = '';
  try {
    host = new URL(String(rawUrl ?? '')).hostname.toLowerCase();
  } catch {
    return { enabled: true, host: '', allowed: false };
  }
  return { enabled: true, host, allowed: hostAllowed(host, state) };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。额外判断 text.length >= maxBytes 是错的：
      // text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        // 超限时 resolve 必须带 truncated:true。只返回截断后的数据、没有任何标记，
        // 调用方无法区分"响应本来就这么大"和"被截断了"：文本路径用长度反推在中文下
        // 恒为 false，二进制路径则把残缺文件当正常数据。
        finish(resolve, { data: asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes), truncated: true });
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, { data: sliceByCodePoints(text, maxBytes), truncated: false });
        } else {
          finish(resolve, { data: Buffer.concat(chunks), truncated: false });
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
/**
 * 合并调用方提供的请求头。
 *
 * 为什么需要它：media-download 插件需要带 `Referer`（B 站 CDN 防盗链）、
 * `Cookie: SESSDATA=…`（登录态）、移动端 `User-Agent`、`ttwid`（抖音 detail 接口），
 * 而本模块原先把 headers 写死，插件的这些头全部被静默丢弃，于是依赖 Referer 的流 403、
 * 抖音接口返回空体。
 *
 * 安全约束（不能省，否则等于把 SSRF 防护打开一个口子）：
 *   ① `host` 必须由本模块按已解析的固定 IP 语义写入，永远不让调用方覆盖，
 *      防 Host 头被用来做 DNS rebinding / 虚拟主机绕过；
 *   ② 头名/头值必须是字符串且不含 CR/LF（防 header injection）；
 *   ③ 只接受白名单头名（Referer / Cookie / User-Agent / Origin / Accept /
 *      Accept-Language / Range / X-Requested-With），其余一律忽略。
 *      不放开任意头，是因为调用方是扩展代码，放开等于让它改写请求语义。
 */
const FORWARDABLE_HEADERS = new Set([
  'referer', 'cookie', 'user-agent', 'origin', 'accept', 'accept-language',
  'range', 'x-requested-with', 'device-mobile', 'x-bogus'
]);

function mergeExtraHeaders(baseHeaders, extra) {
  if (!extra || typeof extra !== 'object') return baseHeaders;
  const out = { ...baseHeaders };
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k).toLowerCase();
    if (!FORWARDABLE_HEADERS.has(key)) continue;       // 见上方 ③
    const val = String(v ?? '');
    if (/[\r\n]/.test(key) || /[\r\n]/.test(val)) continue;   // 见上方 ②
    if (!val) continue;
    out[key] = val;
  }
  // 见上方 ①：host 以本模块算出的为准，任何情况下都不被覆盖
  out.host = baseHeaders.host;
  return out;
}

function requestOnce(url, ip, { asBinary = false, maxBytes = 50000, headers = null, timeoutMs = 20000 } = {}) {  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: mergeExtraHeaders({
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      }, headers),
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: timeoutMs
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
        .then((r) => resolve({ statusCode, body: r.data, truncated: r.truncated, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;
// 文本读取上限。默认值保持 50KB（原行为）；允许调用方提高，但必须有硬上界，
// 否则一次抓取就能把内存吃光（调用方可能传 Infinity / 巨大值）。
const TEXT_BODY_DEFAULT = 50000;
const TEXT_BODY_MAX = 8 * 1024 * 1024;

/**
 * 单请求超时的钳制。导出仅为测试（同 resolveTextCap 约定）。
 * random-image 一直传 `timeoutMs`（booru/detail/download 三处配置），
 * 但本模块没有这个参数，调用方传了被静默忽略，实际恒为硬编码 20s，
 * 于是"外部图床响应慢"配置项不生效（表现为莫名其妙的 20 秒超时）。
 * 钳制范围 1s~120s：不许传 0/负数（那会立刻超时），也不许无限等。
 */
export function resolveTimeoutMs(v, fallback = 20000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.min(120000, Math.trunc(n)));
}

/**
 * proxy 参数的处理。
 * 现状：本模块的请求走 node:http/https 并固定已校验的 IP（防 DNS rebinding），
 * 要支持代理得自己实现 HTTP CONNECT 隧道，属新的网络路径，没有代理环境就无法验证，
 * 贸然上线反而可能破坏"直连兜底"这条现在能用的链路。
 * 所以这里不假装支持：收到 proxy 时明确警告一次，请求按直连发出。
 */
let proxyUnsupportedWarned = false;
function noteProxyUnsupported(proxy) {
  if (!proxy || proxyUnsupportedWarned) return;
  proxyUnsupportedWarned = true;
  console.warn('[safe-fetch] 收到 proxy 参数但本模块暂不支持代理隧道，请求将按直连发出。'
    + '若该站点必须走代理，请改用系统级代理或其它下载通道。');
}

/**
 * 文本读取上限的钳制（导出仅为测试）。
 * 下界 1000（不让 0/负数变成"一个字都不读"），上界 8MB（不让一次抓取把内存吃光）。
 */
export function resolveTextCap(maxBytes) {
  return Math.max(1000, Math.min(TEXT_BODY_MAX, Number(maxBytes) || TEXT_BODY_DEFAULT));
}

/**
 * 抓取网页文本（≤50000 字符）。SSRF 全防护；内网例外遵循
 * security.allowPrivateImageHosts（与图片下载、扩展 fetch 同口径）。
 */
export async function safeFetch(urlString, { browseLocked = false, headers = null, maxBytes = TEXT_BODY_DEFAULT, timeoutMs = null, proxy = '' } = {}) {
  // `maxBytes` 必须真的生效。此前签名里没有这个参数，调用方传进来的 maxBytes
  // 被静默忽略，实际恒为 50KB。后果有两处：
  //   - 图片搜索抓搜索页 HTML（Bing 完整页/结果片段都 >50KB），结果数据在后面，
  //     直接被截掉，"没解析到结果"，功能整个不可用；
  //   - media-download 的 biliJson / 抖音 detail 早就传了 1MB 并检查 res.truncated，
  //     于是 >50KB 的响应一律被截断，它们自己抛"超过读取上限（1024KB）被截断"
  //     （阈值还是错的：实际 50KB）。
  // 上界仍然要有：调用方可能传 Infinity/巨大值，不能让一次抓取把内存吃光。
  const cap = resolveTextCap(maxBytes);
  // timeoutMs 真的生效（钳制后），proxy 不支持则明确告知一次
  const timeout = resolveTimeoutMs(timeoutMs);
  noteProxyUnsupported(proxy);
  // 锁定校验放在最前面，连 DNS 都不做：不在白名单就根本不该发起连接
  const lock = browseLocked ? checkBrowseLock(urlString) : { enabled: false, allowed: true, host: '' };
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
  const allowPrivate = allowPrivateOutbound();
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: cap, headers, timeoutMs: timeout });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      // 逐跳校验：重定向目标也要在白名单里。
      // 只在入口校验的话，一个站内链接 302 到站外就绕过了锁定。
      if (browseLocked) {
        const nl = checkBrowseLock(next);
        if (!nl.allowed) throw new Error(`浏览锁定：重定向目标 ${nl.host || '未知'} 不在允许的域名清单内`);
      }
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    const body = result.body || '';
    // truncated 必须按本次实际的上限判断（硬编码 50000 的话，调用方提高上限后
    // 这个标记就会误报，media-download 正是靠它决定"要不要报截断错误"）。
    // 且必须来自 readBounded 的实测截断标记：用 `body.length >= cap` 反推是错的，
    // body.length 是字符数而 cap 是字节数，中文场景 50KB 字节 ≈ 1.6 万字符，
    // 该比较恒为 false，超限响应被静默截断且 truncated=false，
    // 调用方的"超过读取上限"检查全部失效。
    return { url: url.toString(), statusCode: result.statusCode, truncated: !!result.truncated, body };
  }
  throw new Error('重定向次数过多，已停止');
}

// 扩展侧受保护 fetch
//
// 背景：扩展（Skill）的 `api.fetch` 原先直接就是 `globalThis.fetch`，只要
// 清单里声明了 `permissions: ["web_fetch"]`，就能 `fetch('http://127.0.0.1:3210/api/…')`
// 或打 `169.254.169.254`（云元数据），本模块这一整套 SSRF 防护一条都不生效。
// UI 上 `web_fetch` 呈现为"只读联网"语义，与实际能力面不符。
//
// 为什么不是"直接转发到 safeFetch"：safeFetch 只支持 GET 文本，而唯一在用 api.fetch
// 的 image-generate 需要 POST JSON（生成接口）+ 读二进制流（`res.body.getReader()` 下载图片）。
// 用 node:http 重造一份完整的 fetch 语义（流 / 解压 / 超时 / AbortSignal / keep-alive）
// 风险远大于收益，任何一处不吻合都会把"图能生成但下载回来是坏档"这类问题引进来。
//
// 所以这里的做法是校验后转发：
//   - 入口与每一跳重定向都过 validateFetchUrl（scheme 白名单 + 禁止 URL 内嵌凭据 +
//     域名 DNS 全记录内网检查）与浏览锁定，与 safeFetch / safeFetchBinary 同源；
//   - 真正的传输交给平台 fetch，因此 Response 的全部能力（text / json / arrayBuffer /
//     body 流式读取 / headers / AbortSignal）原样保留，调用方代码一行都不用改；
//   - 重定向由本函数自己跟随（一律以 `redirect: 'manual'` 发出），这样每一跳都能重新
//     校验。若交给平台跟随，一个公网站 302 到 `127.0.0.1` 就绕过整套防护了。
//     同时按 fetch 规范处理：303（及 301/302 上的 POST）改 GET 丢体、跨源丢凭据类头。
//
// 与 safeFetch 的已知差异：这里不做"解析后固定 IP"（防 DNS rebinding），
// 平台 fetch 会自行再解析一次域名，理论上存在 TOCTOU 窗口。取舍理由：该窗口需要
// 扩展主动访问一个"攻击者控制 DNS、且两次解析结果从公网翻转到内网"的域名，而扩展本身
// 已在主进程内运行（等同 RCE），为堵这个窗口去重造 fetch 反而引入更大回归风险。
// 真正会被利用的实际目标（内网/环回/链路本地/CGNAT IPv4 与 IPv6 内嵌形态）
// 已由入口的 DNS 全记录检查挡住。
//
// 例外：security.allowPrivateImageHosts = true 时同样放行内网（与 safeFetch /
// safeFetchBinary / validateImageUrl 一致，统一由 allowPrivateOutbound 读取），
// 供"接口/图床就架在本机或内网"的场景使用，默认关闭。
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
// 跨源重定向时必须丢掉的凭据类请求头（同 fetch 规范）：否则 API Key / Cookie
// 会被顺手带到第三方站点去。
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
// 请求体已丢弃时这些头也必须删（否则服务端按 content-length 等 body，直接挂住）。
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'transfer-encoding'];

async function discardBody(res) {
  try { await res.body?.cancel(); } catch { /* 已结束 / 已被读走 */ }
}

/**
 * 供扩展 `api.fetch` 使用的受保护 fetch。用法与平台 fetch 一致：
 *   `await guardedFetch(url, { method, headers, body, signal })` → Response
 *
 * @param {string|URL|{url:string}} input
 * @param {object} [init]         标准 fetch init（method / headers / body / signal / redirect）
 * @param {object} [opts]
 *   browseLocked  = true    浏览锁定开启时逐跳校验（与 web_fetch 工具同口径）
 *   allowPrivate  = undefined  未指定时跟随 security.allowPrivateImageHosts
 *   maxRedirects  = 5
 */
export async function guardedFetch(input, init = {}, { browseLocked = true, allowPrivate, maxRedirects = MAX_REDIRECTS } = {}) {
  const doAllowPrivate = allowPrivate === undefined
    ? allowPrivateOutbound()
    : allowPrivate === true;

  const rawUrl = typeof input === 'string'
    ? input
    : (input instanceof URL ? input.href : String(input?.url ?? ''));
  if (!rawUrl) throw new Error('缺少请求地址');

  const redirectMode = String(init?.redirect || 'follow');
  if (!['follow', 'error', 'manual'].includes(redirectMode)) throw new Error(`redirect 取值不合法：${redirectMode}`);

  let method = String(init?.method || 'GET').toUpperCase();
  let body = init?.body;
  // 归一化成 Headers：跨源重定向要能删掉凭据类头，POST→GET 要能删掉体相关头。
  let headers;
  try { headers = new Headers(init?.headers ?? undefined); }
  catch { throw new Error('请求头不合法'); }

  let target = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const { url } = await validateFetchUrl(target, { allowPrivate: doAllowPrivate });
    // 与 safeFetch 一致：锁定校验放在发起连接之前（连 DNS 都算白做，先拦掉）
    if (browseLocked) {
      const lock = checkBrowseLock(url.toString());
      if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
    }

    const res = await globalThis.fetch(url.toString(), { ...init, method, body, headers, redirect: 'manual' });

    if (!REDIRECT_CODES.has(res.status)) return res;
    if (redirectMode === 'manual') return res;

    const location = res.headers.get('location');
    if (!location) return res;                    // 没有 Location 就不算真重定向，原样交给调用方
    if (redirectMode === 'error') {
      await discardBody(res);
      throw new TypeError('重定向被拒绝（redirect: "error"）');
    }
    await discardBody(res);
    if (hop >= maxRedirects) throw new Error('重定向次数过多，已停止');

    // 303，以及 301/302 上的 POST/PUT → 改 GET 且丢弃请求体（同 fetch 规范）
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && (method === 'POST' || method === 'PUT'))) {
      method = 'GET';
      body = undefined;
      for (const h of BODY_HEADERS) headers.delete(h);
    } else if (body && typeof body?.getReader === 'function') {
      // 307/308 要原样重放请求体，流式 body 无法重放：明确报错，别发出一个空体请求
      throw new Error('重定向需要重放流式请求体，无法继续');
    }

    let next;
    try { next = new URL(location, url).toString(); }
    catch { throw new Error(`重定向地址不合法：${String(location).slice(0, 200)}`); }
    // 跨源重定向丢掉凭据类请求头，避免 key / cookie 被带去第三方站点
    if (new URL(next).origin !== url.origin) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    }
    target = next;
  }
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, { browseLocked = false, headers = null, timeoutMs = null, proxy = '' } = {}) {
  const lock = browseLocked ? checkBrowseLock(urlString) : { enabled: false, allowed: true, host: '' };
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
  // timeoutMs 真的生效；proxy 不支持则明确告知一次（不静默忽略）
  const timeout = resolveTimeoutMs(timeoutMs);
  noteProxyUnsupported(proxy);
  const allowPrivate = allowPrivateOutbound();
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes, headers, timeoutMs: timeout });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      // 逐跳校验（同 safeFetch）：重定向目标也必须在白名单内
      if (browseLocked) {
        const nl = checkBrowseLock(next);
        if (!nl.allowed) throw new Error(`浏览锁定：重定向目标 ${nl.host || '未知'} 不在允许的域名清单内`);
      }
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    // 超限响应必须显式抛错，与 safeFetchBinaryToFile 语义对齐：把截断后的残缺
    // Buffer 当正常数据返回的话，调用方（image-cache / sticker-manager）的
    // `buffer.length > MAX_BYTES` 检查永远不成立（截断后长度恰好等于上限，
    // `>` 为 false），半张 JPEG/PNG 被写进缓存，表现为"图能读到但花屏/解码失败"
    // 且缓存留下永久坏档。
    if (result.truncated) throw new Error('响应超过读取上限，已截断（数据不完整，拒绝采用）');
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

// ── 流式落盘下载 ────────────────────────────────────────────────────────
//
// 与 safeFetchBinary 的分工：小文件（图片/表情）整读进内存更简单，继续走
// safeFetchBinary；大文件（视频，几十到 200MB）必须边收边写盘，整读会把
// 进程内存顶到文件大小，多个视频并发时直接 OOM。
//
// SSRF 防护与 safeFetchBinary 完全同源：入口与每一跳重定向都过
// validateFetchUrl（DNS 全记录内网检查 + IP 固定防 rebinding），上限语义也
// 一致：累计字节到达 maxBytes 即判"读满上限"（服务端文件 ≥ 上限，收到的
// 必是残缺数据），删掉半截文件并抛错，绝不把截断文件留给调用方。

/**
 * 通过 HTTP 代理建立 CONNECT 隧道，返回一个可当 https.request 的 agent 用。
 *
 * 为什么需要它：ffmpeg 安装包（34MB）走 GitHub Release，国内直连约 700KB/s（50 秒），
 * 走本机代理实测 5.5MB/s（8 秒）。用户本来就在设置里配了 LLM 代理，
 * 下载却没走，体验上就是"明明开了代理还是慢"。
 *
 * 与 LLM 那条代理链路的区别：LLM 走 undici 的 ProxyAgent（fetch 的 dispatcher）。
 * safe-fetch 是手写的 http/https 请求（为了 SSRF 防护要自己控制 DNS 与逐跳重定向），
 * 用不了 dispatcher，所以这里自己建隧道。两条链路共用同一个代理地址配置
 * （api.proxy），避免出现两个地方都要填代理。
 *
 * 隧道建立后仍是 Node 自己做 TLS 握手（rejectUnauthorized 不变），
 * 代理只转发字节，不会把证书校验交给代理。
 */
function connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    let proxy;
    try { proxy = new URL(proxyUrl); } catch { return reject(new Error('代理地址无效')); }
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const mod = proxy.protocol === 'https:' ? https : http;
    const authority = `${targetHost}:${targetPort}`;
    const req = mod.request({
      hostname: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        // 代理本身要求认证时（部分本地代理不开认证，留空也无害）
        ...(proxy.username ? {
          'proxy-authorization': `Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`
          ).toString('base64')}`
        } : {})
      },
      timeout: timeoutMs
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理拒绝建立隧道：HTTP ${res.statusCode}`));
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('代理连接超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 把一次响应流式写入 dest（200 时）；重定向只取 Location，响应体直接排空丢弃。
 *
 * onProgress(received, total)：可选进度回调。total 来自 content-length，
 * 缺失/不可信时为 0（调用方自己决定怎么显示）。回调里不要抛错，
 * 异常会中断下载，这里也包了 try 兜住。
 *
 * proxy：HTTP 代理地址（http://host:port）。给了就走 CONNECT 隧道；
 * 隧道建立失败不静默回落。回落成直连会让"配了代理还是慢"更难查，
 * 直接报错，让用户看见是哪一步不行。
 */
async function requestToFile(url, ip, dest, { limit = Infinity, timeoutMs = 30000, headers = null, onProgress = null, proxy = '' } = {}) {
  const mod = url.protocol === 'https:' ? https : http;
  const port = url.port || (url.protocol === 'https:' ? 443 : 80);
  // 走代理时先建 CONNECT 隧道；https 还要在隧道上自己做 TLS 握手。
  // 不能把裸 socket 直接当 createConnection 的返回值给 https.request：
  // Node 会当成"已经就绪的连接"，于是明文 HTTP 打到 443 端口上，服务端回 400。
  // 必须在隧道上 tls.connect 一次。
  let tunnel = null;
  if (proxy) {
    const raw = await connectViaProxy(proxy, url.hostname, port, timeoutMs);
    tunnel = url.protocol === 'https:'
      ? await new Promise((resolve, reject) => {
        const tlsSocket = tls.connect({
          socket: raw,
          servername: url.hostname,
          rejectUnauthorized: true,
          timeout: timeoutMs
        }, () => resolve(tlsSocket));
        tlsSocket.on('error', reject);
        tlsSocket.on('timeout', () => tlsSocket.destroy(new Error('TLS 握手超时')));
      })
      : raw;
  }
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: tunnel ? url.hostname : ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      // 隧道已建立：连接与 TLS 都由我们做好，直接复用
      ...(tunnel ? { createConnection: () => tunnel } : {}),
      headers: mergeExtraHeaders({
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      }, headers),
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      // 大文件下载：这是 socket 空闲超时而非总时长上限，数据持续流动时不触发，
      // 卡死的连接才会被掐掉（与 requestOnce 的行为一致，只是上限放宽到 timeoutMs）
      timeout: timeoutMs
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();   // 丢弃重定向页响应体，不落盘
        resolve({ statusCode, redirect: String(res.headers.location || ''), bytes: 0, contentType });
        return;
      }
      if (statusCode !== 200) {
        res.resume();   // 排空连接便于复用；错误响应体不落盘
        resolve({ statusCode, bytes: 0, contentType });
        return;
      }
      const declared = Number(res.headers['content-length'] || 0) || 0;
      let total = 0;
      let settled = false;
      let overLimit = false;
      const finish = (val) => { if (settled) return; settled = true; resolve(val); };
      const fail = (err) => { if (settled) return; settled = true; try { res.destroy(); } catch { /* ignore */ } reject(err); };
      const out = fs.createWriteStream(dest, { flags: 'w' });
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (onProgress) { try { onProgress(total, declared); } catch { /* 回调异常不中断下载 */ } }
        if (total >= limit) {
          // 到达上限立即掐断：已写部分反正会被调用方整文件删除，多收无益
          overLimit = true;
          try { res.destroy(); } catch { /* ignore */ }
          out.end();
          finish({ statusCode, bytes: total, contentType, overLimit });
          return;
        }
        if (!out.write(chunk)) {
          // 背压：写盘跟不上网络就读慢一点，别把 chunks 全堆在内存里
          res.pause();
          out.once('drain', () => res.resume());
        }
      });
      res.on('end', () => {
        if (settled) return;
        out.end(() => finish({ statusCode, bytes: total, contentType, overLimit }));
      });
      res.on('error', fail);
      out.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 流式下载到文件。成功返回 { bytes, contentType }；任何失败（非 200、超限截断、
 * 空响应、网络/磁盘错误、重定向超次）都会删掉半截文件再抛错：调用方往往
 * 按"文件存在"判定成功，残缺文件留在盘上会被当成已下载。
 *
 * @param {string} urlString  下载地址
 * @param {string} destPath   目标文件路径（父目录不存在会自动创建）
 * @param {number} maxBytes   硬上限；累计字节到达该值即判超限（保守语义：
 *                            与 safeFetchBinary 的 readBounded 一致，宁可误杀
 *                            "恰好等于上限"的文件，也不放过被截断的残缺文件）
 * @param {object} [opts]     { timeoutMs = 30000 }（socket 空闲超时）、
 *                            { browseLocked = false }（浏览锁定逐跳校验）、
 *                            { headersForHost = null }（按每一跳的实际主机返回请求头，
 *                              用于凭据只发给特定域名；返回 null 表示本跳不带额外头）、
 *                            { proxy = '' }（HTTP 代理，走 CONNECT 隧道）
 */
export async function safeFetchBinaryToFile(urlString, destPath, maxBytes, { timeoutMs = 30000, browseLocked = false, headers = null, headersForHost = null, onProgress = null, proxy = '' } = {}) {
  const dest = String(destPath || '');
  if (!dest) throw new Error('缺少目标文件路径');
  const limit = Math.max(1, Number(maxBytes) || 1);

  const lock = browseLocked ? checkBrowseLock(urlString) : { enabled: false, allowed: true, host: '' };
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || '该地址'} 不在允许的域名清单内`);
  const allowPrivate = allowPrivateOutbound();

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let ok = false;
  try {
    let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      // 凭据类头必须逐跳决定，不能整次下载统一给：下载源常会 302 到另一个
      // 域（GitHub Release → objects.githubusercontent.com），把 Authorization
      // 原样带过去等于把 Token 交给另一个服务。headersForHost 让调用方按本跳
      // 的实际主机决定带不带；返回 null 时退化为只有默认头。
      const hopHeaders = headersForHost ? headersForHost(url) : headers;
      const r = await requestToFile(url, ip, dest, { limit, timeoutMs, headers: hopHeaders, onProgress, proxy });
      if (r.redirect !== undefined) {
        if (!r.redirect) throw new Error(`重定向缺少 Location: ${r.statusCode}`);
        const next = new URL(r.redirect, url).toString();
        // 逐跳校验（同 safeFetch/safeFetchBinary）：重定向目标也必须在白名单内
        if (browseLocked) {
          const nl = checkBrowseLock(next);
          if (!nl.allowed) throw new Error(`浏览锁定：重定向目标 ${nl.host || '未知'} 不在允许的域名清单内`);
        }
        ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
        continue;
      }
      if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
      if (r.bytes === 0) throw new Error('下载内容为空');
      if (r.overLimit || r.bytes >= limit) throw new Error(`文件达到大小上限（${limit} 字节），已中止`);
      ok = true;
      return { bytes: r.bytes, contentType: r.contentType };
    }
    throw new Error('重定向次数过多，已停止');
  } finally {
    if (!ok) { try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ } }
  }
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (allowPrivateOutbound()) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
