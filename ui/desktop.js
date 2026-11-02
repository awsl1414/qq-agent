/* 无边框窗口的窗口控制（最小化 / 最大化 / 关闭）。
 *
 * ⚠️ 2026-10-09（r25）：这组按钮改为**常显**，本文件只负责"点得动"。
 *
 * 改之前的写法是：HTML 上带 hidden，本文件在有 window.qqaDesktop 时解除隐藏。
 * 三个代价，最后一个尤其致命：
 *   ① 用浏览器打开控制台（http://127.0.0.1:3210）或预览页（无 qqaDesktop）时，
 *      整组按钮消失 —— 与原型 v2（浏览器里也画着这三颗）不一致，
 *      三方对比时表现为"按钮没了"；
 *   ② 可见性依赖本文件跑成功：模块加载慢、脚本报错、渲染进程冻结
 *      （main.js 里 R44/R46 与看门狗记录的正是这种冻结）都会把它停在 hidden，
 *      用户看到的就是右上角一片空白 —— "这几颗按钮消失了"；
 *   ③ 首帧到首屏之间闪一下。
 * 现在：**看得见由 HTML/CSS 保证，点得动由这里保证**。
 * 没有桥时直接 return —— 按钮照旧留在顶栏（点不动），不再把它藏起来。
 *
 * 与 app.js 的分工：这里只管"窗口"，不碰任何业务状态，也不读写 localStorage；
 * 出错也不该影响机器人运行，所以全程 try/catch 兜底。
 */
(function () {
  const api = window.qqaDesktop;

  const box = document.getElementById('win-controls');
  if (!box) return;

  const minBtn = document.getElementById('win-min-btn');
  const maxBtn = document.getElementById('win-max-btn');
  const closeBtn = document.getElementById('win-close-btn');

  // 无桌面桥（浏览器 / 预览页）：按钮保留在页面上，但不绑事件，也不再隐藏。
  if (!api) return;

  minBtn?.addEventListener('click', () => api.minimize());
  maxBtn?.addEventListener('click', () => api.toggleMaximize());
  closeBtn?.addEventListener('click', () => api.close());

  // ── 最大化状态 ↔ 图标 ──────────────────────────────────────────────
  // 不用页面自己翻转布尔值：Win+↑、双击拖拽区、Aero Snap 都能改状态，
  // 以主进程事件为准才不会出现"图标说已最大化、窗口其实没有"。
  const applyMaximized = (isMax) => {
    box.classList.toggle('is-maximized', Boolean(isMax));
    if (maxBtn) {
      const label = isMax ? '还原' : '最大化';
      maxBtn.title = label;
      maxBtn.setAttribute('aria-label', label);
    }
  };

  try {
    // 首屏对齐：窗口可能以最大化状态启动
    Promise.resolve(api.isMaximized()).then(applyMaximized).catch(() => {});
    api.onMaximizeChange(applyMaximized);
  } catch (e) {
    console.warn('[desktop] 最大化状态订阅失败:', e);
  }

  // ── 双击顶栏空白处 = 最大化 / 还原（Windows 标题栏的固有习惯）────────
  // 拖拽区（-webkit-app-region: drag）的鼠标事件通常被系统直接吃掉，
  // 所以这里多数时候不会触发；系统自身通常已处理双击。保留纯粹是兜底：
  // 万一事件透传上来了，行为与系统一致，不会出现"双击没反应"。
  const topbar = document.getElementById('topbar');
  topbar?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, select, textarea, a, .top-status')) return;
    api.toggleMaximize();
  });
})();
