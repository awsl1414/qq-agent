// random-image 的纯函数测试：响应解析 + 配置归一 + 请求 URL + provider 输出契约。
// 不联网、不读磁盘配置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImageUrls } from '../skills/random-image/response.js';
import { normalizeConfig, buildProviderResult } from '../skills/random-image/index.js';
import { buildPicUrl } from '../skills/random-image/setu.js';
import { setLogger } from '../skills/random-image/log.js';
import { DEFAULT_SETU_BASE_URL } from '../skills/random-image/config.js';

// ── extractImageUrls：只覆盖有真实接口出处的 4 种结构 ────────────────────

test('cnmiw：{pic:[url]}', () => {
  const body = { pic: ['https://setu.iw233.top/large/a.jpg', 'https://setu.iw233.top/large/b.jpg'] };
  assert.deepEqual(extractImageUrls(body), body.pic);
});

test('lolicon v2：{data:[{urls:{regular}}]}', () => {
  const body = { error: '', data: [{ pid: 1, urls: { regular: 'https://i.pixiv.re/img-master/r.jpg' } }] };
  assert.deepEqual(extractImageUrls(body), ['https://i.pixiv.re/img-master/r.jpg']);
});

test('lolicon v2：urls 只有 original 时也能取到', () => {
  const body = { data: [{ urls: { original: 'https://i.pixiv.re/img-original/o.jpg' } }] };
  assert.deepEqual(extractImageUrls(body), ['https://i.pixiv.re/img-original/o.jpg']);
});

test('lolicon v2：regular 为空串时改用其它非空键，不被空串挡住', () => {
  const body = { data: [{ urls: { regular: '', original: 'https://i.pixiv.re/img-original/o.jpg' } }] };
  assert.deepEqual(extractImageUrls(body), ['https://i.pixiv.re/img-original/o.jpg']);
});

test('lolicon v1：{data:[{url}]}', () => {
  const body = { code: 0, count: 1, data: [{ pid: 1, url: 'https://i.pixiv.re/img-original/v1.jpg' }] };
  assert.deepEqual(extractImageUrls(body), ['https://i.pixiv.re/img-original/v1.jpg']);
});

test('anosu / jitsu：{pics:[url]}', () => {
  const body = { code: 200, pics: ['https://pic.example/a.jpeg', 'https://pic.example/b.jpeg'] };
  assert.deepEqual(extractImageUrls(body), body.pics);
});

test('空数组返回 []', () => {
  assert.deepEqual(extractImageUrls({ error: '', data: [] }), []);
  assert.deepEqual(extractImageUrls({ pic: [] }), []);
});

test('未知结构返回 [] 并 warn 顶层键名', (t) => {
  const warnings = [];
  setLogger({ warn: (msg) => warnings.push(String(msg)) });
  t.after(() => setLogger(null));
  assert.deepEqual(extractImageUrls({ result: { url: 'x' } }), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /result/);
});

test('日志未注入时静默：不抛错、不写 console', (t) => {
  const calls = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(originals)) console[k] = (...a) => calls.push([k, ...a]);
  t.after(() => { for (const [k, fn] of Object.entries(originals)) console[k] = fn; setLogger(null); });
  setLogger(null);
  assert.deepEqual(extractImageUrls({ result: { url: 'x' } }), []);
  assert.deepEqual(calls, []);
});

test('pickUrlStrings 过滤空串与纯空白，不被其挡住（经 extractImageUrls 观测面）', () => {
  assert.deepEqual(extractImageUrls({ pic: ['', null, 'https://a/b.jpg', '  '] }), ['https://a/b.jpg']);
  assert.deepEqual(extractImageUrls({ pics: ['', 'https://a/c.jpg', 42] }), ['https://a/c.jpg']);
});

test('嵌套缺字段被过滤：urls 为空对象 / 缺 url / 非字符串', () => {
  const body = {
    data: [
      { urls: {} },                       // 空 urls
      { urls: { regular: '' } },          // 空串
      { urls: { regular: 123 } },         // 非字符串
      { pid: 1 },                         // 没有 urls / url
      null,
      { urls: { regular: 'https://ok.example/x.jpg' } }
    ]
  };
  assert.deepEqual(extractImageUrls(body), ['https://ok.example/x.jpg']);
});

