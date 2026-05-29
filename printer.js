const { printer: ThermalPrinter, types: PrinterTypes, BreakLine } = require('node-thermal-printer')
const { exec } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const execAsync = promisify(exec)

const Store = require('electron-store')
const store = new Store()
const { BrowserWindow } = require('electron')

const TEST_MODE = false
const os = require('os')
const TEST_FILE = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'titimenu-print-test.txt')
  : '/tmp/titimenu-print-test.txt'

const TEST_FILE_HTML = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'titimenu-print-test.html')
  : '/tmp/titimenu-print-test.html'

const TEST_PRINTER_NAME = 'TEST_MODE'

// ─── Test mode: write text to file and show notification ─────────────────────

function writeTestOutput(lines) {
  const separator = '\n' + '='.repeat(40) + '\n'
  const timestamp = `[${new Date().toLocaleString('es-DO')}]`
  const content = timestamp + '\n' + lines.join('\n') + '\n'

  // Append so multiple orders accumulate in the file
  fs.appendFileSync(TEST_FILE, separator + content)
}

function isTestMode(printerName) {
  return TEST_MODE || printerName === TEST_PRINTER_NAME
}

// ─── Printer discovery ────────────────────────────────────────────────────────

async function getUSBPrinters() {
  const printers = []
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      const { stdout } = await execAsync("lpstat -p 2>/dev/null | awk '{print $2}' || echo ''")
      stdout.split('\n').forEach(name => {
        name = name.trim()
        if (name) printers.push({ name, displayName: name })
      })
    } else if (platform === 'win32') {
      const { stdout } = await execAsync('wmic printer get Name /format:list 2>nul')
      stdout.split('\n').forEach(line => {
        const name = line.replace(/^Name=/, '').trim()
        if (name) printers.push({ name, displayName: name })
      })
    } else {
      const { stdout } = await execAsync("lpstat -p 2>/dev/null | awk '{print $2}' || echo ''")
      stdout.split('\n').forEach(name => {
        name = name.trim()
        if (name) printers.push({ name, displayName: name })
      })
    }
  } catch (err) {
    console.error('Error listing printers:', err.message)
  }

  // Always append test mode option at the end
  printers.push({ name: TEST_PRINTER_NAME, displayName: 'Modo prueba (sin impresora)' })

  return printers
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function pad(str, len, right = false) {
  str = String(str || '')
  if (str.length >= len) return str.substring(0, len)
  const padding = ' '.repeat(len - str.length)
  return right ? padding + str : str + padding
}

function center(str, width = 32) {
  str = String(str || '')
  if (str.length >= width) return str
  const total = width - str.length
  const left = Math.floor(total / 2)
  return ' '.repeat(left) + str
}

function formatDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatTime(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
}

function formatMoney(amount) {
  return parseFloat(amount || 0).toFixed(2)
}

// ─── Real printer factory ─────────────────────────────────────────────────────

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/

async function createPrinter(printerName) {
  let interfaceStr

  console.log('[printer] Using printer:', printerName, 'platform:', process.platform)

  if (IP_RE.test(printerName.trim())) {
    interfaceStr = `tcp://${printerName.trim()}:9100`
  } else if (process.platform === 'win32') {
    interfaceStr = printerName.trim() // Windows: solo el nombre directo de la impresora
  } else {
    interfaceStr = `printer:${printerName.trim()}` // Mac/Linux
  }

  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceStr,
    characterSet: 'PC858_EURO',
    removeSpecialCharacters: true,
    lineCharacter: '-',
    breakLine: BreakLine.WORD,
    options: { timeout: 5000 }
  })
}

// ─── HTML Silent Printing Engine & Templates ──────────────────────────────────

