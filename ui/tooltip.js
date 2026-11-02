/**
 * 自定义气泡提示 —— 全局接管 [title] 与 [data-tip]。
 *
 * 为什么要存在这个文件：
 *   应用窗口是 transparent + 无边框（electron/main.js）。Windows 的原生 tooltip
 *   是一个独立的系统小窗口，叠在透明窗口上会渲染成一坨淡黄色矩形
 *   （#FFFFE1 是 Windows 经典提示底色），提示文字根本看不见，关闭后偶尔还留残影。
 *   所以不能让任何原生 tooltip 出现 —— 把 title 收进 data-title，自己画气泡。
 *
 * 工作方式（全部事件委托，不需要各处改动）：
 *   · mouseover 命中带 title/data-tip 的元素 → 把 title 收进 data-title（原生提示
 *     从此没有触发条件），450ms 后弹出气泡；
 *   · mouseout → 立刻收气泡；
 *   · focusin/focusout 同样处理，键盘用户也能看到；
 *   · mousedown / wheel / scroll / resize 时只收气泡。
 *
 * ⚠️ 两个必须一起做的动作，少一个就会"悬停出两个窗口"：
 *
 *   ① **连祖先链一起收**。原生 tooltip 的规则是「元素自身没有 title 就向上找最近
 *      的祖先 title」。只收自己那一个，等于把提示让给了外层元素 —— 自定义气泡和
 *      原生黄条同时出现。应用里真实存在这种嵌套：
 *        · index.html  #readiness-dots(title) > .rdot-item(title) × 4   ← 顶栏就绪圆点
 *        · 06-settings-render.js  .mcard(title) > .mcard-grip(title) / .mcard-sw(title)
 *
 *   ② **写回来也要收**。01-boot.js 的 updateReadinessDots 每轮状态轮询都执行
 *      `item.title = d.title`，07-settings-events.js / desktop.js 也会随时改写。
 *      只在 mouseover 摘一次挡不住：写回来约 1 秒后原生黄条照样弹出，和已经显示的
 *      气泡凑成两个窗口。所以用 MutationObserver 盯着 title 属性的任何写入，一律
 *      立刻收进 data-title —— 从根上保证应用内不再出现原生提示。
 *
 * 图表圆点原来用的是 SVG <title> 子元素（同样会触发原生提示），已改为 data-tip 属性，
 * 这里一并接管。
 */
(() => {
  const DELAY = 450;          // 悬停多久才弹（和原生手感接近）
  const GAP = 8;              // 气泡与目标的间距
  const MARKS = ['data-tip', 'title', 'data-title'];

  let tipEl = null;           // 气泡 DOM（懒创建）
  let curTarget = null;       // 当前命中的元素
  let timer = 0;

  const findTarget = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      // data-tip 优先（图表圆点），其次原生 title。
      // data-title 也要认：title 已经被收进来了，指针在同一元素内部移动时得能
      // 重新认出它，否则会被误判成"离开了元素"而收掉气泡。
      if (n.hasAttribute && MARKS.some((a) => n.hasAttribute(a))) return n;
    }
    return null;
  };

  const textOf = (el) => el.getAttribute('data-tip') || el.getAttribute('data-title') || '';

  /** 把 title 收进 data-title。原生提示失去触发条件，气泡改用 data-title 显示。
   *  title 也是无障碍名称的来源之一，纯图标按钮被收走时补一个 aria-label。 */
  const absorb = (el) => {
    const t = el.getAttribute('title');
    if (t == null) return el;
    el.setAttribute('data-title', t);
    el.removeAttribute('title');
    const iconBtn = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
    if (iconBtn && !el.hasAttribute('aria-label') && !(el.textContent || '').trim()) {
      el.setAttribute('aria-label', t);
    }
    return el;
  };

  /** 自身 + 整条祖先链一起收 —— 见文件头 ⚠️① */
  const absorbChain = (el) => {
    absorb(el);
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.hasAttribute('title')) absorb(n);
    }
  };

  const hideBubble = () => {
    clearTimeout(timer);
    if (tipEl) tipEl.classList.remove('on');
  };

  const show = (target) => {
    // 文字在"弹出来的这一刻"读，不在排程时读：状态轮询可能在这 450ms 里改了
    // data-title（就绪圆点从「未运行」变「运行中」），读早了会显示过期文案。
    const text = textOf(target);
    if (!text) return;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'app-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.classList.add('on');

    // 定位：优先放目标下方水平居中，放不下就翻到上面，左右夹到视口内
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.bottom + GAP;
    if (y + th > vh - 6) y = r.top - th - GAP;           // 下方放不下 → 上方
    if (y < 6) y = Math.max(6, vh - th - 6);
    x = Math.min(Math.max(6, x), vw - tw - 6);
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
  };

  const schedule = (target) => {
    clearTimeout(timer);
    timer = setTimeout(() => show(target), DELAY);
  };

  /** 命中一个新目标：先把整条链上的 title 收掉，再决定弹不弹 */
  const engage = (t) => {
    if (!t || t === curTarget) return;
    curTarget = t;
    absorbChain(t);
    if (textOf(t)) schedule(t);
    else hideBubble();
  };

  const onOver = (e) => engage(findTarget(e.target));

  const onOut = (e) => {
    const t = findTarget(e.target);
    if (t && t === findTarget(e.relatedTarget)) return; // 只是在元素内部移动
    hideBubble();
    curTarget = null;
  };

  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', (e) => engage(findTarget(e.target)), true);
  document.addEventListener('focusout', () => { hideBubble(); curTarget = null; }, true);
  // 点击 / 滚轮 / 滚动 / 缩放：只收气泡
  document.addEventListener('mousedown', hideBubble, true);
  window.addEventListener('wheel', hideBubble, { passive: true });
  window.addEventListener('resize', hideBubble);
  document.addEventListener('scroll', hideBubble, true);

  /** 见文件头 ⚠️②：任何时刻被写上的 title 都立刻收走。
   *  我们自己 removeAttribute('title') 也会触发一条记录，但那条记录读 hasAttribute
   *  已经是 false，直接跳过 —— 不会自激。 */
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target;
      if (el && el.nodeType === 1 && el.hasAttribute('title')) absorb(el);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['title'],
  });
})();