test('数组形式的响应体（不是对象）返回 []', () => {
  assert.deepEqual(extractImageUrls(['https://a.example/1.jpg']), []);
  assert.deepEqual(extractImageUrls(null), []);
  assert.deepEqual(extractImageUrls('not json'), []);
});

test('同一响应混合结构时按顶层字段优先，不跨字段拼接', () => {
  const body = { pic: ['https://pic.example/1.jpg'], data: [{ url: 'https://data.example/2.jpg' }] };
  assert.deepEqual(extractImageUrls(body), ['https://pic.example/1.jpg']);
});

// ── normalizeConfig：apiBaseUrl 映射到 api.baseUrl ──────────────────────

test('normalizeConfig：apiBaseUrl 为空时回落到默认接口', () => {
  const cfg = normalizeConfig({ apiBaseUrl: '' });
  assert.equal(cfg.api.baseUrl, DEFAULT_SETU_BASE_URL);
});

test('normalizeConfig：apiBaseUrl 未配置时回落到默认接口', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.api.baseUrl, DEFAULT_SETU_BASE_URL);
});

test('normalizeConfig：apiBaseUrl 有值时原样使用', () => {
  const cfg = normalizeConfig({ apiBaseUrl: 'https://api.cnmiw.com/api.php' });
  assert.equal(cfg.api.baseUrl, 'https://api.cnmiw.com/api.php');
});

test('嵌套 api.baseUrl 不再作为配置来源，扁平键是唯一入口', () => {
  // 该分支曾为「程序化配置」保留，但全仓没有调用方，已删除（不留兼容代码）。
  const cfg = normalizeConfig({
    api: { baseUrl: 'https://nested.example/setu' },
    apiBaseUrl: 'https://flat.example/setu'
  });
  assert.equal(cfg.api.baseUrl, 'https://flat.example/setu');
  // 只给了嵌套键时也不能生效，必须回落到默认值
  assert.equal(normalizeConfig({ api: { baseUrl: 'https://nested.example/setu' } }).api.baseUrl,
    DEFAULT_SETU_BASE_URL);
});

test('normalizeConfig：sort 默认值与安全模式映射', () => {
  const cfg = normalizeConfig({ safeMode: true });
  assert.equal(cfg.api.nsfwSort, 'CDNsetu');
  assert.equal(cfg.api.sfwSort, 'CDNcat');
  assert.equal(cfg.send.nsfwAllowed, false);
  assert.equal(cfg.nsfwFilter.enabled, true);
});

// ── provider → 发送层的字段契约 ─────────────────────────────────────────
//
// 真实故障（已实测复现）：providers['image.random'] 曾把取图结果映射成
// `{ url }`，而 toSendable 只读 `image.file || image.payload`，于是 src 恒为空，
// 用户看到「图片发送失败：图片读取失败」。取图成功 ≠ 能发出去。
// 这里直接调**真实的 toSendable**，锁住 provider 输出形状与发送层读法一致。

