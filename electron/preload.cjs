const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capcutAPI', {
  openFiles: (options) => ipcRenderer.invoke('dialog:openFiles', options),
  saveFileDialog: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  getMediaMetadata: (filePath) => ipcRenderer.invoke('media:getMetadata', filePath),
  getWaveform: (filePath) => ipcRenderer.invoke('media:getWaveform', filePath),
  extractThumbnail: (filePath) => ipcRenderer.invoke('media:extractThumbnail', filePath),
  transcribeMedia: (options) => ipcRenderer.invoke('subtitles:transcribe', options),
  startExport: (options) => ipcRenderer.invoke('export:start', options),
  sendExportFrame: (frameBase64) => ipcRenderer.invoke('export:frame', frameBase64),
  finishExport: () => ipcRenderer.invoke('export:finish'),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (callback) => {
    const handler = (e, val) => callback(val);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
  getGpuInfo: () => ipcRenderer.invoke('system:getGpuInfo'),
  openInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath)
});
