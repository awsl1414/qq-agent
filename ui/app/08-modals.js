// 〔通用弹窗外壳 / 模型选择 / 人设 / 白名单 / saveConfig〕
'use strict';

/* ── API 协议下拉 ─────────────────────────────────────────────────────────
   「管理服务商 → 添加/编辑提供商」里的 API 协议选择。与后端 src/api-protocols.js
   的目录保持一致（id 必须逐一对应）。
   ⚠️ UI 是经典脚本共享全局作用域，本常量名带 QA_ 前缀防撞（ui-globals-check 口径）。 */
const QA_API_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI (Chat Completions)' },
  { id: 'openai-responses', label: 'OpenAI (Responses API)' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'mistral', label: 'Mistral' }
];
// 选协议后 Base URL 还空着时自动填的官方默认端点（与后端 PROTOCOL_DEFAULT_BASES 对应）
const QA_PROTOCOL_DEFAULT_BASES = {
  openai: '',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1'
};
function qaProtocolSelectHtml(selected) {
  const sel = String(selected || 'openai');
  return QA_API_PROTOCOLS.map((p) =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${p.label}</option>`
  ).join('');
}

/* ── 提示条文案写入 ──────────────────────────────────────────────────────
   本文件里所有 `#xxx-hint` / `#pick-result` / `#model-label` 提示条都只存在于
   当前分区的 HTML 里（renderSettings 只重建 state.settingsSection 那一段）。
   设置页一旦重建 / 切区 / 重新进页面，旧节点就从 DOM 消失，而
   `$('#xxx').textContent = …` 在查不到元素时直接抛 TypeError。
   更糟的是很多写入发生在 catch 里（如"选择失败：xxx"），那会在处理错误的路上
   二次抛错，用户看到的只有"点了没反应"。

   ⇒ 元素缺席 = 静默跳过。提示条是锦上添花，不该有能力打断主流程。 */
function setHintText(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
  return !!el;
}

/* ── body 滚动锁 ────────────────────────────────────────────────────────
   弹窗打开时锁住背后页面的滚动，关闭时还原。

   为什么需要：无边框透明窗里，弹窗遮罩是 position:fixed 铺满视口，但背后的
   滚动容器仍在。鼠标滚轮在遮罩上滑动会穿透到背后把列表滚走，关掉弹窗后
   用户发现自己刚才看的那一行不见了。触摸板惯性滚动更明显。

   ⚠️ 用计数器：弹窗会叠（模型选择 → 添加模型 → 人设选择），必须等全部关完
      才解锁；用布尔量会被"第一个关掉的弹窗"提前解开。
   ⚠️ 还原的是打开前的原值，不是写死 ''：页面可能本来就设了 overflow。 */
let __modalScrollLocks = 0;
let __modalPrevBodyOverflow = null;
function lockBodyScroll() {
  if (__modalScrollLocks === 0) {
    __modalPrevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  __modalScrollLocks += 1;
}
function unlockBodyScroll(overlay) {
  // 同一个 overlay 只解锁一次（closeModelModal 可能被多条路径调用）
  if (overlay && overlay._scrollLocked) {
    overlay._scrollLocked = false;
  } else if (!overlay) {
    // 无 overlay 参数 = 强制全量解锁（异常兜底）
    __modalScrollLocks = 0;
  }
  if (__modalScrollLocks > 0) __modalScrollLocks -= 1;
  if (__modalScrollLocks === 0) {
    document.body.style.overflow = __modalPrevBodyOverflow || '';
    __modalPrevBodyOverflow = null;
  }
}

/* ── 模态框焦点陷阱 ─────────────────────────────────────────────────────
   让 Tab / Shift+Tab 在最上层弹窗内首尾循环，并把被程序性移出的焦点拽回。

   为什么需要：无边框透明窗里弹窗打开后，焦点仍可 Tab 到背后的顶栏按钮
   （最小化 / 关闭），"弹窗还开着，回车却按到了后面"。读屏用户更难察觉。

   设计：文档级单例。全局只装一次监听，弹窗通过 register/unregister 登记；
   每次拦截时现算"最上层 overlay"是谁，不依赖各 overlay 自己保存状态。
   ⚠️ 现算 topmost 而不是缓存：弹窗会叠、会异步退场，缓存的"当前顶层"很容易过期。 */
const __focusTraps = new Set();
let __trapInstalled = false;
// ⚠️ readonly 输入框不算可编辑焦点目标：人设弹窗的「选择人设」框
// （#gp-pick / #pcp-pick）就是 readonly，焦点落在它上面时 Ctrl+V 等原生编辑
// 命令会被 Chromium 静默吞掉（无 paste 事件、无反馈）。
// Tab 循环与 focusin 兜底都不该把焦点往只读框上拽。
const __FOCUSABLE = 'a[href], iframe, button:not([disabled]), input:not([type=hidden]):not([readonly]):not([disabled]),' +
  ' select:not([disabled]), textarea:not([readonly]):not([disabled]), [tabindex]:not([tabindex="-1"])';

// 「可编辑」焦点目标：接受 Ctrl+V/Ctrl+C/Ctrl+X/Ctrl+A 等原生编辑命令的控件。
// 焦点停在 readonly 输入框（各「选择人设/选择模型」框）、按钮或 body 上时，
// Chromium 对原生编辑命令静默无操作（不报错、无反馈）。
// 三个使用点：弹窗打开自动聚焦、requestClose 续编辑焦点拉回、
// closeModelModal 的只读顺延兜底。
const __EDITABLE_SEL = 'input:not([type=hidden]):not([readonly]):not([disabled]),' +
  ' textarea:not([readonly]):not([disabled]), select:not([disabled])';

/** scope 内第一个**可见且可编辑**的控件（无则 null）。 */
function focusFirstEditableIn(scope) {
  if (!scope || typeof scope.querySelector !== 'function') return null;
  const el = Array.from(scope.querySelectorAll(__EDITABLE_SEL))
    .find((n) => n.offsetParent !== null);
  if (el) { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return el || null;
}

/** anchor 之后（同表单/文档序）第一个可见可编辑控件；没有则回落表单第一个。
 *  用于「选择器子弹窗关闭 + 页面重渲染后」的焦点归还：锚点本身通常是
 *  readonly 选择框（#cfg-model-pick 等），不能停。anchor 自身是只读框时用
 *  compareDocumentPosition 找它后面的第一个（readonly 不在可编辑集合里）。
 *  返回 null = 无可聚焦目标。 */
function focusFirstEditableAfter(anchor) {
  if (!anchor || !anchor.isConnected) return null;
  const root = anchor.closest('form') || anchor.closest('.model-modal') || document.body;
  const all = Array.from(root.querySelectorAll(__EDITABLE_SEL))
    .filter((el) => el.offsetParent !== null);
  const after = all.find((el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  const next = after || all[0];
  if (next) { try { next.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return next || null;
}

/** 从登记过的遮罩中按层号、同层 DOM 顺序选顶层；包含技能设置与白名单。 */
function __topModalOverlay() {
  let top = null;
  let topZ = -Infinity;
  for (const overlay of document.body.children) {
    if (!__focusTraps.has(overlay) || overlay.classList.contains('closing') || !overlay.getClientRects().length) continue;
    const z = Number(getComputedStyle(overlay).zIndex) || 0;
    if (z >= topZ) { top = overlay; topZ = z; }
  }
  return top;
}
/** overlay 内可见且可聚焦的元素（tabindex="-1" 与隐藏节点排除）。 */
function __focusablesIn(overlay) {
  if (!overlay) return [];
  return Array.from(overlay.querySelectorAll(__FOCUSABLE)).filter((n) =>
    n.offsetParent !== null || n === document.activeElement);
}
function registerFocusTrap(overlay) {
  if (!overlay) return;
  __focusTraps.add(overlay);
  installModalFocusTrap();
}
function unregisterFocusTrap(overlay) {
  if (overlay) __focusTraps.delete(overlay);
}
function installModalFocusTrap() {
  if (__trapInstalled) return;
  __trapInstalled = true;

  /* ③ 自动登记：任何进入 DOM 的 .model-modal-overlay 都纳入陷阱约束，
        不必要求创建方记得调用 registerFocusTrap。
        ⚠️ 这是"兜底中的兜底"：modelModalShell 是正规入口，但全项目存在
           （且将来可能新增）直接手搓遮罩的路径。焦点陷阱属于安全/可达性底线，
           不该因为某条路径忘了登记就整体失效。
        观察 body 的直接子节点增删即可（遮罩都是挂 body 下的一层）。 */
  try {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('model-modal-overlay')) {
            __focusTraps.add(n);
          }
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('model-modal-overlay')) {
            __focusTraps.delete(n);
          }
        }
      }
    }).observe(document.body, { childList: true });
  } catch { /* 极老环境无 MutationObserver → 仍可依赖显式 register */ }

  // ① Tab 循环：在最上层弹窗内首尾相接
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // 启动引导（.ob-overlay）压在所有弹窗之上时让路：引导不在 model-modal 体系里，
    // 不豁免的话焦点会被下面那层的陷阱拽回去，引导按钮点不动。
    if (document.querySelector('.ob-overlay')) return;
    const overlay = __topModalOverlay();
    if (!overlay) return;
    const items = __focusablesIn(overlay);
    const cur = document.activeElement;
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    // 焦点跑到弹窗外（或落在弹窗容器自身）→ 拉回对应边界
    if (!overlay.contains(cur)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey && cur === first) { e.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
  }, true);

  // ② focusin 兜底：代码 / 鼠标把焦点挪到弹窗外 → 立刻拽回最上层弹窗。
  //    捕获阶段监听，先于任何聚焦到达目标前就能感知。
  document.addEventListener('focusin', (e) => {
    // 引导层在场时让路（同 Tab 循环的处理）
    if (document.querySelector('.ob-overlay')) return;
    const overlay = __topModalOverlay();
    if (!overlay) return;
    if (overlay.contains(e.target)) return;
    const items = __focusablesIn(overlay);
    try { (items[0] || overlay).focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }, true);
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (!overlay) return;
  // 所有关闭路径（点遮罩 / 右上角 × / Esc / 自己的按钮）都在这里汇合，
  // 统一派发 qa-close，让 09-dialogs.js 的 Promise 型对话框知道"我被关掉了"。
  // 不派发的话 `await qaConfirm(...)` 会永远挂在那里不 settle。
  try { overlay.dispatchEvent(new CustomEvent('qa-close')); } catch { /* ignore */ }
  // 先摘掉全局键盘监听并把焦点还给打开它的元素（可访问性）
  // ⚠️ removeEventListener 的第三参必须与 addEventListener 一致（都是捕获 true），
  //    否则监听器不会被解绑，弹窗关了却还在抢 Esc。
  if (overlay._keyHandler) {
    document.removeEventListener('keydown', overlay._keyHandler, true);
    overlay._keyHandler = null;
  }
  // 焦点陷阱：从全局登记表里摘掉（真逻辑与监听器由 installModalFocusTrap 统一持有）
  unregisterFocusTrap(overlay);
  // ── body 滚动锁 ──
  // 细节见 lockBodyScroll 上方的说明。
  unlockBodyScroll(overlay);
  const back = overlay._prevFocus;
  let restored = false;
  if (back && typeof back.focus === 'function' && back.isConnected && back !== document.body) {
    try { back.focus({ preventScroll: true }); restored = true; } catch { /* ignore */ }
    // ⚠️ back 是 readonly 选择框（#gp-pick / .fb-model-pick /
    //    #cfg-mem-model-pick …）时，焦点停在只读框上，之后弹窗/页面里所有
    //    Ctrl+V、Ctrl+C 都被 Chromium 静默吞掉。子弹窗都是点这些只读框打开的，
    //    机械归还必然复现，所以顺延到同一容器内第一个可编辑控件
    //    （弹窗内 → .model-modal；页面上 → form）。
    if (typeof back.matches === 'function' && back.matches('input[readonly], textarea[readonly]')) {
      focusFirstEditableAfter(back)
        || focusFirstEditableIn(back.closest('.model-modal') || back.closest('form') || document.body);
    }
  }
  if (!restored) {
    // back 不可用（是 body、或已随页面重渲染被移除）→ 焦点不能留在 body 上
    // （留在 body = 之后所有原生编辑命令静默失效）。落到关掉本弹窗后的新最上层，
    // 没有叠层则还给设置页表单第一个可编辑控件。
    const nextTop = Array.from(document.querySelectorAll('.model-modal-overlay:not(.closing)'))
      .filter((o) => o !== overlay).pop();
    if (nextTop) {
      if (!focusFirstEditableIn(nextTop)) {
        const btn = nextTop.querySelector('.model-modal-foot button:not([disabled])') || nextTop.querySelector('.model-modal-close');
        try { btn?.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    } else {
      focusFirstEditableIn(document.querySelector('#settings-form'));
    }
  }
  /* 平滑退场：遮罩淡出 + 面板下沉缩小，动画结束后再移除 DOM。
     与入场 popIn 对称，避免"砰"地消失。 */
  overlay.classList.add('closing');
  const modal = overlay.querySelector('.model-modal');
  let done = false;
  const finish = () => { if (!done) { done = true; overlay.remove(); } };
  if (modal) modal.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 400);   // 兜底：动画被 prefers-reduced-motion 压掉时也能关掉
}

/**
 * 弹窗外壳。
 * 主体方向判定：body 以 `<div class="model-modal-left"` 开头才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 不能用"包含 model-modal-left"判定：复合结构的弹窗（顶部工具栏 + 中部双栏
 *    + 底部提示，如批量价格编辑、模型添加）需要外层纵向、双栏在 .ma-body 内部横向。
 *    误判成 row 后，工具栏与提示文两个 flex 项把宽度吃光，
 *    .ma-body（flex:1, basis 0）被挤成 0 宽，整个内容区隐形。
 */

/**
 * @param {object} opts
 * @param {string} opts.head  标题
 * @param {string} opts.body  正文 HTML（调用方负责转义）
 * @param {string} [opts.foot] 底部按钮 HTML
 * @param {boolean} [opts.danger] 危险配色
 * @param {boolean} [opts.closeOnBackdrop=true] 点遮罩是否关闭。
 *   编辑型弹窗必须传 false：人设编辑器这类"填一半内容"的界面，误触外部直接关掉
 *   太伤体验。传 false 后仍有 × / 取消 / Esc 三条明确退出路径，且未保存改动守卫照常提示。
 */
function modelModalShell({ head, body, foot = '', danger = false, closeOnBackdrop = true }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true" aria-label="${esc(String(head || '对话框'))}">
      <div class="model-modal-head">
        <span>${esc(String(head ?? ''))}</span>
        <button class="model-modal-close" type="button" aria-label="关闭" title="关闭（Esc）">×</button>
      </div>
      <!-- body / foot 按 HTML 契约原样插入（调用方负责其内部转义），
           head 是**标题语义**，走 esc()，与上面的 aria-label 保持一致。
           2026-10-07：原先 head 也未转义，一旦有调用方把会话标题/群名当 title
           传进来，就能借 <img src> 打出外传信标（脚本执行被 CSP 的 script-src 'self' 挡住，
           但 img-src 放行了 http/https）。 -->
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      <div class="model-modal-foot">${foot || ''}</div>
    </div>`;
  document.body.appendChild(overlay);
  // 锁住背后页面滚动，与 closeModelModal 的 unlockBodyScroll 成对
  lockBodyScroll();
  overlay._scrollLocked = true;
  // ── 未保存改动守卫 ──
  // 人设类弹窗是"改完点保存"的显式保存模型（不能混进表单自动保存链，原因见
  // 06-settings-render.js saveToMap 注释），但 Esc / 点遮罩 / × 三条被动关闭路径
  // 会静默丢弃刚写的输入，感知上就是"没保存上"。
  //
  // 除 pcp/gp 等已显式挂 overlay.__dirtyGuard()（返回 true=有未保存改动）的弹窗外，
  // 给所有可编辑控件自动挂监听：用户真实编辑（e.isTrusted === true，可排除程序化
  // dispatchEvent 的回填）就把 __userEdited 置真，requestClose 据此弹确认。
  // 一次性覆盖所有"靠保存按钮落盘、但被动关闭会静默丢输入"的弹窗。
  //   · type=search 与 readonly/disabled 字段排除（过滤框是瞬态，不视为数据）。
  //   · 个别已自带实时保存的弹窗（如反馈草稿）可设 overlay._noDirtyGuard = true 退出。
  //   · 主动关闭（保存/取消等按钮直接调 closeModelModal）不经过守卫，语义不变。
  let __closing = false;
  let __userEdited = false;
  if (!overlay._noDirtyGuard) {
    // 用捕获阶段委托而非逐元素挂监听：既能覆盖弹窗里动态插入的输入框，
    // 也避免重复遍历 DOM。type=search 与 readonly/disabled 字段排除（过滤框属瞬态）。
    overlay.addEventListener('input', (e) => {
      const t = e.target;
      if (!t || typeof t.matches !== 'function') return;
      if (!t.matches('textarea, input:not([type=search]):not([readonly]):not([disabled]), select')) return;
      if (e.isTrusted) __userEdited = true;   // 排除程序化 dispatchEvent 的回填
    }, { capture: true, passive: true });
    overlay.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || typeof t.matches !== 'function') return;
      if (!t.matches('textarea, input:not([type=search]):not([readonly]):not([disabled]), select')) return;
      if (e.isTrusted) __userEdited = true;
    }, { capture: true, passive: true });
  }
  const __isDirty = () => (typeof overlay.__dirtyGuard === 'function') ? overlay.__dirtyGuard() : __userEdited;
  const requestClose = async (force = false) => {
    if (__closing || !overlay.isConnected) return;
    // 确认框的开合会把焦点带走：点遮罩触发时 activeElement 已是 body（遮罩不可
    // 聚焦，先 blur 了文本框），按 × 触发时是 × 按钮本身。「继续编辑」后焦点若
    // 落在 body / 按钮上，弹窗里随后所有 Ctrl+V 都会静默失效。
    // 先记下进入时的焦点，续编辑时拉回弹窗内的可编辑控件。
    const focusBack = document.activeElement;
    if (!force && !overlay._noDirtyGuard && __isDirty()) {
      let ok = false;
      try {
        ok = await qaConfirm({
          title: '未保存的修改',
          message: '弹窗里有未保存的修改，关闭后将丢失。确定关闭吗？',
          confirmText: '丢弃修改',
          cancelText: '继续编辑'
        });
      } catch { ok = true; }   // 确认框自身异常时保持旧行为（直接关）
      if (!ok) {
        const t = (focusBack && overlay.contains(focusBack) && typeof focusBack.matches === 'function' && focusBack.matches(__EDITABLE_SEL))
          ? focusBack
          : (focusFirstEditableIn(overlay) || overlay.querySelector('.model-modal-close'));
        try { t?.focus({ preventScroll: true }); } catch { /* ignore */ }
        return;
      }
    }
    __closing = true;
    closeModelModal(overlay);
  };
  // 点遮罩关闭（编辑型弹窗会显式关掉这个行为，见 closeOnBackdrop 的注释）
  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) requestClose();
    });
  }
  overlay.querySelector('.model-modal-close').addEventListener('click', () => requestClose());

  // ── 可访问性：Esc 关闭 + 焦点管理 ──
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      // ⚠️ 必须在捕获阶段（见下方 addEventListener 第三参 true）拦下 Esc。
      //    挂冒泡阶段会与 14-chrome.js 的 document 级 keydown（启动时注册，
      //    先注册先执行）打架：14-chrome 先跑时 e.defaultPrevented 还是 false，
      //    于是 closeBigPage() 把全屏页也关了，按一次 Esc 两层同关。
      //    捕获阶段最先执行，preventDefault() 生效后 14-chrome 会自行跳过。
      //    走 requestClose：有未保存改动时先弹确认，不静默丢弃。
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
  };
  // 只让"最上层"的弹窗响应 Esc：弹窗可以叠（模型选择 → 添加模型）
  overlay._onKey = onKey;
  overlay._prevFocus = prevFocus;
  const keyHandler = (e) => { if (__topModalOverlay() === overlay) onKey(e); };
  overlay._keyHandler = keyHandler;
  // 第三参 true = 捕获阶段：先于所有冒泡监听器（含 14-chrome 的关全屏页）执行
  document.addEventListener('keydown', keyHandler, true);

  // ── 焦点陷阱 ──
  // 实现在文档级（见文件末尾 installModalFocusTrap），不给每个 overlay 各挂一份：
  //    ① 弹窗可以叠，只有最上层该拦，集中在一处判断最上层更简单；
  //    ② 全项目还有别的代码直接用 `class="model-modal-overlay"` 手搓遮罩，
  //       它们没走 modelModalShell 也应当被同样的规则约束。
  // 这里只登记"这个 overlay 存在"，真正的拦截逻辑全局只有一份。
  registerFocusTrap(overlay);

  // 打开后把焦点移进弹窗（优先第一个可编辑输入框，否则关闭按钮）
  // ⚠️ 选择器必须排除 readonly / disabled：人设弹窗 body 里第一个可聚焦元素是
  //    readonly 的「选择人设」框（#gp-pick / #pcp-pick），焦点落在只读框上时
  //    Ctrl+V 粘贴被 Chromium 静默吞掉。
  setTimeout(() => {
    if (!overlay.isConnected) return;
    if (focusFirstEditableIn(overlay)) return;   // 优先第一个可编辑控件（排除只读/禁用）
    const first = overlay.querySelector('.model-modal-foot button:not([disabled])')
      || overlay.querySelector('.model-modal-close');
    try { first?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }, 0);
  // 统一给弹窗表单补 label→控件的关联：大量模板写成 <label>名称</label><input id="…">
  // 而没有 for，点标签不聚焦输入框、读屏软件也读不出关联。
  // 按「同一 .field 内的第一个控件」自动补（已有 for 的不动），一处覆盖全部弹窗。
  try {
    overlay.querySelectorAll('.field').forEach((f) => {
      const lb = f.querySelector(':scope > label');
      const ctrl = f.querySelector('input, select, textarea');
      if (!lb || !ctrl || lb.getAttribute('for')) return;
      if (!ctrl.id) ctrl.id = 'qa-f-' + Math.random().toString(36).slice(2, 9);
      lb.setAttribute('for', ctrl.id);
    });
  } catch { /* 老环境不支持 :scope 就跳过，不影响弹窗本身 */ }
  return overlay;
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 这东西对省钱没什么实际帮助，但一张纯数字的成本表太无聊了，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
// 弹窗之间跳转的挂起标记。
//
// 背景：旧流程有一个死循环。「添加提供商」强制要求至少填一个模型 id，
// 而「拉取模型列表」按钮只在已存在的提供商的右列里，新用户没有 Model id
// 就建不了提供商，也就不可能点到拉取按钮。这里连同 openProviderAddModal 一起打破它。
let pendingOpenModelManage = false;

/**
 * 关闭当前弹窗后打开「管理服务商」。
 *
 * 不能直接在当前弹窗里再开一个：两个遮罩会同层重叠（.model-modal-overlay
 * 的层号全项目只有一处，见 style.css 0.5 段的 --z-model-modal-overlay），
 * 新旧两个 DOM 摞在一起，中间那段既点得到旧的关闭按钮、又点得到新的内容。
 * 统一"先关后开"。
 */
function scheduleOpenModelManage() {
  pendingOpenModelManage = true;
  const opens = [...document.querySelectorAll('.model-modal-overlay:not(.closing)')];
  const top = opens[opens.length - 1];
  if (top) closeModelModal(top);
  // 等退场动画走完（closeModelModal 是淡出 400ms 后移除 DOM）。
  // 提前开会叠成两个遮罩：新的在下面、旧的淡出后还要再点一次。
  setTimeout(() => {
    if (!pendingOpenModelManage) return;
    pendingOpenModelManage = false;
    openModelManageModal();
  }, top ? 420 : 0);
}

function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span>${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        ${items.map((it) => `
          <div class="tb-row">
            <span class="tb-icon">${it.icon}</span>
            <span class="tb-name">${esc(it.name)}</span>
            <span class="tb-code">${esc(it.key)}</span>
            <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
            <span class="tb-n">${it.n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  // 表情工具已抽成 plugins/sticker，工具 id 变成 sticker__send_sticker；
  // 兼容旧会话档案里没有前缀的历史计数。
  const stickerN = Number(counts['sticker__send_sticker'] || counts.send_sticker) || 0;
  const sticker = stickerN ? `、贴了 ${stickerN} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
/**
 * 「选择人设」弹窗：把选中的人设文本填回某个「角色设定」编辑器。
 *
 * ⚠️ 必须能指定**填回目标**（`target`）：
 *   默认目标是设置页统一编辑器（`#cfg-*`），但那个编辑器只在「统一人设」模式下在场；
 *   从人设/分会话人设弹窗里点「选择人设」时，得填进弹窗自己的 `#gp-roletext` / `#pcp-roletext`。
 *   以前写死 `$('#cfg-roletext')`，元素不在场时 `null.value` 直接抛错（或静默无效），
 *   分群模式下「添加人设」填不进去就是这么来的。
 *
 * @param {{roleSel?:string, rulesSel?:string, pickSel?:string, hintSel?:string}} target
 */
function openPersonaPicker(target = {}) {
  const T = {
    roleSel: '#cfg-roletext',
    rulesSel: '#cfg-customrules',
    pickSel: '#cfg-persona-pick',
    hintSel: '#persona-pick-hint',
    ...target
  };
  const roleEl = document.querySelector(T.roleSel);
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    const h = document.querySelector(T.hintSel);
    if (h) h.textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `<div class="model-modal-right" id="persona-list" style="flex:1"></div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  const listEl = overlay.querySelector('#persona-list');

  /**
   * 渲染人设列表。
   * 每行右侧直接给「删除」：原先要先选中（会关掉本弹窗）再回编辑弹窗点删除，
   * 删个人设要绕一大圈。只对自定义人设（custom_*）显示，与后端约束一致。
   * 用事件委托绑定：删除后原地重绘列表，不需要重新挂监听。
   */
  const renderList = () => {
    const list = Object.entries(state.personaTemplates || {});
    listEl.innerHTML = list.map(([id, p]) => `
      <div class="mm-model" data-id="${esc(id)}">
        <span class="mm-check">${(String(p?.text ?? '').trim() === String(roleEl?.value ?? '').trim()) ? '✓' : ''}</span>
        <span>${esc(p.name)}</span>
        <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
        ${p.builtin ? '' : `<button class="btn btn-small btn-danger mm-del" type="button" data-del="${esc(id)}" style="margin-left:auto" title="删除这个自定义人设">删除</button>`}
      </div>`).join('');
  };

  listEl.addEventListener('click', async (e) => {
    // ── 行内「删除」：拦截，不能让它冒泡成"选中这一行并关窗" ──
    const delBtn = e.target.closest('.mm-del');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.del;
      const tpl = state.personaTemplates?.[id];
      if (!tpl) return;
      const ok = await qaConfirm({
        danger: true,
        title: '删除人设',
        message: `确定删除自定义人设「${tpl.name}」？\n\n删除后不可恢复。如果它正在被使用，角色设定会回落到内置默认。`,
        confirmText: '删除',
        cancelText: '取消'
      });
      if (!ok) return;
      try {
        await api(`/api/persona-templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
        // 正在用的就是它 → 回落到内置默认（与「删除当前自定义人设」同一口径）
        const usedNow = roleEl && String(roleEl.value).trim() === String(tpl.text ?? '').trim();
        const fallback = state.personaTemplates?.xiaojingyu;
        if (usedNow && fallback) {
          roleEl.value = fallback.text;
          const pickEl = document.querySelector(T.pickSel);
          if (pickEl) pickEl.value = fallback.name;
          roleEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await loadSettings();   // 刷新全局模板列表（本弹窗读的就是 state.personaTemplates）
        // ⚠️ loadSettings() 里 state.personaTemplates 的更新在 Promise.all().then
        //    慢路径（未 await），只等它会出现"后端删了、列表里还在"。
        //    删除后必须显式拉一次模板列表再重绘。
        try {
          const t = await api('/api/persona-templates');
          const map = {};
          for (const x of (t.templates || [])) map[x.id] = { name: x.name, text: x.text, builtin: !!x.builtin };
          state.personaTemplates = map;
        } catch {
          delete state.personaTemplates[id];   // 拉不到就本地删，至少这次界面是对的
        }
        renderList();           // 原地重绘，弹窗不关
        const h = document.querySelector(T.hintSel);
        if (h) h.textContent = `人设「${tpl.name}」已删除${usedNow ? '，当前角色设定已回落到内置默认' : ''}`;
      } catch (err) {
        const h = document.querySelector(T.hintSel);
        if (h) h.textContent = `删除失败：${err.message}`;
      }
      return;
    }

    // ── 行点击 = 选中这个人设 ──
    const row = e.target.closest('.mm-model');
    if (!row) return;
    {
      const id = row.dataset.id;
      const tpl = state.personaTemplates[id];
      if (tpl) {
        if (roleEl) roleEl.value = tpl.text;
        // ⚠️ 内置人设没有 customRules 字段。写成 `rulesEl.value = tpl.customRules || ''`
        //    会在用户每选一次内置人设时把编辑器里已写好的「管理员附加规则」抹成空串，
        //    选完直接保存即永久丢失。只在模板自带附加规则时才覆盖。
        const rulesEl = document.querySelector(T.rulesSel);
        if (rulesEl && String(tpl.customRules ?? '').trim()) rulesEl.value = tpl.customRules;
        const pickEl = document.querySelector(T.pickSel);
        if (pickEl) pickEl.value = tpl.name;
        // ⚠️ 程序化赋值不触发 input/change 事件 → 自动保存不会启动。
        //    这是"选了人设但改了不生效/切走就丢"的根因之一：用户以为点选
        //    完就保存了，实际上防抖窗口从未开启，切页签的 flush 也无从发起。
        //    一律派发：填的是设置页元素时它触发自动保存；填的是弹窗元素时
        //    到不了 #settings-form（弹窗挂在 body 下，弹窗自己走 POST 保存），
        //    但弹窗内部的监听器（如"删除当前自定义人设"的显隐）靠它同步。
        if (roleEl) roleEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      closeModelModal(overlay);
      // ⚠️ closeModelModal 会把焦点还给打开本弹窗前的元素，也就是 readonly 的
      //    「选择人设」框，之后弹窗里所有 Ctrl+V 都被 Chromium 静默吞掉。
      //    显式把焦点交还调用方指定的可编辑目标（人设文本框）。
      const focusEl = T.focusSel && document.querySelector(T.focusSel);
      if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch { /* ignore */ } }
      // ⚠️ 这里不能调 syncPersonaButtons()：它是 07-settings-events.js 里
      //    bindSettingsEvents() 的局部函数，本文件够不到，调用会抛 ReferenceError。
      //    页面重渲染时 bindSettingsEvents 自己会同步一次按钮状态。
    }
  });
  renderList();
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 添加人设：弹窗填写人设名称、角色设定、额外规矩。
 *  支持把 .txt/.md 文件直接拖进「角色设定」框，自动读文件填入（名称为空时用文件名）。
 *  @param target 同 openPersonaPicker：加完要填回哪个编辑器（默认设置页统一编辑器）。 */
function openPersonaCreateModal(target = {}) {
  const T = {
    roleSel: '#cfg-roletext',
    rulesSel: '#cfg-customrules',
    pickSel: '#cfg-persona-pick',
    hintSel: '#persona-pick-hint',
    ...target
  };
  // 添加成功后的回调。调用方（「已安装的人设」页）靠它刷新自己的列表，
  // 那个页面没有"角色设定"编辑器可填，只能靠回调知道"加完了"。
  // 不传则保持原行为（只填回编辑器），设置页那几处调用不受影响。
  const onDone = typeof target.onDone === 'function' ? target.onDone : null;
  // ── 编辑模式 ──
  // 传 editId 就是"改这一条"：预填三个框、按钮变「保存修改」、提交时带上 id。
  // 只对自定义人设开放（custom_N），内置人设的正文写死在 src/personas.js 里。
  const editId = String(target.editId || '').trim();
  const editTpl = editId ? ((state.personaTemplates || {})[editId] || null) : null;
  const isEdit = !!editTpl;
  const vName = isEdit ? String(editTpl.name || '') : '';
  const vText = isEdit ? String(editTpl.text || '') : '';
  const vRules = isEdit ? String(editTpl.customRules || '') : '';
  // 提示语优先写进调用方指定的提示位（弹窗里自带一个），页面上才退回全局提示位
  const setHint = (msg, tone) => {
    // 先写弹窗内的提示行：从「已安装 → 人设」页打开时 hintSel 指向空气，
    // 旧实现下校验失败（名称/正文为空）用户看不到任何反馈，点了「确认添加」
    // 毫无反应，只能反复点。
    const inner = overlay.querySelector('#persona-form-hint');
    if (inner) {
      inner.textContent = msg;
      inner.style.color = tone === 'err' ? 'var(--orange)' : '';
    }
    const h = document.querySelector(T.hintSel);
    if (h) h.textContent = msg;
  };
  // 顶部现场说明：人设是什么、保存后到底生不生效，按调用方路径给准确文案。
  //   onDone 存在 = 从「已安装 → 人设」页打开（不回填设置页、不自动生效）；
  //   否则 = 从设置页打开（会填进「角色设定」并自动保存）。
  const guideLine = onDone
    ? (isEdit
      ? '这次改的是<b>人设库里这一条</b>，保存后立即生效。'
      : '保存后<b>不会自动换上</b> —— 回到人设列表，打开卡片右侧的开关才会生效。')
    : '确认添加后，内容会填进上面的「角色设定」并自动保存。';
  const overlay = modelModalShell({
    head: isEdit ? '编辑人设' : '添加人设',
    // 编辑型弹窗（要粘一大段人设文本）：点外部不关闭，防误触清空
    closeOnBackdrop: false,
    body: `
      <div class="hint" style="flex-basis:100%;margin:0 0 12px;line-height:1.65">
        <b>人设 = 机器人的性格说明书</b>：它是谁、怎么说话、什么脾气。只改变说话方式，不影响它会的技能。<br>
        ${guideLine}
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" value="${esc(vName)}" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="它是谁、怎么说话、什么脾气……例如：&#10;「你叫阿毒，说话毒舌但讲义气，擅长吐槽，朋友难过时会认真安慰。」&#10;写好的 .txt 文件也可以直接拖进这个框。">${esc(vText)}</textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>额外规矩（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：对管理员的硬性要求，比如「不要透露你是 AI」「回复别超过 100 字」">${esc(vRules)}</textarea>
      </div>
      <div class="hint" id="persona-form-hint" style="flex-basis:100%;min-height:18px;margin-top:2px;color:var(--orange)"></div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">${isEdit ? '保存修改' : '确认添加'}</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  // ── 拖入 txt/md 自动读取 ──
  // 目标是「角色设定」textarea 本身（用户直觉就是往文本框里丢文件）。
  // dragover 必须 preventDefault 才允许 drop；高亮态挂在 textarea 上，离开/放下即撤。
  const textEl = overlay.querySelector('#new-persona-text');
  const nameEl = overlay.querySelector('#new-persona-name');
  const readDropFile = async (file) => {
    if (!file) return;
    if (file.size > 512 * 1024) {
      setHint('文件太大（上限 512KB），请先拆分再拖入。');
      return;
    }
    try {
      const content = await file.text();
      textEl.value = content;
      // 程序化赋值不触发事件，这里不需要自动保存（弹窗还没确认），但名称留空时顺手用文件名
      if (!nameEl.value.trim()) nameEl.value = file.name.replace(/\.(txt|md|markdown)$/i, '');
      textEl.dispatchEvent(new Event('input', { bubbles: true }));
      setHint(`已读取「${file.name}」（${content.length} 字），确认添加后生效。`);
    } catch (e) {
      setHint(`读取文件失败：${e.message}`);
    }
  };
  textEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    textEl.classList.add('persona-drop-hot');
  });
  textEl.addEventListener('dragleave', () => textEl.classList.remove('persona-drop-hot'));
  textEl.addEventListener('drop', (e) => {
    e.preventDefault();
    textEl.classList.remove('persona-drop-hot');
    readDropFile(e.dataTransfer?.files?.[0]);
  });
  // ⚠️ 打开就把焦点放到「角色设定」框：用户进这个弹窗的主操作就是粘贴一大段
  //    人设文本（.txt 拖读也是为它设计的）。modelModalShell 的自动聚焦会落到
  //    第一个可编辑元素「人设名称」上，整段 Ctrl+V 会灌进名称框。
  //    本 setTimeout 后注册，覆盖 shell 的自动聚焦。
  setTimeout(() => { try { textEl.focus({ preventScroll: true }); } catch { /* ignore */ } }, 0);
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { setHint('先给这个人设起个名字', 'err'); return; }
    if (!text) { setHint('角色设定还是空的 —— 写几句「它是谁、怎么说话」', 'err'); return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify(isEdit ? { id: editId, name, text, customRules } : { name, text, customRules })
      });
      closeModelModal(overlay);
      // 编辑的正好是**当前生效**的人设时，把新正文同步进 config.persona，
      // 后端只更新模板，config.persona.roleText 存的还是旧正文副本，不同步的话：
      //   ① 列表按正文比对会显示它「未使用」（其实在用）；
      //   ② 对话里实际发出去的还是旧正文，用户以为改了却没生效。
      // 模板没带 customRules 时刻意不覆盖（与 personaApplyPatch 同口径：
      // 保留用户手写的额外规矩）。
      if (isEdit && typeof personaIsCurrent === 'function' && personaIsCurrent(editId)) {
        try {
          const patch = { persona: { roleText: text } };
          if (customRules) patch.persona.customRules = customRules;
          await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
        } catch (e2) {
          // 弹窗已关，setHint 写不进弹窗内那行，用全局轻提示兜底
          if (typeof personaToast === 'function') {
            personaToast(`人设已保存，但同步到当前配置失败：${e2.message}`, 'err');
          }
          setHint(`人设已保存，但同步到当前配置失败：${e2.message}（去「设置 → 人设与记忆」重新选一次即可）`, 'err');
        }
      }
      // 编辑模式不回填设置页的编辑器：这次改的是"库里那一条"，不是"当前角色设定"。
      // （新增模式仍要回填，那是设置页「＋ 添加人设」的既有行为。）
      const roleEl = isEdit ? null : document.querySelector(T.roleSel);
      const rulesEl = isEdit ? null : document.querySelector(T.rulesSel);
      const pickEl = isEdit ? null : document.querySelector(T.pickSel);
      if (roleEl) roleEl.value = text;
      // 与 openPersonaPicker 同款：新建人设没填附加规则时（customRules 为空）
      // 不要覆盖编辑器里已写好的规则，否则"添加人设"会静默抹掉「管理员附加规则」。
      if (rulesEl && customRules) rulesEl.value = customRules;
      if (pickEl) pickEl.value = name;
      // 同 openPersonaPicker：程序化赋值不触发 input 事件，自动保存不会启动，
      // 主动派发一次，否则"添加完人设切走页签"就丢（保存从未发起）。
      // 只对在设置表单里的元素派发（弹窗自己走 POST，派发无意义）。
      if (roleEl && document.getElementById('settings-form')?.contains(roleEl)) {
        roleEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // 拉动人设模板列表，让「选择人设」里立刻能看到刚加的这条
      await loadSettings();
      // loadSettings 会重渲染整个表单；重渲染用的是 state.config（含刚派发
      // 事件触发的自动保存最终值）。自动保存在途时渲染守卫会拦下并补绘，不会丢。
      setHint(isEdit
        ? `人设「${name}」已保存。`
        : `人设「${name}」已添加，内容已填进上面的「角色设定」，切走页签即保存。`);
      if (onDone) { try { onDone(); } catch { /* 回调失败不影响已完成的添加 */ } }
    } catch (e) {
      setHint(`${isEdit ? '保存' : '添加'}失败：${e.message}（已填的内容不会丢，可以直接重试）`, 'err');
    }
  });
}

/**
 * 「模型设置」模态框：先选服务商、再选模型，外加图片/视频专用模型与相关开关。
 *
 * 连接信息（接口地址、密钥、代理）不在这里改：本弹窗只负责"用哪个"，不负责"怎么连"。
 * 一个服务商的地址与密钥是它自身的属性，放在"选模型"的地方会让人以为同一个服务商
 * 可以在这里另配一套地址。空状态与左列底部都给了「管理服务商」的直达入口。
 *
 * 保存按钮 = 把这些选择 PATCH 到 /api/config（不再碰 Key：Key 的读写全在
 * 「管理服务商」里，避免两处写同一个字段、谁后写谁生效的旧坑）。
 */
function openModelConfigModal() {
  const c = state.config || {};
  // 可变量：refreshProvidersState() 之后 state.providers 是整个新数组，
  // 捕获成 const 会让重绘继续读旧目录（典型症状：刚加的服务商在弹窗里看不到）。
  let providers = state.providers || [];
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of providers) {
      if ((p.modelNames || {})[m]) return p.modelNames[m];
    }
    return m;
  };
  // 已选服务商：优先当前生效的那个；它已不存在（被删）时落到第一个。
  let pickedPid = providers.some((p) => p.id === c.api?.provider)
    ? c.api.provider
    : (providers[0]?.id || '');
  // 已选模型：只有它属于当前服务商时才算选中，否则视为"还没选"。
  // 切换服务商时靠这条规则自动清空，不需要在点击处理里另写一遍。
  let pickedModel = (() => {
    const p = providers.find((x) => x.id === pickedPid);
    const m = String(c.api?.model || '');
    return p && (p.models || []).includes(m) ? m : '';
  })();

  const overlay = modelModalShell({
    head: '模型设置',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="model-modal-left" id="mc-left"></div>
      <div class="model-modal-right" id="mc-right"></div>`,
    foot: `<button class="btn" id="mc-cancel">取消</button>
           <button class="btn btn-primary" id="mc-save">保存</button>`
  });
  const left = overlay.querySelector('#mc-left');
  const right = overlay.querySelector('#mc-right');

  function renderLeft() {
    if (!providers.length) {
      left.innerHTML = '<div class="muted" style="padding:10px;font-size:12px">还没有服务商。<br />先到「管理服务商」添加一个。</div>';
    } else {
      left.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === pickedPid ? 'active' : ''}" data-pid="${esc(p.id)}">${providerRowHtml(p)}</div>`).join('');
    }
    left.insertAdjacentHTML('beforeend', `
      <div style="margin-top:10px;border-top:1px solid var(--edge);padding-top:8px">
        <button class="btn btn-small" id="mc-goto-manage" type="button" style="width:100%"
          title="服务商的名称、接口地址、密钥与网络代理都在「管理服务商」里配置">服务商地址与密钥 →</button>
      </div>`);
    left.querySelectorAll('.mm-prov').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.pid === pickedPid) return;
      pickedPid = el.dataset.pid;
      // 新服务商下没有这个模型 → 清空（见 pickedModel 初始化的同一判定）
      const p = providers.find((x) => x.id === pickedPid);
      if (!p || !(p.models || []).includes(pickedModel)) pickedModel = '';
      renderLeft();
      renderRight();
    }));
    left.querySelector('#mc-goto-manage')?.addEventListener('click', () => scheduleOpenModelManage());
  }

  function renderRight() {
    const p = providers.find((x) => x.id === pickedPid);
    // 这几项与「选中哪个服务商」无关，但右列会因切换服务商整体重建。
    // 重建若还从 c.api（打开弹窗那一刻的快照）取值，用户先改了图文开关、
    // 再点另一个服务商，刚改的就被静默还原了。所以重建前先把**当前 DOM 里的值**
    // 抓成快照，没有 DOM（首次渲染）时才回落到 c.api。
    // 专用模型多存一个干净 id（dataset.model），保存时用它而不是显示名。
    const prev = right.querySelector('#mc-vision');
    const sketch = prev ? {
      vision: prev.checked,
      video: right.querySelector('#mc-video')?.checked,
      videoMode: right.querySelector('#mc-video-mode')?.value,
      visionModel: right.querySelector('#mc-vision-model-pick')?.dataset.model,
      videoModel: right.querySelector('#mc-video-model-pick')?.dataset.model
    } : null;
    const visionOn = sketch ? sketch.vision : (c.api?.vision !== false);
    const videoOn = sketch ? sketch.video : (c.api?.video === true);
    const videoMode = sketch ? sketch.videoMode : (c.api?.videoMode || 'auto');
    // 专用模型的显示名：快照里有干净 id 就按 id 反查目录名，否则用已存的配置值。
    const specialDisplay = (which, fallback) => {
      const id = sketch ? sketch[which] : undefined;
      if (id === undefined) return esc(displayOf(fallback));
      return esc(id ? (displayOf(id) || id) : '');
    };
    const switches = `
      <div class="checkbox-row"><input type="checkbox" class="sw" id="mc-vision" ${visionOn ? 'checked' : ''} />
        <label for="mc-vision">图片输入（关闭则移除看图工具）</label>
        <span id="mc-vision-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
      <div class="checkbox-row"><input type="checkbox" class="sw" id="mc-video" ${videoOn ? 'checked' : ''} />
        <label for="mc-video">视频输入（GIF 转视频发给模型）</label></div>
      <div class="field-row">
        <div class="field"><label>图片输入专用模型（留空用主模型）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="mc-vision-model-pick" readonly placeholder="点击选择" value="${specialDisplay('visionModel', c.api?.visionModel)}"${sketch?.visionModel ? ` data-model="${esc(sketch.visionModel)}"` : ''} style="flex:1;cursor:pointer" />
            <button class="btn btn-small" id="mc-vision-model-clear" type="button">清空</button>
          </div></div>
        <div class="field"><label>视频输入专用模型（留空用主模型）</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="mc-video-model-pick" readonly placeholder="点击选择" value="${specialDisplay('videoModel', c.api?.videoModel)}"${sketch?.videoModel ? ` data-model="${esc(sketch.videoModel)}"` : ''} style="flex:1;cursor:pointer" />
            <button class="btn btn-small" id="mc-video-model-clear" type="button">清空</button>
          </div></div>
      </div>
      <div class="field"><label>视频理解方式</label>
        <select id="mc-video-mode">
          ${[
            ['auto', '自动：配了视频专用模型就原生读视频，否则抽帧'],
            ['native', '原生：把视频直接交给全模态模型（需模型支持）'],
            ['frames', '抽帧：把视频变成若干张图片（任何视觉模型都能用）'],
            ['off', '关闭：只读时长/分辨率等元信息']
          ].map(([v, l]) => `<option value="${v}" ${videoMode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>`;

    if (!p) {
      right.innerHTML = `
        <div class="empty-hint">还没有可选的服务商。<br />接口地址、密钥与模型都在「管理服务商」里配置。</div>
        <div style="margin-top:10px">
          <button class="btn" id="mc-goto-manage-2" type="button">去「管理服务商」添加 →</button>
        </div>
        ${switches}`;
    } else {
      const names = p.modelNames || {};
      const modelList = (p.models || []).length
        ? (p.models || []).map((m) => {
          // 名称与 id 分开渲染：模型名可能很长（`qwen/qwen3-max-preview`），
          // 不给名称留 flex:1 + 省略号的话，右侧 id 会被挤出容器而不是截断。
          const label = names[m] || m;
          return `
          <div class="mm-model${m === pickedModel ? ' active' : ''}" data-model="${esc(m)}">
            <span class="mm-check">${m === pickedModel ? '✓' : ''}</span>
            <span class="mm-model-text">${esc(label)}</span>
            ${label !== m ? `<span class="muted mm-model-id">${esc(m)}</span>` : ''}
          </div>`;
        }).join('')
        : '<div class="muted" style="padding:10px">这个服务商下还没有模型。到「管理服务商」里点「拉取模型列表」或手动添加。</div>';
      right.innerHTML = `
        <div class="field"><label>服务商</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:600">${esc(providerLabelOf(p))}</span>
            <span class="muted" style="font-size:12px">${p.hasKey ? '· 已保存密钥' : '· 未保存密钥'}</span>
          </div>
          <div class="hint" style="margin-top:4px">接口地址与密钥在「管理服务商」里修改。</div></div>
        <div class="field"><label>模型（点击选择）</label>
          <div id="mc-model-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius)">
            ${modelList}
          </div>
          <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
            <button class="btn btn-small" id="mc-test-btn" type="button" ${pickedModel ? '' : 'disabled'}>测试连通性</button>
            <span class="hint" id="mc-test-result" style="margin:0"></span>
          </div></div>
        ${switches}`;
    }

    right.querySelector('#mc-goto-manage-2')?.addEventListener('click', () => scheduleOpenModelManage());
    right.querySelectorAll('#mc-model-list .mm-model').forEach((el) => el.addEventListener('click', () => {
      pickedModel = el.dataset.model;
      renderRight();
    }));
    // 专用模型选择（写 value + dataset.model，保存时带走干净的 id）
    right.querySelector('#mc-vision-model-pick')?.addEventListener('click', () => pickSpecial('vision'));
    right.querySelector('#mc-video-model-pick')?.addEventListener('click', () => pickSpecial('video'));
    right.querySelector('#mc-vision-model-clear')?.addEventListener('click', () => {
      const el = right.querySelector('#mc-vision-model-pick');
      el.value = ''; delete el.dataset.model;
    });
    right.querySelector('#mc-video-model-clear')?.addEventListener('click', () => {
      const el = right.querySelector('#mc-video-model-pick');
      el.value = ''; delete el.dataset.model;
    });
    right.querySelector('#mc-test-btn')?.addEventListener('click', runTest);
  }

  // 连通性测试：用所选服务商**已保存**的配置去测（Key 由后端按 providerId 解析）。
  // 这里不再有密钥输入框，所以不能把"用户刚输的 Key"传过去——那是「管理服务商」的事。
  async function runTest() {
    const p = providers.find((x) => x.id === pickedPid);
    const btn = right.querySelector('#mc-test-btn');
    const out = right.querySelector('#mc-test-result');
    if (!p || !btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: p.baseURL || '',
          providerId: p.id,
          model: pickedModel || String(c.api?.model || ''),
          apiProtocol: p.apiProtocol || ''
        })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok ? `✓ 测试通过（${res.latencyMs}ms）` : `✗ ${res.note || '测试失败'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = '测试连通性';
  }

  // 专用模型选择（左服务商 / 右模型）。写回弹窗里的只读框，保存时随主配置一起提交。
  const pickSpecial = (which) => {
    if (!providers.length) { qaAlert('模型目录为空。'); return; }
    const fieldId = which === 'vision' ? 'mc-vision-model-pick' : 'mc-video-model-pick';
    const pickOverlay = modelModalShell({
      head: which === 'vision' ? '选择图片输入模型' : '选择视频输入模型',
      body: `
        <div class="model-modal-left" id="msp-left"></div>
        <div class="model-modal-right" id="msp-right"></div>`,
      foot: `<button class="btn" id="msp-cancel">取消</button>`
    });
    const pl = pickOverlay.querySelector('#msp-left');
    const pr = pickOverlay.querySelector('#msp-right');
    let activePid = pickedPid || providers[0].id;
    const renderLeft = () => {
      pl.innerHTML = providers.map((p) =>
        `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${providerRowHtml(p)}</div>`).join('');
      pl.querySelectorAll('.mm-prov').forEach((el) => el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); }));
    };
    const renderRight = () => {
      const p = providers.find((x) => x.id === activePid);
      if (!p) { pr.innerHTML = ''; return; }
      const names = p.modelNames || {};
      pr.innerHTML = (p.models || []).map((m) => `
        <div class="mm-model" data-model="${esc(m)}">
          <span>${esc(names[m] || m)}</span>
          ${(names[m] || m) !== m ? `<span class="muted" style="font-size:11px">${esc(m)}</span>` : ''}
        </div>`).join('') || '<div class="muted" style="padding:10px">该服务商下没有模型</div>';
      pr.querySelectorAll('.mm-model').forEach((el) => el.addEventListener('click', () => {
        const field = overlay.querySelector('#' + fieldId);
        field.value = (names[el.dataset.model] || el.dataset.model);
        field.dataset.model = el.dataset.model;
        closeModelModal(pickOverlay);
      }));
    };
    renderLeft();
    renderRight();
    pickOverlay.querySelector('#msp-cancel').addEventListener('click', () => closeModelModal(pickOverlay));
  };

  overlay.querySelector('#mc-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mc-save').addEventListener('click', async () => {
    const patch = {
      vision: overlay.querySelector('#mc-vision')?.checked ?? (c.api?.vision !== false),
      video: overlay.querySelector('#mc-video')?.checked ?? (c.api?.video === true),
      videoMode: overlay.querySelector('#mc-video-mode')?.value || 'auto'
    };
    const p = providers.find((x) => x.id === pickedPid);
    if (p && pickedModel) {
      patch.provider = pickedPid;
      patch.model = pickedModel;
      // baseUrl 跟着提供商走：运行时的主调用只看 api.baseUrl，
      // 只改 provider 而不改它，请求会发到旧地址（旧版本踩过的坑）。
      if (p.baseURL) patch.baseUrl = p.baseURL;
    }
    // 专用模型：dataset.model 里是干净的 id（没动过就没有该属性 = 走"保持原值"分支）
    const vEl = overlay.querySelector('#mc-vision-model-pick');
    const dEl = overlay.querySelector('#mc-video-model-pick');
    if (vEl && (vEl.dataset.model !== undefined || vEl.value === '')) patch.visionModel = vEl.dataset.model || '';
    if (dEl && (dEl.dataset.model !== undefined || dEl.value === '')) patch.videoModel = dEl.dataset.model || '';
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ api: patch }) });
      closeModelModal(overlay);
      loadSettings();
    } catch (e) {
      qaAlert(`保存失败：${e.message}`);
    }
  });

  renderLeft();
  renderRight();
  // 静默刷新一次 providers：用户可能刚在「管理服务商」里加过，state 还没跟上。
  // 刷新到位后原地重绘；弹窗已关则跳过。已选服务商/模型若随刷新失效，重绘会
  // 由 renderLeft/renderRight 里的兜底判定自动对齐。
  refreshProvidersState().then(() => {
    if (!overlay.isConnected) return;
    providers = state.providers || [];
    // 目录变了：已选服务商可能被删、已选模型可能被移出，先对齐再重绘
    if (!providers.some((p) => p.id === pickedPid)) pickedPid = providers[0]?.id || '';
    const nowP = providers.find((x) => x.id === pickedPid);
    if (!nowP || !(nowP.models || []).includes(pickedModel)) pickedModel = '';
    renderLeft();
    renderRight();
  }).catch(() => { /* 内部已兜底；这里只保证链上异常不会变成 unhandledRejection */ });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
