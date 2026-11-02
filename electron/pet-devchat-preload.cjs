// 开发工单对话框的受限桥：只暴露工单会话的四个动作 + 关窗。
// 全部经主进程转发到 dev-orders 插件能力；渲染进程拿不到文件系统、命令执行或密钥。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqDevChat', Object.freeze({
  ready: () => ipcRenderer.send('qqa-dev:ready'),
  snapshot: (selected = '') => ipcRenderer.invoke('qqa-dev:snapshot', String(selected || '').slice(0, 120)),
  detail: ({ id, from = 0 } = {}) => ipcRenderer.invoke('qqa-dev:detail', { id: String(id || '').slice(0, 120), from: Number(from) || 0 }),
  send: ({ id, text } = {}) => ipcRenderer.invoke('qqa-dev:send', { id: String(id || '').slice(0, 120), text: String(text || '').slice(0, 8000) }),
  newSession: (text = '') => ipcRenderer.invoke('qqa-dev:new', String(text || '').slice(0, 8000)),
  closeSession: (id) => ipcRenderer.invoke('qqa-dev:close-session', String(id || '').slice(0, 120)),
  hide: () => ipcRenderer.send('qqa-dev:hide'),
  onRefresh: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('qqa-dev:refresh', listener);
    return () => ipcRenderer.removeListener('qqa-dev:refresh', listener);
  },
}));
