// 〔设置事件绑定〕
'use strict';
// ── 设置页渲染守卫 ─────────────────────────────────────────────────────
// 自动保存期间（表单读取 + 保存请求在途），任何代码路径想整页重渲染设置表单
// 都会被拦下并记为"待重绘"（真正的拦截在 renderSettings 开头）。
// 重渲染 = 用 state.config（上一次保存的旧值）重建整个表单 DOM，用户正在输入的
// 未保存内容会被直接吹掉，看起来就是"设置存不上 / 改了又弹回去"。
// 拦下后等保存完成再补一次重绘，那时 state.config 已是最新值，不会丢内容。
const settingsGuard = { pending: 0, needRerender: false };

function beginSettingsGuard() { settingsGuard.pending++; }
function endSettingsGuard() {
  settingsGuard.pending = Math.max(0, settingsGuard.pending - 1);
  if (settingsGuard.pending === 0 && settingsGuard.needRerender) {
    settingsGuard.needRerender = false;
    renderSettings();
  }
}

// ── 离开设置页前的"挂起保存"清单 ───────────────────────────────────────
// bindSettingsEvents 每次重渲染都重建闭包，外部（switchTab）拿不到最新的
// flushSave，用模块级数组中转：渲染时登记、切页时逐个调用、
// 重渲染前清掉同表单的旧登记（表单 DOM 已换，旧 flush 引用的闭包失效）。
let settingsFlushHandlers = [];

/** 切走设置页前调用：把防抖窗口内还没落盘的改动立即保存。 */
function flushSettingsSaves() {
  let failed = 0;
  for (const fn of settingsFlushHandlers) {
    try { fn(); } catch (e) { failed++; console.error('离开设置页前保存失败:', e); }
  }
  // ⚠️ 不能只写 console。用户在设置页改完就切走是常态，而这一支正是"防抖窗口内
  //    还没落盘"的最后一次保存机会。悄悄失败的话，用户以为改动已生效，下次回到
  //    设置页看到的却是旧值。聚合后只提示一次，不 await（切页流程不能被提示框卡住）。
  if (failed) {
    qaAlert(`有 ${failed} 项设置没能保存（后端可能未响应）。请稍后回到设置页确认。`);
  }
}

// ── 设置搜索面板「点外面收起」──────────────────────────────────────────
// 挂在**模块顶层**（脚本加载时执行一次）而不是 bindSettingsEvents 里，
// 后者每次重渲染都会跑，绑在 document 上会无限累积。每次点击时现找 DOM，
// 面板不存在（搜索框未渲染的分区/页面）时天然空转，无泄漏。
document.addEventListener('click', (e) => {
  const panel = document.getElementById('set-search-panel');
  if (!panel || panel.hidden) return;
  if (panel.contains(e.target) || (e.target && e.target.id === 'set-search-input')) return;
  panel.hidden = true;
});

/* ── 体检卡按钮（委托）───────────────────────────────────────────────────
   卡片由 06-settings-render.js 的 refreshHealthCard() 在每次自动保存后单独重建，
   绑定在卡片节点上的监听会随旧节点一起消失。所以挂在**模块顶层**委托到 document：
   每次点击现找节点，重建多少次都只有这一份监听，不会叠加。

   与 02-sse-sessions.js 的 bindSessionErrorFix 同一思路（重建节点 + 事件委托）。 */

/** 健康卡「测试一下」：真实连通性请求。按钮状态也在委托里自己管。 */
async function runConnectivityTest(btn, out, idleLabel) {
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '测试中…';
  if (out) out.textContent = '';
  try {
    // 连接信息（地址 / 密钥）只在「管理服务商」里维护，页面上只剩隐藏字段。
    // 按「隐藏字段兜底、最后用已保存配置」的顺序取值，否则健康卡片上的
    // 「测试一下」永远拿空 baseUrl，必报"请先填写 Base URL"。
    const baseUrl = ($('#cfg-baseurl-value')?.value || state.config?.api?.baseUrl || '').trim();
    const model = ($('#cfg-model')?.value || state.config?.api?.model || '').trim();
    // 不带 apiKey：服务端按 providerId / 已保存配置解析，不依赖明文读取端点，
    // 未设 token 时也能测试。带上 providerId 才能用对那一家的 Key（多服务商场景）。
    const providerId = String($('#cfg-provider')?.value || state.config?.api?.provider || '').trim();
    const r = await api('/api/providers/test-chat', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, providerId, model })
    });
    const res = r.result || {};
    // 思考方言由服务端 model.thinking-detect 能力给出，让用户提前知道这个模型
    // 会走哪套思考参数（避免"开了思考但实际没生效"的黑箱感）。
    const dialect = res.thinking?.label ? ` · 思考参数：${res.thinking.label}` : '';
    if (out) out.textContent = res.ok
      ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}${dialect}`
      : `✗ 测试失败：${res.note || '未知错误'}`;
  } catch (e) {
    if (out) out.textContent = `测试失败：${e.message}`;
  }
  btn.disabled = false;
  btn.textContent = idleLabel;
}

/** 健康卡「去连接页 / 去填写 / 去勾选」：跳到对应位置并高亮。 */
function healthCardGoto(target) {
  if (target === 'connection') {
    // 跳「工具 → 连接」页：协议端由用户自装，那一页给的是状态 +
    // 装什么 / 怎么配的指引，比把用户丢进设置分区里找按钮更有用。
    flushSettingsSaves();   // 换页前先把 600ms 防抖窗口内的改动落盘
    switchTab('connection');
  } else if (target === 'settings-api') {
    // 切换到 API 设置区块
    flushSettingsSaves();   // 同上：换区块前先把旧分区挂起的改动落盘
    state.settingsSection = 'api';
    renderSettingsSidebar();
    renderSettings();
    // 高亮模型配置入口按钮：Base URL 不再是页面输入框，引导用户进「模型配置」弹窗
    setTimeout(() => {
      const input = $('#open-model-config-btn');
      if (input) {
        input.focus();
        input.style.boxShadow = '0 0 0 3px var(--accent)';
        setTimeout(() => { input.style.boxShadow = ''; }, 2000);
      }
    }, 100);
  } else if (target === 'settings-allow') {
    // 切换到白名单设置区块
    flushSettingsSaves();   // 同上
    state.settingsSection = 'allow';
    renderSettingsSidebar();
    renderSettings();
    // 高亮白名单区域
    setTimeout(() => {
      const section = $('#settings-form');
      if (section) {
        section.style.boxShadow = '0 0 0 3px var(--accent)';
        setTimeout(() => { section.style.boxShadow = ''; }, 2000);
      }
    }, 100);
  }
}

document.addEventListener('click', (e) => {
  // 按钮本身会被 runConnectivityTest 改写文字，得在点击时现取节点而不是缓存。
  const btn = e.target?.closest?.('#test-api-btn, .hc-fix-btn');
  if (!btn) return;
  if (btn.id === 'test-api-btn') {
    runConnectivityTest(btn, $('#test-api-result'), '测试一下');
  } else {
    healthCardGoto(btn.dataset.target);
  }
});

/* ── 自动保存状态字 ───────────────────────────────────────────────────────
   设置页是**静默自动保存**：改完没有任何反馈，用户只能靠"下次进来值还在"推断
   存没存上，后端抖动时这正是"设置自己变回去了"的体感来源之一。
   这里在页头右侧（#set-save-state，见 06-settings-render.js）写一个极轻的状态字，
   不弹框，2.4s 后淡出。重渲染会把它清空，可接受，状态本来就是瞬时的。 */
let saveStateTimer = null;
function flashSaveState(text, kind = 'ok') {
  const el = $('#set-save-state');
  if (!el) return;
  el.textContent = text;
  el.className = `set-save-state is-${kind}`;
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    const cur = $('#set-save-state');
    if (cur) { cur.textContent = ''; cur.className = 'set-save-state'; }
  }, 2400);
}

/* ── 外观个性化 ───────────────────────────────────────────────────────────
   色板/取色器/滑块/背景图按钮的绑定与即时应用。
   ⚠️ 这些控件都在 #settings-form 里，改动会触发既有的一次防抖自动保存；
      这里只负责"立刻看到效果"和需要原生能力的两件事（选图、清图）。
      选图走 Electron 桥（原生对话框 + 复制到数据目录），浏览器里打开时按钮会提示不可用。 */
function bindUiCustomEvents() {
  const ui = () => (state.config?.ui || {});

  // 读取页面上当前所有个性化控件的值，合成一份 ui 片段（live 预览 + 保存共用口径）
  const readUi = () => ({
    accent: ($('#cfg-accent-hex')?.value || '').trim(),
    bgColor: ($('#cfg-bgcolor-hex')?.value || '').trim(),
    frameAlpha: Number($('#cfg-framealpha')?.value ?? 100),
    bgImage: String(ui().bgImage || ''),
    bgFit: $('#cfg-bgfit')?.value || 'cover',
    bgDim: Number($('#cfg-bgdim')?.value ?? 0),
    winOpacity: Number($('#cfg-winopacity')?.value ?? 100)
  });

  // 让页面上的输入框与内存里的 ui 保持同一份真值（保存前先把 state.config.ui 同步，
  // saveConfig 的 app 分支就是这样读的，避免"预览变了但保存的还是旧值"）
  const syncToState = () => {
    if (!state.config) return;
    state.config.ui = { ...(state.config.ui || {}), ...readUi() };
  };

  const apply = (opts) => {
    const patch = readUi();
    // ⚠️ 拖动滑条的 `input` 阶段传 { live: true }：applyUiCustom 里的 setOpacity
    //    是跨进程 IPC，挂在 input 上等于拖动时每帧打一次（60fps → 60 次/秒）。
    //    CSS 变量在 live 阶段照样即时更新，只把 IPC 推迟到 change（松手）那一次。
    applyUiCustom(patch, opts);
    syncToState();
  };

  // 色板（强调色 / 底色）
  const wireSwatches = (boxSel, attr, hexInputSel, colorInputSel, key) => {
    const box = $(boxSel);
    if (!box) return;
    const mark = (val) => {
      box.querySelectorAll('.swatch').forEach((el) => {
        const v = el.getAttribute(attr) ?? '';
        el.classList.toggle('on', String(v).toLowerCase() === String(val || '').toLowerCase());
      });
    };
    box.querySelectorAll('.swatch').forEach((el) => {
      const pick = () => {
        const v = el.getAttribute(attr) ?? '';
        const hexEl = $(hexInputSel);
        if (hexEl) {
          hexEl.value = v;
          /* ⚠️ 必须主动派发 input。色板是 <div class="swatch">，点击不产生
             input/change，而设置页的自动保存（#settings-form 上的 input/change
             委托）只认这两个事件。只改 hex 输入框的值和 CSS 变量的话保存从未发起，
             只能等用户之后碰别的控件顺带被读走，或切页/关窗时被 flushSave 兜底，
             表现为"有时候能存、有时候不能"。
             bubbles 让它走到 #settings-form 的委托上；hex → 色板联动本身幂等，
             不会循环（赋 cEl.value 不派发事件）。 */
          hexEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const cEl = $(colorInputSel);
        if (cEl && isHexColor(v)) cEl.value = v;
        mark(v);
        apply();
      };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
    return mark;
  };
  const markAccent = wireSwatches('#accent-swatches', 'data-accent', '#cfg-accent-hex', '#cfg-accent', 'accent');
  const markBg = wireSwatches('#bg-swatches', 'data-bg', '#cfg-bgcolor-hex', '#cfg-bgcolor', 'bgColor');

  // 取色器 / 手填 hex：两边互相同步
  const wireColorPair = (colorSel, hexSel, markFn) => {
    const cEl = $(colorSel);
    const hEl = $(hexSel);
    if (cEl) cEl.addEventListener('input', () => {
      if (hEl) hEl.value = cEl.value;
      if (markFn) markFn(cEl.value);
      apply();
    });
    if (hEl) hEl.addEventListener('input', () => {
      const v = hEl.value.trim();
      if (isHexColor(v) && cEl) cEl.value = v;
      if (markFn) markFn(v);
      apply();
    });
  };
  wireColorPair('#cfg-accent', '#cfg-accent-hex', markAccent);
  wireColorPair('#cfg-bgcolor', '#cfg-bgcolor-hex', markBg);

  // 滑块：拖动时同步显示数字 + 即时应用
  // ⚠️ 拖动中的 `input` 走 apply({ live: true })：只更新 CSS 变量做即时预览，
  //    跳过 setOpacity 这类跨进程 IPC；松手（change）时再落一次完整应用。
  const wireRange = (sel, labelSel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      const lab = $(labelSel);
      if (lab) lab.textContent = el.value;
      apply({ live: true });
    });
    // 松手才把「重操作」落一次（change 在键盘操作时也会触发）
    el.addEventListener('change', () => {
      const lab = $(labelSel);
      if (lab) lab.textContent = el.value;
      apply();
    });
  };
  wireRange('#cfg-framealpha', '#framealpha-val');
  wireRange('#cfg-bgdim', '#bgdim-val');
  wireRange('#cfg-winopacity', '#winopacity-val');

  // ── 桌面悬浮小窗：勾上总开关才解灰下面的选项组 ──
  // 只切样式不动数据（保存仍走 #settings-form 的通用防抖自动保存，
  // 这条 change 照旧冒泡上去触发它）。
  $('#cfg-widget-enabled')?.addEventListener('change', () => {
    const opts = $('#cfg-widget-opts');
    if (!opts) return;
    const on = !!$('#cfg-widget-enabled')?.checked;
    opts.style.opacity = on ? '' : '.45';
    opts.style.pointerEvents = on ? '' : 'none';
  });

  /* ── 背景不透明度滑条：拖动时即时落盘 + 即时同步小窗 ───────────────────
     只走 #settings-form 的 600ms 防抖全量保存的话，要等主进程轮询、再等小窗
     状态轮询，最坏约 4.6 秒卡片才变色，滑条本身跟不上卡片的变化。

     所以 input 直接发一份只含 opacity 的局部 patch。updateConfig 是 deepMerge，
     不会动 config.widget 的其它字段；主进程 300ms 内通过 IPC 主动推给小窗。
     松手时 #settings-form 的 change 委托照旧 flushSave() 全量落盘（同一个值），
     "离开页签 / 关页面"的落盘口径完全没变。

     ⚠️ 必须节流：input 在拖动中每帧都触发，而每次都是同步写盘（updateConfig
        里 writeFileSync + rename），不节流会把磁盘和配置写入打满。
     ⚠️ 失败只复位 lastSent 让下一轮重试，不弹提示：全量保存有自己的重试链路，
        这里打断拖动提示反而更吵。 */
  const opaRange = $('#cfg-widget-opacity');
  if (opaRange) {
    const opaLabel = $('#cfg-widget-opacity-val');
    let opaLastSent = -1;
    let opaTimer = null;
    const sendOpa = async () => {
      const v = Number(opaRange.value);
      if (!Number.isFinite(v) || v === opaLastSent) return;
      opaLastSent = v;
      if (opaLabel) opaLabel.textContent = `${v}%`;
      // 乐观更新内存：若在请求在途时发生重渲染，滑条不会被弹回旧值
      // （renderSettings 用 state.config.widget.opacity 重建控件）
      state.config = state.config || {};
      state.config.widget = { ...(state.config.widget || {}), opacity: v };
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ widget: { opacity: v } }) });
      } catch {
        opaLastSent = -1;   // 这一跳没成：让下一次输入/全量保存带上它重试
      }
    };
    opaRange.addEventListener('input', () => {
      if (opaLabel) opaLabel.textContent = `${opaRange.value}%`;   // 数字先动，不等网络
      if (opaTimer) clearTimeout(opaTimer);
      // 250ms：每次发送都是一次整份 config 落盘（writeFileSync + rename），
      // 间隔太短时拖 10 秒就是几十次全量写，磁盘慢时还会和 #settings-form 的
      // 全量保存抢队列。250ms 仍在"拖一下就变色"的手感区间内。
      opaTimer = setTimeout(() => { opaTimer = null; sendOpa(); }, 250);
    });
    // 松手立即把最后位置发出去，不等节流尾巴（final change 之后没有后续输入了）
    opaRange.addEventListener('change', () => {
      if (opaTimer) { clearTimeout(opaTimer); opaTimer = null; }
      sendOpa();
    });
  }

  /* ── 界面背景：两层背景的互斥开关 ───────────────────────────────────────
     改这里之前先记住背景事实：
       · 本地图片  config.ui.bgImage → #app-bg 的 background-image
       · 小红车壁纸 localStorage['wp-console-bg'] → html[data-wp='on'] + #wp-bg-video/#wp-bg-img
     style.css 有一条 `html[data-wp='on'] #app-bg { display: none }`：
     壁纸一启用，本地图就被整层隐藏。两者不是叠加，是后者顶掉前者。

     所以下面三段的目标是「让当前生效的是哪一层，用户看得见、也改得动」：
       ① refreshBgStatus   状态行 + 恢复按钮的显隐，任何切换后立刻重算
       ② 选本地图          自动撤壁纸（否则选完不可见），撤之前先备份原壁纸
       ③ 关壁纸 / 恢复壁纸  成对的后悔药，避免"壁纸没了还得在几百张里重找"
  */
  const BG_PREV_KEY = 'wp-console-bg-prev';
  // 三个函数都来自 14-wallpaper.js，它排在 07 之后 defer（全局 function 声明）。
  // 运行时（绑定事件、点按钮）一定已就位；加守卫只为兜"纯核心部署把壁纸模块摘掉"。
  const wpReady = () => typeof wpCfgLoad === 'function' && typeof wpCfgSave === 'function';

  // 撤掉壁纸：只清 localStorage 里的选择，不动 config。
  // 14 那边的 wpRenderBackground 看到"没有 id"就会摘掉 html[data-wp]，
  // #app-bg 随即从 display:none 里恢复，本地图才可能被看见。
  const wpPause = () => {
    if (!wpReady()) return false;
    const cfg = wpCfgLoad();
    if (!cfg || !cfg.id) return false;
    try { localStorage.setItem(BG_PREV_KEY, JSON.stringify(cfg)); } catch { /* 存储满/被禁：放弃备份，功能照走 */ }
    wpCfgSave(null);                                    // 同时同步给后端（多窗口/机器人技能）
    if (typeof wpRenderBackground === 'function') wpRenderBackground();
    return true;
  };

  const refreshBgStatus = () => {
    // 壁纸模块不在就别碰这行，06 渲染时用内联 IIFE 算好了一份，
    // 这里覆盖成"无"反而是错的（会把真实的本地图状态抹掉）。
    if (typeof wpCfgLoad !== 'function') return;
    const el = $('#cfg-bgstatus');
    const wp = wpCfgLoad();
    const wpOn = !!(wp && wp.id);
    const local = String(state.config?.ui?.bgImage || '').trim();
    // bg-we- 前缀是"旧版插件自动抓的小红车缩略图"，不是用户手选的图；
    // 口径与 00-core.js 的 applyUiCustom 保持一致（那里用 autoThumb 判定让它给壁纸让位）。
    const autoThumb = local.startsWith('bg-we-');
    if (el) {
      if (wpOn) el.innerHTML = `<b style="color:var(--accent)">当前生效：Wallpaper Engine 壁纸</b>（${esc(wp.title || wp.id)}）${local ? '　·　本地图片已被隐藏' : ''}`;
      else if (local && !autoThumb) el.innerHTML = `<b style="color:var(--accent)">当前生效：本地图片</b>（${esc(local)}）`;
      else if (local) el.innerHTML = `<b style="color:var(--accent)">当前生效：自动缩略图</b>（${esc(local)}，壁纸模块的降级兜底）`;
      else el.textContent = '当前生效：无 —— 只有界面底色。两层背景都没有启用。';
    }
    const cur = $('#cfg-wp-current');
    if (cur) cur.textContent = wpOn ? `当前壁纸：${wp.title || wp.id}` : '当前没有启用壁纸。';
    // 恢复按钮：只在"有备份 + 当前确实没壁纸"时露出来，否则是一枚点了没反应的按钮
    const restore = $('#cfg-wp-restore');
    if (restore) {
      let hasPrev = false;
      try { hasPrev = !!JSON.parse(localStorage.getItem(BG_PREV_KEY) || ''); } catch { hasPrev = false; }
      restore.hidden = !(hasPrev && !wpOn);
    }
  };
  refreshBgStatus();
  // 壁纸库是弹窗（14-wallpaper.js 的 wpOpenLibrary），关掉时那边要把设置页这行
  // 状态同步一次，但它够不着这个局部函数，只能挂到 window 上。
  // 不挂的话，在弹窗里换了壁纸、关掉一看，状态行还是进来之前那句。
  try { window.refreshBgStatus = refreshBgStatus; } catch { /* ignore */ }

  // 打开壁纸库：弹出壁纸库弹窗（浮在设置页之上），不再整页跳转。
  // 每次点选都是即时生效的，选完就该回到原来的位置，而不是"切页 → 选 → 再切回设置"。
  // 弹窗壳（08-modals.js）万一没加载，wpOpenLibrary 内部会退回整页。
  $('#cfg-open-wallpaper')?.addEventListener('click', () => {
    if (typeof wpOpenLibrary === 'function') wpOpenLibrary();
    else if (typeof switchTab === 'function') switchTab('wallpaper');
    else location.hash = '#wallpaper';   // 极端兜底：至少把地址指过去
  });

  // 关闭壁纸：清选择 + 摘 data-wp，#app-bg 立刻回来
  $('#cfg-wp-off')?.addEventListener('click', () => {
    const hint = $('#cfg-bg-hint');
    if (!wpReady()) { if (hint) hint.textContent = '壁纸模块未加载，无法操作。'; return; }
    const cfg = wpCfgLoad();
    if (!cfg || !cfg.id) { refreshBgStatus(); return; }
    try { localStorage.setItem(BG_PREV_KEY, JSON.stringify(cfg)); } catch { /* 备份失败不影响关闭 */ }
    wpCfgSave(null);
    if (typeof wpRenderBackground === 'function') wpRenderBackground();
    refreshBgStatus();
    if (hint) hint.textContent = '已关闭壁纸。想反悔点「↩ 恢复上次的壁纸」。';
  });

  // 恢复上次的壁纸（上面两处自动/手动撤下时都会留备份）
  $('#cfg-wp-restore')?.addEventListener('click', () => {
    const hint = $('#cfg-bg-hint');
    if (!wpReady()) return;
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(BG_PREV_KEY) || ''); } catch { cfg = null; }
    if (!cfg || !cfg.id) { refreshBgStatus(); return; }
    wpCfgSave(cfg);
    if (typeof wpRenderBackground === 'function') wpRenderBackground();
    refreshBgStatus();
    if (hint) hint.textContent = `已恢复壁纸：${cfg.title || cfg.id}。本地图片又被隐藏了（两层互斥）。`;
  });

  // 背景图填充方式
  $('#cfg-bgfit')?.addEventListener('change', () => apply());

  // 选择背景图（走 Electron 原生对话框；没有桥时给出明确提示，不静默失败）
  $('#cfg-bg-pick')?.addEventListener('click', async () => {
    const hint = $('#cfg-bg-hint');
    if (!window.qqaDesktop || typeof window.qqaDesktop.pickBgImage !== 'function') {
      if (hint) hint.textContent = '当前不是桌面端（或外壳版本较旧），无法选择本地图片。';
      return;
    }
    try {
      const r = await window.qqaDesktop.pickBgImage();
      if (!r?.ok) return;                       // 用户取消了，什么都不做
      // 保存：背景图不进防抖队列（它是"选完就定"的一次性动作，即时落盘更可预期）
      state.config = state.config || {};
      state.config.ui = { ...(state.config.ui || {}), bgImage: r.name, bgFit: $('#cfg-bgfit')?.value || 'cover' };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      const clearBtn = $('#cfg-bg-clear');
      if (clearBtn) clearBtn.disabled = false;   // 有图可清了
      // 壁纸开着时本地图会被整层隐藏（html[data-wp='on'] #app-bg{display:none}），
      // 所以选完图顺手把壁纸撤下来，否则"选了图却什么都没变"，用户只会以为按钮坏了。
      // 原选择已备份到 wp-console-bg-prev，页面会露出「↩ 恢复上次的壁纸」。
      const paused = wpPause();
      refreshBgStatus();
      if (hint) hint.textContent = `已设置：${r.name}（图片已复制到数据目录）。想看到它，把「底色不透明度」调低一点。`
        + (paused ? ' 已同时撤下 Wallpaper Engine 壁纸（点「↩ 恢复上次的壁纸」可撤回）。' : '');
    } catch (e) {
      if (hint) hint.textContent = `选择背景图失败：${e.message || e}`;
    }
  });

  // 清除背景图
  $('#cfg-bg-clear')?.addEventListener('click', async () => {
    const hint = $('#cfg-bg-hint');
    try {
      if (window.qqaDesktop && typeof window.qqaDesktop.clearBgImage === 'function') {
        await window.qqaDesktop.clearBgImage();
      }
      state.config = state.config || {};
      state.config.ui = { ...(state.config.ui || {}), bgImage: '' };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      const clearBtn = $('#cfg-bg-clear');
      if (clearBtn) { clearBtn.disabled = true; clearBtn.title = '还没有设置背景图'; }   // 没图可清了
      if (hint) hint.textContent = '已清除背景图。';
      refreshBgStatus();   // 状态行要跟着变：清图后可能退化成"只有界面底色"
    } catch (e) {
      if (hint) hint.textContent = `清除失败：${e.message || e}`;
    }
  });

  // 外观恢复默认：清掉所有个性化字段并立即落盘 + 重渲染（让控件回到默认位）
  $('#cfg-uicustom-reset')?.addEventListener('click', async () => {
    const hint = $('#cfg-uicustom-hint');
    try {
      if (window.qqaDesktop && typeof window.qqaDesktop.clearBgImage === 'function') {
        await window.qqaDesktop.clearBgImage();
      }
      state.config = state.config || {};
      state.config.ui = {
        ...(state.config.ui || {}),
        accent: '', bgColor: '', frameAlpha: 100, bgImage: '', bgFit: 'cover', bgDim: 0, winOpacity: 100
      };
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: state.config.ui }) });
      applyUiCustom(state.config.ui);
      renderSettings();
      if (hint) hint.textContent = '已恢复默认外观。';
    } catch (e) {
      if (hint) hint.textContent = `恢复失败：${e.message || e}`;
    }
  });
}

