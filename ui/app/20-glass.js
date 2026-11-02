// 全界面透明（玻璃层）—— 新版 v0.4.8.9 移植版。
//
// 背景：新版自带「底色不透明度」（--frame-bg，只管窗口最底下那一层），
// 但面板、卡片、输入框、弹窗、吸顶表头、顶栏都是实色，
// 所以底色再透，壁纸也进不到面板里。这个文件把「一条滑条管全部界面」补上。
//
// ⚠️⚠️ 只改 --layer-* 是**不够的**（2026-10-23 用户实测：设置页的卡片全是实心）。
//   本工程最底层的三个面令牌是 --card / --card-hi / --field-bg，
//   而 --layer-1 / --layer-2 只是它们的**别名**（`--layer-1: var(--card)`）。
//   全站 52 处直接写 `background: var(--card)`（.health-card / .settings-sidebar /
//   .list-head / .usage-card …），改别名根本管不到它们 —— 必须连同最原始的那几个
//   令牌一起改写。
//
// 做法：**只改主题变量，不逐个元素点名**。
//   1. 先把自己这张样式表临时关掉，读主题的**原始**色值
//      （不关的话读到的是自己上一次 color-mix 的结果，会越算越淡）；
//      ⚠️ 读的必须是 --card / --card-hi / --field-bg 这些**字面色值**，
//      不能读 --layer-1 / --layer-2 —— 那是别名，读出来是别名本身，
//      再包一层 color-mix 就等于拿"被自己改过的变量"当原色算。
//   2. 用原色重写一组 !important 规则：
//        --card := color-mix(in srgb, <原色> var(--we-glass), transparent)
//      （--layer-* 同步重写，让走别名的旧选择器也一起透）
//   3. 之后只改 :root 上的几条 --we-glass*，整界面（含以后新加的页面、
//      重渲染出来的节点）一次样式重算就一起变。
//
// 一条滑条（config.ui.panelAlpha）驱动一整组档位，保住原来的明暗层次
// （越"浮"越实，字才压得住壁纸）：
//   凹槽 soft < 面板 glass = 顶栏 top < 卡片 card < 吸顶 sticky < 浮层 strong
// ⚠️ 顶栏 top 档曾经是 +34（比面板还实两倍），结果整条顶栏像一块实心蓝板、
//   壁纸在那里等于没有（用户实测反馈）。顶栏也是"界面的一部分"，要跟面板同档：
//   top = 0 → 顶栏就是你拉的那条滑条本身。100% 时仍是原样式，无回归。
// 100% = 逐字等于原样式。
//
// 本文件是普通脚本（和 00~19 段一样，无 import/export），按 index.html 的
// defer 顺序排在最后：此时 00-core 的 applyUiCustom 已定义完，这里包一层即可。
(function () {
  'use strict';

  const clampInt = (v, min, max, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };

  // 只读**字面色值**的那几个令牌（别名 --layer-1/--layer-2 故意不在名单里，见文件头）。
  const GLASS_SOURCE_VARS = ['--card', '--card-hi', '--field-bg', '--layer-3', '--code-bg'];
  // ⚠️ top 必须是 0：顶栏 = 面板同档。曾用 +34 让顶栏"更实一点"，
  //   实际效果是整条顶栏把壁纸挡没了（30% 的界面里它 64%），用户直接看出来了。
  //   顶栏的文字对比度靠下面那条 text-shadow 兜，不靠不透明度。
  const GLASS_DELTA = { soft: -6, card: 8, sticky: 22, strong: 26, top: 0 };

  /* ── 玻璃色调（config.ui.glassTint）──────────────────────────────────
     半透明面板的底色默认来自主题（暗色 #24252b / 亮色 #ffffff）。给一个色调后，
     把**主题原色**按比例往那个色相上拉 —— 而不是直接把卡片刷成纯色。
     为什么不是直接换成纯色：主题原色带着明暗基准（暗色主题的卡片必须够暗，
     白字才立得住；亮色主题的卡片必须够亮，黑字才立得住）。直接刷纯色，
     换个浅色调整套界面就废了。按比例混，明度基准不动，只挪色相。
     输入框/代码块（--field-bg / --code-bg）用更轻的比例，保住它们"凹进去"的层次。 */
  const TINT_WEIGHT = 0.45;
  const TINT_WEIGHT_SOFT = 0.22;

  let glassStyle = null;
  let lastUi = null;
  let rawsTheme = '';
  let rawsCache = null;
  let lastTint = '\u0000';      // 哨兵：第一次一定重算

  function themeKey() {
    // 只认 data-theme（本版三套主题全靠它）。⚠️ 不要用 className：下面会给 html
    // 挂 `.we-glass`，拿 className 当 key 就成了"自己改自己 → 又触发重算"的循环。
    const el = document.documentElement;
    return (el.dataset ? el.dataset.theme : '') || '';
  }

  function ensureGlassStyle() {
    if (glassStyle) return glassStyle;
    glassStyle = document.createElement('style');
    glassStyle.id = 'we-glass-style';
    (document.head || document.documentElement).appendChild(glassStyle);
    return glassStyle;
  }

  /* ── 色值工具：把主题原色往色调上拉 ── */
  function parseHex(v) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || '').trim());
    if (!m) return null;
    let s = m[1];
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  /** base 往 tint 拉 w（0~1）。任一边不是合法 hex 就原样返回 —— 宁可没色调，
   *  也不能吐一个非法色值把整条声明搞失效（那会让面板直接没底）。 */
  function tintHex(base, tint, w) {
    if (!tint) return base;
    const b = parseHex(base);
    const t = parseHex(tint);
    if (!b || !t) return base;
    return '#' + b.map((v, i) => {
      const n = Math.round(v * (1 - w) + t[i] * w);
      return Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0');
    }).join('');
  }

  /** 关掉自己的样式表 → 读主题的原始层色。只读一次，色调变化不必重读。 */
  function readThemeRaws() {
    ensureGlassStyle();
    const sheet = glassStyle.sheet;
    try { if (sheet) sheet.disabled = true; } catch { /* ignore */ }
    const cs = getComputedStyle(document.documentElement);
    const raw = {};
    for (const name of GLASS_SOURCE_VARS) raw[name] = cs.getPropertyValue(name).trim();
    try { if (sheet) sheet.disabled = false; } catch { /* ignore */ }

    // 主题还没就绪（读不到原始色值）时**不接管**：宁可先保持不透明，
    // 也不能把这些令牌写成非法值 —— 那会让所有面板直接变透明/消失。
    if (!raw['--card'] || !raw['--card-hi'] || !raw['--layer-3']) return false;
    rawsCache = raw;
    rawsTheme = themeKey();
    return true;
  }

  /** 用原色 + 色调重写一组覆盖规则。
   *  把原色**直接抄进** color-mix（而不是引用一个 --we-layer-* 再套 var），
   *  少一层间接引用，也就少一种"变量没算出来 → 整块面板消失"的失败方式。 */
  function composeGlassStyle(tint) {
    ensureGlassStyle();
    const raw = rawsCache;
    if (!raw) return false;

    // 缺哪个就用同档的邻居顶上，保证不会因为某个主题少写一个令牌就退回实底
    const card = tintHex(raw['--card'], tint, TINT_WEIGHT);
    const cardHi = tintHex(raw['--card-hi'], tint, TINT_WEIGHT);
    const field = tintHex(raw['--field-bg'] || raw['--layer-3'], tint, TINT_WEIGHT_SOFT);
    const code = tintHex(raw['--code-bg'] || raw['--card-hi'], tint, TINT_WEIGHT_SOFT);
    const deep = tintHex(raw['--layer-3'], tint, TINT_WEIGHT_SOFT);

    const mix = (color, alphaVar) => `color-mix(in srgb,${color} var(${alphaVar},100%),transparent)`;

    /* ── 边缘光：把"一块半透明色"变成"一片玻璃"──────────────────────────
       真实玻璃的质感有一半在边缘上：凸起的面顶边吃光、底边压出厚度；
       凹陷的槽（输入框/下拉）正好反过来 —— 顶边被上方的面遮暗，底边才见光。
       之前只调 alpha，观感是"半透明色块浮在图上"，缺的就是这一像素。

       ⚠️⚠️ 为什么用 background-image，而不是大家都想到的 inset box-shadow：
         CSS 的 box-shadow **没有追加语法**，写一条就整条替换。
         .modal 的 var(--lift-lg)、.health-card / .usage-card 的 var(--lift)、
         .sel-menu 那段特意收窄过（0 6px 14px，为了省软件渲染重绘）的浮层投影，
         只要我写一条 inset，它们全部当场消失 —— 浮层会"贴回页面上"，
         层次感比加高光之前还差。（用户要求：附加，原功能不变。）
         background-image 只占 background 的一个子属性：
         background-color / box-shadow / border / background-size / 布局 / 过渡动画
         一律不碰，纯粹的叠加，撤掉等于没发生过。

       ⚠️ 只给原本**没有** background-image 的元素加。头号雷区 input.sw：
         那个开关的白色圆点就是 radial-gradient 画的，还配了 background-size /
         background-position，被这条盖上去开关立刻变空白。
         range / checkbox / radio / color / file 同理 —— 它们都拿背景画控件，
         所以选择器里逐个排除，不是保险起见，是必须。

       高光强度按卡片底色亮度自动定（raw['--card']）：暗底给淡白高光（.07）配
       稍重的下缘暗边（.17）；亮底反过来 —— 白卡片上 .07 的白肉眼看不见，得给到
       .5+，而下缘暗边必须压到 .06 以下，否则白卡片下沿会显脏。 */
    const edge = (() => {
      const b = parseHex(raw['--card']);
      // 相对亮度（sRGB 加权，近似即可）：0 = 纯黑，1 = 纯白
      const L = b ? (0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2]) / 255 : 0.15;
      const light = L > 0.55;
      return {
        hi: light ? `rgba(255,255,255,${Math.min(0.86, 0.5 + L * 0.36).toFixed(2)})` : 'rgba(255,255,255,.07)',
        lo: light ? 'rgba(0,0,0,.06)' : 'rgba(0,0,0,.17)',
        // 凹陷槽：顶边暗、底边亮
        hiSoft: light ? `rgba(255,255,255,${Math.min(0.8, 0.38 + L * 0.34).toFixed(2)})` : 'rgba(255,255,255,.045)',
        loSoft: light ? 'rgba(0,0,0,.12)' : 'rgba(0,0,0,.2)',
      };
    })();
    /* 两条 1px 渐变，分别贴在上/下沿。
       ⚠️ 必须用 !important：全站大量元素是 `background: var(--layer-1)` 这类**简写**
          声明，简写会把 background-image 重置成 none。同一条规则里我们只写
          background-image，简写规则不 !important 时压不过它。
         之所以敢 !important：它只作用于 background-image 一个子属性，
         而且选择器已经排掉了所有"用背景画控件"的元素（见上）。 */
    const bevel = (top, bottom) =>
      'background-image:'
      + `linear-gradient(180deg,${top} 0 1px,transparent 1px),`
      + `linear-gradient(0deg,${bottom} 0 1px,transparent 1px)!important;`;
    glassStyle.textContent = [
      'html{',
      // ── 最底层的三个面令牌：这一组才是卡片/左栏/表头真正读的东西 ──
      `--card:${mix(card, '--we-glass')}!important;`,
      `--card-hi:${mix(cardHi, '--we-glass-card')}!important;`,
      `--field-bg:${mix(field, '--we-glass-soft')}!important;`,
      // ── 别名层：--layer-1/2 就是 --card/--card-hi，用同一份原色重写，
      //    让走旧名字的 1900 多处 var() 一起透，两边不会是两种深浅 ──
      `--layer-1:${mix(card, '--we-glass')}!important;`,
      `--layer-2:${mix(cardHi, '--we-glass-card')}!important;`,
      `--layer-3:${mix(deep, '--we-glass-strong')}!important;`,
      // --inset-bg / --code-bg 也是别名，一律从原色出发
      `--inset-bg:${mix(field, '--we-glass-soft')}!important;`,
      `--code-bg:${mix(code, '--we-glass-soft')}!important;`,
      `--we-sticky-1:${mix(card, '--we-glass-sticky')};`,
      `--we-sticky-2:${mix(cardHi, '--we-glass-sticky')};`,
      '}',
      // 顶栏：整条渐变跟着同一条滑条变半透明（top 档 = 面板同档）。100% 时与原样式逐字相同。
      'html.we-glass #topbar{',
      'background:linear-gradient(180deg,'
        + mix('var(--topbar-1)', '--we-glass-top') + ','
        + mix('var(--topbar-2)', '--we-glass-top') + ')!important;',
      'box-shadow:0 1px 0 rgba(255,255,255,.05),0 2px 12px rgba(0,0,0,.24)!important;',
      // 底色淡下去以后，白字全靠这层投影立住（浅色壁纸下尤其明显）
      'text-shadow:0 1px 3px rgba(0,0,0,.6),0 0 1px rgba(0,0,0,.45);',
      '}',
      // 白底元素（激活页签 / 品牌图标）不吃上面那条投影，否则蓝字会糊出黑边
      'html.we-glass #topbar #tabs .nav-item.active,html.we-glass #topbar .brand::before{text-shadow:none;}',
      /* ── 全屏页（会话选择 / 会话设置）：壁纸在这里曾经整块消失 ────────────
         根因不在变量层，而在 .bigpage 自带一层**不透明**整屏底
         （`background: var(--page-bg)`，position:fixed z-index:60），壁纸层
         .wp-bg-el 在 z-index:-2，被它从 z=60 整块挡死 —— 看过去就是一片纯深灰。
         现在已经把 .bigpage 的底改成 transparent（交给 .win-frame，见 style.css
         那段长注释），所以这里**不需要**再覆盖背景：写成 color-mix 反而会和
         .win-frame 叠成第二层，中间档位比主界面更暗。

         还差的是它自己的零件：底透明以后，原来"用不透明页面底顺手遮住"的地方
         全都要显形了 —— 下面两条补的就是这些。 */
      /* 全屏页的标题条 .bp-head 吃的是与 #topbar **同一对** --topbar-* 变量，
         但它是另一条独立规则（不透明蓝渐变）—— 上面给 #topbar 写的那条管不到它，
         所以这里必须单独写一遍，否则顶栏蓝条会是一整块实心色、和主界面不一致。 */
      'html.we-glass .bp-head{',
      'background:linear-gradient(180deg,'
        + mix('var(--topbar-1)', '--we-glass-top') + ','
        + mix('var(--topbar-2)', '--we-glass-top') + ')!important;',
      'box-shadow:0 1px 0 rgba(255,255,255,.05),0 2px 12px rgba(0,0,0,.24)!important;',
      'text-shadow:0 1px 3px rgba(0,0,0,.6),0 0 1px rgba(0,0,0,.45);',
      '}',
      /* 全屏页里的吸顶条（会话列表头 / 两个搜索框）：原本用 --page-bg **实色**
         盖住滚上去的内容。页面底透掉之后，这里若继续实色，就会变成一条
         横贯页面的突兀色带，和整页的玻璃质感打架。
         改用「吸顶档」（比面板再实一档，GLASS_DELTA.sticky = +22）：
         既保住"滚过去的内容不从表头里穿出来"，又跟其余吸顶条同源。 */
      'html.we-glass .bp-mode-chat>#session-list .list-head,'
        + 'html.we-glass #cc-search-wrap,'
        + 'html.we-glass #bp-setup-left .bp-search-wrap{background:var(--we-sticky-1)!important;}',
      // 吸顶条（列表头/表格表头/浮层标题条）：比面板再实一档，
      // 滚动时底下的内容不会从表头里"穿"过来。
      // 新版 .member-table th 直接吃 --layer-1、.usage-table th 吃 --bg-3(=--layer-2)，
      // 都已经被上面的变量换代了，这里只补"要更实一档"的那几个。
      'html.we-glass .list-head,html.we-glass .member-table th{background:var(--we-sticky-1)!important;}',
      'html.we-glass .panel-float-bar,html.we-glass .usage-table th,'
        + 'html.we-glass .usage-table thead th,html.we-glass .ub-scroll thead th,'
        + 'html.we-glass .model-modal>table.usage-table thead th{background:var(--we-sticky-2)!important;}',
      // 透到能看见壁纸时给文字一点投影：壁纸越花，字越要靠这层"底"立住。
      'html.we-glass .app-shell{text-shadow:0 1px 2px rgba(0,0,0,.42);}',
      // ── 玻璃边缘光（纯附加层，见下方长注释）────────────────────────────
      `html.we-glass .health-card,html.we-glass .usage-card,`
        + `html.we-glass .modal,html.we-glass .sel-menu{${bevel(edge.hi, edge.lo)}}`,
      `html.we-glass textarea,html.we-glass select,`
        + `html.we-glass input:not([type='range']):not([type='checkbox'])`
        + `:not([type='radio']):not([type='color']):not([type='file']):not(.sw)`
        + `{${bevel(edge.loSoft, edge.hiSoft)}}`,
    ].join('');
    lastTint = tint || '';
    return true;
  }

  function applySurfaceAlpha(ui) {
    // ⚠️ 合并而不是整体替换：weSetGlassPercent 只传 { panelAlpha } 一项，
    //   整体替换会把 glassTint 等其它字段抹掉（色调时有时无的经典成因）。
    if (ui) lastUi = { ...(lastUi || {}), ...ui };
    const alpha = clampInt(lastUi?.panelAlpha, 0, 100, 100);
    const root = document.documentElement;

    // 旧版本逐元素写过 inline，升级时清掉，免得两套叠加
    for (const el of document.querySelectorAll('[data-we-glass]')) {
      el.style.removeProperty('background-color');
      el.removeAttribute('data-we-glass');
    }
    // 更早的版本把原始层色存在 --we-layer-* 上；现在改用"原色直接进 color-mix"，顺手清掉
    root.style.removeProperty('--we-layer-1');
    root.style.removeProperty('--we-layer-2');

    // 换主题（data-theme 变了）时要重抠一次原色，
    // 否则浅色主题会套着深色层的原色算，越算越黑。
    // 色调换了不必重读主题，只重拼样式表。
    if (!rawsCache || themeKey() !== rawsTheme) {
      if (!readThemeRaws()) return;   // 主题还没就绪：这一轮先保持原样
      lastTint = '\u0000';
    }
    const tint = String(lastUi?.glassTint || '').trim();
    if (!glassStyle || !glassStyle.textContent || tint !== lastTint) {
      if (!composeGlassStyle(tint)) return;
    }

    // 一条滑条 → 一组档位，层级关系保持不变（越"浮"越实）。
    // ⚠️ 负数档位（凹槽/代码块）在 100 时要停在 100：否则"100 = 原样不透明"
    // 这个约定会在输入框和代码块上破功，它们永远差那 6 个点。
    const at = (delta) => (delta < 0 && alpha >= 100)
      ? 100
      : Math.max(0, Math.min(100, alpha + delta));
    root.style.setProperty('--we-glass', `${alpha}%`);
    root.style.setProperty('--we-glass-soft', `${at(GLASS_DELTA.soft)}%`);
    root.style.setProperty('--we-glass-card', `${at(GLASS_DELTA.card)}%`);
    root.style.setProperty('--we-glass-sticky', `${at(GLASS_DELTA.sticky)}%`);
    root.style.setProperty('--we-glass-strong', `${at(GLASS_DELTA.strong)}%`);
    root.style.setProperty('--we-glass-top', `${at(GLASS_DELTA.top)}%`);
    // 100% 时把控制类关掉：顶栏覆盖、吸顶加强、文字投影只在"真的透"时才生效，
    // 保证拉满 = 与改之前逐像素一致。
    root.classList.toggle('we-glass', alpha < 100);
  }

  // 换主题时 applyUiCustom 不一定重跑（主题是直接改 data-theme 的），
  // 这里盯一下 html 的属性变化，主题变了就用上一份 ui 重算。
  // 新版 00-core 的 applyTheme 也会调 applyUiCustom，两条路都通。
  let themeObserver = null;
  function startThemeObserver() {
    if (themeObserver || typeof MutationObserver !== 'function') return;
    themeObserver = new MutationObserver(() => {
      if (themeKey() !== rawsTheme && lastUi) applySurfaceAlpha(null);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ── 接到 00-core 的 applyUiCustom 上 ──
  // ⚠️ 用包装而不是自己轮询：applyUiCustom 是"唯一一条把 ui 配置落到 CSS 的路径"，
  // 挂上去就不会漏（启动、保存、重置、切换都走它）。
  //
  // ⚠️⚠️ 关键：00-core.js 里的 `function applyUiCustom(...)` 是**顶层函数声明**，
  //   在普通 <script> 里它同时是全局词法绑定和 window 属性；但一旦文件被包进
  //   IIFE 或按 module 加载，它就只活在那个作用域里 —— 别的文件根本读不到
  //   `window.applyUiCustom`。所以下面用**裸标识符**判断（走词法作用域，
  //   两种情况都能拿到），包装完再显式写回 window，保证后加载的脚本也拿得到。
  function wrapApply() {
    if (typeof applyUiCustom !== 'function' || applyUiCustom.__weGlass) return false;
    const orig = applyUiCustom;
    const wrapped = function (ui, opts) {
      const r = orig.call(this, ui, opts);
      try { applySurfaceAlpha(ui); } catch { /* 玻璃层失败绝不能拖垮外观设置 */ }
      return r;
    };
    wrapped.__weGlass = true;
    // 改写词法作用域里的绑定 + window 上那份（能写哪个写哪个）
    try { applyUiCustom = wrapped; } catch { /* const/不可写绑定 */ }
    try { window.applyUiCustom = wrapped; } catch { /* ignore */ }
    return true;
  }

  function boot() {
    startThemeObserver();
    if (!wrapApply()) {
      // applyUiCustom 还没定义（脚本顺序变了）→ 等一拍再挂，最多试 40 次
      let tries = 0;
      const t = setInterval(() => {
        if (wrapApply() || ++tries > 40) clearInterval(t);
      }, 100);
    }
    // 首屏：配置可能已经加载好了，主动应用一次
    try {
      if (typeof state !== 'undefined' && state.config?.ui) applySurfaceAlpha(state.config.ui);
    } catch { /* state 还没就绪，等 applyUiCustom 被调用 */ }
  }

  // 给壁纸页/控制台用的手动入口
  window.weSetGlassPercent = function (pct) {
    const p = clampInt(pct, 0, 100, 100);
    try {
      if (typeof state !== 'undefined' && state.config) {
        state.config.ui = { ...(state.config.ui || {}), panelAlpha: p };
      }
    } catch { /* ignore */ }
    applySurfaceAlpha({ panelAlpha: p });
    return p;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