function getBaseHTML(styles, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${styles}
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`
}

function getReceiptStyles(paperWidth) {
  const is58 = paperWidth === '58mm'
  const width = is58 ? '48mm' : '72mm'
  const fontSize = is58 ? '10px' : '12px'
  const titleSize = is58 ? '13px' : '16px'
  const subTitleSize = is58 ? '11px' : '13px'

  return `
    @page { margin: 0; size: auto; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: ${fontSize};
      line-height: 1.4;
      color: #000;
      width: ${width};
      margin: 0 auto;
      padding: 4mm 1mm;
      box-sizing: border-box;
      background: #fff;
    }
    .center { text-align: center; }
    .right { text-align: right; }
    .bold { font-weight: bold; }
    .text-large { font-size: ${titleSize}; font-weight: bold; }
    .text-medium { font-size: ${subTitleSize}; font-weight: bold; }
    
    .divider {
      border-top: 1px dashed #000;
      margin: 6px 0;
    }
    .divider-double {
      border-top: 3px double #000;
      margin: 6px 0;
    }
    
    .header { margin-bottom: 8px; }
    .business-name { font-size: ${titleSize}; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; }
    .business-details { color: #333; font-size: 0.95em; margin-bottom: 1px; }
    
    table { width: 100%; border-collapse: collapse; }
    .items-table th { border-bottom: 1px solid #000; padding: 3px 0; text-align: left; font-weight: bold; }
    .items-table td { padding: 4px 0; vertical-align: top; }
    .totals-table td { padding: 2px 0; }
    
    .footer { margin-top: 12px; font-size: 0.9em; color: #333; }
    .tag { display: inline-block; border: 1px solid #000; padding: 2px 6px; font-weight: bold; margin: 4px 0; border-radius: 3px; }
    .notes { font-style: italic; color: #555; font-size: 0.95em; margin-left: 8px; margin-top: 1px; }
    .comanda-section-header {
      background: #f0f0f0;
      text-align: center;
      font-weight: bold;
      padding: 3px 0;
      margin: 8px 0 4px;
      text-transform: uppercase;
      border-radius: 2px;
      border: 1px solid #ccc;
      font-size: 0.95em;
    }
    .delivery-box {
      border: 1px solid #000;
      padding: 6px;
      margin-top: 8px;
      border-radius: 4px;
      font-size: 0.95em;
    }
    .delivery-box div { margin-bottom: 2px; }
  `
}

async function printHTML(htmlContent, printerName) {
  if (isTestMode(printerName)) {
    const separator = '\n' + '='.repeat(40) + '\n'
    const timestamp = `[${new Date().toLocaleString('es-DO')}] [MODO SISTEMA HTML]`
    fs.appendFileSync(TEST_FILE_HTML, separator + timestamp + '\n' + htmlContent + '\n')
    
    const cleanText = htmlContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    writeTestOutput(['--- SIMULACIÓN MODO SISTEMA ---', ...cleanText])
    return
  }

  return new Promise((resolve, reject) => {
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))

    printWindow.webContents.on('did-finish-load', () => {
      const printDelay = process.platform === 'win32' ? 2000 : 800
      console.log(`[printer] HTML loaded. Waiting ${printDelay}ms before printing...`)
      
      setTimeout(() => {
        const device = printerName === TEST_PRINTER_NAME ? '' : printerName
        console.log(`[printer] Sending HTML to printer: ${device}`)
        
        printWindow.webContents.print({
          silent: true,
          printBackground: true,
          deviceName: device,
          margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
          pageSize: { width: 80000, height: 297000 } // 80mm en microns
        }, (success, errorType) => {
          console.log('[printer] Print result:', success, errorType)
          // NO cerrar la ventana hasta que el callback confirme que la impresión fue enviada
          setTimeout(() => {
            printWindow.destroy()
            if (success) {
              resolve()
            } else {
              reject(new Error(`Fallo al imprimir vía sistema: ${errorType}`))
            }
          }, 500)
        })
      }, printDelay)
    })

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      printWindow.destroy()
      reject(new Error(`Fallo al cargar plantilla: ${errorDescription}`))
    })
  })
}

function generatePOSReceiptHTML(order, businessInfo, paperWidth) {
  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''
  
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const items = order.items || order.order_items || []
  const total = parseFloat(order.total || order.total_amount || 0)
  const tip = parseFloat(order.tip_amount || 0)
  const hasTip = tip > 0
  const discount = parseFloat(order.discount_amount || 0)
  const hasDiscount = discount > 0
  const showBreakdown = hasTip || hasDiscount
  const subtotal = showBreakdown
    ? parseFloat(order.subtotal || (total + discount - tip))
    : 0
  const tipPct = hasTip && order.tip_pct ? parseFloat(order.tip_pct) : null
  const tipLabel = tipPct ? `Propina (${tipPct}%):` : 'Propina:'
  const discountPct = hasDiscount && order.discount_pct ? parseFloat(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  const payMethod = order.payment_method || 'Efectivo'
  const posNum = order.order_number || order.id?.slice(-6) || '000'

  let itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const unitPrice = item.unit_price || item.price || 0
    const itemTotal = unitPrice * qty
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">RD$${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  let breakdownHtml = ''
  if (showBreakdown) {
    breakdownHtml = `
      <tr>
        <td>SUBTOTAL:</td>
        <td class="right">RD$${formatMoney(subtotal)}</td>
      </tr>
      ${hasDiscount ? `
      <tr>
        <td>${discountLabel}</td>
        <td class="right">-RD$${formatMoney(discount)}</td>
      </tr>` : ''}
      ${hasTip ? `
      <tr>
        <td>${tipLabel}</td>
        <td class="right">+RD$${formatMoney(tip)}</td>
      </tr>` : ''}
    `
  }

  const bodyContent = `
    <div class="header center">
      <div class="business-name">${bizName}</div>
      ${legalName ? `<div class="business-details">${legalName}</div>` : ''}
      ${rnc ? `<div class="business-details">RNC: ${rnc}</div>` : ''}
      ${address ? `<div class="business-details">${address}</div>` : ''}
      <div class="tag">POS #${posNum}</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        ${breakdownHtml}
        <tr class="bold text-medium">
          <td>TOTAL:</td>
          <td class="right">RD$${formatMoney(total)}</td>
        </tr>
        <tr>
          <td style="padding-top: 6px;">Pago: ${payMethod}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
    
    <div class="divider-double"></div>
    
    <div class="footer center">
      ¡Gracias por su visita!
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateTableComandaHTML(order, businessName, paperWidth) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = order.table_label || order.table_number || order.table_id || '?'
  const shortId = (order.id || '000000').slice(-6).toUpperCase()
  const items = order.items || order.order_items || []
  const kitchenItems = items.filter(i => !i.bar && i.category !== 'bar' && i.station !== 'bar')
  const barItems = items.filter(i => i.bar || i.category === 'bar' || i.station === 'bar')
  const allItems = kitchenItems.length === 0 && barItems.length === 0 ? items : []

  function renderItemsList(itemList) {
    return itemList.map(item => {
      const qty = item.quantity || item.qty || 1
      const name = item.name || item.product_name || ''
      const notes = item.notes || item.special_instructions || ''
      return `
        <div style="padding: 3px 0;">
          <span class="bold">${qty}x</span> ${name}
          ${notes ? `<div class="notes">* ${notes}</div>` : ''}
        </div>
      `
    }).join('')
  }

  let sectionsHtml = ''
  if (kitchenItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Cocina</div>
      <div>${renderItemsList(kitchenItems)}</div>
    `
  }
  if (barItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Bar</div>
      <div>${renderItemsList(barItems)}</div>
    `
  }
  if (allItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Items</div>
      <div>${renderItemsList(allItems)}</div>
    `
  }

  const bodyContent = `
    <div class="header center">
      <div class="text-large">** COMANDA **</div>
      <div class="tag" style="font-size: 1.15em;">MESA ${tableLabel}</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <div>
      ${sectionsHtml}
    </div>
    
    <div class="divider-double"></div>
    
    <div class="footer center bold">
      Orden #${shortId}
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateDeliveryTicketHTML(order, businessName, paperWidth) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const typeLabel = (order.order_type || 'delivery').toUpperCase()
  const customerName = order.customer_name || order.client_name || 'Cliente'
  const customerPhone = order.customer_phone || order.phone || order.tel || 'N/A'
  const items = order.items || order.order_items || []
  const total = order.total || order.total_amount || 0
  const address = order.delivery_address || order.address || ''

  let itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const unitPrice = item.unit_price || item.price || 0
    const itemTotal = unitPrice * qty
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">RD$${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="text-large">** ${typeLabel} **</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <div style="margin-bottom: 6px;">
      <div><span class="bold">Cliente:</span> ${customerName}</div>
      <div><span class="bold">Teléfono:</span> ${customerPhone}</div>
    </div>
    
    <div class="divider"></div>
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        <tr class="bold text-medium">
          <td>TOTAL:</td>
          <td class="right">RD$${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>
    
    ${address ? `
      <div class="delivery-box">
        <div class="bold" style="border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 4px;">DIRECCIÓN DE ENVÍO:</div>
        <div>${address}</div>
      </div>
    ` : ''}
    
    <div class="divider-double"></div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateFiscalReceiptHTML(data, paperWidth) {
  const bizName = data.business_name || 'MI NEGOCIO'
  const legalName = data.legal_name || ''
  const rnc = data.rnc || ''
  const address = data.address || ''
  const ncf = data.ncf || ''
  const ncfType = data.ncf_type || 'B02'
  const ncfLabel = ncfType === 'B01' ? 'Crédito Fiscal' : 'Consumidor Final'
  const items = data.items || []
  const subtotal = parseFloat(data.subtotal || 0)
  const itbis = parseFloat(data.itbis || 0)
  const total = parseFloat(data.total || 0)
  const tip = parseFloat(data.tip_amount || 0)
  const hasTip = tip > 0
  const dateStr = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })

  let itemsHtml = items.map(item => {
    const qty = item.qty || 1
    const name = item.name || ''
    const unitPrice = item.price || 0
    const itemTotal = item.subtotal || (unitPrice * qty)
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">RD$${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="business-name">${bizName}</div>
      ${legalName ? `<div class="business-details">${legalName}</div>` : ''}
      <div class="business-details">RNC: ${rnc}</div>
      ${address ? `<div class="business-details">${address}</div>` : ''}
      
      <div class="divider" style="margin: 8px 0 4px;"></div>
      <div class="bold" style="font-size: 1.1em; text-transform: uppercase;">Comprobante Fiscal</div>
      <div class="tag" style="font-size: 1.15em; margin: 3px 0;">${ncf}</div>
      <div class="business-details bold">${ncfLabel}</div>
      <div class="business-details" style="margin-top: 3px;">Fecha: ${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        <tr>
          <td>Base Imponible:</td>
          <td class="right">RD$${formatMoney(subtotal)}</td>
        </tr>
        <tr>
          <td>ITBIS (18%):</td>
          <td class="right">+RD$${formatMoney(itbis)}</td>
        </tr>
        ${hasTip ? `
        <tr>
          <td>Propina:</td>
          <td class="right">+RD$${formatMoney(tip)}</td>
        </tr>` : ''}
        <tr class="bold text-medium" style="border-top: 1px solid #000;">
          <td style="padding-top: 4px;">TOTAL:</td>
          <td class="right" style="padding-top: 4px;">RD$${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>
    
    ${(ncfType === 'B02' && data.client_name) ? `
      <div class="delivery-box" style="margin-top: 10px;">
        <div><span class="bold">Cliente:</span> ${data.client_name}</div>
        ${data.client_rnc ? `<div><span class="bold">RNC:</span> ${data.client_rnc}</div>` : ''}
      </div>
    ` : ''}
    
    <div class="divider-double"></div>
    
    <div class="footer center">
      ¡Gracias por su visita!
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateTestReceiptHTML(businessName, paperWidth) {
  const dateStr = new Date().toLocaleString('es-DO')
  const bodyContent = `
    <div class="header center">
      <div class="text-large">TitiMenu Print Bridge</div>
      <div class="business-name" style="margin-top: 4px;">${businessName || 'Mi Negocio'}</div>
      <div class="tag">PÁGINA DE PRUEBA</div>
      <div class="business-details" style="margin-top: 6px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    <div class="center" style="padding: 10px 0;">
      <span class="bold">¡Impresora configurada OK!</span><br>
      El modo de impresión por sistema (HTML) funciona correctamente en tu impresora.
    </div>
    <div class="divider-double"></div>
  `
  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

// ─── POS Receipt ──────────────────────────────────────────────────────────────

async function printPOSReceipt(order, printerName, businessInfo) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generatePOSReceiptHTML(order, businessInfo, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''

  const LINE = '================================'
  const DASH = '--------------------------------'
  const W = 32
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const items = order.items || order.order_items || []
  const total = parseFloat(order.total || order.total_amount || 0)
  const tip = parseFloat(order.tip_amount || 0)
  const hasTip = tip > 0
  const discount = parseFloat(order.discount_amount || 0)
  const hasDiscount = discount > 0
  const showBreakdown = hasTip || hasDiscount
  const subtotal = showBreakdown
    ? parseFloat(order.subtotal || (total + discount - tip))
    : 0
  const tipPct = hasTip && order.tip_pct ? parseFloat(order.tip_pct) : null
  const tipLabel = tipPct ? `Propina (${tipPct}%):` : 'Propina:'
  const discountPct = hasDiscount && order.discount_pct ? parseFloat(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  const payMethod = order.payment_method || 'Efectivo'
  const posNum = order.order_number || order.id?.slice(-6) || '000'

  const lines = [
    LINE,
    center(bizName, W),
    ...(legalName ? [center(legalName, W)] : []),
    ...(rnc ? [center(`RNC: ${rnc}`, W)] : []),
    ...(address ? [center(address, W)] : []),
    center(`POS #${posNum}`, W),
    center(dateStr, W),
    LINE,
    ...items.map(item => {
      const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
      const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
      const spaces = W - left.length - right.length
      return left + ' '.repeat(Math.max(1, spaces)) + right
    }),
    DASH,
    ...(showBreakdown ? [
      pad('SUBTOTAL:', 16) + pad(`RD$${formatMoney(subtotal)}`, 16, true),
      ...(hasDiscount ? [pad(discountLabel, 16) + pad(`-RD$${formatMoney(discount)}`, 16, true)] : []),
      ...(hasTip ? [pad(tipLabel, 16) + pad(`+RD$${formatMoney(tip)}`, 16, true)] : []),
    ] : []),
    pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true),
    `Pago: ${payMethod}`,
    LINE,
    center('¡Gracias por su visita!', W),
    LINE,
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  if (!await printer.isPrinterConnected()) throw new Error('Impresora no disponible')

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(bizName, W))
  if (legalName) printer.println(center(legalName, W))
  if (rnc) printer.println(center(`RNC: ${rnc}`, W))
  if (address) printer.println(center(address, W))
  printer.println(center(`POS #${posNum}`, W))
  printer.println(center(dateStr, W))
  printer.println(LINE)
  printer.alignLeft()
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    const spaces = W - left.length - right.length
    printer.println(left + ' '.repeat(Math.max(1, spaces)) + right)
  })
  printer.println(DASH)
  if (showBreakdown) {
    printer.println(pad('SUBTOTAL:', 16) + pad(`RD$${formatMoney(subtotal)}`, 16, true))
    if (hasDiscount) printer.println(pad(discountLabel, 16) + pad(`-RD$${formatMoney(discount)}`, 16, true))
    if (hasTip) printer.println(pad(tipLabel, 16) + pad(`+RD$${formatMoney(tip)}`, 16, true))
  }
  printer.println(pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true))
  printer.println(`Pago: ${payMethod}`)
  printer.println(LINE)
  printer.alignCenter()
  printer.println('¡Gracias por su visita!')
  printer.println(LINE)
  printer.cut()
  await printer.execute()
}

// ─── Table Comanda ────────────────────────────────────────────────────────────

async function printTableComanda(order, printerName, businessName) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateTableComandaHTML(order, businessName, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const LINE = '================================'
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = order.table_label || order.table_number || order.table_id || '?'
  const shortId = (order.id || '000000').slice(-6).toUpperCase()
  const items = order.items || order.order_items || []
  const kitchenItems = items.filter(i => !i.bar && i.category !== 'bar' && i.station !== 'bar')
  const barItems = items.filter(i => i.bar || i.category === 'bar' || i.station === 'bar')
  const allItems = kitchenItems.length === 0 && barItems.length === 0 ? items : []

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(`** COMANDA - MESA ${tableLabel} **`),
      center(dateStr),
      LINE,
      ...(kitchenItems.length > 0 ? ['--- COCINA ---', ...kitchenItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      ...(barItems.length > 0 ? ['--- BAR ---', ...barItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      ...(allItems.length > 0 ? ['--- ITEMS ---', ...allItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      LINE,
      center(`Orden #${shortId}`),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  if (!await printer.isPrinterConnected()) throw new Error('Impresora no disponible')

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(center(`** COMANDA - MESA ${tableLabel} **`))
  printer.bold(false)
  printer.println(center(dateStr))
  printer.println(LINE)
  printer.alignLeft()

  if (kitchenItems.length > 0) {
    printer.alignCenter(); printer.println('--- COCINA ---'); printer.alignLeft()
    kitchenItems.forEach(item => {
      printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
      if (item.notes || item.special_instructions) printer.println(`   * ${item.notes || item.special_instructions}`)
    })
  }
  if (barItems.length > 0) {
    printer.alignCenter(); printer.println('--- BAR ---'); printer.alignLeft()
    barItems.forEach(item => printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`))
  }
  if (allItems.length > 0) {
    printer.alignCenter(); printer.println('--- ITEMS ---'); printer.alignLeft()
    allItems.forEach(item => printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`))
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(`Orden #${shortId}`))
  printer.println(LINE)
  printer.cut()
  await printer.execute()
}

// ─── Delivery / Takeout Ticket ────────────────────────────────────────────────

async function printDeliveryTicket(order, printerName, businessName) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateDeliveryTicketHTML(order, businessName, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const LINE = '================================'
  const DASH = '--------------------------------'
  const W = 32
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const typeLabel = (order.order_type || 'delivery').toUpperCase()
  const customerName = order.customer_name || order.client_name || 'Cliente'
  const customerPhone = order.customer_phone || order.phone || order.tel || 'N/A'
  const items = order.items || order.order_items || []
  const total = order.total || order.total_amount || 0

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(`** ${typeLabel} **`),
      center(dateStr),
      LINE,
      `Cliente: ${customerName}`,
      `Tel: ${customerPhone}`,
      DASH,
      ...items.map(item => {
        const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
        const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
        const spaces = W - left.length - right.length
        return left + ' '.repeat(Math.max(1, spaces)) + right
      }),
      DASH,
      pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true),
      ...(order.delivery_address || order.address ? [DASH, `Dir: ${order.delivery_address || order.address}`] : []),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  if (!await printer.isPrinterConnected()) throw new Error('Impresora no disponible')

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(center(`** ${typeLabel} **`))
  printer.bold(false)
  printer.println(center(dateStr))
  printer.println(LINE)
  printer.alignLeft()
  printer.println(`Cliente: ${customerName}`)
  printer.println(`Tel: ${customerPhone}`)
  printer.println(DASH)
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    const spaces = W - left.length - right.length
    printer.println(left + ' '.repeat(Math.max(1, spaces)) + right)
  })
  printer.println(DASH)
  printer.println(pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true))
  if (order.delivery_address || order.address) {
    printer.println(DASH)
    printer.println(`Dir: ${order.delivery_address || order.address}`)
  }
  printer.println(LINE)
  printer.cut()
  await printer.execute()
}

// ─── Test page ────────────────────────────────────────────────────────────────

async function printTestPage(printerName, businessName) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateTestReceiptHTML(businessName, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const lines = [
    '================================',
    '  TitiMenu Print Bridge',
    businessName || 'Mi Negocio',
    '================================',
    'Impresora configurada OK!',
    new Date().toLocaleString('es-DO'),
    '================================',
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  printer.alignCenter()
  printer.println('================================')
  printer.bold(true)
  printer.println('  TitiMenu Print Bridge')
  printer.bold(false)
  printer.println(businessName || 'Mi Negocio')
  printer.println('================================')
  printer.println('Impresora configurada OK!')
  printer.println(new Date().toLocaleString('es-DO'))
  printer.println('================================')
  printer.cut()
  await printer.execute()
}

// ─── Fiscal Receipt ──────────────────────────────────────────────────────────

async function printFiscalReceipt(data, printerName) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateFiscalReceiptHTML(data, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const LINE = '================================'
  const DASH = '--------------------------------'
  const W = 32

  const bizName = data.business_name || 'MI NEGOCIO'
  const legalName = data.legal_name || ''
  const rnc = data.rnc || ''
  const address = data.address || ''
  const ncf = data.ncf || ''
  const ncfType = data.ncf_type || 'B02'
  const ncfLabel = ncfType === 'B01' ? 'Crédito Fiscal' : 'Consumidor Final'
  const items = data.items || []
  const subtotal = parseFloat(data.subtotal || 0)
  const itbis = parseFloat(data.itbis || 0)
  const total = parseFloat(data.total || 0)
  const tip = parseFloat(data.tip_amount || 0)
  const hasTip = tip > 0
  const dateStr = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const lines = [
    LINE,
    center(bizName, W),
    ...(legalName ? [center(legalName, W)] : []),
    center(`RNC: ${rnc}`, W),
    ...(address ? [center(address, W)] : []),
    LINE,
    center('COMPROBANTE FISCAL', W),
    center(ncf, W),
    center(ncfLabel, W),
    `Fecha: ${dateStr}`,
    LINE,
    ...items.map(item => {
      const left = `${item.qty || 1}x ${item.name || ''}`
      const right = `RD$${formatMoney(item.subtotal || (item.price * (item.qty || 1)) || 0)}`
      const spaces = W - left.length - right.length
      return left + ' '.repeat(Math.max(1, spaces)) + right
    }),
    DASH,
    pad('Base imponible:', 16) + pad(`RD$${formatMoney(subtotal)}`, 16, true),
    pad('ITBIS (18%):', 16) + pad(`+RD$${formatMoney(itbis)}`, 16, true),
    ...(hasTip ? [pad('Propina:', 16) + pad(`+RD$${formatMoney(tip)}`, 16, true)] : []),
    LINE,
    pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true),
    LINE,
    ...(ncfType === 'B02' && data.client_name ? [
      `Cliente: ${data.client_name}`,
      ...(data.client_rnc ? [`RNC: ${data.client_rnc}`] : []),
      LINE
    ] : []),
    center('¡Gracias por su visita!', W),
    LINE,
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  if (!await printer.isPrinterConnected()) throw new Error('Impresora no disponible')

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(bizName, W))
  if (legalName) printer.println(center(legalName, W))
  printer.println(center(`RNC: ${rnc}`, W))
  if (address) printer.println(center(address, W))
  printer.println(LINE)
  printer.bold(true)
  printer.println(center('COMPROBANTE FISCAL', W))
  printer.bold(false)
  printer.println(center(ncf, W))
  printer.println(center(ncfLabel, W))
  printer.alignLeft()
  printer.println(`Fecha: ${dateStr}`)
  printer.println(LINE)
  items.forEach(item => {
    const left = `${item.qty || 1}x ${item.name || ''}`
    const right = `RD$${formatMoney(item.subtotal || (item.price * (item.qty || 1)) || 0)}`
    const spaces = W - left.length - right.length
    printer.println(left + ' '.repeat(Math.max(1, spaces)) + right)
  })
  printer.println(DASH)
  printer.println(pad('Base imponible:', 16) + pad(`RD$${formatMoney(subtotal)}`, 16, true))
  printer.println(pad('ITBIS (18%):', 16) + pad(`+RD$${formatMoney(itbis)}`, 16, true))
  if (hasTip) printer.println(pad('Propina:', 16) + pad(`+RD$${formatMoney(tip)}`, 16, true))
  printer.println(LINE)
  printer.println(pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true))
  printer.println(LINE)
  if (ncfType === 'B02' && data.client_name) {
    printer.println(`Cliente: ${data.client_name}`)
    if (data.client_rnc) printer.println(`RNC: ${data.client_rnc}`)
    printer.println(LINE)
  }
  printer.alignCenter()
  printer.println('¡Gracias por su visita!')
  printer.println(LINE)
  printer.cut()
  await printer.execute()
}

async function printStationComanda(stationTitle, items, printerName, orderInfo) {
  if (!printerName || printerName === '— No usar —') return

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')
  
  const tableLabel = orderInfo.table_label || orderInfo.table_number || orderInfo.table_id || '?'
  const shortId = (orderInfo.id || orderInfo.order_number || '000000').slice(-6).toUpperCase()

  if (printMode === 'system') {
    const html = generateStationComandaHTML(stationTitle, items, orderInfo, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const LINE = '================================'
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(`** ${stationTitle} - MESA ${tableLabel} **`),
      center(dateStr),
      LINE,
      ...items.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}` + (i.notes ? `\n   * ${i.notes}` : '')),
      LINE,
      center(`Orden #${shortId}`),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const printer = await createPrinter(printerName)
  if (!await printer.isPrinterConnected()) throw new Error('Impresora no disponible')

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(center(`** ${stationTitle} - MESA ${tableLabel} **`))
  printer.bold(false)
  printer.println(center(dateStr))
  printer.println(LINE)
  printer.alignLeft()

  items.forEach(item => {
    printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
    if (item.notes || item.special_instructions) printer.println(`   * ${item.notes || item.special_instructions}`)
  })

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(`Orden #${shortId}`))
  printer.println(LINE)
  printer.cut()
  await printer.execute()
}

function generateStationComandaHTML(stationTitle, items, orderInfo, paperWidth) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = orderInfo.table_label || orderInfo.table_number || orderInfo.table_id || '?'
  const shortId = (orderInfo.id || orderInfo.order_number || '000000').slice(-6).toUpperCase()

  const itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const notes = item.notes || item.special_instructions || ''
    return `
      <div style="padding: 3px 0; font-size: 1.1em;">
        <span class="bold">${qty}x</span> ${name}
        ${notes ? `<div class="notes">* ${notes}</div>` : ''}
      </div>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="text-large">** ${stationTitle} **</div>
      <div class="tag" style="font-size: 1.15em;">MESA ${tableLabel}</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <div>
      ${itemsHtml}
    </div>
    
    <div class="divider-double"></div>
    
    <div class="footer center bold">
      Orden #${shortId}
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

async function printKitchenComanda(items, printerName, orderInfo) {
  return await printStationComanda('COMANDA COCINA', items, printerName, orderInfo)
}

async function printBarComanda(items, printerName, orderInfo) {
  return await printStationComanda('COMANDA BAR', items, printerName, orderInfo)
}

module.exports = {
  getUSBPrinters,
  printPOSReceipt,
  printFiscalReceipt,
  printTableComanda,
  printDeliveryTicket,
  printTestPage,
  printKitchenComanda,
  printBarComanda,
  TEST_PRINTER_NAME
}
