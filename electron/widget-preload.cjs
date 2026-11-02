// 桌面悬浮小窗的预加载桥（只服务 ui/widget.html）。
//
// 存在理由：右键菜单要画成与卡片同一风格的深色菜单（系统原生菜单改不了样式），
// 而"改设置 / 打开主界面 / 展开小窗"这些动作只有主进程能做 —— 页面需要一个
// 最小的开口把它们递过去。
//
// 安全边界（比主窗口 preload.cjs 收得还紧）：
//   1. 只暴露两个方法，且**参数不是命令**：apply 传的是"要改成什么样"的键值，
//      command 传的是固定枚举名 —— 主进程侧逐键白名单 + 夹取后才落配置，
//      渲染进程传什么都改不了白名单之外的东西。
//   2. 不暴露 ipcRenderer 本体、fs/path/shell 等任何模块；contextIsolation 仍是
//      true、nodeIntegration 仍是 false（见 createWidgetWindow）。
//   3. 主进程校验发送方必须**就是小窗自己的 webContents**：即使别处的页面
//      拿到了同名桥也用不了。
//
// ⚠️ 必须是 .cjs：package.json 是 "type": "module"，preload 在沙箱下按 CommonJS
//    加载，用 .js 会被当 ESM 解析而直接加载失败（与主窗口 preload.cjs 同一个坑）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqaWidget', {
  /**
   * 改小窗设置（主进程白名单校验 + 夹取后合并进 config.widget，并立即同步到活窗口）。
   * @param {object} patch 只允许 enabled / alwaysOnTop / clickThrough / edgeHide /
   *                       transparent / size / opacity / refreshMs 这几个键。
   * @returns {Promise<{ok:boolean, patch?:object, reason?:string}>}
   */
  apply: (patch) => ipcRenderer.invoke('widget:apply', patch),
  /**
   * 非配置类动作（固定枚举）：
   *   'open-console' 打开主界面   'expand' 从贴边收起态展开
   * @param {string} name
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  command: (name) => ipcRenderer.invoke('widget:command', name),
  /**
   * 订阅"偏好变了"推送（R140）。主进程发现在设置页改了 widget 配置
   * （不透明度/刷新间隔/开关……）后主动发 widget:prefs-changed，
   * 页面收到就重拉 /api/config —— 不用再等 2.5 秒状态轮询 + 3 秒去重。
   * @param {(payload:{opacity?:number}) => void} cb
   * @returns {() => void} 取消订阅
   */
  onPrefsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, payload) => {
      try { cb(payload || {}); } catch { /* 页面自己的异常不要带回主进程 */ }
    };
    ipcRenderer.on('widget:prefs-changed', handler);
    return () => {
      try { ipcRenderer.removeListener('widget:prefs-changed', handler); } catch { /* 已销毁：忽略 */ }
    };
  }
});
