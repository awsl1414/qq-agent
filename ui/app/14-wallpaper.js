// 「壁纸」页：把 Wallpaper Engine 壁纸库搬进控制台当界面背景（毛玻璃风格）。
//
// 两部分职责：
//   1. 全局背景引擎：开机即恢复上次选的壁纸（localStorage），在 body 底层铺
//      video / 预览图层；壁纸自身一次性预模糊，#tabs、侧栏、卡片用半透明色
//      叠在上面形成毛玻璃观感（不用 backdrop-filter，理由见 wpGlassCss）。
//      开关只挂 html[data-wp='on']，关掉壁纸时这些覆盖全部失效，界面还原。
//      附带两样「取色取景」能力（算法移植自 zcode-beautify，MIT）：
//        - 莫奈取色（仅强调色跟随）：canvas 解码预览图 → Celebi 量化 + Score
//          打分取主色 → MD3 明暗两套 primary，重染 --ac 三件套；
//          功能色（ok/warn/err）与玻璃色板不动。开关挂 html[data-monet]。
//        - 智能取景：与全图均值色距平方的加权重心 = 画面主体位置，作为
//          cover 焦点；极端宽高比自动切 contain（完整显示 + 同图模糊底）。
//   2. 壁纸管理页：网格列出壁纸（预览图 + 动态/静态徽标），点选即换背景；
//      模糊强度 / 压暗程度两个滑条 + 取景模式 + 莫奈开关，实时生效并持久化。
//
// 后端：/api/wallpaper/list 与 /api/wallpaper/file（src/routes.js 的能力中介 →
// 内置模块 src/wallpaper/core.js）。媒体 URL 必须带 token 查询参数：<img>/<video> 标签
// 发不了自定义请求头，而 /api/* 的鉴权同时接受 ?token=。统一由 00-core.js 的
// withToken() 拼（它取的是 CONSOLE_AUTH_TOKEN，不是 CONSOLE_MARKER，后者只是
// Electron 下被主进程换成真凭据的占位符，浏览器里没人认）。
'use strict';

// ── 本页模块状态（经典脚本，全局名一律 wp 前缀防撞）──────────────────────
const WP_STORE_KEY = 'wp-console-bg';   // localStorage：{ id,title,kind,blur,dim,monet,fit }
let wpItems = [];
let wpLoadSeq = 0;
let wpAnalyzeSeq = 0;   // 换壁纸期间旧分析结果晚到时作废

function wpCfgLoad() {
  try { return JSON.parse(localStorage.getItem(WP_STORE_KEY) || '') || null; } catch { return null; }
}
function wpCfgSave(cfg) {
  try { cfg ? localStorage.setItem(WP_STORE_KEY, JSON.stringify(cfg)) : localStorage.removeItem(WP_STORE_KEY); }
  catch { /* 存储满/被禁用时静默：本功能纯装饰 */ }
  wpPushState(cfg);   // 同步给后端（机器人技能/多窗口一致性），失败静默
}
function wpMediaUrl(id, kind) {
  // 媒体 URL 走 <img>/<video>/CSS url() 这类原生加载，带不了请求头，
  // 统一交给 00-core.js 的 withToken() 拼 ?token=。
  return withToken(`/api/wallpaper/file?id=${encodeURIComponent(id)}&kind=${kind === 'preview' ? 'preview' : 'media'}`);
}

// ── 莫奈取色 + 智能取景（canvas 像素分析，纯前端，零后端依赖）──────────
// 算法移植自 zcode-beautify（MIT）：显著性 = 像素与全图均值色的欧氏距离
// 平方做权重的重心；主色 = Celebi 量化 + Score 打分（vendor-md3.js 提供算子）。
/** md3 缺失时的内置降级取色：饱和度加权直方图找主导色相 → 明暗两档
 *  强调色。没有 MD3 的精细色阶，但"颜色跟随壁纸"的观感成立。
 *  场景：分发时 vendor-md3.js 或 index.html 引入行被漏装（纯插件思路
 *  安装最常见的缺口），宁可降级也不能静默失去整个功能。 */
function wpFallbackAccent(data, off) {
  const W = [255, 255, 255], K = [0, 0, 0];
  const mix = (c, t, k) => c.map((v, i) => Math.round(v + (t[i] - v) * k));
  const argb = (c) => (0xff000000 | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0;
  const buckets = new Array(12).fill(0);
  const sums = Array.from({ length: 12 }, () => [0, 0, 0, 0]);
  for (const i of off) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 510;
    if (mx === mn || l < 0.1 || l > 0.95) continue;   // 灰/过暗过亮不参与
    const s = (mx - mn) / (255 - Math.abs(mx + mn - 255));
    const d = mx - mn;
    let h;
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    const k = Math.floor(h * 2) % 12;
    const w = s * s;   // 饱和度平方加权：找的是"有颜色的东西"
    buckets[k] += w;
    const s2 = sums[k];
    s2[0] += r * w; s2[1] += g * w; s2[2] += b * w; s2[3] += w;
  }
  let best = -1, bw = 0;
  buckets.forEach((w, k) => { if (w > bw) { bw = w; best = k; } });
  if (best < 0 || bw <= 0) return null;
  const s = sums[best];
  const rgb = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
  // 暗主题往白混 35%（保读性），亮主题往黑混 12%
  return { dark: argb(mix(rgb, W, 0.35)), light: argb(mix(rgb, K, 0.12)) };
}

async function wpAnalyzeImage(url) {
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    const W = 160;
    const H = Math.max(1, Math.round((img.naturalHeight || 9) * W / Math.max(1, img.naturalWidth || 16)));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, W, H);
    const data = cx.getImageData(0, 0, W, H).data;   // 同源 URL，画布不污染
    let rs = 0, gs = 0, bs = 0, n = 0;
    const off = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) continue;
      off.push(i);
      rs += data[i]; gs += data[i + 1]; bs += data[i + 2]; n++;
    }
    let focus = { x: 0.5, y: 0.5, fit: 'cover' };
    if (n > 0) {
      const mr = rs / n, mg = gs / n, mb = bs / n;
      let wx = 0, wy = 0, wsum = 0;
      for (const i of off) {
        const x = (i / 4) % W, y = Math.floor(i / 4 / W);
        const dr = data[i] - mr, dg = data[i + 1] - mg, db = data[i + 2] - mb;
        const w = dr * dr + dg * dg + db * db + 1;
        wx += x * w; wy += y * w; wsum += w;
      }
      const aspect = W / H;
      focus = {
        x: Math.min(1, Math.max(0, (wx / wsum) / W)),
        y: Math.min(1, Math.max(0, (wy / wsum) / H)),
        fit: aspect > 2.4 || aspect < 0.42 ? 'contain' : 'cover'
      };
    }
    let colors = null;
    let engine = 'builtin';
    if (typeof md3 === 'object' && md3 && off.length) {
      try {
        const pixels = new Array(off.length);
        for (let k = 0; k < off.length; k++) {
          const i = off[k];
          pixels[k] = md3.argbFromRgb(data[i], data[i + 1], data[i + 2]);
        }
        const ranked = md3.Score.score(md3.QuantizerCelebi.quantize(pixels, 64));
        const src = ranked && ranked[0];
        if (Number.isFinite(src)) {
          const theme = md3.themeFromSourceColor(src);
          colors = { dark: theme.schemes.dark.primary, light: theme.schemes.light.primary };
          engine = 'md3';
        }
      } catch { /* 取色失败走降级 */ }
    }
    if (!colors && off.length) {
      colors = wpFallbackAccent(data, off);
      if (engine !== 'md3') {
        console.warn('[壁纸] vendor-md3.js 未加载，取色用内置简化算法（确认 ui/app/vendor-md3.js 存在且 index.html 有引入行，可得完整 MD3）');
      }
    }
    return { focus, colors };
  } catch { return null; }   // 图挂了/画布异常：焦点与配色都退默认
}

function wpArgbHex(argb) {
  return `#${((argb >> 16) & 255).toString(16).padStart(2, '0')}${((argb >> 8) & 255).toString(16).padStart(2, '0')}${(argb & 255).toString(16).padStart(2, '0')}`;
}
function wpArgbRgba(argb, a) {
  return `rgba(${(argb >> 16) & 255}, ${(argb >> 8) & 255}, ${argb & 255}, ${a})`;
}
// 仅强调色跟随：--ac 三件套按明暗两套重染；ok/warn/err 功能色刻意不动。
function wpMonetCss(colors) {
  const rows = (c) => `--ac: ${wpArgbHex(c)}; --ac-soft: ${wpArgbRgba(c, .14)}; --ac-line: ${wpArgbRgba(c, .38)};`;
  return `html[data-wp='on'][data-monet='on'] {${rows(colors.dark)}}\n` +
         `html[data-wp='on'][data-monet='on'][data-theme='light'] {${rows(colors.light)}}`;
}
function wpMonetApply(colors) {
  let style = document.getElementById('wp-monet-style');
  if (!colors) { style?.remove(); return; }
  if (!style) {
    style = document.createElement('style');
    style.id = 'wp-monet-style';
    document.head.appendChild(style);
  }
  style.textContent = wpMonetCss(colors);
}

