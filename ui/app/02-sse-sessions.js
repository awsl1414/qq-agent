// 〔SSE / 会话视图〕
'use strict';
// ── SSE ──
// 单例 + 自愈。connectSSE 若被重复调用（看门狗重建窗口、热重载、切 tab 重入）
// 会叠出多个永久 SSE 连接，逐步吃满 Chromium 对 127.0.0.1 的 6 条 socket 上限，
// 最终普通 fetch 全 "Failed to fetch"。
// 这里保证全局永远只有一个 EventSource，并提供 reconnectSSE 供网络自愈调用。
let sseConn = null;
function connectSSE() {
  // 预览模式：没有真实事件源，会话由 00-preview.js 的模拟器推进；
  // EventSource 连不上会无限重连刷屏，直接短路。
  if (state.preview) return;
  // 已有一条健康的连接就别再叠了
  if (sseConn && sseConn.readyState !== EventSource.CLOSED) return;
  // EventSource 发不了自定义头：令牌只能走 withToken() 拼成 ?token=。
  // 统一走这个出口，避免以后新增原生加载路径时再各拼一份。
  const eventUrl = withToken('/api/events');
  const es = new EventSource(eventUrl);
  // 记进单例，供 reconnectSSE 关闭重建
  sseConn = es;
  es.addEventListener('session-start', () => {
    loadSessions();
    refreshStatus();
    // 自动跟随新会话（等待中/运行中）
    if (state.autoFollowRunning) {
      loadSessions({ quiet: true }).then(() => {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) selectSession(active.id);
      }).catch(() => { /* 跟随失败不影响已有列表：下一次 SSE 事件会再试 */ });
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null，pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (Number.isFinite(data.sentCount)) patch.sentCount = data.sentCount;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    // 「人话解释」跟着 error 一起走。undefined 时不写，免得把先前拿到的解释
    // 被后续只有 error 字符串的 patch 冲掉。
    if (data.errorHuman !== undefined) patch.errorHuman = data.errorHuman;
    if (data.errorRaw !== undefined) patch.errorRaw = data.errorRaw;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来，不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    // 会话设置页在场时也重渲染一次：群内 @机器人 + /安静 的指令禁言会 emit
    // chat-update，不刷新的话「指令禁言」卡片停在"未禁言"，用户以为指令没生效。
    // 必须走 14-chrome.js 导出的 window.refreshSetupPane：setupChat / renderSetupPane
    // 都是该文件 IIFE 私有的，typeof 恒为 undefined。refreshSetupPane 内部自己
    // 判模式，不在设置页时是空操作。
    try {
      if (typeof window.refreshSetupPane === 'function') window.refreshSetupPane();
    } catch { /* 设置页未就绪不阻塞 */ }
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 只操作 DOM 且 tab 不对就 return 的话，切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        // failed 数量一并记进 state：渲染时给"有失败"的整理结果加警示标记，
        // 否则部分失败与"内容无需改动"长得一样，用户看不出问题。
        const failCount = Array.isArray(data.failed) ? data.failed.length : 0;
        state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now(), failed: failCount };
      }
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      const failCount = Array.isArray(data.failed) ? data.failed.length : 0;
      if (status) status.textContent = (failCount ? '⚠️ ' : '') + (data.note || '整理完成');
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'connection') loadConnectionPage({ quiet: true });
  });
  es.addEventListener('status', () => refreshStatus());
  // 协议端由用户自装，它的日志归它自己的控制台，后端不再发 snowluma-* 事件。
  es.addEventListener('qq-portable-status', () => { refreshStatus(); if (state.tab === 'connection') loadConnectionPage({ quiet: true }); });
  // qq-portable-log 只用于刷新连接页上的状态（日志面板已不再展示 QQ 内核输出）。
  // 仍做 500ms 防抖：协议端启动期这一串日志很密，逐行重绘纯属浪费。
  let qqLogRedrawTimer = 0;
  es.addEventListener('qq-portable-log', () => {
    if (state.tab !== 'connection') return;
    clearTimeout(qqLogRedrawTimer);
    qqLogRedrawTimer = setTimeout(() => {
      if (state.tab === 'connection') loadConnectionPage({ quiet: true });
    }, 500);
  });
  es.addEventListener('feedback', (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  // 模型逐个审的进度：POST /api/doctor/triage 要逐个文件调模型（可能几分钟），
  // 靠这个事件实时推进进度条，否则用户点完只能对着"审阅中"干等。
  es.addEventListener('doctor-triage', (ev) => {
    if (!doctorState.triaging) return;
    let d = {};
    try { d = JSON.parse(ev.data); } catch { return; }
    doctorState.triageProg = { done: d.done || 0, total: d.total || 0, file: d.file || '' };
    // 只重绘进度条那一块，不整页重建（避免闪烁）
    const bar = $('#harness-page')?.querySelector('.doctor-triage-bar');
    if (bar) bar.outerHTML = renderTriageBar(doctorState.project?.rules || []);
  });
  // 视觉能力扫描进度：POST /api/vision/scan 是异步的（202），完成后靠这个事件
  // 告诉前端；没人监听的话，扫描结果只能在重载页面后才看得到。
  es.addEventListener('vision-scan', async (ev) => {
    let d = {};
    try { d = JSON.parse(ev.data); } catch { /* ignore */ }
    // 扫描入口在「模型配置」弹窗，mc-vision-hint 承接进度。
    const hint = $('#mc-vision-hint');
    if (hint) {
      if (d.phase === 'start') hint.textContent = '扫描中…（会真实请求每个模型，请稍候）';
      else if (d.phase === 'done') hint.textContent = `完成：${d.total ?? 0} 个模型`;
      else if (d.phase === 'error') hint.textContent = `失败：${d.error || '未知错误'}`;
    }
    if (d.phase === 'done' || d.phase === 'error') {
      try {
        const v = await api('/api/vision/results');
        state.visionResults = v.results || {};
        state.visionScanning = !!v.scanning;
        if (state.tab === 'settings') renderSettings();
      } catch { /* 拉结果失败就保持现状 */ }
    }
  });
  es.onerror = () => { /* EventSource 自带自动重连，无需手动处理 */ };
}

// 网络自愈入口。长运行后若渲染端 socket 池卡死（持续 "Failed to fetch"），
// 关闭旧 SSE 由浏览器释放那条半死 socket，再建一条新的；必要时 00-core 的
// 网络看门狗会进一步触发整页重载兜底。
function reconnectSSE() {
  try { sseConn?.close(); } catch { /* 忽略 */ }
  sseConn = null;
  if (state.preview) return;
  connectSSE();
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
    const next = data.sessions || [];
    // 轮询路径（quiet=true）在数据一字未变时直接跳过整轮渲染。每 refreshMs 都重设
    // state.sessions 并调 renderSessionList()（`box.innerHTML = …` 整体重建），
    // 几百条会话时等于"每隔十几秒把列表整块推倒重画"：视觉闪烁、滚动位置跳动、
    // 正在悬停/拖拽的行被抹掉。签名取完整 JSON，不会漏掉任何参与渲染的字段。
    const sig = JSON.stringify(next);
    if (quiet && state.sessionsSig === sig) return;
    state.sessionsSig = sig;
    state.sessions = next;
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）。
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」），硬编码会让配置项形同虚设。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  // 兜底值必须与后端 DEFAULT_CONFIG.ui.refreshMs 一致（15000），
  // 否则"拿不到配置"时前端按 4 秒轮询、后端默认 15 秒，两边对不上。
  return Number.isFinite(n) && n >= 1000 ? n : 15000;
}

/**
 * 状态栏轮询。用 setTimeout 自续期而不是 setInterval：每一轮都重新读
 * ui.refreshMs，用户在设置页改「界面刷新间隔」后立刻生效，不必刷新页面。
 */
let statusPollTimer = null;
function startStatusPoller() {
  if (statusPollTimer) { clearTimeout(statusPollTimer); statusPollTimer = null; }
  const tick = async () => {
    try { await refreshStatus(); } catch { /* 单次失败不中断轮询 */ }
    statusPollTimer = setTimeout(tick, refreshIntervalMs());
  };
  statusPollTimer = setTimeout(tick, refreshIntervalMs());
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：被节流的事件直接丢弃的话，快速滚动时事件密集，
 *      "抵达底部"那一下几乎总落在 120ms 窗口内被扔掉，用户停手后又没有新事件，
 *      加载永远不触发，表现为"滚得快会滚不下去，像撞墙"。现在窗口内的事件会
 *      留下一个尾随定时器，停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发：快速甩滚时惯性大，提前量太小的话内容还没加载出来
 *      人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染。
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数渲染一次调一次，不做防护的话加载 N 批就挂 N 个监听器，
  //    滚一次同时触发 N 次 onLoadMore、一次跳好几批，而且每个监听器各有自己的
  //    last 变量，120ms 节流形同虚设。状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用，停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    renderSessionList();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail，它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。不要在它内部再套一层滚动容器：内层没有高度基准、会被
 *   内容撑开，滚动事件全发生在外层，监听挂空，"继续滚动没反应"。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）。调 updateChatMessagesBody(true)
 *   的话每批都要全量 sort + 全量 innerHTML 重建（行数越滚越多），还有 scrollTop
 *   补偿把视口"吸"在底部，连锁触发下一批加载，主线程被反复长阻塞。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

let listPollerVisBound = false;
function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    // 页面不可见（最小化/被遮挡）时跳过用量页轮询：大数据下 stats 重算
    // 即便有缓存也要几百毫秒，后台一直跑是纯浪费。会话/存档等轻页签不受影响。
    const skipUsage = document.hidden;
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'connection') loadConnectionPage({ quiet: true });
    if (state.tab === 'usage' && !skipUsage) loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
  // 从后台切回：立刻刷一次用量（刚才跳过的补上），数字不会"停在过去"。
  // ⚠️ 只挂一次：startListPoller 在每次「设置页改动保存」时都会被调用来刷新间隔
  //    （07-settings-events.js 的 doSave），每次都 addEventListener 的话，反复改
  //    设置会叠出一串 visibilitychange 监听，每次切回前台把 loadUsageView 跑 N 遍。
  if (!listPollerVisBound) {
    listPollerVisBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.tab === 'usage') loadUsageView();
    });
  }
}
startListPoller();

