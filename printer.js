const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer')
const { exec } = require('child_process')
const { promisify } = require('util')
const execAsync = promisify(exec)

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
      // Also try system_profiler for USB printers
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

  if (printers.length === 0) {
    printers.push({ name: 'DUMMY', displayName: 'Sin impresora detectada' })
  }

  return printers
}

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

async function createPrinter(printerName) {
  const platform = process.platform
  let interfaceStr

  if (printerName === 'DUMMY') {
    interfaceStr = 'tcp://127.0.0.1:9100'
  } else if (platform === 'win32') {
    interfaceStr = `\\\\localhost\\${printerName}`
  } else {
    interfaceStr = `printer:${printerName}`
  }

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceStr,
    characterSet: CharacterSet.PC858_EURO,
    breakLine: BreakLine.WORD,
    options: { timeout: 5000 }
  })

  return printer
}

async function printPOSReceipt(order, printerName, businessName) {
  const printer = await createPrinter(printerName)

  const isConnected = await printer.isPrinterConnected()
  if (!isConnected) throw new Error('Impresora no disponible')

  const LINE = '================================'
  const DASH = '--------------------------------'
  const W = 32

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(businessName || 'MI NEGOCIO', W))
  printer.println(center(`POS #${order.order_number || order.id?.slice(-6) || '000'}`, W))
  const dt = order.created_at || new Date().toISOString()
  printer.println(center(`${formatDate(dt)}  ${formatTime(dt)}`, W))
  printer.println(LINE)

  printer.alignLeft()
  const items = order.items || order.order_items || []
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    const spaces = W - left.length - right.length
    printer.println(left + ' '.repeat(Math.max(1, spaces)) + right)
  })

  printer.println(DASH)

  const subtotal = order.subtotal || order.total || 0
  const total = order.total || order.total_amount || 0
  printer.println(pad('SUBTOTAL:', 16) + pad(`RD$${formatMoney(subtotal)}`, 16, true))
  printer.println(pad('TOTAL:', 16) + pad(`RD$${formatMoney(total)}`, 16, true))

  const payMethod = order.payment_method || 'Efectivo'
  printer.println(`Pago: ${payMethod}`)

  printer.println(LINE)
  printer.alignCenter()
  printer.println('¡Gracias por su visita!')
  printer.println(LINE)
  printer.cut()

  await printer.execute()
}

async function printTableComanda(order, printerName, businessName) {
  const printer = await createPrinter(printerName)

  const isConnected = await printer.isPrinterConnected()
  if (!isConnected) throw new Error('Impresora no disponible')

  const LINE = '================================'
  const dt = order.created_at || new Date().toISOString()
  const tableLabel = order.table_label || order.table_number || order.table_id || '?'
  const shortId = (order.id || '000000').slice(-6).toUpperCase()

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(center(`** COMANDA - MESA ${tableLabel} **`))
  printer.bold(false)
  printer.println(center(`${formatDate(dt)}  ${formatTime(dt)}`))
  printer.println(LINE)

  printer.alignLeft()

  const items = order.items || order.order_items || []
  const kitchenItems = items.filter(i => !i.bar && i.category !== 'bar' && i.station !== 'bar')
  const barItems = items.filter(i => i.bar || i.category === 'bar' || i.station === 'bar')

  if (kitchenItems.length > 0) {
    printer.alignCenter()
    printer.println('--- COCINA ---')
    printer.alignLeft()
    kitchenItems.forEach(item => {
      printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
      if (item.notes || item.special_instructions) {
        printer.println(`   * ${item.notes || item.special_instructions}`)
      }
    })
  }

  if (barItems.length > 0) {
    printer.alignCenter()
    printer.println('--- BAR ---')
    printer.alignLeft()
    barItems.forEach(item => {
      printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
    })
  }

  if (kitchenItems.length === 0 && barItems.length === 0) {
    printer.alignCenter()
    printer.println('--- ITEMS ---')
    printer.alignLeft()
    items.forEach(item => {
      printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
    })
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.println(center(`Orden #${shortId}`))
  printer.println(LINE)
  printer.cut()

  await printer.execute()
}

async function printDeliveryTicket(order, printerName, businessName) {
  const printer = await createPrinter(printerName)

  const isConnected = await printer.isPrinterConnected()
  if (!isConnected) throw new Error('Impresora no disponible')

  const LINE = '================================'
  const DASH = '--------------------------------'
  const W = 32
  const dt = order.created_at || new Date().toISOString()
  const typeLabel = (order.order_type || 'delivery').toUpperCase()

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(center(`** ${typeLabel} **`))
  printer.bold(false)
  printer.println(center(`${formatDate(dt)}  ${formatTime(dt)}`))
  printer.println(LINE)

  printer.alignLeft()
  const customerName = order.customer_name || order.client_name || 'Cliente'
  const customerPhone = order.customer_phone || order.phone || order.tel || 'N/A'
  printer.println(`Cliente: ${customerName}`)
  printer.println(`Tel: ${customerPhone}`)
  printer.println(DASH)

  const items = order.items || order.order_items || []
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `RD$${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    const spaces = W - left.length - right.length
    printer.println(left + ' '.repeat(Math.max(1, spaces)) + right)
  })

  printer.println(DASH)
  printer.println(pad('TOTAL:', 16) + pad(`RD$${formatMoney(order.total || order.total_amount || 0)}`, 16, true))

  if (order.delivery_address || order.address) {
    printer.println(DASH)
    printer.println(`Dir: ${order.delivery_address || order.address}`)
  }

  printer.println(LINE)
  printer.cut()

  await printer.execute()
}

async function printTestPage(printerName, businessName) {
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

module.exports = { getUSBPrinters, printPOSReceipt, printTableComanda, printDeliveryTicket, printTestPage }