/** 取景：按 cfg.fit（cover/contain/smart）落焦点与 contain 模式的模糊底。 */
function wpApplyFraming(cfg) {
  const fc = cfg.fitCache && cfg.fitCache.id === cfg.id ? cfg.fitCache : null;
  const smart = cfg.fit !== 'cover' && cfg.fit !== 'contain';
  const wantContain = cfg.fit === 'contain' || (smart && fc?.fit === 'contain');
  const fx = smart && fc ? fc.x : 0.5;
  const fy = smart && fc ? fc.y : 0.5;
  const pos = `${Math.round(fx * 100)}% ${Math.round(fy * 100)}%`;
  const img = document.getElementById('wp-bg-img');
  if (img) {
    img.style.backgroundSize = wantContain ? 'contain' : 'cover';
    img.style.backgroundPosition = wantContain ? 'center' : pos;
  }
  const video = document.getElementById('wp-bg-video');
  if (video) {
    video.style.objectFit = wantContain ? 'contain' : 'cover';
    video.style.objectPosition = pos;
  }
  const bd = document.getElementById('wp-bg-backdrop');
  if (bd) {
    /* 修「刚开始打开是一张特别糊的壁纸」的第二处（第一处是 #app-bg 的插件缩略图，
       见 00-core.js）。
       contain 模式的模糊底本身就是"preview 缩略图 × cover 铺满 + blur 28px"：
       它的职责只是填 contain 视频两侧的留白，本该永远被视频盖住。可启动时
       4K 120fps 视频还没解出首帧（readyState < 2），视频元素是黑的、整屏只剩
       这层 28px 模糊，用户看到的就是"一张特别糊的壁纸"，等视频起播才消失。
       所以视频没就绪就先别开它；loadeddata 之后由 wpRenderBackground 里那个
       一次性监听重新跑本函数，把留白补回来。（静态图没有这个问题：它自己就是
       可见主体，backdrop 在它下面，开着也无害。） */
    const vReady = !video || video.readyState >= 2;   // 2 = HAVE_CURRENT_DATA，已有当前帧
    bd.dataset.on = (wantContain && vReady) ? '1' : '0';
  }
}

/**
 * 莫奈 + 焦点的主入口：有缓存（monetCache/fitCache，按 id 失效）直接用，
 * 没有就后台分析一次、落缓存再应用。开机/换壁纸首跑多花 ~50ms，之后秒出。
 */
function wpApplyThemeSmart(cfg) {
  const cachedColors = cfg.monetCache && cfg.monetCache.id === cfg.id
    ? { dark: cfg.monetCache.dark, light: cfg.monetCache.light } : null;
  if (cachedColors) wpMonetApply(cfg.monet === false ? null : cachedColors);
  else wpMonetApply(null);
  wpApplyFraming(cfg);
  if (cachedColors && cfg.fitCache?.id === cfg.id) return;   // 两样都有缓存，无需分析
  const seq = ++wpAnalyzeSeq;
  wpAnalyzeImage(wpMediaUrl(cfg.id, 'preview')).then((r) => {
    if (!r || seq !== wpAnalyzeSeq) return;
    const cur = wpCfgLoad();
    if (!cur || cur.id !== cfg.id) return;   // 期间已换壁纸：结果作废
    if (r.focus) cur.fitCache = { id: cfg.id, ...r.focus };
    if (r.colors) cur.monetCache = { id: cfg.id, ...r.colors };
    try { localStorage.setItem(WP_STORE_KEY, JSON.stringify(cur)); } catch { /* 存不下就只本次生效 */ }
    if (r.colors && cur.monet !== false) wpMonetApply(cur.monetCache);
    wpApplyFraming(cur);
  });
}