function bindSettingsEvents(c) {
  if (state.settingsSection === 'backup') { settingsFlushHandlers = []; bindBackupSettings(); return; }
  // 设置页顶部全局提示：知道了 ↔ 展开（选择记在 localStorage，见 06 的 setPageHeadHtml）
  const hintClose = $('#set-hint-close');
  if (hintClose) hintClose.addEventListener('click', () => {
    try { localStorage.setItem('qa.settingsHintClosed', '1'); } catch { /* 隐私模式忽略 */ }
    renderSettings();
  });
  const hintOpen = $('#set-hint-open');
  if (hintOpen) hintOpen.addEventListener('click', () => {
    try { localStorage.removeItem('qa.settingsHintClosed'); } catch { /* 忽略 */ }
    renderSettings();
  });
  /* ── 即时保存：任何设置项变动 → 防抖 600ms 自动保存 ──
     变动反馈由「↩ 撤销本次设置」按钮承担（见 showUndoBtn）。
     不要再加 .dirty-glow 那种流动渐变带：半透明渐变 + background-position
     无限动画在透明分层窗口上会被逐帧 alpha 混合成一条黄色残影。 */
  let saveTimer = null;
  let saving = false;
  // 连续自动保存失败计数：成功清零，失败递增。
  // 用于"每连续失败 3 次弹一次提示"的节流，避免后端挂掉时弹窗轰炸。
  let saveFailures = 0;
  // 撤销快照：进入本设置区块时拍一份配置；有改动后显示「撤销」按钮，
  // 点击 = 整份配置回滚到快照（设置是即时生效的，回滚与改动之间发生的一切不负责）。
  const sectionSnapshot = structuredClone(state.config || {});
  let undoBtn = null;

  function markDirty() {
    showUndoBtn();
    scheduleSave();
  }

  function showUndoBtn() {
    if (undoBtn || !$('#settings-form')) return;
    undoBtn = document.createElement('button');
    undoBtn.className = 'btn btn-small settings-undo-btn';
    undoBtn.textContent = '↩ 撤销本次设置';
    undoBtn.title = '把本区块的设置整体还原到你进入时的状态。\n注意：设置是即时生效的，改动到撤销之间机器人可能已按新设置运行过，这部分不回滚。';
    undoBtn.addEventListener('click', async () => {
      // 撤销会丢弃本区块改动 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: '撤销',
        message: '确定撤销本次设置？\n将把整个配置还原到你进入本设置区块之前的状态。\n（改动期间的运行行为不会被追回）'
      })) return;
      try {
        // 整份快照写回（后端 updateConfig 深合并；快照含全部字段，等价整体覆盖）。
        // ⚠️ 不带 keepalive：fetch keepalive 有 64KB body 上限，整份配置快照
        // （含 providers/价格表/技能设置）很容易超，超限时 fetch 直接以
        // "Failed to fetch" 拒绝。keepalive 只用于页面卸载兜底（小 patch）。
        const r = await api('/api/config', { method: 'POST', body: JSON.stringify(sectionSnapshot) });
        if (r && r.config) state.config = r.config;
        renderSettings();
      } catch (e) {
        qaAlert(`撤销失败：${e.message}`);
      }
    });
    const form = $('#settings-form');
    // 放在整页表单**最底下**（prepend 会顶在标题上方，把第一行设置项挤下去；
    // 有改动时视线应该在内容末尾收尾，而不是被顶上的按钮打断阅读）
    if (form) form.appendChild(undoBtn);
  }

  function scheduleSave(delay = 600) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, delay);
  }

  async function doSave() {
    if (saving) { scheduleSave(); return; }
    saving = true;
    // 渲染守卫：从"开始收集表单"到"state.config 更新完成"期间不允许整页重渲染。
    // saveConfig 会先逐字段读 DOM、再 POST 并用响应覆盖 state.config，
    // 中途任何重渲染（SSE 事件 / 轮询回调）都会吹掉用户正在输入的值。
    beginSettingsGuard();
    try {
      await saveConfig({ quiet: true });
      saveFailures = 0;
      // 静默保存的唯一反馈：页头右侧一个会自己淡出的「已保存」。
      try {
        const t = new Date();
        flashSaveState(`✓ 已保存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`, 'ok');
      } catch { /* 反馈失败不影响保存本身 */ }
      refreshStatus();
      // 页头体检卡 + 侧栏「配置就绪」小标按新的 state.config 就地刷新：
      // 两处结论都来自 assessReadiness() 这个纯函数，只在渲染那一刻求值一次，
      // 保存完成后 state 已是新值而 DOM 还是旧的（填好白名单，卡片仍说"还没配置"）。
      // 不用整页 renderSettings()：那会吹掉用户正在输入的表单（settingsGuard 防的
      // 就是这件事）。必须放在 saveConfig 之后，此刻 state.config 才是新值。
      refreshHealthCard();
      refreshSettingsReadiness();
      startListPoller();
      // 刷新间隔可能刚被改过：重建状态轮询，让新间隔立刻生效
      startStatusPoller();
    } catch (e) {
      console.error('自动保存失败:', e);
      // ⚠️ 自动保存失败不能只写 console。这正是"关掉的功能重启后又自己打开"的
      //    根源之一：UI 显示的是内存态，落盘失败时磁盘还是旧值，重启后从磁盘重读，
      //    看起来就是"设置自己变回去了"，而用户全程毫无感知。
      //    策略：3 秒后自动重试（后端抖动自愈）；每连续失败 3 次弹一次窗（节流，
      //    避免后端宕机时弹窗轰炸）。重试成功即清零，永不到达弹窗分支。
      saveFailures++;
      try { flashSaveState('保存失败，正在重试…', 'err'); } catch { /* 反馈失败不影响重试 */ }
      if (saveFailures % 3 === 0) {
        qaAlert(`设置自动保存已连续失败 ${saveFailures} 次（后端可能未响应）。\n界面显示的改动可能并未生效 —— 请检查程序状态，稍后在设置页重新确认。`);
      }
      scheduleSave(3000);
    } finally {
      saving = false;
      endSettingsGuard();
    }
  }

  // 立即保存（清掉防抖定时器，当场发起）。
  // 两个触发点：
  //   1. change 事件（复选框勾选/下拉框切换/日期时间选择），这类操作语义上
  //      已经"完成"，没有继续输入的后续，等 600ms 毫无意义，还留出
  //      "改完立刻切页签 → 定时器随 DOM 一起销毁 → 改动丢失"的窗口。
  //   2. 切走设置页前（switchTab flush），同上，是离开前的最后一刻。
  // 定时器回调里先清引用：doSave 里若正在保存会再次 scheduleSave()，
  // 旧引用不清掉会让"已取消的定时器"看起来还活着。
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    doSave();
  }

  // 表单变动监听（设置页所有输入都会经过这里）。
  // input（打字/拖滑条）保持 600ms 防抖聚批；change（勾选/选择完成）立即保存，
  // change 之后再没有"同一字段的后续输入"，防抖只会增加丢失窗口。
  //
  // ⚠️ 防重复绑定：#settings-form 是静态元素（只换 innerHTML），renderSettings
  //    每次都会调 bindSettingsEvents。每次都在 form 上 addEventListener + 向 window
  //    挂 beforeunload 的话，N 次重渲染后每敲一个字触发 N 次保存（N 个并发 POST），
  //    关页时 N 次 keepalive 请求可能撞配额。
  //    仿照 attachScrollLoader：监听器只挂一次，闭包引用存在元素属性上，
  //    重渲染时只更新引用。
  // 数字输入框「聚焦时滚轮改值」的经典误触：鼠标停在 number 框上滚页面，值被悄悄
  // ±1 并随后自动保存，用户完全无感知。只在聚焦时拦截，未聚焦的滚动照常滚页面。
  if (!window.__numWheelGuard) {
    window.__numWheelGuard = true;
    document.addEventListener('wheel', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('input[type=number]') && document.activeElement === t) {
        e.preventDefault();
      }
    }, { passive: false });
  }
  // 全局防连点：同一按钮 400ms 内的第二次点击直接吞掉。
  // 背景：多个弹窗的保存/添加按钮没有 disabled 防护，连点会并发两次请求，
  // 配置类补丁幂等无妨，但「添加提供商 / 添加搜索服务」这类创建型端点可能落两条重复记录。
  // 用捕获阶段统一拦截，比逐处改 6 个弹窗可靠；项目里没有依赖双击的交互。
  if (!window.__clickGuard) {
    window.__clickGuard = true;
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      const now = Date.now();
      if (b.__lastClick && now - b.__lastClick < 400) {
        e.stopPropagation();
        e.preventDefault();
      } else {
        b.__lastClick = now;
      }
    }, true);
  }
  const form = $('#settings-form');
  if (form && !form.__settingsBound) {
    form.__settingsBound = {
      markDirty: (el) => markDirty(el),
      flushSave: () => flushSave()
    };
    form.addEventListener('input', (e) => form.__settingsBound.markDirty(e.target), { passive: true });
    // ⚠️ change（勾选/下拉切换）必须立即落盘，不走 600ms 防抖：这个窗口正是
    //    "关完开关马上退出 → 改动没落盘 → 重启后开关自己变回去"的成因。
    //    input（打字/拖滑条）保持防抖聚批不变。
    //    markDirty 里的 scheduleSave 会先被 flushSave 清掉，不会重复保存。
    form.addEventListener('change', (e) => {
      form.__settingsBound.markDirty(e.target);
      form.__settingsBound.flushSave();
    }, { passive: true });
    // 页面关闭/刷新兜底：防抖窗口内直接关页面前，先把挂起的保存发出去。
    // fetch keepalive 让请求在页面卸载后仍能完成（sendBeacon 带不了
    // 自定义头，这里用同款 api() 的 POST + keepalive 更简单可靠）。
    // 只挂一次：N 个闭包各带一个定时器，关页时并发 POST 反而丢数据。
    window.addEventListener('beforeunload', () => {
      if (form.__settingsBound) form.__settingsBound.flushSave();
    });
  } else if (form) {
    // 已绑定过：只刷新引用，指向本次渲染的新闭包
    form.__settingsBound.markDirty = (el) => markDirty(el);
    form.__settingsBound.flushSave = () => flushSave();
  }

  // 暴露给页签切换等外部路径：离开设置页前把挂起的改动落盘。
  // ⚠️ 必须挂在模块级状态上（bindSettingsEvents 每次重渲染都重建闭包），
  //    switchTab 才能找到"当前这一份"的 flush。
  //    每次都 push 会让数组无限增长，所以清空只留当前一份：重渲染后旧闭包的
  //    saveTimer 引用已失效，留着只会有害。
  settingsFlushHandlers = [];
  const flush = () => flushSave();
  settingsFlushHandlers.push(flush);

  // ── Skill 开关 ──
  // Skill 的启停要跑生命周期回调（activate/deactivate），所以是立即生效并落盘，
  // 不走"未保存更改"流程，避免"界面显示已开、后端还没开"的中间态。
  // ⚠️ 下面这段是死代码：选择器 `.skill-toggle` 与真实类名（`.skill-toggle-row` /
  //    `[data-skill-toggle]`）不符，从未命中过；真实绑定在 06-settings-render.js。
  //    保留仅作历史参考，不再参与运行。
  [].forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.skillId;
      cb.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: JSON.stringify({ enabled: cb.checked })
        });
        // 用后端返回的状态覆盖本地，保证展示与判定一致
        const idx = (state.skills || []).findIndex((s) => s.id === id);
        if (idx >= 0 && r.skill) state.skills[idx] = r.skill;
        if (r.config) state.config = r.config;
        await loadSkillsStatus();
        renderSettings();
      } catch (err) {
        cb.checked = !cb.checked;   // 失败回滚勾选状态
        qaAlert(`切换技能失败：${err.message}`);
      } finally {
        cb.disabled = false;
      }
    });
  });

  // ── 工具分类块：按块绑定 + 局部刷新 ──────────────────────────────────
  // 分类总开关 / 折叠展开只重建自己这一个 .tool-category 块（refreshToolCategory），
  // 不整页 renderSettings()：整页 innerHTML 重建是肉眼可见的闪烁，还会白白重绑
  // 全页事件。块内渲染与整页渲染同源（buildToolCategoryHTML，见 06-settings-render.js）。
  function refreshToolCategory(cat) {
    const el = document.querySelector(`.tool-category[data-category="${cat}"]`);
    // 找不到块（已切走设置页等）→ 兜底走整页渲染
    if (!el) { renderSettings(); return; }
    const tpl = document.createElement('template');
    tpl.innerHTML = buildToolCategoryHTML(cat).trim();
    const fresh = tpl.content.firstElementChild;
    if (!fresh) { el.remove(); return; }
    el.replaceWith(fresh);
    bindToolCategoryEvents(fresh);
  }

  function bindToolCategoryEvents(block) {
    const cat = block.dataset.category;

    // 单个工具开关
    block.querySelectorAll('.tool-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const toolId = cb.dataset.toolId;
        state.config.tools = state.config.tools || {};
        // send_to 的勾选 = 「跨会话发送」开关本身（收编进消息发送分类）
        if (cb.dataset.crossChat) {
          state.config.tools.crossChatSend = cb.checked;
        } else {
          state.config.tools.overrides = state.config.tools.overrides || {};
          state.config.tools.overrides[toolId] = cb.checked;
        }
        const card = cb.closest('.tool-card');
        if (card) {
          card.classList.toggle('enabled', cb.checked);
          card.classList.toggle('disabled', !cb.checked);
          const box = card.querySelector('.tool-checkbox-box');
          if (box) box.textContent = cb.checked ? '✓' : '✗';
        }
        // 实时更新提示词预览
        updatePromptPreview();
        // 标脏走表单链（自动保存 'tools' 分支读 state.config.tools 整体提交）
        const form = $('#settings-form');
        if (form && form.__settingsBound) form.__settingsBound.markDirty(card || cb);
      });
    });

    // 分类开关 = 一键总闸：
    //   关 → 整类停用，子开关视觉跟着全关且不可拨（渲染层按 categories[cat] 汇合）；
    //   开 → 自动展开该分类并把子工具全部打开（一键全开），子开关各自仍可单独关。
    // 单个开/关只写自己的 override，不回写分类开关，两个层级互不干扰。
    const catCb = block.querySelector('.category-checkbox');
    if (catCb) catCb.addEventListener('change', () => {
      state.config.tools = state.config.tools || {};
      state.config.tools.categories = state.config.tools.categories || {};
      state.config.tools.categories[cat] = catCb.checked;
      if (catCb.checked) {
        // 一键全开 + 展开：子工具 override 全部置真（send_to 特殊：它对应 crossChatSend）
        state.config.tools.overrides = state.config.tools.overrides || {};
        (state.toolRegistry || []).filter((t) => t.category === cat).forEach((t) => {
          if (t.id === 'send_to') state.config.tools.crossChatSend = true;
          else state.config.tools.overrides[t.id] = true;
        });
        state.collapsedToolCategories ??= new Set();
        state.collapsedToolCategories.delete(cat);
      }
      // 只重绘这一个分类块（子开关全亮/全灰、展开态），其余 DOM 原地不动
      refreshToolCategory(cat);
      updatePromptPreview();
    });

    // 头部点击 = 展开/折叠（点在开关上不触发，也不闪整页）
    const header = block.querySelector('.tool-category-header');
    if (header) header.addEventListener('click', (e) => {
      if (e.target.closest('.tool-category-toggle')) return;
      state.collapsedToolCategories ??= new Set();
      if (state.collapsedToolCategories.has(cat)) state.collapsedToolCategories.delete(cat);
      else state.collapsedToolCategories.add(cat);
      refreshToolCategory(cat);
    });
  }

  $$('.tool-category').forEach(bindToolCategoryEvents);

  // 全局开关
  const toolsEnabledCb = $('#cfg-tools-enabled');
  if (toolsEnabledCb) toolsEnabledCb.addEventListener('change', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = toolsEnabledCb.checked;
    updatePromptPreview();
  });

  // 全部启用/禁用/恢复默认
  // ⚠️ 这三个是 <button>，click 不产生 input/change，设置页的自动保存（#settings-form
  //    上的事件委托）根本收不到。只改内存 + 重渲染的话，"点完立刻关程序/被强杀"这一路
  //    改动会整个丢掉。批量开关影响面最大，必须当场落盘。
  //    saveConfig 的 tools 分支从 state.config.tools 读，所以只需补上 flush。
  $('#tools-enable-all')?.addEventListener('click', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = true;
    state.config.tools.overrides = {};
    state.config.tools.categories = {};
    renderSettings();
    try { flushSave(); } catch { /* 保存失败由 doSave 内部的重试与提示接管 */ }
  });
  $('#tools-disable-all')?.addEventListener('click', () => {
    state.config.tools = state.config.tools || {};
    state.config.tools.enabled = false;
    renderSettings();
    try { flushSave(); } catch { /* 同上 */ }
  });
  $('#tools-security')?.addEventListener('click', () => {
    // 浏览锁定 / 内网图片 / 外部链接白名单：独立模态框，自己 POST patch
    // （见 09-community.js 的 openSecurityModal）。
    if (typeof openSecurityModal === 'function') openSecurityModal();
  });
  $('#tools-reset')?.addEventListener('click', () => {
    // 恢复默认：分类开关回到完整默认集（核心 6 类 + media/knowledge/utility 全开），
    // 而不是写空对象 {}，旧写法会清掉用户显式关闭过的分类、且漏掉 utility 键。
    state.config.tools = {
      enabled: true,
      overrides: {},
      categories: { messaging: true, sticker: true, query: true, memory: true, web: true, system: true, media: true, knowledge: true, utility: true }
    };
    renderSettings();
    try { flushSave(); } catch { /* 同上 */ }
  });

  /** 实时更新提示词预览（后端同源组装，前端不拼静态模板） */
  function updatePromptPreview() {
    // 立即刷：工具开关已同步写进 state.config.tools，但自动保存有 600ms 防抖、
    // 还没落盘。所以把当前工具态随请求发过去，后端合并补丁组装但不落盘，
    // 预览即刻反映刚点的开关。
    const overrides = { tools: state.config?.tools || {} };
    refreshPromptPreview(overrides);
  }

  // 分类展开/折叠已并入上方 bindToolCategoryEvents（局部刷新，不再整页重绘）

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
    // 自定义服务 Key 框随选中项重置：不同服务各自的掩码/空状态在渲染时生成，
    // 但切换提供方是原地改 display 不重渲染，这里手动对齐，避免上一家的
    // Key 残留显示给下一家（看起来像"共享 Key"，实际两家的 Key 互不相干）。
    const cpKey = $('#cfg-custom-sp-key');
    const cpToggle = $('#cfg-custom-sp-key-toggle');
    if (cpKey) {
      const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === v);
      cpKey.type = 'password';
      cpKey.value = cp?.hasApiKey ? '******' : '';
      cpKey.placeholder = '输入新 Key 可替换；留空保持不变';
      if (cpToggle) cpToggle.textContent = '显示';
    }
  });

  // ── 自定义搜索服务：测试 / 删除 ──
  // （"添加"在 openAddSearchProviderModal 弹窗里，08-modals.js 自带绑定；
  //   页面上是「⚙ 添加自定义搜索服务」入口按钮。）
  $('#open-add-search-provider-btn')?.addEventListener('click', () => openAddSearchProviderModal());

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    // 删除服务 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除服务',
      message: `确定删除搜索服务「${name}」？`
    })) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });

  // ── 聊天设置两个收纳模态框的入口 ──
  $('#open-send-config-btn')?.addEventListener('click', () => openSendConfigModal());
  $('#open-active-config-btn')?.addEventListener('click', () => openActiveConfigModal());

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 外观个性化 ──
  // 全部"改了立刻看得到"，落盘交给设置页统一的防抖自动保存（saveConfig）。
  bindUiCustomEvents();

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // ⚠️ 不要在 #cfg-model 上挂 input 监听：它是 type="hidden"，永远收不到用户输入。
  // 价格卡的刷新由 refreshModelPriceCard() 自己的调用点负责。
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 前缀缓存保活 ──
  // 开关与间隔都即时保存（后端每次 tick 重读配置，无需重启）。
  $('#cfg-cachewarm')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ cacheWarm: { enabled } }) });
      e.target.checked = enabled;
    } catch (err) {
      // 保存失败要把勾选状态回滚，否则界面显示"已开"而后端仍是关的
      e.target.checked = !enabled;
      qaAlert(`保存失败：${err.message}`);
    }
  });
  $('#cfg-cachewarm-interval')?.addEventListener('change', async (e) => {
    const n = Math.min(1440, Math.max(1, Number(e.target.value) || 10));
    e.target.value = n;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ cacheWarm: { intervalMin: n } }) });
    } catch (err) {
      qaAlert(`保存失败：${err.message}`);
    }
  });

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    if (statusEl) statusEl.textContent = '正在拉取官网价格表…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 通用折叠：总开关关闭 → 对应子设置块平滑收起（CSS grid 1fr↔0fr 动画）──
  // 保存不用这里管：上面的表单级 input/change 监听已统一走防抖自动保存，
  // 折叠只是视觉收起，控件仍在 DOM 里，val()/chk() 照常读到值。
  // 表里的顺序 = 模板里出现的顺序，新增折叠块时两边一起加。
  for (const [swSel, subId] of [
    ['#cfg-useofficialprice', 'price-sub'],
    ['#cfg-cachewarm', 'cachewarm-sub'],
    ['#cfg-websearch', 'websearch-sub'],
    ['#cfg-mem-consolidate', 'mem-sub'],
    ['#cfg-proactive', 'proactive-sub'],
  ]) {
    const box = $(swSel);
    const sub = document.getElementById(subId);
    if (box && sub) box.addEventListener('change', () => sub.classList.toggle('folded', !box.checked));
  }

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    // 反向：勾上「用主模型」→ 不需要选专用模型 → 折叠（CSS grid 动画，不再是瞬隐）
    const box = $('#mem-model-box');
    if (box) box.classList.toggle('folded', memUseChat.checked);
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 替换成真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key'],
    ['cfg-custom-sp-key-toggle', 'cfg-custom-sp-key'],
    ['cfg-obtoken-toggle', 'cfg-obtoken'],
    ['cfg-obhttptoken-toggle', 'cfg-obhttptoken']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：显示真实 Key（若之前是掩码/空占位）
          input.type = 'text';
          input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住。
          // ⚠️ 空输入不要强制回填掩码：把 current === '' 也变成 '******' 会吞掉
          //    用户"清空输入框想清除 Key"的意图，已存 Key 永远无法清除。
          //    空 = 保持空；掩码只盖"真实 Key 原样"这一种。
          const current = input.value || '';
          input.type = 'password';
          if (real && current === real) {
            input.value = '******';
          } else if (current === '******') {
            input.value = '******';
          } else {
            // 空串（清空意图）或新输入的 Key：保持原值
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以"显示"必须向后端专用端点要明文，不能直接读 state.config）。
  // 自定义服务是动态的：field 值在切换提供方时才定（custom:<id>），
  // 所以这里是个函数而不是常量表。
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': () => 'deepseek',
    'cfg-zhipu-key': () => 'zhipu',
    'cfg-bocha-key': () => 'bocha',
    'cfg-baidu-key': () => 'baidu',
    'cfg-metaso-key': () => 'metaso',
    'cfg-custom-sp-key': () => ($('#cfg-searchprovider')?.value || '').startsWith('custom:')
      ? $('#cfg-searchprovider').value
      : null
  };

  // 搜索服务 Key 的「清除密钥」按钮（与模型 API 页同款语义：
  // 留空保存 = 保持不变，真清除必须点按钮）
  const SEARCH_KEY_CLEAR_BTN = {
    'cfg-ds-searchkey-clear': 'cfg-ds-searchkey',
    'cfg-zhipu-key-clear': 'cfg-zhipu-key',
    'cfg-bocha-key-clear': 'cfg-bocha-key',
    'cfg-baidu-key-clear': 'cfg-baidu-key',
    'cfg-metaso-key-clear': 'cfg-metaso-key',
    'cfg-custom-sp-key-clear': 'cfg-custom-sp-key'
  };
  for (const [btnId, inputId] of Object.entries(SEARCH_KEY_CLEAR_BTN)) {
    const btn = $(`#${btnId}`);
    if (!btn) continue;
    btn.addEventListener('click', async () => {
      const isCustom = inputId === 'cfg-custom-sp-key';
      const field = SEARCH_KEY_FIELDS[inputId]?.();
      if (!field) return;
      const input = $(`#${inputId}`);
      // 清除凭据不可逆 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: '清除 Key',
        message: '确定清除该搜索服务已保存的 API Key？'
      })) return;
      try {
        if (isCustom) {
          // 自定义服务的 Key 存在 providers 数组条目里，不能走 webSearch.<field> 路径。
          // 重用 POST /api/search-providers 的"已存在则更新"分支：同一 baseUrl+type
          // 命中 existing，传空 apiKey 即清除。
          const cp = (state.config?.webSearch?.providers || []).find((p) => `custom:${p.id}` === field);
          if (!cp) throw new Error('找不到这个自定义搜索服务');
          await api('/api/search-providers', {
            method: 'POST',
            body: JSON.stringify({
              name: cp.name, type: cp.type, baseUrl: cp.baseUrl,
              model: cp.model, apiKey: '', count: cp.count, timeoutMs: cp.timeoutMs
            })
          });
        } else {
          // 内置五家：空串走正常保存链就能清除（sanitize 删掉了掩码、空串覆盖旧值）
          await api('/api/config', { method: 'POST', body: JSON.stringify({ webSearch: { [field]: { apiKey: '' } } }) });
        }
        if (input) { input.value = ''; input.placeholder = '输入新 Key 可替换'; }
        const hint = $('#search-provider-action-hint');
        if (hint) hint.textContent = 'API Key 已清除';
        await loadSettings();
      } catch (e) {
        qaAlert(`清除失败：${e.message}`);
      }
    });
  }

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId]?.();
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      // 环境变量提供的 Key：配置里没存（apiKey 空）但 env 有，显示时直接亮出
      // env 值（运行时优先级是 cfg > env，用户"看一眼"应该覆盖两种来源）。
      return String(r.apiKey || '');
    }
    // OneBot 令牌：与搜索 Key 同样的"显示明文"专用端点
    if (inputId === 'cfg-obtoken' || inputId === 'cfg-obhttptoken') {
      const which = inputId === 'cfg-obtoken' ? 'ws' : 'http';
      const r = await api(`/api/onebot-token?which=${encodeURIComponent(which)}`);
      return String(r.token || '');
    }
    return '';
  }
  // 备选模型行：模型 ID + 可选提供商（留空 = 沿用主模型的提供商）
  let fallbackRows = (Array.isArray(c.api?.fallbackModels) ? c.api.fallbackModels : []).map((f) => ({ model: f.model || '', provider: f.provider || '' }));
  if (fallbackRows.length === 0) fallbackRows = [{ model: '', provider: '' }];
  // 备选模型点选：readonly 输入框 → 弹模型目录选择器，选完写回行数据并触发表单保存。
  // 不让手输，杜绝"打错模型 id 等运行时才报错"。
  function openFallbackModelPicker(rowIdx) {
    const providers = state.providers || [];
    if (!providers.length) { qaAlert('模型目录为空：请先在本页上方添加提供商。'); return; }
    const currentModel = fallbackRows[rowIdx]?.model || '';
    const overlay = modelModalShell({
      head: `选择备选模型（第 ${rowIdx + 1} 行）`,
      body: `
        <div class="model-modal-left" id="mm-left"></div>
        <div class="model-modal-right" id="mm-right"></div>`,
      foot: `<button class="btn" id="mm-cancel">取消</button>`
    });
    const left = overlay.querySelector('#mm-left');
    const right = overlay.querySelector('#mm-right');
    let activePid = providers[0].id;
    function renderLeft() {
      left.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${providerRowHtml(p)}</div>`).join('');
      left.querySelectorAll('.mm-prov').forEach((el) => {
        el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
      });
    }
    function renderRight() {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { right.innerHTML = ''; return; }
      const names = p.modelNames || {};
      right.innerHTML = p.models.map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span class="mm-check">${m === currentModel ? '✓' : ''}</span>
          <span>${esc(names[m] || m)}</span>
          ${(names[m] || m) !== m ? `<span class="muted" style="font-size:11px">${esc(m)}</span>` : ''}
        </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
      right.querySelectorAll('.mm-model').forEach((el) => {
        el.addEventListener('click', () => {
          fallbackRows[rowIdx].model = el.dataset.model;
          // 提供商下拉同步指向所选提供商（备选可跨提供商，这里帮用户带上）
          fallbackRows[rowIdx].provider = activePid;
          closeModelModal(overlay);
          renderFallbackRows();
          // renderFallbackRows 整表重建 DOM，焦点会掉回 body（之后 Ctrl+V 全废），
          // 且 closeModelModal 归还的旧行元素已被移除，重建后显式还给该行
          // 选择框之后第一个可编辑控件。
          focusFirstEditableAfter($(`.fb-model-pick[data-i="${rowIdx}"]`));
          // 通知自动保存：fallbackModels 从 DOM 实时读，触发表单监听即可
          $('#fallback-model-rows')?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
    }
    renderLeft();
    renderRight();
    overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
  }
  function renderFallbackRows() {
    const box = $('#fallback-model-rows');
    if (!box) return;
    // 没有提供商列：选模型时自动带上所属提供商（跨渠道备选仍有效），
    // 手动再选一遍纯属多余。行内只留 模型点选 + 删除。
    const provNameOf = (pid) => {
      const p = (state.providers || []).find((x) => x.id === pid);
      return p ? providerLabelOf(p) : '';
    };
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:88%">备选模型（点击选择；提供商随模型自动确定）</th><th></th></tr>
        ${fallbackRows.map((row, i) => `
          <tr>
            <td><input type="text" class="fb-model-pick" data-i="${i}" readonly placeholder="点击选择模型" data-model="${esc(row.model || '')}" data-provider="${esc(row.provider || '')}" value="${esc(row.model ? (provNameOf(row.provider) ? `${provNameOf(row.provider)} · ${row.model}` : row.model) : '')}" style="cursor:pointer" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger fb-del" data-i="${i}" ${fallbackRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.fb-model-pick').forEach((el) => {
      el.addEventListener('click', () => { openFallbackModelPicker(Number(el.dataset.i)); });
    });
    box.querySelectorAll('.fb-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (fallbackRows.length <= 1) return;
        fallbackRows.splice(Number(el.dataset.i), 1);
        renderFallbackRows();
      });
    });
  }
  renderFallbackRows();
  const addFallbackRowBtn = $('#add-fallback-row-btn');
  if (addFallbackRowBtn) addFallbackRowBtn.addEventListener('click', () => {
    fallbackRows.push({ model: '', provider: '' });
    renderFallbackRows();
  });

  // ── 「模型设置」「管理服务商」两个入口模态框 ──
  // 分工：模型设置只管"用哪个服务商、哪个模型"（专用模型 / 图片视频开关 /
  // 视频理解方式也在这里）；服务商的名称、接口地址、密钥、代理与模型目录
  // 全在「管理服务商」（mg-* 字段）。
  $('#open-model-config-btn')?.addEventListener('click', () => openModelConfigModal());
  $('#open-model-manage-btn')?.addEventListener('click', () => openModelManageModal());
  // ── 新手引导卡：未配置模型时 api 分区只渲染「接口地址 + 密钥 + 测试并保存」，
  //    一键完成 拉模型 → 建服务商 → 选模型 → 测连通。
  //    已配置后该卡不渲染，这两个绑定自然失效（?. 守卫）。
  $('#fg-start')?.addEventListener('click', () => runFirstTimeGuide());
  $('#fg-key-toggle')?.addEventListener('click', () => {
    const input = $('#fg-apikey');
    const btn = $('#fg-key-toggle');
    if (!input || !btn) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '隐藏' : '显示';
  });

  // ── 设置搜索 ─────────────────────────────────────────────────────
  // 索引表 SETTINGS_SEARCH_INDEX 在 06-settings-render.js。交互：
  //   输入 → 面板列出命中项（权重排序）→ ↑↓ 选择 / Enter 或点击直达。
  // 直达路径与健康卡 hc-fix-btn 完全同型：先 flush 防抖窗口内的挂起改动
  //   （否则切分区后旧分区的输入不会被保存），再切分区 + 高亮目标元素。
  const ssInput = $('#set-search-input');
  const ssPanel = $('#set-search-panel');
  if (ssInput && ssPanel) {
    let ssResults = [];
    let ssActive = 0;
    const ssRenderPanel = () => {
      if (!ssResults.length) { ssPanel.hidden = true; ssPanel.innerHTML = ''; return; }
      ssActive = Math.max(0, Math.min(ssActive, ssResults.length - 1));
      ssPanel.innerHTML = ssResults.map((r, i) => `
        <button type="button" class="ssp-item ${i === ssActive ? 'active' : ''}" data-i="${i}">
          <span class="ssp-label">${esc(r.label)}</span><span class="ssp-desc">${esc(r.desc)}</span>
        </button>`).join('');
      ssPanel.hidden = false;
      ssPanel.querySelectorAll('.ssp-item').forEach((el) => el.addEventListener('click', () => ssGoto(Number(el.dataset.i))));
    };
    const ssSearch = () => {
      const q = ssInput.value.trim().toLowerCase();
      if (!q) { ssResults = []; ssRenderPanel(); return; }
      const exact = (it) => it.keys.some((k) => k === q);
      ssResults = SETTINGS_SEARCH_INDEX
        .filter((it) => it.keys.some((k) => k.includes(q) || q.includes(k)))
        .sort((a, b) => (exact(b) ? 1 : 0) - (exact(a) ? 1 : 0) || b.w - a.w)
        .slice(0, 8);
      ssActive = 0;
      ssRenderPanel();
    };
    const ssGoto = (i) => {
      const it = ssResults[i];
      if (!it) return;
      ssPanel.hidden = true;
      ssInput.value = '';
      ssInput.blur();
      flushSettingsSaves();
      state.settingsSection = it.section;
      renderSettingsSidebar();
      renderSettings();
      if (it.target) {
        setTimeout(() => {
          const el = document.getElementById(it.target);
          if (!el) return;
          el.style.boxShadow = '0 0 0 3px var(--accent)';
          try { el.focus({ preventScroll: true }); } catch { /* 非聚焦元素忽略 */ }
          el.scrollIntoView({ block: 'nearest' });
          setTimeout(() => { el.style.boxShadow = ''; }, 2000);
        }, 120);
      }
    };
    ssInput.addEventListener('input', ssSearch);
    ssInput.addEventListener('keydown', (e) => {
      if (ssPanel.hidden || !ssResults.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); ssActive = (ssActive + 1) % ssResults.length; ssRenderPanel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); ssActive = (ssActive - 1 + ssResults.length) % ssResults.length; ssRenderPanel(); }
      else if (e.key === 'Enter') { e.preventDefault(); ssGoto(ssActive); }
      else if (e.key === 'Escape') { ssPanel.hidden = true; }
    });
  }
  // 拿当前 API Key 真实值的函数已删除：唯一调用点随「模型配置」弹窗改版消失，
  // 它引用的 #cfg-apikey 也不存在了。弹窗内自带取 Key 逻辑。

  // 健康卡片的「测试一下 / 去连接页 / 去填写 / 去勾选」不在这里绑定：
  // 卡片会被 refreshHealthCard() 单独重建，绑定节点会随旧节点丢失；
  // 统一走本文件顶层的 document 点击委托（runConnectivityTest / healthCardGoto）。




  // 图片输入能力提示（视觉扫描结果）：图片输入开关本体已移入「模型配置」模态框，
  // 这里只更新区块头部的 #model-vision-hint。
  function syncVisionSwitch(pid, model) {
    const vhint = $('#model-vision-hint');
    if (!vhint) return;
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
      vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
    } else {
      vhint.textContent = '';
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 「扫描视觉能力」按钮已删除。视觉能力数据仍由内置视觉表 + 模型目录徽标提供；
  // 后端 /api/vision/scan 端点保留（无 UI 入口），SSE vision-scan 监听保留兜底。

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  const personaPick = $('#cfg-persona-pick');
  function currentPersonaId() {
    // ⚠️ 必须按已保存配置的 roleText 比对，不能读 `$('#cfg-roletext')?.value`：
    //    那个输入框早已随人设编辑器搬进弹窗、不在 DOM 里，恒返回空串，
    //    会让删除按钮永远不显示、"当前人设"提示永远为空。
    //    口径与 06-settings-render.js 渲染"当前人设名"一致（`c.persona?.roleText`）。
    const roleText = String(state.config?.persona?.roleText ?? '');
    const found = Object.entries(state.personaTemplates || {})
      .find(([, p]) => String(p.text ?? '') === roleText);
    return found ? found[0] : '';
  }
  function syncPersonaButtons() {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const isCustom = id.startsWith('custom_');
    const delBtn = $('#del-persona-btn');
    if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
    const hint = $('#persona-pick-hint');
    if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
  }
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    // 删除人设 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: '删除人设',
      message: `确定删除自定义人设「${tpl.name}」？`
    })) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      // 必须判空：元素不在 DOM（视图未渲染/结构变化）时裸赋值会抛 TypeError，
      // 把已经成功的 DELETE 当成失败处理。
      const roleEl = $('#cfg-roletext');
      const rulesEl = $('#cfg-customrules');
      if (roleEl) roleEl.value = state.personaTemplates.xiaojingyu?.text || '';
      if (rulesEl) rulesEl.value = '';
      // 删除 = 表单值被程序化改回默认人设：同样派发 input 触发自动保存，
      // 否则"删完切走"后配置里还是被删掉的那套角色设定（保存从未发起）。
      $('#cfg-roletext')?.dispatchEvent(new Event('input', { bubbles: true }));
      await loadSettings();
    } catch (e) {
      // 同上：提示条元素缺席时不能让异常吞掉真实错误
      const hintEl = $('#persona-pick-hint');
      if (hintEl) hintEl.textContent = `删除失败：${e.message}`;
      else console.error('[persona] 删除失败：', e);
    }
  });
  
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 人设页：统一/分会话切换 + 分会话按钮网格 ──
  // 唯一真相是隐藏 input 里的 JSON（与分群档位滑条同一套做法）。
  // 统一开关：切显隐（不触发保存，display 切换不是配置变化，真正的值在 checkbox 上）。
  const personaUnifiedChk = $('#cfg-persona-unified');
  if (personaUnifiedChk) personaUnifiedChk.addEventListener('change', () => {
    const ub = $('#persona-unified-box');
    const pb = $('#persona-perchat-box');
    if (ub) ub.style.display = personaUnifiedChk.checked ? '' : 'none';
    if (pb) pb.style.display = personaUnifiedChk.checked ? 'none' : '';
  });
  // 分会话按钮：点开独立人设模态框（写回隐藏 JSON → 自动保存）
  // root 判空：统一模式下这个节点也可能不在场，$$ 对 null root 会直接抛错。
  const perChatBox = $('#persona-perchat-box');
  if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
    btn.addEventListener('click', () => openPerChatPersonaModal(btn.dataset.chat));
  });
  // 人设编辑入口：两个模式各一个按钮（统一模式=「编辑人设」，分群模式=「全局人设设置」），
  // 打开的是同一个弹窗，所以用一个函数绑两次，别让哪个模式漏掉入口。
  $('#open-global-persona-btn')?.addEventListener('click', () => openGlobalPersonaModal());
  $('#open-persona-editor-btn')?.addEventListener('click', () => openGlobalPersonaModal());
  // 群名异步补显：按钮文字先显示"群 号"，拉到群名后替换
  api('/api/onebot/groups').then((d) => {
    const names = new Map((d.groups || []).map((g) => [String(g.id), g.name]));
    if (perChatBox) $$('.persona-chat-btn', perChatBox).forEach((btn) => {
      const m = /^group:(\d+)$/.exec(String(btn.dataset.chat || ''));
      if (!m) return;
      const n = names.get(m[1]);
      if (!n) return;
      const hasDot = btn.textContent.includes('●');
      btn.textContent = hasDot ? `${n} ●` : n;
    });
  }).catch(() => {});

  // ── 检查更新（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  const checkUpdateBtn = $('#check-update-btn');
  if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-hint');
    checkUpdateBtn.disabled = true;
    if (hint) hint.textContent = '检查中…';
    const data = await runUpdateCheck({ manual: true });   // 手动：即使关过浮窗也再弹一次
    if (!data) {
      if (hint) hint.textContent = '检查失败：网络不可达';
    } else if (data.disabled) {
      if (hint) hint.textContent = `${data.reason || '在线更新检查未启用'}（当前为手动安装模式）`;
    } else if (!data.ok) {
      if (hint) hint.textContent = `检查失败：${data.error || '未知错误'}`;
    } else if (data.hasUpdate) {
      // 有新版：给下载链接。Electron 里 target=_blank 会被 main.js 转给系统浏览器。
      if (hint) hint.innerHTML = data.url
        ? `发现新版本 <b>v${esc(data.latest)}</b>（当前 v${esc(data.current)}） <a href="${esc(data.url)}" target="_blank" rel="noopener">去下载</a>`
        : `发现新版本 <b>v${esc(data.latest)}</b>（当前 v${esc(data.current)}），更新源未提供下载地址`;
    } else if (hint) hint.textContent = `已是最新（v${data.current}）`;
    checkUpdateBtn.disabled = false;
  });

  // ── OneBot 区块事件 ──
  /* ── 一键启动 + 便携版管理 ──
     协议端解耦后，「一键启动」只剩启动 QQ 这一步，SnowLuma / NapCat 由用户自己装、
     自己启动，本软件不碰。
     状态模型：renderSettings 同步渲染、运行态是异步接口，所以 qbRefresh() 先拉
     /api/status + /api/qq-portable/status 存进 qb，再 qbPaint() 只改 quickbar 与
     「QQ 来源」块的文字/按钮态，不重建表单。 */
  if ($('#quick-start-btn')) {
    const qb = { qqReady: false, qqRunning: false, protoUp: false, source: 'none', portableInstalled: false, portableSupported: true, connected: false };

    const qbPaint = () => {
      const text = $('#quick-start-text');
      const btn = $('#quick-start-btn');
      if (!btn) return;
      btn.disabled = !!qb.connected;
      // 已连接是终态：保留一个可见的锚点，但必须禁用，别让人以为还要再点什么。
      // ⚠️ 这一位由 qbRefresh 从 /api/status 读回来，三步链成功时也置位，
      //    否则成功后的 qbRefresh 会立刻把「已连接 ✓」覆盖回启动态文案。
      if (qb.connected) {
        if (text) text.textContent = '机器人已连接，正常工作中 —— 状态与日志见「工具 → 连接」页';
        btn.textContent = '已连接 ✓';
        btn.disabled = true;
      } else if (!qb.portableSupported) {
        // 一键启动依赖 QQNT（只有 Windows 版）。非 Windows 上藏掉按钮，
        // 只留一句"自己登录 QQ + 自己起协议端"，否则用户点下去只会看到 spawn 失败。
        if (text) text.textContent = '这台机器上「一键启动 QQ」不可用（便携 QQ 仅 Windows）—— 请自行登录 QQ 并启动协议端（SnowLuma 或 NapCat）';
        btn.textContent = '不可用';
        btn.disabled = true;
      } else if (!qb.qqReady) {
        if (text) text.textContent = '没找到可用的 QQ —— 装好新版 QQ（QQNT，官网下载即可）后点右边重新检测';
        btn.textContent = '重新检测 QQ';
      } else if (!qb.qqRunning) {
        if (text) text.textContent = qb.source === 'local'
          ? '已用上你电脑里的 QQ —— 点一下直接启动，机器人会另开一个窗口登录'
          : '点一下启动机器人用的 QQ（更推荐用你电脑里已装的 QQ）';
        btn.textContent = '启动机器人的 QQ';
      } else if (!qb.protoUp) {
        if (text) text.textContent = 'QQ 已启动，但协议端没在运行 —— SnowLuma / NapCat 需要你自己启动';
        btn.textContent = '重新检查';
      } else {
        if (text) text.textContent = '协议端在运行 —— 正在等机器人上线…';
        btn.textContent = '等待连接…';
      }
      // 「QQ 来源」块：按状态显隐按钮 + 一句话现状
      const stateEl = $('#qq-portable-state');
      const pStart = $('#qq-portable-start-btn');
      const pInstall = $('#qq-install-btn');
      const intro = $('#qq-source-intro');
      if (!qb.portableSupported) {
        // 便携 QQ 依赖 QQNT，只有 Windows 版。mac/Linux 上「装独立副本」永远
        // 只会得到「没找到本机安装的 QQ」—— 那条路在这里不可达，不是"还没装"。
        // 藏掉两个按钮，把这句话说清楚，免得用户反复点。
        if (intro) intro.textContent = '便携 QQ（含「装独立副本」）仅 Windows 可用 —— QQNT 没有 macOS / Linux 版。当前平台请用外部 OneBot 协议端（如 NapCat / LLOneBot）配合你已登录的 QQ。';
        if (stateEl) stateEl.textContent = '便携 QQ 仅 Windows 可用';
        if (pStart) pStart.style.display = 'none';
        if (pInstall) pInstall.style.display = 'none';
        return;
      }
      if (stateEl) stateEl.textContent = !qb.portableInstalled
        ? (qb.source === 'none' ? '未检测到 QQ，也没装独立副本 —— 先装一个新版 QQ（QQNT）'
          : '未装独立副本 —— 当前直接用你电脑里已装的 QQ ✓')
        : (qb.qqRunning ? `独立副本 QQ 运行中（pid ${qb.pid ?? '—'}）` : '已装独立副本，未运行');
      if (pStart) pStart.style.display = qb.portableInstalled ? '' : 'none';
      if (pInstall) pInstall.style.display = qb.portableInstalled ? 'none' : '';
    };

    const qbRefresh = async () => {
      try {
        const [st, q] = await Promise.all([
          api('/api/status').catch(() => null),
          api('/api/qq-portable/status').catch(() => null)
        ]);
        if (!st) {
          const stateEl = $('#qq-portable-state');
          if (stateEl) stateEl.textContent = '状态读取失败（后端没有应答）';
          return;
        }
        const qq = q || st.qqPortable || {};
        qb.qqReady = !!qq.ready;
        qb.qqRunning = !!qq.running;
        qb.pid = qq.pid ?? null;
        qb.source = qq.source || (qb.qqReady ? 'portable' : 'none');
        qb.portableInstalled = qq.portableInstalled !== undefined ? !!qq.portableInstalled : (qb.source === 'portable');
        // supported 缺省按 true：后端字段未就位时保持 Windows 的现有行为，
        // 不能因为读不到就突然把安装入口藏掉（与 ffmpeg 的 canAutoInstall 同口径）。
        qb.portableSupported = qq.supported !== false;
        qb.protoUp = !!st.protocol?.portOpen;
        qb.connected = !!st.onebot?.connected;
        qbPaint();
      } catch { /* 拉不到就保持占位文案，不打断设置页 */ }
    };

    // 「一键启动」：启动链参数别改，14-chrome.js 的「开始对话」按钮按同一套节奏走。
    const quickStartBtn = $('#quick-start-btn');
    quickStartBtn.addEventListener('click', async () => {
      const btn = quickStartBtn;
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      if (hint) hint.textContent = '';
      try {
        // 步骤 0：没检测到 QQ → 重新检测（force=1 跳过 30s 探测缓存）
        if (!qb.qqReady) {
          if (hint) hint.textContent = '正在重新检测…';
          const r = await api('/api/qq-portable/status?force=1');
          if (r?.ready) {
            if (hint) hint.textContent = '✓ 检测到 QQ，可以启动了';
            qb.qqReady = true;
            qb.source = r.source || (qb.source === 'none' ? 'local' : qb.source);
            qbPaint();
          } else {
            if (hint) hint.textContent = '还是没检测到 —— 确认装的是新版 QQ（QQNT），装完再点一次';
            btn.disabled = false;
          }
          return;
        }
        // 步骤 1：启动 QQ（local / portable 都走同一接口，后端按 source 分流）
        if (!qb.qqRunning) {
          btn.textContent = '启动 QQ 中…';
          if (hint) hint.textContent = 'QQ 启动中 —— 它不会自动弹窗，稍候到任务栏/托盘把窗口调出来登录/扫码';
          const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            if (hint) hint.textContent = `QQ 启动失败：${r.error}`;
            qbPaint();
            return;
          }
          qb.qqRunning = true;
          // 等 3 秒让 QQ 完全启动
          await new Promise((r2) => setTimeout(r2, 3000));
        }
        // 步骤 2：协议端不由本软件启动。没在跑就明确告诉用户去哪儿装 / 怎么启动，
        // 在这里干等 5 分钟只会让人以为程序坏了。
        const st2 = await api('/api/status').catch(() => null);
        if (!st2?.protocol?.portOpen) {
          qb.protoUp = false;
          if (hint) hint.textContent = 'QQ 已启动，但协议端没在运行 —— 到「工具 → 连接」页按指引启动 SnowLuma 或 NapCat（本软件不再自带协议端）';
          qbPaint();
          return;
        }
        qb.protoUp = true;
        // 步骤 3：等待 OneBot 连接
        // ⚠️ 最多等 5 分钟。只等 30 秒就报"连接超时"的话，用户很可能还没扫码登录
        //    （首次登录本来就要一两分钟），看到超时以为失败又点一次，越点越乱。
        //    等待期间每隔十几秒把"正在等什么、你现在该做什么"写清楚。
        btn.textContent = '等待机器人上线…';
        const WAIT_STEP_MS = 2000;
        const WAIT_MAX_MS = 5 * 60 * 1000;
        for (let waited = 0; waited < WAIT_MAX_MS; waited += WAIT_STEP_MS) {
          // 用户切走页签/分区后按钮已不在 DOM，循环仍在每 2 秒打一次 /api/status
          // （最多 5 分钟）。这里直接收尾，不再空转。
          if (!btn.isConnected) return;
          await new Promise((r2) => setTimeout(r2, WAIT_STEP_MS));
          const s = await api('/api/status').catch(() => null);
          if (s?.onebot?.connected) {
            if (hint) hint.textContent = '✅ 已连接！机器人开始工作';
            // ⚠️ 走 qbPaint() 落终态，别手写 btn.textContent：紧随其后的
            //    qbRefresh() 会重画一次，手写的字样会被覆盖。
            qb.connected = true;
            qbPaint();
            qbRefresh();
            return;
          }
          // 每 ~16 秒刷新一次提示（别每秒改字，看着像在闪）
          if (hint && waited % 16000 < WAIT_STEP_MS) {
            const secs = Math.round(waited / 1000);
            hint.textContent = secs < 20
              ? '正在等机器人上线 —— 如果 QQ 还没登录，到 QQ 窗口里扫码登录'
              : `还在等（已 ${secs} 秒）—— 登录完 QQ 后会自动连上，不用再点这个按钮；状态见「工具 → 连接」页`;
          }
        }
        if (hint) {
          hint.textContent = '等了 5 分钟还没连上 —— 到「工具 → 连接」页看状态：'
            + '最常见是机器人 QQ 还没登录，或协议端的端口/令牌与这里不一致。';
        }
        qbPaint();
      } catch (e) {
        if (hint) hint.textContent = `启动失败：${e.message}`;
        qbPaint();
      }
    });

    // 「单独启动便携 QQ」（仅装了独立副本时显示）
    const pStartBtn = $('#qq-portable-start-btn');
    if (pStartBtn) pStartBtn.addEventListener('click', async () => {
      const btn = pStartBtn;
      const hint = $('#qq-portable-hint');
      btn.disabled = true;
      if (hint) hint.textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        if (hint) hint.textContent = r.alreadyRunning
          ? '便携 QQ 已在运行 ✓'
          : (r.ok ? '已启动 —— QQ 不会自动弹窗，到任务栏/托盘把窗口调出来登录' : `启动失败：${r.error}`);
      } catch (e) {
        if (hint) hint.textContent = `启动失败：${e.message}`;
      }
      qbRefresh();
    });

    // 「装独立副本（可选）」：从本机 QQ 复制一份（1~2GB，分钟级），带进度轮询。
    // ⚠️ 判断"装没装完"要看 portableInstalled / setup.ok，不能看 ready：
    //    本机有 QQ 时 ready 本来就是 true，用它会一进来就误判"装好了"。
    const pInstallBtn = $('#qq-install-btn');
    if (pInstallBtn) pInstallBtn.addEventListener('click', async () => {
      const btn = pInstallBtn;
      const hint = $('#qq-portable-hint');
      btn.disabled = true;
      btn.textContent = '安装中…';
      if (hint) hint.textContent = '正在从你电脑里的 QQ 复制一份 —— 请先完全退出 QQ（包括托盘图标）';
      try {
        const r0 = await api('/api/qq-portable/setup', { method: 'POST', body: '{}' });
        if (!r0.ok && !r0.alreadyInstalled) {
          if (hint) hint.textContent = r0.error || '安装失败';
        } else if (r0.alreadyInstalled) {
          if (hint) hint.textContent = '独立副本已装好 ✓';
        } else {
          // 后端已开始复制 → 每秒看一眼进度（上限 30 分钟）
          for (let i = 0; i < 1800; i++) {
            // 同启动链：切走后按钮脱离 DOM，别让这个每秒一次的进度轮询继续空转。
            if (!btn.isConnected) break;
            await new Promise((r) => setTimeout(r, 1000));
            const s = await api('/api/status');
            const setup = s.qqPortable?.setup;
            if (setup?.running) {
              if (hint) hint.textContent = `复制中 ${setup.done}/${setup.total}（${setup.step}）…预计几分钟`;
              continue;
            }
            if (setup?.error) { if (hint) hint.textContent = setup.error; break; }
            if (setup?.ok || s.qqPortable?.portableInstalled) { if (hint) hint.textContent = '✓ 独立副本装好了'; break; }
          }
        }
      } catch (e) {
        if (hint) hint.textContent = `安装失败：${e.message}`;
      }
      btn.disabled = false;
      btn.textContent = '装独立副本（可选）';
      qbRefresh();
    });

    qbRefresh();
  }

  // ── 预览演示模式开关（「界面与应用」页 · 界面区块）──
  // 它不是配置项（不写进 config）：只切换 URL 的 #preview 哈希然后重载整个界面，
  // 00-preview.js 在启动时读这个哈希决定是否拦截 fetch 提供模拟数据。
  // stopPropagation：别让这次 change 冒泡到 #settings-form 触发与它无关的自动保存。
  const previewSw = $('#cfg-previewmode');
  if (previewSw) previewSw.addEventListener('change', (e) => {
    e.stopPropagation();
    if (previewSw.checked) location.hash = 'preview';
    else history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });

  // ── 媒体工具（ffmpeg）区块事件 ─────────────────────────────────────
  // 这一块承担三件事：
  //   ① 状态条：当前用的是哪份（下载的 / 系统的 / 手填的）、版本多少
  //   ② 下载：起任务 → 每秒轮询进度 → 完成后刷新状态
  //   ③ 手动路径验证 + 删除已下载的那份
  // 状态是异步拉的，首帧只渲染占位；ffmpegRefresh() 拉到后只改文字与按钮态，
  // 不重建表单（与上面「连接 QQ」的 qbRefresh 同一套做法，避免绑定丢失）。
  const ffmpegDownloadBtn = $('#ffmpeg-download-btn');
  if (ffmpegDownloadBtn) {
    const statusText = $('#ffmpeg-status-text');
    const progressHint = $('#ffmpeg-progress-hint');
    const removeBtn = $('#cfg-ffmpeg-remove');
    const removeHint = $('#cfg-ffmpeg-remove-hint');
    const testBtn = $('#cfg-ffmpeg-test');
    const testHint = $('#cfg-ffmpeg-test-hint');
    const mirrorSub = $('#ffmpeg-mirror-sub');
    let pollTimer = null;

    const SOURCE_LABEL = {
      managed: '已下载',
      bundled: '随包（旧版本留下的）',
      manual: '手动指定',
      env: '环境变量 QQ_AGENT_FFMPEG',
      path: '系统 PATH',
      system: '系统安装',
      none: '未找到'
    };

    // 来源分组的展示名（与 ffmpeg-resolve.js 的 FFMPEG_SOURCES 对应）。
    const GROUP_LABEL = {
      manual: '手填路径',
      managed: '下载安装的',
      system: '系统安装的'
    };

    // 平台适配：installGuide / canAutoInstall 只有 /api/ffmpeg/status 才有，
    // 06 的渲染函数是同步纯函数拿不到，所以安装指引区首帧是空占位（hidden），
    // 由 paint() 注入；平台相关的文案与 macOS 要隐藏的下载区块也在 paint() 里修正。
    // paint 只改文字与显隐、不重建表单（与 qbRefresh 同一约束），
    // 所以每块内容都先确认存在再写。
    const installGuideHtml = (g) => {
      if (!g || g.kind !== 'command') return '';
      // 这块是运行时注入的，不是 .set-card 的直接子节点，所以拿不到
      // `#settings-form .set-card > h3` 那套卡片标题样式（会落成页面级蓝色标题）。
      // 内联对齐卡片标题的观感，避免这一块看起来像另一个层级的分区。
      const head = '<h3 style="margin:14px 0 10px;font-size:13px;font-weight:700;color:var(--fg);border-bottom:0">安装 ffmpeg</h3>';
      // 一行 = 说明 + 等宽命令 + 复制。label 用 <span> 而不是 <label>：
      // .field label 被全局设成 display:block，会把命令挤到下一行。
      const row = (label, cmd, note = '') => `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px">
          ${label ? `<span class="hint" style="margin:0">${esc(label)}</span>` : ''}
          <code>${esc(cmd)}</code>
          <button class="btn btn-mini btn-ghost" type="button" data-ffmpeg-copy="${esc(cmd)}">复制</button>
        </div>
        ${note ? `<div class="hint">${esc(note)}</div>` : ''}`;
      if (Array.isArray(g.distros) && g.distros.length) {
        // linux：主路径是发行版包管理器，四个发行版各给一条命令。
        return `${head}
          <div class="field">
            <div class="hint" style="margin-top:0">按你的发行版选一条在终端执行；装完回来点「测试」确认。</div>
            ${g.distros.map((d) => `
              <div style="margin-top:8px">
                <span class="hint" style="display:block;margin:0 0 2px">${esc(d.label || d.id)}</span>
                ${row('', d.cmd, d.note || '')}
              </div>`).join('')}
          </div>`;
      }
      // darwin：主命令 + 备用（装 Homebrew 本身）折叠 + 逐条注意事项。
      const parts = [];
      if (g.primary) parts.push(row(g.primary.label, g.primary.cmd));
      if (g.fallback) {
        parts.push(`
          <details open style="margin-top:var(--space-sm)">
            <summary class="hint" style="cursor:pointer">${esc(g.fallback.label || '备用命令')}</summary>
            ${row('', g.fallback.cmd)}
          </details>`);
      }
      const notes = (g.notes || []).filter(Boolean);
      if (notes.length) {
        parts.push(`<ul class="hint" style="margin:8px 0 0;padding-left:18px">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`);
      }
      return `${head}<div class="field">${parts.join('')}</div>`;
    };

    // 复制命令：与 00-core.js 启动失败卡片的 copyBtn 同一套反馈节奏。
    // 每次注入都是新的 DOM（旧节点连同监听一起丢弃），所以重绑不会累积。
    const bindCopyButtons = (root) => {
      $$('[data-ffmpeg-copy]', root).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const cmd = btn.dataset.ffmpegCopy || '';
          try {
            await navigator.clipboard.writeText(cmd);
            btn.textContent = '已复制 ✓';
          } catch (e) {
            // 剪贴板被拒（窗口未聚焦 / 浏览器权限 / 非安全上下文）时不能假装成功，
            // 但只说「复制失败」用户无从下手，所以退一步把命令选中，让他自己按复制键。
            // 失败原因记在 title 上，主路径仍是自动复制。
            //
            // 不区分 ⌘C / Ctrl+C：navigator.platform 已废弃（Chromium 返回空串），
            // 为一个提示文案去嗅探 UA 不值得，说「复制键」两边都说得通。
            btn.textContent = '复制失败';
            btn.title = `自动复制不可用（${e?.message || e?.name || '未知原因'}）。命令已选中，按系统的复制快捷键即可`;
            const code = btn.closest('div')?.querySelector('code');
            if (code) {
              const range = document.createRange();
              range.selectNodeContents(code);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          setTimeout(() => { btn.textContent = '复制'; }, 1500);
        });
      });
    };

    // 平台是否允许程序内下载；paintCandidates 的兜底文案要据此改写。
    let autoInstallAllowed = true;

    // 把本机探测到的可用 ffmpeg 列在「优先使用」下面。
    // 这是用户判断"系统里那份到底认不认"的唯一依据，只给单选而不给清单，
    // 用户切到 system 后看到"未安装"会以为是设置坏了。
    const paintCandidates = (list) => {
      const hint = $('#cfg-ffmpeg-source-hint');
      if (!hint) return;
      const rows = (list || []).filter((x) => x && x.path);
      if (!rows.length) {
        // macOS 没有下载按钮，不能再让用户"点上面的「下载并安装」"。
        hint.textContent = autoInstallAllowed
          ? '没有探测到可用的 ffmpeg：可以点上面的「下载并安装」，或在下面手动指定路径。'
          : '没有探测到可用的 ffmpeg：按上面的命令装好后回来，或在下面手动指定路径。';
        return;
      }
      // esc 来自 00-core.js（classic script，全局可见）
      hint.innerHTML = `本机可用：${rows.map((r) => (
        `<span style="display:block;margin-top:4px">· ${esc(GROUP_LABEL[r.group] || r.group)} — `
        + `<code>${esc(r.path)}</code>`
        + `<span class="hint">（${esc(r.version)}）</span></span>`
      )).join('')}`;
    };

    const paint = (s) => {
      if (!s) return;
      // ── 平台适配 ─────────────────────────────────────────────────
      // canAutoInstall 缺省按 true 处理：后端旧版本 / 字段未就位时保持现状，
      // 不能因为读不到就突然把 Windows 的下载入口藏掉。
      const canAutoInstall = s.canAutoInstall !== false;
      autoInstallAllowed = canAutoInstall;
      const isWin = s.platform === 'win32';
      // 安装指引区：有 installGuide 才注入（win32 为 null → 保持 hidden）。
      // 内容随平台而变，每次刷新都按内容哈希判断是否重写。
      //
      // 已装好时整块折叠成一行「安装方式」：状态条刚说完"ffmpeg 9.0.2 可用"，
      // 紧接着摆一条安装命令是自相矛盾的，用户还会以为哪里没配好。
      // 未装 / 不健康时才默认展开，那时安装命令正是他要找的东西。
      // 用户手动展开过就不再覆盖（dataset.userToggled），否则每次轮询刷新
      // 都会把他刚点开的区块重新折上。
      const guideBox = $('#ffmpeg-install-guide');
      const guideWrap = $('#ffmpeg-install-guide-wrap');
      const guideSummary = $('#ffmpeg-install-guide-summary');
      if (guideBox && s.installGuide !== undefined) {
        const html = installGuideHtml(s.installGuide);
        // 内容没变就不重写：innerHTML 重建会把「已复制 ✓」的按钮态和展开的
        // <details> 一起吹掉，而刷新会在下载 / 删除后触发。
        if (html !== guideBox.dataset.guideHtml) {
          guideBox.innerHTML = html;
          guideBox.dataset.guideHtml = html;
          if (html) bindCopyButtons(guideBox);
        }
        if (guideWrap) {
          guideWrap.hidden = !html;
          const unhealthyNow = s.ok && s.health && s.health.ok === false;
          const installed = s.ok && !unhealthyNow;
          if (html && !guideWrap.dataset.userToggled) {
            guideWrap.open = true;
          }
          if (guideSummary) {
            guideSummary.textContent = installed ? '已安装，查看安装方式' : '安装方式';
          }
        }
      }
      // 「优先使用哪一个」里，程序内下载那一份只在能下载的平台存在。
      // macOS 上它恒为空，留着会让用户去找一个不存在的东西。
      const managedRow = $('#cfg-ffmpeg-source-managed-row');
      if (managedRow) managedRow.hidden = !canAutoInstall;
      const autoLabel = $('#cfg-ffmpeg-source-auto-label');
      if (autoLabel) {
        // 「自动」那条的描述列了整条查找顺序，其中「下载的」在 mac 上不存在。
        autoLabel.textContent = canAutoInstall
          ? '自动（手填路径 → 下载的 → 系统安装）'
          : '自动（手填路径 → 系统安装）';
      }
      // 下载按钮与高级区：macOS 整块不显示。高级区里全是下载相关的东西
      // （下载 / 下载源 / Token / 删除），藏掉后只剩一个展开后空白的入口，
      // 所以连折叠按钮一起藏。
      // ⚠️ 这些内容被 settingsCards() 切成了独立卡片，必须按卡片藏，
      //    只藏 #ffmpeg-adv 的话，它的子元素早被 </section> 挤到了卡外。
      const advToggleEl = $('#ffmpeg-adv-toggle');
      const advBoxEl = $('#ffmpeg-adv');
      if (advToggleEl) advToggleEl.hidden = !canAutoInstall;
      if (advBoxEl) advBoxEl.hidden = !canAutoInstall;
      $$('.ffmpeg-dl-only').forEach((h) => {
        const card = h.closest('.set-card');
        (card || h).hidden = !canAutoInstall;
      });
      // 手动路径文案里的可执行文件名：Windows 才有 .exe。
      const pathHint = $('#cfg-ffmpeg-path-hint');
      if (pathHint) {
        pathHint.textContent = `自己装过 ffmpeg 的话，把 ${isWin ? 'ffmpeg.exe' : 'ffmpeg'} 的完整路径填这里，会优先使用它。`;
      }
      // winget 是 Windows 专有，非 Windows 上别让用户去找一个不存在的命令。
      const systemLabel = $('#cfg-ffmpeg-source-system-label');
      if (systemLabel) {
        systemLabel.textContent = isWin
          ? '优先用系统里自己装的（PATH / winget）'
          : '优先用系统里自己装的（PATH）';
      }

      // 两个下载按钮（状态条上的主按钮 + 高级区里的）共用同一份状态：
      // 已安装时只保留高级区那个「重新下载」，顶部不再出现一个大按钮，
      // 用户已经有能用的 ffmpeg 了，主行动不该是"再装一遍"。
      const advBtn = $('#ffmpeg-download-btn-adv');
      const advHint = $('#ffmpeg-download-hint');
      // 装了但缺能力（缺 libx264 / 缺滤镜）与"没装"是两种不同的故障，
      // 但对用户而言结论一样：这份 ffmpeg 干不了活，得换一份。
      const unhealthy = s.ok && s.health && s.health.ok === false;
      if (s.ok && !unhealthy) {
        statusText.innerHTML = `<b style="color:var(--accent)">ffmpeg ${esc(s.version)}</b>　·　来源：${esc(SOURCE_LABEL[s.source] || s.source)}`;
        ffmpegDownloadBtn.hidden = true;
        ffmpegDownloadBtn.textContent = '下载并安装';
      } else if (unhealthy) {
        const why = (s.health.problems || []).map((p) => p.detail).join('、');
        statusText.innerHTML = `<b style="color:var(--orange)">ffmpeg 不可用</b>　·　${esc(why)}`;
        // 换成新的一份是这类情况唯一可靠的自助方案：缺编码器/滤镜的构建
        // 改配置补不回来，只能换二进制。
        ffmpegDownloadBtn.hidden = !canAutoInstall;
        ffmpegDownloadBtn.textContent = '下载可用的 ffmpeg';
      } else {
        statusText.innerHTML = '<b style="color:var(--orange)">未安装</b>　·　上面四项媒体功能当前不可用';
        ffmpegDownloadBtn.hidden = !canAutoInstall;
        ffmpegDownloadBtn.textContent = '下载并安装';
      }
      ffmpegDownloadBtn.disabled = false;
      if (advBtn) {
        advBtn.disabled = false;
        advBtn.textContent = unhealthy ? '下载可用的 ffmpeg' : (s.managed ? '重新下载' : '下载并安装');
      }
      if (advHint) {
        advHint.textContent = unhealthy
          ? `问题：${(s.health.problems || []).map((p) => p.detail).join('；')}。换个来源重新下载即可。`
          : (s.managed ? '已安装到数据目录。' : '还没下载过。');
      }
      if (removeBtn) {
        removeBtn.disabled = !s.managed;
        if (removeHint) removeHint.textContent = s.managed ? '' : '（没有下载过的文件）';
      }
      // 下载走哪条通道直接决定速度（实测：代理直连 5.5MB/s、镜像 700KB/s、
      // 裸直连经常超时）。后端已经把「镜像 / 代理」合成一条决策（有代理时
      // 镜像自动让位，避免 代理→镜像→GitHub 多绕一跳），这里原样展示。
      // 只在"可能去下载"时才显示，已装好且健康、用的是系统 ffmpeg 的用户
      // 看这条纯属噪音；但健康检查不通过时仍要显示（那份确实要重下）。
      const proxyLine = $('#ffmpeg-proxy-line');
      if (proxyLine) {
        // macOS 不走程序内下载，这条通道信息纯属噪音。
        proxyLine.hidden = !canAutoInstall || (s.ok && !unhealthy && !s.managed);
        if (!proxyLine.hidden) {
          proxyLine.textContent = s.downloadChannel
            ? `本次下载通道：${s.downloadChannel}`
            : '';
          if (!s.downloadProxy) {
            proxyLine.textContent += '　（未检测到代理；国内可在「连接模型 → 管理服务商」里填地址，或直接用下面的镜像源）';
          }
        }
      }
      paintCandidates(s.candidates);
    };

    const ffmpegRefresh = async () => {
      try {
        const s = await api('/api/ffmpeg/status');
        paint(s);
      } catch (e) {
        if (statusText) statusText.textContent = `状态读取失败：${e?.message || e}`;
      }
    };

    // 进度轮询：与 /api/wallpaper/import 的 1 秒节奏一致。
    // 切走分区后按钮脱离 DOM（isConnected=false）就停，否则轮询空转。
    const poll = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (!ffmpegDownloadBtn.isConnected) { clearInterval(pollTimer); pollTimer = null; return; }
        try {
          const s = await api('/api/ffmpeg/download');
          if (!s.running) {
            clearInterval(pollTimer); pollTimer = null;
            ffmpegDownloadBtn.disabled = false;
            const advBtnNow = $('#ffmpeg-download-btn-adv');
            if (advBtnNow) advBtnNow.disabled = false;
            if (s.ok) {
              progressHint.textContent = '';
              await ffmpegRefresh();
            } else {
              progressHint.textContent = '';
              if (statusText) statusText.textContent = `下载失败：${s.error || '未知原因'}`;
              ffmpegDownloadBtn.textContent = '重试下载';
              if (advBtnNow) advBtnNow.textContent = '重试下载';
            }
            return;
          }
          const pct = s.total > 0 ? Math.min(100, Math.round((s.received / s.total) * 100)) : 0;
          const mb = (n) => (n / 1048576).toFixed(1);
          progressHint.textContent = s.total > 0
            ? `${s.step}… ${pct}%（${mb(s.received)} / ${mb(s.total)} MB）`
            : `${s.step}… ${mb(s.received)} MB`;
        } catch { /* 单次轮询失败不算任务失败，下一次再试 */ }
      }, 1000);
    };

    // 两个入口（状态条主按钮 / 高级区按钮）走同一段逻辑，复制一份必然漂移。
    const startDownload = async (btn) => {
      if (btn) btn.disabled = true;
      progressHint.textContent = '正在连接下载源…';
      try {
        const mirror = document.querySelector('input[name="cfg-ffmpeg-mirror"]:checked')?.value || 'yylx';
        const customMirror = $('#cfg-ffmpeg-mirror-custom')?.value || '';
        const r = await api('/api/ffmpeg/download', {
          method: 'POST',
          body: JSON.stringify({ mirror, customMirror })
        });
        if (!r.ok) {
          progressHint.textContent = '';
          if (btn) btn.disabled = false;
          // 后端以 use_package_manager 拒绝下载，这不是故障，是"这台机器该走
          // 包管理器"。照抄成"下载失败"会把用户引向反复重试。
          // 命令取自当前安装指引，避免在别处再写死一份 brew 命令。
          if (r.code === 'use_package_manager') {
            const primary = r.installGuide?.primary?.cmd || 'brew install ffmpeg';
            if (statusText) {
              statusText.innerHTML = `这台机器上不提供程序内下载，请按上面的 <code>${esc(primary)}</code> 安装后回来刷新。`;
            }
            return;
          }
          if (statusText) statusText.textContent = `下载失败：${r.error || '未知原因'}`;
          return;
        }
        poll();
      } catch (e) {
        progressHint.textContent = '';
        if (btn) btn.disabled = false;
        if (statusText) statusText.textContent = `下载失败：${e?.message || e}`;
      }
    };

    ffmpegDownloadBtn.addEventListener('click', () => startDownload(ffmpegDownloadBtn));
    $('#ffmpeg-download-btn-adv')?.addEventListener('click', (e) => startDownload(e.currentTarget));

    // 下载源和安装设置默认展开，仍允许用户手动收起。
    const advToggle = $('#ffmpeg-adv-toggle');
    const advBox = $('#ffmpeg-adv');
    if (advToggle && advBox) {
      advToggle.addEventListener('click', () => {
        const folded = advBox.classList.toggle('folded');
        advToggle.setAttribute('aria-expanded', folded ? 'false' : 'true');
        advToggle.textContent = folded ? '高级：下载与安装设置' : '收起下载与安装设置';
      });
    }

    // 安装方式默认展开；用户手动开合后，状态轮询不再覆盖其选择。
    const guideWrapEl = $('#ffmpeg-install-guide-wrap');
    if (guideWrapEl) {
      guideWrapEl.addEventListener('toggle', () => {
        guideWrapEl.dataset.userToggled = '1';
      });
    }

    // 下载源单选 → 切「自定义前缀」输入框的显隐。
    // 只是视觉收起：控件仍在 DOM 里，saveConfig 照常读到值。
    document.querySelectorAll('input[name="cfg-ffmpeg-mirror"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (mirrorSub) mirrorSub.classList.toggle('folded', radio.value !== 'custom' || !radio.checked);
      });
    });

    // GitHub Token 显示/隐藏：明文走后端专用端点（配置里是脱敏的）。
    const ghToggle = $('#cfg-ffmpeg-ghtoken-toggle');
    const ghInput = $('#cfg-ffmpeg-ghtoken');
    if (ghToggle && ghInput) {
      ghToggle.addEventListener('click', async () => {
        if (ghInput.type === 'password') {
          try {
            const r = await api('/api/ffmpeg/gh-token');
            ghInput.type = 'text';
            ghInput.value = String(r.token || '');
            ghToggle.textContent = '隐藏';
          } catch (e) {
            qaAlert(`读取令牌失败：${e?.message || e}`);
          }
        } else {
          ghInput.type = 'password';
          ghInput.value = ghInput.value.trim() ? '******' : '';
          ghToggle.textContent = '显示';
        }
      });
    }

    // 手动路径「测试」：只验证，不写配置（写配置走表单保存）。
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const p = $('#cfg-ffmpeg-path')?.value?.trim() || '';
        if (!p) { testHint.textContent = '请先填写 ffmpeg 的完整路径'; return; }
        testBtn.disabled = true;
        testHint.textContent = '验证中…';
        try {
          const r = await api('/api/ffmpeg/test', { method: 'POST', body: JSON.stringify({ path: p }) });
          testHint.textContent = r.ok
            ? `✓ 可用：${r.detail}${r.ffprobe ? '' : '（同目录没有 ffprobe，元信息会走 ffmpeg 兜底）'}`
            : `✗ ${r.error || '不可用'}`;
        } catch (e) {
          testHint.textContent = `✗ ${e?.message || e}`;
        }
        testBtn.disabled = false;
      });
    }

    // 删除已下载的那份：只动数据目录，不碰系统安装的。
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!await qaConfirm({
          title: '删除已下载的 ffmpeg',
          confirmText: '删除',
          message: '会删除数据目录里下载的那份 ffmpeg。\n\n如果你系统里自己装过 ffmpeg，它不受影响，功能会继续用那一份。\n\n删除后媒体功能会降级，直到重新下载。'
        })) return;
        removeBtn.disabled = true;
        if (removeHint) removeHint.textContent = '删除中…';
        try {
          const r = await api('/api/ffmpeg/remove', { method: 'POST', body: '{}' });
          if (removeHint) removeHint.textContent = r.ok ? '✓ 已删除' : `删除失败：${r.error}`;
        } catch (e) {
          if (removeHint) removeHint.textContent = `删除失败：${e?.message || e}`;
        }
        await ffmpegRefresh();
      });
    }

    ffmpegRefresh();
  }

  // ── 数据管理区块事件 ──
  const openDataDirBtn = $('#open-datadir-btn');
  if (openDataDirBtn) openDataDirBtn.addEventListener('click', async () => {
    try {
      await api('/api/open-data-dir', { method: 'POST', body: '{}' });
    } catch (e) {
      // ⚠️ 用户点一下按钮什么都没发生时，必须给出原因，否则会反复点击并以为功能坏了
      //    （数据目录打不开通常是后端未响应或系统没有文件管理器关联）。
      console.error('打开数据目录失败:', e);
      qaAlert(`打开数据目录失败：${e?.message || e}`);
    }
  });

  const resetDataBtn = $('#reset-data-btn');
  if (resetDataBtn) resetDataBtn.addEventListener('click', async () => {
    const hint = $('#reset-data-hint');
    // 重置 = 删除全部用户数据 → danger:true + 危险色按钮文案
    if (!await qaConfirm({
      danger: true,
      title: '重置为初始形态',
      confirmText: '重置（删除全部数据）',
      message: '⚠️ 确定要重置为初始形态吗？\n\n此操作会删除所有用户数据：\n- 配置（API Key、模型、白名单）\n- 聊天记录\n- 长期记忆\n- 表情包库\n\n不可恢复！建议先备份 data/ 目录。'
    })) return;
    if (!await qaConfirm({
      danger: true,
      title: '再次确认',
      confirmText: '确认删除全部数据',
      message: '再次确认：真的要删除所有用户数据吗？'
    })) return;
    resetDataBtn.disabled = true;
    if (hint) hint.textContent = '重置中…';
    try {
      const r = await api('/api/reset-data', { method: 'POST', body: '{}' });
      if (r.ok) {
        if (hint) hint.textContent = '✅ 已重置，请重启应用';
        setTimeout(() => {
          qaAlert('已重置为初始形态！\n\n请关闭应用并重新启动。');
        }, 500);
      } else {
        if (hint) hint.textContent = `重置失败：${r.error}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `重置失败：${e.message}`;
    }
    resetDataBtn.disabled = false;
  });
}

async function bindBackupSettings() {
  const panel = $('#backup-panel');
  if (!panel) return;
  // 已注册在设置外壳的通用自动保存闭包不能收到备份表单的输入。
  panel.addEventListener('input', (event) => event.stopPropagation());
  panel.addEventListener('change', (event) => event.stopPropagation());
  const post = (action, body) => api('/api/backup/' + action, { method: 'POST', body: JSON.stringify(body) });
  try {
    const [data, status] = await Promise.all([api('/api/backup/config'), api('/api/backup/targets')]);
    if (!panel.isConnected) return;
    let config = data.config;
    const credentialFields = new Set(['username', 'accessKeyId', 'password', 'secretAccessKey']);
    let busy = false;
    const field = (key, label, value = '', type = 'text', placeholder = '') => '<div class="field"><label>' + esc(label) + '<input data-bk="' + key + '" type="' + type + '" value="' + esc(String(value)) + '" placeholder="' + esc(placeholder) + '"' + (credentialFields.has(key) ? ' autocomplete="off"' : '') + (type === 'number' ? ' min="' + (key === 'retention' ? '1' : '0.01') + '" step="' + (key === 'retention' ? '1' : 'any') + '" required' : '') + '></label></div>';
    const toggle = (key, label, on) => '<label class="checkbox-row"><input class="sw" type="checkbox" data-bk="' + key + '" ' + (on ? 'checked' : '') + '> ' + esc(label) + '</label>';
    const targetLabels = { local: '本地目录', webdav: 'WebDAV', s3: 'S3 兼容' };
    const targetHelp = {
      local: ['适合：本机副本、移动硬盘或局域网共享盘。', '填写：一个可写目录；桌面端可点「浏览…」选择。', '特点：本机磁盘速度快，无需网络；与机器放一起仍有丢失风险。', '注意：OneDrive / 坚果云的「仅在线」目录读回可能很慢。'],
      webdav: ['适合：群晖 WebDAV Server、Nextcloud、坚果云等 NAS / 网盘。', '填写：服务地址（如 https://nas.local:5006/backup）、用户名和密码。', '特点：跨设备访问；使用 HTTPS 加密传输。', '注意：自签证书需开启「允许不安全 TLS」，仅用于信任的服务。'],
      s3: ['适合：AWS S3、Cloudflare R2、Backblaze B2、自建 MinIO。', '填写：Endpoint、Region、Bucket、Access Key 和 Secret Key。', '特点：可靠的异地副本；云服务通常按存储量与流量计费。', '注意：MinIO 等自建服务通常需要开启 Path style。']
    };
    const helpList = (type) => '<ul class="hint">' + targetHelp[type].map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>';
    const categorySize = (item) => item.error ? '体积读取失败：' + item.error : fmtBytes(item.bytes);
    let exportCategories = status.categories.filter((item) => item.defaultOn !== false).map((item) => item.key);
    const categoryOptions = (selected, attr) => '<div class="backup-categories">' + status.categories.map((item) => '<label class="checkbox-row"><input class="sw" type="checkbox" ' + attr + '="' + esc(item.key) + '" ' + (selected.includes(item.key) ? 'checked' : '') + '><span>' + esc(item.label) + ' · <span data-category-size="' + esc(item.key) + '">' + esc(categorySize(item)) + '</span><small class="muted">' + esc(item.desc) + '</small></span></label>').join('') + '</div>';
    const draw = () => {
      // 添加/删除目标会重绘面板，保留用户手动收起的导出选项。
      const exportOptionsOpen = panel.querySelector('#backup-export-options')?.open ?? true;
      panel.innerHTML = '<div class="backup-actions"><button type="button" class="btn btn-small" id="backup-restore-link">前往恢复 / 回滚</button></div><ul class="hint"><li>默认排除配置和扩展数据中的密钥；包含密钥时整包加密。</li><li>目标凭据加密存储；留空保留原值，修改后请保存。</li><li>恢复时先刷新备份列表，再选择「预览与恢复」；恢复后可回滚。</li></ul><div class="set-hint" id="backup-status" role="status"></div>' +
        '<fieldset id="backup-global"><legend>备份设置</legend><div class="backup-actions">' + toggle('enabled', '定时备份', config.enabled) + toggle('includeSecrets', '包含密钥', config.includeSecrets) + '</div><div class="field-row">' + field('intervalHours', '间隔（小时）', config.intervalHours, 'number') + field('retention', '保留份数', config.retention, 'number') + '</div></fieldset>' +
        '<div class="backup-actions"><button type="button" class="btn" id="backup-save">保存备份设置</button><button type="button" class="btn" id="backup-run">立即备份</button><button type="button" class="btn" id="backup-export">导出到本地</button><button type="button" class="btn" id="backup-list">刷新备份列表</button></div><p id="backup-feedback" role="status" aria-atomic="true"></p>' +
        '<details class="collapsible" id="backup-export-options"' + (exportOptionsOpen ? ' open' : '') + '><summary>本地导出内容</summary><p class="hint">无需配置目标，勾选什么就导出什么；导出不上传，也不计入备份历史。恢复时可以只选其中一部分。</p>' + categoryOptions(exportCategories, 'data-export-category') + '</details>' +
        '<div id="backup-targets">' + (config.targets || []).map((target) => {
          const fields = field('name', '名称', target.name) + toggle('enabled', '启用目标', target.enabled);
          const specific = target.type === 'local' ? '<div class="backup-directory">' + field('dir', '目录路径', target.dir) + (typeof window.qqaDesktop?.pickDirectory === 'function' ? '<button type="button" class="btn btn-small" data-browse>浏览…</button>' : '') + '</div>' : target.type === 'webdav' ?
            field('url', 'WebDAV URL', target.url) + field('username', '用户名', target.username, 'password', target.hasUsername ? '••••••（留空保留）' : '') + field('password', '密码', target.password, 'password', target.hasCredentials ? '••••••（留空保留）' : '') + toggle('allowInsecureTLS', '允许不安全 TLS（仅用于信任的自签证书服务）', target.allowInsecureTLS === true) :
            field('endpoint', 'S3 Endpoint', target.endpoint) + field('region', 'Region', target.region || 'us-east-1') + field('bucket', 'Bucket', target.bucket) + field('accessKeyId', 'Access Key ID', target.accessKeyId, 'password', target.hasAccessKeyId ? '••••••（留空保留）' : '') + field('secretAccessKey', 'Secret Access Key', target.secretAccessKey, 'password', target.hasSecretAccessKeyCipher ? '••••••（留空保留）' : '') + toggle('forcePathStyle', 'Path style', target.forcePathStyle !== false);
          const categories = categoryOptions(Array.isArray(target.categories) ? target.categories : status.categories.filter((item) => item.defaultOn !== false).map((item) => item.key), 'data-category');
          return '<fieldset data-target="' + esc(target.id) + '"><legend>' + esc(targetLabels[target.type] || target.type) + (target.name ? ' · ' + esc(target.name) : '') + '</legend><div class="backup-target-fields">' + fields + specific + '</div><fieldset><legend>备份内容</legend><p class="hint">勾选什么就备份什么，恢复时可以只选其中一部分。</p><p class="hint">体积为当前实际内容的未压缩大小；空类别显示 0 B。包含密钥时另加加密配置。</p>' + categories + '</fieldset><p class="hint">每个目标只备份自己勾选的类别；类别相同的目标共用一个包。</p><div class="backup-actions"><button type="button" class="btn btn-small" data-test="' + esc(target.id) + '">测试连接</button><button type="button" class="btn btn-small" data-remove="' + esc(target.id) + '">删除目标</button></div></fieldset>';
        }).join('') + '</div><fieldset><legend>添加备份目标</legend><div class="field-row"><div class="field"><label for="backup-type">备份方式</label><select id="backup-type" aria-describedby="backup-type-help"><option value="local">本地目录</option><option value="webdav">WebDAV</option><option value="s3">S3 兼容</option></select></div><button type="button" class="btn" id="backup-add">添加目标</button></div><div class="set-hint" id="backup-type-help">' + helpList('local') + '</div></fieldset>' +
        '<h4 id="backup-restore-title" tabindex="-1">恢复与回滚</h4><button type="button" class="btn" id="backup-import" data-restore>选择备份文件…</button><input type="file" id="backup-import-file" accept=".zip,.qqab" aria-label="选择备份文件" hidden><div id="backup-preview"></div><div id="backup-files"><p class="hint">请刷新备份列表，或选择本地 ZIP / QQAB 备份文件进行预览与恢复。</p></div><h4>恢复回滚</h4><div id="backup-rollbacks"></div>';
      const collect = () => {
        exportCategories = [...panel.querySelectorAll('[data-export-category]:checked')].map((el) => el.dataset.exportCategory);
        panel.querySelectorAll('#backup-global [data-bk]').forEach((el) => { config[el.dataset.bk] = el.type === 'checkbox' ? el.checked : Number(el.value); });
        config.targets = [...panel.querySelectorAll('[data-target]')].map((row) => {
          const old = config.targets.find((target) => target.id === row.dataset.target);
          const target = { ...old };
          row.querySelectorAll('[data-bk]').forEach((el) => {
            if (credentialFields.has(el.dataset.bk) && !el.value) { delete target[el.dataset.bk]; return; }
            target[el.dataset.bk] = el.type === 'checkbox' ? el.checked : el.value;
          });
          target.categories = [...row.querySelectorAll('[data-category]:checked')].map((el) => el.dataset.category);
          return target;
        });
      };
      const feedback = (text) => { panel.querySelector('#backup-feedback').textContent = text; };
      panel.querySelector('#backup-type').addEventListener('change', (event) => { panel.querySelector('#backup-type-help').innerHTML = helpList(event.target.value); });
      panel.querySelectorAll('[data-bk], [data-category]').forEach((el) => el.addEventListener('input', () => feedback('备份设置已修改，请保存')));
      panel.querySelector('#backup-restore-link').addEventListener('click', () => {
        const title = panel.querySelector('#backup-restore-title');
        title.scrollIntoView({ block: 'start' });
        title.focus({ preventScroll: true });
      });
      const setBusy = (on) => {
        busy = on;
        panel.setAttribute('aria-busy', String(on));
        panel.querySelectorAll('input, select, button').forEach((el) => { el.disabled = on; });
      };
      const updateStatus = () => {
        const last = status.lastRun;
        const failures = (last?.targets || []).filter((item) => !item.ok).map((item) => item.id + '：' + item.error);
        const partial = failures.length && last.targets.some((item) => item.ok);
        panel.querySelector('#backup-status').textContent = (status.running ? '备份或恢复正在运行，请稍后刷新。' : '') + (last ? '最近备份：' + (partial ? '部分成功' : last.ok ? '成功' : '失败') + (last.error ? '；' + last.error : '') + (failures.length ? '；' + failures.join('；') : '') : '还没有备份。添加并保存目标后点「立即备份」，或直接「导出到本地」留一份离线副本。');
        panel.querySelector('#backup-run').disabled = busy || status.running;
        panel.querySelectorAll('[data-restore], [data-rollback]').forEach((el) => { el.disabled = busy || status.running; });
        const execute = panel.querySelector('[data-restore-execute]');
        if (execute) execute.disabled = busy || status.running || !panel.querySelector('[data-restore-category]:checked');
      };
      const refreshStatus = async () => {
        Object.assign(status, await api('/api/backup/targets'));
        panel.querySelectorAll('[data-category-size]').forEach((el) => {
          const item = status.categories.find((category) => category.key === el.dataset.categorySize);
          if (item) el.textContent = categorySize(item);
        });
        updateStatus();
        panel.querySelector('#backup-rollbacks').replaceChildren();
        for (const item of status.rollbacks || []) addRollback(item.id || item.backupId);
        if (!status.rollbacks?.length) panel.querySelector('#backup-rollbacks').innerHTML = '<p class="muted">暂无可回滚的恢复快照</p>';
      };
      const action = (button, fn, loading = '正在处理…', eventName = 'click') => button.addEventListener(eventName, async () => {
        if (busy) return;
        const focused = document.activeElement;
        const label = button.textContent;
        let nextFocus;
        // 与设置页自动保存共用守卫，避免服务端 status 事件把在途表单换成旧值。
        beginSettingsGuard();
        setBusy(true);
        button.textContent = loading;
        feedback(loading);
        try { nextFocus = await fn(); } catch (error) { feedback('操作失败：' + error.message); }
        finally {
          if (panel.isConnected) {
            button.textContent = label;
            setBusy(false);
            updateStatus();
            if (nextFocus) panel.querySelector(nextFocus)?.focus({ preventScroll: true });
            else if (focused?.isConnected && !focused.disabled) focused.focus({ preventScroll: true });
          }
          endSettingsGuard();
        }
      });
      const save = async () => {
        // busy 会禁用原生约束校验，先收集后显式验证数值和类别。
        collect();
        if (!(config.intervalHours > 0) || !Number.isInteger(config.retention) || config.retention <= 0) throw new Error('备份间隔必须为正数，保留份数必须为正整数');
        if (config.targets.some((target) => target.enabled && !target.categories.length)) throw new Error('请为每个启用目标至少选择一项备份内容');
        const result = await post('config', config);
        config = result.config;
        // 不重绘整张表单；清除已提交凭据，避免下次保存重发旧密码并覆盖外部修改。
        panel.querySelectorAll('[data-target]').forEach((row) => {
          const target = config.targets.find((item) => item.id === row.dataset.target);
          const flags = { username: 'hasUsername', password: 'hasCredentials', accessKeyId: 'hasAccessKeyId', secretAccessKey: 'hasSecretAccessKeyCipher' };
          row.querySelectorAll('[data-bk]').forEach((el) => {
            if (!credentialFields.has(el.dataset.bk)) return;
            el.value = '';
            el.removeAttribute('value');
            el.placeholder = target?.[flags[el.dataset.bk]] ? '••••••（留空保留）' : '';
          });
        });
        feedback('备份设置已保存');
      };
      const secretSwitch = panel.querySelector('[data-bk="includeSecrets"]');
      secretSwitch.addEventListener('change', async () => {
        if (secretSwitch.checked && !busy) {
          // 确认完成前保持 false；取消、Esc、关闭弹窗都不能使保存读到 true。
          secretSwitch.checked = false;
          beginSettingsGuard();
          setBusy(true);
          try { secretSwitch.checked = await qaConfirm({ danger: true, confirmText: '确认包含敏感信息', message: '备份包将包含 API Key、访问令牌等敏感信息，整包会加密。请妥善保管备份与本实例加密密钥；换机器后可能无法解密。确定包含密钥？' }); }
          catch (error) { feedback('确认失败：' + error.message); }
          finally { setBusy(false); updateStatus(); secretSwitch.focus({ preventScroll: true }); endSettingsGuard(); }
        }
      });
      action(panel.querySelector('#backup-save'), save);
      panel.querySelectorAll('[data-browse]').forEach((button) => action(button, async () => {
        const result = await window.qqaDesktop.pickDirectory();
        if (result?.canceled) { feedback('已取消选择目录'); return; }
        if (!result?.ok || !result.path) throw new Error(result?.error || '无法选择目录');
        const input = button.closest('[data-target]').querySelector('[data-bk="dir"]');
        input.value = result.path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, '正在选择…'));
      action(panel.querySelector('#backup-export'), async () => {
        const categories = [...panel.querySelectorAll('[data-export-category]:checked')].map((el) => el.dataset.exportCategory);
        if (!categories.length) throw new Error('请展开「本地导出内容」，至少勾选一项');
        const response = await fetch('/api/backup/export', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER },
          body: JSON.stringify({ categories, includeSecrets: secretSwitch.checked }) });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || '导出失败'); }
        const blob = await response.blob();
        const name = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'qq-agent-backup.zip';
        let message;
        if (typeof window.qqaDesktop?.saveBackup === 'function') {
          const result = await window.qqaDesktop.saveBackup(name, new Uint8Array(await blob.arrayBuffer()));
          if (result?.canceled) { feedback('已取消导出保存'); return; }
          if (!result?.ok) throw new Error(result?.error || '保存失败');
          message = '已导出到本地：' + name;
        } else {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a'); link.href = url; link.download = name;
          document.body.append(link); link.click(); link.remove();
          const DOWNLOAD_URL_TTL_MS = 60_000; // 留出浏览器接管下载的时间。
          setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
          message = '已开始下载：' + name;
        }
        const skipped = JSON.parse(decodeURIComponent(response.headers.get('x-backup-skipped') || '%5B%5D'));
        feedback(message + '；未上传，不计入备份历史。' + (skipped.length ? '已跳过：' + skipped.map((item) => (item.label || item.key) + '：' + item.reason).join('；') : ''));
      }, '正在导出…');
      action(panel.querySelector('#backup-add'), async () => { collect(); config.targets.push({ id: crypto.randomUUID(), type: panel.querySelector('#backup-type').value, name: '', enabled: true, categories: status.categories.filter((item) => item.defaultOn !== false).map((item) => item.key) }); draw(); feedback('目标已添加，请填写并保存'); return '[data-target]:last-child [data-bk="name"]'; });
      panel.querySelectorAll('[data-remove]').forEach((button) => action(button, async () => { collect(); config.targets = config.targets.filter((target) => target.id !== button.dataset.remove); draw(); feedback('目标已移除，请保存设置'); return '#backup-add'; }));
      panel.querySelectorAll('[data-test]').forEach((button) => action(button, async () => { await save(); feedback('正在测试连接…'); const result = await post('test', { targetId: button.dataset.test }); if (!result.ok) throw new Error(result.message || result.error || '连接失败'); feedback(result.message || '连接成功'); }, '正在测试…'));
      let previewFileId;
      const clearPreview = async () => {
        if (previewFileId) await api('/api/backup/import-file?' + new URLSearchParams({ fileId: previewFileId }), { method: 'DELETE' });
        previewFileId = undefined;
        panel.querySelector('#backup-preview').replaceChildren();
      };
      const showRestorePreview = async (preview, input, name) => {
        await clearPreview();
        previewFileId = input.fileId;
        const row = document.createElement('fieldset');
        const legend = document.createElement('legend'); legend.textContent = name; row.append(legend);
        const info = document.createElement('p'); info.className = 'hint';
        info.textContent = (preview.manifest.encrypted ? '已加密备份。' : '未加密备份。') + '勾选要恢复的类别；消息合并去重，恢复前生成可回滚快照。'
          + (preview.scan.modules.length ? '用户扩展先进入锻造台暂存，需逐个确认安装。' : '');
        row.append(info);
        const categories = document.createElement('div'); categories.className = 'backup-categories';
        for (const item of preview.scan.categories) {
          const label = document.createElement('label'); label.className = 'checkbox-row';
          const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'sw'; check.checked = true; check.dataset.restoreCategory = item.key;
          const text = document.createElement('span'); text.textContent = item.label + ' · ' + item.chats + ' 个会话 · ' + item.files + ' 个文件 · ' + fmtBytes(item.bytes);
          label.append(check, text); categories.append(label);
        }
        row.append(categories);
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = '查看来源与本机数据详情';
        const contents = document.createElement('pre'); contents.textContent = JSON.stringify(preview.scan, null, 2);
        details.append(summary, contents); row.append(details);
        const hint = document.createElement('p'); hint.className = 'hint'; hint.setAttribute('role', 'status'); row.append(hint);
        const execute = document.createElement('button'); execute.type = 'button'; execute.className = 'btn'; execute.dataset.restoreExecute = ''; execute.textContent = '执行恢复';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = '取消预览';
        const actions = document.createElement('div'); actions.className = 'backup-actions'; actions.append(execute, cancel); row.append(actions);
        panel.querySelector('#backup-preview').append(row);
        const updateSelection = () => {
          hint.textContent = categories.querySelector(':checked') ? '' : '请至少选择一项恢复内容';
          updateStatus();
        };
        categories.addEventListener('change', updateSelection);
        updateSelection();
        action(cancel, async () => { await clearPreview(); feedback('已取消恢复'); return '#backup-import'; });
        action(execute, async () => {
          const selected = [...categories.querySelectorAll(':checked')].map((el) => el.dataset.restoreCategory);
          if (!selected.length) throw new Error('请至少选择一项恢复内容');
          const selection = Object.fromEntries(selected.map((key) => [key, preview.selection[key]]));
          if (!await qaConfirm({ danger: true, confirmText: '执行恢复', message: name + '\n将恢复所选的 ' + selected.length + ' 个类别，可能覆盖当前文件；恢复前会生成可回滚快照。回滚也会撤销恢复后对相关文件的修改。' })) { feedback('已取消执行，可继续调整恢复范围'); return; }
          try {
            feedback('正在恢复，请等待完成…');
            const restored = await post('restore', { ...input, selection });
            previewFileId = undefined;
            categories.remove(); actions.remove(); hint.remove();
            feedback('恢复完成，可在下方回滚：' + restored.backupId);
            for (const module of restored.report?.modules || []) {
              if (!module.ok || !module.draftId) continue;
              const install = document.createElement('button'); install.type = 'button'; install.className = 'btn btn-small'; install.dataset.restore = ''; install.textContent = '确认安装 ' + module.key;
              row.append(install);
              action(install, async () => {
                if (!await qaConfirm({ danger: true, confirmText: '安装此扩展', message: '安装扩展 ' + module.key + '？安装后默认关闭。\n安全检查：\n' + JSON.stringify(module.gate, null, 2) })) { feedback('扩展仍在锻造台暂存区，尚未安装'); return; }
                const result = await api('/api/bundle/install', { method: 'POST', body: JSON.stringify({ items: [{ draftId: module.draftId, confirmIssues: true }], enable: false }) });
                if (!result.ok) throw new Error(result.results?.map((item) => item.error).filter(Boolean).join('；') || result.error || '安装失败');
                install.remove(); feedback('已安装 ' + module.key + '，默认关闭；可在扩展页启用');
              }, '正在安装…');
            }
            if (restored.report?.modules?.length) feedback('数据恢复完成，可回滚：' + restored.backupId + '；扩展已暂存，请逐个确认安装');
          } finally {
            await refreshStatus().catch((error) => feedback(panel.querySelector('#backup-feedback').textContent + '；刷新回滚快照失败：' + error.message));
          }
        });
        feedback('预览已就绪，请勾选恢复范围');
        row.scrollIntoView({ block: 'nearest' });
        return '[data-restore-category]';
      };
      const importFile = async (file, name) => {
        if (file.size > status.maxFileBytes) throw new Error('备份文件体积超过上限（' + fmtBytes(status.maxFileBytes) + '）');
        await clearPreview();
        const preview = await api('/api/backup/import-file', { method: 'POST', body: file,
          headers: { 'content-type': 'application/octet-stream', 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER } });
        return showRestorePreview(preview, { fileId: preview.fileId }, name);
      };
      const fileInput = panel.querySelector('#backup-import-file');
      action(fileInput, async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (file) return importFile(file, file.name);
      }, '正在预览文件…', 'change');
      action(panel.querySelector('#backup-import'), async () => {
        if (typeof window.qqaDesktop?.pickBackupFile !== 'function') {
          // action 的忙碌守卫会禁用表单；原生文件选择器必须从启用的 input 打开。
          fileInput.disabled = false;
          fileInput.click();
          return;
        }
        const picked = await window.qqaDesktop.pickBackupFile();
        if (picked.canceled) { feedback('已取消选择文件'); return; }
        if (!picked.ok) throw new Error(picked.error);
        return importFile(new Blob([picked.bytes]), picked.name);
      }, '正在选择备份…');
      const refreshFiles = async () => {
        const result = await api('/api/backup/list');
        const container = panel.querySelector('#backup-files'); container.replaceChildren();
        for (const target of result.targets) {
          const title = document.createElement('h4'); title.textContent = target.name || target.id; container.append(title);
          if (!target.ok) { const error = document.createElement('p'); error.textContent = target.error; container.append(error); }
          if (target.ok && !target.backups.length) { const empty = document.createElement('p'); empty.textContent = '暂无备份'; container.append(empty); }
          for (const item of target.backups) {
            const row = document.createElement('div'); row.className = 'field backup-file';
            const label = document.createElement('span'); label.textContent = item.key + ' · ' + fmtBytes(item.size) + ' '; row.append(label);
            const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small'; button.dataset.restore = ''; button.disabled = busy || status.running; button.textContent = '预览与恢复'; button.setAttribute('aria-label', '预览与恢复 ' + (target.name || target.id) + ' / ' + item.key); row.append(button);
            action(button, async () => {
              const input = { targetId: target.id, key: item.key };
              const preview = await post('preview', input);
              return showRestorePreview(preview, input, (target.name || target.id) + ' / ' + item.key);
            }, '正在预览…'); container.append(row);
          }
        }
        if (!result.targets.length) container.innerHTML = '<p class="muted">暂无备份目标，请先添加并保存目标</p>';
        updateStatus();
        return result;
      };
      action(panel.querySelector('#backup-list'), async () => { await refreshStatus(); const result = await refreshFiles(); feedback(result.ok ? '备份列表已刷新' : '部分目标读取失败，详情见备份列表'); }, '正在刷新…');
      action(panel.querySelector('#backup-run'), async () => {
        await save();
        let message;
        try {
          feedback('正在备份，请等待上传完成…');
          const result = await post('run', {});
          const failed = (result.targets || []).filter((item) => !item.ok).map((item) => item.id + '：' + item.error);
          const skipped = (result.skippedCategories || []).map((item) => (item.label || item.key) + '：' + item.reason);
          const packages = result.keys?.length > 1 ? result.keys.length + ' 个包（各目标按所选类别备份）：' + result.targets.filter((item) => item.ok).map((item) => item.id + ' → ' + item.key).join('；') : result.key || result.keys?.[0] || '';
          message = (failed.length ? '备份部分成功：' : '备份完成：') + packages + (failed.length ? '；失败目标：' + failed.join('；') : '') + (skipped.length ? '。已跳过：' + skipped.join('；') : '');
        } catch (error) { message = '备份失败：' + error.message; }
        try { await refreshStatus(); const listed = await refreshFiles(); if (!listed.ok) message += '；部分目标列表读取失败，详情见下方'; }
        catch (error) { message += '；刷新状态或列表失败：' + error.message; }
        feedback(message);
      }, '正在备份…');
      const addRollback = (id) => {
        const button = document.createElement('button'); button.className = 'btn btn-small'; button.type = 'button'; button.dataset.rollback = id; button.disabled = busy || status.running; button.textContent = '回滚 ' + id;
        action(button, async () => {
          if (!await qaConfirm({ danger: true, confirmText: '回滚', message: '确定回滚 ' + id + '？将覆盖相关文件、还原到恢复前的快照，恢复后的修改也会丢失。' })) { feedback('已取消回滚'); return; }
          await post('rollback', { backupId: id });
          feedback('回滚完成：' + id);
          await refreshStatus().catch((error) => feedback('回滚完成；刷新状态失败：' + error.message));
          panel.querySelector('#backup-restore-title').focus({ preventScroll: true });
        }, '正在回滚…');
        panel.querySelector('#backup-rollbacks').append(button);
      };
      for (const item of status.rollbacks || []) addRollback(item.id || item.backupId);
      if (!status.rollbacks?.length) panel.querySelector('#backup-rollbacks').innerHTML = '<p class="muted">暂无可回滚的恢复快照</p>';
      setBusy(busy);
      updateStatus();
    };
    draw();
    $('#backup-section-title')?.scrollIntoView({ block: 'start' });
  } catch (error) { if (panel.isConnected) panel.textContent = '读取备份配置失败：' + error.message; }
}
