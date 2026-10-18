// Preload de la CAJA SIN CONEXIÓN (`renderer/caja.html`).
//
// Contenido LOCAL, empaquetado en la app: por eso puede cobrar e imprimir, cosa que el preload
// del POS remoto no puede. Aun así se expone lo justo para cobrar sin red y nada más: ni
// configuración, ni credenciales, ni `ipcRenderer` pelado. El proceso principal además
// comprueba que la llamada venga de la caja que está montada (`esCajaLocal`).

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('caja', {
  estado: () => ipcRenderer.invoke('caja:estado'),
  ventas: () => ipcRenderer.invoke('caja:ventas'),
  /** Guarda la venta en la cola del equipo. Devuelve {ok, venta} o {ok:false, error}. */
  cobrar: (venta) => ipcRenderer.invoke('caja:cobrar', venta),
  imprimirRecibo: (uuid) => ipcRenderer.invoke('caja:imprimir-recibo', uuid),
  factura: (uuid, ncfType, rnc, nombre) => ipcRenderer.invoke('caja:factura', { uuid, ncfType, rnc, nombre }),
  reimprimirFactura: (uuid) => ipcRenderer.invoke('caja:reimprimir-factura', uuid),
  devolverACola: (uuid) => ipcRenderer.invoke('caja:devolver-a-cola', uuid),
  enLinea: () => ipcRenderer.invoke('caja:en-linea'),
  probarConexion: () => ipcRenderer.invoke('caja:probar-conexion'),
  onConexion: (cb) => ipcRenderer.on('caja:conexion', (_e, estado) => cb(estado)),
})
