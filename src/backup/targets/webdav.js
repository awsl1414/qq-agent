// WebDAV 端点由用户配置为可信备份后端，通常是内网 NAS；威胁模型不同于网页抓取，
// 因此刻意不用会阻止内网地址的 safe-fetch.guardedFetch。
import { fetch, Agent, ProxyAgent } from 'undici';
import { dispatcherFor } from '../../proxy-agent.js';
import { getConfig } from '../../config.js';
import {
  BACKUP_DOWNLOAD_MAX_BYTES, BACKUP_LIST_PAGE_MAX_BYTES, BACKUP_LIST_MAX_PAGES_COUNT,
  BACKUP_LIST_MAX_ENTRIES_COUNT, BACKUP_LIST_MAX_DEPTH_LEVELS, BACKUP_LIMIT_ERROR_CODE,
  backupLimitError, readBoundedResponse
} from './limits.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_COUNT = 2;
const RETRY_DELAY_MS = 100;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MKCOL_STATUSES = new Set([201, 204, 405]);
const insecureAgents = new Map();
const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

function decodeXml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

function elements(xml, tag) {
  return [...xml.matchAll(new RegExp(`<(?:(?:[\\w.-]+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}\\s*>`, 'gi'))].map(match => match[1]);
}

function keyParts(key) {
  const parts = String(key || '').replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '..' || part === '.' || /[\x00-\x1f]/.test(part))) throw new Error('WebDAV key 非法');
  return parts;
}

