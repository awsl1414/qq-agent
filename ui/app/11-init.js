// 〔页签切换 / 启动〕
'use strict';

/** 清掉 R51「自由拖动排布」的遗留。12-layout.js 已整文件删除，但用户机器上可能还存着
 *  ① config.ui.layout（列宽 / 页签顺序 / 浮层位置）
 *  ② 元素行内样式里的 --pane-w（分隔条拖动写进去的）
 *  不清理的话这些存档永远不会再被读，但会一直躺在配置文件里。
 *  只在确实存过 layout 时才 POST，避免每次启动都白写一次盘。 */
function clearLegacyLayout() {
  document.querySelectorAll('[style*="--pane-w"]').forEach((el) => {
    try { el.style.removeProperty('--pane-w'); } catch { /* 忽略 */ }
  });
  const c = state.config || (state.config = {});
  const ui = c.ui || {};
  const had = ui.layout && typeof ui.layout === 'object';
  if (!had) return;                       // 从没存过 → 不白写一次盘
  c.ui = { ...ui, layout: { panes: {}, tabOrder: [], float: {} } };
  return api('/api/config', { method: 'POST', body: JSON.stringify({ ui: c.ui }) }).catch(() => {});
}
// ── 标签页切换 ──
// 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
// 结果漏了 usage 分支，点「用量」页签只切了视图、从不加载内容，
// 页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
// 两条路径各维护一份必然再次分叉。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 原生 <select> → 自绘下拉（主题风格 + 展开过渡动画）──
// 初始 DOM 里的和之后任何渲染塞进来的都会被自动接管（见 00-core.js 的说明）。
startSelectEnhancer();

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  // bootLoop 之前的一切都不许抛：启动链上任何一段抛错都会让 loading 壳
  // 永远挂着（appReady 永远 false，看门狗反复重载也每轮撞同一个错），
  // 群友反馈的"卡在加载界面"里有这一份。全部兜底，保证一定能走到 bootLoop。
  try { applyTheme(getThemePref()); } catch { /* 主题失败不影响启动 */ }
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }

  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();
  runUpdateCheck();                                 // 启动时静默查一次（失败不打扰）
  setInterval(() => runUpdateCheck(), 3600_000);    // 之后每小时查一次

  // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
  try {
    const cfg0 = await api('/api/config');
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) applyTheme(t);
    else if (cfg0 && !('ui' in cfg0)) { /* 后端还没这个字段，保持本地值 */ }
    // 外观个性化：强调色/底色/不透明度/背景图/整窗不透明度。
    // 必须在首屏就应用一次，否则"设了半透明"重启后要等用户点进设置页才生效。
    applyUiCustom(cfg0?.ui || {});
  } catch { /* 接口不可用就用本地的 */ }

  // 启动落点：固定进「会话」页（state.tab 默认 'sessions'）。
  //
  // 这里原先有一段"首启引导"：模型或白名单没配好就 switchTab('settings') 后 return，
  // 把用户直接抛去设置页。用户反馈「每次点开都在设置界面，我要的是直接进会话」，
  // 故移除该跳转。
  //
  // 不能只把 switchTab 换成 'chats' 了事：原分支 return 掉了下面三行初始化
  // （loadSessions / loadMemoryView / initSessionScrollLoader），只留
  // connectSSE + refreshStatus + startStatusPoller。若只换页签不补初始化，
  // 首启进会话页会是空的（会话列表不拉、滚动加载不挂）。
  // 所以这里无论配置是否齐全，都走同一条完整初始化路径。
  //
  // "还没配好"的提示由右下角横幅（renderBanner）+ 顶栏 4 个就绪圆点承担，
  // 它们本来就在实时反映状态，且点击可直达对应页。
  try {
    const cfg = await api('/api/config');
    state.config = state.config || cfg;
    // 清掉「自由拖动排布」的历史存档（config.ui.layout）与残留内联 --pane-w。
    // 刻意保持静默（只 warn 不提示用户）：这是乐观清理，失败了也不会
    // 造成任何功能问题（下次启动还会再试一次）。启动路径上弹框打断用户更差。
    try { clearLegacyLayout(); } catch (e) { console.warn('[layout] 清理旧排布失败：', e?.message ?? e); }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  startStatusPoller();
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
})();