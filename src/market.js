// 社区市场客户端：账号凭据管理、发布代理、口令安装。
//
// ── 为什么本地要存凭据、又要走代理 ──
//   · 凭据：账号系统"不需要频繁使用"，登录一次后 token 存在 data/account.json
//     （支持多条，UI 可以列出并选择）。绝不进 config.json —— 那玩意会被
//     GET /api/config 脱敏回传，塞进去等于自造一个泄露面。
//   · 代理：浏览器直连 kondius.cn 会被 CORS 拦（官网没开跨域），应用内所有
//     市场操作（登录/发布/口令校验/下载安装）都由 Node 端转发。
//
// ── 口令安装的安全边界 ──
//   · 下载的 zip 解压前先过与后端同款的结构校验（路径穿越/可执行文件/体积）
//   · 解压目标强制收在 skills/ 或 plugins/ 之下（type 由服务器 entry 决定，
//     前端传什么都没用 —— 这是"技能页输插件口令也装进插件目录"的保证）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, getConfig } from './config.js';
import { logger } from './logger.js';

export const MARKET_API_BASE = 'https://www.kondius.cn/api/community';
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');
// 2026-10-20：30s → 90s。实测（本机直连 kondius.cn，同一端点）：
//   好时 ttfb 2.1s / 6.6s 传完；差时 34s 被 UND_ERR_SOCKET 切断；
//   /plugins 拿到 402 条用了 53.9s，/skills 60s 时 body 还没读完。
// 30s 会在这条链路稍慢时必然先放弃，等于把"偶发慢"当成"永久故障"。
const FETCH_TIMEOUT_MS = 90000;
// 网络层瞬时错误的重试间隔。上游走阿里云 ESA（多 edge 节点），重试通常就换到
// 另一个节点，成本远低于让用户去点「重试」。
const RETRY_DELAY_MS = 800;
const RETRYABLE_NET = /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|other side closed|terminated/i;
// 安装包下载上限与后端 MAX_UPLOAD 对齐
const MAX_ZIP_BYTES = 8 * 1024 * 1024;

const log = (fn, ...args) => logger[fn]('market', ...args);

/** 读本地凭据列表：[{ username, token, savedAt }]。 */
export function listAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (Array.isArray(parsed?.accounts)) {
      return parsed.accounts.filter((a) => a && typeof a === 'object' && a.token && a.username);
    }
  } catch { /* 还没有凭据文件 */ }
  return [];
}

function saveAccounts(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ACCOUNT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  fs.renameSync(tmp, ACCOUNT_FILE);
}

/** 保存/更新一条凭据（按 username 去重）。 */
export function saveAccount({ username, token }) {
  const list = listAccounts().filter((a) => a.username !== username);
  list.push({ username: String(username), token: String(token), savedAt: Date.now() });
  saveAccounts(list);
  return list;
}

/** 删除一条凭据（登出：本地删 + 远端吊销，远端失败不阻塞本地删除）。 */
export async function removeAccount(username, { revoke = true } = {}) {
  const list = listAccounts();
  const hit = list.find((a) => a.username === username);
  if (revoke && hit) {
    try {
      await marketFetch('/auth/logout', { method: 'POST', token: hit.token });
    } catch (error) {
      log('warn', `吊销凭据失败（不影响本地删除）：${error?.message ?? error}`);
    }
  }
  saveAccounts(list.filter((a) => a.username !== username));
  return list;
}

/**
 * 官网市场 API 代理。返回解析后的 JSON；HTTP 非 2xx 抛错（带服务器给的 error 文案）。
 * @param {string} pathname 以 / 开头，拼在 MARKET_API_BASE 后
 * @param {object} options { method, token, json, body(headers 自动), timeoutMs }
 */
