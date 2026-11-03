// 〔启动 loading 壳 / 就绪体检 / 状态栏〕
'use strict';
// ── 状态栏 ──
// refreshStatus 被高频调用：状态轮询、每条消息的 SSE、切回设置页都会触发。
// 无条件重写顶栏会让横幅（innerHTML 整块重建）每轮闪一次，所以这里用签名短路：
// 值没变就跳过 DOM 写入。做法与 14-chrome.js 的 syncIdentity 一致。
// ⚠️ state.* 仍然每轮更新（其它模块读它），只有 DOM 那一层被短路。
let lastStatusSig = null;

// ⚠️ 连续失败计数 + 顶栏"过期"标记。
//   本函数由 15 秒轮询驱动（02-sse-sessions.js）。如果 /api/status 持续失败，
//   顶栏会一直显示上一次的"已连接 / 今日 N 次运行"，用户以为一切正常，实际后端早已不响应。
//   **显示过期数据比显示错误更危险**（信息是错的，不是缺的）。
//   连续 3 次（≈45 秒，足够滤掉一次网络抖动）仍失败 → 顶栏改口径。
const STATUS_FAIL_THRESHOLD = 3;
let statusFailStreak = 0;

/** 顶栏进入"状态未知"态。 */
function markStatusStale() {
  if (state.statusStale) return;
  state.statusStale = true;
  // 签名置空 → 恢复时一定会重写一次 DOM（否则"值没变"会被签名短路掉，
  // 顶栏就永远停在"状态未知"了）。
  lastStatusSig = null;
  try {
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    if (dot) dot.className = 'dot dot-off';
    if (label) {
      label.textContent = '状态未知（后端未响应）';
      label.title = `控制台已连续 ${STATUS_FAIL_THRESHOLD} 次拿不到 /api/status 的响应，顶栏显示的是过期数据。请确认后端进程是否还在运行。`;
    }
  } catch (e) { /* 顶栏结构异常也不该把轮询本身搞崩 */ }
  // renderBanner 平时只在 /api/status 成功路径里被调，持续失败时它压根不会跑，
  // 横幅就永远停在旧内容。这里主动补一次，让"和控制台失去联系"的横幅立刻亮出来。
  try { renderBanner(); } catch (e) { /* 横幅模块未就绪不阻塞 */ }
}

/** 后端恢复后清掉过期标记（下一次渲染会正常覆盖顶栏）。 */
function clearStatusStale() {
  if (!state.statusStale) return;
  state.statusStale = false;
  lastStatusSig = null;
}

