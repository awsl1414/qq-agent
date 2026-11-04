// security.allowPrivateImageHosts 在全部出站路径上的二态行为。
//
// 背景：这个开关原先只有图片下载路径读，网页抓取（用户报障的图片搜索就走
// safeFetch）不读，于是"图片能下载但图片搜索仍被 SSRF 拒绝"。统一读取点
// （safe-fetch.js 的 allowPrivateOutbound）之后，五条导出路径都必须读同一个开关。
// 本文件逐条钉住这一点：任一函数被改回"不读开关"，对应断言立即变红。
//
// 只连本机 127.0.0.1 的假服务器，不开外网。
//
// 运行：node --test tests/outbound-private-switch.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// 数据目录必须在 import 之前固定：config.js 在模块求值时读取 QQ_AGENT_DATA_DIR，
// 之后 updateConfig 会把配置写进这个目录。
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-private-switch-'));
process.env.QQ_AGENT_DATA_DIR = temp;

const {
  safeFetch,
  guardedFetch,
  safeFetchBinary,
  safeFetchBinaryToFile,
  validateImageUrl
} = await import('../src/safe-fetch.js');
const { updateConfig } = await import('../src/config.js');

const BODY_TEXT = 'hello from local server';
const BODY_BYTES = Buffer.from('local-binary-payload');
const DENIED = /禁止访问内网\/本机地址|域名解析到内网\/本机地址/;

/** 起一个只服务固定内容的假服务器，返回 { server, port, url }。 */
async function startLocalServer() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/bin')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BODY_BYTES.length });
      res.end(BODY_BYTES);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(BODY_TEXT);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, url: (p = '/') => `http://127.0.0.1:${port}${p}` };
}

/** 用例体内切换开关；用例结束（含失败）一定复位为关闭。 */
function withPrivateSwitch(allowed, fn) {
  updateConfig({ security: { allowPrivateImageHosts: allowed } });
  return Promise.resolve()
    .then(fn)
    .finally(() => updateConfig({ security: { allowPrivateImageHosts: false } }));
}

const local = await startLocalServer();
after(() => {
  local.server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('safeFetch：默认拒绝本机地址，开关打开后拿到 body', async () => {
  const target = local.url('/text');
  await withPrivateSwitch(false, async () => {
    await assert.rejects(safeFetch(target), DENIED);
  });
  await withPrivateSwitch(true, async () => {
    const res = await safeFetch(target);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, BODY_TEXT);
  });
});

test('guardedFetch：默认（browseLocked: true）拒绝本机地址，开关打开后拿到 body', async () => {
  const target = local.url('/text');
  await withPrivateSwitch(false, async () => {
    await assert.rejects(guardedFetch(target, {}, { browseLocked: false }), DENIED);
  });
  await withPrivateSwitch(true, async () => {
    const res = await guardedFetch(target, {}, { browseLocked: false });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), BODY_TEXT);
  });
});

test('safeFetchBinary：默认拒绝，开关打开后拿到完整 buffer', async () => {
  const target = local.url('/bin');
  await withPrivateSwitch(false, async () => {
    await assert.rejects(safeFetchBinary(target), DENIED);
  });
  await withPrivateSwitch(true, async () => {
    const { buffer, contentType } = await safeFetchBinary(target);
    assert.ok(buffer.equals(BODY_BYTES));
    assert.match(contentType, /application\/octet-stream/);
  });
});

test('safeFetchBinaryToFile：默认拒绝且不落盘，开关打开后文件存在且字节正确', async () => {
  const target = local.url('/bin');
  const dest = path.join(temp, 'download.bin');
  await withPrivateSwitch(false, async () => {
    await assert.rejects(safeFetchBinaryToFile(target, dest, 1024 * 1024), DENIED);
    assert.equal(fs.existsSync(dest), false, '拒绝后不应留下文件');
  });
  await withPrivateSwitch(true, async () => {
    const { bytes } = await safeFetchBinaryToFile(target, dest, 1024 * 1024);
    assert.equal(bytes, BODY_BYTES.length);
    assert.ok(fs.readFileSync(dest).equals(BODY_BYTES));
  });
});

test('validateImageUrl：默认拒绝本机地址，开关打开后原样返回', async () => {
  const target = local.url('/cat.png');
  await withPrivateSwitch(false, async () => {
    await assert.rejects(validateImageUrl(target), DENIED);
  });
  await withPrivateSwitch(true, async () => {
    assert.equal(await validateImageUrl(target), target);
  });
});