export async function marketFetch(pathname, { method = 'GET', token = '', json = null, body = null, headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  // 只重试"无副作用"的请求：GET/HEAD 且不带 body。
  // 登录 / 发布 / 装包这类 POST 一旦发出就不能重发（可能重复提交、重复扣配额），
  // 宁可直接报错让用户自己决定。
  const canRetry = (method === 'GET' || method === 'HEAD') && json === null && body === null;
  // 总预算：重试**不额外加时**，只吃第一次剩下的时间。
  // 否则"60s 超时 + 重试"最坏会拖到 121s，前端早就放弃了，用户看到的是
  // 一句没头没尾的超时 —— 而且后台还在跑，白占连接。
  const deadline = Date.now() + timeoutMs;

  const attempt = async () => {
    const left = Math.max(1000, deadline - Date.now());
    try {
      const res = await fetch(`${MARKET_API_BASE}${pathname}`, {
        method,
        headers: {
          ...(json !== null ? { 'content-type': 'application/json' } : {}),
          ...(token ? { 'X-Account-Token': token } : {}),
          ...headers
        },
        body: json !== null ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(left)
      });
      // ⚠️ 2026-10-20：原来这里是 `await res.json().catch(() => ({}))` ——
      // 只要 body 没读完（连接被切 / 到点被 abort），json() 抛错就被吞成 {}，
      // 而 res.ok 仍是 true，于是向上返回"空列表"。实测 /skills 在 60s 处
      // 正好命中这个路径：市场页显示「共 0 个」，用户以为市场是空的，
      // 实际是响应根本没传完。这里改成：读完 + 解析，失败就按失败报。
      const raw = await res.text();
      let data = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`市场返回了无法解析的内容（${raw.length} 字节，可能被截断）`);
        }
      }
      if (!res.ok) {
        const e = new Error(data?.error || `市场服务 HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return data;
    } catch (e) {
      // 同 community：undici 的 fetch 失败原因藏在 e.cause，带出来便于定位（DNS/TLS/网络）。
      const cause = e?.cause;
      const causeText = cause ? ` | cause: ${cause.code || cause.message || cause}` : '';
      const wrapped = new Error(`[market] 请求 ${pathname} 失败: ${e.message}${causeText}`);
      if (e?.status) wrapped.status = e.status;
      // 标记给下面的重试判断用（包装后原始 name 就丢了）
      wrapped.isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      wrapped.isNetwork = RETRYABLE_NET.test(`${e?.message || ''} ${causeText}`);
      throw wrapped;
    }
  };

  try {
    return await attempt();
  } catch (e) {
    // 超时不重试：60s 已经很长，再等一轮只会让用户更久看不到结果，
    // 而且超时多半意味着上游真的没响应，重试命中率低。
    // 只对「连接被切断 / 重置」这类瞬时错误补一次（换个 edge 节点通常就好）。
    const retryable = canRetry && !e.isTimeout && (e.isNetwork || (e.status >= 500));
    if (!retryable) throw e;
    log('warn', `市场请求失败，${RETRY_DELAY_MS}ms 后重试一次：${pathname} · ${e.message}`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return attempt();
  }
}

/**
 * 账号登录/注册：成功则自动保存凭据并返回账号信息。
 * mode: 'login' | 'register'。注册三要素：登录 ID + 展示用户名 + 密码（确认密码由前端本地比对）。
 */
export async function loginAccount({ loginId, displayName = '', password, mode = 'login' }) {
  const payload = mode === 'register'
    ? { loginId, displayName, password }
    : { loginId, password };
  const data = await marketFetch(mode === 'register' ? '/auth/register' : '/auth/login', {
    method: 'POST', json: payload
  });
  const name = data?.account?.displayName || data?.account?.username || data?.account?.loginId;
  if (!data?.ok || !data?.token || !name) throw new Error(mode === 'register' ? '注册失败（服务器响应异常）' : '登录失败（服务器响应异常）');
  saveAccount({ username: name, token: data.token });
  return { account: data.account, accounts: listAccounts() };
}

/** 校验一条凭据是否仍有效（whoami）。 */
export async function verifyAccount(token) {
  try {
    const data = await marketFetch('/auth/whoami', { token });
    return data?.ok ? data.account : null;
  } catch {
    return null;
  }
}

/**
 * 发布一个 skill/plugin 目录到市场（待审核）。
 * @param {object} o { kind: 'skill'|'plugin', id, displayName, description, token }
 * @returns 服务器响应 { ok, item, renamedTo? }
 */
export async function publishModule({ kind, id, displayName, description, token, captchaVerifyParam = '' }) {
  const dir = path.join(ROOT, kind === 'plugin' ? 'plugins' : 'skills', id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`目录不存在：${dir}`);
  }
  const zipBuffer = await zipDirectory(dir);
  // FormData（Node 18+ 原生）：zip 用 Blob 传，文件名服务端不敏感
  const form = new FormData();
  form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${id}.zip`);
  if (displayName) form.append('name', String(displayName));
  if (description) form.append('description', String(description));
  // 2026-10-17：服务端强制人机验证 —— 前端（UI 弹阿里云滑块）拿到
  // captchaVerifyParam 后透传上来；缺失时服务端 403「请先完成人机验证」。
  if (captchaVerifyParam) form.append('captchaVerifyParam', String(captchaVerifyParam));
  const res = await fetch(`${MARKET_API_BASE}/market/publish`, {
    method: 'POST',
    headers: token ? { 'X-Account-Token': token } : {},
    body: form,
    signal: AbortSignal.timeout(120000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `发布失败：HTTP ${res.status}`);
  return data;
}

/** 把目录打成 zip（Buffer）。entry.json 不存在于本地目录，无需剔除。 */
async function zipDirectory(dir) {
  const files = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp, rel ? `${rel}/${name}` : name);
      else files.push({ fp, rel: rel ? `${rel}/${name}` : name });
    }
  };
  walk(dir);
  // 前置校验（与后端 validate_zip 同款）：本地先拦，省一次上传
  if (files.length > 100) throw new Error('文件数量过多（>100）');
  let total = 0;
  for (const f of files) {
    total += fs.statSync(f.fp).size;
    if (/\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i.test(f.rel)) throw new Error(`禁止打包可执行文件：${f.rel}`);
  }
  if (total > 32 * 1024 * 1024) throw new Error('解压后总大小超过 32MB');

  // zip 打包：无外部依赖，用最简 STORED（无压缩）实现足够（8MB 上限内可控）
  // —— 但 ZIP_STORED 手写 CRC 代码量大；改走系统 PowerShell？不行（跨平台）。
  // 实际方案：借 node:zlib 的 deflateRaw 打 deflate 条目（本地自实现 zip writer）。
  const { deflateRawSync } = await import('node:zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  const crc32 = makeCrc32();
  for (const f of files) {
    const data = fs.readFileSync(f.fp);
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    // local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);            // version needed
    lfh.writeUInt16LE(0, 6);             // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);            // time
    lfh.writeUInt16LE(0x21, 12);         // date（固定合法值即可）
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, payload);

    central.push({ nameBuf, crc, method, compSize: payload.length, rawSize: data.length, offset });
    offset += lfh.length + nameBuf.length + payload.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);            // version made by
    cdh.writeUInt16LE(20, 6);            // version needed
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(c.method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.compSize, 20);
    cdh.writeUInt32LE(c.rawSize, 24);
    cdh.writeUInt16LE(c.nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);            // extra len
    cdh.writeUInt16LE(0, 32);            // comment len
    cdh.writeUInt16LE(0, 34);            // disk number
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(c.offset, 42);
    chunks.push(cdh, c.nameBuf);
    offset += cdh.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  const out = Buffer.concat(chunks);
  if (out.length > MAX_ZIP_BYTES) throw new Error(`压缩包超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB 上限（当前 ${Math.round(out.length / 1024 / 1024)}MB）`);
  return out;
}

