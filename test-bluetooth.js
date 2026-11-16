/**
 * Impresora Bluetooth: el listado de las dos plataformas y el envío crudo.
 *
 *     node test-bluetooth.js
 *
 * ## Lo que vigila
 *  1. Windows: solo el puerto SALIENTE de cada impresora (el entrante, con MAC en ceros, no
 *     imprime), con el nombre del aparato.
 *  2. Mac: los puertos del sistema y los adaptadores USB-serie no salen como impresoras.
 *  3. (Solo en Mac) los bytes llegan a un puerto serie REAL —un pseudoterminal— idénticos,
 *     sin que la terminal convierta \n en \r\n. Esa conversión corrompería el QR fiscal sin
 *     ningún error: el papel saldría con basura en vez de código.
 */
const assert = require('assert')
const { parsearWindows, parsearMac, mensajeDe, esBluetooth } = require('./bluetooth')

;(async () => {
  // 1. Windows
  const salida = [
    'Vínculo serie estándar sobre Bluetooth (COM5)|BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0002\\7&2A1B&0&DC0D30A1B2C3_C00000000',
    'Vínculo serie estándar sobre Bluetooth (COM6)|BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}_LOCALMFG&0000\\7&2A1B&0&000000000000_00000000',
    'MTP-II|BTHENUM\\DEV_DC0D30A1B2C3\\7&1C2D&0&BLUETOOTHDEVICE_DC0D30A1B2C3',
    'Auriculares|BTHENUM\\DEV_AABBCCDDEEFF\\7&1C2D&0&BLUETOOTHDEVICE_AABBCCDDEEFF',
    '',
  ].join('\r\n')
  assert.deepStrictEqual(parsearWindows(salida), [
    { name: 'bt:COM5', displayName: 'Bluetooth · MTP-II (COM5)' },
  ])
  // Sin el nombre del aparato, igual se ofrece.
  assert.deepStrictEqual(parsearWindows(salida.split('\r\n')[0]), [
    { name: 'bt:COM5', displayName: 'Bluetooth · impresora (COM5)' },
  ])

  // 2. Mac
  assert.deepStrictEqual(
    parsearMac(['cu.Bluetooth-Incoming-Port', 'cu.debug-console', 'cu.usbserial-110', 'tty.BLTH', 'cu.BLTH', 'disk0']),
    [{ name: 'bt:/dev/cu.BLTH', displayName: 'Bluetooth · BLTH' }],
  )
  assert.ok(esBluetooth('bt:COM5') && !esBluetooth('192.168.1.50') && !esBluetooth('EPSON_TM') && !esBluetooth(undefined))
  assert.ok(mensajeDe({ code: 'ENOENT', message: 'x' }, 'COM5').includes('No encontramos la impresora emparejada'))
  // Lo que contesta .NET en un Windows en inglés o en español → el mensaje para el cajero.
  const { codigoWindows } = require('./bluetooth')
  assert.strictEqual(codigoWindows('Exception calling "Open": "The semaphore timeout period has expired."'), 'TOPE')
  assert.strictEqual(codigoWindows('Excepción al llamar a "Open": "Se ha excedido el tiempo de espera del semáforo."'), 'TOPE')
  assert.strictEqual(codigoWindows("Access to the port 'COM7' is denied."), 'EBUSY')
  assert.strictEqual(codigoWindows("El acceso al puerto 'COM7' está denegado."), 'EBUSY')
  assert.strictEqual(codigoWindows("The port 'COM9' does not exist."), 'ENOENT')
  assert.strictEqual(codigoWindows('algo raro'), 'WINDOWS')

  // 3. Envío crudo a un pseudoterminal (solo Mac: ahí está la trampa de ONLCR)
  if (process.platform === 'darwin') {
    const { spawn } = require('child_process')
    // Un pty con python: imprime la ruta del esclavo y devuelve en hex lo que llega al maestro.
    const py = spawn('python3', ['-c', `
import os, pty, sys, select, binascii
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
datos = b''
while True:
    r, _, _ = select.select([m], [], [], 3)
    if not r: break
    try: trozo = os.read(m, 65536)
    except OSError: break
    if not trozo: break
    datos += trozo
print(binascii.hexlify(datos).decode(), flush=True)
`])
    let out = ''
    py.stdout.on('data', d => { out += d })
    while (!out.includes('\n')) await new Promise(r => setTimeout(r, 20))
    const ruta = out.split('\n')[0].trim()
    // Un ticket con todo lo que una terminal "cocinaría": \n, \r, ESC, 0x00, 0xFF y bytes de imagen.
    const ticket = Buffer.concat([
      Buffer.from('\x1b@Hola\nMundo\r\n'),
      Buffer.from([0x0a, 0x0d, 0x00, 0xff, 0x1d, 0x76, 0x30, 0x00, 0x0a, 0x0a, 0x7f, 0x03, 0x04, 0x11, 0x13]),
    ])
    const { enviarPorBluetooth } = require('./bluetooth')
    await enviarPorBluetooth(ticket, 'bt:' + ruta)
    await new Promise(r => py.on('close', r))
    const recibido = Buffer.from(out.split('\n')[1].trim(), 'hex')
    assert.strictEqual(recibido.toString('hex'), ticket.toString('hex'), 'los bytes llegaron alterados')
    console.log(`✓ ${ticket.length} bytes llegaron idénticos a ${ruta}`)
  }

  console.log('✓ test-bluetooth: todo bien')
})().catch(e => { console.error('✗', e); process.exit(1) })
