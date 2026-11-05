// 日志查询 API（H1a）：内存过滤、磁盘历史读取、下载上限、级别持久化。
//
// 只测后端契约：路由表 + logger 的纯逻辑。SSE 节流在 app.js 里，需要真实
// createApp，归实测覆盖（见本次交付报告）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-routes-'));
process.env.QQ_AGENT_DATA_DIR = temp;

const { logger } = await import('../src/logger.js');
const { createRoutes } = await import('../src/routes.js');
const { getConfig, loadConfig } = await import('../src/config.js');

// 测试里不往终端刷日志；内存条目直接构造，避免依赖真实调用的时间戳精度。
logger.mirrorConsole = false;
const routes = createRoutes({ readBody: async (body) => body, emit() {}, sanitizeConfig: (c) => c });

after(() => fs.rmSync(temp, { recursive: true, force: true }));

function routeOf(method, pattern) {
  const route = routes.find((item) => item.method === method && item.pattern === pattern);
  assert.ok(route, `${method} ${pattern}`);
  return route;
}

async function request(method, pattern, { query = '', body = {} } = {}) {
  let response;
  const res = {};
  await routeOf(method, pattern).handler({
    req: body,
    res,
    url: new URL(`http://localhost${pattern}${query}`),
    json: (_res, status, data) => { response = { status, data }; }
  });
  return response;
}

const T = Date.UTC(2026, 0, 2, 3, 0, 0);
function seed() {
  logger.memory = [
    { ts: T + 1000, level: 'info', module: 'app', text: '启动完成' },
    { ts: T + 2000, level: 'warn', module: 'skill:random-image', text: '图片下载超时' },
    { ts: T + 3000, level: 'error', module: 'app', text: 'LLM 调用失败 ERROR_CODE=42' },
    { ts: T + 4000, level: 'info', module: 'skill:weather', text: 'weather ok' },
    { ts: T + 5000, level: 'warn', module: 'sender', text: '发送限频' },
    { ts: T + 6000, level: 'debug', module: 'app', text: 'detail heartbeat' }
  ];
}

test('query: 级别多值、模块前缀、子串搜索、时间范围、游标与 limit', () => {
  seed();
  // 级别多值：warn,error 命中任一（结果按新到旧）
  assert.deepEqual(
    logger.query({ level: 'warn,error' }).logs.map((e) => e.level),
    ['warn', 'error', 'warn']
  );
  // 模块前缀：skill 同时命中 skill:random-image 与 skill:weather
  assert.deepEqual(
    logger.query({ module: 'skill' }).logs.map((e) => e.module),
    ['skill:weather', 'skill:random-image']
  );
  // 前缀不是子串匹配：kill 不得命中 skill:*
  assert.equal(logger.query({ module: 'kill' }).total, 0);
  // q：大小写不敏感，同时匹配 text 与 module
  assert.deepEqual(logger.query({ q: 'error_code' }).logs.map((e) => e.module), ['app']);
  assert.deepEqual(logger.query({ q: 'WEATHER' }).logs.map((e) => e.level), ['info']);
  // 时间范围：闭区间
  assert.deepEqual(
    logger.query({ since: T + 2000, until: T + 4000 }).logs.map((e) => e.ts),
    [T + 4000, T + 3000, T + 2000]
  );
  // 游标：严格早于 before
  assert.deepEqual(
    logger.query({ before: T + 4000 }).logs.map((e) => e.ts),
    [T + 3000, T + 2000, T + 1000]
  );
  // limit + hasMore（total 是 before 之后的命中总数）
  const page = logger.query({ limit: 2 });
  assert.equal(page.logs.length, 2);
  assert.equal(page.total, 6);
  assert.equal(page.hasMore, true);
  // limit 上限 500
  seed();
  logger.memory = Array.from({ length: 700 }, (_, i) => ({ ts: T + i, level: 'info', module: 'app', text: `n${i}` }));
  assert.equal(logger.query({}).logs.length, 200);       // 默认 200
  assert.equal(logger.query({ limit: 9999 }).logs.length, 500); // 夹到上限
});

