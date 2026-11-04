// 会话列表出口的 `sentCount` 契约（F1）。
//
// 背景：session.sent 有三个读取方，历史上前两个（详情 HTTP、SSE）已经统一成
// publicSentEntries，列表出口却什么都不带，导致：
//   · 引导第 5 步「去群里 @ 它一句」永远不打勾（读 state.sessions[].sent 恒 undefined）
//   · 已发过消息的失败会话仍显示「重试」，点下去被后端 409 拒绝
// 现在列表摘要给一个 sentCount，作为"这条会话发出去过东西"的唯一口径，
// 前端不得再从别的字段推断。
//
// 这里同时守住三件事：
//   ① #summary() 输出 sentCount，且与 s.sent.length 一致；
//   ② 索引从磁盘重建（无缓存 / 缓存版本失配 / 后台对账）后 sentCount 仍是真值；
//   ③ listSummaries() 不夹带整份 sent（列表只暴露必要信息）。
//
// 全程不联网：只碰临时数据目录里的会话文件。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-count-contract-'));
process.env.QQ_AGENT_DATA_DIR = temp;

const { SessionRegistry, publicSentEntry, sentCountOf } = await import('../src/sessions.js');
const { DATA_DIR } = await import('../src/config.js');

after(() => fs.rmSync(temp, { recursive: true, force: true }));

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_CACHE_FILE = path.join(DATA_DIR, 'session-index-cache.json');

/** 直接写一份会话文件（模拟"上一次运行留下的历史会话"）。 */
function writeSessionFile(id, { sent = [], status = 'done', startedAt = 1 } = {}) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const data = {
    id,
    chatKey: 'group:1',
    startedAt,
    endedAt: startedAt + 1,
    status,
    messages: [],
    sent,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data), 'utf8');
  return data;
}

/** 造一条模拟的已发送记录（只用到对外契约里的字段）。 */
const sentEntry = (i) => ({ type: 'text', text: `第 ${i} 条`, at: '10:00:00', src: null });

test('#summary() 输出 sentCount，且与 s.sent.length 一致', () => {
  const reg = new SessionRegistry(0);
  try {
    const withSent = reg.create({ chatKey: 'group:a', trigger: 'message', triggerSummary: 't' });
    withSent.sent.push(sentEntry(1), sentEntry(2), sentEntry(3));
    reg.update(withSent.id);

    const none = reg.create({ chatKey: 'group:b', trigger: 'message', triggerSummary: 't' });
    reg.update(none.id);

    const list = reg.listSummaries(100);
    const a = list.find((s) => s.id === withSent.id);
    const b = list.find((s) => s.id === none.id);
    assert.ok(a && b, '两条会话都应出现在列表里');
    assert.equal(a.sentCount, 3);
    assert.equal(b.sentCount, 0);
    // 唯一口径：摘要里只给计数，不带整份 sent
    assert.equal('sent' in a, false, '列表摘要不得夹带 sent');
    assert.deepEqual(Object.keys(a).filter((k) => k.includes('sent')), ['sentCount']);
    // 口径函数与摘要同源：别处（SSE 广播）要同一个数时不能各算一套
    assert.equal(sentCountOf(withSent), 3);
    assert.equal(sentCountOf(none), 0);
    assert.equal(sentCountOf({}), 0, '没有 sent 字段时为 0，不抛错');
  } finally {
    reg.flushIndexCache();
  }
});

test('索引从磁盘重建（写文件 → 新实例重载）后 sentCount 仍正确', () => {
  // 先清掉可能由上一个用例写入的缓存与内存索引：完全走「无缓存慢路径」。
  fs.rmSync(INDEX_CACHE_FILE, { force: true });
  writeSessionFile('reload-with-sent', { sent: [sentEntry(1), sentEntry(2)], startedAt: 100 });
  writeSessionFile('reload-no-sent', { sent: [], startedAt: 200 });

  const first = new SessionRegistry(0);
  const firstList = first.listSummaries(100);
  assert.equal(firstList.find((s) => s.id === 'reload-with-sent').sentCount, 2);
  assert.equal(firstList.find((s) => s.id === 'reload-no-sent').sentCount, 0);
  first.flushIndexCache();   // 落缓存，模拟正常退出

  // 第二个实例：走缓存快路径，缓存条目里的 sentCount 必须还在
  const second = new SessionRegistry(0);
  const cached = second.listSummaries(100);
  assert.equal(cached.find((s) => s.id === 'reload-with-sent').sentCount, 2,
    '缓存快路径不得丢失 sentCount');
  assert.equal(cached.find((s) => s.id === 'reload-no-sent').sentCount, 0);
  second.flushIndexCache();
});