/* ── 该群的回复频率（= 人设里的「参与度」档位）──
   口径与后端 src/config.js#personaForChat 完全一致：分群人设优先，没单独设就跟随全局。
   ⚠️ 键格式必须两种都认：UI 保存时可能写 `group:123`，也可能只写 `123`，
   只认一种会导致存了却永不生效。所以先按 chatKey 查、再按纯 id 查。
   展示成"标签语言"的小胶囊（淡底 + 同色字 + 无描边），跟状态徽标同一族；
   不要做成按钮（有描边），它只是信息，不是控件。 */
const REPLY_FREQ_LABEL = { low: '安静型', medium: '普通群友', high: '活跃型' };
const REPLY_FREQ_DESC = {
  low: '很少主动搭话，只在被 @ 或明显需要时才回',
  medium: '跟普通群友一样，聊到就接两句',
  high: '活跃，群里热闹时会主动插话'
};
function replyFreqOf(chatKey) {
  const cfg = state.config || {};
  const id = String(chatKey || '').split(':')[1] || '';
  const perChat = cfg.personaByChat || {};
  const conf = perChat[String(chatKey)] || (id ? perChat[id] : null) || {};
  const level = conf.participation || cfg.persona?.participation || 'medium';
  const perChatOwn = Boolean(conf.participation);
  const label = REPLY_FREQ_LABEL[level] || REPLY_FREQ_LABEL.medium;
  return {
    level, label, perChatOwn,
    tip: `回复频率：${label}（${REPLY_FREQ_DESC[level] || ''}）· ${perChatOwn ? '本群单独设置' : '跟随全局设置'}`
  };
}
/** 回复频率胶囊的 HTML（列表卡片与详情头共用，保证两处长得一样） */
function replyFreqChip(chatKey) {
  const f = replyFreqOf(chatKey);
  return `<span class="session-freq freq-${esc(f.level)}" title="${esc(f.tip)}">${esc(f.label)}</span>`;
}

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  // ⚠️ 空态兜底：shown 为空时 box.innerHTML = '' 会让列表区一片空白，用户分不清是
  //    "还没有会话"「正在加载」还是"加载失败"。
  //    不能提前 return：函数末尾还要挂事件委托（bindSessionListDelegation），
  //    跳过它会导致"从空变有数据"时委托没挂上、整列点不动。
  const isEmpty = !shown.length;
  box.innerHTML = isEmpty
    ? '<div class="empty-hint">还没有会话记录。<br>有人 @ 机器人或发私聊后，这里会实时出现处理过程。</div>'
    : shown.map((s) => {
    const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
    const waitHtml = s.status === 'waiting' && s.waitUntil
      ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
      : '';
    const activityHtml = s.status === 'running' && s.activity
      ? `<span class="session-activity">${esc(s.activity)}</span>`
      : s.status === 'error' && (s.errorHuman?.title || s.error)
        ? `<span class="session-activity">⚠️ ${esc((s.errorHuman?.title || s.error).slice(0, 60))}</span>`
        : '';
    // 统计行（token / 缓存命中率 / 轮数 / 搜索）：**单独占一行**，不再和状态挤同一行，
    // 之前七八个元素全塞进一行，窄侧栏下 flex 会把状态徽标压成竖排（运/行/中）、
    // 数字被断成两行，观感很臃肿。
    const cacheRate = fmtCacheRate(s.usage);   // 这一轮会话的缓存命中率（无数据时为空串）
    const toolCalls = countToolCalls(s);       // 工具调用次数（0 时不显示，跟「搜」保持一致的克制）
    const statParts = [s.usage ? fmtTokens(s.usage.totalTokens) : '-'];
    if (cacheRate) statParts.push(`<span class="cache-rate" title="本轮 prompt 命中前缀缓存的比例">${cacheRate}</span>`);
    statParts.push(`${s.rounds || 0} 轮`);
    if (toolCalls > 0) statParts.push(`<span class="tool-calls" title="本轮一共调用了 ${toolCalls} 次工具">工具 ${toolCalls}</span>`);
    if (Number(s.webSearchCount) > 0) statParts.push(`搜 ${s.webSearchCount}`);
    const statsText = s.status !== 'waiting' ? statParts.join(' · ') : '';
    const isNew = !state.seenSessionIds.has(s.id);
    // 失败会话的重试按钮：只有 error 状态且没发出过消息的才显示
    // （已发言的重试会导致群里重复内容，后端同样会 409 拒绝）。
    // 判据读列表摘要里的 sentCount：列表出口不带整份 sent，自己从 s.sent 推断
    // 会恒为"没发过"，已发过消息的失败会话也会长出这颗按钮。
    const retryHtml = s.status === 'error' && !(Number(s.sentCount) > 0)
      ? `<button class="btn btn-small session-retry-btn" data-id="${esc(s.id)}" title="把这条会话的触发消息翻回未读并重新处理">重试</button>`
      : '';
    // 运行中/等待中会话的中止按钮：运行中在下一轮请求前安全收尾，等待中直接干净消失
    const abortHtml = (s.status === 'running' || s.status === 'waiting')
      ? `<button class="btn btn-small btn-danger session-abort-btn" data-id="${esc(s.id)}" title="中止这次处理（已发出的消息不受影响）">中止</button>`
      : '';
    // 动作按钮统一靠右（状态/活动在左），不跟状态徽标抢宽度
    const actsHtml = (retryHtml || abortHtml)
      ? `<span class="session-meta-acts">${retryHtml}${abortHtml}</span>`
      : '';
    // 统计行统一**排在运行状态的下方**（用户要求：状态一行、数据一行，别混在一行里）
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          <!-- 标题行改成固定三列后群名列变窄（~121px），长群名会被省略号截断，
               补 title 让鼠标悬停仍能看全名（tooltip.js 已全局接管 title，不会出黄块）。 -->
          <span class="session-chat" title="${esc(chatName)}">${esc(chatName)}</span>
          ${replyFreqChip(s.chatKey)}
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${actsHtml}
        </div>
        ${statsText ? `<div class="session-stats">${statsText}</div>` : ''}
      </div>`;
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${all.length} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = all.length ? `${shown.length}/${all.length}` : '';
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  // 事件委托：会话列表是 SSE 高频重绘的（每条会话状态一变就整表重渲），
  // 对每个 .session-item / 重试 / 中止按钮逐条 addEventListener 的话，
  // 每帧创建 N×3 个闭包，GC 压力明显，而且旧监听器随 innerHTML 一起被丢弃，
  // 绑定开销白白付掉。改成在容器上挂一次性委托监听器（本函数可能在重绘中
  // 反复调用，用 dataset 标记保证只挂一次）。命中判定用 closest 上溯。
  bindSessionListDelegation(box);
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

/**
 * 给会话列表容器挂一次性事件委托。重复调用安全（用 dataset 标记防重入）。
 * 监听器读的是"点击那一刻的 DOM"，所以列表重绘后无需重新绑定。
 *
 * ⚠️ 可达性说明（勿删）：当前信息架构下，这段行点击实际走不到。
 *    #session-list（含 #session-items）在启动时被 14-chrome.js 整块搬进全屏页
 *    #bigpage；而 15-chat-chrome.js 一旦进入「会话选择」模式就给 #session-items
 *    加 .cc-hide（display:none），改用它自己的卡片左栏 W_LIST。
 *    保留这段的理由：① 重试/中止按钮的委托仍被真实使用，只要列表被渲染出来按钮就活；
 *    ② 一旦 IA 回退、或别的视图复用 #session-items，行点击必须还能用；
 *    ③ 删掉会让"列表能渲染但点不动"成为一个更隐蔽的坑。
 *    若确认永不复用，应连同 #session-items 的渲染一起移除，而不是只摘掉监听器。
 */
function bindSessionListDelegation(box) {
  if (!box || box.dataset.delegated === '1') return;
  box.dataset.delegated = '1';
  const handlers = getSessionListHandlers();
  box.addEventListener('click', (e) => {
    const t = e.target;
    // 顺序要紧：按钮优先于行（按钮本身也在 .session-item 里）。
    // 用 closest 上溯，保证点在 <button> 内的文字/图标节点也能命中。
    const retry = t.closest && t.closest('.session-retry-btn');
    if (retry) { e.stopPropagation(); handlers.onRetry(retry); return; }
    const abort = t.closest && t.closest('.session-abort-btn');
    if (abort) { e.stopPropagation(); handlers.onAbort(abort); return; }
    const item = t.closest && t.closest('.session-item');
    if (item && item.dataset.id) handlers.onSelect(item.dataset.id);
  });
}

/**
 * 会话列表的三个动作实现（抽成单例，供委托回调复用）。
 * 惰性创建并缓存在模块级，每次 renderSessionList 复用同一组实现，不重复造闭包。
 */
let sessionListHandlers = null;
function getSessionListHandlers() {
  if (sessionListHandlers) return sessionListHandlers;
  // 失败会自动重试一次的 api 封装（用于"偶发 failed to fetch"的点击类操作：
  // 中止/重试等）。后端在收尾时会做同步落盘（大会话 JSON 写盘可达几百毫秒），
  // 期间其它请求会在 TCP 队列里排队；偶发的连接抖动/瞬间拒绝会以
  // TypeError: Failed to fetch 冒出来，这类瞬态失败重试一次几乎必成。
  // 只重试网络层失败（TypeError），HTTP 4xx/5xx 是服务器的明确答复，不重试。
  async function apiWithRetry(path, options = {}, retries = 1) {
    try {
      return await api(path, options);
    } catch (err) {
      const transient = err instanceof TypeError || /failed to fetch|network|load failed/i.test(String(err?.message || ''));
      if (!transient || retries <= 0) throw err;
      await new Promise((r) => setTimeout(r, 350));
      return apiWithRetry(path, options, retries - 1);
    }
  }

  sessionListHandlers = {
    // 选中会话（点行本体）
    onSelect(id) { selectSession(id); },

    // 失败会话的「重试」：把触发消息翻回未读并重新处理。
    // （调用方已 stopPropagation：点了重试就别选中这条会话）
    async onRetry(btn) {
      const id = btn.dataset.id;
      if (!id || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '重试中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(id)}/retry`, {
          method: 'POST', body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法重试');
        // 新会话由唤醒流程创建；列表靠 SSE/轮询刷新，这里立即拉一次
        await loadSessions({ quiet: true });
      } catch (err) {
        qaAlert(`重试失败：${err.message}`);
        // ⚠️ 复位要防御：这次渲染出的 btn 可能已被下一帧 innerHTML 换掉（成了游离节点），
        //    对它写 disabled 无害但也没必要；真正在册的同 id 新按钮靠重绘恢复初始态。
        if (btn.isConnected) { btn.disabled = false; btn.textContent = '重试'; }
      }
    },

    // 运行中/等待中的「中止」：请求后端安全收尾这条会话。
    // 中止是"尽快别再继续"，不是立即截断，后端在下一轮 LLM 请求前收尾，
    // 已发出的消息不受影响。列表刷新靠 SSE/轮询，这里立即拉一次。
    async onAbort(btn) {
      const id = btn.dataset.id;
      if (!id || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '中止中…';
      try {
        const r = await apiWithRetry(`/api/sessions/${encodeURIComponent(id)}/abort`, {
          method: 'POST', body: '{}'
        });
        if (!r.ok) throw new Error(r.error || '无法中止');
        await loadSessions({ quiet: true });
      } catch (err) {
        qaAlert(`中止失败：${err.message}`);
        if (btn.isConnected) { btn.disabled = false; btn.textContent = '中止'; }
      }
    },
  };
  return sessionListHandlers;
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  // 详情容器可能已被切页销毁（#session-detail 只在会话页存在），直接写 innerHTML
  // 会抛 TypeError，切走时静默跳过即可。
  //
  // ⚠️ 不要在这里立刻清空：会话卡的展开走的正是这条路径（15-chat-chrome.js 的
  //   卡头点击 → selectSession）。紧跟一句 innerHTML = '加载中…' 会把右栏骨架
  //   #cc-cards 整块擦掉，中间至少一帧是空的，用户看到的就是"闪一下"。
  //   本机 API 通常几十毫秒就返回，这个中间态纯属负收益。
  //   改成延迟占位：只有真的慢（>200ms）才显示「加载中…」；正常情况由
  //   renderSessionDetail 一次性替换内容（同一帧完成，不闪）。
  const detail = $('#session-detail');
  let hintTimer = null;
  if (detail) {
    hintTimer = setTimeout(function () {
      // 期间既没切走、新内容也还没来，才落占位（避免迟到响应把占位留在屏上）
      if (state.currentSessionId === id && state.tab === 'sessions') {
        detail.innerHTML = '<div class="empty-hint">加载中…</div>';
      }
    }, 200);
  }
  try {
    await loadSessionDetail(id);
  } finally {
    if (hintTimer) clearTimeout(hintTimer);
  }
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

// ══════════════════════════════════════════════════════════════════════════
// 会话报错「说人话」
// ---------------------------------------------------------------------------
// 模型报错时详情页会铺一整段红字（`模型 API HTTP 400：{"error":{…}}`），
// 能读英文 JSON 的人觉得信息完整，绝大多数用户只看到"一堵墙"。
//
// 做法：后端在抛错前把解释挂在 error.human（见 src/error-l10n.js），
//  orchestrator 接成 session.errorHuman / session.errorRaw 一路带到这儿。
// 这里只负责渲染，不负责猜：拿不到 human 就原样显示（纯增量退化）。
//
// 展示形态：
//   ┌ ⚠️ 模型名填错了                     ← title，一句话说清哪儿坏了
//   │    你填的「DS v41f」这个模型服务端不认。   ← what，为什么
//   │    改成服务商支持的其中一个：a / b。       ← fix，怎么办
//   │    [ 去改模型名 ]                        ← target → 一键跳设置页
//   │    ▸ 查看技术详情                        ← <details> 折叠原始报错
//   └
// 修复按钮的 data-target 复用 07-settings-events.js 的 .hc-fix-btn 约定，
// 但那套只在设置页绑定；这里的按钮在会话页，所以单独绑一次（见 bindSessionErrorFix）。
// ══════════════════════════════════════════════════════════════════════════

/** 修复按钮文案：target → 按钮上写什么 */
const ERR_FIX_LABEL = {
  'settings-api': '去改模型设置',
  'settings-tools': '去调历史条数',
  'settings-allow': '去改聊天设置',
  connection: '去连接页看看',
  skills: '去管理技能',
  plugins: '去管理插件'
};

/**
 * 渲染会话错误块。有 human 就渲染人话卡片，没有就退回原来那段红字。
 * @param {object} s 会话对象
 * @returns {string} HTML
 */
function sessionErrorHtml(s) {
  const h = s.errorHuman;
  // 没有解释（未知错误 / 老数据）→ 保持原样。宁可不美化，也不能吞掉信息。
  if (!h || !h.title) return `<div class="session-error">${esc(s.error)}</div>`;

  const raw = s.errorRaw || s.error || '';
  const target = h.target && ERR_FIX_LABEL[h.target] ? h.target : null;
  return `<div class="session-error-card">
    <div class="sec-head">
      <span class="sec-ico" aria-hidden="true">⚠️</span>
      <span class="sec-title">${esc(h.title)}</span>
    </div>
    <div class="sec-what">${esc(h.what)}</div>
    <div class="sec-fix">${esc(h.fix)}</div>
    ${target ? `<div class="sec-actions"><button class="btn btn-small sec-fix-btn" type="button" data-target="${esc(target)}">${esc(ERR_FIX_LABEL[target])}</button></div>` : ''}
    ${raw ? `<details class="sec-raw"><summary>查看技术详情</summary><pre>${esc(raw)}</pre></details>` : ''}
  </div>`;
}

/**
 * 绑定错误卡片上「去改设置」的点击。
 * 卡片是每次渲染重建的（renderSessionDetail 里 innerHTML 覆盖），所以用事件委托
 * 挂在 #session-detail 上绑一次即可，不用在每次重渲染后再遍历按钮，
 * 也不会因为重建而重复绑定。
 */
function bindSessionErrorFix() {
  const box = $('#session-detail');
  if (!box || box.dataset.errFixBound === '1') return;
  box.dataset.errFixBound = '1';
  box.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.sec-fix-btn');
    if (!btn) return;
    const target = btn.dataset.target || '';
    try {
      if (target === 'connection') { switchTab('connection'); return; }
      if (target === 'skills') { switchTab('skills'); return; }
      if (target === 'plugins') { switchTab('plugins'); return; }
      if (target === 'settings-api' || target === 'settings-tools' || target === 'settings-allow') {
        // 设置页的三个分区都要先进设置页、再切分区，直接改 state.settingsSection
        // 不会重渲染，必须调既有的两个 render（与 07-settings-events.js 同一路径）。
        switchTab('settings');
        // ⚠️ 换分区前先把挂起的自动保存落盘：state.settingsSection 一变，
        //    doSave 就只收集新分区的字段，旧分区 600ms 窗口内的改动会被漏掉。
        if (typeof flushSettingsSaves === 'function') flushSettingsSaves();
        state.settingsSection = target.replace('settings-', '');
        if (typeof renderSettingsSidebar === 'function') renderSettingsSidebar();
        if (typeof renderSettings === 'function') renderSettings();
      }
    } catch (err) { /* 跳转失败不该再弹一个错误把用户淹了 */ }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// 会话「已发送」里的图片缩略图
// ---------------------------------------------------------------------------
// 后端（src/sessions.js 的 publicSentEntry）对外只给两个渲染相关字段：
// `src` 与 `preview`。
//
// `preview` 是后端算好的语义，前端**只按它落三种状态，不自己判断 type**：
//   'ok'      有可预览地址 → 缩略图
//   'missing' 媒体类条目但拿不到预览地址 → 文字徽标 +「（无预览）」
//   'none'    纯文字等非媒体条目 → 原文字徽标，不加提示
// 这样"本条本来就没图"和"有图但预览拿不到"在界面上可区分，新增来源也不用再动前端。
//
// src 来自模型 / 外部输入 / 会话文件。esc() 只解决 HTML 特殊字符，挡不住
// `javascript:` 这类协议，所以进 src 属性之前必须单独校验：只放行 http(s)，
// 或形如 /api/sessions/<id>/image/<payload>.<sig> 的同源相对路径。
// ══════════════════════════════════════════════════════════════════════════
const SENT_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);
const SENT_LOCAL_IMAGE_RE = /^\/api\/sessions\/[\w-]+\/image\/[A-Za-z0-9_-]+\.[0-9a-f]{32}$/;

/**
 * 取出一条「已发送」记录里可安全渲染的缩略图地址。
 * src 缺失、协议不是 http(s)、相对路径不是受控取图地址时返回空串（退回文字徽标）。
 * @param {object} entry session.sent 里的一条记录
 * @param {function} [tokenize] 给同源地址补控制台令牌（默认用 00-core.js 的 withToken）
 * @returns {string} 可放进 <img src> 的地址，或 ''
 */
function sentImageUrl(entry, tokenize) {
  if (!entry) return '';
  const raw = typeof entry.src === 'string' ? entry.src.trim() : '';
  if (!raw) return '';
  if (SENT_LOCAL_IMAGE_RE.test(raw)) {
    // 浏览器原生加载发不了自定义头：设置 server.token 后必须带 ?token=
    const addToken = typeof tokenize === 'function'
      ? tokenize
      : (typeof withToken === 'function' ? withToken : (u) => u);
    return addToken(raw);
  }
  let parsed;
  try { parsed = new URL(raw); } catch { return ''; }
  return SENT_IMAGE_PROTOCOLS.has(parsed.protocol) ? parsed.href : '';
}

/** 一条「已发送」记录的 HTML：按后端给的 preview 落三种状态之一。 */
function sentBadgeHtml(sent) {
  const label = `已发送到 QQ${sent.at ? ` · ${esc(sent.at)}` : ''}`;
  // preview 是后端唯一措辞来源（见 src/sessions.js publicSentEntry）；
  // 这里只在 'ok' 分支才尝试取地址，取不到时仍按媒体无预览降级，
  // 避免"后端说可预览、地址却过不了前端协议校验"时静默变成纯文字。
  if (sent.preview === 'ok') {
    const imageUrl = sentImageUrl(sent);
    if (imageUrl) {
      // 缩略图放在独立块里，note（sent.text）单独一行：图片本身没有文字信息量，
      // 配的那句话仍要能被读出来，alt 也用它（读屏与图片加载失败时都有内容）。
      // data-error-quiet：加载失败由下面的兜底就地换成一行说明，不再触发全局
      // 「软件界面出了点问题」提示条（外部图床的图过期是常态，见 ui/error-boot.js）。
      return `
        <div class="sent-badge sent-badge--image">
          <div class="asr-label">${label}</div>
          <div class="sent-thumb"><img class="sent-thumb__img" data-error-quiet="1" src="${esc(imageUrl)}" alt="${esc(sent.text)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>
          <div class="sent-thumb__broken" hidden>图片加载失败（链接可能已失效）</div>
          <div class="sent-thumb__note">${esc(sent.text)}</div>
        </div>`;
    }
  }
  // 'missing'：媒体条目但拿不到预览，明确标出来，与纯文字条目区分。
  // 旧会话数据 / 预览模式里的条目没有 preview：按 'none' 处理（原文字徽标），
  // 不为旧数据保留第二套推断逻辑，也不凭 type 自己猜。
  if (sent.preview === 'missing' || sent.preview === 'ok') {
    return `
        <div class="sent-badge sent-badge--nopreview">
          <div class="asr-label">${label} <span class="sent-nopreview-tag">（无预览）</span></div>
          ${esc(sent.text)}
        </div>`;
  }
  return `
        <div class="sent-badge">
          <div class="asr-label">${label}</div>
          ${esc(sent.text)}
        </div>`;
}

/**
 * 缩略图加载失败 → 藏掉坏图、露出文字兜底。事件委托挂在长期容器 #session-detail
 * 上绑一次即可（renderSessionDetail 每次整体重画也还在）。
 * ⚠️ error 事件不冒泡，必须捕获阶段监听。
 */
function bindSentImageFallback() {
  const box = $('#session-detail');
  if (!box || box.dataset.sentImgBound === '1') return;
  box.dataset.sentImgBound = '1';
  box.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('sent-thumb__img')) return;
    const thumb = img.closest('.sent-thumb');
    const broken = thumb?.parentElement?.querySelector('.sent-thumb__broken');
    if (thumb) thumb.hidden = true;
    if (broken) broken.hidden = false;
  }, true);
}

