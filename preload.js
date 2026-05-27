const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  testPrint: () => ipcRenderer.invoke('test-print'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  onStatusChange: (callback) => ipcRenderer.on('status-change', (_event, connected) => callback(connected)),
  onLogMessage: (callback) => ipcRenderer.on('log-message', (_event, text) => callback(text)),
  resetConfig: () => ipcRenderer.invoke('reset-config'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, data) => callback(data)),
  quitAndInstall: () => ipcRenderer.send('quit-and-install')
})