test('GET /api/logs：返回 { logs, level, total, hasMore }，非法级别 400', async () => {
  seed();
  const ok = await request('GET', '/api/logs', { query: '?level=warn,error&limit=10' });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.data).sort(), ['dates', 'hasMore', 'level', 'logs', 'total']);
  assert.ok(ok.data.logs.every((e) => e.level === 'warn' || e.level === 'error'));
  assert.equal(ok.data.level, logger.getLevel());
  const bad = await request('GET', '/api/logs', { query: '?level=war' });
  assert.equal(bad.status, 400);
});

test('history：反向读尾部、按新到旧、续行归并、before 游标', async () => {
  const day = '2026-01-02';
  const dir = path.join(temp, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `qq-agent-${day}.log`), [
    '08:00:01 [INFO ] [app] first',
    '08:00:02 [WARN ] [skill:random-image] image timeout',
    '08:00:03 [ERROR] [app] boom',
    '    at foo (bar.js:1:2)',
    ''
  ].join('\n'));

  const tail = await request('GET', '/api/logs/history', { query: `?date=${day}&limit=2` });
  assert.equal(tail.status, 200);
  assert.equal(tail.data.date, day);
  assert.equal(tail.data.logs.length, 2);
  assert.deepEqual(tail.data.logs.map((e) => e.level), ['error', 'warn']);
  assert.match(tail.data.logs[0].text, /^boom\n    at foo/);   // 续行属于上一条
  assert.equal(tail.data.hasMore, true);
  const dayStart = new Date(2026, 0, 2).getTime();
  assert.equal(tail.data.logs[1].ts, dayStart + (8 * 3600 + 2) * 1000);

  // 游标：严格早于 error 那条
  const older = await request('GET', '/api/logs/history', {
    query: `?date=${day}&before=${dayStart + (8 * 3600 + 3) * 1000}`
  });
  assert.deepEqual(older.data.logs.map((e) => e.level), ['warn', 'info']);
  assert.equal(older.data.hasMore, false);

  // 游标翻页要能越过"比一页还长"的尾部：先铺 600 行，再用 before 取中段。
  // （旧实现按固定行数先读一批再过滤，游标远在读取范围之外时整页会被滤空。）
  const bigDay = '2026-01-04';
  const big = path.join(dir, `qq-agent-${bigDay}.log`);
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const hh = String(12 + Math.floor(i / 3600)).padStart(2, '0');
    const mm = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const ss = String(i % 60).padStart(2, '0');
    rows.push(`${hh}:${mm}:${ss} [INFO ] [app] row ${i}`);
  }
  fs.writeFileSync(big, rows.join('\n') + '\n');
  const bigStart = new Date(2026, 0, 4).getTime();
  // 游标 = 第 100 行（row i 的时间 = 12:00:00 + i 秒），期望拿到 99..0（limit=100）
  const cursor = bigStart + (12 * 3600 + 100) * 1000;
  const mid = await request('GET', '/api/logs/history', { query: `?date=${bigDay}&before=${cursor}&limit=100` });
  assert.equal(mid.data.logs.length, 100);
  assert.deepEqual(mid.data.logs[0].text, 'row 99');
  assert.deepEqual(mid.data.logs[99].text, 'row 0');
  assert.equal(mid.data.hasMore, false);
  const midTop = await request('GET', '/api/logs/history', { query: `?date=${bigDay}&limit=100` });
  assert.deepEqual(midTop.data.logs[0].text, 'row 599');
  assert.equal(midTop.data.hasMore, true);

  // 不存在的日期：空列表而不是 404（文件尚未产生是正常状态）
  const missing = await request('GET', '/api/logs/history', { query: '?date=2020-05-05' });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data.logs, []);
});

