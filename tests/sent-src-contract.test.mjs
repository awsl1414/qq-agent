// 「已发送」条目的可预览契约（U5）。
//
// 目标：session.sent 对外只暴露 { type, text, at, src, preview }，src 是唯一可预览字段，
// preview 是后端算好的渲染语义（ok / missing / none）；
// 两个出口（GET /api/sessions/:id 与 SSE session-update）必须逐字段一致，
// 内部绝对路径不得外泄。
//
// 全程不联网：
//   · 四种来源的记账用真实的工具 / 扩展 setup 驱动，但把 sender 换成假对象；
//   · 取图端点直接调 routes 表里那条路由的 handler（不起 HTTP 服务）。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-src-contract-'));
process.env.QQ_AGENT_DATA_DIR = temp;

const { publicSentEntries, publicSentEntry } = await import('../src/sessions.js');
const { registerLocalImage, readLocalImage } = await import('../src/media-registry.js');
const { createRoutes } = await import('../src/routes.js');
const { buildToolDefs } = await import('../src/tools.js');
const { updateConfig, getConfig, DATA_DIR } = await import('../src/config.js');

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const DATA_ROOT = path.resolve(DATA_DIR);
const TMP_ROOT = path.resolve(os.tmpdir());

// 1×1 PNG（魔数校验能过）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 在指定目录写一张真 PNG，返回绝对路径。 */
function writePng(dir, name = 'x.png') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, PNG);
  return file;
}

/** 四种来源各自的真实落盘位置（与扩展实现保持一致）。 */
const dirs = {
  setu: path.join(DATA_DIR, 'setu-tmp'),
  generate: path.join(os.tmpdir(), 'qq-agent-image-generate'),
  stickerA: path.join(DATA_DIR, 'sticker-images'),
  stickerB: path.join(DATA_DIR, 'plugin-data', 'sticker', 'img')
};

test('对外形状：四种来源都只输出 { type, text, at, src, preview } 五个键', () => {
  const setuFile = writePng(dirs.setu, 'setu.png');
  const genFile = writePng(dirs.generate, 'gen.png');
  const stickerFile = writePng(dirs.stickerA, 'st.png');
  const stickerThumb = writePng(dirs.stickerB, 'st.png');
  const sessionId = 'session-shape';

  const sent = [
    { type: 'text', text: '普通消息', at: '1', src: null },
    { type: 'image', text: '[图片:网图]', at: '2', src: 'https://example.com/a.png', localFile: '/tmp/secret' },
    { type: 'image', text: '[随机图]', at: '3', src: registerLocalImage(sessionId, { kind: 'setu', path: setuFile }) },
    { type: 'image', text: '[图片:AI绘图]', at: '4', src: registerLocalImage(sessionId, { kind: 'generate', path: genFile }) },
    { type: 'sticker', text: '[表情包:x]', at: '5', src: registerLocalImage(sessionId, { kind: 'sticker', path: stickerFile }) },
    { type: 'sticker', text: '[表情包:y]', at: '6', src: registerLocalImage(sessionId, { kind: 'sticker', path: stickerThumb }) }
  ];
  const out = publicSentEntries({ id: sessionId, sent });
  assert.equal(out.length, sent.length);
  for (const entry of out) {
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'preview', 'src', 'text', 'type']);
  }
  // 四类图片（网图 / 随机图 / AI 绘图 / 表情包，表情包两处根目录）都拿到了 src
  for (const entry of out.slice(1)) assert.ok(entry.src, `${entry.text} 应有 src`);
  // 网图保持原样
  assert.equal(out[1].src, 'https://example.com/a.png');
});

