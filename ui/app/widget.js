// 桌面悬浮小窗的页面脚本（只服务 ui/widget.html，与主界面的 ui/app/*.js 零共享）。
//
// 职责边界（刻意收窄）：
//   · 只读：GET /api/config（拿主题与刷新间隔）+ 轮询 GET /api/status；
//   · 不发任何写请求 —— 置顶/穿透/尺寸/关闭/打开主界面全在主进程的右键菜单里，
//     页面与主进程之间不架 IPC 桥（少一个桥就少一类"渲染进程指哪打哪"的面）。
//   · 所有 DOM 查询都做空值兜底：卡片在窗口极小/显示异常时也不该整页抛白。
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);

  /* 与主界面同一个暗号：真实令牌由主进程 installConsoleRequestAuth 在
     webRequest 里换成进程私有凭据（只对 mainWindow / widgetWindow 的
     webContents 生效）。server.token 为空时后端直接放行，本值无人校验。 */
  const CONSOLE_MARKER = 'qq-agent-console';

  const MIN_MS = 1000;   // 与主进程 WIDGET 夹取范围一致
  const MAX_MS = 60000;

  let refreshMs = 2500;
  let timer = null;
  let inFlight = false;
  let failStreak = 0;
  let lastOkAt = 0;

  // ── 格式化（口径与主界面 00-core.js 的 fmtTokShort / fmtYuan 一致）──
  const fmtTokShort = (n) => {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    if (abs < 1000) return String(Math.round(v));
    if (abs < 1e6) return `${(v / 1e3).toFixed(1)}k`;
    if (abs < 1e9) return `${(v / 1e6).toFixed(2)}M`;
    return `${(v / 1e9).toFixed(2)}G`;
  };
  const fmtYuan = (n) => {
    const v = Number(n) || 0;
    if (v === 0) return '¥0';
    if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
    return `¥${v.toFixed(2)}`;
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  /** 文本写入（节点不存在就静默跳过 —— 见文件头兜底约定）。 */
  const setText = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  const show = (id, on) => { const n = $(id); if (n) n.hidden = !on; };

  /** 给元素加/去一个类（节点不存在就跳过）。 */
  const toggleClass = (id, cls, on) => { const n = $(id); if (n) n.classList.toggle(cls, on); };

  function applyTheme(pref) {
    let actual = pref;
    if (pref === 'system') {
      try {
        actual = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
      } catch { actual = 'dark'; }
    }
    // 小窗只认 dark/light 两个实体值（主界面的 '?' 整活主题不进桌面卡片）
    document.documentElement.setAttribute('data-theme', actual === 'light' ? 'light' : 'dark');
  }

  /**
   * 拉一次配置：只取三项 —— 主题、刷新间隔、背景不透明度。
   * GET /api/config 是只读接口，无来源信息也放行（后端 originAllowed 的口径），
   * 浏览器里直接开 /widget.html 也能正常工作。
   * 不透明度也要周期性重拉（见 pollOnce）：用户在设置里拖滑条，小窗不该
   * 等到重启才变 —— mica 背板由主进程管，卡片 alpha 由这里管。
   */
  let lastPrefsAt = 0;
  async function loadPrefs(force = false) {
    const now = Date.now();
    // R140：3000 → 1000。这个去重原本只是"别被 2.5s 轮询打得太密"的保险，
    // 但它同时会吃掉主进程 widget:prefs-changed 推送带来的那次补拉 ——
    // 用户拖完设置页滑条，推送到了、去重还没过期，卡片继续不更新。
    // 主进程现在只在配置真的变了才推，1000ms 已经足够挡掉重复请求。
    if (!force && now - lastPrefsAt < 1000) return;   // 1s 内不重复拉
    lastPrefsAt = now;
    try {
      const res = await fetch('/api/config', { headers: { 'x-console-token': CONSOLE_MARKER } });
      if (!res.ok) return;
      const cfg = await res.json();
      applyTheme(cfg?.ui?.theme || 'dark');
      ws = cfg?.widget || {};            // 自绘菜单的勾选态以这里的真值为准
      const ms = Number(cfg?.widget?.refreshMs);
      if (Number.isFinite(ms) && ms >= MIN_MS) {
        const next = Math.min(MAX_MS, Math.round(ms));
        if (next !== refreshMs) { refreshMs = next; startPolling(); }
      }
      // 背景不透明度：与主进程 widgetOpacityPct 同口径夹取（30~100），
      // 默认 50 = 半透明卡片（配置里没写/乱写时用这个，别退回不透明）。
      const rawOpa = Number(cfg?.widget?.opacity);
      const pct = Number.isFinite(rawOpa) && rawOpa > 0
        ? Math.min(100, Math.max(30, Math.round(rawOpa))) : 50;
      document.documentElement.style.setProperty('--card-alpha', (pct / 100).toFixed(2));
      // 圆角来源切换（2026-10-23）：透明窗口的圆角归页面画（12px，默认值），
      // 不透明窗口的圆角归 Win11 DWM 画（系统 8px），页面必须让出直角 → 挂 .wd。
      // 两套圆弧同时存在就会在角上露出一片窗口底色 —— 见 electron/main.js
      // createWidgetWindow 与 widget.html 里 --wcard-radius 的注释。
      // 这里只切类，不碰别的样式。
      document.documentElement.classList.toggle('wd', !cfg?.widget?.transparent);
    } catch { /* 拿不到就用默认值，不阻塞状态轮询 */ }
  }

  function renderStatus(s) {
    // 先记时间：页脚要显示"上次更新到这个点"，赋值晚于拼接会让首次渲染
    // 永远不带时间（只有第二轮才补上，且显示的是上一轮的时刻）。
    lastOkAt = Date.now();
    const dot = $('w-dot');
    if (dot) {
      dot.className = 'wdot ' + (s.onebot?.connected ? 'ok' : (s.protocol?.portOpen ? 'wait' : 'bad'));
    }
    // 标题：已上线优先；暂停次之（暂停是用户主动状态，不该被"没连上"盖住）；
    // 否则透出后端诊断原文（它已经是"人话 + 下一步"的口径）。
    let title;
    if (s.paused) title = '机器人已暂停';
    else if (s.onebot?.connected) title = '机器人已上线';
    else title = s.onebot?.diagnosis || '机器人没连上';
    setText('w-title', title);

    // 当前模型（右上角，超长省略）：一眼知道在跑哪个模型
    const model = String(s.orchestrator?.model || '').trim();
    if (model) {
      setText('w-model', model);
      show('w-model', true);
      const m = $('w-model');
      if (m) m.title = model;
    } else {
      show('w-model', false);
    }

    const u = s.usage || {};
    setText('w-runs', String(Number(u.runs) || 0));
    setText('w-tokens', fmtTokShort(u.totalTokens));
    // 成本三态（与顶栏"没有匹配价格就不显示 ¥0"同一意图，但小窗不能留个洞）：
    //   ① 没匹配到价格 → "未计价"（弱化 + 悬停解释去哪填）；
    //   ② 有价且 >0    → 正常金额；
    //   ③ 有价但为 0   → ¥0（真实花费就是 0，不是"没配"）。
    // ⚠️ matched 的口径（src/model-prices.js resolveModelPrice）：命中时是
    //    模型 id 字符串，没命中的是 **null**（source='unmatched'）—— 不是 false，
    //    所以判空用 !c.matched，写 === false 会漏掉真实数据。
    const c = s.cost || {};
    const costVal = Number(c.cost) || 0;
    if (!c.matched) {
      setText('w-cost', '未计价');
      toggleClass('w-cost', 'na', true);
      const el = $('w-cost');
      if (el) el.title = '当前模型没匹配到价格：在「设置 → 模型与搜索」填单价后，这里会显示估算成本';
    } else {
      setText('w-cost', fmtYuan(costVal));
      toggleClass('w-cost', 'na', false);
      const el = $('w-cost');
      if (el) el.title = '';
    }
    // 缓存命中率：数字 + 进度条双通道（扫一眼就知道高不高），分档着色
    // （≥50% 绿 / ≥20% 橙 / <20% 红）。今天没有计费调用时显示 —、条走空。
    const rate = Number(s.cacheHitRate) || 0;
    const hitEl = $('w-hit');
    const bar = $('w-hit-bar');
    if (rate > 0) {
      const pct = Math.round(rate * 100);
      setText('w-hit', `${pct}%`);
      if (hitEl) hitEl.title = '输入 token 里命中前缀缓存的比例（今日）';
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.className = pct >= 50 ? 'hi' : (pct >= 20 ? 'mid' : 'lo');
      }
    } else {
      setText('w-hit', '—');
      if (hitEl) hitEl.title = '今天还没有产生计费调用，暂无命中率';
      if (bar) { bar.style.width = '0%'; bar.className = ''; }
    }

    setText('w-search', `搜索 ${Number(s.webSearchCount ?? u.webSearchCount) || 0} 次`);
    // 2026-10-23：原「接入已停止」（注入暂停）随协议端解耦删除；小窗不再有这类附加状态。
    setText('w-extra', '');
    show('w-extra', false);
    if (lastOkAt) { setText('w-time', hhmm(lastOkAt)); show('w-time', true); }

    failStreak = 0;
  }

  function renderStale() {
    const dot = $('w-dot');
    if (dot) dot.className = 'wdot bad';
    setText('w-title', '连接中…');
    setText('w-search', lastOkAt ? '更新失败' : '正在连接控制台…');
    show('w-extra', false);
    if (lastOkAt) { setText('w-time', `上次 ${hhmm(lastOkAt)}`); show('w-time', true); }
  }

  /* ── 右键菜单：卡片内自绘（原生菜单改不了样式，统一成软件自己的风格）──
     动作只有一个出口：window.qqaWidget 桥（electron/widget-preload.cjs）。
     桥不存在（外壳旧 / preload 失败）时整块置灰 + 提示重启，不静默失效。 */
  let ws = {};
  const bridge = () => (window.qqaWidget && typeof window.qqaWidget.apply === 'function') ? window.qqaWidget : null;
  const menuEl = () => $('w-menu');
  const menuOpen = () => { const m = menuEl(); return !!m && !m.hidden; };

  function renderMenu() {
    const m = menuEl();
    if (!m) return;
    const off = !bridge();
    m.classList.toggle('off', off);
    const hint = $('w-menu-hint');
    if (hint) hint.hidden = !off;
    const setOn = (sel, on) => { const n = m.querySelector(sel); if (n) n.classList.toggle('on', !!on); };
    setOn('[data-toggle="alwaysOnTop"]', ws.alwaysOnTop !== false);
    setOn('[data-toggle="clickThrough"]', !!ws.clickThrough);
    setOn('[data-toggle="edgeHide"]', ws.edgeHide !== false);
    const size = ['s', 'm', 'l'].includes(ws.size) ? ws.size : 'm';
    m.querySelectorAll('[data-size]').forEach((b) => {
      b.classList.toggle('cur', b.getAttribute('data-size') === size);
    });
    const raw = Number(ws.opacity);
    const opa = Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.max(30, Math.round(raw))) : 50;
    const r = $('w-menu-opa');
    if (r) r.value = String(opa);
    const rv = $('w-menu-opa-val');
    if (rv) rv.textContent = `${opa}%`;
  }

  // 开/关去重的时间戳：右键同时走 contextmenu 与 mousedown 两条路径，
  // 只算一次（否则"开了又立刻关"= 点了没反应）。
  let menuToggleAt = 0;
  /** 窗口是不是"基本在屏幕外"（贴边收起态：只剩一条缝）。
   *  这种时候弹菜单用户是看不见的 —— 先把它展开，下次右键才是菜单。 */
  function mostlyOffScreen() {
    try {
      const sw = window.screen?.availWidth || window.screen?.width || 0;
      const sh = window.screen?.availHeight || window.screen?.height || 0;
      if (!sw || !sh) return false;
      const x = window.screenX || 0;
      const y = window.screenY || 0;
      return (x + window.innerWidth < 40) || (y + window.innerHeight < 40)
        || (x > sw - 40) || (y > sh - 40);
    } catch { return false; }
  }

  function openMenu() { const m = menuEl(); if (!m) return; renderMenu(); m.hidden = false; }
  function closeMenu() {
    const m = menuEl();
    if (m) m.hidden = true;
    // 点了菜单项而关闭的：清掉去重窗口，用户马上再右键要能立刻开
    menuToggleAt = 0;
  }

  /** 经桥改设置。失败不抛给页面（下次轮询会用真值覆盖回来）。 */
  async function applyWidget(patch) {
    const b = bridge();
    if (!b) return;
    try {
      await b.apply(patch);
      Object.assign(ws, patch);        // 乐观更新：勾选态立刻跟上手指
      renderMenu();
      loadPrefs(true);                 // 再与主进程真值对齐一次
    } catch { /* 桥不可用时菜单已置灰 */ }
  }

  async function widgetCommand(name) {
    const b = bridge();
    if (!b) return;
    try { await b.command(name); } catch { /* 忽略 */ }
  }

  function bindMenu() {
    const m = menuEl();
    if (!m) return;
    // 右键开/关菜单（再右键一次收起）。
    // 两条触发路径并存：整卡是 -webkit-app-region:drag，个别机器上 contextmenu
    // 会被拖拽区吃掉，mousedown(button=2) 兜住这种情况；300ms 去重防止
    // "两条都到 → 开了又立刻关"变成"点了没反应"。
    const toggleMenu = () => {
      const now = Date.now();
      if (now - menuToggleAt < 300) return;
      menuToggleAt = now;
      if (menuOpen()) { closeMenu(); return; }
      // 收起态（只剩一条缝）时右键 = 先展开：菜单开在屏幕外等于没有
      if (mostlyOffScreen()) { widgetCommand('expand'); return; }
      openMenu();
    };
    document.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleMenu(); });
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      e.preventDefault();
      toggleMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    // 鼠标移出小窗即收起：卡片太小，没有"点空白处关闭"的地方
    document.addEventListener('mouseleave', () => closeMenu());
    m.addEventListener('click', (e) => {
      const row = e.target && e.target.closest ? e.target.closest('.wrow') : null;
      if (!row) return;
      const cmd = row.getAttribute('data-cmd');
      if (cmd === 'open-console') { widgetCommand('open-console'); closeMenu(); return; }
      if (cmd === 'close') { applyWidget({ enabled: false }); closeMenu(); return; }
      const t = row.getAttribute('data-toggle');
      if (t) {
        // alwaysOnTop / edgeHide 默认开（配置里没写就是开），另两项默认关
        const cur = (t === 'alwaysOnTop' || t === 'edgeHide') ? ws[t] !== false : !!ws[t];
        applyWidget({ [t]: !cur });
      }
    });
    const opa = $('w-menu-opa');
    if (opa) {
      opa.addEventListener('input', () => {
        const v = $('w-menu-opa-val');
        if (v) v.textContent = `${opa.value}%`;
      });
      // change（松手）才落盘：拖动过程中的 input 只更新数字，别每帧写配置
      opa.addEventListener('change', () => applyWidget({ opacity: Number(opa.value) }));
    }
    m.querySelectorAll('[data-size]').forEach((b) => {
      b.addEventListener('click', () => applyWidget({ size: b.getAttribute('data-size') }));
    });
  }

  async function pollOnce() {
    if (inFlight) return;          // 上一轮还没回（服务卡住时不要叠请求）
    inFlight = true;
    try {
      const res = await fetch('/api/status', { headers: { 'x-console-token': CONSOLE_MARKER } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderStatus(await res.json());
      // 状态正常时就近刷新一次配置（内部 3s 去重）：设置里改了主题 /
      // 刷新间隔 / 背景透明度，小窗不用重启就能跟上
      loadPrefs();
    } catch {
      failStreak += 1;
      if (failStreak >= 2) renderStale();   // 单次抖动不打扰，连续两次才改口径
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, refreshMs);
  }

  // 主题跟随系统（pref=system 时）：系统深浅色切换要能反应到卡片上
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', () => loadPrefs(true));   // 系统深浅色切换：强制重拉
    }
  } catch { /* 老内核没有该 API，忽略 */ }

  (async function boot() {
    bindMenu();
    // R140：主进程改了 widget 配置会主动推 widget:prefs-changed（旧外壳没有
    // 这个桥时这里静默跳过，退回"2.5 秒轮询 + 1 秒去重"的兜底链路）。
    // 不放进 loadPrefs 的 try 里：桥注册失败只是少一条快路，不影响其它启动。
    try {
      const w = window.qqaWidget;
      if (w && typeof w.onPrefsChanged === 'function') {
        w.onPrefsChanged(() => { loadPrefs(true); });
      }
    } catch { /* 老外壳：忽略 */ }
    await loadPrefs();
    await pollOnce();
    startPolling();
  })();
})();
