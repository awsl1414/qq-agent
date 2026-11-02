const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
// This surface can measure/present only its current reply. It has no model,
// filesystem, settings, screenshot, console or interaction privileges.
contextBridge.exposeInMainWorld('qqPetSpeech', Object.freeze({
  ready: () => ipcRenderer.invoke('qqa-pet-speech:ready'),
  measure: ({ width, height, revision } = {}) => ipcRenderer.invoke('qqa-pet-speech:measure', { width, height, revision }),
  present: (revision) => ipcRenderer.invoke('qqa-pet-speech:present', revision),
  onUpdate: (callback) => subscribe('qqa-pet-speech:update', callback),
  onReset: (callback) => subscribe('qqa-pet-speech:reset', callback),
  onLayout: (callback) => subscribe('qqa-pet-speech:layout', callback),
  onLimits: (callback) => subscribe('qqa-pet-speech:limits', callback),
}));
