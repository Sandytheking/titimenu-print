const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer')
const { exec } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const execAsync = promisify(exec)

const TEST_MODE = false
const TEST_OUTPUT_FILE = '/tmp/titimenu-print-test.txt'
const TEST_PRINTER_NAME = 'TEST_MODE'

// ─── Test mode: write text to file and show notification ─────────────────────

function writeTestOutput(lines) {
  const separator = '\n' + '='.repeat(40) + '\n'
  const timestamp = `[${new Date().toLocaleString('es-DO')}]`
  const content = timestamp + '\n' + lines.join('\n') + '\n'

  // Append so multiple orders accumulate in the file
  fs.appendFileSync(TEST_OUTPUT_FILE, separator + content)
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
      const { stdout } = await execAsync('lpstat -a 2>/dev/null || echo ""')
      const lines = stdout.split('\n').filter(l => l.trim())
      lines.forEach(line => {
        const name = line.split(' ')[0]
        if (name) printers.push({ name, displayName: name })
      })
      try {
        const { stdout: spOut } = await execAsync(
          "system_profiler SPUSBDataType 2>/dev/null | grep -A5 'Printer' | grep 'Product ID\\|Manufacturer\\|Product' | head -20"
        )
        if (spOut.trim() && printers.length === 0) {
          printers.push({ name: 'USB_PRINTER', displayName: 'USB Thermal Printer (detected)' })
        }
      } catch (_) {}
    } else if (platform === 'win32') {
      const { stdout } = await execAsync(
        'wmic printer get Name,PortName /format:csv 2>nul'
      )
      const lines = stdout.split('\n').filter(l => l.includes(','))
      lines.slice(1).forEach(line => {
        const parts = line.split(',')
        if (parts.length >= 3) {
          const name = parts[2] ? parts[2].trim() : ''
          if (name) printers.push({ name, displayName: name })
        }
      })
    } else {
      const { stdout } = await execAsync('lpstat -a 2>/dev/null || echo ""')
      const lines = stdout.split('\n').filter(l => l.trim())
      lines.forEach(line => {
        const name = line.split(' ')[0]
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

async function createPrinter(printerName) {
  const platform = process.platform
  let interfaceStr

  if (platform === 'win32') {
    interfaceStr = `\\\\localhost\\${printerName}`
  } else {
    interfaceStr = `printer:${printerName}`
  }

  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceStr,
    characterSet: CharacterSet.PC858_EURO,
    breakLine: BreakLine.WORD,
    options: { timeout: 5000 }
  })
}

// ─── POS Receipt ──────────────────────────────────────────────────────────────

async function printPOSReceipt(order, printerName, businessInfo) {
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

module.exports = {
  getUSBPrinters,
  printPOSReceipt,
  printFiscalReceipt,
  printTableComanda,
  printDeliveryTicket,
  printTestPage,
  TEST_PRINTER_NAME
}
