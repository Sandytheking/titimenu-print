const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog } = require('electron')
const path = require('path')
const Store = require('electron-store')
const { getUSBPrinters, printPOSReceipt, printTableComanda, printDeliveryTicket, printTestPage } = require('./printer')
const { setCallbacks, startListening, disconnect } = require('./supabase')

const store = new Store()

let tray = null
let configWindow = null
let isConnected = false

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
    height: 580,
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

  const menu = Menu.buildFromTemplate([
    {
      label: isConnected ? '● Conectado' : '○ Desconectado',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Configuración', click: () => createConfigWindow() },
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
          startListening(businessId)
        } else {
          createConfigWindow()
        }
      }
    },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() }
  ])

  tray.setContextMenu(menu)
}

// ─── Connection Status ────────────────────────────────────────────────────────

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
  const printerName = store.get('printerName')
  const businessName = store.get('businessName', 'Mi Negocio')

  if (!printerName) {
    new Notification({
      title: 'TitiMenu Print Bridge',
      body: 'Nueva orden recibida pero no hay impresora configurada'
    }).show()
    return
  }

  try {
    if (type === 'pos') {
      await printPOSReceipt(order, printerName, businessName)
    } else if (type === 'table') {
      await printTableComanda(order, printerName, businessName)
    } else if (type === 'delivery') {
      await printDeliveryTicket(order, printerName, businessName)
    }
  } catch (err) {
    console.error('Print error:', err.message)
    new Notification({
      title: 'Error de impresión',
      body: err.message || 'No se pudo imprimir. Verifica que la impresora esté encendida.'
    }).show()
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => ({
  businessId: store.get('businessId', ''),
  businessName: store.get('businessName', ''),
  printerName: store.get('printerName', '')
}))

ipcMain.handle('save-config', (_event, config) => {
  store.set('businessId', config.businessId)
  store.set('businessName', config.businessName)
  store.set('printerName', config.printerName)

  disconnect()
  setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder })
  startListening(config.businessId)

  return { success: true }
})

ipcMain.handle('get-printers', async () => {
  return await getUSBPrinters()
})

ipcMain.handle('test-print', async () => {
  const printerName = store.get('printerName')
  const businessName = store.get('businessName', 'Mi Negocio')
  if (!printerName) return { success: false, error: 'No hay impresora configurada' }
  try {
    await printTestPage(printerName, businessName)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('get-status', () => isConnected)

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.titimenu.printbridge')

  // Hide dock icon on Mac (tray-only app)
  if (app.dock) app.dock.hide()

  createTray()

  const businessId = store.get('businessId')

  if (!businessId) {
    createConfigWindow()
  } else {
    setCallbacks({ onStatus: onStatusChange, onOrder: onNewOrder })
    startListening(businessId)
  }
})

app.on('window-all-closed', () => {
  // Keep running in tray even when all windows are closed
})

app.on('before-quit', () => {
  disconnect()
})