let sessionDetailLoadGeneration = 0;

async function loadSessionDetail(id, { quiet = false } = {}) {
  const generation = ++sessionDetailLoadGeneration;
  try {
    const s = await api(`/api/sessions/${id}`);
    // 请求期间可能切换到另一会话，或同一会话已有更新的详情请求；迟到响应不得覆盖当前状态。
    if (generation !== sessionDetailLoadGeneration || state.currentSessionId !== id) return;
    state.sessionDetail = s;
    if (state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (generation !== sessionDetailLoadGeneration || state.currentSessionId !== id || state.tab !== 'sessions') return;
    if (!quiet) {
      const detail = $('#session-detail');
      if (detail) detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
    }
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态。
  // json 模式切换也要触发重渲染，所以它进指纹。
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};
  // 这一轮会话的缓存命中率（显示在总 token 后面，用户要求）
  const cacheRate = fmtCacheRate(usage);

  const html = [];
  const canDelete = s.status !== 'running';   // 运行中的会话不能删（usage 还在累加）
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${replyFreqChip(s.chatKey)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        ${canDelete ? `<button class="btn btn-small btn-danger" id="session-delete-btn" style="margin-left:6px" title="删除这条会话记录">删除</button>` : ''}
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总${cacheRate ? ` · <span class="cache-rate" title="本轮 prompt 命中前缀缓存的比例">${cacheRate}</span>` : ''}</span>
        <span>${s.rounds || 0} 轮</span>
        <span>工具调用 ${countToolCalls(s)} 次</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
    </div>`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      inputMessages: (s.inputMessages || []).map((m) => ({ role: m.role, content: m.content })),
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible" open>
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card-flow ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name-flow">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card-flow">
            <div class="tool-head"><span class="tool-name-flow">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">思考（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) html.push(sentBadgeHtml(sent));
  }
  if (s.error) html.push(sessionErrorHtml(s));
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  bindSessionErrorFix();   // 错误卡片上的「去改设置」按钮（委托，幂等）
  bindSentImageFallback(); // 图片缩略图加载失败的兜底（委托，幂等）
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  // 删除这条会话记录
  const delBtn = $('#session-delete-btn');
  if (delBtn) delBtn.addEventListener('click', async () => {
    // 破坏性操作带 danger:true，主按钮走危险色，与「取消」在视觉上区分开。
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除',
      message: `确定删除这条会话记录？\n\n触发：${s.triggerSummary || '-'}\n时间：${fmtClock(s.startedAt)}\n\n删除后不可恢复（不影响用量统计的历史数据）。`
    })) return;
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      state.currentSessionId = null;
      state.sessions = (state.sessions || []).filter((x) => x.id !== s.id);
      $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      renderSessionList();
      loadSessions({ quiet: true });
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 这里不要再加"运行中每 2s 自递归拉详情"的轮询：renderSessionDetail 会被 SSE
  // 事件和主轮询反复调用，每次都新起 setTimeout 且从不取消旧的，timer 会不断累积。
  // loadSessions 已经会对 running/waiting 的会话刷新详情，功能完全覆盖。
}