async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    // ⚠️ 复位必须在**签名短路之前**：恢复后数据可能与失败前一字不差，
    //   放在后面就会被下面的 `sig === lastStatusSig` 提前 return 掉，
    //   顶栏会永远停在"状态未知（后端未响应）"。clearStatusStale 顺带把签名置空，
    //   保证恢复后的第一轮一定真正重写一次 DOM。
    statusFailStreak = 0;
    clearStatusStale();
    // 签名只取"参与渲染的标量"：不含对象引用（否则每轮必变，短路永远不生效）。
    // 成本/命中率取整后再入签名，它们是浮点，末位抖动不该算变化。
    const cfg = state.config || {};
    const sig = JSON.stringify([
      s.onebot?.connected, s.onebot?.everConnected, s.onebot?.self?.nickname,
      s.onebot?.diagnosis, s.onebot?.error,
      s.orchestrator?.model,
      s.usage?.runs, s.usage?.totalTokens, s.usage?.webSearchCount,
      Math.round((s.cost?.cost || 0) * 1000),
      Math.round((s.cacheHitRate || 0) * 10000),
      s.webSearchCount, s.paused, s.pauseReason, s.dataDir,
      // updateReadinessDots 还依赖"配置是否齐全"，那几个字段必须一起进签名，
      // 否则用户在设置页填好地址/模型后，圆点 3 要等下一次 status 变化才亮。
      cfg.api?.baseUrl, cfg.api?.model,
      cfg.allow?.groups?.length, cfg.allow?.private?.length, cfg.allowAllWhenEmpty,
      s.qqPortable?.running, s.protocol?.portOpen
    ]);
    // state 侧永远更新（下面的 renderBanner / 其它模块都读它）
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    state.dataDir = s.dataDir || '';
    if (sig === lastStatusSig) return;   // 一字未变：DOM 侧整个跳过
    lastStatusSig = sig;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    // 未连接时展示后端诊断：区分「协议端没起 / 没登录账号 / 令牌不匹配」，
    // 不让用户面对一句干巴巴的"未连接"猜原因。
    // 状态条常驻可见，术语用"机器人上线"，诊断原文（后端给的）照旧透出。
    label.textContent = s.onebot.connected
      ? `机器人已上线${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : (s.onebot.diagnosis || '机器人没连上');
    label.title = s.onebot.connected ? '' : (s.onebot.error || '');
    delete label.dataset.jumpTo;
    label.style.cursor = '';
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    // 成本：官方价匹配得上就显示；匹配不上（中转站常见）只显示 token，不显示误导性的 ¥0
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
    updateReadinessDots(s);
  } catch (e) {
    // 单次失败忽略（瞬时错误不该打扰用户），只累计；连够次数才改口径。
    statusFailStreak += 1;
    if (statusFailStreak >= STATUS_FAIL_THRESHOLD) markStatusStale();
  }
}

/** 更新顶栏就绪进度指示器（4 圆点 + 未就绪项的红色缩写） */
function updateReadinessDots(s) {
  const items = $$('#readiness-dots .rdot-item');
  if (items.length !== 4) return;

  const qq = s?.qqPortable || {};
  const qqRunning = !!qq.running;
  // 协议端是否在运行，判据是 WS 端口在不在监听（协议端由用户自装，我们只能看端口）。
  const protoUp = !!s?.protocol?.portOpen;
  const obConnected = !!s?.onebot?.connected;
  const cfg = state.config || {};
  const cfgReady = !!(cfg.api?.baseUrl && cfg.api?.model && (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty));

  // 四项统一由这张表驱动。ok 时只有圆点；未就绪时圆点旁补一个极短缩写
  // （⚠QQ / ⚠连接 / ⚠配置），不用悬停也知道缺哪一项。缩写压到 1~2 个字加前缀符号，
  // 四项全异常时也只占约 176px，不会撑破账号卡。
  // QQ/协议端两项同时认 OneBot 已连接：OneBot 连上就是"QQ 侧 + 协议端实际已就绪"
  // 最硬的证据，不该因为探测不到进程而亮红字。
  const defs = [
    {
      ok: qqRunning || obConnected,
      off: '⚠QQ',
      title: qqRunning ? 'QQ 内核运行中'
        : (obConnected ? 'QQ 已在服务机器人（OneBot 已连接，走的是你自己登录的那份 QQ）'
        : 'QQ 内核未运行（点击前往启动）')
    },
    {
      ok: protoUp || obConnected,
      // 协议端这一项也标 QQ：对用户来说它就是 QQ 连接组件，比标「网关」直观。
      off: '⚠QQ',
      title: protoUp ? '协议端（SnowLuma / NapCat）在运行'
        : (obConnected ? '已连接外部 QQ 协议端'
        : '协议端没在运行（点击前往连接页）')
    },
    {
      ok: obConnected,
      wait: protoUp && !obConnected,
      waitText: '连接…',
      off: '⚠连接',
      title: obConnected ? '机器人已上线（能收发群消息）'
        : (s?.onebot?.diagnosis || (protoUp ? '机器人上线中…（登录后一两分钟）' : '机器人没连上'))
    },
    {
      ok: cfgReady,
      off: '⚠配置',
      title: cfgReady ? '配置已完成' : '配置未完成（点击前往设置）'
    }
  ];

  items.forEach((item, i) => {
    const d = defs[i];
    const dot = item.querySelector('.rdot');
    const tag = item.querySelector('.rdot-t');
    item.className = 'rdot-item' + (d.ok ? ' is-on' : (d.wait ? ' is-wait' : ' is-off'));
    if (dot) dot.className = 'rdot' + (d.ok ? ' on' : (d.wait ? ' wait' : ''));
    if (tag) tag.textContent = d.ok ? '' : (d.wait ? (d.waitText || '…') : d.off);
    item.title = d.title;
  });
}

// 就绪圆点点击跳转（点圆点或它旁边的缩写都能跳）
$$('#readiness-dots .rdot-item').forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.target;
    if (target === 'connection') switchTab('connection');
    else if (target === 'settings') switchTab('settings');
  });
});

// token 紧凑格式统一走 00-core.js 的 fmtTokShort（K/M/G 三档）。
function fmtTokens(n) {
  return `${fmtTokShort(n)} tok`;
}

/**
 * 缓存命中率文案（prompt 里命中前缀缓存的部分占比）。
 * 口径与后端 `src/llm.js` 的 `cacheHitRate()` 一致：cachedTokens / promptTokens，钳到 0~1。
 * ⚠️ 只有拿到 prompt 数据才显示，等待中 / 从未调用模型的会话没有分母，
 *    硬显示 "缓存 0%" 会让人误以为缓存失效。
 */
function fmtCacheRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return '';
  const rate = Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
  return `缓存 ${Math.round(rate * 100)}%`;
}

/**
 * 一条会话调用了多少次工具（数字）。
 * 口径与后端 `src/sessions.js#toolCallCount` 一致：优先用会话上的 `toolCalls` 计数，
 * 缺失时数 `messages` 里带 `toolCall` 的条目。
 * ⚠️ 会话**列表**（/api/sessions）只回摘要、不带 messages，所以那边只能靠后端算好的
 *    `toolCalls` 字段；只有详情（带 messages）能走兜底分支。
 */
function countToolCalls(s) {
  const n = Number(s?.toolCalls);
  if (Number.isFinite(n) && n > 0) return n;
  return (s?.messages || []).filter((m) => m && m.toolCall).length;
}

// 加 `?.`：本文件是 defer 脚本、语句按序执行，而 $() 查不到节点时返回 null。
// 直接 .addEventListener 会抛 TypeError，把这个文件后面的所有顶层语句一起带走
// （顶栏初始化、状态轮询全哑，界面上表现为"顶栏永远空着"而没有任何报错线索）。
$('#pause-btn')?.addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 来一条事件就全量重建会话列表和详情会让主线程反复长阻塞，详情内容反而"更新缓慢"，
// 还伴随滚动跳动。现在 patch 立即进 state（数据不延迟），渲染合并到短定时器一次，
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：窗口被遮挡/最小化时 Chromium
//    会完全停发 rAF，渲染全部积压到切回前台才一次性出现，用户看到的就是
//    "不手动刷新就不更新"。setTimeout 在后台页面仍会执行（最多被节流到 1s）。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先，它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}