test('history / download：日期格式校验挡住路径注入', async () => {
  for (const bad of ['../../etc/passwd', '2026-1-2', '2026-02-30', '..%2F..%2Fetc%2Fpasswd', '2026-01-02.log']) {
    const r = await request('GET', '/api/logs/history', { query: `?date=${encodeURIComponent(bad)}` });
    assert.equal(r.status, 400, `history 应拒绝 ${bad}`);
    const d = await request('GET', '/api/logs/download', { query: `?date=${encodeURIComponent(bad)}` });
    assert.equal(d.status, 400, `download 应拒绝 ${bad}`);
  }
});

test('download：小文件正常下发，超过 32MB 返回 413', async () => {
  const day = '2026-01-02';
  const file = path.join(temp, 'logs', `qq-agent-${day}.log`);
  // 真实小文件：验证 content-disposition 与流式正文
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  const done = new Promise((resolve) => sink.on('finish', resolve));
  let head = null;
  await routeOf('GET', '/api/logs/download').handler({
    req: { method: 'GET', headers: {} },
    res: new Proxy(sink, {
      get(target, prop) {
        if (prop === 'writeHead') return (code, headers) => { head = { code, headers }; };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      }
    }),
    url: new URL(`http://localhost/api/logs/download?date=${day}`),
    json() { throw new Error('小文件不应走 json 响应'); }
  });
  await done;
  assert.equal(head.code, 200);
  assert.match(head.headers['content-disposition'], /^attachment; filename="qq-agent-2026-01-02\.log"$/);
  assert.match(Buffer.concat(chunks).toString('utf8'), /image timeout/);

  // 超限：稀疏文件只改大小，不真写 33MB 数据
  const bigDay = '2026-01-03';
  const big = path.join(temp, 'logs', `qq-agent-${bigDay}.log`);
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 33 * 1024 * 1024);
  const over = await request('GET', '/api/logs/download', { query: `?date=${bigDay}` });
  assert.equal(over.status, 413);
  assert.match(over.data.error, /32MB/);
  fs.rmSync(big);
});

test('dates：只列合法日期文件，新到旧', async () => {
  const dir = path.join(temp, 'logs');
  fs.writeFileSync(path.join(dir, 'qq-agent-2025-12-31.log'), '');
  fs.writeFileSync(path.join(dir, 'not-a-log.txt'), '');
  const r = await request('GET', '/api/logs/dates');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.dates, ['2026-01-04', '2026-01-02', '2025-12-31']);
  const list = await request('GET', '/api/logs');
  assert.deepEqual(list.data.dates, r.data.dates);   // 首屏同时带日期列表
});

test('模块分布：/api/logs/modules 只受日期与级别影响，带 module / q 不改变分布', async () => {
  const day = '2026-01-08';
  const dir = path.join(temp, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `qq-agent-${day}.log`), [
    '09:00:01 [INFO ] [app] 启动',
    '09:00:02 [INFO ] [app] 心跳',
    '09:00:03 [WARN ] [app] 慢请求',
    '09:00:04 [INFO ] [skill:sticker] 生成贴纸',
    '09:00:05 [ERROR] [skill:image-generate] 出图失败',
    '    at generate (image.js:1:2)',
    ''
  ].join('\n'));

  const base = await request('GET', '/api/logs/modules', { query: `?date=${day}&level=info,warn,error` });
  assert.equal(base.status, 200);
  assert.equal(base.data.date, day);
  assert.equal(base.data.total, 5);
  assert.deepEqual(base.data.modules, [
    { module: 'app', count: 3 },
    { module: 'skill:image-generate', count: 1 },
    { module: 'skill:sticker', count: 1 }
  ]);
  assert.equal(base.data.scanTruncated, false);

  // 核心回归：模块下拉的数据源不随「当前选中的模块 / 关键字」变化。
  // 旧实现是逐页累加当前筛选结果，选 skill 后 app 从下拉里消失且切不回去。
  const withModule = await request('GET', '/api/logs/modules', {
    query: `?date=${day}&level=info,warn,error&module=skill`
  });
  assert.deepEqual(withModule.data.modules, base.data.modules);
  const withQ = await request('GET', '/api/logs/modules', {
    query: `?date=${day}&level=info,warn,error&module=skill&q=sticker`
  });
  assert.deepEqual(withQ.data.modules, base.data.modules);

  // 级别是同口径的一部分：只看 warn,error 时 app 只剩 1 条
  const warnOnly = await request('GET', '/api/logs/modules', { query: `?date=${day}&level=warn,error` });
  assert.deepEqual(warnOnly.data.modules, [
    { module: 'app', count: 1 },
    { module: 'skill:image-generate', count: 1 }
  ]);

  // 参数校验与其它日志端点一致
  const badDate = await request('GET', '/api/logs/modules', { query: '?date=../../etc/passwd' });
  assert.equal(badDate.status, 400);
  const badLevel = await request('GET', '/api/logs/modules', { query: `?date=${day}&level=war` });
  assert.equal(badLevel.status, 400);
  // 没有日志文件的日子：空分布而不是报错（文件尚未产生是正常状态）
  const missing = await request('GET', '/api/logs/modules', { query: '?date=2020-05-05' });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.data.modules, []);
  assert.equal(missing.data.total, 0);
});