// ── 全局背景引擎 ─────────────────────────────────────────────────────────
// 性能铁律（与 style.css 弹窗同款教训，见 electron/main.js 的
// disableHardwareAcceleration）：本应用没有 GPU，backdrop-filter 会让 CPU
// 每帧对整屏做高斯模糊，滚动/切窗直接掉帧。玻璃感因此改由「背景层自己
// 一次性模糊」提供：filter 挂在媒体层上，静态图栅格化一次即被缓存；
// 前景元素一律半透明色叠在已模糊的背景上，观感等效、成本趋近于零。
// 视频壁纸例外：视频上的 filter 是逐帧模糊（又回到老问题），保持原样
// 清晰播放，靠压暗罩 + 卡片色保证可读性。
function wpGlassCss() {
  return `
/* 背景层：媒体在最底(-2)，压暗罩(-1)；都不吃鼠标事件 */
.wp-bg-el { position: fixed; inset: 0; z-index: -2; pointer-events: none; }
#wp-bg-video { width: 100%; height: 100%; object-fit: cover; }
/* 静态图把模糊做在自己身上（--wp-blur 由滑条驱动）。blur 四边会漏出
   半透明边，向外扩 60px 盖住（最大 40px 模糊）；fixed 元素不吃布局，
   扩出去不产生滚动条。 */
#wp-bg-img { inset: -60px; background-size: cover; background-position: center;
  filter: blur(var(--wp-blur,18px)) saturate(1.4); }
/* contain 取景的模糊底：同图 cover + 重模糊，垫在完整显示的主图后面 */
#wp-bg-backdrop { inset: -60px; background-size: cover; background-position: center;
  display: none; filter: blur(28px) saturate(1.15) brightness(.85); }
#wp-bg-backdrop[data-on='1'] { display: block; }
#wp-bg-dim { position: fixed; inset: 0; z-index: -1; pointer-events: none; background: rgba(0,0,0,var(--wp-dim,.25)); }

/* 「盖住壁纸」（底色不透明度拉满 100）时，把壁纸层和压暗罩一起收起来。
   ⚠️ 必须收：.wp-bg-el / #wp-bg-dim 都是 z-index:-2 / -1，与 .win-frame(-1) 同层且
      在 DOM 里更靠后 —— 底色拉成不透明后，那层 25% 的黑压暗罩会浮在**不透明底色之上**，
      结果"关掉壁纸"看着比跟随主题还暗一档。 */
html[data-wp-veil='on'] .wp-bg-el { display: none !important; }

/* 主界面的透明底不在这里做 —— 统一交给 20-glass.js 的「全界面玻璃层」：
   面板 / 卡片 / 浮层 / 输入槽 / 代码块 / 吸顶表头 / 顶栏 都走同一组主题变量，
   由「面板透明度」一条滑条驱动（壁纸页的「界面」滑条就是同一条）。
   这里原先自己硬编码了一套 --wp-glass / --wp-card / --wp-glass-strong，
   却只盖到 #tabs、.list-pane、.card、.modal 这几张"名单内"的元素 —— 名单外的
   页面和控件照旧实色，两个滑条各管一半，越调越乱。整段已移除。 */
/* 字体颜色预设：正文 / 次要 / 弱化三档一起换，强调色不动（归莫奈取色）。
   ⚠️⚠️ 2026-10-23 修「色号光有色号没有效果」：
   这里原先是 --tx / --tx2 / --tx3 —— 那是**旧版**的变量名，新版 style.css 里
   一次都没有定义（全文 0 处），所以这 7 条规则一直在给空气赋值，点色号毫无反应。
   新版真正的文字三档是 --fg / --fg-dim / --fg-mute（--text/--muted/--faint 是它们的别名）。
   同时去掉 html[data-wp='on'] 这个前置条件：壁纸现在多数由插件生成的 bgImage
   （#app-bg）画出来，data-wp 不一定挂得上，套着它就会出现"壁纸在、字色不跟"。
   data-text 本身只在选了非「主题」时才会挂，已经足够当开关了。
   ⚠️ 本段整体在模板字符串里，注释不要用反引号引变量名 —— 会把字符串提前截断。 */
html[data-text='white']  { --fg:#f2f4f8; --fg-dim:rgba(242,244,248,.72); --fg-mute:rgba(242,244,248,.5); }
html[data-text='black']  { --fg:#17191d; --fg-dim:rgba(23,25,29,.72);     --fg-mute:rgba(23,25,29,.5); }
html[data-text='blue']   { --fg:#6ea8ff; --fg-dim:rgba(110,168,255,.72);  --fg-mute:rgba(110,168,255,.5); }
html[data-text='yellow'] { --fg:#ffd75e; --fg-dim:rgba(255,215,94,.72);   --fg-mute:rgba(255,215,94,.5); }
html[data-text='green']  { --fg:#7fd88f; --fg-dim:rgba(127,216,143,.72);  --fg-mute:rgba(127,216,143,.5); }
html[data-text='pink']   { --fg:#ff9ecb; --fg-dim:rgba(255,158,203,.72);  --fg-mute:rgba(255,158,203,.5); }
html[data-text='purple'] { --fg:#c3a1ff; --fg-dim:rgba(195,161,255,.72);  --fg-mute:rgba(195,161,255,.5); }
/* 色板控件 */
.wp-swatches { display: inline-flex; gap: 5px; align-items: center; }
.wp-sw { width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--line-str);
  cursor: pointer; display: inline-block; box-shadow: 0 0 0 1px rgba(0,0,0,.2) inset; }
.wp-sw.on { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 本页自己的网格 */
.wp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
.wp-cell { display: flex; flex-direction: column; gap: 6px; padding: 0; border: 2px solid var(--line); border-radius: var(--radius);
  background: var(--layer-1); cursor: pointer; overflow: hidden; text-align: left; transition: border-color .15s, transform .15s;
  /* min-width:0：grid 项默认 min-width:auto，缩略图的原始像素宽会把整列顶宽
     （表现就是"某张卡片的预览图按原始尺寸铺开、把网格撑歪"）。 */
  min-width: 0;
  /* 视口外的卡片跳过渲染/解码：壁纸库几百张时滚动只画看得见的那批 */
  content-visibility: auto; contain-intrinsic-size: auto 200px; }
.wp-cell:hover { transform: translateY(-2px); }
.wp-cell.on { border-color: var(--accent); }
.wp-thumb { position: relative; aspect-ratio: 16/9; min-width: 0; overflow: hidden;
  background: linear-gradient(135deg, var(--layer-1), var(--layer-2)); }
.wp-thumb img { width: 100%; height: 100%; max-width: 100%; object-fit: cover; display: block; }
.wp-badge { position: absolute; top: 6px; right: 6px; padding: 2px 7px; border-radius: var(--radius-full); font-size: 11px; font-weight: 600;
  background: rgba(0,0,0,.55); color: #fff; }
.wp-badge.mov { background: rgba(46,108,255,.85); }
.wp-name { padding: 8px 10px 0; font-size: 13px; font-weight: 600; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wp-sub { padding: 0 10px 9px; font-size: 11px; color: var(--fg-mute); }
.wp-ctrl { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 4px 0 16px; }
.wp-ctrl label { font-size: 12px; color: var(--fg-dim); display: flex; align-items: center; gap: 6px; }
.wp-ctrl input[type='range'] { width: 140px; }
.wp-ctrl select { font: inherit; }
.wp-dynrow { padding: 0 10px 9px; display: flex; gap: 6px; align-items: center; }
.wp-dyn, .wp-redo { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--line-str); background: var(--layer-1); color: var(--fg-dim); font-size: 11px;
  cursor: pointer; user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.wp-dyn:hover, .wp-redo:hover { color: var(--accent); border-color: var(--line-str); }
.wp-dyn[aria-disabled='true'], .wp-redo[aria-disabled='true'] { opacity: .75; cursor: default; }
.wp-hintbox { padding: 14px 16px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--fg-dim); font-size: 13px; line-height: 1.8; }

/* 页头标题：容器现在是 .settings-pane，它给所有 h3 套了「设置分区标题」那套
   （accent 色 + 下边框 + 22px 上边距）。本页 h3 住在 .usage-head 的 flex 行里，
   那根下边框会变成一截悬空的短线，所以这里按页内标题来画。 */
#wallpaper-page > .usage-wrap > .usage-head > h3 {
  margin: 0; padding: 0; border-bottom: none; font-size: 15px; color: var(--fg);
  flex: none;
}
/* 页头那颗说明（壁纸库路径）：flex-basis 0 —— 先把它的"自然宽度"当成 0，
   再让它吃掉剩余空间。写 auto 的话 flex-wrap 会先按整段路径的宽度去排，
   990px 页宽下必换行，按钮组被挤到第二行。
   挤到极限时用省略号收尾（完整路径在 title 上）。 */
#wallpaper-page .wp-weinfo { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 页头按钮组：整组不换行、不压缩 */
#wallpaper-page .wp-headbtns { display: flex; gap: 8px; align-items: center; flex: none; }

/* ── 弹窗态 ──────────────────────────────────────────────────────────
   这一页现在的主入口是「设置 → 界面背景 → 🎨 打开壁纸库…」，开的是弹窗
   （见 wpOpenLibrary）：#wallpaper-page 整个节点被搬进 .model-modal-body。
   搬进去以后，整页那套壳（990 居中 / 玻璃卡片 / 22-26 内边距 / 自己的滚动条）
   会在弹窗里套成两层，全部卸掉，滚动交给 .model-modal-body 自己管。 */
#wallpaper-page.wp-lib-pane {
  max-width: none; width: auto; margin: 0; padding: 0;
  background: none; box-shadow: none; border-radius: 0;
  overflow: visible; flex: none; min-height: 0;
}
/* 弹窗标题已经是「控制台壁纸」，页头那颗 h3 会重复一遍 */
#wallpaper-page.wp-lib-pane .usage-head > h3 { display: none; }
/* 也没有「← 外观与数据」这条回头路了：✕ / Esc / 点遮罩都能关，关掉就回到原处 */
#wallpaper-page.wp-lib-pane #wp-back { display: none; }
/* 弹窗里纵向间距收紧一档：这块内容本来就密（两行控件 + 两行卡片），
   照整页那套留白，820px 高的窗口里要滚一屏才看得完。 */
#wallpaper-page.wp-lib-pane .usage-head { margin-bottom: 12px; }
#wallpaper-page.wp-lib-pane .wp-ctrl { margin: 2px 0 10px; }
#wallpaper-page.wp-lib-pane #wp-settings { padding-top: 8px; }

/* 弹窗尺寸：.model-modal 默认 760 宽，放不下 4 列网格。内容按 940 页宽排，
   左右各留 36，与设置页观感一致。
   高度用 auto + max-height（不是钉死高度）：壁纸少时不留一大片空白，壁纸多时
   由 max-height 收口、交给 .model-modal-body 滚动。
   ⚠️ 配套把 body 的 flex 从 1 改成 0 1 auto —— 默认的 flex-basis:0 会在
      "弹窗高度 auto" 时把 body 算成 0 高，内容被裁成一条。 */
.model-modal-overlay.wp-lib .model-modal { width: 1000px; }
.model-modal-overlay.wp-lib .model-modal-body { flex: 0 1 auto; }

/* 弹窗顶部的说明条 */
.wp-lib-desc {
  margin: 0; padding: 10px 12px; border-radius: var(--radius);
  background: var(--layer-1); border: 1px solid var(--line);
  font-size: 12.5px; line-height: 1.75; color: var(--fg-dim);
}

/* 空状态卡（没装小红车 / 内置模块没加载起来）。
   以前这两种情况都只渲染一个 .wp-hintbox，而 .wp-hintbox 的样式恰恰也在这张
   只在"已选壁纸"时才注入的表里 —— 于是页面退化成没有任何样式的裸文本。
   现在样式进页必注入（见 wpEnsurePageCss），空状态本身也升级成设置页那套卡片语言。 */
.wp-empty { display: flex; gap: 16px; align-items: flex-start;
  padding: 22px 24px; background: var(--layer-1);
  border: 1px solid var(--line); border-radius: var(--radius-lg); }
.wp-empty-ico { flex: none; font-size: 30px; line-height: 1.1; opacity: .92;
  width: 52px; height: 52px; display: flex; align-items: center; justify-content: center;
  background: var(--layer-2); border-radius: var(--radius-lg); }
.wp-empty-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 9px; }
.wp-empty-body h4 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.wp-empty-body p { margin: 0; font-size: 12.5px; line-height: 1.75; color: var(--fg-dim); }
.wp-empty-body p.muted { color: var(--fg-mute); font-size: 12px; }
.wp-empty-body code { font-size: 11.5px; }
.wp-empty-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 目录输入框（空状态的「安装根目录」、正常页的「小红车目录 / 管家白名单」）。
   视觉对齐 设置 → 任意 .field 里的输入框：凹下底色、34px 固定高、7px 圆角、
   聚焦 2px 强调色描边。两条坑，都别"顺手优化"掉：
   ① 不能直接套 .field —— 它带 flex:1，落进 .wp-empty-body 这个 flex column 会被
      纵向拉高；落进 .wp-ctrl 那个 flex row 又会把整行挤得换行。
   ② 选择器必须带 #wallpaper-page。style.css 里有一条
      input:not([type='checkbox']):not([type='radio']) { border: none }（特异性 0,2,1），
      单写 .wp-input（0,1,0）会被它压掉。这正是"输入框和外面不像"的真正原因：
      它此前没拿到任何 app 样式，用的是 Chromium 自带深色控件皮肤。 */
#wallpaper-page .wp-field { display: flex; flex-direction: column; gap: 5px; width: 100%; min-width: 0; }
#wallpaper-page .wp-field > label { font-size: 12px; color: var(--muted); }
#wallpaper-page .wp-inputrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#wallpaper-page .wp-input {
  height: 34px; padding: 0 12px; width: 100%; min-width: 0;
  background: var(--inset-bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); font-size: 13px; outline: none; box-shadow: var(--inset-edge);
  transition: box-shadow var(--dur-base) var(--ease-in-out), border-color var(--dur-base) var(--ease-in-out);
}
#wallpaper-page .wp-inputrow > .wp-input { flex: 1 1 220px; width: auto; }
#wallpaper-page .wp-input::placeholder { color: var(--faint); }
#wallpaper-page .wp-input:hover { border-color: var(--line-str); }
#wallpaper-page .wp-input:focus {
  border-color: var(--border);
  box-shadow: var(--inset-edge), 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}
/* 输入框同一行的按钮：与 34px 输入框等高（与 .field .btn-small 同一处理） */
#wallpaper-page .wp-inputrow > .btn,
#wallpaper-page .wp-ctrl .btn-small { height: 34px; padding-top: 0; padding-bottom: 0; flex: none; }
`;
}

/** 面板透明度：已并入 20-glass.js 的「全界面玻璃层」。
 *  透明度只有一个真值 config.ui.panelAlpha，由那套变量统一落成
 *  --layer-1/2/3、--inset-bg、--code-bg、顶栏与吸顶表头。
 *  这里保留空实现，只是为了不断开 wpRenderBackground 的调用链。
 *  别再在这里自己算一套 alpha：两套一起写，谁后写谁赢，会互相打架。 */
function wpApplyPanelAlpha(/* cfg */) { /* no-op：见上 */ }

/** 确保本页样式表已注入。
 *
 *  此前这张表（.wp-grid / .wp-cell / .wp-ctrl / .wp-hintbox…）和壁纸背景层的规则
 *  一起塞在 #wp-bg-style 里，而注入它的只有 wpRenderBackground()，且那函数第一句
 *  就是「没有 cfg 就 return」。结果是没选过壁纸的人、根本没装小红车的人，进壁纸页
 *  看到的是一坨裸 HTML（没有网格、没有卡片、没有字号）。
 *
 *  页面样式和"当前有没有启用壁纸"无关，进页就注入，幂等。
 *  wpRenderBackground() 里那段 `if (!$('#wp-bg-style'))` 会自动复用它，不会重复插。 */
function wpEnsurePageCss() {
  if (document.getElementById('wp-bg-style')) return;
  const style = document.createElement('style');
  style.id = 'wp-bg-style';
  style.textContent = wpGlassCss();
  document.head.appendChild(style);
}

/** 字体颜色预设：正文/标题/次要灰字整套替换（同色透明度分层保持阅读层级），
 *  强调色不动（归莫奈管）。值挑的都是明暗壁纸上都读得清的亮度档。 */
