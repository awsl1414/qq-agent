// 内容分级（全局策略 + core 闸门 + 旧配置迁移）的单元测试。
//
// 分级逻辑曾经散在 random-image 技能里（safeMode / booru.strictSfw / booru.onlyR0），
// 第三方扩展既读不到也管不住。现在档位与派生规则只在 src/content-rating.js 定义，
// core 在 sender.sendImage 统一执行。这组测试锁住那张派生表与四档行为矩阵。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-content-rating-'));
process.env.QQ_AGENT_DATA_DIR = temp;
const { CONTENT_RATINGS, DECLARED_RATINGS, ratingRule, currentContentRating, exceedsPolicy, ratingRejection } =
  await import('../src/content-rating.js');
const { migrateContentRating, loadConfig, updateConfig, CONFIG_FILE } = await import('../src/config.js');
const { applyContentPolicy, illustRating } = await import('../skills/random-image/filters.js');
const { SendQueue } = await import('../src/sender.js');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// ── 派生表：全项目唯一的一处定义 ────────────────────────────────────────

test('ratingRule：四档的过滤规则', () => {
  assert.deepEqual(ratingRule('all'), { blockR18: false, blockR15: false, onlyR0: false });
  assert.deepEqual(ratingRule('r18'), { blockR18: true, blockR15: false, onlyR0: false });
  assert.deepEqual(ratingRule('strict'), { blockR18: true, blockR15: true, onlyR0: false });
  assert.deepEqual(ratingRule('r0'), { blockR18: true, blockR15: true, onlyR0: true });
});

test('ratingRule：未知 / 空值一律回落 strict（安全侧）', () => {
  for (const bad of [undefined, null, '', 'R18', 'nsfw', 1, {}]) {
    assert.deepEqual(ratingRule(bad), ratingRule('strict'), `ratingRule(${JSON.stringify(bad)}) 应回落 strict`);
  }
});

test('CONTENT_RATINGS 与 DECLARED_RATINGS 是两组不同的值', () => {
  assert.deepEqual(CONTENT_RATINGS, ['all', 'r18', 'strict', 'r0']);
  assert.deepEqual(DECLARED_RATINGS, ['safe', 'r15', 'r18']);
});

test('currentContentRating：读配置，非法值回落 strict', () => {
  assert.equal(currentContentRating({ security: { contentRating: 'all' } }), 'all');
  assert.equal(currentContentRating({ security: { contentRating: 'r0' } }), 'r0');
  assert.equal(currentContentRating({ security: { contentRating: 'bogus' } }), 'strict');
  assert.equal(currentContentRating({ security: {} }), 'strict');
  assert.equal(currentContentRating({}), 'strict');
});

test('exceedsPolicy：声明 × 策略矩阵', () => {
  // declared = safe 永不超限
  for (const policy of CONTENT_RATINGS) assert.equal(exceedsPolicy('safe', policy), false);
  // r15 只在 strict / r0 下超限
  assert.equal(exceedsPolicy('r15', 'all'), false);
  assert.equal(exceedsPolicy('r15', 'r18'), false);
  assert.equal(exceedsPolicy('r15', 'strict'), true);
  assert.equal(exceedsPolicy('r15', 'r0'), true);
  // r18 除 all 之外都超限
  assert.equal(exceedsPolicy('r18', 'all'), false);
  assert.equal(exceedsPolicy('r18', 'r18'), true);
  assert.equal(exceedsPolicy('r18', 'strict'), true);
  assert.equal(exceedsPolicy('r18', 'r0'), true);
});

test('ratingRejection：未知声明 / 超策略返回文案，放行返回 null', () => {
  assert.equal(ratingRejection('safe', 'r0'), null);
  assert.equal(ratingRejection('r15', 'all'), null);
  assert.equal(ratingRejection('r18', 'all'), null);   // 合法值先校验，再判超限
  assert.match(ratingRejection('r15', 'strict'), /内容分级[\s\S]*设置 → 聊天与权限 → 内容分级/);
  assert.match(ratingRejection('R-18', 'all'), /未知的内容分级声明/);
});

// ── 四档行为矩阵（候选过滤 + 漏斗数字）────────────────────────────────
//
// 用同一组带分级标记的候选，验证 applyContentPolicy 在四档下的放行结果。
// fetchBooruPage 调的就是这个函数，所以漏斗数字与真实搜索路径同源。

const CANDIDATES = [
  { id: 'r18', restrict: 1, categories: ['R-18'] },
  { id: 'r15', sanity_level: 2, categories: ['R-15'] },
  { id: 'r0', categories: ['R-0'] },
  // 非 R-18 / 非 R-15，但分类里不是纯 R-0：只有「仅 R-0」这一档会把它拦下，
  // 用来证明 r0 那一级确实独立生效（否则 r0 档的漏斗永远看不出差别）。
  { id: 'other', categories: ['一般'] }
];

