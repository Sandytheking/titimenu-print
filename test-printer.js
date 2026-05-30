const { printer: ThermalPrinter, types: PrinterTypes, CharacterSet } = require('node-thermal-printer')
const { exec } = require('child_process')

// Listar impresoras disponibles
const cmd = process.platform === 'win32'
  ? 'wmic printer get name,portname'
  : 'lpstat -p'

exec(cmd, (err, stdout) => {
  console.log('=== IMPRESORAS DISPONIBLES ===')
  console.log(stdout || 'Ninguna encontrada')
})

// Intentar conectar con la interfaz exacta del usuario
async function testPrinter() {
  const name = '_2connet_2C_POS80_01_V10'
  const interfaces = [
    name,
    `printer:${name}`,
    `\\\\.\\${name}`,
  ]
  
  for (const iface of interfaces) {
    try {
      const printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: iface,
        characterSet: CharacterSet.PC858_EURO,
      })
      const connected = await printer.isPrinterConnected()
      console.log(`[${iface}] connected: ${connected}`)
      
      if (connected || iface.startsWith('printer:') || iface === name) {
        printer.alignCenter()
        printer.println(`TEST TITIMENU (${iface})`)
        printer.cut()
        await printer.execute()
        console.log(`✅ IMPRIMIO con: ${iface}`)
      }
    } catch(e) {
      console.log(`[${iface}] ERROR: ${e.message}`)
    }
  }
}

testPrinter()