test('toSendable：能读出 downloader 契约里的本地文件路径', async (t) => {
  const { toSendable } = await import('../skills/random-image/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-sendable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.jpg');
  // 1x1 JPEG 的最小字节，避免依赖真实图片
  fs.writeFileSync(file, Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

  // downloader 契约：file 与 payload 都指向同一本地路径
  const got = await toSendable({ file, payload: file, bytes: 4, mime: 'image/jpeg' });
  assert.ok(typeof got === 'string' && got.startsWith('base64://'),
    `toSendable 应把本地文件读成 base64://，实际：${JSON.stringify(got)}`);
  assert.ok(got.length > 'base64://'.length, 'base64 内容不能为空');

  // 只有 payload（base64 模式）时同样可用
  assert.equal(await toSendable({ payload: 'base64://AAAA' }), 'base64://AAAA');
  // 只有 http 直链时原样返回
  assert.equal(await toSendable({ file: 'https://example.com/a.jpg' }), 'https://example.com/a.jpg');

  // 旧 bug 的形态：只有 url 键 → 取不到地址 → null
  assert.equal(await toSendable({ url: file }), null,
    'url 键不被识别——这正是旧 provider 映射导致「图片读取失败」的原因');
});

// ── provider 输出契约：驱动真实的映射函数 ───────────────────────────────
//
// 上一组只测了 toSendable 的**输入**，provider 的**输出**形状仍无人锁定，
// 把映射改回 {url} 时全量测试照样全绿 —— 这就是同一个故障可以静默复发的原因。
// 这里直接调 provider 使用的唯一映射函数 buildProviderResult（纯函数，方案 a）：
// 比桩替换 runSetuRequest（方案 b）少一层模块内部状态，且不必联网。

test('buildProviderResult：输出 {file, payload}，不是 {url}', async (t) => {
  const { toSendable } = await import('../skills/random-image/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setu-provider-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'b.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  // downloader 的完整返回值（含 url 之外的字段），映射后只保留发送层认的两个键
  const out = buildProviderResult({
    outcome: 'ok',
    images: [
      { payload: file, file, bytes: 8, mime: 'image/png' },
      { payload: 'base64://QUJD', file: null }
    ]
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.images, [
    { file, payload: file },
    { file: null, payload: 'base64://QUJD' }
  ]);
  assert.equal('url' in out.images[0], false, 'provider 不能输出 url 键（toSendable 不读它）');

  // 契约闭环：provider 的输出必须能被真实 toSendable 消费
  assert.ok(String(await toSendable(out.images[0])).startsWith('base64://'));
  assert.equal(await toSendable(out.images[1]), 'base64://QUJD');
});

test('buildProviderResult：非 ok 结果转换为 ok:false 并带上原因', () => {
  assert.deepEqual(buildProviderResult({ outcome: 'no-image', message: '接口暂时拉不到图' }),
    { ok: false, images: [], error: '接口暂时拉不到图' });
  // 没有 message 时用 outcome 兜底，不能是 undefined
  assert.deepEqual(buildProviderResult({ outcome: 'cooldown' }),
    { ok: false, images: [], error: 'cooldown' });
  assert.deepEqual(buildProviderResult(null),
    { ok: false, images: [], error: 'image unavailable' });
});

// ── buildPicUrl：取图接口 query 契约 ────────────────────────────────────
//
// 接口对多传/少传/拼错参数都返回 200，只是内容不对：参数拼错的表现是
// "拉不到图"或"单图超大下载失败"，从发送链路根本看不出问题来源。
// 所以这里逐项锁住 query，去掉/改错任何一项都应让测试变红。

const parseQuery = (url) => new URL(url).searchParams;
const API = { baseUrl: DEFAULT_SETU_BASE_URL };

test('buildPicUrl：nsfw 分类传 r18=1，sfw 分类传 r18=0', () => {
  assert.equal(parseQuery(buildPicUrl(API, '', 1, { nsfw: true })).get('r18'), '1');
  assert.equal(parseQuery(buildPicUrl(API, '', 1, { nsfw: false })).get('r18'), '0');
});

test('buildPicUrl：任何分类都带 size=regular 与 type=json', () => {
  for (const nsfw of [true, false]) {
    const q = parseQuery(buildPicUrl(API, 'CDNsetu', 3, { nsfw }));
    assert.equal(q.get('size'), 'regular');
    assert.equal(q.get('type'), 'json');
  }
});

test('buildPicUrl：num 被 clamp 到 MAX_COUNT', () => {
  // MAX_COUNT = 10，超出上限的请求要压回 10，避免接口一次返回上百个 URL
  assert.equal(parseQuery(buildPicUrl(API, '', 999, { nsfw: false })).get('num'), '10');
  assert.equal(parseQuery(buildPicUrl(API, '', 3, { nsfw: false })).get('num'), '3');
  assert.equal(parseQuery(buildPicUrl(API, '', 0, { nsfw: false })).get('num'), '1');
});

test('buildPicUrl：sort 透传，未给时为空串', () => {
  assert.equal(parseQuery(buildPicUrl(API, 'CDNsetu', 1, { nsfw: true })).get('sort'), 'CDNsetu');
  assert.equal(parseQuery(buildPicUrl(API, undefined, 1, { nsfw: false })).get('sort'), '');
});

test('buildPicUrl：用户自填地址里已有的 query 保留', () => {
  const q = parseQuery(buildPicUrl({ baseUrl: 'https://x.com/api?foo=1' }, '', 1, { nsfw: false }));
  assert.equal(q.get('foo'), '1');
  assert.equal(q.get('num'), '1');
});