/**
 * 主动刷新 state.providers。
 *
 * ⚠️ loadSettings() 的 providers 更新在内部的 Promise.all().then 里（慢路径，
 * 没有 await），`await loadSettings()` 返回时 state.providers 仍是旧值。
 * 紧随其后的 onDone() 会读到空数组、显示"还没有提供商"，自动选主模型也会跳过。
 * 添加/拉取模型之后必须显式拉一次，不能赌 loadSettings 的时序。
 */
async function refreshProvidersState() {
  try {
    const d = await api('/api/providers');
    state.providers = d.providers || [];
  } catch { /* 拉不到就沿用旧值，不阻塞主流程 */ }
}

/**
 * 还没有主模型、但提供商目录里已经有模型时，把"选模型"这一步收掉。
 *
 * 背景：在「管理服务商」里配置完提供商后，还要自己去「模型设置」点「模型目录」
 * 选一次模型才算能用，萌新根本不知道还有这一步，配置永远停在半路。
 *
 * 规则：
 *   · 已有主模型 → 不动（加备用提供商不打扰）；
 *   · 目录里只有 1 个模型 → 直接选它（新手最常见的路径）；
 *   · 多个模型 → 弹「选择模型」让用户自己挑。
 *
 * @returns {Promise<boolean>} true = 已自动选定 / 已弹出选择器
 */
