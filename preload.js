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
  // Credencial del equipo: login del dueño (paso 1), registro contra el negocio (paso 2),
  // estado y desconexión.
  bridgeLogin: (creds) => ipcRenderer.invoke('bridge-login', creds),
  bridgeRegister: (data) => ipcRenderer.invoke('bridge-register', data),
  bridgeStatus: () => ipcRenderer.invoke('bridge-status'),
  bridgeDisconnect: () => ipcRenderer.invoke('bridge-disconnect'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, data) => callback(data)),
  quitAndInstall: () => ipcRenderer.send('quit-and-install')
})
