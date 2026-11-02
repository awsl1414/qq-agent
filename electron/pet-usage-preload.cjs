// 今日用量卡片的受限桥：只允许「取一次数据」「关掉自己」两件事。
// 不暴露 ipcRenderer、不暴露任何 Node 能力 —— 卡片只是展示层。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqPetUsage', Object.freeze({
  ready: () => ipcRenderer.invoke('qqa-pet-usage:ready'),
  close: () => ipcRenderer.send('qqa-pet-usage:close'),
  onData: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('qqa-pet-usage:data', listener);
    return () => ipcRenderer.removeListener('qqa-pet-usage:data', listener);
  },
}));
