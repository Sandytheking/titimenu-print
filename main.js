const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog, shell, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const http = require('http')
const Store = require('electron-store')
const bridgeAuth = require('./bridgeAuth')
const { getUSBPrinters, isDrink, printPOSReceipt, printFiscalReceipt, printTableComanda, printDeliveryTicket, printKitchenComanda, printBarComanda, printTestPage, printClosingReport, TEST_PRINTER_NAME } = require('./printer')
const { setCallbacks, startListening, disconnect } = require('./supabase')

const store = new Store()

let tray = null
let configWindow = null
let isConnected = false
let httpServer = null
let activePort = null
let updateReady = false

function sendUpdateStatus(status, details = null) {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send('update-status', { status, details })
  }
}

function handleQuitAndInstall() {
  console.log('[updater] quit-and-install requested')
  
  // En macOS, quitAndInstall falla silenciosamente si la app no está firmada.
  // Usamos un timeout: si la app sigue ejecutándose después de 2 segundos,
  // mostramos un diálogo explicativo de macOS Code Signing.
  const timeoutId = setTimeout(() => {
    if (process.platform === 'darwin') {
      dialog.showMessageBox({
        type: 'info',
        title: 'Actualización en macOS',
        message: 'La actualización automática no pudo completarse',
        detail: 'Apple exige obligatoriamente que las aplicaciones de macOS estén firmadas digitalmente con un certificado de desarrollador oficial para poder auto-actualizarse.\n\nAl ser una compilación local/no firmada, el sistema de seguridad de macOS bloquea el reemplazo automático de los archivos.\n\nPor favor, descarga e instala la última versión manualmente usando el archivo DMG desde el repositorio de GitHub.',
        buttons: ['Entendido', 'Abrir descargas en GitHub']
      }).then(({ response }) => {
        if (response === 1) {
          const { shell } = require('electron')
          shell.openExternal('https://github.com/Sandytheking/titimenu-print/releases')
        }
      })
    } else {
      dialog.showMessageBox({
        type: 'error',
        title: 'Error de Actualización',
        message: 'No se pudo reiniciar la aplicación para aplicar la actualización.',
        detail: 'Por favor, cierra la aplicación manualmente y vuelve a abrirla, o instala la nueva versión manualmente.'
      })
    }
  }, 2000)

  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    clearTimeout(timeoutId)
    sendLog(`Error en quitAndInstall: ${err.message}`)
  }
}


// ─── Auto-updater ─────────────────────────────────────────────────────────────

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('checking-for-update', () => {
  sendLog('Buscando actualizaciones...')
  sendUpdateStatus('checking')
})

autoUpdater.on('update-available', (info) => {
  sendLog(`Nueva versión disponible: v${info.version}`)
  sendUpdateStatus('available', info)
  new Notification({
    title: 'TitiMenu',
    body: `Descargando actualización v${info.version}`
  }).show()
})

autoUpdater.on('update-not-available', () => {
  sendLog('TitiMenu está actualizado')
  sendUpdateStatus('not-available')
})

autoUpdater.on('update-downloaded', (info) => {
  updateReady = true
  sendLog(`✅ Actualización v${info.version} lista — se instalará al cerrar`)
  sendUpdateStatus('downloaded', info)
  new Notification({
    title: 'TitiMenu',
    body: `Actualización v${info.version} lista. Reinicia para aplicarla.`
  }).show()
  updateTray()
})

autoUpdater.on('error', (err) => {
  sendLog(`Error de actualización: ${err.message}`)
  sendUpdateStatus('error', err.message)
})

// ─── Tray icons (base64 inline so no external assets needed at runtime) ──────

