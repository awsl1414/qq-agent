/* 主题预置：在样式生效前就定好 data-theme，避免首屏闪白/闪黑。
   优先级：localStorage 里的显式选择 > 系统偏好 > 暗色。
   这里只做"应用"，真正的切换逻辑与持久化在 app.js。
   必须是外链同步脚本，不能内联：CSP 是 script-src 'self'，
   内联脚本要维护 hash 白名单，一改就失效、被静默拦截。 */
(function () {
  try {
    var saved = localStorage.getItem('qqa-theme') || '';
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    // 合法值：dark / light / system / ?（整活主题）。未知值回退暗色。
    var theme = (saved === 'light' || saved === 'dark' || saved === '?') ? saved : (saved === 'system' ? sys : (saved || sys));
    if (theme !== 'light' && theme !== 'dark' && theme !== '?') theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