const keptIds = (rating) => applyContentPolicy(CANDIDATES, rating).illusts.map((il) => il.id);

test('四档行为矩阵：all / r18 / strict / r0', () => {
  // 每档的放行结果
  assert.deepEqual(keptIds('all'), ['r18', 'r15', 'r0', 'other']);
  assert.deepEqual(keptIds('r18'), ['r15', 'r0', 'other']);
  assert.deepEqual(keptIds('strict'), ['r0', 'other']);
  assert.deepEqual(keptIds('r0'), ['r0']);

  // 每档的漏斗：原始 4 → r18 后 → r15 后 → r0 后
  assert.deepEqual(applyContentPolicy(CANDIDATES, 'all').funnel, { afterR18: 4, afterR15: 4, afterR0: 4 });
  assert.deepEqual(applyContentPolicy(CANDIDATES, 'r18').funnel, { afterR18: 3, afterR15: 3, afterR0: 3 });
  assert.deepEqual(applyContentPolicy(CANDIDATES, 'strict').funnel, { afterR18: 3, afterR15: 2, afterR0: 2 });
  assert.deepEqual(applyContentPolicy(CANDIDATES, 'r0').funnel, { afterR18: 3, afterR15: 2, afterR0: 1 });
});

test('illustRating：Pixiv 元数据 → 发送时声明的分级', () => {
  assert.equal(illustRating({ restrict: 1 }), 'r18');
  assert.equal(illustRating({ sanity_level: 6 }), 'r18');
  assert.equal(illustRating({ sanity_level: 2 }), 'r15');
  assert.equal(illustRating({ categories: ['R-15'] }), 'r15');
  assert.equal(illustRating({ categories: ['R-0'] }), 'safe');
  assert.equal(illustRating({}), 'safe');
});

// ── 旧配置迁移 ──────────────────────────────────────────────────────────

const withSkill = (skillCfg) => ({ skills: { 'random-image': skillCfg } });

test('迁移：booru.onlyR0 优先 → r0', () => {
  const out = migrateContentRating(withSkill({ safeMode: false, booru: { onlyR0: true } }));
  assert.equal(out.security.contentRating, 'r0');
});

test('迁移：safeMode:false → all', () => {
  assert.equal(migrateContentRating(withSkill({ safeMode: false })).security.contentRating, 'all');
});

test('迁移：booru.strictSfw:false → r18', () => {
  assert.equal(migrateContentRating(withSkill({ booru: { strictSfw: false } })).security.contentRating, 'r18');
});

test('迁移：safeMode:true / 未设 → 不写 contentRating（默认 strict）', () => {
  const out = migrateContentRating(withSkill({ safeMode: true }));
  assert.equal(out.security, undefined, '默认档位不该被写进配置');
  assert.equal(loadConfigWith({ skills: { 'random-image': { safeMode: true } } }).security.contentRating, 'strict');
});

test('迁移：用户显式设过 contentRating 时不被旧键覆盖', () => {
  const out = migrateContentRating({
    security: { contentRating: 'all' },
    skills: { 'random-image': { safeMode: true, booru: { onlyR0: true } } }
  });
  assert.equal(out.security.contentRating, 'all');
});

test('迁移：旧键被删除，代码里不再有第二处读取点', () => {
  const out = migrateContentRating(withSkill({ safeMode: false, booru: { onlyR0: true, strictSfw: false, candidates: 20 } }));
  const skill = out.skills['random-image'];
  assert.equal('safeMode' in skill, false);
  assert.equal('onlyR0' in skill.booru, false);
  assert.equal('strictSfw' in skill.booru, false);
  assert.equal(skill.booru.candidates, 20, '其它配置必须原样保留');
});

test('迁移：旧键删空后不留空 booru 壳', () => {
  const out = migrateContentRating(withSkill({ booru: { onlyR0: true } }));
  assert.equal('booru' in out.skills['random-image'], false, '空对象没有语义，留着只是配置噪音');
  // 还有其它 booru 配置时必须保留
  const kept = migrateContentRating(withSkill({ booru: { onlyR0: true, candidates: 20 } }));
  assert.deepEqual(kept.skills['random-image'].booru, { candidates: 20 });
});

test('迁移：幂等（迁移结果再迁一次不变）', () => {
  const once = migrateContentRating(withSkill({ safeMode: false, booru: { onlyR0: true } }));
  const twice = migrateContentRating(once);
  assert.equal(twice.security.contentRating, 'r0');
});

test('迁移：加载链端到端（config.json 里的旧键被折算成 contentRating）', () => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    skills: { 'random-image': { safeMode: false, booru: { onlyR0: true } } }
  }), 'utf8');
  const cfg = loadConfig();
  assert.equal(cfg.security.contentRating, 'r0');
  fs.rmSync(CONFIG_FILE, { force: true });
});