test('缓存版本失配（旧缓存没有 sentCount）→ 从会话文件补算', () => {
  // 构造上游版本残留：条目里没有 sentCount
  const stale = {
    version: 2,
    savedAt: Date.now(),
    entries: [
      { id: 'reload-with-sent', chatKey: 'group:1', startedAt: 100, status: 'done' },
      { id: 'reload-no-sent', chatKey: 'group:1', startedAt: 200, status: 'done' }
    ]
  };
  fs.writeFileSync(INDEX_CACHE_FILE, JSON.stringify(stale), 'utf8');

  const reg = new SessionRegistry(0);
  try {
    const list = reg.listSummaries(100);
    assert.equal(list.find((s) => s.id === 'reload-with-sent').sentCount, 2,
      '版本失配时必须重建索引而不是沿用缺字段的旧缓存');
    assert.equal(list.find((s) => s.id === 'reload-no-sent').sentCount, 0);
  } finally {
    reg.flushIndexCache();
  }
});

test('后台对账补读的新会话也带 sentCount', async () => {
  fs.rmSync(INDEX_CACHE_FILE, { force: true });
  // 先建一个只有空目录的实例（没有任何会话文件），再把文件"从外部"写进来
  for (const f of fs.readdirSync(SESSIONS_DIR)) fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
  const reg = new SessionRegistry(0);
  assert.equal(reg.listSummaries(100).length, 0);

  writeSessionFile('late-session', { sent: [sentEntry(1), sentEntry(2), sentEntry(3), sentEntry(4)] });
  await reg.reconcileInBackground();

  const entry = reg.listSummaries(100).find((s) => s.id === 'late-session');
  assert.ok(entry, '对账后应补读新文件');
  assert.equal(entry.sentCount, 4);
  reg.flushIndexCache();
});

test('引导判据（后端契约）：含 sent 的会话 sentCount > 0，不含的为 0', () => {
  // ui/app/18-onboarding.js 由另一路改造，本任务只钉后端契约：
  // 第 5 步应当能凭 sentCount 判断"机器人真的回过话"。
  fs.rmSync(INDEX_CACHE_FILE, { force: true });
  for (const f of fs.readdirSync(SESSIONS_DIR)) fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
  writeSessionFile('answered', { sent: [sentEntry(1)], startedAt: 1 });
  writeSessionFile('silent', { sent: [], startedAt: 2 });

  const reg = new SessionRegistry(0);
  try {
    const list = reg.listSummaries(100);
    assert.equal(list.filter((s) => Number(s.sentCount) > 0).length, 1);
    assert.equal(list.find((s) => s.id === 'answered').sentCount, 1);
    assert.equal(list.find((s) => s.id === 'silent').sentCount, 0);
  } finally {
    reg.flushIndexCache();
  }
});

// ── preview 字段：四种组合 ────────────────────────────────────────────────
test('publicSentEntry 的 preview：image+src / image+无src / text+无src / sticker+无src', () => {
  const cases = [
    { entry: { type: 'image', text: '[图片]', at: '1', src: 'https://example.com/a.png' }, want: 'ok' },
    { entry: { type: 'image', text: '[随机图]', at: '1', src: null }, want: 'missing' },
    { entry: { type: 'text', text: '普通消息', at: '1', src: null }, want: 'none' },
    { entry: { type: 'sticker', text: '[表情包:x]', at: '1', src: null }, want: 'missing' }
  ];
  for (const { entry, want } of cases) {
    assert.equal(publicSentEntry(entry).preview, want, `${entry.type}/${entry.src} 应为 ${want}`);
  }
  // 其它媒体类型同样归到 missing（语音 / 视频），非媒体（工具补记）归 none
  for (const type of ['voice', 'audio', 'video', 'record']) {
    assert.equal(publicSentEntry({ type, text: 'x', at: '1', src: null }).preview, 'missing', type);
  }
  assert.equal(publicSentEntry({ type: 'tool', text: '[语音 · tts_send_voice]', at: '1', src: null }).preview, 'none');
  // 脏数据：src 不是受控地址（宿主路径 / 非法协议）时按"拿不到预览"处理
  assert.equal(publicSentEntry({ type: 'image', text: 'x', at: '1', src: '/etc/passwd' }).preview, 'missing');
  assert.equal(publicSentEntry({ type: 'image', text: 'x', at: '1', src: 'javascript:alert(1)' }).preview, 'missing');
});