const WP_TEXT_PRESETS = {
  theme:  { label: '主题', swatch: 'linear-gradient(135deg,#e3e6ef,#17191d)' },
  white:  { label: '白', tx: [242, 244, 248] },
  black:  { label: '黑', tx: [23, 25, 29] },
  blue:   { label: '蓝', tx: [110, 168, 255] },
  yellow: { label: '黄', tx: [255, 215, 94] },
  green:  { label: '绿', tx: [127, 216, 143] },
  pink:   { label: '粉', tx: [255, 158, 203] },
  purple: { label: '紫', tx: [195, 161, 255] }
};
function wpApplyText(cfg) {
  const html = document.documentElement;
  const key = cfg?.text && WP_TEXT_PRESETS[cfg.text] ? cfg.text : 'theme';
  if (key === 'theme') html.removeAttribute('data-text');
  else html.setAttribute('data-text', key);
}

/** 按 localStorage 配置铺/清背景层。可重复调用（幂等）。 */
/* 底色不透明度 = 100 时给 html 挂 data-wp-veil='on'，由 wpGlassCss 里那条规则
   把残留的壁纸层/压暗罩收起来（见那边的注释）。真值在 config.ui.frameAlpha。 */
function wpSyncVeil() {
  try {
    const fa = Math.round(Number(state?.config?.ui?.frameAlpha ?? 100));
    if (Number.isFinite(fa) && fa >= 100) document.documentElement.setAttribute('data-wp-veil', 'on');
    else document.documentElement.removeAttribute('data-wp-veil');
  } catch { /* state 还没就绪 */ }
}

/* 改「底色不透明度」（config.ui.frameAlpha）的唯一入口：即时生效 + 落盘 + 同步设置页滑条。
   「用底色遮住」按钮传 100，选壁纸时传 0，两边必须走同一套，否则一个改了 DOM、
   另一个没改 state，滑条和实际值就会打架。 */
function wpSetFrameAlpha(v) {
  try {
    if (typeof state === 'undefined' || !state.config) return;
    const next = Math.max(0, Math.min(100, Math.round(Number(v))));
    if (!Number.isFinite(next)) return;
    const cur = Math.round(Number(state.config.ui?.frameAlpha ?? 100));
    if (cur === next) { wpSyncVeil(); return; }
    state.config.ui = { ...(state.config.ui || {}), frameAlpha: next };
    // 必须传整份 ui：00-core 的 applyUiCustom 对缺失字段是"清掉"语义
    // （强调色传空就 removeProperty），只传 frameAlpha 会把强调色一起抹了。
    if (typeof applyUiCustom === 'function') applyUiCustom(state.config.ui);
    // 设置页那条滑条如果已经渲染过，同步数字，别让两边显示打架
    const fa = document.getElementById('cfg-framealpha');
    if (fa) fa.value = String(next);
    const fav = document.getElementById('framealpha-val');
    if (fav) fav.textContent = String(next);
    wpSyncVeil();
    // 只上报一个键：后端 updateConfig 是 deepMerge，不会动别的字段
    if (typeof api === 'function') {
      api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { frameAlpha: next } }) })
        .then((r) => { if (r?.config?.ui) state.config.ui = r.config.ui; })
        .catch(() => { /* 存不下就只本次生效 */ });
    }
  } catch { /* state 结构变化时忽略 */ }
}

function wpRenderBackground() {
  const html = document.documentElement;
  // 旧层全清再铺（视频元素重建，避免换壁纸时残留旧画面）
  // 视频元素随之消失，看门狗必须先停，否则无视频时仍每 3 秒空转（F7 BUG-3）。
  wpStopVideoWatchdog();
  $$('.wp-bg-el').forEach((el) => el.remove());
  wpSyncVeil();
  const cfg = wpCfgLoad();
  if (!cfg || !cfg.id) {
    html.removeAttribute('data-wp');
    html.removeAttribute('data-monet');
    html.removeAttribute('data-text');
    $('#wp-bg-dim')?.remove();
    wpMonetApply(null);
    return;
  }
  if (!$('#wp-bg-style')) {
    const style = document.createElement('style');
    style.id = 'wp-bg-style';
    style.textContent = wpGlassCss();
    document.head.appendChild(style);
  }
  html.setAttribute('data-wp', 'on');
  html.setAttribute('data-monet', cfg.monet === false ? 'off' : 'on');
  html.style.setProperty('--wp-blur', `${Number(cfg.blur ?? 18)}px`);
  html.style.setProperty('--wp-dim', String(Number(cfg.dim ?? 0.25)));
  wpApplyPanelAlpha(cfg);
  wpApplyText(cfg);
  const dim = document.createElement('div');
  dim.id = 'wp-bg-dim';
  // 必须带 wp-bg-el：上面那句清理只认这个 class，漏了的话每渲染一次就多叠
  // 一层压暗（启动时 boot + 插件事件各跑一次 → 20% 变 36%，壁纸莫名发黑）。
  dim.className = 'wp-bg-el';
  document.body.appendChild(dim);
  const previewUrl = wpMediaUrl(cfg.id, 'preview');
  // contain 模式的模糊底：先铺（DOM 顺序在主媒体层之下）
  const backdrop = document.createElement('div');
  backdrop.className = 'wp-bg-el';
  backdrop.id = 'wp-bg-backdrop';
  backdrop.style.backgroundImage = `url("${previewUrl}")`;
  document.body.appendChild(backdrop);
  if (cfg.kind === 'video') {
    const v = document.createElement('video');
    v.className = 'wp-bg-el';
    v.id = 'wp-bg-video';
    v.autoplay = true; v.muted = true; v.loop = true;
    v.setAttribute('playsinline', '');
    v.src = wpMediaUrl(cfg.id, 'media');
    // 隐藏期创建的 autoplay 不生效：加载完成后（可见时）补播
    v.addEventListener('canplay', () => wpEnsureVideoPlaying(), { once: true });
    /* 首帧就绪：contain 模式的模糊底在视频没画面时是 force 关掉的（见
       wpApplyFraming），这里补一次取景，视频有画面了才允许它出来填两侧留白。 */
    v.addEventListener('loadeddata', () => {
      const cur = wpCfgLoad();
      if (cur && cur.id === cfg.id) wpApplyFraming(cur);
    }, { once: true });
    // 编码/容器播不了（老编码、损坏文件）→ 自动降级为静态预览图，别黑屏
    v.addEventListener('error', () => {
      const cur = wpCfgLoad();
      if (cur && cur.id === cfg.id) { cur.kind = 'still'; wpCfgSave(cur); wpRenderBackground(); }
    }, { once: true });
    document.body.appendChild(v);
    wpEnsureVideoPlaying();
    wpStartVideoWatchdog();
  } else {
    const d = document.createElement('div');
    d.className = 'wp-bg-el';
    d.id = 'wp-bg-img';
    d.style.backgroundImage = `url("${previewUrl}")`;
    document.body.appendChild(d);
  }
  wpApplyThemeSmart(cfg);
}

// 视频壁纸的播放保障。Chromium 两个经典坑都会让视频"停在那不动"
// （表现：背景只剩模糊预览图，看起来像动态壁纸渲染失败）：
//   1) 页面隐藏期间创建的 autoplay 不生效（Electron 窗口 show:false 的
//      启动阶段就是隐藏的），回前台必须手动补 play()；
//   2) play() 的 Promise 会被 AbortError 拒绝（加载中暂停/换源竞态），
//      静默吞掉就永远停在 paused（实测 play→playing→pause 连发，时间轴冻结）。
// 策略：可见就确保在播：带重试的 play() + canplay 事件补播 + 3 秒一次的
// 轻量看门狗（无视频/隐藏/本就暂停条件不满足时立即返回，零成本）。
//
// 看门狗**按需启停**：只在页面上存在 #wp-bg-video 时运行（wpRenderBackground
// 创建 <video> 后启动、重铺/移除壁纸前停止）。常驻 setInterval 在无壁纸时是
// 纯空转，而且没有任何生命周期管理（F7 BUG-3）。不在回调里加 if 早退来"省"——
// 那仍然占着定时器，只是提前返回。
let wpPlayRetry = 0;
let wpVideoTimer = null;
function wpStartVideoWatchdog() {
  if (wpVideoTimer) return;
  wpVideoTimer = setInterval(wpEnsureVideoPlaying, 3000);
}
function wpStopVideoWatchdog() {
  if (!wpVideoTimer) return;
  clearInterval(wpVideoTimer);
  wpVideoTimer = null;
}
function wpEnsureVideoPlaying() {
  const v = document.getElementById('wp-bg-video');
  if (!v || document.hidden || v.paused === false || v.ended) return;
  v.play().then(() => { wpPlayRetry = 0; }).catch(() => {
    if (++wpPlayRetry <= 8) setTimeout(wpEnsureVideoPlaying, 800);   // 瞬态拒绝：~6 秒内重试
  });
}
document.addEventListener('visibilitychange', () => {
  const v = document.getElementById('wp-bg-video');
  if (!v) return;
  if (document.hidden) v.pause();          // 切走/最小化：省一路解码
  else { wpPlayRetry = 0; wpEnsureVideoPlaying(); }
});