/** 凭据由 targets/index.js 的工厂解密后以 password 传入。 */
export function createWebdavTarget(entry = {}) {
  let root;
  try {
    root = new URL(entry.url);
    if (!new Set(['http:', 'https:']).has(root.protocol) || root.username || root.password || root.search || root.hash) root = undefined;
    if (root && !root.pathname.endsWith('/')) root.pathname += '/';
  } catch { /* 无效配置留给 test() 以非抛错形式报告。 */ }
  const authorization = `Basic ${Buffer.from(`${entry.username || ''}:${entry.password || ''}`).toString('base64')}`;

  function requireRoot() {
    if (entry.__credentialError) throw new Error(entry.__credentialError);
    if (!root) throw new Error('WebDAV URL 无效（需 http/https 且不含凭据、查询或片段）');
    return root;
  }

  function dispatcher() {
    const configured = dispatcherFor();
    if (entry.allowInsecureTLS !== true) return configured;
    // ProxyAgent 的目标 TLS 参数必须在构造时设置，不能用直连 Agent 替换用户代理。
    const proxy = configured ? String(getConfig()?.api?.proxy || '').trim() : '';
    if (!insecureAgents.has(proxy)) insecureAgents.set(proxy, proxy
      ? new ProxyAgent({ uri: proxy, requestTls: { rejectUnauthorized: false } })
      : new Agent({ connect: { rejectUnauthorized: false } }));
    return insecureAgents.get(proxy);
  }

  async function request(method, url, accepted, body, headers = {}, format = 'none') {
    for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method, headers: { Authorization: authorization, ...headers }, body,
          dispatcher: dispatcher(), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!accepted.has(response.status)) {
          await response.body?.cancel();
          // 只防御远端瞬态故障；认证、路径错误不会因重试消失。
          if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRY_COUNT) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }
          throw new Error(`WebDAV ${method} 状态码 ${response.status} 路径 ${url.pathname}`);
        }
        if (response.status === 404) {
          await response.body?.cancel();
          return format === 'text' ? '' : undefined;
        }
        if (format === 'buffer') return await readBoundedResponse(response, BACKUP_DOWNLOAD_MAX_BYTES);
        if (format === 'text') return (await readBoundedResponse(response, BACKUP_LIST_PAGE_MAX_BYTES)).toString('utf8');
        await response.body?.cancel();
        return;
      } catch (error) {
        if (error.code === BACKUP_LIMIT_ERROR_CODE) throw error;
        if (response) throw new Error(`WebDAV ${method} 状态码 ${response.status} 路径 ${url.pathname}（请求失败）`);
        if (attempt === MAX_RETRY_COUNT) throw new Error(`WebDAV ${method} 状态码 unavailable 路径 ${url.pathname}（网络或超时错误）`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  function fileUrl(key) {
    const base = requireRoot();
    return new URL(keyParts(key).map(encodeURIComponent).join('/'), base);
  }

  async function mkdir(url) {
    const current = new URL('/', url);
    for (const part of url.pathname.split('/').filter(Boolean)) {
      current.pathname += `${part}/`;
      await request('MKCOL', current, MKCOL_STATUSES);
    }
  }

  async function list() {
    const base = requireRoot();
    const queue = [base];
    const visited = new Set();
    const files = new Map();
    const queued = new Set([base.href]);
    let entriesCount = 0;
    while (queue.length) {
      if (visited.size >= BACKUP_LIST_MAX_PAGES_COUNT) throw backupLimitError();
      const directory = queue.shift();
      if (visited.has(directory.href)) continue;
      visited.add(directory.href);
      const xml = await request('PROPFIND', directory, new Set([207, 404]), PROPFIND_BODY,
        { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, 'text');
      if (!xml) continue;
      if (!/<(?:[\w.-]+:)?multistatus\b/i.test(xml)) throw new Error(`WebDAV PROPFIND 状态码 207 路径 ${directory.pathname}（无效 XML）`);
      for (const item of elements(xml, 'response')) {
        if (++entriesCount > BACKUP_LIST_MAX_ENTRIES_COUNT) throw backupLimitError();
        const href = elements(item, 'href')[0];
        if (!href) continue;
        const url = new URL(decodeXml(href.trim()), directory);
        // 远端返回值不能诱导带认证访问别的主机或备份根目录之外。
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) continue;
        const relative = decodeURIComponent(url.pathname.slice(base.pathname.length)).replace(/\/$/, '');
        if (!relative) continue;
        if (keyParts(relative).length > BACKUP_LIST_MAX_DEPTH_LEVELS) throw backupLimitError();
        const props = elements(item, 'propstat').filter(block => /HTTP\/\S+\s+200\b/.test(elements(block, 'status')[0] || '')).join('');
        if (!props) continue;
        if (/<(?:[\w.-]+:)?collection\b/i.test(props)) {
          if (!url.pathname.endsWith('/')) url.pathname += '/';
          if (!queued.has(url.href)) {
            if (queued.size >= BACKUP_LIST_MAX_PAGES_COUNT) throw backupLimitError();
            queued.add(url.href);
            queue.push(url);
          }
        } else {
          const size = Number(elements(props, 'getcontentlength')[0]);
          const mtimeMs = Date.parse(decodeXml(elements(props, 'getlastmodified')[0] || ''));
          files.set(relative, { key: relative, size: Number.isFinite(size) && size >= 0 ? size : 0, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 });
        }
      }
    }
    return [...files.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.key.localeCompare(b.key));
  }

  return {
    type: 'webdav',
    async test() {
      try {
        await mkdir(requireRoot());
        await list();
        return { ok: true, message: 'WebDAV 连接成功' };
      } catch (error) { return { ok: false, message: error.message }; }
    },
    list,
    async put(key, buffer) {
      requireRoot();
      if (!Buffer.isBuffer(buffer)) throw new Error('put 需要 Buffer');
      const url = fileUrl(key);
      await mkdir(new URL('.', url));
      await request('PUT', url, new Set([200, 201, 204]), buffer);
    },
    async get(key) { return request('GET', fileUrl(key), new Set([200]), undefined, {}, 'buffer'); },
    async remove(key) { await request('DELETE', fileUrl(key), new Set([200, 202, 204, 404])); }
  };
}

export default { createWebdavTarget };
