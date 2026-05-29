const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const http = require('http')
const Store = require('electron-store')
const { getUSBPrinters, printPOSReceipt, printFiscalReceipt, printTableComanda, printDeliveryTicket, printKitchenComanda, printBarComanda, printTestPage, TEST_PRINTER_NAME } = require('./printer')
const { setCallbacks, startListening, disconnect, fetchBusinessInfo } = require('./supabase')

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
        detail: 'Apple exige obligatoriamente que las aplicaciones de macOS estén firmadas digitalmente con un certificado de desarrollador oficial para poder auto-actualizarse.\n\nAl ser una compilación local/no firmada, el sistema de seguridad de macOS bloquea el reemplazo automático de los archivos.\n\nPor favor, descarga e instala la versión v1.0.7 manualmente usando el archivo DMG desde el repositorio de GitHub.',
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
    title: 'TitiMenu Print Bridge',
    body: `Descargando actualización v${info.version}`
  }).show()
})

autoUpdater.on('update-not-available', () => {
  sendLog('TitiMenu Print Bridge está actualizado')
  sendUpdateStatus('not-available')
})

autoUpdater.on('update-downloaded', (info) => {
  updateReady = true
  sendLog(`✅ Actualización v${info.version} lista — se instalará al cerrar`)
  sendUpdateStatus('downloaded', info)
  new Notification({
    title: 'TitiMenu Print Bridge',
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
    title: 'TitiMenu Print Bridge — Configuración',
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
      ? 'TitiMenu Print Bridge — Conectado'
      : 'TitiMenu Print Bridge — Desconectado'
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
    { label: 'Abrir configuración', click: () => createConfigWindow() },
    {
      label: 'Estado',
      click: () => {
        const businessId = store.get('businessId', '')
        const printerName = store.get('printerName', '')
        dialog.showMessageBox({
          type: 'info',
          title: 'Estado',
          message: 'TitiMenu Print Bridge',
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
        const businessId = store.get('businessId')
        if (businessId) {
          disconnect()
          setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder, onLogger: sendLog })
          startListening(businessId)
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
      title: 'TitiMenu Print Bridge',
      body: 'Conectado — escuchando órdenes'
    }).show()
  }
}

// ─── New Order Handler ────────────────────────────────────────────────────────

async function onNewOrder(type, order) {
  const legacyPrinter = store.get('printerName', '')
  const printerCaja = store.get('printerCaja') || legacyPrinter || ''
  const printerCocina = store.get('printerCocina') || legacyPrinter || ''
  const printerBar = store.get('printerBar') || legacyPrinter || ''
  const businessName = store.get('businessName', 'Mi Negocio')

  if (!printerCaja && !printerCocina && !printerBar) {
    new Notification({
      title: 'TitiMenu Print Bridge',
      body: 'Nueva orden recibida pero no hay ninguna impresora activa configurada'
    }).show()
    return
  }

  const items = order.items || order.order_items || []
  const foodItems = items.filter(item => item.product_type !== 'drink')
  const drinkItems = items.filter(item => item.product_type === 'drink')

  const printComandas = async () => {
    if (printerCocina === printerBar) {
      if (printerCocina) {
        await printTableComanda(order, printerCocina, businessName)
      }
    } else {
      if (foodItems.length > 0 && printerCocina) {
        await printKitchenComanda(foodItems, printerCocina, order)
      }
      if (drinkItems.length > 0 && printerBar) {
        await printBarComanda(drinkItems, printerBar, order)
      }
    }
  }

  try {
    if (type === 'pos') {
      const businessInfo = {
        name: businessName,
        legalName: store.get('businessLegalName', ''),
        rnc: store.get('businessRnc', ''),
        address: store.get('businessAddress', '')
      }
      if (printerCaja) {
        await printPOSReceipt(order, printerCaja, businessInfo)
      }
      // Also separate and print kitchen/bar comandas for POS orders!
      await printComandas()
    } else if (type === 'table') {
      await printComandas()
    } else if (type === 'delivery') {
      if (printerCaja) {
        await printDeliveryTicket(order, printerCaja, businessName)
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

    if (req.method === 'POST' && urlPath === '/print-receipt') {
      console.log('[HTTP] POST /print-receipt recibido')
      const data = await parseBody(req)
      const legacyPrinter = store.get('printerName', '')
      const printerCaja = store.get('printerCaja') || legacyPrinter || ''
      if (!printerCaja) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No hay impresora de caja configurada' }))
        return
      }
      const order = {
        order_number: data.order_number,
        items: (data.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.subtotal })),
        subtotal: data.subtotal,
        total: data.total,
        tip_amount: data.tip_amount,
        tip_pct: data.tip_pct,
        discount_amount: data.discount_amount,
        discount_pct: data.discount_pct,
        payment_method: data.payment_method,
        created_at: data.date
      }
      const businessInfo = {
        name: data.business_name || store.get('businessName', 'Mi Negocio'),
        legalName: store.get('businessLegalName', ''),
        rnc: store.get('businessRnc', ''),
        address: store.get('businessAddress', '')
      }
      await printPOSReceipt(order, printerCaja, businessInfo)
      sendLog(`HTTP: Recibo impreso — Orden #${data.order_number}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
      return
    }

    if (req.method === 'POST' && urlPath === '/print-fiscal') {
      console.log('[HTTP] POST /print-fiscal recibido')
      const data = await parseBody(req)
      const legacyPrinter = store.get('printerName', '')
      const printerCaja = store.get('printerCaja') || legacyPrinter || ''
      if (!printerCaja) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No hay impresora de caja configurada' }))
        return
      }
      await printFiscalReceipt(data, printerCaja)
      sendLog(`HTTP: Comprobante fiscal impreso — ${data.ncf || ''}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
      return
    }

    if (req.method === 'POST' && urlPath === '/print-comanda') {
      const data = await parseBody(req)
      const legacyPrinter = store.get('printerName', '')
      const printerCocina = store.get('printerCocina') || legacyPrinter || ''
      const printerName = data.target_printer || printerCocina
      if (!printerName) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No hay impresora configurada para comanda' }))
        return
      }
      const order = {
        table_label: data.table_label,
        id: String(data.order_number || ''),
        items: (data.items || []).map(i => ({ name: i.name, qty: i.qty, bar: i.product_type === 'bar' })),
        created_at: data.date
      }
      await printTableComanda(order, printerName, store.get('businessName', 'Mi Negocio'))
      sendLog(`HTTP: Comanda impresa — Mesa ${data.table_label}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
      return
    }

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
    printerCaja: store.get('printerCaja', legacyPrinter),
    printerCocina: store.get('printerCocina', legacyPrinter),
    printerBar: store.get('printerBar', legacyPrinter),
    printMode: store.get('printMode', 'thermal'),
    paperWidth: store.get('paperWidth', '80mm'),
    httpPort: activePort || store.get('httpPort', null),
    version: app.getVersion()
  }
})

ipcMain.handle('save-config', async (_event, config) => {
  store.set('businessId', config.businessId)
  store.set('businessName', config.businessName)
  store.set('printerName', config.printerName) // Keep it for legacy fallback
  store.set('printerCaja', config.printerCaja || '')
  store.set('printerCocina', config.printerCocina || '')
  store.set('printerBar', config.printerBar || '')
  store.set('printMode', config.printMode || 'thermal')
  store.set('paperWidth', config.paperWidth || '80mm')

  const bizInfo = await fetchBusinessInfo(config.businessId)
  store.set('businessLegalName', bizInfo.legal_name || '')
  store.set('businessRnc', bizInfo.rnc || '')
  store.set('businessAddress', bizInfo.address || '')

  disconnect()
  setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder, onLogger: sendLog })
  startListening(config.businessId)

  return { success: true }
})

ipcMain.handle('get-printers', async () => {
  return await getUSBPrinters()
})

ipcMain.handle('test-print', async () => {
  const legacyPrinter = store.get('printerName', '')
  const printerCaja = store.get('printerCaja') || legacyPrinter || ''
  const printerCocina = store.get('printerCocina') || legacyPrinter || ''
  const printerBar = store.get('printerBar') || legacyPrinter || ''
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

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.titimenu.printbridge')

  // Hide dock icon on Mac (tray-only app)
  if (app.dock) app.dock.hide()

  createTray()

  // Always open config window on startup
  createConfigWindow()

  // If there's a saved businessId, also start listening in the background
  const businessId = store.get('businessId')
  if (businessId) {
    setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder, onLogger: sendLog })
    startListening(businessId)
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
