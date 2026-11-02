// 预加载桥：无边框窗口（frame: false）下，渲染进程没有任何原生窗口控件可用，
// 只能由页面自绘按钮，再通过这里把「最小化 / 最大化 / 关闭」三个意图转给主进程。
//
// 安全边界（刻意收得很紧）：
//   1. 只暴露窗口控制这一个能力面，不暴露 ipcRenderer 本体、不暴露 fs/path/shell 等任何模块。
//      渲染进程即使被 XSS 攻破，能做的也只有"动这个窗口"，拿不到文件系统和命令执行。
//   2. 全部方法都不接收渲染进程传来的参数（window 由主进程按 e.sender 反查），
//      不存在"传个 id 就操作别的窗口"的路径。
//   3. contextIsolation 保持 true、nodeIntegration 保持 false —— 与改动前一致，
//      这个文件的唯一新增能力就是 contextBridge 上那 5 个方法。
//
// ⚠️ 必须是 .cjs：package.json 是 "type": "module"，preload 在沙箱下按 CommonJS 加载，
//    用 .js 会被当成 ESM 解析而直接加载失败（表现为"窗口起来了但按钮全无反应"）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqaDesktop', {
  /**
   * 桌宠右键「打开控制台」：主进程的桌宠宿主在用户点菜单项时向本窗口发
   * 'qqa-pet:open-console'，这里只做转发订阅，不暴露 ipcRenderer 本体。
   * 返回取消订阅函数（与 onMaximizeChange 同一套约定）。
   */
  onPetOpenConsole: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('qqa-pet:open-console', listener);
    return () => ipcRenderer.removeListener('qqa-pet:open-console', listener);
  },
  /** 最小化窗口。 */
  minimize: () => ipcRenderer.send('win:minimize'),
  /** 最大化 / 还原（由主进程按当前状态判断，渲染进程不需要自己维护状态）。 */
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  /** 关闭窗口。语义与系统标题栏的 ✕ 完全一致：默认缩到托盘，而不是退出进程。 */
  close: () => ipcRenderer.send('win:close'),
  /** 当前是否最大化（首屏对齐用）。 */
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  /**
   * R67：把当前窗口位置/尺寸**立刻**写进存档（设置页「保存当前排布」按钮用）。
   * 平时 moved/resize 会防抖 400ms 自动落盘，这条是显式入口 —— 无参数，
   * 与上面几个方法同样的边界：渲染进程指不了任何窗口。
   * 返回 { ok, x, y, width, height, maximized }；拿不到窗口时只回 { ok:false }。
   */
  saveWindowGeometry: () => ipcRenderer.invoke('win:save-geometry'),
  /**
   * 订阅最大化状态变化（用户双击拖拽区 / Win+↑ / Aero Snap 都会触发）。
   * 返回取消订阅函数。
   */
  onMaximizeChange: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, value) => callback(Boolean(value));
    ipcRenderer.on('win:maximized-changed', handler);
    return () => ipcRenderer.removeListener('win:maximized-changed', handler);
  },

  // ── 外观个性化（R40）──
  // 这三项是"渲染进程做不到"才过桥的：整窗不透明度只能由主进程 setOpacity；
  // 背景图要原生文件对话框 + 复制进数据目录（页面是 http 源，读不了 file://）。
  // ⚠️ 依然**不接受文件路径参数**（对话框在主进程弹出、复制由主进程完成），
  //    所以没有"渲染进程指哪读哪"的能力面。
  /** 整窗不透明度：0.3~1（主进程夹取）。浏览器里打开控制台时此能力不存在。 */
  setOpacity: (value) => ipcRenderer.invoke('win:set-opacity', value),
  /** 选择界面背景图：返回 { ok, name } 或 { ok:false, canceled:true }。 */
  pickBgImage: () => ipcRenderer.invoke('ui:pick-bg-image'),
  /** 清除已选背景图（不删其它数据）。 */
  clearBgImage: () => ipcRenderer.invoke('ui:clear-bg-image'),

  // ── 本地导入技能/插件（R41）──
  // 「把文件拖进来就能装」要用到两个只有主进程能给的东西：原生对话框、
  // 以及拖放的 File 对象背后的真实磁盘路径。两者都只返回路径字符串，
  // 读写全部交给后端 /api/skills/import（只有那里有校验与落地规则）。
  /** 选 zip 包或文件夹（可多选）：返回 { ok, paths } 或 { ok:false, canceled:true }。 */
  pickModuleFiles: () => ipcRenderer.invoke('dialog:pick-modules'),
  /** 选一个文件夹，只回路径（不读不写）：返回 { ok, path } 或 { ok:false, canceled:true }。 */
  pickDirectory: () => ipcRenderer.invoke('dialog:pick-dir'),
  /** 拖放反查路径：传入 dataTransfer 里的 File，返回 { ok, path }。 */
  pathForFile: (file) => ipcRenderer.invoke('file:path-for', file),

  // ── 启动失败兜底（R125-P0-2 / P2-4）──
  // 这两项是"纯前端做不到"才过桥的：开系统文件管理器要到主进程走 shell.openPath；
  // 把启动失败日志上报给主进程落盘也要经 IPC。依然**不接受任何参数**（路径 / 内容
  // 一律由主进程或渲染进程自身决定），没有"渲染进程指哪写哪"的能力面。
  /** 打开主进程日志目录（data/logs）。无参数。 */
  openLogDir: () => ipcRenderer.invoke('boot:open-log-dir'),
  /** R125-P2-4：把启动失败 + 尾部日志上报主进程，由它写进主进程日志文件。无返回值（fire-and-forget）。 */
  reportBootFailure: (payload) => ipcRenderer.send('boot-failure', payload),

  /**
   * 2026-10-24：打开协议端自己的控制台（SnowLuma / NapCat 的 WebUI）。
   * 只接受 'snowluma' | 'napcat' 两个枚举值 —— 真正打开的地址写死在主进程
   * （PROTOCOL_CONSOLE_URLS）。渲染进程传不进任意 URL，"本机地址不外开"
   * 这条安全规则没有因为这个入口放松。
   */
  openProtocolConsole: (which) => ipcRenderer.invoke('app:open-protocol-console', String(which || ''))
});