/** 把一段配置写盘后完整走一遍 loadConfig（用完即删）。 */
function loadConfigWith(parsed) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed), 'utf8');
  try {
    return loadConfig();
  } finally {
    fs.rmSync(CONFIG_FILE, { force: true });
  }
}

// ── core 闸门（模拟第三方扩展直接调 sendImage）──────────────────────────

function makeSender(t, sentCalls) {
  // sendImage 内含真人化停顿，测试里让 setTimeout 立即回调
  t.mock.method(globalThis, 'setTimeout', (fn) => { fn(); return { unref() {} }; });
  const onebot = {
    sendImage: async () => { sentCalls.push(1); return { message_id: sentCalls.length }; },
    sendSegments: async () => { sentCalls.push(1); return { message_id: sentCalls.length }; }
  };
  const store = { appendSelf() {} };
  return new SendQueue({ onebot, store });
}

test('core 闸门：strict 策略下声明 r18 → 拒发，文案指向设置页', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'strict' } });
  await assert.rejects(
    sender.sendImage('group:123', { dataUrl: 'base64://AAAA' }, { rating: 'r18' }),
    /内容分级[\s\S]*设置 → 聊天与权限 → 内容分级/
  );
  assert.equal(sentCalls.length, 0, '被拦截时不能真的发出去');
});

test('core 闸门：all 策略下声明 r18 → 正常发出', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'all' } });
  await sender.sendImage('group:123', { dataUrl: 'base64://BBBB' }, { rating: 'r18' });
  assert.equal(sentCalls.length, 1);
});

test('core 闸门：r18 策略放行 r15，但 R-18 仍然被拦（与四档矩阵一致）', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'r18' } });
  await sender.sendImage('group:123', { dataUrl: 'base64://BBBB' }, { rating: 'r15' });
  assert.equal(sentCalls.length, 1);
  await assert.rejects(
    sender.sendImage('group:123', { dataUrl: 'base64://EEEE' }, { rating: 'r18' }),
    /内容分级/
  );
  assert.equal(sentCalls.length, 1);
});

test('core 闸门：未声明 rating → 放行（AI 生图等没有分级概念的来源）', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'r0' } });
  await sender.sendImage('group:123', { dataUrl: 'base64://CCCC' }, {});
  assert.equal(sentCalls.length, 1);
});

test('core 闸门：未知声明值 → 拒发（拼错的分级不能被静默放行）', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'all' } });
  await assert.rejects(
    sender.sendImage('group:123', { dataUrl: 'base64://DDDD' }, { rating: 'R-18' }),
    /未知的内容分级声明/
  );
  assert.equal(sentCalls.length, 0);
});

// ── core 闸门：sendMedia 的图片段（第三方出图主要路径）──────────────────
//
// 抖音图文 / 视频等媒体走 sendMedia → onebot.sendSegments。闸门必须同样生效，
// 否则「全局策略」对这条路径只是一句空话。

test('core 闸门：sendMedia 段级 rating 超策略 → 整批拒发', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'strict' } });
  await assert.rejects(
    sender.sendMedia('group:123', [{ type: 'image', data: { file: 'a.jpg' }, rating: 'r18' }]),
    /内容分级[\s\S]*设置 → 聊天与权限 → 内容分级/
  );
  assert.equal(sentCalls.length, 0, '被拦截时不能真的发出去');
});

test('core 闸门：sendMedia 的 options.rating 同样受策略约束', async (t) => {
  const sentCalls = [];
  const sender = makeSender(t, sentCalls);
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'strict' } });
  await assert.rejects(
    sender.sendMedia('group:123', [{ type: 'image', data: { file: 'b.jpg' } }], { rating: 'r15' }),
    /内容分级/
  );
  assert.equal(sentCalls.length, 0);
  // safe 在任何档位都放行
  await sender.sendMedia('group:123', [{ type: 'image', data: { file: 'c.jpg' } }], { rating: 'safe' });
  assert.equal(sentCalls.length, 1);
});

test('core 闸门：sendMedia 未声明 rating → 放行，且 rating 字段不透传给 OneBot', async (t) => {
  let received = null;
  t.mock.method(globalThis, 'setTimeout', (fn) => { fn(); return { unref() {} }; });
  const onebot = {
    sendSegments: async (kind, id, segs) => {
      received = segs;
      return { message_id: 1 };
    }
  };
  const sender = new SendQueue({ onebot, store: { appendSelf() {} } });
  updateConfig({ allowAllWhenEmpty: false, allow: { groups: ['123'], private: [] }, security: { contentRating: 'r0' } });
  await sender.sendMedia('group:123', [
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'image', data: { file: 'y.jpg' }, rating: 'safe' }
  ]);
  assert.deepEqual(received, [
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'image', data: { file: 'y.jpg' } }
  ]);
});