/** CRC32（IEEE）—— zip 条目必需。 */
function makeCrc32() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
}

/**
 * 口令校验（批量）：codes → [{ code, ok, name, author, type, ... }]。
 */
export async function verifyInstallCodes(codes) {
  const data = await marketFetch('/install/verify', { method: 'POST', json: { codes } });
  if (!Array.isArray(data?.results)) throw new Error('口令校验响应异常');
  return data.results;
}

/**
 * 只下载 + 校验，**不落盘**。
 *
 * 2026-10-22 拆出来的原因：市场安装改走「先导入锻造台暂存区 → 过闸 → 人工确认 → 落地」，
 * 下载与安装成了两件事。routes 拿到 buffer 后交给 forge.import-zip，
 * 由它对同一份字节做结构校验、闸门检查与人工确认，而不是各自复制一份规则。
 *
 * @param {{code:string, verified?:object|null}} o
 * @returns {Promise<{buffer:Buffer, type:'skill'|'plugin', ident:string, entry:object|null}>}
 */
export async function downloadModuleZip({ code, verified = null } = {}) {
  // verified 来自 HTTP body（routes.js `verified: body?.entry`），**客户端可控** ——
  // 原实现直接信它的 type 与 id。虽然装插件本就执行任意 JS（设计使然），但 id 会作为
  // zip-install 的 preferId 参与落地目录名计算，不校验就是给路径穿越留放大面。
  // 这里按白名单口径重新校验：id 不合法就丢弃（回退用 zip 自己的根目录名），
  // type 只认 plugin/skill 两个值。
  const entry = verified && verified.ok ? verified : null;
  const type = String(entry?.type || '').toLowerCase() === 'plugin' ? 'plugin' : 'skill';
  const rawIdent = String(entry?.id || '');
  const ident = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(rawIdent) ? rawIdent : '';
  // 不信任何本地猜测：没传 verified 也重新校验一次拿 type
  const res = await fetch(`${MARKET_API_BASE}/install/${encodeURIComponent(String(code).trim().toUpperCase())}/download`, {
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`下载失败：HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  // r92：先按 content-length 预拦再整体读入。原实现 Buffer.from(arrayBuffer())
  // 之后才查 8MB 上限 —— 恶意/损坏服务端推超大 body 时内存已经爆了。
  // （content-length 可能缺失/说谎，下面的长度复查保留。）
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_ZIP_BYTES) throw new Error('安装包超过 8MB 上限');
  const zipBuffer = Buffer.from(await res.arrayBuffer());
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error('安装包超过 8MB 上限');
  // 结构校验放在下载之后、落地之前：这条路径同样要过（forge 侧还会再过一遍，
  // 两边口径一致 —— 不信任任何传输环节）。
  const { validateZipStructure } = await import('./zip-install.js');
  validateZipStructure(zipBuffer);
  return { buffer: zipBuffer, type, ident, entry };
}

/**
 * 按口令下载并安装到本地 skills/ 或 plugins/。
 * 类型路由由**服务器返回的 type** 决定（skill.json→skill / plugin.json→plugin），
 * 前端/调用方无法干预 —— 即使在技能页输入了插件的口令，也装进 plugins/。
 *
 * ⚠️ 2026-10-22 起，**HTTP 安装链路不再走这里**：/api/market/install 改为
 *    「下载 → 锻造台暂存区 → 闸门 → 人工确认 → 落地」。本函数保留给
 *    "确实要直装"的内部调用（以及历史脚本），它**没有闸门也没有人工确认**。
 *
 * @param {object} o { code, verified(校验阶段拿到的条目信息) }
 * @returns {Promise<{ok, kind, id, dir}>}
 */
export async function installByCode({ code, verified }) {
  const { buffer: zipBuffer, type, ident } = await downloadModuleZip({ code, verified });
  const { unzipToModuleDir } = await import('./zip-install.js');
  const dirName = await unzipToModuleDir(zipBuffer, { root: ROOT, type, preferId: ident });
  log('info', `口令 ${code} 安装完成：${type}s/${dirName}`);
  return { ok: true, kind: type, id: dirName, dir: path.join(ROOT, type === 'plugin' ? 'plugins' : 'skills', dirName) };
}

/* ── r105 搬运（自 v0.4.5 移植）：应用内「市场」页列表代理 ─────────────
 * 拉取官网 GET /skills | /plugins，做**字段白名单裁剪**再回前端：
 *   ① 官网 items 里还有 authorId 之类的前端用不到的内部标识，没必要带出来；
 *   ② 白名单防止官网将来新增字段（可能是内部字段）被无意透传到 UI。
 * @param {'skill'|'plugin'} kind
 * @returns {Promise<{categories:object, items:Array}>}
 */
/* ── 市场列表的 60 秒内存缓存 + 并发去重（2026-10-20）──────────────────────
 * 上游是阿里云 ESA/WAF 后面的公网接口（实测 gzip 136KB / 解压约 372KB，220~340ms），
 * 而市场页每切一次页签就会重拉一次、点「刷新」还会再来一次。慢的时候（上游抖动、
 * WAF 拦一下）几条请求会全挤在一起，前端看到的就是"转圈很久 / 加载不出来"。
 *
 * 缓存只包住**列表**这一层：列表是只读数据，60 秒内不会有什么变化；安装 / 校验 /
 * 发布走的都是各自接口，不受这里影响（装完想立刻看到变化，前端会 force 重拉）。
 */
// 2026-10-20：60s → 5min。上游每次拉列表都要重传 250KB+，而这条链路实测
// 6~34 秒不等 —— 60 秒的缓存让用户来回切几次页签就要重付一次等待成本。
// 市场内容更新频率以天计，5 分钟足够新鲜；点「刷新」时前端会带 force=1 绕开。
const MARKET_LIST_TTL_MS = 5 * 60_000;
const marketListCache = new Map();      // kind → { at, data }
const marketListInflight = new Map();   // kind → Promise（同一时刻只打一条上游请求）
// kind → 代际号（2026-10-20 审查）。force / 清缓存时自增，用来作废"在我之前出发"
// 的那条上游请求：它回来的数据已经过时，不许再覆盖新缓存（否则装完插件点刷新，
// 界面上会闪回安装前的列表）。
const marketListGen = new Map();

/** 清掉列表缓存（装 / 删之后需要立刻看到新状态时用）。 */
export function clearMarketListCache(kind) {
  const bump = (k) => {
    marketListCache.delete(k);
    marketListGen.set(k, (marketListGen.get(k) || 0) + 1);
    marketListInflight.delete(k);   // 在途的那条也不再算数（见 listMarketItems 的注释）
  };
  if (kind) bump(kind === 'plugin' ? 'plugin' : 'skill');
  else { bump('skill'); bump('plugin'); }
}

/**
 * 市场列表（技能 / 插件）。
 * @param {'skill'|'plugin'} kind
 * @param {object} [options]
 * @param {boolean} [options.force] 用户点「刷新」/ 装完之后要看到新状态：跳过内存与磁盘缓存，同步重拉。
 */
export async function listMarketItems(kind, { force = false } = {}) {
  const key = kind === 'plugin' ? 'plugin' : 'skill';
  if (force) {
    marketListCache.delete(key);
    // 2026-10-20 修：force 只删缓存是不够的 —— 若此刻正好有一条上游请求在途，
    // 下一行会把它当成"并发请求复用"直接返回，用户点「刷新」拿到的还是安装前
    // 那条 Promise 的结果（装完插件看不到新状态就出在这里）。这里把在途请求
    // 也作废：清掉 inflight + 抬一代，旧请求回来时代际不符就不写缓存。
    marketListGen.set(key, (marketListGen.get(key) || 0) + 1);
    marketListInflight.delete(key);
  }

  const hit = marketListCache.get(key);
  if (hit && Date.now() - hit.at < MARKET_LIST_TTL_MS) return hit.data;

  const running = marketListInflight.get(key);
  if (running) return running;      // 并发请求复用同一条上游请求

  // 磁盘兜底（2026-10-20）：这条链路实测会在 6 秒到 80 秒之间剧烈波动，
  // 而列表内容以天为粒度变化。有上次的成果就直接给，同时在后台换新 ——
  // 用户不用为"上游这会儿慢"再等一分半。force 时不吃这一套。
  if (!force) {
    const disk = readDiskListCache(key);
    if (disk) {
      // 2026-10-20 修：不能把磁盘的 at 原样塞进内存缓存。那个 at 是"上次成功拉
      // 上游的时间"，往往已经是几小时前 —— 内存 TTL 是 5 分钟，于是这一条一进
      // 内存就"已过期"，每次切页签都重新走一遍后台全量拉取（上游失败时还要
      // 再付一次 6~90 秒的等待）。内存 at 的语义是"本进程从何时起把它当新鲜的"，
      // 所以这里用当前时间，真正的刷新交给下面那一行。
      marketListCache.set(key, { at: Date.now(), data: disk.data });
      refreshInBackground(key);
      return disk.data;
    }
  }

  const gen = marketListGen.get(key) || 0;
  const task = fetchList(key, gen).finally(() => {
    // 只清理"自己这一条"：期间被 force / 清缓存接管的话，map 里已经是新请求，
    // 不能把新的那条删掉（删掉就等于并发去重失效，下一轮又会重打上游）。
    if (marketListInflight.get(key) === task) marketListInflight.delete(key);
  });
  marketListInflight.set(key, task);
  return task;
}

/** 拉一次上游并刷新两处缓存。列表本身是只读数据，失败不影响调用方已有的数据。 */
async function fetchList(key, gen = 0) {
  const seg = key === 'plugin' ? 'plugins' : 'skills';
  const data = await marketFetch(`/${seg}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  const FIELDS = ['id', 'name', 'description', 'author', 'version', 'category', 'categoryName',
    'status', 'updatedAt', 'createdAt', 'downloads', 'installCode', 'downloadUrl', 'type'];
  const slim = items.map((it) => {
    const out = {};
    for (const k of FIELDS) if (it && it[k] !== undefined) out[k] = it[k];
    return out;
  });
  const out = { categories: data?.categories && typeof data.categories === 'object' ? data.categories : {}, items: slim };
  // 代际守卫：这一趟是"上一代"发的（期间用户 force 过 / 装完了插件），
  // 数据已经过时 —— 照样回给调用方，但不许覆盖新的缓存与磁盘文件。
  if (gen === (marketListGen.get(key) || 0)) {
    marketListCache.set(key, { at: Date.now(), data: out });
    writeDiskListCache(key, out);
  }
  return out;
}

/** 后台换新：不 await、不占用 inflight（失败只记日志，用户手里已经有旧数据）。 */
function refreshInBackground(key) {
  fetchList(key, marketListGen.get(key) || 0).catch((e) => {
    log('warn', `市场列表后台刷新失败：${key} · ${String(e?.message || e)}`);
  });
}

/* ── 列表的磁盘缓存（2026-10-20）────────────────────────────────────────
 * 只存"已裁剪"的成品，体积与前端收到的完全一致（约 100~250KB）。
 * 24 小时是硬上限：再旧就同步重拉，宁可让用户等一次，也不给他看隔夜的市场。
 */
const MARKET_DISK_TTL_MS = 24 * 3600_000;
const diskCacheFile = (key) => path.join(DATA_DIR, `market-list-${key}.json`);

function readDiskListCache(key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(diskCacheFile(key), 'utf8'));
    if (!parsed || typeof parsed.at !== 'number' || !parsed.data) return null;
    if (Date.now() - parsed.at > MARKET_DISK_TTL_MS) return null;
    return { at: parsed.at, data: parsed.data };
  } catch { return null; }   // 没缓存 / 文件坏了：都当没有
}

