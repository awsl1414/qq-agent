// 原生对话框的安全封装（2026-10-16 外部审查 #2）
//
// ── 病灶 ──────────────────────────────────────────────────────────────
// Electron **没有 API 能程序化关闭 showMessageBox**。而"无父窗口"的原生框是独立
// 顶层窗口 —— 每个都占一个任务栏按钮，且**点掉之前进程不退出**。群友截图里
// "任务栏冒出一排 QQ Agent"就是这个：一个真窗口 + N 个没被点掉的提示框。
//
// 本文件把两件事收在一处：
//   ① 能挂父窗口就挂 —— 模态子对话框**不单独占任务栏**；
//   ② 该消失的必须能自己消失 —— 超时后执行退出动作（框随进程一起消失）。
//
// ── 红线（报告 5.2，不许在修复中破坏）────────────────────────────────
//   · 不能为了消弹框回到**静默退出**（R45 教训：用户见"双击没反应"会反复点）；
//   · 不能给"看门狗放弃自愈"那种**不该退出**的场景套超时退出 —— 后端可能正在
//     跑会话，退出即丢工作。那种场景只挂父窗口、不超时。
//
// 定时器生命周期在 ./dialog-timer.js（无 electron 依赖，可单测）；这里只做接线。

import { app, dialog } from 'electron';
import { scheduleAutoClose } from './dialog-timer.js';

/** 常用档位（报告建议值，集中在这里便于统一调整）。 */
export const DIALOG_TIMEOUT = {
  alreadyRunning: 8000,     // 纯信息，一行字读够
  startupFailed: 180000,    // 要给点「打开日志目录」的时间，但不能永久挂
  fatal: 30000              // 反正是 exit(1) 路径
};

/**
 * 弹一个原生消息框。
 *
 * @param {object} opts                 dialog.showMessageBox 的选项
 * @param {object} [cfg]
 * @param {BrowserWindow|null} [cfg.parent]   父窗口；传了且未销毁则挂父（不占任务栏）
 * @param {number} [cfg.autoCloseMs]          超时自消（毫秒）；0 = 不超时
 * @param {Function} [cfg.timeoutAction]      超时后执行的动作，默认 app.quit()
 * @returns {Promise<Electron.MessageBoxReturnValue>}
 */
export function showDialog(opts, { parent = null, autoCloseMs = 0, timeoutAction = null } = {}) {
  const useParent = parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed();
  const p = useParent
    ? dialog.showMessageBox(parent, opts)
    : dialog.showMessageBox(opts);
  scheduleAutoClose(p, { autoCloseMs, timeoutAction: timeoutAction || (() => app.quit()) });
  return p;
}