function makeTrayIcon(connected) {
  // 16x16 circle: green or red
  const color = connected ? '48bb78' : 'e53e3e'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <circle cx="8" cy="8" r="7" fill="#${color}"/>
  </svg>`
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  )
}

// ─── Config Window ────────────────────────────────────────────────────────────

function createConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus()
    return
  }

  configWindow = new BrowserWindow({
    width: 440,
    height: 720,
    resizable: false,
    title: 'TitiMenu — Configuración',
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  configWindow.loadFile(path.join(__dirname, 'renderer', 'config.html'))
  configWindow.on('closed', () => { configWindow = null })
}

// ─── Ventana del POS ──────────────────────────────────────────────────────────
// Carga el POS web REAL (titimenu.com) dentro de la app. No es un POS nuevo: es el
// mismo que corre en el navegador, con la impresión saliendo por IPC al proceso
// principal en vez de por un fetch a loopback — que es justo lo que Chrome bloquea y
// lo que obliga hoy a instalar la extensión.

const POS_ORIGIN = 'https://titimenu.com'
const POS_URL = `${POS_ORIGIN}/dashboard/pos`

// El personal entra por OTRA ruta —/staff/{slug}— con su PIN, no por la del dueño. El
// slug lo trae el canje de la credencial (`applyBusinessInfo`), así que NO hay que
// pedírselo a nadie: la app ya sabe de qué negocio es este equipo. Y como el canje se
// repite, el dato se revalida solo en vez de quedarse congelado.
function staffUrl() {
  const slug = store.get('businessSlug', '')
  return slug ? `${POS_ORIGIN}/staff/${slug}` : null
}

// Dos sesiones separadas y PERSISTENTES. Dueño y empleado son dos sesiones de Supabase
// en el mismo dominio: con una sola partición se pisarían, y cambiar de modo obligaría
// a escribir la contraseña o el PIN otra vez. Sin el prefijo `persist:` la sesión vive
// en memoria y se pierde al cerrar la app.
const POS_PARTITIONS = {
  owner: 'persist:titimenu-pos',   // nombre heredado: no cambiarlo conserva la sesión ya guardada
  staff: 'persist:titimenu-staff',
}

/** 'owner' | 'staff' — la elección de ESTE aparato, recordada entre arranques. */
function entryMode() {
  return store.get('posEntryMode') === 'staff' ? 'staff' : 'owner'
}

function hasEntryMode() {
  return store.get('posEntryMode') === 'staff' || store.get('posEntryMode') === 'owner'
}

/**
 * Se pregunta UNA vez y se recuerda. Un terminal es del dueño o del personal, y es el
 * mismo todos los días: preguntar en cada arranque sería justo la fricción que esta
 * app existe para quitar. Se cambia cuando haga falta desde la bandeja.
 */
async function askEntryMode() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'TitiMenu',
    message: '¿Cómo se usa este equipo?',
    detail: 'Puedes cambiarlo cuando quieras desde el icono de TitiMenu en la barra.\n\n' +
            '· Dueño — entra al panel completo con tu correo y contraseña.\n' +
            '· Empleado — entra con el PIN del personal.',
    buttons: ['Dueño', 'Empleado'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  const mode = response === 1 ? 'staff' : 'owner'
  store.set('posEntryMode', mode)
  return mode
}

// ÚNICA lista de orígenes de confianza. La comparten las tres defensas: quién puede
// llamar al IPC (`isTrustedPosSender`), a dónde puede navegar la ventana
// (`will-navigate`) y a quién se le conceden permisos (`configurePosSession`). Una
// sola lista para que no puedan discrepar.
const TRUSTED_POS_ORIGINS = new Set(['https://titimenu.com', 'https://www.titimenu.com'])

let posWindow = null

/** ¿La URL pertenece al POS? Misma lista de orígenes que valida el IPC (pieza 2). */
function isTrustedPosUrl(url) {
  try { return TRUSTED_POS_ORIGINS.has(new URL(url).origin) } catch { return false }
}

/** Abre en el NAVEGADOR del sistema, nunca dentro de la app. Sólo http/https. */
function openExternalSafely(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
}

/**
 * ¿Puede arrancarse directo en el POS? Hacen falta las dos cosas: el equipo
 * registrado (si no, el POS cargaría sin poder imprimir los pedidos del menú) y una
 * impresora de caja activa (si no, el primer cobro terminaría en un PDF sin que el
 * dueño entienda por qué). Si falta alguna, se abre la configuración: es el sitio
 * donde se arreglan las dos.
 */
function isPosReady() {
  try { return bridgeAuth.hasCredential() && isPrinterActive(cashierPrinterName()) } catch { return false }
}

function createPosWindow() {
  if (posWindow && !posWindow.isDestroyed()) {
    posWindow.show()
    posWindow.focus()
    return
  }

  const mode = entryMode()
  const url = mode === 'staff' ? staffUrl() : POS_URL

  // Modo empleado sin slug: sólo pasa si este equipo se registró con una versión del
  // web anterior a que `/api/bridge/session` devolviera el slug. El siguiente canje de
  // la credencial lo trae; mientras tanto se dice qué pasa en vez de abrir una ventana
  // en blanco.
  if (!url) {
    dialog.showMessageBox({
      type: 'info',
      title: 'TitiMenu',
      message: 'Todavía no sé el enlace del personal de este negocio',
      detail: 'Se obtiene solo la próxima vez que el equipo renueve su credencial. ' +
              'Si tiene prisa, entra como Dueño desde el icono de TitiMenu en la barra.',
    })
    createConfigWindow()
    return
  }

  posWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 700,
    title: 'TitiMenu POS',
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      // Preload PROPIO y mínimo (getStatus + printJob). NUNCA el de la config: esta
      // ventana carga contenido remoto. Ver la cabecera de preload-pos.js.
      preload: path.join(__dirname, 'preload-pos.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: POS_PARTITIONS[mode],
    },
  })

  const wc = posWindow.webContents

  // ── El dominio, VISIBLE ──
  // Si la sesión de Supabase caduca, Next redirige a /login DENTRO de esta ventana y
  // el dueño escribiría su contraseña en un recuadro sin barra de direcciones — que
  // es exactamente como se ve un phishing. El título muestra el origen real y se
  // actualiza en cada navegación; la página no puede sobrescribirlo.
  const applyTitle = () => {
    if (!posWindow || posWindow.isDestroyed()) return
    let origin = ''
    try { origin = new URL(wc.getURL()).origin } catch {}
    posWindow.setTitle(origin ? `TitiMenu POS — ${origin}` : 'TitiMenu POS')
  }
  wc.on('page-title-updated', (event) => { event.preventDefault(); applyTitle() })
  wc.on('did-navigate', applyTitle)
  wc.on('did-navigate-in-page', applyTitle)

  // ── No se sale de titimenu.com ──
  // Va emparejado con la comprobación de origen del IPC: una impide LLEGAR, la otra
  // impide ACTUAR. Con las dos, ni una navegación hostil ni un iframe pueden imprimir.
  wc.on('will-navigate', (event, url) => {
    if (isTrustedPosUrl(url)) return
    event.preventDefault()
    console.warn(`[pos-window] navegación BLOQUEADA a ${url}`)
    openExternalSafely(url)
  })

  // ── window.open ──
  // El fallback de impresión del web abre `about:blank` y le escribe el ticket dentro
  // (cinco sitios entre POS, PrintBill y FiscalInvoice). Eso se PERMITE o el dueño se
  // queda sin su PDF cuando no hay impresora. Todo lo demás —el link a /descargar del
  // banner, por ejemplo— se abre en el navegador del sistema, fuera de la app.
  wc.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'allow' }
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // ── Llegar a la configuración desde el POS ──
  // La ventana del POS no tiene barra ni menú, así que la impresora se cambiaba sólo
  // desde la bandeja. Se añade el atajo estándar (Cmd+, / Ctrl+,) capturado antes de
  // que la página lo vea. NO se inyecta ningún botón dentro de titimenu.com: eso sería
  // meter script nuestro en contenido remoto, justo lo que la pieza 2 evita.
  wc.on('before-input-event', (event, input) => {
    const modifier = process.platform === 'darwin' ? input.meta : input.control
    if (modifier && input.key === ',' && input.type === 'keyDown') {
      event.preventDefault()
      createConfigWindow()
    }
  })

  posWindow.once('ready-to-show', () => {
    applyTitle()
    posWindow.show()
  })

  posWindow.on('closed', () => {
    posWindow = null
    // Cerrar el POS NO cierra la app: el bridge sigue en la bandeja imprimiendo los
    // pedidos que llegan por realtime, que es su valor de siempre. En Mac se vuelve a
    // esconder el icono del Dock para dejarla como estaba.
    if (process.platform === 'darwin' && app.dock) app.dock.hide()
  })

  // En Mac la app vive sólo en la bandeja (`app.dock.hide()` al arrancar), pero una
  // ventana que se usa todo el día tiene que poder alcanzarse con Cmd+Tab.
  if (process.platform === 'darwin' && app.dock) app.dock.show()

  wc.on('render-process-gone', (_e, details) => {
    sendLog(`La ventana del POS se cerró sola (${details.reason}). Ábrela otra vez desde la bandeja.`)
  })

  posWindow.loadURL(url)
}

/**
 * Cambia el rol de ESTE aparato. La partición se fija al crear la ventana, así que
 * cambiar de modo la recrea — es lo que mantiene las dos sesiones separadas y vivas.
 */
function setEntryMode(mode) {
  if (mode !== 'owner' && mode !== 'staff') return
  if (entryMode() === mode && posWindow && !posWindow.isDestroyed()) {
    posWindow.focus()
    return
  }
  store.set('posEntryMode', mode)
  if (posWindow && !posWindow.isDestroyed()) {
    posWindow.destroy()
    posWindow = null
  }
  updateTray()
  createPosWindow()
}

/**
 * Permisos del navegador dentro de la ventana del POS. Por defecto NO se concede
 * nada: sólo notificaciones, y sólo a titimenu.com. Las denegaciones se registran a
 * propósito — así se ve en el log qué está pidiendo el POS en vez de adivinarlo.
 */
function configurePosSession() {
  // Las DOS particiones (dueño y empleado) con la misma política: una sola regla, no
  // una por sesión que puedan discrepar.
  for (const partition of Object.values(POS_PARTITIONS)) {
    applyPosPermissions(session.fromPartition(partition))
  }
}

/**
 * Menú de aplicación (sólo macOS). Con el POS abierto el icono del Dock aparece, y con
 * él la barra de menús: si no ponemos una, macOS muestra la de Electron por defecto.
 * Aquí van el atajo a la configuración y —importante— los roles de edición, que son
 * los que hacen funcionar copiar y pegar dentro del POS.
 *
 * En Windows NO se toca: una barra de menús colgando encima del POS estorbaría, y la
 * de por defecto es la que trae los aceleradores de copiar/pegar.
 */
function buildAppMenu() {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'TitiMenu',
      submenu: [
        { role: 'about', label: 'Acerca de TitiMenu' },
        { type: 'separator' },
        {
          label: 'Impresoras y configuración…',
          accelerator: 'Command+,',
          click: () => createConfigWindow(),
        },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar TitiMenu' },
        { role: 'hideOthers', label: 'Ocultar otras' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir de TitiMenu' },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ventana',
      submenu: [
        { label: 'Abrir POS', click: () => createPosWindow() },
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
        { role: 'minimize', label: 'Minimizar' },
        { role: 'close', label: 'Cerrar' },
      ],
    },
  ]))
}

function applyPosPermissions(posSession) {
  const decide = (permission, requestingUrl) => {
    const ok = permission === 'notifications' && isTrustedPosUrl(requestingUrl || '')
    if (!ok) console.warn(`[pos-window] permiso DENEGADO: ${permission} (${requestingUrl || 'origen desconocido'})`)
    return ok
  }

  posSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(decide(permission, details?.requestingUrl || wc?.getURL()))
  })

  posSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return decide(permission, requestingOrigin || wc?.getURL())
  })
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(makeTrayIcon(false))
  updateTray()
}

function updateTray() {
  if (!tray) return

  tray.setImage(makeTrayIcon(isConnected))
  tray.setToolTip(
    isConnected
      ? 'TitiMenu — Conectado'
      : 'TitiMenu — Desconectado'
  )

  const updateItems = updateReady
    ? [
        { type: 'separator' },
        {
          label: '⬆️ Instalar actualización',
          click: () => handleQuitAndInstall()
        }
      ]
    : [
        {
          label: '🔄 Buscar actualizaciones',
          click: () => {
            try { autoUpdater.checkForUpdatesAndNotify() } catch (e) { sendLog(`Error de actualización: ${e.message}`) }
          }
        }
      ]

  const menu = Menu.buildFromTemplate([
    {
      label: isConnected ? '● Conectado' : '○ Desconectado',
      enabled: false
    },
    { type: 'separator' },
    { label: '🧾 Abrir POS', click: () => createPosWindow() },
    {
      label: 'Este equipo entra como',
      submenu: [
        {
          label: 'Dueño',
          type: 'radio',
          checked: entryMode() === 'owner',
          click: () => setEntryMode('owner'),
        },
        {
          label: 'Empleado (PIN)',
          type: 'radio',
          checked: entryMode() === 'staff',
          click: () => setEntryMode('staff'),
        },
      ],
    },
    { label: '🖨️ Impresoras y configuración', click: () => createConfigWindow() },
    {
      label: 'Estado',
      click: () => {
        const businessId = store.get('businessId', '')
        const printerName = store.get('printerName', '')
        dialog.showMessageBox({
          type: 'info',
          title: 'Estado',
          message: 'TitiMenu',
          detail: [
            `Estado: ${isConnected ? 'Conectado' : 'Desconectado'}`,
            `Business ID: ${businessId || 'No configurado'}`,
            `Impresora: ${printerName || 'No configurada'}`
          ].join('\n')
        })
      }
    },
    {
      label: 'Reiniciar conexión',
      click: () => {
        if (bridgeAuth.hasCredential()) {
          startAuthenticatedListening()
        } else {
          createConfigWindow()
        }
      }
    },
    ...updateItems,
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() }
  ])

  tray.setContextMenu(menu)
}

// ─── Connection Status ────────────────────────────────────────────────────────

function sendLog(text) {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send('log-message', text)
  }
}

function onStatusChange(connected) {
  const wasConnected = isConnected
  isConnected = connected
  updateTray()

  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send('status-change', connected)
  }

  if (connected && !wasConnected) {
    new Notification({
      title: 'TitiMenu',
      body: 'Conectado — escuchando órdenes'
    }).show()
  }
}

function isPrinterActive(name) {
  if (!name) return false
  if (name === '') return false
  if (name === '— No usar —') return false
  if (name === '-- No usar --') return false
  if (name === 'No usar') return false
  if (name.trim() === '') return false
  return true
}

// NOTA: aquí vivía un resolveCashierName() que leía pos_sessions por session_id. Se
// eliminó en v1.2.3 porque NO PODÍA funcionar: el cliente de este bridge usa la anon key
// sin sesión de usuario, así que `auth.uid()` es NULL y la única política de pos_sessions
// (business_pos_sessions) resolvía a cero filas. Y fallaba en SILENCIO — .maybeSingle()
// con 0 filas devuelve data:null, error:null —, lo que costó dos rondas de arreglos sin
// rastro en los logs. Desde la migración 20260805 el cajero es COLUMNA de pos_orders, así
// que la fila del realtime ya lo trae: se lee directo, igual que customer_name. Cero
// consultas, cero round-trip, cero modo de fallo invisible.


// Datos del negocio para las plantillas. Ahora los trae el CANJE de la credencial
// (/api/bridge/session), no una consulta a `businesses`: el JWT del equipo solo puede leer
// pos_orders y orders, y así el bridge queda sin una sola lectura extra en la BD.
function applyBusinessInfo(biz) {
  if (!biz) return
  if (biz.name) store.set('businessName', biz.name)
  // El slug arma la URL del personal (/staff/{slug}). Llega por el MISMO canje que el
  // resto, así que se revalida solo si el negocio lo cambia.
  if (biz.slug) store.set('businessSlug', biz.slug)
  store.set('businessLegalName', biz.legal_name || '')
  store.set('businessRnc', biz.rnc || '')
  store.set('businessAddress', biz.address || '')
  store.set('businessCurrency', biz.currency || 'RD$')
  store.set('businessItbisEnabled', biz.itbis_enabled === true)
  store.set('businessShowTaxBreakdown', biz.show_tax_breakdown_receipt === true)
  if (biz.id) store.set('businessId', biz.id)
}

// Arranca (o rearranca) la escucha con la credencial del equipo. El JWT se pasa como GETTER
// para que la reconexión tome siempre el vigente y no uno que ya venció.
async function startAuthenticatedListening() {
  const jwt = await bridgeAuth.exchange()
  applyBusinessInfo(bridgeAuth.getBusiness())
  businessRefreshedAt = Date.now()   // recién canjeado: el TTL arranca aquí
  const businessId = store.get('businessId')
  if (!businessId) { sendLog('Sin negocio configurado — inicia sesión en la configuración'); return }
  disconnect()
  setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder, onLogger: sendLog })
  startListening(businessId, () => bridgeAuth.getJwt())
  if (!jwt) {
    sendLog('⚠️ Sin conexión con TitiMenu: los recibos que imprimes desde la caja siguen saliendo. Los pedidos del menú digital no se imprimirán solos hasta que vuelva la conexión.')
  }
}

// Los datos del negocio se leían UNA sola vez —al arrancar, al iniciar sesión o al registrar
// el equipo— y se quedaban en `store` para siempre. El dueño encendía "desglose de ITBIS" en
// el dashboard y el bridge seguía imprimiendo sin desglose hasta que alguien lo reiniciara,
// sin ninguna señal de que estaba usando un dato viejo. Es la misma familia de bug que ya
// salió cinco veces en el proyecto: responder desde un recuerdo en vez de preguntarle a quien
// de verdad lo sabe. Mismo remedio que el cache de `print_method` del web: TTL de 10 minutos,
// perezoso (solo antes de imprimir, así el bridge en reposo no habla con nadie) y que DEGRADA
// —si el canje falla se sigue con lo último conocido y el ticket sale igual, porque quedarse
// sin papel por un problema de red sería peor que un desglose desactualizado.
const BUSINESS_TTL_MS = 10 * 60 * 1000
let businessRefreshedAt = 0

async function refreshBusinessInfo() {
  if (Date.now() - businessRefreshedAt < BUSINESS_TTL_MS) return
  if (!bridgeAuth.hasCredential()) return          // sin credencial no hay a quién preguntarle
  try {
    await bridgeAuth.exchange()
    applyBusinessInfo(bridgeAuth.getBusiness())
    businessRefreshedAt = Date.now()
  } catch (e) {
    sendLog(`No se pudieron refrescar los datos del negocio (se usan los últimos): ${e.message}`)
  }
}

async function onNewOrder(type, order) {
  await refreshBusinessInfo()
  console.log('[printer] printerCaja:', JSON.stringify(store.get('printerCaja')))
  console.log('[printer] printerCocina:', JSON.stringify(store.get('printerCocina')))
  console.log('[printer] printerBar:', JSON.stringify(store.get('printerBar')))

  const legacyPrinter = store.get('printerName', '')
  const printerCaja = store.has('printerCaja') ? store.get('printerCaja') : legacyPrinter
  const printerCocina = store.has('printerCocina') ? store.get('printerCocina') : legacyPrinter
  const printerBar = store.has('printerBar') ? store.get('printerBar') : legacyPrinter
  const businessName = store.get('businessName', 'Mi Negocio')

  if (!isPrinterActive(printerCaja) && !isPrinterActive(printerCocina) && !isPrinterActive(printerBar)) {
    new Notification({
      title: 'TitiMenu',
      body: 'Nueva orden recibida pero no hay ninguna impresora activa configurada'
    }).show()
    return
  }

  const items = order.items || order.order_items || []
  // `isDrink` viene de printer.js y es el ÚNICO criterio de estación del bridge: el mismo
  // que usa printTableComanda para dibujar las secciones. Tenerlo escrito aquí también fue
  // lo que permitió que las dos respuestas divergieran sin que nadie lo notara.
  const foodItems = items.filter(i => !isDrink(i))
  const drinkItems = items.filter(isDrink)

  const businessInfo = {
    name: businessName,
    legalName: store.get('businessLegalName', ''),
    rnc: store.get('businessRnc', ''),
    address: store.get('businessAddress', ''),
    currency: store.get('businessCurrency', 'RD$'),
    itbisEnabled: store.get('businessItbisEnabled', false),
    showTaxBreakdown: store.get('businessShowTaxBreakdown', false)
  }
  console.log('[business] currency:', businessInfo.currency)

  const printComandas = async () => {
    const tableInfo = {
      table_number: order.table_number,
      table_label: order.table_label ?? (
        order.table_number 
          ? `Mesa ${order.table_number}` 
          : order.order_type === 'delivery'
            ? `Delivery${order.customer_name ? ' - ' + order.customer_name : ''}`
            : order.order_type === 'takeout'
              ? `Takeout${order.customer_name ? ' - ' + order.customer_name : ''}`
              : ''
      ),
      order_id: order.id
    }

    if (printerCocina === printerBar) {
      if (isPrinterActive(printerCocina)) {
        await printTableComanda(order, printerCocina, businessInfo, tableInfo)
      }
    } else {
      if (foodItems.length > 0 && isPrinterActive(printerCocina)) {
        await printKitchenComanda(foodItems, printerCocina, order, businessInfo, tableInfo)
      }
      if (drinkItems.length > 0 && isPrinterActive(printerBar)) {
        await printBarComanda(drinkItems, printerBar, order, businessInfo, tableInfo)
      }
    }
  }

  try {
    if (type === 'pos') {
      if (isPrinterActive(printerCaja)) {
        // `order` es la fila cruda de pos_orders: cashier_name viene en ella.
        await printPOSReceipt(order, printerCaja, businessInfo)
      }
      // Also separate and print kitchen/bar comandas for POS orders!
      await printComandas()
    } else if (type === 'table') {
      await printComandas()
    } else if (type === 'delivery') {
      if (isPrinterActive(printerCaja)) {
        await printDeliveryTicket(order, printerCaja, businessInfo)
      }
      // Also separate and print kitchen/bar comandas for delivery orders!
      await printComandas()
    }
  } catch (err) {
    console.error('Print error:', err.message)
    new Notification({
      title: 'Error de impresión',
      body: err.message || 'No se pudo imprimir. Verifica que las impresoras estén encendidas.'
    }).show()
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch (e) { reject(new Error('JSON inválido en el body')) }
    })
    req.on('error', reject)
  })
}

// ─── Trabajos de impresión: UN solo sitio para los tres documentos ────────────
// Lo llaman los DOS transportes: el servidor HTTP (POS en el navegador, vía la
// extensión de Chrome) y el IPC de la ventana del POS (app de escritorio).
//
// POR QUÉ ESTÁ FACTORIZADO Y NO COPIADO: aquí vive el whitelist explícito del payload
// —lo que no se liste NO llega a la plantilla por muy bien que lo mande el web—, y una
// segunda copia divergiría en silencio. Ya pasó con `cashier_name`: el web lo mandaba,
// el mapeo no lo listaba, y el "Cajero/a" no salía en el papel. No falla: DEGRADA. Dos
// copias significan que el papel del POS envuelto y el del navegador podrían traer
// campos distintos sin que nada se ponga en rojo.

/** Error de impresión que sabe con qué código HTTP debe contestar el servidor. */
class PrintJobError extends Error {
  constructor(message, httpStatus) {
    super(message)
    this.name = 'PrintJobError'
    this.httpStatus = httpStatus
  }
}

/** Impresora de caja configurada (puede no estar activa). */
function cashierPrinterName() {
  const legacyPrinter = store.get('printerName', '')
  return store.has('printerCaja') ? store.get('printerCaja') : legacyPrinter
}

/** Impresora de caja activa, o revienta con el 503 de siempre. */
function activeCashierPrinter() {
  const printerCaja = cashierPrinterName()
  if (!isPrinterActive(printerCaja)) {
    throw new PrintJobError('No hay impresora de caja activa configurada', 503)
  }
  return printerCaja
}

/**
 * Imprime uno de los tres documentos.
 * @param {'print-receipt'|'print-fiscal'|'print-closing'} endpoint
 * @param {object} data payload tal como lo manda el web
 * @returns {Promise<string>} resumen para el log (el caller le pone el prefijo del
 *          transporte: "HTTP: …" o "POS: …")
 */
async function handlePrintJob(endpoint, data) {
  const printerCaja = activeCashierPrinter()

  if (endpoint === 'print-receipt') {
    const order = {
      order_number: data.order_number,
      table_label: data.table_label || null,
      table_number: data.table_number || null,
      order_type: data.order_type || null,
      // Campos del cliente para el ticket de delivery/takeout (la plantilla los
      // imprime como Cliente/Tel/Dir/Nota). Nombres idénticos a la BD/camino automático.
      customer_name: data.customer_name || null,
      customer_phone: data.customer_phone || null,
      customer_address: data.customer_address || null,
      // El whitelist de este mapeo es explícito: lo que no se liste NO llega a la
      // plantilla por muy bien que lo mande el web. cashier_name faltaba, y por eso
      // el "Cajero/a" no salía aunque el payload lo traía.
      cashier_name: data.cashier_name || null,
      notes: data.notes || null,
      delivery_fee: data.delivery_fee || null,
      items: (data.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.subtotal })),
      subtotal: data.subtotal,
      total: data.total,
      tip_amount: data.tip_amount,
      tip_pct: data.tip_pct,
      // Desglose de ITBIS del recibo, YA calculado por el web. Si no se lista acá NO
      // llega a la plantilla por muy bien que lo mande el web — es exactamente lo que
      // pasó con cashier_name y costó tres rondas.
      tax_base: data.tax_base ?? null,
      itbis: data.itbis ?? null,
      discount_amount: data.discount_amount,
      discount_pct: data.discount_pct,
      payment_method: data.payment_method,
      // Recibido/Cambio: el ticket los muestra en cobros en efectivo (transparencia
      // del cobro en la puerta). En el camino automático son columnas de pos_orders;
      // aquí hay que listarlos o no llegan a la plantilla.
      cash_given: data.cash_given ?? null,
      card_amount: data.card_amount ?? null,
      change_amount: data.change_amount ?? null,
      created_at: data.date
    }
    const businessInfo = {
      name: data.business_name || store.get('businessName', 'Mi Negocio'),
      legalName: store.get('businessLegalName', ''),
      rnc: store.get('businessRnc', ''),
      address: store.get('businessAddress', ''),
      currency: data.currency || store.get('businessCurrency', 'RD$'),
      itbisEnabled: store.get('businessItbisEnabled', false),
      showTaxBreakdown: store.get('businessShowTaxBreakdown', false)
    }
    console.log('[business] currency:', businessInfo.currency)
    // Ruteo por order_type: delivery/takeout usan la plantilla que desglosa
    // Subtotal + Envío + TOTAL; el resto (pos/mesa) sigue con el recibo POS.
    if (data.order_type === 'delivery' || data.order_type === 'takeout') {
      await printDeliveryTicket(order, printerCaja, businessInfo)
    } else {
      await printPOSReceipt(order, printerCaja, businessInfo)
    }
    return `Recibo impreso — Orden #${data.order_number}`
  }

  if (endpoint === 'print-fiscal') {
    data.currency = data.currency || store.get('businessCurrency', 'RD$')
    console.log('[business] currency:', data.currency)
    await printFiscalReceipt(data, printerCaja)
    return `Comprobante fiscal impreso — ${data.ncf || ''}`
  }

  if (endpoint === 'print-closing') {
    data.business_name = data.business_name || store.get('businessName', 'Mi Negocio')
    data.currency = data.currency || store.get('businessCurrency', 'RD$')
    console.log('[business] currency:', data.currency)
    await printClosingReport(data, printerCaja)
    return `Cierre de caja impreso — ${data.closing_id || data.closed_at || ''}`
  }

  // Inalcanzable por los dos transportes (ambos filtran contra la misma lista antes
  // de llegar aquí), pero un tercero futuro no puede colarse por defecto.
  throw new PrintJobError(`endpoint de impresión desconocido: ${endpoint}`, 404)
}

