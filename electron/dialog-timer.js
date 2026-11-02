// 原生对话框的超时自消（2026-10-16 外部审查 #2）
//
// 与 dialog-safe.js 拆开的理由：那个文件要 `import { app, dialog } from 'electron'`，
// 而 electron 只在打包环境里装得上 —— 混在一起就意味着这套逻辑**没有任何自动化测试**。
// 而它恰恰是最容易写错的地方，两个坑：
//   ① 用户点了按钮却**没清定时器** → 进程想退时被未决的 timer 拖着（180s 档能拖三分钟），
//      表现为"点了退出但进程半天不退"；
//   ② 超时回调里再抛一次 → 退出路径上多一条未处理拒绝，反而更难查。
//
// 本文件不依赖 electron：超时动作由调用方注入（dialog-safe.js 负责补 app.quit 兜底）。

/**
 * 给一个"已经发出去"的对话框挂超时自消。
 *
 * @param {Promise} p                 dialog.showMessageBox 返回的 promise
 * @param {object} cfg
 * @param {number} cfg.autoCloseMs    超时（毫秒）；<=0 表示不超时
 * @param {Function} cfg.timeoutAction  超时后执行的动作（调用方需保证它不会抛）
 * @param {Function} [cfg.setTimer]   定时器工厂（测试注入）
 * @param {Function} [cfg.clearTimer] 清定时器（测试注入）
 * @returns {{cancel:Function}|null}
 */
export function scheduleAutoClose(p, {
  autoCloseMs = 0, timeoutAction = null, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  if (!(autoCloseMs > 0)) return null;

  let done = false;                 // true = 已收场（用户点了 / 已超时 / 手动取消）
  let timer = null;                 // 先声明：finish 里要清它，避免 TDZ 疑虑
  const finish = (act) => {
    if (done) return;
    done = true;
    // ① 无论哪种收场，定时器都必须清掉 —— 否则进程退出被未决 timer 拖着
    try { clearTimer(timer); } catch { /* 已触发过的定时器清不掉无所谓 */ }
    if (typeof act !== 'function') return;
    // ② 动作抛错时**吞掉**：这是退出路径，再抛只会变成未处理拒绝、把真正的退出
    //    原因盖住。调用方（dialog-safe）传入的兜底动作本身是 app.quit()，不会再抛。
    try { act(); } catch { /* 退出路径上不添乱 */ }
  };

  timer = setTimer(() => finish(timeoutAction), autoCloseMs);

  // 用户点了按钮（确定或取消）→ 收场并清掉定时器
  Promise.resolve(p).finally(() => finish(null));

  return { cancel: () => finish(null) };
}