async function autoPickMainModelIfNeeded() {
  const cfg = state.config || {};
  if (String(cfg.api?.model || '').trim()) return false;
  // 兜底：state.providers 可能因 loadSettings 的慢路径尚未刷新（见 refreshProvidersState 注释）
  if (!(state.providers || []).length) await refreshProvidersState();
  const providers = state.providers || [];
  const all = [];
  for (const p of providers) {
    for (const m of (p.models || [])) all.push({ provider: p.id, model: m, baseUrl: p.baseURL || '' });
  }
  if (!all.length) return false;
  if (all.length === 1) {
    const pick = all[0];
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { provider: pick.provider, model: pick.model, baseUrl: pick.baseUrl } })
      });
      await loadSettings();
      // 提示一句"已自动选定"，否则用户不知道模型被谁选的
      const hint = $('#provider-hint');
      if (hint) hint.textContent = `已自动选用模型：${pick.model}（随时可在「模型设置」里更换）`;
    } catch { /* 自动选失败就退回让用户手动选 */ }
    return true;
  }
  openModelPicker();
  return true;
}

function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    setHintText('#provider-hint', '模型目录为空：请先在下方的“手动添加提供商”里添加。');
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
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
    right.innerHTML = (p.models || []).map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        ${(names[m] || m) !== m ? `<span class="muted" style="font-size:11px">${esc(m)}</span>` : ''}
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        // 同步规则：图片/视频专用模型如果指向**其它提供商**的旧模型，
        // 主模型一换就再也对不上（识别请求会发到已弃用的端点）。
        // 这里随主模型一起切换：专用模型属于同一提供商 → 跟随主模型 id；
        // 属于别的提供商（用户特意挑的跨渠道视觉模型）→ 清空回退主模型。
        // 用户在设置里明确填写的专用模型仍然优先，只有"跟随主模型"的
        // 旧值才被替换，判定依据：旧专用模型属于当前主提供商（跟随态）。
        const cfg = state.config || {};
        const oldProvider = cfg.api?.provider;
        const oldVision = String(cfg.api?.visionModel || '').trim();
        const oldVideo = String(cfg.api?.videoModel || '').trim();
        // ⚠️ 判据必须是"该模型是否属于旧提供商的模型目录"，不是 spec === oldPid
        //    （模型 id 与提供商 id 比相等，正常情况恒为 false）。
        //    判错的话换提供商后专用模型永不更新/清空，图片/视频识别会以
        //    "新端点 + 旧模型 id"发出，必然 404。
        const followsMain = (spec, oldPid) => {
          if (!spec || !oldPid) return false;
          const op = (state.providers || []).find((x) => x.id === oldPid);
          return !!op && (op.models || []).includes(spec);
        };
        const visionModel = oldVision && followsMain(oldVision, oldProvider)
          ? (pid === oldProvider ? model : '')
          : oldVision;
        const videoModel = oldVideo && followsMain(oldVideo, oldProvider)
          ? (pid === oldProvider ? model : '')
          : oldVideo;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, ...(visionModel !== oldVision ? { visionModel } : {}), ...(videoModel !== oldVideo ? { videoModel } : {}) } })
          });
          closeModelModal(overlay);
          try { await loadSettings(); } catch { /* 刷新失败不遮断焦点归还，也别误报"选择失败"（POST 已成功） */ }
          // loadSettings 重渲染整个表单，焦点会掉回 body（之后 Ctrl+V 全废），
          // 显式还给主模型选择框之后第一个可编辑控件。
          focusFirstEditableAfter($('#cfg-model-pick'));
        } catch (e) {
          setHintText('#provider-hint', `选择失败：${e.message}`);
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 添加自定义搜索服务：与「模型设置」同款的"入口按钮 → 专门弹窗"形态
 * （原来的 <details> 折叠条看着不像能点）。
 * 字段 id 沿用页面时代的 new-sp-* / add-search-provider-btn / add-search-provider-hint。
 * 弹窗内容是点击后才创建的，页面绑定抓不到，所以绑定必须在这里自带。
 */
function openAddSearchProviderModal() {
  const overlay = modelModalShell({
    head: '添加自定义搜索服务',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="field-row">
        <div class="field"><label>名称（自己辨认用）</label>
          <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
        <div class="field"><label>类型</label>
          <select id="new-sp-type">
            <option value="openai">JSON 搜索接口（POST）</option>
            <option value="bing">网页解析（Bing 结果格式）</option>
          </select></div>
      </div>
      <div class="field"><label>接口地址 / 搜索页地址</label>
        <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
      <div class="field-row">
        <div class="field"><label>API Key（可选）</label>
          <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
        <div class="field"><label>模型名（可选）</label>
          <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
      </div>`,
    foot: `
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
      <button class="btn" id="add-search-provider-btn">＋ 添加并选中</button>`
  });
  overlay.querySelector('#add-search-provider-btn').addEventListener('click', async () => {
    const hint = overlay.querySelector('#add-search-provider-hint');
    const baseUrl = (overlay.querySelector('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: (overlay.querySelector('#new-sp-name')?.value || '').trim(),
          type: overlay.querySelector('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: (overlay.querySelector('#new-sp-apikey')?.value || '').trim(),
          model: (overlay.querySelector('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      // 重渲染设置页：下拉框里立刻出现新服务且处于选中态
      await loadSettings();
      // 让用户看到 ✓ 再关（model-modal 退场动画 400ms，这里停 600ms）
      setTimeout(() => closeModelModal(overlay), 600);
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    setHintText('#mem-model-hint', '模型目录为空：请先到「模型 API」页签添加提供商。');
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
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
    right.innerHTML = (p.models || []).map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        ${(names[m] || m) !== m ? `<span class="muted" style="font-size:11px">${esc(m)}</span>` : ''}
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染，复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          try { await loadSettings(); } catch { /* 同上：刷新失败不误报 */ }
          // 同 openModelPicker：重渲染后焦点显式归还。
          focusFirstEditableAfter($('#cfg-mem-model-pick'));
        } catch (e) {
          setHintText('#mem-model-hint', `选择失败：${e.message}`);
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 选择图片/视频专用模型：复用模型目录选择器。
 * 与主模型不同点：
 *   · 不换 provider：专用模型只记模型 id（llm.js 检测到对应模态时替换主模型 id，
 *     端点仍用主模型的）。跨提供商挑模型也允许（很多网关同一 baseUrl 下全量模型）。
 *   · 选中后直接写 DOM 隐藏字段（cfg-vision-model / cfg-video-model），
 *     随后的自动保存（saveConfig 'api' 分支读这些字段）把它带走。与主模型
 *     选择器"立即 POST"不同，这里走统一表单流，避免两条保存路径打架。
 *   · 顶部多一个「跟随主模型（清空）」选项，对应"留空用主模型"的语义。
 */
function openSpecialModelPicker(which) {
  const isVision = which === 'vision';
  const fieldId = isVision ? 'cfg-vision-model' : 'cfg-video-model';
  const pickId = isVision ? 'cfg-vision-model-pick' : 'cfg-video-model-pick';
  const providers = state.providers || [];
  if (!providers.length) { qaAlert('模型目录为空：请先在「模型 API」页添加提供商。'); return; }
  const currentModel = ($('#' + fieldId)?.value || '').trim();
  const overlay = modelModalShell({
    head: isVision ? '选择图片输入模型' : '选择视频输入模型',
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
  function apply(model) {
    const input = $('#' + fieldId);
    const pick = $('#' + pickId);
    if (input) input.value = model;
    if (pick) {
      // 显示名与 renderApiSection 的 displayOf 同口径
      let label = model;
      for (const p of (state.providers || [])) {
        if ((p.modelNames || {})[model]) { label = p.modelNames[model]; break; }
      }
      pick.value = model ? label : '';
    }
    // 触发表单监听：自动保存按 'api' 分支读取隐藏字段
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    closeModelModal(overlay);
    // 关闭后把焦点还给触发按钮：焦点掉到 body 的话，键盘用户选完模型
    // 要重新 Tab 一路找回来（对照 openMemoryModelPicker 的同类处理）。
    focusFirstEditableAfter($('#' + pickId));
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = `
      <div class="mm-model" data-model="">
        <span class="mm-check">${currentModel ? '' : '✓'}</span>
        <span>（跟随主模型）</span>
        <span class="muted" style="font-size:11px">留空 = 图片/视频也用主模型</span>
      </div>
      ${(p.models || []).map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        ${(names[m] || m) !== m ? `<span class="muted" style="font-size:11px">${esc(m)}</span>` : ''}
      </div>`).join('')}`;
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', () => apply(el.dataset.model || ''));
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels, knownProviderId) {
  const providers = state.providers || [];
  // 已知提供商 id 优先（管理服务商里"拉取模型列表"传来的），否则按 baseUrl 匹配
  const existingProvider = providers.find((p) => p.id === knownProviderId)
    || providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === String(baseUrl || '').replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      // 同 openProviderAddModal：先显式刷新 providers，再渲染/自动选模型
      await refreshProvidersState();
      closeModelModal(overlay);
      // 必须写存活的 #provider-hint：写不存在的元素会在 catch 里二次抛错。
      setHintText('#provider-hint', `已加入 ${newModels.length} 个模型。`);
      await loadSettings();
      // 补拉模型之后同样把"选主模型"这步收掉（单模型自动选定 / 多模型弹选择器），
      // "先建提供商、后拉模型"是新手最常见的路径。
      await autoPickMainModelIfNeeded();
    } catch (e) {
      setHintText('#provider-hint', `加入失败：${e.message}`);
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
/**
 * 「管理服务商」模态框：左右两列。
 * 左列 = 提供商列表 + 添加提供商 / 删除提供商按钮；
 * 右列 = 选中提供商的 baseURL、API Key（掩码）、模型列表（ID + 显示名）、
 *        拉取模型列表 / 删除模型按钮。
 * 替代了页面上原来的「删除模型 / 提供商」按钮和「手动添加提供商」整块表单。
 */
function openModelManageModal() {
  const overlay = modelModalShell({
    head: '管理服务商',
    body: `
      <div class="model-modal-left" id="mg-left"></div>
      <div class="model-modal-right" id="mg-right"></div>`,
    foot: `<button class="btn" id="mg-close">关闭</button>`
  });
  const left = overlay.querySelector('#mg-left');
  const right = overlay.querySelector('#mg-right');
  const cfgProvider = String(state.config?.api?.provider || '');
  let activePid = cfgProvider || (state.providers || [])[0]?.id || '';

  function renderLeft() {
    const providers = state.providers || [];
    // 选中项兜底：openModelManageModal 只在**打开那一刻**算过一次 activePid，
    // 之后添加/删除提供商都不会重算。于是"空目录打开 → 添加提供商"这条路
    // 走到这里 activePid 仍是 ''，renderRight 拿不到 provider →
    // 右列只显示"左侧选中一个提供商后…"，连「拉取模型列表」按钮都不出现。
    // 这里每次渲染都重新对齐：activePid 失效（被删/为空）就回退到第一个。
    if (!providers.some((p) => p.id === activePid)) {
      activePid = (cfgProvider && providers.some((p) => p.id === cfgProvider))
        ? cfgProvider
        : (providers[0]?.id || '');
    }
    left.innerHTML = `
      <div style="padding:6px 0 8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-small" id="mg-add-prov">＋ 添加提供商</button>
        <button class="btn btn-small btn-danger" id="mg-del-prov">删除提供商</button>
      </div>
      ${providers.map((p) => `
        <div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">
          ${providerRowHtml(p, p.id === cfgProvider)}
        </div>`).join('') || '<div class="muted" style="padding:10px;font-size:12px">还没有提供商。<br />点上方「＋ 添加提供商」，只填 Base URL + API Key 也行 —— 添加后就能「拉取模型列表」。</div>'}`;
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
    // 添加提供商：弹子模态框（Base URL + Key → 拉取/勾选模型 → POST /api/providers）
    left.querySelector('#mg-add-prov').addEventListener('click', () => {
      openProviderAddModal(() => { renderLeft(); renderRight(); });
    });
    // 删除提供商：删当前选中的那个（confirm 在右列的删除按钮上做过了，这里再拦一道）
    left.querySelector('#mg-del-prov').addEventListener('click', async () => {
      const p = (state.providers || []).find((x) => x.id === activePid);
      if (!p) { qaAlert('请先在列表里选中一个提供商。'); return; }
      const modelCount = (p.models || []).length;
      // 破坏性 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: '删除提供商',
        message: `确定删除整个提供商「${providerLabelOf(p)}」？\n\n将一并删除它的 API Key 与 ${modelCount} 个模型。此操作不可撤销。`
      })) return;
      try {
        await api('/api/providers', { method: 'DELETE', body: JSON.stringify({ providerId: p.id }) });
        // 删的是当前主提供商 → 后端会清空选中模型，刷新设置页提示重新选
        activePid = cfgProvider === p.id ? '' : activePid;
        // 同上：必须先拉 providers，否则左列还列着刚删掉的那一项。
        await refreshProvidersState();
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (err) {
        qaAlert(`删除提供商失败：${err.message}`);
      }
    });
  }

  function renderRight() {
    const p = (state.providers || []).find((x) => x.id === activePid);
    if (!p) { right.innerHTML = '<div class="muted" style="padding:12px;font-size:12px">左侧选中一个提供商后，这里显示它的端点、密钥与模型。</div>'; return; }
    const names = p.modelNames || {};
    right.innerHTML = `
      <div class="field"><label>名称</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="mg-name" value="${esc(p.displayName || '')}" maxlength="40" style="flex:1"
            placeholder="${esc(p.displayName ? (p.baseURL || '') : (p.baseURL || '给这个服务商起个名字'))}" />
          <button class="btn btn-small" id="mg-name-save" type="button" title="保存名称（只改显示名，不影响连接）">保存</button>
          <span id="mg-name-state" style="font-size:11px;align-self:center;white-space:nowrap"></span>
        </div>
        <div class="hint" style="margin-top:4px">只给你自己辨认用，不会发往服务商。改完点「保存」（或按回车）生效。</div></div>
      <div class="field"><label>Base URL</label>
        <input type="text" id="mg-baseurl" value="${esc(p.baseURL || '')}" readonly style="width:100%" />
        <div class="hint" style="margin-top:4px">地址不可就地修改：换地址等于换一个服务商，请删掉旧的重新添加。</div></div>
      <div class="field"><label>API 协议</label>
        <div style="display:flex;gap:8px">
          <select id="mg-protocol" style="flex:1">${qaProtocolSelectHtml(p.apiProtocol || 'openai')}</select>
          <button class="btn btn-small" id="mg-protocol-save" type="button" title="保存协议修改（改完立即对下一次对话生效）">保存</button>
          <span id="mg-protocol-state" style="font-size:11px;align-self:center;white-space:nowrap"></span>
        </div>
        <div class="hint" style="margin-top:4px">默认 OpenAI (Chat Completions)。多数中转站无需改动；直连 Claude / Gemini 官方端点才需要换。拉取模型与连通性测试都会按此协议走。</div></div>
      <div class="field"><label>API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="mg-apikey" value="${esc(p.hasKey ? '******' : '')}" readonly placeholder="${p.hasKey ? '' : '（未保存）'}" style="flex:1" />
          <button class="btn btn-small" id="mg-apikey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="mg-apikey-clear" type="button" title="清除已保存的 API Key">清除密钥</button>
        </div></div>
      <div class="field"><label>模型（${(p.models || []).length} 个）</label>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <button class="btn btn-small" id="mg-fetch-models">拉取模型列表</button>
          <button class="btn btn-small btn-danger" id="mg-del-model">删除模型</button>
        </div>
        <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius)">
          ${(p.models || []).map((m) => {
            const label = names[m] || m;
            return `
            <label class="mm-model">
              <input type="radio" name="mg-model" value="${esc(m)}" />
              <span class="mm-model-text">${esc(label)}</span>
              ${label !== m ? `<span class="muted mm-model-id">${esc(m)}</span>` : ''}
            </label>`;
          }).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型，点「拉取模型列表」。</div>'}
        </div></div>`;

    /* ── 保存名称 ────────────────────────────────────────────────────
       与下方「API 协议保存」同一套形态：输入框 + 保存按钮 + 状态提示。
       ⚠️ 保存后不整页 loadSettings()：弹窗开着时整页重建会把当前节点换掉，
         既有的焦点/滚动位置与后续绑定都会乱（仓库里多处注释踩过这个坑）。
         只做「显式拉 providers → 原地重绘左右列」，页面摘要等下次自然刷新。 */
    const nameInput = right.querySelector('#mg-name');
    const nameSaveBtn = right.querySelector('#mg-name-save');
    const paintNameTip = (text, color) => {
      const tip = right.querySelector('#mg-name-state');
      if (!tip) return;
      tip.textContent = text;
      tip.style.color = color;
      clearTimeout(right.__nameTipTimer);
      if (text) {
        right.__nameTipTimer = setTimeout(() => {
          const t = right.querySelector('#mg-name-state');
          if (t) t.textContent = '';
        }, 2600);
      }
    };
    async function commitName() {
      const want = nameInput.value.trim();
      if (!want) {
        // 空名称后端会拒绝（列表里会出现空白项），这里先说清楚原因，不必绕一趟网络
        paintNameTip('名称不能为空', 'var(--red, #e5484d)');
        nameInput.focus();
        return;
      }
      if (want === String(p.displayName || '')) { paintNameTip('已是当前值', 'var(--muted)'); return; }
      nameSaveBtn.disabled = true;
      const oldText = nameSaveBtn.textContent;
      nameSaveBtn.textContent = '保存中…';
      try {
        const r = await api('/api/providers/display-name', {
          method: 'POST',
          body: JSON.stringify({ providerId: p.id, displayName: want })
        });
        await refreshProvidersState();
        // 原地重绘：左列列表与右列标题都要跟着变；重绘后旧输入框已被替换
        renderLeft();
        renderRight();
        const btn = right.querySelector('#mg-name-save');
        if (btn) { btn.disabled = false; btn.textContent = oldText; }
        const tip = right.querySelector('#mg-name-state');
        if (tip) {
          tip.textContent = '已保存 ✓';
          tip.style.color = 'var(--green)';
          clearTimeout(right.__nameTipTimer);
          right.__nameTipTimer = setTimeout(() => {
            const t = right.querySelector('#mg-name-state');
            if (t) t.textContent = '';
          }, 2600);
        }
        // 页面上的「当前：…」摘要后台对齐（不 await，不挡这次交互）
        loadSettings();
        if (r && r.displayName && r.displayName !== want) {
          // 后端归一化过（理论上不会变），如实告知而不是假装存下了用户的原值
          const tip2 = right.querySelector('#mg-name-state');
          if (tip2) { tip2.textContent = `已保存为 ${r.displayName}`; tip2.style.color = 'var(--muted)'; }
        }
      } catch (e) {
        paintNameTip('保存失败', 'var(--red, #e5484d)');
        if (nameSaveBtn.isConnected) { nameSaveBtn.disabled = false; nameSaveBtn.textContent = oldText; }
        qaAlert(`保存名称失败：${e.message}`);
      }
    }
    nameSaveBtn.addEventListener('click', commitName);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitName(); }
    });

    // Key 显示/隐藏：走 /api/providers/key 取明文（与主页面同款）
    right.querySelector('#mg-apikey-toggle').addEventListener('click', async () => {      const input = right.querySelector('#mg-apikey');
      const btn = right.querySelector('#mg-apikey-toggle');
      const show = input.type === 'password';
      try {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(p.id)}`);
        if (show) {
          input.type = 'text';
          input.value = String(r.apiKey || '（无）');
          btn.textContent = '隐藏';
        } else {
          input.type = 'password';
          input.value = p.hasKey ? '******' : '';
          btn.textContent = '显示';
        }
      } catch (e) {
        qaAlert(`读取密钥失败：${e.message}`);
      }
    });
    // Key 清除
    right.querySelector('#mg-apikey-clear').addEventListener('click', async () => {
      if (!p.hasKey) return;
      // 清除凭据 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: '清除 Key',
        message: `确定清除「${providerLabelOf(p)}」的 API Key？`
      })) return;
      try {
        await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId: p.id, apiKey: '' }) });
        // 同协议保存那个坑：loadSettings() 不等 providers，不先拉一次就会拿旧
        // hasKey 重画右列（"清除了但还显示 ******"）。
        await refreshProvidersState();
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (e) {
        qaAlert(`清除失败：${e.message}`);
      }
    });
    /* ── 保存协议修改 ────────────────────────────────────────────────
       ⚠️ 保存后不要直接 renderRight()：loadSettings() 把 providers 塞在慢路径
       Promise.all 里、压根不等（见 05-memory-settings.js 的函数头注释），它 resolve
       时 state.providers 还是旧的，renderRight() 会把下拉框画回旧协议，用户看到
       的就是"选了、保存了、又变回去了"。
       做法：
         · 保存前先记下想要的值；保存后显式拉一次 providers（不等慢路径）；
         · 正常情况下界面本来就是用户选中的那个值，不再重画右列；
         · 只有后端回读跟想要的不一致（归一化回落等罕见情况）才重画；
         · 给一句「已保存 ✓」的即时反馈，保存成功不能是静默的。
       · 改下拉即保存（change）+ 保留「保存」按钮（同一个提交函数，幂等）。 */
    const protocolSaveBtn = right.querySelector('#mg-protocol-save');
    const protocolSel = right.querySelector('#mg-protocol');
    let protocolBusy = false;
    const paintTip = (text, color) => {
      const tip = right.querySelector('#mg-protocol-state');
      if (!tip) return;
      tip.textContent = text;
      tip.style.color = color;
      clearTimeout(right.__protocolTipTimer);
      if (text) {
        right.__protocolTipTimer = setTimeout(() => {
          const t = right.querySelector('#mg-protocol-state');
          if (t) t.textContent = '';
        }, 2600);
      }
    };
    async function commitProtocol() {
      if (protocolBusy) return;
      const want = protocolSel.value;
      const saved = (state.providers || []).find((x) => x.id === p.id)?.apiProtocol || 'openai';
      if (want === saved) { paintTip('已是当前值', 'var(--muted)'); return; }
      protocolBusy = true;
      protocolSaveBtn.disabled = true;
      const oldText = protocolSaveBtn.textContent;
      protocolSaveBtn.textContent = '保存中…';
      let done = false;
      try {
        await api('/api/providers/protocol', {
          method: 'POST',
          body: JSON.stringify({ providerId: p.id, apiProtocol: want })
        });
        await refreshProvidersState();          // ← 关键：把真实值拉回来再判断
        const now = (state.providers || []).find((x) => x.id === p.id)?.apiProtocol || 'openai';
        if (now !== want) {
          // 后端没按我们给的值存（归一化/回落）→ 重画，让界面显示事实
          renderLeft();
          renderRight();
          paintTip(`已保存为 ${now}`, 'var(--muted)');
        } else {
          paintTip('已保存 ✓', 'var(--green)');
        }
        done = true;
        // state.config 里的 providers 也顺手对齐（后台，不挡这次交互）
        loadSettings();
      } catch (e) {
        paintTip('保存失败', 'var(--red, #e5484d)');
        qaAlert(`保存协议失败：${e.message}`);
      } finally {
        protocolBusy = false;
        // 没被 renderRight 换掉才需要复位（换掉了就是另一个新按钮，别去动旧节点）
        if (protocolSaveBtn.isConnected) {
          protocolSaveBtn.disabled = false;
          protocolSaveBtn.textContent = oldText;
        }
      }
      // 保存期间用户又改了下拉 → 再提交一次，否则界面显示的和存下来的不一致
      if (done && protocolSel.isConnected && protocolSel.value !== want) commitProtocol();
    }
    protocolSaveBtn.addEventListener('click', commitProtocol);
    protocolSel.addEventListener('change', () => { commitProtocol(); });
    // 拉取模型：从该提供商的端点拉（Key 用后端保存的）
    right.querySelector('#mg-fetch-models').addEventListener('click', async () => {
      const btn = right.querySelector('#mg-fetch-models');
      btn.disabled = true;
      btn.textContent = '拉取中…';
      try {
        const r = await api('/api/providers/fetch-models', {
          method: 'POST',
          body: JSON.stringify({ baseUrl: p.baseURL, providerId: p.id, apiProtocol: right.querySelector('#mg-protocol').value })
        });
        // 复用勾选加入弹窗（把新模型并进该提供商）
        openModelAddModal(p.baseURL, '', r.models || [], p.id);
      } catch (e) {
        qaAlert(`拉取失败：${e.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '拉取模型列表';
      }
    });
    // 删除模型：删当前选中的单选模型
    right.querySelector('#mg-del-model').addEventListener('click', async () => {
      const picked = right.querySelector('input[name="mg-model"]:checked');
      if (!picked) { qaAlert('请先在列表里选中一个要删除的模型。'); return; }
      const model = picked.value;
      // 删除模型 → danger:true
      if (!await qaConfirm({
        danger: true,
        confirmText: '删除模型',
        message: `确定从「${providerLabelOf(p)}」删除模型 ${model}？`
      })) return;
      try {
        await api('/api/providers/models', {
          method: 'DELETE',
          body: JSON.stringify({ providerId: p.id, modelId: model })
        });
        // 同协议保存：loadSettings() 不等 providers，不先拉一次的话右列还列着
        // 刚删掉的那个模型，用户再点一次删除反而报"模型不存在"。
        await refreshProvidersState();
        await loadSettings();
        renderLeft();
        renderRight();
      } catch (e) {
        qaAlert(`删除失败：${e.message}`);
      }
    });
  }

  renderLeft();
  renderRight();
  // 静默刷新一次 providers：用户可能在别处刚添加过、state 还没跟上
  //（loadSettings 的慢路径不保证时序），否则会出现"明明有提供商，打开却显示还没有"。
  // 刷新到位后原地重绘；弹窗已关则跳过。
  refreshProvidersState().then(() => {
    if (!overlay.isConnected) return;
    renderLeft();
    renderRight();
  }).catch(() => { /* 内部已兜底；这里只保证链上异常不会变成 unhandledRejection */ });
  overlay.querySelector('#mg-close').addEventListener('click', () => {
    closeModelModal(overlay);
    // 关闭时兜底：目录里已有模型但还没选主模型（比如旧版本添加完没接着选），
    // 自动选定 / 弹选择器，别让用户停在这个半成品状态。
    autoPickMainModelIfNeeded();
  });
}

