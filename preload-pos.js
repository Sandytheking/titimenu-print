// Preload de la VENTANA DEL POS — deliberadamente distinto y mucho más pobre que
// `preload.js`, el de la ventana de configuración.
//
// POR QUÉ SON DOS Y NO UNO: la ventana de config carga un `loadFile` local, escrito
// por nosotros, y por eso puede recibir un `electronAPI` con bridgeLogin, saveConfig,
// resetConfig y bridgeDisconnect. La ventana del POS carga **titimenu.com**, o sea
// CONTENIDO REMOTO. Darle ese mismo API convertiría cualquier XSS en titimenu.com —o
// un script de terceros que entre en esa página— en "reconfigúrame el bridge",
// "desconéctame el equipo" o "dame las credenciales". Reusar el preload de config
// aquí sería el agujero, así que este archivo existe para no poder cometerlo.
//
// LA SUPERFICIE ES ESTA Y NO CRECE SIN PENSARLO:
//   · getStatus()                  → ¿hay bridge y qué versión tiene?
//   · printJob(endpoint, payload)  → imprime uno de TRES documentos
// Nada de configuración, nada de sesión, nada de credenciales, nada de apagar la app.
//
// Y lo que se expone son FUNCIONES, no `ipcRenderer`. Exponer `ipcRenderer` pelado
// (o su `invoke`) daría acceso a TODOS los canales del main —incluidos bridge-login y
// reset-config— y anularía toda esta separación de un plumazo.

const { contextBridge, ipcRenderer } = require('electron')

// Espejo de la lista dura del main. Aquí es sólo para fallar rápido y con un mensaje
// claro; **la validación que cuenta es la del main**, porque un renderer comprometido
// puede saltarse cualquier comprobación que viva de este lado.
const ALLOWED_ENDPOINTS = ['print-receipt', 'print-fiscal', 'print-closing']

contextBridge.exposeInMainWorld('titimenuBridge', {
  getStatus: () => ipcRenderer.invoke('pos:get-status'),

  printJob: (endpoint, payload) => {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      return Promise.resolve({ ok: false, error: `endpoint no permitido: ${endpoint}` })
    }
    return ipcRenderer.invoke('pos:print-job', { endpoint, payload })
  },
})