// ── 与后端同步（机器人换壁纸 → 控制台实时跟随）─────────────────────────
// 控制台本地 localStorage 是主状态；每次保存顺路 POST 给后端一份镜像，
// 后端（或 QQ 聊天里的机器人技能）改状态后广播 wallpaper-changed，这里
// 拉回来应用。失败全部静默：后端是旧版本时功能自然退化为纯本地。
// 同步规则（非对称，防回环/防误清空）：
//   远端有壁纸且与本地不同 → 远端为准（机器人或别的窗口改的）；
//   远端为空而本地有      → 只把本地推回去重新对齐，绝不清用户的选择。
const WP_CFG_FIELDS = ['id', 'title', 'kind', 'blur', 'dim', 'monet', 'fit'];
function wpPushState(cfg) {
  if (typeof api !== 'function') return;
  api('/api/wallpaper/state', {
    method: 'POST',
    body: JSON.stringify(wpCfgCanonical(cfg))
  }).catch(() => { /* 旧后端/离线：本地照常 */ });
}
function wpCfgCanonical(cfg) {
  if (!cfg || !cfg.id) return null;
  return {
    id: String(cfg.id),
    title: String(cfg.title || cfg.id),
    kind: cfg.kind === 'video' ? 'video' : 'still',
    blur: Number(cfg.blur ?? 18),
    dim: Number(cfg.dim ?? 0.25),
    monet: cfg.monet !== false,
    fit: ['cover', 'contain', 'smart'].includes(cfg.fit) ? cfg.fit : 'smart',
    // panel 只是 config.ui.panelAlpha 的历史镜像副本。默认 1（=100%）而不是旧版的
    // 0.46：wpPullState 在"本地有、远端空"时会把这个值推回后端，0.46 的默认值
    // 会让一份从没调过透明度的配置凭空变成 46%。真值始终以 config.ui.panelAlpha 为准。
    panel: Math.max(0.1, Math.min(1, Number(cfg.panel ?? 1) || 1)),
    text: ['theme', 'white', 'black', 'blue', 'yellow', 'green', 'pink', 'purple'].includes(cfg.text) ? cfg.text : 'theme'
  };
}
async function wpPullState() {
  if (typeof api !== 'function') return;
  try {
    const r = await api('/api/wallpaper/state');
    if (!r?.ok || !('cfg' in r)) return;   // 旧后端没有这个接口
    const remote = wpCfgCanonical(r.cfg);
    const local = wpCfgLoad();
    const localCanon = wpCfgCanonical(local);
    if (JSON.stringify(remote) === JSON.stringify(localCanon)) return;
    if (remote) {
      // 保留本地已分析好的焦点/取色缓存（同一张壁纸才有效）
      const merged = { ...remote };
      if (local?.id === remote.id) {
        if (local.fitCache) merged.fitCache = local.fitCache;
        if (local.monetCache) merged.monetCache = local.monetCache;
      }
      wpCfgSaveLocal(merged);
      wpRenderBackground();
      if (document.getElementById('wallpaper-page')?.offsetParent !== null) loadWallpaperPage();
    } else if (localCanon) {
      wpPushState(local);   // 本地有而远端空：把本地补推回去
    }
  } catch { /* 静默 */ }
}
function wpCfgSaveLocal(cfg) {
  try { cfg ? localStorage.setItem(WP_STORE_KEY, JSON.stringify(cfg)) : localStorage.removeItem(WP_STORE_KEY); }
  catch { /* 静默 */ }
}
// SSE：机器人换壁纸的实时通道（无 SSE 环境退化为不跟随，无副作用）
if (typeof EventSource !== 'undefined') {
  try {
    // EventSource 发不了自定义头，令牌必须走 withToken() 的 ?token=；
    // 漏了它配置 server.token 后这条连接恒 401，wallpaper-changed 永远收不到。
    const wpEs = new EventSource(withToken('/api/events'));
    wpEs.addEventListener('wallpaper-changed', () => wpPullState());
  } catch { /* 静默 */ }
}

// defer 脚本在 DOM 解析完、首帧绘制前执行，开机直接恢复壁纸，基本无闪白
wpRenderBackground();
wpPullState();

// ── 「壁纸」管理页 ───────────────────────────────────────────────────────
function wpActiveId() { return wpCfgLoad()?.id || ''; }

function wpBadge(item) {
  if (item.dyn) return '<span class="wp-badge mov">▶ 动态 · 无缝循环</span>';
  if (item.kind === 'video') return '<span class="wp-badge mov">▶ 动态</span>';
  if (String(item.type).toLowerCase() === 'web') return '<span class="wp-badge">网页 · 仅预览</span>';
  return '<span class="wp-badge">静态</span>';
}

/** 能否转动态：场景（录 WE 渲染窗）或源视频（截段+无缝循环）。
 *  后端 dynSupported=false 时整条链路都跑不通（非 Windows 没有 ddagrab），
 *  直接不渲染入口，与运行时的 unsupported_platform 提示形成两层：
 *  一层防用户白点，一层防页面数据过期。 */
function wpCanDyn(it, dynSupported) {
  if (dynSupported === false) return false;
  return String(it.type || '').toLowerCase() === 'scene' || (it.kind === 'video' && !it.dyn);
}

function wpPageHtml(data, cfg, settings) {
  // 平台不支持动态壁纸时给一句固定说明：入口全藏掉之后，用户看到的只是
  // "怎么没有转动态按钮"，不解释就变成另一个无从自查的谜。
  const dynNote = data.dynSupported === false
    ? '<div class="muted" style="padding:0 2px 10px">动态壁纸录制依赖 Windows 的 ddagrab 桌面抓取与 Wallpaper Engine，macOS / Linux 上不可用。</div>'
    : '';
  const cells = (data.items || []).map((it) => `
    <button class="wp-cell ${it.id === (cfg?.id || '') ? 'on' : ''}" data-id="${esc(it.id)}" title="${esc(it.title)}">
      <div class="wp-thumb">
        ${it.hasPreview ? `<img loading="lazy" decoding="async" src="${wpMediaUrl(it.id, 'preview')}" alt="" referrerpolicy="no-referrer">` : ''}
        ${wpBadge(it)}
      </div>
      <div class="wp-name">${esc(it.title)}</div>
      <div class="wp-sub">${esc(it.kind === 'video' ? '视频壁纸' : '场景/图片 · 用预览图')} · ${esc(it.source === 'workshop' ? '创意工坊' : '本地')}</div>
      ${wpCanDyn(it, data.dynSupported) && !it.dyn ? `<div class="wp-dynrow"><span class="wp-dyn" role="button" tabindex="0" data-id="${esc(it.id)}">⚡ 转动态壁纸</span><span class="wp-sub" style="padding:0">${it.type === 'scene' ? '录制渲染窗' : '无缝循环'}</span></div>` : ''}
      ${it.dyn && data.dynSupported !== false ? `<div class="wp-dynrow"><span class="wp-redo" role="button" tabindex="0" data-id="${esc(it.id)}" title="录坏了？清掉缓存重新录制">↻ 重新录制</span></div>` : ''}
    </button>`).join('');
  const fit = cfg?.fit || 'smart';
  // 界面透明度：真值在 config.ui.panelAlpha（和设置页同一条滑条）。
  // 壁纸配置里的 panel 只是同值的历史副本，读不到配置时才拿它兜底。
  const panelPct = (() => {
    try {
      if (typeof state !== 'undefined' && state.config?.ui) {
        const n = Math.round(Number(state.config.ui.panelAlpha ?? 100));
        if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
      }
    } catch { /* state 还没就绪 */ }
    // 兜底：壁纸配置里的历史副本；再兜底就回到"100 = 原样不透明"，
    // 与 00-core.js 里 clampInt(u.panelAlpha, 0, 100, 100) 的默认值一致。
    // （旧版这里写 0.46，配置还没加载时会闪一下 46%，看着像自己乱跳。）
    return Math.round((Number(cfg?.panel ?? 1)) * 100);
  })();
  // 「用底色遮住」= 把 config.ui.frameAlpha（设置页「底色不透明度」同一个键）拉到 100，
  // 用不透明底色把壁纸盖住，不清空壁纸配置。旧版是 wpCfgSave(null)，选择直接丢了，
  // 想看回来还得重新挑。
  // 想恢复透明：设置 → 外观个性化 → 底色不透明度 调回 0（同一个键，两边联动）。
  // 这个按钮不叫「关闭壁纸」：它只盖住壁纸，html[data-wp='on'] 和壁纸选择都还在，
  // 所以 #app-bg 仍是 display:none，设置里的本地背景图照样显示不出来。
  // 真正的"关闭壁纸"（清选择、摘 data-wp、让本地图回来）在
  // 设置 → 外观与数据 → 界面背景 → 「关闭壁纸」。两个按钮同名会让人分不清。
  return `
  <div class="usage-wrap">
    <div class="usage-head">
      <h3 style="margin:0">🖼️ 控制台壁纸</h3>
      <span class="muted wp-weinfo" title="${esc(data.weDir)}">Wallpaper Engine 壁纸库 · ${data.count} 张 · <code>${esc(data.weDir)}</code></span>
      <!-- 三颗按钮包成一组：.usage-head 是 flex-wrap:wrap，不包的话最后一个
           「用底色遮住」会被挤到第二行、孤零零贴在左边（990px 页宽下必现）。
           ⚠️ 这一行**不放 flex:1 占位块**，wrap 是先按自然宽度排、放不下才换行，
           占位块会把说明挤到换行；改成让 .wp-weinfo 自己 flex:1 1 0（见样式）。 -->
      <span class="wp-headbtns">
        <button class="btn btn-small" id="wp-back" title="回到 设置 → 外观与数据 → 界面背景">← 外观与数据</button>
        <button class="btn btn-small" id="wp-refresh">刷新列表</button>
        <button class="btn btn-small" id="wp-flat" title="把「底色不透明度」拉到 100，用界面底色把壁纸整个盖住。⚠️ 这只是遮住 —— 壁纸选择还在，设置里的本地背景图仍然显示不出来。要真正关掉壁纸、让本地图片回来：设置 → 外观与数据 → 界面背景 → 关闭壁纸。想恢复透明：直接点一张壁纸（会自动放回透明），或去设置把「底色不透明度」调回 0"${cfg ? '' : ' hidden'}>用底色遮住</button>
      </span>
    </div>
    <div class="wp-ctrl">
      <label>模糊 <input type="range" id="wp-blur-r" min="0" max="40" step="1" value="${Number(cfg?.blur ?? 18)}"> <span id="wp-blur-v">${Number(cfg?.blur ?? 18)}px</span></label>
      <label>压暗 <input type="range" id="wp-dim-r" min="0" max="70" step="5" value="${Math.round((Number(cfg?.dim ?? 0.25)) * 100)}"> <span id="wp-dim-v">${Math.round((Number(cfg?.dim ?? 0.25)) * 100)}%</span></label>
      <label title="整界面透明度：面板/卡片/输入框/弹窗/顶栏共用这一条（与「设置 → 界面 → 面板透明度」是同一个值）">界面 <input type="range" id="wp-panel-r" min="0" max="100" step="5" value="${panelPct}"> <span id="wp-panel-v">${panelPct}%</span></label>
      <label>字体 <span class="wp-swatches">${Object.entries(WP_TEXT_PRESETS).map(([k, p]) => `
        <span class="wp-sw${(cfg?.text || 'theme') === k ? ' on' : ''}" role="button" tabindex="0" data-text-key="${k}" title="字体：${p.label}"
          style="background:${p.tx ? `rgb(${p.tx.join(',')})` : p.swatch}"></span>`).join('')}</span></label>
      <label>取景 <select id="wp-fit-s">
        <option value="smart"${fit === 'smart' ? ' selected' : ''}>智能（按画面主体）</option>
        <option value="cover"${fit === 'cover' ? ' selected' : ''}>填满裁剪</option>
        <option value="contain"${fit === 'contain' ? ' selected' : ''}>完整显示</option>
      </select></label>
      <label><input type="checkbox" id="wp-monet-c"${cfg?.monet !== false ? ' checked' : ''}> 莫奈取色（强调色跟随壁纸）</label>
      <span class="muted" style="font-size:11px" title="颜色跟随壁纸的取色引擎；降级模式=vendor-md3.js 未装，功能仍可用但色阶较粗">取色引擎：${typeof md3 === 'object' && md3 ? 'MD3 完整' : '内置降级 ⚠ 补装 vendor-md3.js'}</span>
      <span class="muted" style="font-size:12px" id="wp-selected">选中的壁纸：${cfg ? esc(cfg.title || cfg.id) : '（未启用）'}</span>
    </div>
    <div class="wp-ctrl" id="wp-settings" style="border-top:1px dashed var(--line);padding-top:10px;margin-top:0">
      <label title="留空会自动按注册表和常见 Steam 路径探测；探不到再手填 wallpaper_engine 安装根目录（里面要有 wallpaper64.exe）">小红车目录
        <input class="wp-input" type="text" id="wp-wedir" placeholder="留空自动探测" style="width:190px" value="${esc(settings?.wallpaperEngineDir || '')}">
        <button class="btn btn-small" type="button" id="wp-wedir-browse">浏览…</button></label>
      <label title="默认关：壁纸只是控制台功能，模型看不见任何壁纸工具，零 token 成本。打开后注册 8 个工具 + 2 段提示词，模型能按群聊指令换/控壁纸，代价约 1358 tok/次 LLM 调用。改完要重启应用。">聊天里可控制壁纸 <input type="checkbox" id="wp-llm-c"${settings?.llmControl === true ? ' checked' : ''}></label>
      <label title="允许在 QQ 聊天里控制台壁纸的 QQ 号，多个用空格或逗号分隔；留空 = 谁都不能用（桌面壁纸不受此限）。仅在打开「聊天里可控制壁纸」后才有意义。">管家白名单 <input class="wp-input" type="text" id="wp-whitelist" placeholder="QQ 号，留空=上锁" style="width:140px"${settings?.llmControl === true ? '' : ' disabled'} value="${esc(settings?.whitelist || '')}"></label>
      <button class="btn btn-small" id="wp-settings-save">保存设置</button>
      <span class="muted" id="wp-settings-msg" style="font-size:11px"></span>
    </div>
    ${dynNote}
    <div class="wp-grid">${cells || '<div class="wp-hintbox">壁纸库里没有可用的壁纸。</div>'}</div>
  </div>`;
}

