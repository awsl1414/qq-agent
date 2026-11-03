import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fetch } from 'undici';
import { dispatcherFor } from '../../proxy-agent.js';


const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 250;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const ALGORITHM = 'AWS4-HMAC-SHA256';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** pathname is already URI encoded; S3 paths must never be normalized or double encoded. */
export function canonicalRequest({ method, pathname, query = [], headers, payloadHash }) {
  const pairs = [...query].map(([key, value]) => [encode(key), encode(value)]);
  pairs.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  const normalized = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]);
  normalized.sort((a, b) => compare(a[0], b[0]));
  const signedHeaders = normalized.map(([key]) => key).join(';');
  return [method.toUpperCase(), pathname || '/', pairs.map(pair => pair.join('=')).join('&'),
    normalized.map(([key, value]) => `${key}:${value}\n`).join(''), signedHeaders, payloadHash].join('\n');
}

export function stringToSign({ amzDate, region, request }) {
  return [ALGORITHM, amzDate, `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`, sha256(request)].join('\n');
}

export function signS3Request({ method, url, headers = {}, body = Buffer.alloc(0), accessKeyId, secretAccessKey, region, amzDate }) {
  const parsed = new URL(url);
  const signed = { ...headers, host: parsed.host, 'x-amz-content-sha256': sha256(body), 'x-amz-date': amzDate };
  const request = canonicalRequest({ method, pathname: parsed.pathname, query: parsed.searchParams, headers: signed, payloadHash: signed['x-amz-content-sha256'] });
  const toSign = stringToSign({ amzDate, region, request });
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8)), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  const names = Object.keys(signed).map(key => key.toLowerCase()).sort().join(';');
  return { headers: { ...signed, authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope},SignedHeaders=${names},Signature=${signature}` }, canonicalRequest: request, stringToSign: toSign, signature };
}

function xmlText(value) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity.startsWith('#')) return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return entities[entity] ?? all;
  });
}
const tag = (xml, name) => xmlText(xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`))?.[1] || '');

export function buildS3Url(entry, key = '', query = {}) {
  let url;
  try { url = new URL(entry.endpoint || `https://s3.${entry.region || 'us-east-1'}.amazonaws.com`); }
  catch { throw new Error('S3 endpoint 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('S3 endpoint 无效');
  if (!entry.bucket || !/^[a-zA-Z0-9.-]+$/.test(entry.bucket)) throw new Error('S3 bucket 无效');
  if (typeof key !== 'string' || key.startsWith('/') || key.split('/').some(part => part === '.' || part === '..')) throw new Error('S3 key 必须是相对路径');
  const base = url.pathname.replace(/\/$/, '');
  if (entry.forcePathStyle !== false) url.pathname = `${base}/${encode(entry.bucket)}/${key.split('/').map(encode).join('/')}`;
  else {
    url.hostname = `${entry.bucket}.${url.hostname}`;
    url.pathname = `${base}/${key.split('/').map(encode).join('/')}`;
  }
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

export function createS3Target(entry = {}) {
  async function request(method, key = '', query = {}, body) {
    // 凭据由 targets/index.js 的 createTarget 统一解封后以 secretAccessKey 传入。
    // 这里不再自己解密：两处都解会让"改了解密口径"变成要改两个地方。
    if (entry.__credentialError) throw new Error(entry.__credentialError);
    const url = buildS3Url(entry, key, query);
    const secret = entry.secretAccessKey;
    if (!entry.accessKeyId || !secret) throw new Error('S3 凭据缺失');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const { headers } = signS3Request({ method, url, body, accessKeyId: entry.accessKeyId, secretAccessKey: secret, region: entry.region || 'us-east-1', amzDate });
      let response;
      try {
        response = await fetch(url, { method, headers, body, dispatcher: dispatcherFor(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'manual' });
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        await response.body?.cancel();
      } catch {
        // 网络中断和超时可能是外部瞬态故障；不传递底层错误，避免回显凭据。
        if (attempt === MAX_RETRIES) throw new Error('S3 请求失败或超时');
      }
      if (response && (!RETRY_STATUSES.has(response.status) || attempt === MAX_RETRIES)) throw new Error(`S3 请求失败（HTTP ${response.status}）`);
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  async function list() {
    const result = [];
    const seen = new Set();
    let token = '';
    do {
      const query = { 'list-type': '2', prefix: String(entry.prefix || '') };
      if (token) query['continuation-token'] = token;
      const xml = (await request('GET', '', query)).toString('utf8');
      if (!/<(?:[\w-]+:)?ListBucketResult(?:\s|>)/.test(xml)) throw new Error('S3 列表响应无效');
      for (const match of xml.matchAll(/<(?:[\w-]+:)?Contents(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?Contents>/g)) {
        const key = tag(match[1], 'Key');
        const size = Number(tag(match[1], 'Size'));
        if (!key || !Number.isFinite(size) || size < 0) throw new Error('S3 列表响应无效');
        result.push({ key, size, mtimeMs: Date.parse(tag(match[1], 'LastModified')) || 0 });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : '';
      if (tag(xml, 'IsTruncated') === 'true' && (!token || seen.has(token))) throw new Error('S3 分页响应无效');
      seen.add(token);
    } while (token);
    return result;
  }
  return {
    type: 's3',
    test: async () => {
      try { await list(); return { ok: true, message: 'S3 连接成功' }; }
      catch (error) { return { ok: false, message: error.message }; }
    },
    list,
    put: async (key, buffer) => { if (!Buffer.isBuffer(buffer)) throw new TypeError('S3 上传内容必须是 Buffer'); await request('PUT', key, {}, buffer); },
    get: key => request('GET', key),
    remove: async key => { await request('DELETE', key); }
  };
}