/**
 * 新手引导「测试并保存」。
 *
 * 未配置模型时，旧路径要把「模型设置 →（空目录 confirm）→ 管理服务商 →
 * 添加提供商 → 拉取 → 勾选 → 添加 →（有时还要再选一次主模型）」走一遍，
 * 5 个入口概念、3 个弹窗。这个函数把整条路压成两个输入框 + 一次点击：
 *
 *   ① fetch-models（带明文 Key，不需要提供商先存在）
 *   ② POST /api/providers 建/更新提供商（勾选全部拉到的模型）
 *   ③ 自动选第一个模型 POST /api/config（provider/model/baseUrl 三件套）
 *   ④ test-chat 试一次连通，结果如实显示
 *
 * 失败不赌气：拉不到列表时保留输入、给出人话原因，并高亮「我有多家服务商 /
 * 手动添加」按钮，openProviderAddModal 支持手填模型 id，覆盖不支持
 * /models 列表的端点。
 */
async function runFirstTimeGuide() {
  const btn = $('#fg-start');
  const out = $('#fg-result');
  const manualBtn = $('#open-model-manage-btn');
  const baseUrl = ($('#fg-baseurl')?.value || '').trim();
  const apiKey = ($('#fg-apikey')?.value || '').trim();
  const say = (t) => { if (out) out.textContent = t; };
  const highlightManual = () => {
    if (!manualBtn) return;
    manualBtn.style.boxShadow = '0 0 0 3px var(--accent)';
    setTimeout(() => { manualBtn.style.boxShadow = ''; }, 2500);
  };
  if (!baseUrl) { qaAlert('请先填写「接口地址（Base URL）」—— 服务商给你的网址，例如 https://api.deepseek.com/v1'); return; }
  if (!apiKey) { qaAlert('请先填写「密钥（API Key）」—— 在服务商网站的密钥管理页创建，sk- 开头的那一串'); return; }
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '正在连接…';
  try {
    say('① 正在向服务商拉取可用模型列表…');
    const fr = await api('/api/providers/fetch-models', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, apiProtocol: 'openai' })
    });
    const models = (fr.models || []).map((m) => ({ id: String(m.id ?? m), name: String(m.name ?? m.id ?? m) }));
    if (!models.length) {
      say('✗ 服务商没有返回任何模型。请确认接口地址和密钥无误；若你用的是不支持模型列表的端点，点右侧「我有多家服务商 / 手动添加」手填模型 id。');
      highlightManual();
      return;
    }
    say(`② 拉取到 ${models.length} 个模型，正在保存…`);
    // 建/更新提供商：全带（新人不需要理解"勾选"），Key 随 providers 一并落盘
    const up = await api('/api/providers', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, models, apiProtocol: 'openai' })
    });
    const pid = up.provider?.id || '';
    // 慢路径时序坑（见 refreshProvidersState）：loadSettings 不保证 providers 已更新
    await refreshProvidersState();
    // 自动选第一个：达到"一次点击全自动"；想换随时进「模型设置」
    const chosen = models[0];
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ api: { provider: pid, model: chosen.id, baseUrl } })
    });
    say(`③ 已保存，正在试聊一次（${chosen.name || chosen.id}）…`);
    try {
      const tr = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model: chosen.id, apiProtocol: 'openai' })
      });
      const res = tr.result || {};
      // 写 state 而不是直接塞 DOM：loadSettings 的慢路径还会再渲染一次
      // （渲染函数读 state.__modelTestNote，换模型后按 model 比对自动失效）
      state.__modelTestNote = res.ok
        ? { ok: true, model: chosen.id, text: `✓ 已连接：${chosen.name || chosen.id} · 测试通过（${res.latencyMs}ms）。不合适？点「⚙ 模型设置」更换。` }
        : { ok: false, model: chosen.id, text: `已保存 ${chosen.name || chosen.id}，但测试没通过：${res.note || '未知错误'}。密钥或地址可能不对，点「⚙ 模型设置」检查。` };
    } catch (e) {
      state.__modelTestNote = { ok: false, model: chosen.id, text: `已保存 ${chosen.name || chosen.id}（连通性测试没跑起来：${e.message}）。` };
    }
    await loadSettings();
  } catch (e) {
    say(`✗ ${e.message || '连接失败'}。请检查接口地址和密钥；确认无误仍不行，点右侧「我有多家服务商 / 手动添加」手填模型 id。`);
    highlightManual();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '测试并保存'; }
  }
}