function writeDiskListCache(key, data) {
  try {
    const p = diskCacheFile(key);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), data }), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    log('warn', `市场列表磁盘缓存写入失败：${String(e?.message || e)}`);
  }
}

/* ── r113 新增：人设市场 ────────────────────────────────────────────────
 * 人设与技能 / 插件是**三种不同的东西**，别拿同一套心智硬套：
 *   技能 / 插件 = 代码，下载 zip 落到 skills/ 或 plugins/，装完即生效；
 *   人设       = 文本，落进 config.customPersonas，装完还要切一次才生效。
 * 所以这里的接口形状是照**人设自己的数据**设计的（官网 /personas 端点），
 * 而不是给 listMarketItems 加个 'persona' 分支 —— 字段根本对不上：
 *   官网 personas 用 `title` 而非 `name`，**没有** downloads / version /
 *   status / installCode（有 downloadUrl + hasPrompt），分类也只给裸 key
 *   （companion / roleplay / utility / custom），拿不到中文 categoryName。
 *
 * ⚠️ 最要紧的一条：/personas 返回体里**带完整 prompt**（实测 123 条共
 *   70 万字、单条最长近 9 千字，整包 3.7MB）。列表页绝不能把 prompt 透传
 *   前端 —— 一屏 123 张卡就是 3.7MB 文本进内存，卡顿必现，且毫无意义
 *   （用户此时还没决定用哪一张）。这里**强制剔除 prompt**，只留 hasPrompt
 *   标记与长度，真正的正文等用户点「试用 / 应用」时再按 id 单独取。
 */
