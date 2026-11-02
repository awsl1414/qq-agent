const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// No filesystem, arbitrary channels, screenshot bytes or model API credentials.
contextBridge.exposeInMainWorld('qqDesktopPet', Object.freeze({
  getState: () => ipcRenderer.invoke('qqa-pet:state'),
  ready: () => ipcRenderer.send('qqa-pet:ready'),
  openConsole: () => ipcRenderer.send('qqa-pet:open-console'),
  openMenu: () => ipcRenderer.send('qqa-pet:menu'),
  observeNow: () => ipcRenderer.invoke('qqa-pet:observe'),
  showSpeech: (text) => ipcRenderer.invoke('qqa-pet:speech', { text: String(text || '').slice(0, 6000) }),
  closeSpeech: () => ipcRenderer.send('qqa-pet:speech-close'),
  setSpeechAnchor: ({ left, top, width, height } = {}) => ipcRenderer.send('qqa-pet:speech-anchor', { left, top, width, height }),
  beginDrag: () => ipcRenderer.send('qqa-pet:drag-start'),
  tickDrag: () => ipcRenderer.send('qqa-pet:drag-tick'),
  endDrag: () => ipcRenderer.send('qqa-pet:drag-end'),
  interact: () => ipcRenderer.send('qqa-pet:interact'),
  // 单击 → 今日用量卡片（主进程现算统计，返回值只用于失败提示）
  usageToday: () => ipcRenderer.invoke('qqa-pet:usage-today'),
  closeUsage: () => ipcRenderer.send('qqa-pet:usage-close'),
  // 双击 → 开发工单对话框（窗口由主进程创建/定位）
  openDevChat: () => ipcRenderer.send('qqa-pet:dev-open'),
  modelLoaded: (id, error = '') => ipcRenderer.send('qqa-pet:model-loaded', { id: String(id || '').slice(0, 120), error: String(error || '').slice(0, 700) }),
  reportPreview: ({ modelId, dataUrl } = {}) => ipcRenderer.invoke('qqa-pet:preview', { modelId: String(modelId || '').slice(0, 80), dataUrl: typeof dataUrl === 'string' ? dataUrl : '' }),
  reportError: (error) => ipcRenderer.send('qqa-pet:error', String(error || '').slice(0, 700)),
  commandResult: ({ requestId, ok, error } = {}) => ipcRenderer.send('qqa-pet:command-result', { requestId: String(requestId || '').slice(0, 100), ok: ok === true, error: String(error || '').slice(0, 500) }),
  reportActivity: (value = {}) => ipcRenderer.send('qqa-pet:activity', { modelId: String(value.modelId || '').slice(0, 80), motionId: String(value.motionId || '').slice(0, 220), expressionId: String(value.expressionId || '').slice(0, 220), posture: String(value.posture || '').slice(0, 10), trigger: String(value.trigger || '').slice(0, 40), ok: value.ok === true, error: String(value.error || '').slice(0, 500) }),
  onState: (callback) => subscribe('qqa-pet:state-update', callback),
  onCommand: (callback) => subscribe('qqa-pet:command', callback),
  onCursor: (callback) => subscribe('qqa-pet:cursor', callback),
  onVisibility: (callback) => subscribe('qqa-pet:visibility', callback),
  onLayout: (callback) => subscribe('qqa-pet:layout', callback),
}));