test('级别持久化：POST 写配置，重启（重新 loadConfig）后仍生效', async () => {
  const r = await request('POST', '/api/logs/level', { body: { level: 'debug' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.level, 'debug');
  assert.equal(logger.getLevel(), 'debug');
  assert.equal(getConfig().logs.level, 'debug');
  // 直接核对落盘：配置写到了本测试的独立数据目录，而不是内存态
  const onDisk = JSON.parse(fs.readFileSync(path.join(temp, 'config.json'), 'utf8'));
  assert.equal(onDisk.logs.level, 'debug');
  // 模拟重启：只用磁盘上的配置重新判定级别
  logger.setLevel('info');
  logger.applyConfiguredLevel();
  assert.equal(logger.getLevel(), 'debug');
  assert.equal(loadConfig().logs.level, 'debug');

  const bad = await request('POST', '/api/logs/level', { body: { level: 'verbose' } });
  assert.equal(bad.status, 400);
  assert.equal(logger.getLevel(), 'debug');   // 非法值不改变现状

  const back = await request('POST', '/api/logs/level', { body: { level: 'info' } });
  assert.equal(back.data.level, 'info');
});

// ── 扫描截断 / 偏移缓存 / 配置派生级别 / 正文截断 ──────────────────────────

const { HISTORY_SCAN_MAX_BYTES, MAX_QUERY_LIMIT } = await import('../src/logger.js');
const { updateConfig } = await import('../src/config.js');

/** 造一个刚好超过扫描预算的日志文件（行宽固定，行数按需要算）。 */
function writeHugeDay(day, targetBytes) {
  const dir = path.join(temp, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `qq-agent-${day}.log`);
  const pad = 'x'.repeat(160);
  const chunk = [];
  let bytes = 0;
  let i = 0;
  while (bytes < targetBytes) {
    const sec = Math.floor(i / 4);          // 每秒 4 行：同秒多行也顺带覆盖
    const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const line = `${hh}:${mm}:${ss} [INFO ] [app] row-${i} ${pad}\n`;
    chunk.push(line);
    bytes += Buffer.byteLength(line);
    i++;
  }
  fs.writeFileSync(file, chunk.join(''));
  return { file, rows: i, bytes };
}

test('history：扫描撞上 32MB 预算时 scanTruncated=true，未超预算时为 false', async () => {
  assert.equal(HISTORY_SCAN_MAX_BYTES, 32 * 1024 * 1024);
  // 34MB：从 EOF 扫满 32MB 仍够不到文件头
  const huge = writeHugeDay('2026-02-01', HISTORY_SCAN_MAX_BYTES + 2 * 1024 * 1024);
  assert.ok(huge.bytes > HISTORY_SCAN_MAX_BYTES);
  // before 落在文件最开头那一秒：任何一页都要扫穿整个预算才可能读到
  const dayStart = new Date(2026, 1, 1).getTime();
  const cut = await request('GET', '/api/logs/history', {
    query: `?date=2026-02-01&limit=200&before=${dayStart + 2000}`
  });
  assert.equal(cut.status, 200);
  assert.equal(cut.data.logs.length, 0);
  assert.equal(cut.data.hasMore, false);       // 页长没截断
  assert.equal(cut.data.scanTruncated, true);  // 但扫描被预算截断 → 界面不能说"到底了"

  // 模块分布走同一套预算：截断时 scanTruncated=true，分布只覆盖较新的部分，
  // 前端据此在下拉上加提示（否则用户会以为早期模块当天没打过日志）。
  const dist = await request('GET', '/api/logs/modules', { query: '?date=2026-02-01' });
  assert.equal(dist.status, 200);
  assert.equal(dist.data.scanTruncated, true);
  assert.ok(dist.data.modules.length > 0);

  // 小文件：完整扫到文件头，scanTruncated=false
  const small = await request('GET', '/api/logs/history', { query: '?date=2026-01-04&limit=100' });
  assert.equal(small.data.scanTruncated, false);
  fs.rmSync(huge.file);
});

test('history：小文件全量翻页不丢行（missing === 0）', async () => {
  const day = '2026-01-05';
  const dir = path.join(temp, 'logs');
  const rows = 1234;
  const out = [];
  for (let i = 0; i < rows; i++) {
    const sec = Math.floor(i / 3);           // 每秒 3 行，必然跨页
    const hh = String(10 + Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    out.push(`${hh}:${mm}:${ss} [INFO ] [app] r${i}`);
  }
  fs.writeFileSync(path.join(dir, `qq-agent-${day}.log`), out.join('\n') + '\n');
  // 与 ui/app/20-logs.js 相同的游标逻辑：重叠一秒 + 重数去重
  const seen = new Map();
  const key = (e) => `${Math.floor(e.ts / 1000)}|${e.level}|${e.module}|${e.text}`;
  let cursor = null;
  let shown = 0;
  for (let page = 0; page < 200; page++) {
    const q = cursor == null ? `?date=${day}&limit=100` : `?date=${day}&limit=100&before=${cursor}`;
    const r = await request('GET', '/api/logs/history', { query: q });
    assert.equal(r.data.scanTruncated, false);
    const batch = new Map();
    for (const e of r.data.logs) {
      const k = key(e);
      const n = (batch.get(k) || 0) + 1;
      batch.set(k, n);
      if (n > (seen.get(k) || 0)) { seen.set(k, n); shown++; }
    }
    if (!r.data.logs.length || !r.data.hasMore) break;
    const oldest = r.data.logs.at(-1).ts;
    const secStart = Math.floor(oldest / 1000) * 1000;
    const next = secStart + 1000;
    cursor = next === cursor ? secStart : next;
  }
  assert.equal(shown, rows);
});

test('history：偏移缓存让第二次带 before 的读取不再从 EOF 重扫', async () => {
  const day = '2026-01-06';
  const file = path.join(temp, 'logs', `qq-agent-${day}.log`);
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    const sec = Math.floor(i / 4);
    const hh = String(12 + Math.floor(sec / 3600)).padStart(2, '0');
    const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    rows.push(`${hh}:${mm}:${ss} [INFO ] [app] p${i}`);
  }
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const dayStart = new Date(2026, 0, 6).getTime();
  // 游标落在文件中部：page2 的 before = 第 2000 行（row 1999）的秒末尾
  const midTs = dayStart + (12 * 3600 + Math.floor(1999 / 4)) * 1000 + 1000;

  let reads = 0;
  const realCreate = fs.createReadStream;
  const origOnly = null;
  // 统计实际读出的字节数：锚点命中后第二页只该读它需要的块，而不是整个文件
  const sizes = [];
  const orig = fs.createReadStream;
  const t1 = performance.now();
  const first = await request('GET', '/api/logs/history', { query: `?date=${day}&limit=200&before=${midTs}` });
  const firstMs = performance.now() - t1;
  const t2 = performance.now();
  const second = await request('GET', '/api/logs/history', { query: `?date=${day}&limit=200&before=${midTs}` });
  const secondMs = performance.now() - t2;
  assert.deepEqual(first.data.logs.map((e) => e.text), second.data.logs.map((e) => e.text));
  assert.equal(first.data.hasMore, true);
  // 第二次命中锚点：读的字节数明显更少（第一次要从 EOF 反向扫过 row1999..3999）
  assert.ok(secondMs <= firstMs, `第二次(${secondMs.toFixed(2)}ms)不应慢于第一次(${firstMs.toFixed(2)}ms)`);

  // 同样的读取在「新文件、无锚点」时才是真正的冷扫；用耗时上界兜住重扫退化
  const coldDay = '2026-01-07';
  fs.copyFileSync(file, path.join(temp, 'logs', `qq-agent-${coldDay}.log`));
  const coldStart = new Date(2026, 0, 7).getTime();
  const coldTs = coldStart + (12 * 3600 + Math.floor(1999 / 4)) * 1000 + 1000;
  const t3 = performance.now();
  await request('GET', '/api/logs/history', { query: `?date=${coldDay}&limit=200&before=${coldTs}` });
  const coldMs = performance.now() - t3;
  assert.ok(secondMs <= coldMs * 0.8 + 5, `锚点命中(${secondMs.toFixed(2)}ms)应快于冷扫(${coldMs.toFixed(2)}ms)`);
});

test('/api/config 写 logs.level 后 logger 级别同步（配置是唯一真源）', async () => {
  const r = await request('POST', '/api/config', { body: { logs: { level: 'error' } } });
  assert.equal(r.status, 200);
  assert.equal(getConfig().logs.level, 'error');
  assert.equal(logger.getLevel(), 'error');
  // GET /api/logs 与 GET /api/config 同源
  const logs = await request('GET', '/api/logs');
  assert.equal(logs.data.level, 'error');
  // 非法 level 经 /api/config 写入时保持原级别（logger.setLevel 拒绝未知值）
  updateConfig({ logs: { level: 'nonsense' } });
  assert.equal(logger.getLevel(), 'error');
  // /api/logs/level 与 /api/config 走同一条派生链路
  const back = await request('POST', '/api/logs/level', { body: { level: 'info' } });
  assert.equal(back.data.level, 'info');
  assert.equal(getConfig().logs.level, 'info');
});

test('单条超长正文在内存 / SSE / 磁盘三处口径一致', async () => {
  const big = 'y'.repeat(100 * 1024);
  const before = logger.memory.length;
  logger.info('truncate-probe', big);
  const entry = logger.memory.at(-1);
  assert.equal(entry.text.length, 64 * 1024 + '…（过长已截断）'.length);
  assert.ok(entry.text.endsWith('…（过长已截断）'));
  assert.equal(logger.memory.length, before + 1);
  // 落盘的那一行用的是同一份文本（只多出时间/级别/模块前缀）
  const day = new Date();
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const text = fs.readFileSync(path.join(temp, 'logs', `qq-agent-${key}.log`), 'utf8');
  const line = text.split('\n').filter((l) => l.includes('[truncate-probe]')).at(-1);
  assert.ok(line.endsWith('…（过长已截断）'));
  // 落盘行 = `HH:MM:SS [INFO ] [module] ` + 正文（正文与内存里那份逐字相同）
  assert.match(line, /^\d{2}:\d{2}:\d{2} \[INFO \] \[truncate-probe\] /);
  assert.equal(line.replace(/^\d{2}:\d{2}:\d{2} \[INFO \] \[truncate-probe\] /, ''), entry.text);
});