const PERSONA_CATEGORY_LABEL = {
  companion: '陪伴型',
  roleplay: '角色扮演',
  utility: '实用助手',
  custom: '自定义'
};

/** 人设列表（不含 prompt 正文）。 */
export async function listPersonaItems() {
  const data = await marketFetch('/personas');
  const raw = Array.isArray(data?.items) ? data.items : [];
  const items = raw.map((it) => {
    const prompt = typeof it?.prompt === 'string' ? it.prompt : '';
    return {
      id: String(it?.id || ''),
      title: String(it?.title || it?.id || '未命名人设'),
      description: String(it?.description || ''),
      author: String(it?.author || ''),
      category: String(it?.category || 'custom'),
      categoryName: PERSONA_CATEGORY_LABEL[it?.category] || PERSONA_CATEGORY_LABEL.custom,
      updatedAt: it?.updatedAt || '',
      createdAt: it?.createdAt || '',
      hasPrompt: !!it?.hasPrompt && prompt.length > 0,
      // 只回长度供 UI 显示「约 2000 字」，不回正文
      promptLength: prompt.length
      // ⚠️ 刻意**不回** downloadUrl：那是官网站内相对路径（/api/community/…），
      //   应用内既不能直连（无鉴权、走不了 CORS）也没有下载 zip 的需求 ——
      //   人设的"下载"就是取文本。带着它只会让人以为前端该去拼这个 URL。
    };
  }).filter((x) => x.id);
  return { categories: { ...PERSONA_CATEGORY_LABEL }, items };
}