/* 回设置：这一页是从「设置 → 外观与数据 → 界面背景 → 打开壁纸库…」点进来的。
   顶栏此刻高亮的是「设置」，左栏二级导航（#settings-sidebar）是收起的
   （syncChrome 对壁纸页走 is-none），所以页面上不给回头路就是把人扔在这儿。
   回到 'app' 分区并滚到「界面背景」那一节，正好是进来的地方。 */
function wpBackToSettings() {
  try { state.settingsSection = 'app'; } catch { /* state 未就绪 */ }
  switchTab('settings');
  // 设置页是异步渲染的，等一拍再滚；找不到锚点就停在页面顶部，不算失败。
  setTimeout(() => {
    const anchor = document.getElementById('settings-bg');
    if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, 140);
}

/* ── 壁纸库弹窗 ──────────────────────────────────────────────────────
   入口：设置 → 外观与数据 → 界面背景 → 「🎨 打开壁纸库…」。
   做成弹窗而不是设置的下级整页：这里每点一张壁纸都是即时生效的（背景当场就换），
   选完就该原路回去。整页跳转会把"看一眼就回去"变成"切页 → 挑 → 再切回设置"，
   而且设置页的滚动位置、展开的分区全丢。弹窗浮在设置之上，点 ✕ 回到原处。
   #wallpaper-page 是搬家不是重建：同一个 DOM 节点换宿主，节点上的监听器原样带走，
   loadWallpaperPage() 一个字都不用改。
   搬回来必须挂在 overlay 的 qa-close 上：closeModelModal 的四条关闭路径
   （✕ / Esc / 点遮罩 / 自己的「关闭」按钮）全部汇合到那一个事件。挂在自己的
   关闭按钮上会漏掉另外三条，结果是弹窗一关 #wallpaper-page 就被一起 remove() 掉，
   再点「打开壁纸库」什么都不发生。 */
let wpLibOverlay = null;

function wpOpenLibrary() {
  const page = document.getElementById('wallpaper-page');
  const dock = document.getElementById('view-wallpaper');
  if (!page || !dock) return;
  if (wpLibOverlay && wpLibOverlay.isConnected) return;   // 已经开着，别叠第二层
  // 弹窗壳没加载（08-modals.js 被裁掉的构建）：退回整页，功能不能丢
  if (typeof modelModalShell !== 'function') {
    if (typeof switchTab === 'function') switchTab('wallpaper');
    return;
  }
  const overlay = modelModalShell({
    head: '控制台壁纸',
    body: `<p class="wp-lib-desc">把 Wallpaper Engine（小红车）的壁纸选作控制台背景。点一张即刻生效，关掉这个窗口就能在背后看到效果 —— 模糊、压暗、界面透明度都是即时预览。</p>`,
    foot: `<button class="btn" type="button" id="wp-lib-close">关闭</button>`
  });
  overlay.classList.add('wp-lib');
  // 壁纸选择、滑条全部即时生效，这里没有"未保存的修改"这回事，
  // 不关掉守卫的话，拖一下模糊滑条再关弹窗就会弹「是否丢弃修改」。
  overlay._noDirtyGuard = true;
  page.classList.remove('settings-pane');
  page.classList.add('wp-lib-pane');
  overlay.querySelector('.model-modal-body').appendChild(page);
  overlay.querySelector('#wp-lib-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.addEventListener('qa-close', () => {
    // 先搬回停靠点，再让 overlay 自毁（closeModelModal 派发完 qa-close 才 remove）
    page.classList.remove('wp-lib-pane');
    page.classList.add('settings-pane');
    dock.appendChild(page);
    // 弹窗背后是设置页：换了壁纸回来，状态行 /「当前壁纸」/「↩ 恢复上次」三处
    // 都得跟着变，否则看到的是进来之前那份（refreshBgStatus 由 07 挂在 window 上）。
    if (typeof window.refreshBgStatus === 'function') window.refreshBgStatus();
    if (wpLibOverlay === overlay) wpLibOverlay = null;
  });
  wpLibOverlay = overlay;
  loadWallpaperPage();
}

/* 壁纸库不可用时的空状态。
   「电脑上没装小红车」和「内置模块没加载起来」是两回事：前者用户自己能解决
   （装上，或手填安装目录），后者是安装/开发问题。以前两种都甩同一句
   「壁纸功能不可用」外加 src/wallpaper 的实现细节，既不是这个软件的语言，
   也没给出路。现在分开写，且第一种直接把目录输入框摆在页面上。 */
function wpMissingHtml(msg) {
  const weMissing = /没有找到 Wallpaper Engine/i.test(msg);
  return `<div class="usage-wrap">
    <div class="usage-head">
      <h3 style="margin:0">🖼️ 控制台壁纸</h3>
      <span class="muted">Wallpaper Engine 壁纸库</span>
      <span style="flex:1"></span>
      <button class="btn btn-small" id="wp-back" title="回到 设置 → 外观与数据 → 界面背景">← 外观与数据</button>
    </div>
    <div class="wp-empty">
      <div class="wp-empty-ico" aria-hidden="true">${weMissing ? '🎨' : '🧩'}</div>
      <div class="wp-empty-body">
        <h4>${weMissing ? '还没找到 Wallpaper Engine' : '壁纸库没能加载'}</h4>
        <p>${esc(msg)}</p>
        ${weMissing ? `
          <p class="muted">装好 Wallpaper Engine（Steam 里的「Wallpaper Engine：壁纸引擎」）后点「重新检测」。
            装在非默认库、或用的是绿色版时，把安装根目录填在下面 —— 目录里要有 <code>wallpaper64.exe</code>。</p>
          <div class="wp-field">
            <label for="wp-dir-input">安装根目录</label>
            <div class="wp-inputrow">
              <input class="wp-input" type="text" id="wp-dir-input" spellcheck="false" autocomplete="off"
                placeholder="例如 D:\\Steam\\steamapps\\common\\wallpaper_engine">
              <button class="btn btn-small" type="button" id="wp-dir-browse">浏览…</button>
              <button class="btn btn-small btn-primary" type="button" id="wp-dir-save">保存并重试</button>
              <button class="btn btn-small" type="button" id="wp-retry">重新检测</button>
            </div>
          </div>
          <div class="wp-empty-row"><span class="muted" id="wp-dir-msg" style="font-size:11px">点「浏览…」选择文件夹，也可以直接把路径粘进来。</span></div>`
        : `
          <p class="muted">内置模块 <code>src/wallpaper/</code> 没能加载。若刚更新过文件，重启一次 QQ Agent 通常就能恢复。</p>
          <div class="wp-empty-row"><button class="btn btn-small" id="wp-retry">重新检测</button></div>`}
      </div>
    </div>
  </div>`;
}