/** 管理服务商里的「添加提供商」子模态框：名称 + Base URL + Key → 拉取勾选模型 → 添加。 */
function openProviderAddModal(onDone) {
  const overlay = modelModalShell({
    head: '添加提供商',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="field"><label>名称（选填）</label>
        <input type="text" id="pa-name" placeholder="例如：DeepSeek 官方、公司中转" maxlength="40" style="width:100%" />
        <div class="hint" style="margin-top:4px">只给你自己辨认用，之后随时能在「管理服务商」里改。留空则用端点（如 <span id="pa-name-fallback">api.deepseek.com</span>）。</div></div>
      <div class="field"><label>API 协议</label>
        <select id="pa-protocol" style="width:100%">${qaProtocolSelectHtml('openai')}</select>
        <div class="hint" style="margin-top:4px">默认 OpenAI (Chat Completions)，多数中转站对各家模型都提供该兼容协议。此项不总与模型相关联——直连 Claude / Gemini 官方端点时才需要选对应协议，选中会自动填官方地址。Mistral 官方 API 本身就是 OpenAI 兼容格式。</div></div>
      <div class="field"><label>Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="pa-baseurl" placeholder="例如 https://api.deepseek.com/v1" style="flex:1" />
          <button class="btn btn-small" id="pa-fetch" type="button" title="用本弹窗里填的 Base URL + API Key 从端点拉取可用模型列表，勾选后随「添加」一并保存（无需先建提供商）">⟳ 拉取模型</button>
        </div></div>
      <div class="field"><label>API Key</label>
        <input type="password" id="pa-apikey" placeholder="sk-..." autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型 id（可先留空；填好上方两项后点「⟳ 拉取模型」自动勾选）</label>
        <div id="pa-fetched-box"></div>
        <div id="pa-model-rows"></div>
        <button class="btn btn-small" id="pa-add-row" style="margin-top:6px">＋ 添加一行</button></div>`,
    foot: `<button class="btn" id="pa-cancel">取消</button>
           <button class="btn btn-primary" id="pa-confirm">添加</button>`
  });
  let rows = [{ id: '', name: '' }];
  // 「拉取模型」就在本弹窗里：新用户填完 Base URL + Key 就能原地拉列表勾选，
  // 不必"先建提供商 → 去管理服务商 → 再拉取"绕一圈。
  let fetched = []; // [{ id, name, checked }]
  const fetchedBox = overlay.querySelector('#pa-fetched-box');
  function renderFetched() {
    if (!fetched.length) { fetchedBox.innerHTML = ''; return; }
    fetchedBox.innerHTML = `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:6px 8px;margin-bottom:8px;max-height:180px;overflow:auto">
        <div class="muted" style="font-size:12px;margin-bottom:4px">拉取到 ${fetched.length} 个模型（勾选要添加的，也可与手填行并用）：</div>
        ${fetched.map((m, i) => `
          <label style="display:flex;gap:6px;align-items:center;padding:2px 0;font-size:12px;cursor:pointer">
            <input type="checkbox" class="pa-ck" data-i="${i}" ${m.checked ? 'checked' : ''} />
            <span>${esc(m.id)}</span>${m.name && m.name !== m.id ? `<span class="muted">${esc(m.name)}</span>` : ''}
          </label>`).join('')}
        <button class="btn btn-small" id="pa-fetch-toggle" type="button" style="margin-top:4px">全选 / 全不选</button>
      </div>`;
    fetchedBox.querySelectorAll('.pa-ck').forEach((el) => el.addEventListener('change', () => { fetched[Number(el.dataset.i)].checked = el.checked; }));
    fetchedBox.querySelector('#pa-fetch-toggle').addEventListener('click', () => {
      const allOn = fetched.every((m) => m.checked);
      fetched.forEach((m) => { m.checked = !allOn; });
      renderFetched();
    });
  }
  // 选协议时 Base URL 还空着 → 自动填官方默认端点（Anthropic / Gemini 官方地址长、手写易错）
  overlay.querySelector('#pa-protocol').addEventListener('change', () => {
    const proto = overlay.querySelector('#pa-protocol').value;
    const baseInput = overlay.querySelector('#pa-baseurl');
    if (!baseInput.value.trim() && QA_PROTOCOL_DEFAULT_BASES[proto]) {
      baseInput.value = QA_PROTOCOL_DEFAULT_BASES[proto];
      syncNameFallbackHint();
    }
  });
  // 名称留空时最终会用端点兜底 → 提示里实时显示那个端点。
  // 不写出来用户会以为"名称必须填"，或者填完发现列表里的名字不是自己写的。
  // 用 host（含端口）而不是 hostname：两个本地服务同机不同端口时，
  // 提示若都显示 127.0.0.1，用户会以为留空就能区分开。
  function syncNameFallbackHint() {
    const hint = overlay.querySelector('#pa-name-fallback');
    if (!hint) return;
    const base = overlay.querySelector('#pa-baseurl')?.value.trim() || '';
    let host = '';
    try { host = base ? new URL(base).host : ''; } catch { host = ''; }
    hint.textContent = host || '该地址的端点';
  }
  overlay.querySelector('#pa-baseurl').addEventListener('input', syncNameFallbackHint);
  overlay.querySelector('#pa-fetch').addEventListener('click', async () => {
    const btn = overlay.querySelector('#pa-fetch');
    const baseUrl = overlay.querySelector('#pa-baseurl').value.trim();
    const apiKey = overlay.querySelector('#pa-apikey').value.trim();
    const apiProtocol = overlay.querySelector('#pa-protocol').value;
    if (!baseUrl) { qaAlert('请先填写 Base URL，再拉取模型列表'); return; }
    if (!apiKey) { qaAlert('请先填写 API Key（拉取模型列表需要密钥鉴权）'); return; }
    btn.disabled = true;
    btn.textContent = '拉取中…';
    try {
      // Key 口径：本弹窗是"新建"场景、提供商还不存在 → 显式带明文 Key
      // （后端 fetch-models 的 Key 解析顺序就是 显式明文 > providerId 已存 > 顶层）。
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, apiProtocol })
      });
      if (!(r.models || []).length) {
        qaAlert('端点没有返回任何模型。\n请检查 Base URL / API Key 是否正确。');
        return;
      }
      fetched = (r.models || []).map((m) => ({ id: String(m.id || m), name: String(m.name || m.id || m), checked: true }));
      renderFetched();
    } catch (e) {
      qaAlert(`拉取失败：${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 拉取模型';
    }
  });
  const rowsBox = overlay.querySelector('#pa-model-rows');
  function renderRows() {
    rowsBox.innerHTML = `
      <table class="model-rows-table">
        ${rows.map((row, i) => `
          <tr>
            <td><input type="text" class="pa-mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="pa-mr-name" data-i="${i}" placeholder="显示名（可选）" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger pa-mr-del" data-i="${i}" ${rows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    rowsBox.querySelectorAll('.pa-mr-id').forEach((el) => el.addEventListener('input', () => { rows[Number(el.dataset.i)].id = el.value; }));
    rowsBox.querySelectorAll('.pa-mr-name').forEach((el) => el.addEventListener('input', () => { rows[Number(el.dataset.i)].name = el.value; }));
    rowsBox.querySelectorAll('.pa-mr-del').forEach((el) => el.addEventListener('click', () => {
      if (rows.length <= 1) return;
      rows.splice(Number(el.dataset.i), 1);
      renderRows();
    }));
  }
  renderRows();
  overlay.querySelector('#pa-add-row').addEventListener('click', () => { rows.push({ id: '', name: '' }); renderRows(); });
  overlay.querySelector('#pa-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#pa-confirm').addEventListener('click', async () => {
    const baseUrl = overlay.querySelector('#pa-baseurl').value.trim();
    const apiKey = overlay.querySelector('#pa-apikey').value.trim();
    const apiProtocol = overlay.querySelector('#pa-protocol').value;
    const displayName = overlay.querySelector('#pa-name').value.trim();
    // 勾选的拉取模型在前、手填行在后，按 id 去重（重复手填同一 id 不产生两份）
    const seen = new Set();
    const models = [
      ...fetched.filter((m) => m.checked).map((m) => ({ id: m.id, name: m.name || m.id })),
      ...rows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id)
    ].filter((m) => !seen.has(m.id) && seen.add(m.id));
    if (!baseUrl) { qaAlert('请填写 Base URL'); return; }
    if (!apiKey) { qaAlert('请填写 API Key（提供商必须带密钥才能测试连通性）'); return; }
    // ⚠️ 这里曾经强制要求至少填一个模型 id，与上面标签写的「可先留空」自相矛盾，
    //    更致命的是它构成了死循环：「拉取模型列表」按钮只在**已存在的提供商**里，
    //    于是新用户没有模型 id 就建不了提供商 → 永远点不到拉取按钮。
    //    后端 upsertProvider 的 models 默认就是 []，允许空目录没有任何问题，
    //    改为放行，并在添加成功后直接把用户送到「拉取模型列表」。
    try {
      await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models, apiProtocol, displayName }) });
      // 先显式刷新 providers：loadSettings 的慢路径不保证时序，不刷新的话
      // 下面的 onDone（左栏渲染）和自动选模型都会读到旧空数组（见 refreshProvidersState）。
      await refreshProvidersState();
      closeModelModal(overlay);
      // ⚠️ 必须**先等 loadSettings 完成**再回调 onDone：onDone 是管理服务商的
      //    renderLeft/renderRight，它们读的是 state.providers。旧写法把
      //    loadSettings() 放在 onDone() 之后（且都没 await），回调渲染时
      //    state.providers 还是空数组，表现为"添加成功了，但左列看不到它、
      //    右列也没有「拉取模型列表」按钮"，用户以为没添加成功。
      await loadSettings();
      if (onDone) onDone();
      // 一个模型都没带（既没勾拉取的、也没手填）才送去「管理服务商」补拉；
      // 现在拉取入口就在本弹窗里，多数添加会直接带着勾选的模型落地。
      if (!models.length) { scheduleOpenModelManage(); return; }
      // 把"还要再选一次主模型"这一步收掉：单个模型直接选定，多个模型弹选择器
      // （见 autoPickMainModelIfNeeded 的注释）。
      await autoPickMainModelIfNeeded();
    } catch (e) {
      qaAlert(`添加失败：${e.message}`);
    }
  });
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  // ⚠️ 结果条 #pick-result 与目标输入框 #cfg-allowgroups / #cfg-allowprivate 都
  //    只存在于白名单分区的 HTML 里（renderSettings 只重建 state.settingsSection
  //    那一段）。弹窗开着时只要发生一次整页重建（切分区 / 自动保存返回后的补渲染 /
  //    loadSettings 回来重绘），这两个节点就从 DOM 里消失了。
  //    所以：① 状态提示一律走 setHintText（查不到就跳过，绝不抛）；
  //         ② 目标输入框在点击那一刻重新判活，写不进去就明确告诉用户，不静默吞。
  const allowSel = isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate';
  const setResult = (text) => setHintText('#pick-result', text);
  setResult('拉取中…');
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    setResult(`拉取失败：${e.message}（OneBot 未连接？）`);
    return;
  }
  if (!list?.length) {
    setResult(isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表');
    return;
  }
  const inputEl = $(allowSel);
  // 输入框都不在（用户已经切走了）→ 弹窗没有意义，说清楚，别再白拉一遍。
  if (!inputEl) {
    qaAlert(`设置页已切走，「${isGroups ? '允许的群号' : '允许的 QQ'}」输入框不在当前页面。\n请回到「白名单」页签后再点一次。`);
    return;
  }
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="选择${isGroups ? '群' : '好友'}">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input class="sw" type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // 手搓遮罩也要纳入焦点陷阱：自动登记只认 .model-modal-overlay，
  // 这个弹窗用的是 .modal-overlay，不登记的话 Tab 能跑出弹窗到背后的设置页。
  registerFocusTrap(overlay);
  const previousFocus = document.activeElement;
  __focusablesIn(overlay)[0]?.focus({ preventScroll: true });
  const closePicker = () => {
    document.removeEventListener('keydown', onPickerEsc, true);
    unregisterFocusTrap(overlay);
    overlay.parentNode?.removeChild(overlay);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  };
  const onPickerEsc = (e) => {
    if (e.key !== 'Escape' || __topModalOverlay() !== overlay) return;
    e.preventDefault(); e.stopPropagation(); closePicker();
  };
  document.addEventListener('keydown', onPickerEsc, true);
  $('#pick-cancel', overlay).addEventListener('click', () => closePicker());
  $('#pick-apply', overlay).addEventListener('click', async () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    // 全不选 + 确定 = 把白名单清空。配合「白名单留空时允许所有会话」默认关闭的语义
    // （isChatAllowed：allow 空且不开 allowAllWhenEmpty → 一律不放行），
    // 这会让机器人对所有会话停止响应，所以必须确认。
    if (!picked.length && selected.size > 0) {
      const ok = await qaConfirm({
        danger: true,
        confirmText: '清空白名单',
        message: `你取消了全部勾选 —— 确定要清空「${isGroups ? '允许的群号' : '允许的 QQ'}」吗？\n\n`
          + '清空后：若「白名单留空时允许所有会话」未开启（默认关闭），机器人将不再响应任何会话。'
      });
      if (!ok) return;
    }
    // 目标输入框判活：整页重建后 inputEl 是**离线节点**，往里写值等于什么都没发生
    // （用户以为已保存、实际配置没变）。所以优先用现查到的活节点，都没有就明说。
    const target = (inputEl && inputEl.isConnected) ? inputEl : $(allowSel);
    if (!target || !target.isConnected) {
      closePicker();
      qaAlert(`设置页已切走，「${isGroups ? '允许的群号' : '允许的 QQ'}」输入框不在当前页面。\n请回到「白名单」页签后再点一次「选择群 / 选择好友」。`);
      return;
    }
    target.value = picked.join(',');
    // ⚠️ 程序化赋值不会触发 input 事件，而表单自动保存靠 #settings-form 的 input
    //    委托启动，不派发的话用户点完「确定」其实什么都没保存。
    target.dispatchEvent(new Event('input', { bubbles: true }));
    setResult(`已选 ${picked.length} 个${isGroups ? '群' : '好友'}（已自动保存）`);
    closePicker();
  });
}

