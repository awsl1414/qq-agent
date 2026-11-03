import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebdavTarget } from '../src/backup/targets/webdav.js';

const PASSWORD = 'do-not-leak-this-password';
const AUTH = `Basic ${Buffer.from(`user:${PASSWORD}`).toString('base64')}`;
const MTIME = 'Tue, 03 Nov 2026 03:00:00 GMT';
const escapeXml = value => value.replaceAll('&', '&amp;');

async function fixture(t) {
  const dirs = new Set(['/']);
  const files = new Map();
  const calls = [];
  let transientFailures = 0;
  const server = http.createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, depth: req.headers.depth });
    if (req.headers.authorization !== AUTH) { res.writeHead(401).end(PASSWORD); return; }
    if (req.url.includes('retry') && transientFailures++ === 0) { res.writeHead(503).end(); return; }
    if (req.url.includes('denied')) { res.writeHead(403).end(PASSWORD); return; }
    const parent = req.url.replace(/[^/]+\/?$/, '');
    if (req.method === 'MKCOL') {
      if (dirs.has(req.url)) { res.writeHead(405).end(); return; }
      if (!dirs.has(parent)) { res.writeHead(409).end(); return; }
      dirs.add(req.url); res.writeHead(201).end(); return;
    }
    if (req.method === 'PUT') {
      if (!dirs.has(parent)) { res.writeHead(409).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      files.set(req.url, Buffer.concat(chunks)); res.writeHead(201).end(); return;
    }
    if (req.method === 'GET') {
      if (!files.has(req.url)) { res.writeHead(404).end(PASSWORD); return; }
      res.end(files.get(req.url)); return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(files.delete(req.url) ? 204 : 404).end(); return;
    }
    if (req.method === 'PROPFIND') {
      if (!dirs.has(req.url)) { res.writeHead(404).end(PASSWORD); return; }
      const child = key => key.startsWith(req.url) && !key.slice(req.url.length).replace(/\/$/, '').includes('/');
      const entries = [...dirs].filter(child).map(key => [key, true]).concat([...files.keys()].filter(child).map(key => [key, false]));
      const xml = entries.map(([key, dir]) => `<D:response><D:href>${escapeXml(key)}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype><D:getcontentlength>${files.get(key)?.length || 0}</D:getcontentlength><D:getlastmodified>${MTIME}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<D:multistatus xmlns:D="DAV:">${xml}</D:multistatus>`); return;
    }
    res.writeHead(405).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/nas/backups`;
  const target = createWebdavTarget({ url, username: 'user', password: PASSWORD });
  return { target, calls, files, url };
}

test('WebDAV local server: MKCOL, recursive Depth 1 listing, binary PUT/GET and DELETE with Basic auth', async t => {
  const { target, calls } = await fixture(t);
  assert.equal((await target.test()).ok, true);
  const buffer = Buffer.from([0, 255, 1, 128]);
  const key = 'qq-agent/nested/中文 & file.qqab';
  await target.put(key, buffer);
  assert.deepEqual(await target.get(key), buffer);
  assert.deepEqual(await target.list(), [{ key, size: buffer.length, mtimeMs: Date.parse(MTIME) }]);
  await target.remove(key);
  await target.remove(key);
  assert.deepEqual(await target.list(), []);
  assert.ok(calls.some(call => call.method === 'MKCOL' && call.path === '/nas/backups/qq-agent/nested/'));
  assert.ok(calls.filter(call => call.method === 'PROPFIND').every(call => call.depth === '1'));
  assert.ok(calls.every(call => call.auth === AUTH));
  assert.ok(['MKCOL', 'PROPFIND', 'PUT', 'GET', 'DELETE'].every(method => calls.some(call => call.method === method)));
});

test('errors report status/path without response body or password; test never throws', async t => {
  const { target, calls, url } = await fixture(t);
  assert.deepEqual(await target.list(), []);
  await assert.rejects(target.get('missing.qqab'), error => {
    assert.match(error.message, /404.*\/nas\/backups\/missing.qqab/);
    assert.ok(!error.message.includes(PASSWORD)); return true;
  });
  await assert.rejects(target.put('../escape', Buffer.from('x')), /非法/);
  const invalid = createWebdavTarget({ url: `http://user:${PASSWORD}@localhost/` });
  assert.equal((await invalid.test()).ok, false);
  assert.ok(!(await invalid.test()).message.includes(PASSWORD));
  await assert.rejects(target.get('denied.qqab'), /403.*\/nas\/backups\/denied.qqab/);
  assert.equal(calls.filter(call => call.path.endsWith('denied.qqab')).length, 1);
  const unauthorized = createWebdavTarget({ url, username: 'user', password: 'wrong' });
  const result = await unauthorized.test();
  assert.equal(result.ok, false);
  assert.match(result.message, /401.*\/nas\//);
  assert.ok(!result.message.includes(PASSWORD));
});

test('transient status retries preserve request body and authorization', async t => {
  const { target, calls } = await fixture(t);
  await target.put('retry.qqab', Buffer.from('retry payload'));
  assert.equal((await target.get('retry.qqab')).toString(), 'retry payload');
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
});