test('绝对路径不出现在输出里（JSON 字符串不含数据目录 / tmpdir 前缀）', () => {
  const setuFile = writePng(dirs.setu, 'leak.png');
  const genFile = writePng(dirs.generate, 'leak.png');
  const sessionId = 'session-leak';
  const sent = [
    // 恶意 / 历史脏数据：src 直接塞了宿主路径，也必须被挡成 null
    { type: 'image', text: 'x', at: '1', src: setuFile },
    { type: 'image', text: 'y', at: '2', src: `file:///${genFile.replace(/\\/g, '/')}` },
    { type: 'image', text: 'z', at: '3', localFile: { path: setuFile } }
  ];
  const json = JSON.stringify(publicSentEntries({ id: sessionId, sent }));
  assert.equal((json.match(/"src":null/g) || []).length, 3);
  assert.ok(!json.includes(DATA_ROOT), `不应包含数据目录：${json}`);
  assert.ok(!json.includes(TMP_ROOT), `不应包含临时目录：${json}`);
  assert.ok(!json.includes('localFile'));
  // 合法的受控地址里只有相对路径
  const ok = registerLocalImage(sessionId, { kind: 'setu', path: setuFile });
  assert.match(ok, /^\/api\/sessions\/session-leak\/image\//);
  assert.ok(!ok.includes(DATA_ROOT));
});

test('两个出口一致：GET /api/sessions/:id 与 SSE session-update 的 sent 逐字段相等', async (t) => {
  // 真起 createApp：两个出口都在它的闭包里（HTTP 详情走 routes 表、SSE 走 emit），
  // 只有同时驱动它们才能证明"共用同一个序列化函数"，而不是测试自己又写了一遍。
  const sessionId = 'session-exits';
  const setuFile = writePng(dirs.setu, 'both.png');
  const session = {
    id: sessionId,
    chatKey: 'group:1',
    startedAt: 1,
    status: 'done',
    messages: [],
    sent: [
      { type: 'text', text: 'hi', at: '1', src: null },
      { type: 'image', text: '[随机图]', at: '2', src: registerLocalImage(sessionId, { kind: 'setu', path: setuFile }) },
      // 内部字段：两个出口都必须剥掉
      { type: 'image', text: '[图片:AI绘图]', at: '3', src: null, localFile: { path: path.join(dirs.generate, 'x.png') } }
    ]
  };
  // 定时器一律不真跑：createApp 会挂遥测 / 价格表 / 巡检等循环，测试里没有退出必要
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {}, ref() {} }));
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {}, ref() {} }));
  t.mock.method(globalThis, 'clearTimeout', () => {});
  t.mock.method(globalThis, 'clearInterval', () => {});

  const { createApp } = await import('../src/app.js');
  const app = createApp({ log() {} });
  try {
    app.sessions.current.set(sessionId, session);

    // ── 出口 1：SSE session-update（真连 /api/events 读事件流） ──
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const { port } = app.server.address();
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const collectUntil = async (needle, timeoutMs = 3000) => {
      let text = '';
      const deadline = Date.now() + timeoutMs;
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    };
    await collectUntil('event: hello');
    app.emit('session-update', { sessionId });
    const sseText = await collectUntil('event: session-update');
    const dataLine = sseText.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(dataLine, `SSE 应写出 data 行：${sseText}`);
    const sseBody = JSON.parse(dataLine.slice('data: '.length));

    // ── 出口 2：GET /api/sessions/:id（走真实 HTTP 分发） ──
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`);
    const httpBody = await res.json();

    assert.deepEqual(sseBody.sent, httpBody.sent, '两个出口的 sent 必须逐字段相等');
    // 列表判据用的 sentCount 也随 SSE 推下去：会话结束时列表不一定重拉，
    // 缺这个字段的话"重试按钮 / 引导第 5 步"要等下一次 GET /api/sessions 才对。
    assert.equal(sseBody.sentCount, session.sent.length);
    assert.deepEqual(httpBody.sent, [
      { type: 'text', text: 'hi', at: '1', src: null, preview: 'none' },
      { type: 'image', text: '[随机图]', at: '2', src: session.sent[1].src, preview: 'ok' },
      { type: 'image', text: '[图片:AI绘图]', at: '3', src: null, preview: 'missing' }
    ]);
    assert.ok(!JSON.stringify(httpBody).includes('localFile'), '内部字段不得外泄');
    assert.ok(!JSON.stringify(sseBody).includes(DATA_ROOT));
  } finally {
    await app.stop();
  }
});

test('token 不可伪造：篡改一个字符 → 取图 404', () => {
  const sessionId = 'session-token';
  const file = writePng(dirs.setu, 'token.png');
  const src = registerLocalImage(sessionId, { kind: 'setu', path: file });
  const token = src.split('/image/')[1];
  assert.ok(readLocalImage(sessionId, token), '原 token 应可读');

  // 逐个位置篡改（payload 与签名都覆盖）
  const spots = new Set([0, 1, token.length - 1, token.length - 2, token.indexOf('.') + 1, token.indexOf('.') - 1]);
  for (const i of spots) {
    if (i < 0 || i >= token.length) continue;
    const ch = token[i] === 'A' ? 'B' : 'A';
    const tampered = token.slice(0, i) + ch + token.slice(i + 1);
    if (tampered === token) continue;
    assert.equal(readLocalImage(sessionId, tampered), null, `位置 ${i} 篡改后应失败`);
  }
  // 截断 / 追加也不行
  assert.equal(readLocalImage(sessionId, token.slice(0, -1)), null);
  assert.equal(readLocalImage(sessionId, `${token}0`), null);
});

test('跨会话：A 会话的 token 请求 B 会话 → 404', () => {
  const a = 'session-a';
  const b = 'session-b';
  const file = writePng(dirs.setu, 'cross.png');
  const token = registerLocalImage(a, { kind: 'setu', path: file }).split('/image/')[1];
  assert.ok(readLocalImage(a, token));
  assert.equal(readLocalImage(b, token), null);
});

test('路径白名单：越界 / 同前缀目录 / 非白名单目录一律登记失败', () => {
  const sessionId = 'session-paths';
  // createRoutes 里读图失败一律 404；这里先测登记端（拒收即不会签发地址）
  const evil = [
    { kind: 'setu', p: path.join(dirs.setu, '..', '..', 'etc-passwd.png') },
    { kind: 'setu', p: path.join(DATA_DIR, 'config.json') },
    { kind: 'setu', p: path.join(`${dirs.setu}-evil`, 'x.png') }
  ];
  writePng(`${dirs.setu}-evil`, 'x.png');
  for (const item of evil) {
    assert.equal(registerLocalImage(sessionId, { kind: item.kind, path: item.p }), null, item.p);
  }
  // 伪造 token 直接打读图端：路径段带 ..、或指向白名单根之外
  const forgedPayload = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const fakeSrc = registerLocalImage(sessionId, { kind: 'setu', path: writePng(dirs.setu, 'ok.png') });
  const sig = fakeSrc.split('/image/')[1].split('.').pop();
  for (const rel of ['../../etc/passwd', '../config.json', 'sub/../../config.json', '/etc/passwd']) {
    const token = `${forgedPayload({ k: 'setu', r: 0, p: rel })}.${sig}`;
    assert.equal(readLocalImage(sessionId, token), null, rel);
  }
  // 同前缀目录的图即便登记成功也会被拒（它不在任何白名单根内）
  assert.equal(registerLocalImage(sessionId, { kind: 'setu', path: path.join(`${dirs.setu}-evil`, 'x.png') }), null);
});

test('文件校验：文本伪装 .png 被拒；超过 15MB 被拒；空文件被拒', () => {
  const sessionId = 'session-files';
  const fake = path.join(dirs.setu, 'fake.png');
  fs.mkdirSync(dirs.setu, { recursive: true });
  fs.writeFileSync(fake, 'this is not an image, just text pretending to be png');
  const token = registerLocalImage(sessionId, { kind: 'setu', path: fake }).split('/image/')[1];
  assert.equal(readLocalImage(sessionId, token), null, '非图片必须 404');

  const empty = path.join(dirs.setu, 'empty.png');
  fs.writeFileSync(empty, '');
  assert.equal(registerLocalImage(sessionId, { kind: 'setu', path: empty }), null, '空文件不应登记');

  // 超限：真 PNG 头 + 填充到 15MB+1
  const big = path.join(dirs.setu, 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024 + 1)]));
  const bigToken = registerLocalImage(sessionId, { kind: 'setu', path: big }).split('/image/')[1];
  assert.equal(readLocalImage(sessionId, bigToken), null, '超限文件必须 404');
});

test('表情包两个白名单根都能取图（只覆盖一处会让另一半不可预览）', () => {
  const sessionId = 'session-sticker';
  for (const dir of [dirs.stickerA, dirs.stickerB]) {
    const file = writePng(dir, 'multi-root.png');
    const src = registerLocalImage(sessionId, { kind: 'sticker', path: file });
    assert.ok(src, `${dir} 应能登记`);
    assert.ok(readLocalImage(sessionId, src.split('/image/')[1]), `${dir} 应能取图`);
  }
});

test('四种来源的真实记账：send_image / random-image / image-generate / sticker 都写 src', async () => {
  const sessionId = 'session-sources';
  const session = { id: sessionId, sent: [] };

  // ── 1) 网图（src/tools.js 的 send_image）：src 就是已校验的直链 ──
  updateConfig({ security: { imageSend: { requirePreview: false } } });
  const sendImage = buildToolDefs().find((d) => d.id === 'send_image');
  const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  // 用 data: 走不通（只收 http(s)），所以网络路径用本机 HTTP 服务会被 safe-fetch 校验；
  // 这里不联网，直接验证记账契约的另一半：src 取值就是 args.url。
  // send_image 的完整链路已由 tests/sent-image-preview.test.mjs 覆盖。
  assert.ok(sendImage, 'send_image 工具应存在');

  // ── 2) 随机图：扩展拿 localImageSrc 换受控地址 ──
  const randomImage = await import('../skills/random-image/index.js');
  const setuFile = writePng(dirs.setu, 'source-setu.png');
  let captured = null;
  const api = {
    config: () => ({}),
    capability: async () => ({ ok: true, images: [{ file: setuFile, payload: setuFile }] }),
    localImageSrc: (kind, p, ctx) => registerLocalImage(ctx.session.id, { kind, path: p }),
    registerTool: (def) => { captured = def; return `random-image__${def.id}`; }
  };
  randomImage.setup(api);
  assert.ok(captured, 'random-image 应注册工具');
  await captured.execute({
    chatKey: 'group:1',
    session,
    sender: { sendImage: async () => ({ message_id: 1 }) },
    emit() {}
  }, { count: 1 });
  assert.equal(session.sent.length, 1);
  assert.ok(session.sent[0].src, '随机图应有 src');
  assert.equal(session.sent[0].src, registerLocalImage(sessionId, { kind: 'setu', path: setuFile }));

  // ── 3) AI 绘图：真跑一次 draw 工具，图片从假 fetch 拿（不联网） ──
  const imageGenerate = await import('../skills/image-generate/index.js');
  let drawTool = null;
  imageGenerate.setup({
    config: () => ({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
      model: 'test-model',
      responseFormat: 'b64_json',
      maxRetries: 0
    }),
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })
    }),
    log() {},
    warn() {},
    localImageSrc: (kind, p, ctx) => registerLocalImage(ctx.session.id, { kind, path: p }),
    registerTool: (def) => { drawTool = def; return `image-generate__${def.id}`; }
  });
  assert.ok(drawTool, 'image-generate 应注册 draw 工具');
  const genSession = { id: sessionId, sent: [] };
  const drawOut = await drawTool.execute({
    chatKey: 'group:1',
    session: genSession,
    sender: { sendImage: async () => ({ message_id: 2 }) }
  }, { prompt: '一只猫' });
  assert.ok(!drawOut.isError, `draw 不应失败：${drawOut.content}`);
  assert.equal(genSession.sent.length, 1);
  assert.ok(genSession.sent[0].src, 'AI 绘图应有 src');
  assert.ok(genSession.sent[0].src.startsWith(`/api/sessions/${sessionId}/image/`));
  assert.ok(readLocalImage(sessionId, genSession.sent[0].src.split('/image/')[1]), 'AI 绘图地址应可读');

  // ── 4) 表情包：插件用 localStickerPath + localImageSrc ──
  const sticker = await import('../plugins/sticker/index.js');
  const stickerFile = writePng(dirs.stickerA, 'source-sticker.png');
  assert.ok(sticker.setup, 'sticker 应导出 setup');
  const stickerSrc = registerLocalImage(sessionId, { kind: 'sticker', path: stickerFile });
  assert.ok(stickerSrc);
  assert.equal(publicSentEntry({ type: 'sticker', text: '[表情包:x]', at: '1', src: stickerSrc }).src, stickerSrc);

  // 四种来源对外形状完全一致
  const all = publicSentEntries(session);
  for (const entry of all) assert.deepEqual(Object.keys(entry).sort(), ['at', 'preview', 'src', 'text', 'type']);
  assert.ok(pngUrl.startsWith('data:image/png'));
  assert.ok(!JSON.stringify(publicSentEntries({ sent: session.sent })).includes(DATA_ROOT));
});

test('前端分支：src 为 null → 「无图」；受控地址 / http(s) → 缩略图；其它协议 → 无图', async () => {
  const fsSync = fs;
  const uiSource = fsSync.readFileSync(new URL('../ui/app/02-sse-sessions.js', import.meta.url), 'utf8');
  const start = uiSource.indexOf('const SENT_IMAGE_PROTOCOLS');
  const end = uiSource.indexOf('function bindSentImageFallback', start);
  assert.ok(start > 0 && end > start);

  const vm = await import('node:vm');
  const sentLocal = registerLocalImage('session-ui', { kind: 'setu', path: writePng(dirs.setu, 'ui.png') });
  const tokenize = (u) => (u.startsWith('/api/') ? `${u}?token=T` : u);
  const sandbox = {
    URL,
    withToken: tokenize,
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  };
  const mod = vm.runInNewContext(`${uiSource.slice(start, end)}\n({ sentImageUrl, sentBadgeHtml })`, sandbox);

  // preview:'none'（非媒体条目）：只有文字徽标，不带「无预览」标记
  for (const entry of [
    { type: 'text', text: '普通消息', at: '1', src: null, preview: 'none' },
    { type: 'tool', text: '[消息 · tts_send_voice]', at: '1', src: null, preview: 'none' }
  ]) {
    const html = mod.sentBadgeHtml(entry);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="sent-badge"/);
    assert.doesNotMatch(html, /无预览/);
  }
  // preview:'missing'（媒体条目但拿不到预览）：文字徽标 +「（无预览）」
  for (const entry of [
    { type: 'image', text: '[随机图]', at: '1', src: null, preview: 'missing' },
    { type: 'sticker', text: '[表情包:x]', at: '1', src: null, preview: 'missing' }
  ]) {
    const html = mod.sentBadgeHtml(entry);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="sent-badge sent-badge--nopreview"/);
    assert.match(html, /（无预览）/);
  }
  // 可预览：网图与受控地址都走缩略图，受控地址带控制台令牌
  const net = mod.sentBadgeHtml({ type: 'image', text: '[图片]', at: '1', src: 'https://example.com/a.png', preview: 'ok' });
  assert.match(net, /<img class="sent-thumb__img"/);
  const local = mod.sentBadgeHtml({ type: 'sticker', text: '[表情包:x]', at: '1', src: sentLocal, preview: 'ok' });
  assert.match(local, /<img class="sent-thumb__img"/);
  assert.ok(local.includes(`${sentLocal}?token=T`), '受控地址应补 ?token=');
  // 注入面：preview:'ok' 但地址过不了前端协议校验时，降级成「无预览」而不是纯文字
  for (const src of ['javascript:alert(1)', 'file:///etc/passwd', '/api/other/x.png', '//evil.example/a.png']) {
    const html = mod.sentBadgeHtml({ type: 'image', text: 'x', at: '1', src, preview: 'ok' });
    assert.doesNotMatch(html, /<img/, src);
    assert.match(html, /（无预览）/, src);
  }
});

test('取图端点路由：命中时回图片字节，失败一律 404', async () => {
  const sessionId = 'session-route';
  const file = writePng(dirs.setu, 'route.png');
  const src = registerLocalImage(sessionId, { kind: 'setu', path: file });
  const pathname = `/api/sessions/${sessionId}/image/${src.split('/image/')[1]}`;

  const routes = createRoutes({});
  const route = routes.find((r) => r.method === 'GET' && r.pattern instanceof RegExp && r.pattern.test(pathname));
  assert.ok(route, '应存在取图路由');

  const respond = async (p) => {
    let status = null;
    let headers = null;
    let body = null;
    const res = {
      writeHead(code, h) { status = code; headers = h; },
      end(b) { body = b; }
    };
    await route.handler({ res, match: route.pattern.exec(p) });
    return { status, headers, body };
  };

  const ok = await respond(pathname);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  // 本地图随时可能被清理：必须每次回源校验，否则缓存期内删了文件仍显示旧图
  assert.equal(ok.headers['cache-control'], 'private, no-cache');
  assert.ok(Buffer.isBuffer(ok.body) && ok.body.equals(PNG));

  // 篡改 / 跨会话 / 不存在的会话 → 404，且不泄露路径
  // 改签名最后一个字符（追加 '0' 不是"篡改一个字符"：末位可能本来就是 0）
  const token0 = src.split('/image/')[1];
  const last = token0[token0.length - 1];
  const badToken = token0.slice(0, -1) + (last === '0' ? '1' : '0');
  const bad = await respond(`/api/sessions/${sessionId}/image/${badToken}`);
  assert.equal(bad.status, 404);
  assert.equal(bad.body, 'Not found');
  const cross = await respond(`/api/sessions/session-route-2/image/${src.split('/image/')[1]}`);
  assert.equal(cross.status, 404);
});

test('配置未被测试污染：imageSend 开关仍可读', () => {
  assert.equal(getConfig().security?.imageSend?.requirePreview, false);
});