/**
 * 取**单个**人设的 prompt 正文。
 * 列表页刻意不带 prompt（见上），所以详情必须按 id 单取。
 * @param {string} id 形如 persona-5677838eff
 * @returns {Promise<{id,title,prompt,description,author,category}>}
 */
export async function fetchPersonaPrompt(id) {
  const pid = String(id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pid)) {
    throw new Error('人设 id 非法');
  }
  /* 顺序要紧：**先打单条端点**，成功就直接返回。
   * 官网 GET /personas/:id/prompt 的响应同时带元信息与正文（实测顶层就是
   *   { ok, item:{…}, prompt:"…" }），一次往返足够，不必再拉整包列表。
   * ⚠️ 反过来先拉列表是纯浪费：/personas 整包 3.7MB（123 条 / 70 万字），
   *   而这里只要 9KB —— 实测先列表后单条要多花 ~1.9s、多传 3.7MB。
   *   列表只在单条端点不可用时才需要（拿兜底的元信息）。 */
  try {
    const one = await marketFetch(`/personas/${encodeURIComponent(pid)}/prompt`);
    const prompt = String(one?.prompt || one?.item?.prompt || '');
    if (prompt) {
      // 元信息以单条端点为准；缺项时从 item 里补齐
      const m = one?.item || {};
      return {
        id: pid,
        title: String(m.title || pid),
        description: String(m.description || ''),
        author: String(m.author || ''),
        category: String(m.category || 'custom'),
        categoryName: PERSONA_CATEGORY_LABEL[m.category] || PERSONA_CATEGORY_LABEL.custom,
        updatedAt: m.updatedAt || '',
        prompt
      };
    }
  } catch { /* 端点不存在 / 网络失败 → 走下面的兜底 */ }

  // 兜底：拉整包自己找（此时不得不取全量，只在主路径失效时才会走到）
  const raw = await marketFetch('/personas');
  const one = (Array.isArray(raw?.items) ? raw.items : []).find((x) => String(x?.id) === pid);
  if (!one) throw new Error('找不到这个人设');
  const prompt = String(one?.prompt || '');
  if (!prompt) throw new Error('这个人设没有提示词正文');
  return {
    id: pid,
    title: String(one?.title || pid),
    description: String(one?.description || ''),
    author: String(one?.author || ''),
    category: String(one?.category || 'custom'),
    categoryName: PERSONA_CATEGORY_LABEL[one?.category] || PERSONA_CATEGORY_LABEL.custom,
    updatedAt: one?.updatedAt || '',
    prompt
  };
}