// 拆分逗号/空白分隔的列表，并统一剥掉 `group:` / `private:` 前缀落成裸号
// （与后端权威格式一致，src/store.js allowed() 直接 includes(String(id))）。
// 必须归一化：openWhitelistPicker 用 g.id（裸号）比对勾选态，而输入框里的存量
// 脏值可能是 group:xxx；不剥前缀就会「勾不上已加白名单的群，点确定把老项丢掉」。
function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).map(bareAllowId);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  /**
   * 读数值输入框。
   * ⚠️ 不要写成 `Number(val(...)) || fallback`：`||` 会把合法的 0 当成"空值"
   *    回落到 fallback。概率这一项明确允许 0（表示"从不主动发起话题"），
   *    填 0 会被静默存成 0.25，界面显示一个值、后端存另一个值。
   *    正确做法：先判"框是否存在 + 是否可解析为有限数"，再判范围。
   * @param {string} sel 选择器
   * @param {number} fallback 框不存在或值非法时的回落值
   * @param {{min?:number,max?:number}} [range] 可选钳位范围（含端点）
   */
  const num = (sel, fallback, range) => {
    const node = el(sel);
    if (!node) return fallback;
    const raw = String(node.value ?? '').trim();
    if (raw === '') return fallback;              // 空串 = 用户没填 → 用原值
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;     // 非数字 → 用原值
    if (range) {
      let v = n;
      if (typeof range.min === 'number') v = Math.max(range.min, v);
      if (typeof range.max === 'number') v = Math.min(range.max, v);
      // 钳位结果写回输入框：界面显示用户原值、后端存钳位值会长期不一致且无提示。
      if (v !== n) node.value = String(v);
      return v;
    }
    return n;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  // ⚠️ 分区已合并：收集条件必须同时认「宿主 id」和「被并掉的旧 id」，
  //    否则合并页里另一半表单不会被保存（静默丢配置）。
  //    val()/chk() 都是 null 安全的，多跑一个分支不会误写。
  if (sec === 'persona' || sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      // UI 声明了 min=1800000，保存必须钳位，否则录 1 就存 1 毫秒。
      consolidateMinIntervalMs: num('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000, { min: 600000 }) || 21600000
    };
  }

  if (sec === 'api' || sec === 'search') {
    patch.api = {
      ...(c.api || {}),
      // 思考强度/温度/最大工具轮数在「信息发送配置」模态框（openSendConfigModal，
      // 保存时直接 POST api patch）。此处不收集这三个字段：deepMerge 不写就保留
      // 服务端旧值，模态框保存过的值不会被这里覆盖。
      visionModel: val('#cfg-vision-model', c.api.visionModel || '').trim(),
      videoModel: val('#cfg-video-model', c.api.videoModel || '').trim(),
      videoMode: (() => {
        const v = val('#cfg-video-mode', c.api.videoMode || 'auto');
        return ['auto', 'native', 'frames', 'off'].includes(v) ? v : 'auto';
      })(),
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0,
      // 模型身份三件套：正常路径由模型目录选择器直接 POST（openModelPicker），
      // 这里把隐藏字段 / 只读框的当前值一并带上，保证"选完模型又在
      // 本区块改了单价"的合并保存不会把 model/provider/baseUrl 丢掉。
      // （deepMerge 下不写就保留服务端旧值，写了就与隐藏字段一致，两个方向都安全。）
      model: val('#cfg-model', c.api.model || '').trim(),
      provider: val('#cfg-provider', c.api.provider || '').trim(),
      baseUrl: val('#cfg-baseurl-value', c.api.baseUrl || '').trim(),
      // 备选模型列表：从 DOM 实时读取（fallbackRows 是 bindSettingsEvents 的局部变量，
      // 顶层 saveConfig 访问不到，所以这里直接查 DOM），过滤掉空行。
      // 提供商列已删：model 输入框显示"提供商名 · 模型id"，但存的是纯 id +
      // 提供商由 fallbackRows 内部维护，显示格式不能进配置。
      // 改为从显示值反解太脆（模型 id 本身可含 ·），所以这里读 data-* 属性
      // （renderFallbackRows 渲染时把真值放在 data-model / data-provider 上）。
      fallbackModels: $$('#fallback-model-rows .fb-model-pick').map((el) => ({
        model: String(el.dataset.model || '').trim(),
        provider: String(el.dataset.provider || '').trim()
      })).filter((r) => r.model)
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入，那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const caRaw = String(val('#cfg-price-cached', '')).trim();
        // 必须区分"空框"（未填）与合法的 0（缓存命中免费）。
        // `|| 0` + `cached: ca || i` 会把 0 回退成输入价，成本核算偏高。
        const ca = caRaw === '' ? null : (Number(caRaw) || 0);
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca ?? i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：Key 只在「管理服务商」里维护（走 providers/set-key），
    // 设置页表单没有 #cfg-apikey，也没有任何隐藏 Key 字段需要带出。
  }

  if (sec === 'api' || sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...(c.webSearch || {}),
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务：列表由「添加/删除」按钮维护（POST /api/search-providers），
      // 但**当前选中那家的 Key 编辑框**在这里随表单提交，用户改 Key 的主路径
      // 就是这个框。按 id 定位条目原地更新；掩码/留空 = 不动，明文 = 覆盖。
      providers: (c.webSearch?.providers || []).map((p) => {
        const sel = val('#cfg-searchprovider', '');
        if (sel !== `custom:${p.id}`) return p;
        const entered = val('#cfg-custom-sp-key', '').trim();
        if (entered && entered !== '******') return { ...p, apiKey: entered };
        return p;
      }),
      // 自定义服务 Key 的「清除」不走表单（专用按钮直接 POST），这里不处理空串。
    };
  }

  if (sec === 'persona' || sec === 'memory') {
    // ⚠️ 人设编辑器在弹窗里（#gp-* / #pcp-*），页面上的 #cfg-botname /
    //    #cfg-roletext 等输入框已全部移除。元素不在场时用 state.config 的旧值
    //    整段回传，会在 state.config 尚未跟上弹窗保存结果的那段时间里把刚切换的
    //    人设静默还原（表现为"保存成功了一切页签又变回旧人设"）。
    //    所以元素不在场就不写该键，deepMerge 自然保留服务端现值。
    const personaPatch = {};
    const botNameEl = $('#cfg-botname');
    if (botNameEl) personaPatch.botName = botNameEl.value.trim() || '小鲸鱼';
    const selfNickEl = $('#cfg-selfnick');
    if (selfNickEl) personaPatch.selfNickname = selfNickEl.value.trim();
    const participationEl = $('#cfg-participation');
    if (participationEl) personaPatch.participation = participationEl.value;
    const roleTextEl = $('#cfg-roletext');
    if (roleTextEl) personaPatch.roleText = roleTextEl.value;
    const rulesEl = $('#cfg-customrules');
    if (rulesEl) personaPatch.customRules = rulesEl.value;
    const sysPromptEl = $('#cfg-sysprompt');
    if (sysPromptEl) personaPatch.systemPromptOverride = sysPromptEl.value;
    if (Object.keys(personaPatch).length) patch.persona = personaPatch;
    // 统一人设开关：编辑器随开关二选一在场，读不到的保持旧值。
    patch.personaUnified = chk('#cfg-persona-unified', c.personaUnified !== false);
    // personaByChat 不在这里收集：独立人设模态框直接 POST 落盘（openPerChatPersonaModal
    // 的 saveToMap）。再 POST 一遍（可能过期的）隐藏 JSON 会把 modal 刚存的条目用旧值覆盖。
    // ⚠️ 统一开关"关闭"时 personaByChat 里的条目仍然生效（personaForChat 逐会话合并），
    //    开关只控制 UI 形态。
  }

  if (sec === 'allow' || sec === 'chat') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    // ⚠️ 不要写 patch.deny：deepMerge 对数组是整体替换，无条件写
    //    { groups: [], private: [] } 会让「聊天」分区任何一次保存都清空用户的
    //    会话级黑名单，而全项目没有 deny 编辑入口，改完即丢。
    //    将来补了 deny 编辑 UI 再在这里按 section 收集。
    // allowAllWhenEmpty 必须读复选框：硬编码值会在每次保存时重置用户的开关。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
  }

  if (sec === 'allow' || sec === 'chat') {
    // 运行节奏/发送保护/档位/峰谷/禁言/温度/思考强度在「信息发送配置」与「活跃设置」
    // 两个模态框里（openSendConfigModal / openActiveConfigModal），各自保存时直接 POST。
    // 本区块剩下的表单控件只有主动话题（表情包设置在 plugins/sticker 插件卡的设置弹窗）。
    patch.proactive = {
      ...(c.proactive || {}),
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      // 间隔：0ms 无意义 → 钳到 ≥1000，回落原值/默认（沿用旧的 `|| 默认` 语义）
      checkIntervalMinMs: num('#cfg-pro-min', c.proactive?.checkIntervalMinMs ?? 1800000, { min: 1000 }) || 1800000,
      checkIntervalMaxMs: num('#cfg-pro-max', c.proactive?.checkIntervalMaxMs ?? 5400000, { min: 1000 }) || 5400000,
      // ⚠️ 概率允许 0（= 从不主动发起）→ 必须走 num()，不能用 `|| 0.25`
      probability: num('#cfg-pro-prob', c.proactive?.probability ?? 0.25, { min: 0, max: 1 })
    };
  }

  // 'app'（界面与应用）与 'desktop'/'onebot'（兼容别名）共享同一批字段读取；
  // val()/chk() 均为 null 安全，当前页不存在的输入框回退到 c 里的原值，不会误写。
  if (sec === 'desktop' || sec === 'onebot' || sec === 'app') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000,
      // 外观个性化：颜色只接受合法 hex（手填一半如 "#5b8" 时不写，避免整条 CSS
      // 声明失效）；背景图由原生对话框选好后即时落盘，这里只原样保留。
      accent: isHexColor(val('#cfg-accent-hex', c.ui?.accent ?? '')) ? val('#cfg-accent-hex', '').trim() : '',
      bgColor: isHexColor(val('#cfg-bgcolor-hex', c.ui?.bgColor ?? '')) ? val('#cfg-bgcolor-hex', '').trim() : '',
      frameAlpha: clampInt(val('#cfg-framealpha', c.ui?.frameAlpha ?? 100), 30, 100, 100),
      bgImage: String(c.ui?.bgImage || ''),
      bgFit: val('#cfg-bgfit', c.ui?.bgFit || 'cover'),
      bgDim: clampInt(val('#cfg-bgdim', c.ui?.bgDim ?? 0), 0, 85, 0),
      winOpacity: clampInt(val('#cfg-winopacity', c.ui?.winOpacity ?? 100), 30, 100, 100)
    };
    // 不写 memberNotes：它有自己的编辑入口（记忆页的备注），不该由界面设置的表单
    // 保存捎带。deepMerge 下不写这个键 = 保留服务端现值。
    // ── 桌面悬浮小窗 ──
    // 只收集设置项；位置/尺寸在主进程侧落 window-state.json，不经过这里。
    // enabled 关着时其余项照常收集（下次打开即生效），UI 上整组只是置灰。
    const widgetSize = val('#cfg-widget-size', c.widget?.size || 'm');
    patch.widget = {
      ...(c.widget || {}),
      enabled: chk('#cfg-widget-enabled', c.widget?.enabled !== false),
      alwaysOnTop: chk('#cfg-widget-top', c.widget?.alwaysOnTop !== false),
      clickThrough: chk('#cfg-widget-click', !!c.widget?.clickThrough),
      edgeHide: chk('#cfg-widget-edgehide', c.widget?.edgeHide !== false),
      opacity: num('#cfg-widget-opacity', c.widget?.opacity ?? 50, { min: 30, max: 100 }) || 50,
      transparent: chk('#cfg-widget-transparent', c.widget?.transparent !== false),
      size: ['s', 'm', 'l'].includes(widgetSize) ? widgetSize : 'm',
      refreshMs: num('#cfg-widget-refresh', c.widget?.refreshMs ?? 2500, { min: 1000, max: 60000 }) || 2500
    };
  }

  if (sec === 'desktop' || sec === 'onebot' || sec === 'app') {
    // ⚠️ 令牌是脱敏回传的（值是 ******，真实值只在后端）：
    //    留空 / ****** = 保持原值；只有输入了新明文才更新。
    //    直接把输入框的值写进 patch 的话，"保存一次别的设置，令牌就被清空"。
    const enteredWsToken = val('#cfg-obtoken', '').trim();
    const enteredHttpToken = val('#cfg-obhttptoken', '').trim();
    // protocol 只剩端点与令牌：协议端由用户自己装、自己启动。
    patch.protocol = {
      wsUrl: val('#cfg-wsurl', c.protocol?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.protocol?.httpUrl || '').trim(),
      ...(enteredWsToken && enteredWsToken !== '******' ? { accessToken: enteredWsToken } : {}),
      ...(enteredHttpToken && enteredHttpToken !== '******' ? { httpAccessToken: enteredHttpToken } : {})
    };
  }

  if (sec === 'tools') {
    // 工具配置直接从 state.config.tools 读取（事件绑定已实时更新）
    const t = state.config.tools || { enabled: true, overrides: {}, categories: {} };
    // ⚠️ overrides / categories 是映射型字段，deepMerge 对对象是递归合键，传 {}
    //    删不掉旧键（「全部启用」「恢复默认」点了不生效、刷新后又变回关闭）。
    //    内存里这两份映射始终是全量，用 __replace__ 整体替换。
    patch.tools = {
      ...t,
      overrides: { __replace__: t.overrides || {} },
      categories: { __replace__: t.categories || {} }
    };
  }

  if (sec === 'media') {
    // ffmpeg 设置：只收集这三项；「下载/删除/测试」是即时动作，
    // 各自直接 POST 专用端点，不经过表单保存链。
    //
    // ⚠️ Token 是脱敏回传的（值是 ******，真实值只在后端）：
    //    留空 / ****** = 保持原值；只有输入了新明文才更新。与 protocol.accessToken 同款。
    const enteredGhToken = val('#cfg-ffmpeg-ghtoken', '').trim();
    const mirrorRaw = document.querySelector('input[name="cfg-ffmpeg-mirror"]:checked')?.value || 'yylx';
    // ⚠️ 白名单必须与 src/ffmpeg-setup.js 的 MIRRORS 键一致：漏一个就会把用户
    //    选的源静默改回默认，表现为"换了镜像还是走原来那个"。
    const mirror = ['yylx', 'gh-proxy', 'direct', 'custom'].includes(mirrorRaw) ? mirrorRaw : 'yylx';
    // 优先使用哪一组 ffmpeg：'' = 自动。白名单与 ffmpeg-resolve.js 的 FFMPEG_SOURCES 一致。
    const sourceRaw = document.querySelector('input[name="cfg-ffmpeg-source"]:checked')?.value || '';
    const ffmpegSource = ['', 'manual', 'managed', 'system'].includes(sourceRaw) ? sourceRaw : '';
    patch.media = {
      ...(c.media || {}),
      ffmpegPath: val('#cfg-ffmpeg-path', c.media?.ffmpegPath || '').trim(),
      ffmpegSource,
      downloadMirror: mirror,
      customMirror: val('#cfg-ffmpeg-mirror-custom', c.media?.customMirror || '').trim(),
      ...(enteredGhToken && enteredGhToken !== '******' ? { githubAccessToken: enteredGhToken } : {})
    };
  }

  // ── POST 之前的最后防线：去掉"空 patch"造成的无谓请求 ──
  // 变动监听挂在整个 #settings-form 上，点击 readonly 输入框、拖动滑条
  // 等不产生真实改动的操作也会触发一次保存。空 patch（没有任何顶层键）
  // 直接跳过，它不会破坏数据，但每次都会让后端全量落盘 + 广播 status。
  if (Object.keys(patch).length === 0) {
    return { ok: true, config: state.config };
  }

  // keepalive：页面卸载（关窗/刷新）后请求仍能完成，beforeunload 的兜底 flush
  // 依赖这一点，普通 fetch 会随页面一起被中止。
  // ⚠️ keepalive 有 64KB body 上限，超限时 fetch 直接抛 "Failed to fetch"。
  //    关键词表/模型列表/工具 overrides 可能超，所以按体积自适应，大 body 退回普通 fetch。
  const bodyStr = JSON.stringify(patch);
  const useKeepalive = bodyStr.length < 60_000;
  // 必须带请求级超时：/api/config 是同步写盘端点，磁盘 IO 或 socket 卡住时
  // 没有 AbortSignal.timeout，doSave 的 saving 标志永不复位，后续保存只会重排队丢弃，
  // 界面无任何错误提示（表现为"改了没反应、重启又变回去"）。
  // 超时后走失败分支（提示 + 3s 重试）。
  const data = await api('/api/config', {
    method: 'POST', body: bodyStr, timeoutMs: 20000,
    ...(useKeepalive ? { keepalive: true } : {})
  });
  state.config = data.config;
  // 连接分区的地址 / 令牌改完要立刻生效：OneBotClient 构造时快照了端点，
  // 只落配置不重连等于"改了没用"。这里补一次 apply（与「连接」页的「保存并重连」
  // 同一条后端接口）；失败不影响保存本身，连接页的状态会如实反映。
  if (sec === 'onebot' && patch.protocol) {
    try {
      const wsTok = val('#cfg-obtoken', '').trim();
      const httpTok = val('#cfg-obhttptoken', '').trim();
      await api('/api/protocol/apply', {
        method: 'POST',
        body: JSON.stringify({
          wsUrl: patch.protocol.wsUrl,
          httpUrl: patch.protocol.httpUrl,
          accessToken: wsTok,
          httpAccessToken: httpTok
        })
      });
    } catch { /* 保存已成功；重连失败由连接页兜住 */ }
  }
  if (!quiet) setHintText('#model-label', `模型：${state.config.api.model || '未设置'}`);
  return data;
}

/* 装载焦点陷阱：本脚本以 defer 加载，执行时 body 已解析完，直接装即可。
   装好后由 MutationObserver 自动登记后续所有 .model-modal-overlay，
   无需每个创建方显式登记。 */
try { installModalFocusTrap(); } catch { /* 环境不支持则退化为无陷阱 */ }