/* 空状态上的按钮：都只改这一页，不碰别处。
   保存目录走的是和正常页「保存设置」同一条 /api/config（deepMerge 只改这一个键），
   别另开接口，两套写同一字段早晚打起来。 */
function wpBindMissing() {
  $('#wp-back')?.addEventListener('click', wpBackToSettings);
  $('#wp-retry')?.addEventListener('click', () => loadWallpaperPage());
  const saveDir = async () => {
    const btn = $('#wp-dir-save');
    const hint = $('#wp-dir-msg');
    const dir = ($('#wp-dir-input')?.value || '').trim();
    if (!dir) { if (hint) hint.textContent = '先把安装目录填上'; return; }
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '保存中…';
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ skills: { wallpaper: { wallpaperEngineDir: dir } } })
      });
      if (hint) hint.textContent = '已保存，正在重新检测…';
      loadWallpaperPage();
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e?.message || e}`;
      if (btn) btn.disabled = false;
    }
  };
  $('#wp-dir-save')?.addEventListener('click', saveDir);
  // 选完目录直接存 + 重扫：这个框只出现在「扫不到壁纸库」的报错页上，
  // 选了目录就等于"我要用这个"，再让人多点一次「保存并重试」是多余的。
  // （正常页的「小红车目录」不自动存，那行还有别的字段要一起保存。）
  wpBindDirPicker($('#wp-dir-input'), $('#wp-dir-browse'), saveDir);
}

/* 目录输入框 → 原生「选择文件夹」。
   像 D:\Steam\steamapps\common\wallpaper_engine 这种路径让人肉眼抄一遍是折磨，
   抄错一个字符还只会得到"目录不存在"，很难自查。
   只在桌面桥存在时给这条路：纯浏览器里打开控制台时拿不到原生对话框，
   那就把「浏览…」藏掉、输入框照旧手填/粘贴，不做一枚点了没反应的按钮。 */
function wpPickDir(input, onPicked) {
  const bridge = window.qqaDesktop;
  if (!bridge || typeof bridge.pickDirectory !== 'function') return false;
  Promise.resolve(bridge.pickDirectory()).then((r) => {
    // 取消 / 无返回值：输入框一个字都不动（用户可能是想手填）
    if (!r || !r.ok || !r.path) return;
    if (input) {
      input.value = r.path;
      input.focus();
    }
    if (typeof onPicked === 'function') onPicked(r.path);
  }).catch(() => { /* 对话框打不开（远程会话/权限）时保持手填可用，不弹错 */ });
  return true;
}

/* 给一个输入框接上「浏览…」按钮。
   只在按钮上开对话框，点输入框不弹：输入框是给人打字/粘贴/选字改的，
   点一下就弹原生窗口会把最基本的"点进框里改一个字"变成"先关掉一个对话框"。 */
function wpBindDirPicker(input, btn, onPicked) {
  if (btn) {
    const hasPicker = !!(window.qqaDesktop && typeof window.qqaDesktop.pickDirectory === 'function');
    // 纯浏览器里没有原生对话框：藏掉按钮，手填/粘贴照旧，不做点了没反应的按钮
    if (!hasPicker) { btn.hidden = true; return; }
    btn.addEventListener('click', (e) => { e.preventDefault(); wpPickDir(input, onPicked); });
  }
}

async function loadWallpaperPage() {
  const box = $('#wallpaper-page');
  if (!box) return;
  // 先保样式：本页所有 .wp-* 规则都在 wpGlassCss() 里，而它以前只在
  // 「已经选了壁纸」时被注入，否则这个页面是裸 HTML（见 wpEnsurePageCss 注释）。
  wpEnsurePageCss();
  // 进页先按当前 frameAlpha 把「盖住壁纸」的状态对齐一次（首屏 state 未必就绪）
  wpSyncVeil();
  const seq = ++wpLoadSeq;
  box.innerHTML = '<div class="muted" style="padding:20px">正在扫描壁纸库…</div>';
  let data;
  try {
    data = await api('/api/wallpaper/list');
  } catch (e) {
    if (seq !== wpLoadSeq) return;
    box.innerHTML = wpMissingHtml(String(e?.message || e));
    wpBindMissing();
    return;
  }
  if (seq !== wpLoadSeq) return;
  if (!data.ok) {
    box.innerHTML = wpMissingHtml(String(data.error || '未知错误'));
    wpBindMissing();
    return;
  }
  wpItems = data.items || [];
  const cfg = wpCfgLoad();
  // 模块设置（小红车目录 / 管家白名单）：内置模块不出现在插件/技能列表里，
  // 它的设置就放本页。优先用已加载的 state.config，没有再拉一次（与 05 段同款）。
  let wpSettings = {};
  try {
    const all = (typeof state !== 'undefined' && state.config) || await api('/api/config');
    wpSettings = all?.skills?.wallpaper || {};
  } catch { /* 读不到就留空：输入框空着，保存时照常可写 */ }
  // kind 自愈：本地因某次瞬态错误被降级成 still（视频加载失败会持久降级），
  // 但列表最新认定它是可播视频（原生视频或已导入的动态循环）时，自动升回
  // video 并重铺背景，不用用户手点一遍才恢复。
  if (cfg?.id) {
    const it = wpItems.find((x) => x.id === cfg.id);
    if (it && it.kind === 'video' && cfg.kind !== 'video') {
      cfg.kind = 'video';
      wpCfgSave(cfg);
      wpRenderBackground();
    }
  }
  box.innerHTML = wpPageHtml(data, cfg, wpSettings);

  // 回设置（页头左起第一颗）。正常态和空状态都有这颗按钮，绑法一致。
  $('#wp-back')?.addEventListener('click', wpBackToSettings);
  $('#wp-refresh')?.addEventListener('click', () => loadWallpaperPage());
  // 小红车目录：「浏览…」按钮弹原生目录选择框（点输入框本身不弹，留给手填/粘贴）。
  // 这里不自动保存：同一行还有管家白名单，一起点「保存设置」才合理。
  wpBindDirPicker($('#wp-wedir'), $('#wp-wedir-browse'));
  // 模块设置保存：只上报这两个键（后端 updateConfig 是 deepMerge，不会碰别的字段）。
  $('#wp-settings-save')?.addEventListener('click', async () => {
    const btn = $('#wp-settings-save');
    const msg = $('#wp-settings-msg');
    const nextLlm = !!$('#wp-llm-c')?.checked;
    const patch = { skills: { wallpaper: {
      wallpaperEngineDir: ($('#wp-wedir')?.value || '').trim(),
      whitelist: ($('#wp-whitelist')?.value || '').trim(),
      // 对话侧开关：注册 8 个工具 + 2 段提示词（约 1358 tok/次调用）。
      // 别的键不动，后端 updateConfig 是 deepMerge。
      llmControl: nextLlm
    } } };
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      if (r?.config?.skills?.wallpaper && typeof state !== 'undefined' && state.config) {
        state.config.skills = { ...(state.config.skills || {}), wallpaper: r.config.skills.wallpaper };
      }
      if (msg) {
        // 工具注册发生在 setup（启动时），改完必须重启，说清楚，别让人以为保存就生效。
        msg.textContent = nextLlm !== (wpSettings?.llmControl === true)
          ? '已保存。聊天工具开关要重启应用才生效'
          : '已保存（目录下次扫描生效）';
      }
    } catch (e) {
      if (msg) msg.textContent = `保存失败：${e?.message || e}`;
    } finally { if (btn) btn.disabled = false; }
  });
  // 「用底色遮住」：不是清掉壁纸，而是把底色不透明度（config.ui.frameAlpha）拉到 100，
  // 壁纸选择、模糊、压暗、取色全部原样保留，只是被一层不透明底色挡住。
  // 恢复透明走设置页那条滑条（同一个键），或者直接在下面重新点一张壁纸，
  // 选壁纸会自动把底色放回透明。
  // 它不会让 #app-bg 回来：html[data-wp='on'] 仍成立，本地背景图还是隐藏的。
  // 要真正做到那一步，走设置里的「关闭壁纸」（清选择）。
  $('#wp-flat')?.addEventListener('click', () => wpSetFrameAlpha(100));
  const blurR = $('#wp-blur-r');
  const dimR = $('#wp-dim-r');
  blurR?.addEventListener('input', () => {
    $('#wp-blur-v').textContent = `${blurR.value}px`;
    document.documentElement.style.setProperty('--wp-blur', `${blurR.value}px`);
  });
  blurR?.addEventListener('change', () => {
    const c = wpCfgLoad() || { id: '', kind: 'still', title: '' };
    if (!c.id) return;   // 还没选壁纸：只存不了，等选了再落
    c.blur = Number(blurR.value); wpCfgSave(c);
  });
  dimR?.addEventListener('input', () => {
    $('#wp-dim-v').textContent = `${dimR.value}%`;
    document.documentElement.style.setProperty('--wp-dim', String(Number(dimR.value) / 100));
  });
  dimR?.addEventListener('change', () => {
    const c = wpCfgLoad() || { id: '', kind: 'still', title: '' };
    if (!c.id) return;
    c.dim = Number(dimR.value) / 100; wpCfgSave(c);
  });
  const panelR = $('#wp-panel-r');
  panelR?.addEventListener('input', () => {
    $('#wp-panel-v').textContent = `${panelR.value}%`;
    // 和设置页共用同一条滑条：只改一个全局变量，整界面一起重算。
    // （旧版这里调 wpApplyPanelAlpha，那套只覆盖名单内的几块，已废弃）
    if (typeof window.weSetGlassPercent === 'function') window.weSetGlassPercent(Number(panelR.value));
    else wpApplyPanelAlpha({ panel: Number(panelR.value) / 100 });   // 旧版兜底
  });
  panelR?.addEventListener('change', () => {
    const pct = Number(panelR.value);
    // 界面透明度是"整界面"偏好，落到 config.ui.panelAlpha（设置页读的是同一个键）。
    // 即便还没选壁纸也要能存，透明度跟壁纸是不是开着无关。
    try {
      if (typeof state !== 'undefined' && state.config) {
        state.config.ui = { ...(state.config.ui || {}), panelAlpha: pct };
        if (typeof api === 'function') {
          // 只上报 panelAlpha 一个键，不要把整份 state.config.ui 发回去：
          // state.config.ui 是页面加载时拿到的快照，里面还带着 bgImage / bgDim /
          // winOpacity 等别的字段；整份回传 = 用旧快照覆盖后端的新值，
          // 典型症状是"刚在设置页改好的背景图，拖一下透明度就退回去了"。
          // 后端 updateConfig 是 deepMerge，只给一个键就只动这一个键。
          api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { panelAlpha: pct } }) })
            .then((r) => { if (r?.config?.ui) state.config.ui = r.config.ui; })
            .catch(() => { /* 存不下就只本次生效 */ });
        }
      }
    } catch { /* state 结构变化时忽略 */ }
    const c = wpCfgLoad() || { id: '', kind: 'still', title: '' };
    if (!c.id) return;
    c.panel = pct / 100; wpCfgSave(c);
  });
  // 字体色板：点选即全界面正文变色（标题/正文/次要灰字同色系分层，
  // 强调色归莫奈）。跟随主题 = 恢复应用默认文字色。
  $$('.wp-sw', box).forEach((sw) => {
    const fire = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const c = wpCfgLoad();
      if (!c?.id) return;
      c.text = sw.dataset.textKey || 'theme';
      wpCfgSave(c);
      wpApplyText(c);
      $$('.wp-sw', box).forEach((x) => x.classList.toggle('on', x === sw));
    };
    sw.addEventListener('click', fire);
    sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
  });
  $('#wp-fit-s')?.addEventListener('change', () => {
    const c = wpCfgLoad();
    if (!c?.id) return;
    c.fit = $('#wp-fit-s').value;
    wpCfgSave(c);
    wpApplyFraming(c);   // 取景变化即时重排，不动媒体层
  });
  $('#wp-monet-c')?.addEventListener('change', () => {
    const c = wpCfgLoad();
    if (!c?.id) return;
    c.monet = $('#wp-monet-c').checked;
    wpCfgSave(c);
    document.documentElement.setAttribute('data-monet', c.monet ? 'on' : 'off');
    if (c.monet && c.monetCache?.id === c.id) wpMonetApply(c.monetCache);
  });
  $$('.wp-cell', box).forEach((cell) => {
    cell.addEventListener('click', () => {
      const it = wpItems.find((x) => x.id === cell.dataset.id);
      if (!it) return;
      const cur = wpCfgLoad() || {};
      wpCfgSave({
        id: it.id, title: it.title, kind: it.kind,
        blur: cur.blur ?? 18, dim: cur.dim ?? 0.25,
        panel: cur.panel ?? 0.46,
        text: cur.text || 'theme',
        monet: cur.monet ?? true, fit: cur.fit ?? 'smart'
      });
      // 选壁纸 = 我要看这张，底色不透明度一律放回 0（透明），
      // 否则点了「用底色遮住」之后再挑壁纸，背景被不透明底色挡着，看着像"选了没反应"。
      // 放在 wpRenderBackground() 之前：先撤遮盖，新铺的壁纸层就不用"藏起来再显示"。
      wpSetFrameAlpha(0);
      wpRenderBackground();
      // 只翻转选中态 + 更新提示行，不整页重渲染：缩略图不重新请求、
      // 滚动位置不丢、几十张图不重排，点选壁纸应当是即时的。
      $$('.wp-cell', box).forEach((c) => c.classList.toggle('on', c.dataset.id === it.id));
      // 别用 querySelector('.wp-ctrl .muted')：那取到的是第一个 .muted，
      // 也就是「取色引擎：MD3 完整」那一行，一点壁纸它就被改写成「选中的壁纸：…」，
      // 取色引擎提示凭空消失。按 id 取。
      const sel = $('#wp-selected', box);
      if (sel) sel.textContent = `选中的壁纸：${it.title}`;
      const flatBtn = box.querySelector('#wp-flat');
      if (flatBtn) flatBtn.hidden = false;
    });
  });

  // ⚡ 转动态 / ↻ 重新录制：提交导入任务 + 轮询进度（共用 runner）。
  // span 嵌在 <button> 里，点它不能触发选壁纸（stopPropagation）。
  // redo：先清服务端缓存再导，录坏成品的重录入口（否则内容哈希命中
  // 缓存，永远拿回同一条坏循环，表现为"只能转一次"）。
  const runImport = async (btn, id, redo) => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = redo ? '清缓存中…' : '提交中…';
    if (redo) {
      // 正在当视频播的壁纸，文件句柄被 <video> 占着删不掉（Windows）：
      // 先切回静态图释放句柄再让后端删缓存。
      const c = wpCfgLoad();
      if (c && c.id === id && c.kind === 'video') {
        c.kind = 'still';
        wpCfgSave(c);
        wpRenderBackground();
      }
    }
    // 失败原因（含 ffmpeg 安装指引这类长文案）必须整段给用户看：
    // 按钮上只放短句 + title 悬停，弹窗给全文。只在按钮上 slice 截断的话，
    // 用户就只能看到半句「装法：管理员/普通 Pow」。
    const wpImportFail = (btn, prefix, msg) => {
      const full = String(msg || '未知错误');
      btn.textContent = `✗ ${prefix}（点按钮重试）`;
      btn.title = full;
      alert(`转动态壁纸失败：\n\n${full}`);
    };
    // 缺 ffmpeg 是最常见也最容易自助解决的一类失败：与其让用户读一段
    // "去设置里下载"的说明，不如直接把人送过去并高亮那一块。
    // 判据是后端给的结构化原因码，不是匹配文案，文案改一句就断。
    const isMissingFfmpeg = (code) => code === 'ffmpeg_missing';
    // 平台本身不支持（macOS / Linux 没有 ddagrab 与 Wallpaper Engine）：
    // 装 ffmpeg 也录不出来，所以不能给"去安装"的引导，只把原因说清楚。
    const isUnsupportedPlatform = (code) => code === 'unsupported_platform';
    const wpImportFailUnsupported = (btn, msg) => {
      const full = String(msg || '动态壁纸录制在当前平台不可用');
      btn.textContent = '✗ 当前平台不支持动态壁纸';
      btn.title = full;
      btn.setAttribute('aria-disabled', 'true');   // 再点也不会有结果，直接禁用
      alert(full);
    };
    const wpImportFailWithGuide = (btn, msg) => {
      const full = String(msg || '未知错误');
      btn.textContent = '✗ 需要 ffmpeg（点此去安装）';
      btn.title = full;
      btn.removeAttribute('aria-disabled');
      btn.addEventListener('click', () => {
        if (typeof window.gotoFfmpegSettings === 'function') {
          window.gotoFfmpegSettings({ note: '转动态壁纸需要 ffmpeg，装好后再回来点一次' });
        }
      }, { once: true });
    };
    let r;
    try {
      r = await api('/api/wallpaper/import', { method: 'POST', body: JSON.stringify({ id, redo: !!redo }) });
    } catch (e) {
      wpImportFail(btn, '提交失败', e?.message || e);
      btn.removeAttribute('aria-disabled');
      return;
    }
    // 后端的两类"缺 ffmpeg"文案都带这句特征：checkFfmpeg 的安装引导
    // 与导入管线的报错。用它判断是否该走"一键去安装"，而不是靠宽松的 /ffmpeg/i
    // （正常的转码失败也可能提到 ffmpeg，那时给跳转是误导）。
    if (!r?.ok) {
      if (isUnsupportedPlatform(r?.errorCode)) wpImportFailUnsupported(btn, r?.error);
      else if (isMissingFfmpeg(r?.errorCode)) wpImportFailWithGuide(btn, r?.error);
      else wpImportFail(btn, '启动失败', r?.error || '未知错误');
      if (!isUnsupportedPlatform(r?.errorCode)) btn.removeAttribute('aria-disabled');
      return;
    }
    const timer = setInterval(async () => {
      let s;
      try { s = await api(`/api/wallpaper/import?job=${encodeURIComponent(r.job)}`); }
      catch { clearInterval(timer); btn.textContent = '✗ 查询失败'; return; }
      if (seq !== wpLoadSeq) { clearInterval(timer); return; }   // 页面已重渲染：旧按钮作废
      if (s?.ok && !s.done) {
        btn.textContent = `⏳ ${s.stage}${s.detail ? `·${s.detail}` : ''}`.slice(0, 60);
        return;
      }
      clearInterval(timer);
      if (s?.ok && s.done && !s.error) {
        btn.textContent = redo ? '✓ 已重录' : '✓ 已动态';
        setTimeout(() => loadWallpaperPage(), 600);   // 刷新徽标与选中态（kind 变 video）
      } else if (isUnsupportedPlatform(s?.errorCode)) {
        wpImportFailUnsupported(btn, s?.error);
      } else if (isMissingFfmpeg(s?.errorCode)) {
        wpImportFailWithGuide(btn, s?.error);
        btn.removeAttribute('aria-disabled');
      } else {
        wpImportFail(btn, s?.error ? '导入失败' : '导入失败', s?.error || '未知错误');
        btn.removeAttribute('aria-disabled');
      }
    }, 1000);
  };
  const wireImportBtn = (sel, redo) => $$(sel, box).forEach((btn) => {
    const fire = (e) => { e.stopPropagation(); e.preventDefault(); runImport(btn, btn.dataset.id, redo); };
    btn.addEventListener('click', fire);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fire(e); });
  });
  wireImportBtn('.wp-dyn', false);
  wireImportBtn('.wp-redo', true);
}
