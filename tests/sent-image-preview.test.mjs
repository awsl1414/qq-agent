// 会话「已发送」里的图片缩略图。
//
// 两端各测一半，都不碰网络、也不引 DOM 框架：
//   · 后端（src/tools.js 的 send_image）：成功后往 session.sent 记的条目必须带
//     原始 http(s) 直链（字段名 src），且不把 base64 / 本地路径写进去
//     （会话文件整份落盘）。
//   · 前端（ui/app/02-sse-sessions.js 的 sentImageUrl / sentBadgeHtml）：带合法
//     src 的条目走缩略图分支，src 缺失或协议不合法时退回原来的文字徽标。
//
// 前端是普通脚本（无 import/export），按 tests/connection-token-toggle.test.mjs
// 的做法把两段纯函数切出来在 vm 里跑。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';

// ── 前端：切出纯函数 ────────────────────────────────────────────────────
const uiSource = fs.readFileSync(new URL('../ui/app/02-sse-sessions.js', import.meta.url), 'utf8');
const sentStart = uiSource.indexOf('const SENT_IMAGE_PROTOCOLS');
const sentEnd = uiSource.indexOf('function bindSentImageFallback', sentStart);
assert.ok(sentStart > 0 && sentEnd > sentStart, '02-sse-sessions.js 里找不到缩略图渲染段');

const ui = vm.runInNewContext(
  `${uiSource.slice(sentStart, sentEnd)}
   ({ sentImageUrl, sentBadgeHtml })`,
  {
    URL,   // vm 新上下文里没有 Node 的 Web API 全局，显式给进去
    // 与 00-core.js 的 esc() 同一个实现（跨脚本共享的顶层绑定）
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
);

test('图片条目：合法 http(s) 直链 → 渲染缩略图，保留标签与 note 文字', () => {
  const html = ui.sentBadgeHtml({
    type: 'image',
    text: '[图片:猫]',
    src: 'https://i.pixiv.re/img-original/1.jpg',
    preview: 'ok',
    at: '12:00:00'
  });
  assert.match(html, /class="sent-badge sent-badge--image"/);
  assert.match(html, /<img class="sent-thumb__img" data-error-quiet="1" src="https:\/\/i\.pixiv\.re\/img-original\/1\.jpg"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /alt="\[图片:猫\]"/);  assert.match(html, /已发送到 QQ · 12:00:00/);
  assert.match(html, /class="sent-thumb__note">\[图片:猫\]/);
  assert.match(html, /class="sent-thumb__broken" hidden/);
});

test('preview 不是 ok → 不出现 img；missing 明确标「（无预览）」', () => {
  for (const entry of [
    { type: 'image', text: '[图片]', at: '12:00:00', preview: 'missing' },
    { type: 'image', text: '[图片]', src: '', at: '12:00:00', preview: 'missing' },
    { type: 'image', text: '[图片]', src: null, at: '12:00:00', preview: 'missing' },
    { type: 'text', text: '普通消息', at: '12:00:00', src: null, preview: 'none' },
    // 旧字段不再有第二条渲染路径：preview 说了算，url 不参与
    { type: 'image', text: '[图片]', url: 'https://example.com/a.jpg', at: '12:00:00', preview: 'missing' }
  ]) {
    const html = ui.sentBadgeHtml(entry);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="sent-badge/);
    assert.match(html, new RegExp(entry.text.replace(/[[\]]/g, '\\$&')));
    if (entry.preview === 'missing') assert.match(html, /（无预览）/);
    else assert.doesNotMatch(html, /（无预览）/);
  }
});

test('协议白名单：非 http(s) 与畸形地址一律当作没有 src', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'not a url',
    '   '
  ]) {
    assert.equal(ui.sentImageUrl({ type: 'image', text: '[图片]', src: url }), '', url);
  }
  assert.equal(ui.sentImageUrl({ type: 'image', src: 'HTTPS://Example.com/a.jpg' }), 'https://example.com/a.jpg');
});

test('HTML 属性经过 esc()：引号与尖括号不能逃出属性', () => {
  const html = ui.sentBadgeHtml({
    type: 'image',
    text: '"[x]" <b>',
    src: 'https://example.com/a.jpg?"onload="alert(1)',
    preview: 'ok',
    at: '1"2'
  });
  // URL 本身在解析阶段就会被规范化，但 text / at 仍必须转义
  assert.match(html, /alt="&quot;\[x\]&quot; &lt;b&gt;"/);
  assert.match(html, /已发送到 QQ · 1&quot;2/);
  assert.doesNotMatch(html, /<b>/);
});

// ── 后端：send_image 的记账契约 ────────────────────────────────────────
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-image-preview-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { buildToolDefs } = await import('../src/tools.js');
const { updateConfig } = await import('../src/config.js');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 起一个只服务固定 PNG 的本机图床（不开外网）。 */
async function startImageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_1X1.length });
    res.end(PNG_1X1);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('send_image 成功后 sent 条目带原始 http(s) 直链（src），不带 base64 / 本地路径', async () => {
  const { server, port } = await startImageServer();
  try {
    // 本机图床是内网地址，需要显式放开（与用户自建图床的真实配置同一开关）
    updateConfig({ security: { allowPrivateImageHosts: true, imageSend: { requirePreview: false } } });
    const tool = buildToolDefs().find((d) => d.id === 'send_image');
    const sourceUrl = `http://127.0.0.1:${port}/cat.png`;
    const session = { id: 'session-1', sent: [] };
    const sentToQQ = [];
    const ctx = {
      chatKey: 'group:1',
      session,
      emit() {},
      sender: { sendImage: async (chatKey, img) => { sentToQQ.push({ chatKey, img }); return { message_id: 42 }; } }
    };

    const result = await tool.execute(ctx, { url: sourceUrl, note: '猫' });
    assert.equal(JSON.parse(result.content).sent, true);

    assert.equal(session.sent.length, 1);
    const entry = session.sent[0];
    assert.equal(entry.type, 'image');
    assert.equal(entry.src, sourceUrl);
    assert.equal(entry.text, '[图片:猫]');
    assert.ok(entry.at);
    // 落盘契约：只有 URL，没有内联数据，也没有宿主路径
    assert.doesNotMatch(JSON.stringify(entry), /base64|data:image|\/tmp\/|file:\/\//);
    // sender 收到的仍是 url + dataUrl 回退（本任务不改发送链路）
    assert.equal(sentToQQ[0].img.url, sourceUrl);
  } finally {
    server.close();
  }
});