const PRINT_JOB_PATHS = new Set(['/print-receipt', '/print-fiscal', '/print-closing'])

async function handleRequest(req, res) {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const urlPath = req.url.split('?')[0]

  try {
    if (req.method === 'GET' && urlPath === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        connected: true,
        supabase_connected: isConnected,
        version: app.getVersion(),
        printer: store.get('printerName', ''),
        business: store.get('businessName', '')
      }))
      return
    }

    // Los tres documentos comparten handler: sólo cambian el parseo del cuerpo y los
    // códigos de respuesta. QUÉ se imprime y con qué campos vive en `handlePrintJob`,
    // que es la misma función que usa el IPC de la ventana del POS.
    if (req.method === 'POST' && PRINT_JOB_PATHS.has(urlPath)) {
      console.log(`[HTTP] POST ${urlPath} recibido`)
      const data = await parseBody(req)
      try {
        const summary = await handlePrintJob(urlPath.slice(1), data)
        sendLog(`HTTP: ${summary}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (err) {
        // 503 sin impresora de caja, como siempre; el resto, 500.
        res.writeHead(err.httpStatus || 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // Aquí vivía POST /print-comanda. Se eliminó en la 1.3.5: no tenía UN SOLO llamador
    // —verificado en el web completo, en la app nativa, en TitiPrint y en este mismo repo—
    // y arrastraba dos defectos que solo habrían aparecido el día que alguien lo usara:
    // clasificaba con `product_type === 'bar'` (el valor real es 'drink', así que ningún
    // trago calificaba nunca) y mandaba SIEMPRE a la impresora de cocina, sin poder llegar
    // jamás al bar. Un endpoint muerto con la lógica podrida no es código inofensivo: es la
    // trampa que muerde a quien lo estrene confiando en que funciona. Si algún día hace
    // falta imprimir una comanda por HTTP, se escribe de nuevo usando `isDrink` y las tres
    // impresoras, que es como lo hace hoy el camino de realtime.

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  } catch (err) {
    console.error('HTTP error:', err.message)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function startHttpServer() {
  const ports = [3001, 3002, 3003]

  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const server = http.createServer(handleRequest)
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          httpServer = server
          activePort = port
          store.set('httpPort', port)
          resolve()
        })
      })
      sendLog(`Servidor HTTP activo en puerto ${activePort}`)
      return
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        sendLog(`Error al iniciar servidor HTTP: ${err.message}`)
        return
      }
    }
  }

  sendLog('Error: puertos 3001-3003 ocupados, servidor HTTP no iniciado')
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => {
  const legacyPrinter = store.get('printerName', '')
  return {
    businessId: store.get('businessId', ''),
    businessName: store.get('businessName', ''),
    printerName: legacyPrinter,
    printerCaja: store.has('printerCaja') ? store.get('printerCaja') : legacyPrinter,
    printerCocina: store.has('printerCocina') ? store.get('printerCocina') : legacyPrinter,
    printerBar: store.has('printerBar') ? store.get('printerBar') : legacyPrinter,
    printMode: store.get('printMode', 'thermal'),
    paperWidth: store.get('paperWidth', '80mm'),
    printSpeed: store.get('printSpeed', 1),
    httpPort: activePort || store.get('httpPort', null),
    version: app.getVersion()
  }
})

ipcMain.handle('save-config', async (_event, config) => {
  console.log('[printers] Guardando configuración:', JSON.stringify(config))
  store.set('businessId', config.businessId)
  store.set('businessName', config.businessName)
  store.set('printerName', config.printerName) // Keep it for legacy fallback
  store.set('printerCaja', config.printerCaja || '')
  store.set('printerCocina', config.printerCocina || '')
  store.set('printerBar', config.printerBar || '')
  store.set('printMode', config.printMode || 'thermal')
  store.set('paperWidth', config.paperWidth || '80mm')
  store.set('printSpeed', parseInt(config.printSpeed) || 1)

  // Los datos del negocio ya NO se leen de `businesses`: llegan en el canje de la credencial.
  // Con credencial, esto reconecta con el JWT del equipo; sin ella, avisa qué falta.
  if (bridgeAuth.hasCredential()) {
    await startAuthenticatedListening()
  } else {
    sendLog('Configuración guardada. Falta conectar este equipo: inicia sesión con la cuenta del dueño.')
  }

  return { success: true }
})


// ── Credencial del equipo (login del dueño, una sola vez) ────────────────────
// Dos pasos separados a propósito: el primero solo valida y trae los negocios (para el
// selector si tiene más de uno); el segundo registra contra el elegido. Así el usuario ve el
// selector sin que se haya registrado nada todavía.
let pendingOwnerSession = null

ipcMain.handle('bridge-login', async (_e, { email, password }) => {
  const r = await bridgeAuth.signInOwner((email || '').trim(), password || '')
  if (!r.ok) return { success: false, error: r.error }
  pendingOwnerSession = { accessToken: r.accessToken, client: r.client }
  return { success: true, businesses: r.businesses }
})

ipcMain.handle('bridge-register', async (_e, { businessId, deviceName }) => {
  if (!pendingOwnerSession) return { success: false, error: 'Vuelve a iniciar sesión.' }
  const r = await bridgeAuth.registerDevice(pendingOwnerSession, businessId, deviceName)
  pendingOwnerSession = null            // la sesión del dueño muere acá, pase lo que pase
  if (!r.ok) return { success: false, error: r.error }
  applyBusinessInfo(r.business)
  await startAuthenticatedListening()
  return { success: true, device: r.device, persisted: r.persisted }
})

ipcMain.handle('bridge-status', () => ({
  connected: bridgeAuth.hasCredential(),
  business: bridgeAuth.getBusiness() || { name: store.get('businessName', '') },
  encryption: bridgeAuth.encryptionAvailable(),
}))

ipcMain.handle('bridge-disconnect', () => {
  bridgeAuth.forgetToken('el dueño desconectó este equipo')
  disconnect()
  return { success: true }
})

ipcMain.handle('get-printers', async () => {
  const printers = await getUSBPrinters()
  console.log('[printers] Lista completa:', JSON.stringify(printers))
  return printers
})

ipcMain.handle('test-print', async () => {
  const legacyPrinter = store.get('printerName', '')
  const printerCaja = store.has('printerCaja') ? store.get('printerCaja') : legacyPrinter
  const printerCocina = store.has('printerCocina') ? store.get('printerCocina') : legacyPrinter
  const printerBar = store.has('printerBar') ? store.get('printerBar') : legacyPrinter
  const businessName = store.get('businessName', 'Mi Negocio')

  const activePrinters = [...new Set([printerCaja, printerCocina, printerBar].filter(Boolean))]
  if (activePrinters.length === 0) return { success: false, error: 'No hay ninguna impresora configurada para probar' }

  try {
    let hasTestMode = false
    for (const printer of activePrinters) {
      await printTestPage(printer, businessName)
      if (printer === TEST_PRINTER_NAME) {
        hasTestMode = true
      }
    }
    if (hasTestMode) {
      const os = require('os')
      const testFilePath = process.platform === 'win32'
        ? path.join(os.tmpdir(), 'titimenu-print-test.txt')
        : '/tmp/titimenu-print-test.txt'
      new Notification({
        title: 'Impresión simulada',
        body: `Ver ${testFilePath}`
      }).show()
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('get-status', () => isConnected)

ipcMain.handle('reset-config', () => {
  disconnect()
  store.clear()
  return { success: true }
})

ipcMain.handle('check-for-updates', async () => {
  try {
    sendLog('Iniciando búsqueda manual de actualizaciones...')
    const result = await autoUpdater.checkForUpdatesAndNotify()
    return { success: true, updateInfo: result?.updateInfo }
  } catch (err) {
    sendLog(`Error en búsqueda manual: ${err.message}`)
    return { success: false, error: err.message }
  }
})

ipcMain.on('quit-and-install', () => {
  console.log('[updater] quit-and-install called')
  handleQuitAndInstall()
})

// ─── IPC de la ventana del POS ────────────────────────────────────────────────
// Estos DOS canales son lo único que ve el POS (ver `preload-pos.js`). Los demás
// canales del main —bridge-login, save-config, reset-config…— no le llegan porque el
// preload no expone `ipcRenderer`, sólo dos funciones.
//
// Aquí van las comprobaciones que de verdad cuentan. Las del preload son para fallar
// rápido; un renderer comprometido se las salta. Estas no.

const ALLOWED_PRINT_ENDPOINTS = new Set(['print-receipt', 'print-fiscal', 'print-closing'])

/**
 * ¿La llamada viene de la página del POS y no de cualquier cosa que haya acabado
 * cargándose en esa ventana (un iframe de terceros, una navegación a otro sitio, un
 * anuncio)? Se comprueba el ORIGEN del frame que llama, no la ventana.
 *
 * En builds de desarrollo se admite además el `next dev` local, para poder probar la
 * app contra un web sin desplegar. En el instalador (`app.isPackaged`) NO se admite:
 * si no, cualquier página servida desde la propia máquina podría imprimir.
 */
function isTrustedPosSender(event) {
  try {
    const url = event.senderFrame?.url || ''
    const { origin } = new URL(url)
    if (TRUSTED_POS_ORIGINS.has(origin)) return true
    if (!app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true
    console.warn(`[pos-ipc] llamada RECHAZADA desde un origen no autorizado: ${origin || '(vacío)'}`)
    return false
  } catch {
    console.warn('[pos-ipc] llamada RECHAZADA: no se pudo determinar el origen')
    return false
  }
}

ipcMain.handle('pos:get-status', (event) => {
  if (!isTrustedPosSender(event)) return null
  return {
    connected: true,
    version: app.getVersion(),
  }
})

ipcMain.handle('pos:print-job', async (event, args) => {
  if (!isTrustedPosSender(event)) return { ok: false, error: 'origen no autorizado' }

  // Lista DURA. Que la petición venga por IPC no la hace confiable: el `endpoint` es
  // texto que llega de una página remota y decide qué documento se imprime. Nada de
  // construir rutas con él, nada de aceptar lo que no esté en la lista.
  const endpoint = typeof args?.endpoint === 'string' ? args.endpoint : ''
  if (!ALLOWED_PRINT_ENDPOINTS.has(endpoint)) {
    console.warn(`[pos-ipc] endpoint RECHAZADO: ${JSON.stringify(args?.endpoint)}`)
    return { ok: false, error: 'endpoint no permitido' }
  }

  const payload = args?.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload inválido' }
  }

  try {
    // MISMA función que usa el servidor HTTP — el whitelist del payload, el
    // businessInfo y el ruteo por order_type viven en un solo sitio (pieza 3). Dos
    // copias del mapeo divergirían en silencio, que es el bug de `cashier_name`.
    const summary = await handlePrintJob(endpoint, payload)
    sendLog(`POS: ${summary}`)
    return { ok: true }
  } catch (err) {
    console.error(`[pos-ipc] fallo al imprimir ${endpoint}:`, err.message)
    return { ok: false, error: err.message }
  }
})

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.titimenu.printbridge')

  // Hide dock icon on Mac (tray-only app)
  if (app.dock) app.dock.hide()

  createTray()
  configurePosSession()
  buildAppMenu()

  // Credencial del EQUIPO (Opción B). init antes de cualquier canje: necesita el store y el
  // logger, y safeStorage solo está disponible con la app lista.
  bridgeAuth.init({
    store,
    logger: sendLog,
    stateChange: (st) => {
      if (st.kind === 'needs-login') {
        sendLog('Este equipo necesita iniciar sesión otra vez para imprimir los pedidos del menú.')
        createConfigWindow()
      }
    },
  })

  // Qué ventana abre la app. La decisión va DESPUÉS de `bridgeAuth.init` porque
  // `hasCredential()` no sabe nada antes de eso. Equipo registrado + impresora activa
  // → directo al POS, que es a lo que se viene; si falta algo, a la configuración,
  // que es donde se arregla.
  if (isPosReady()) {
    // La pregunta del rol va sólo la PRIMERA vez (o tras actualizar desde una versión
    // que no la tenía). A partir de ahí, directo a la URL que corresponda.
    if (!hasEntryMode()) await askEntryMode()
    updateTray()
    createPosWindow()
  } else {
    createConfigWindow()
  }

  if (bridgeAuth.hasCredential()) {
    await startAuthenticatedListening()
  } else if (store.get('businessId')) {
    // Instalación vieja: tiene el UUID pegado a mano pero no credencial. Se le dice qué
    // falta en vez de arrancar en silencio por la política abierta (que además va a cerrarse).
    sendLog('Este equipo todavía no está conectado: inicia sesión con la cuenta del dueño en la configuración.')
  }

  await startHttpServer()

  setTimeout(() => {
    try { autoUpdater.checkForUpdatesAndNotify() } catch (e) { sendLog(`Error de actualización: ${e.message}`) }
  }, 10000)

  // Verificación cada 24 horas (como solicitó el usuario)
  setInterval(() => {
    try { autoUpdater.checkForUpdatesAndNotify() } catch (e) { sendLog(`Error de actualización: ${e.message}`) }
  }, 24 * 60 * 60 * 1000)
})

app.on('window-all-closed', () => {
  // Keep running in tray even when all windows are closed
})

app.on('before-quit', () => {
  disconnect()
  if (httpServer) httpServer.close()
})