// Preload del ARMAZÓN: la pantalla de inicio (los tres botones) y la barra superior
// que queda encima del POS.
//
// Es LOCAL — `renderer/shell.html` sale de nuestro propio disco, no de la red— así que
// aquí no aplica la paranoia del preload del POS. Aun así se expone lo justo: navegar
// entre las tres pantallas y leer el estado. Nada de imprimir (eso es del POS) y nada
// de configurar (eso es del preload de la ventana de configuración).

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  /** 'owner' | 'staff' | 'printer' */
  open: (target) => ipcRenderer.invoke('shell:open', target),
  goHome: () => ipcRenderer.invoke('shell:home'),
  getState: () => ipcRenderer.invoke('shell:state'),
  onState: (cb) => ipcRenderer.on('shell:state-changed', (_e, state) => cb(state)),
})
