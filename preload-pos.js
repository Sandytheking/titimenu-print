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
//   · cajaSinConexion.*            → (2.2.0) la caja sin conexión, ver abajo
// Nada de configuración, nada de sesión, nada de credenciales, nada de apagar la app.
//
// ## Por qué `cajaSinConexion` sí está aquí (lo pensé)
// Sin internet la app cobra con una caja LOCAL que guarda las ventas en este equipo. Quien las
// SUBE después es el POS web, porque es quien tiene la sesión de Supabase y quien la renueva
// (una copia del token en la app rotaría el refresh token y dejaría al web deslogueado). Así
// que el web necesita: guardar la foto de la caja, apartar e-NCF para ESTE equipo y leer/marcar
// la cola. Lo que eso le da a un script hostil en titimenu.com es leer y alterar las ventas
// pendientes de su propio negocio —algo que esa misma página ya puede hacer en la base con la
// sesión del dueño— y nada sobre el equipo: no configura, no imprime fuera de la lista, no ve
// credenciales. Y la cola NUNCA se borra por aquí: solo cambia de estado, y `marcarSubida` exige
// la respuesta del servidor (id y número).
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

  cajaSinConexion: {
    guardarFoto: (foto) => ipcRenderer.invoke('pos:caja-guardar-foto', foto),
    deviceId: () => ipcRenderer.invoke('pos:caja-device-id'),
    aplicarApartar: (negocioId, resp) => ipcRenderer.invoke('pos:caja-aplicar-apartar', { negocioId, resp }),
    pendientes: (negocioId) => ipcRenderer.invoke('pos:caja-pendientes', negocioId),
    marcarSubida: (uuid, resp) => ipcRenderer.invoke('pos:caja-marcar-subida', { uuid, resp }),
    marcarProblema: (uuid, motivo) => ipcRenderer.invoke('pos:caja-marcar-problema', { uuid, motivo }),
    intentoFallido: (uuid, motivo) => ipcRenderer.invoke('pos:caja-intento-fallido', { uuid, motivo }),
    resumen: (negocioId) => ipcRenderer.invoke('pos:caja-resumen', negocioId),
    ventas: (negocioId) => ipcRenderer.invoke('pos:caja-ventas', negocioId),
    devolverACola: (uuid) => ipcRenderer.invoke('pos:caja-devolver-a-cola', uuid),
    podar: () => ipcRenderer.invoke('pos:caja-podar'),
  },
})
