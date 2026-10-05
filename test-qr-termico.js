/**
 * Verifica que el QR del papel fiscal TÉRMICO llegue de verdad al buffer, y que el ancho
 * de línea siga al papel configurado.
 *
 *     node test-qr-termico.js
 *
 * ## El bug que vigila (2.1.0, E320000015515 en una 2Connect POS80 por USB)
 * El papel salió con todos los datos correctos —importes, código de seguridad, fecha de
 * firma— y la leyenda «escaneando el QR»… pero sin QR. La causa no era la impresora ni
 * el `GS ( k`: era que `printer.raw()` de node-thermal-printer **no escribe en el
 * buffer** (`core.js:470` hace `Interface.execute`), y la ruta USB de este bridge
 * imprime con `getBuffer()` + `sendRawToPrinter()`. Los bytes del QR se iban por la
 * interfaz, que en esa ruta es **un fichero temporal dummy**, y nunca se imprimían.
 *
 * Es el modo de fallo que este repositorio ya tiene escrito en tres sitios: no hay
 * error, no hay log, el papel sale «bien» con menos cosas. Sólo se vio careando papeles.
 *
 * Por eso el test de abajo no comprueba «¿se llamó al QR?» sino **«¿están los bytes en
 * el buffer que se manda a la impresora?»**, que es la única pregunta que importa.
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { printer: ThermalPrinter, types: PrinterTypes, BreakLine } = require('node-thermal-printer')

const src = fs.readFileSync(path.join(__dirname, 'printer.js'), 'utf8')
function extraer(nombre) {
  const i = src.search(new RegExp(`(async )?function ${nombre}\\(`))
  assert.ok(i >= 0, `no encontré ${nombre} en printer.js`)
  let k = src.indexOf('{', i), prof = 0
  for (; k < src.length; k++) {
    if (src[k] === '{') prof++
    else if (src[k] === '}' && --prof === 0) { k++; break }
  }
  return src.slice(i, k)
}

// `imprimirQrTermico` consulta la configuración; aquí se le pone una de mentira.
let config = {}
const store = { get: (k, d) => (k in config ? config[k] : d) }

eval(extraer('qrGsK'))
eval(extraer('anchoTermico'))
eval(extraer('pad'))
eval(extraer('center'))
eval(extraer('imprimirQrTermico'))

const URL_QR = 'https://fc.dgii.gov.do/TesteCF/ConsultaTimbreFC?RncEmisor=132752155&ENCF=E320000015515&MontoTotal=810.00&CodigoSeguridad=aZECOS'

const DUMMY = path.join(require('os').tmpdir(), 'titimenu-test-qr.bin')
const nuevaImpresora = () => new ThermalPrinter({
  type: PrinterTypes.EPSON, interface: DUMMY, characterSet: 'PC858_EURO',
  removeSpecialCharacters: true, lineCharacter: '-', breakLine: BreakLine.WORD,
})

const contiene = (buf, bytes) => buf.indexOf(Buffer.from(bytes)) >= 0
const GS_V_0  = [0x1D, 0x76, 0x30]              // raster bit image
const GS_PAR_K = [0x1D, 0x28, 0x6B]             // QR nativo

let ok = 0, fallos = []
async function prueba(nombre, fn) {
  try { await fn(); ok++; console.log(`  ✓ ${nombre}`) }
  catch (e) { fallos.push(nombre); console.log(`  ✗ ${nombre}\n      ${e.message}`) }
}

;(async () => {
  console.log('\nEL QR LLEGA AL BUFFER')

  await prueba('el raster entra en el buffer que se manda a la impresora', async () => {
    config = {}
    const p = nuevaImpresora()
    const antes = p.getBuffer().length
    const como = await imprimirQrTermico(p, URL_QR, '80mm')
    const buf = p.getBuffer()
    assert.equal(como, 'raster')
    assert.ok(buf.length > antes + 500,
      `el buffer no creció lo suficiente: ${antes} → ${buf.length} bytes. ` +
      'Si está en ~0, el QR se fue por la interfaz en vez del buffer (el bug de la 2.1.0).')
    assert.ok(contiene(buf, GS_V_0), 'faltan los bytes de imagen raster GS v 0')
  })

  await prueba('el QR nativo también entra en el buffer, no por la interfaz', async () => {
    config = { qrNativo: true }
    const p = nuevaImpresora()
    const como = await imprimirQrTermico(p, URL_QR, '80mm')
    const buf = p.getBuffer()
    assert.equal(como, 'nativo')
    assert.ok(contiene(buf, GS_PAR_K), 'faltan los bytes del QR nativo GS ( k')
    // Y la URL va literal: si se saneara, el QR apuntaría a otro sitio.
    assert.ok(buf.includes(URL_QR), 'la URL no está intacta en el buffer')
  })

  await prueba('el raster codifica el contenido que se le pasa', async () => {
    config = {}
    const p = nuevaImpresora()
    await imprimirQrTermico(p, URL_QR, '80mm')
    const otro = nuevaImpresora()
    await imprimirQrTermico(otro, 'https://fc.dgii.gov.do/x', '80mm')
    // El PNG va a 220 px SIEMPRE (más datos = módulos más finos, no imagen más grande),
    // así que no se comparan tamaños: se comprueba que el contenido del raster CAMBIA
    // con la URL. Si no cambiara, se estaría pintando algo que no son estos datos.
    assert.ok(!p.getBuffer().equals(otro.getBuffer()),
      'dos URLs distintas dieron el mismo raster: no se está codificando la URL')
  })

  await prueba('el raster cabe en el ancho de cabeza de cada papel', async () => {
    // 80 mm son 576 puntos y 58 mm son 384. Un QR más ancho que la cabeza se corta, y
    // un QR cortado no se escanea: deja de ser verificable, que es su único propósito.
    for (const [papel, puntos] of [['80mm', 576], ['58mm', 384]]) {
      config = {}
      const p = nuevaImpresora()
      await imprimirQrTermico(p, URL_QR, papel)
      const buf = p.getBuffer()
      const i = buf.indexOf(Buffer.from(GS_V_0))
      // GS v 0 m xL xH yL yH: el ancho va en BYTES (8 columnas de puntos por byte).
      const anchoPuntos = (buf[i + 4] + buf[i + 5] * 256) * 8
      assert.ok(anchoPuntos > 0 && anchoPuntos <= puntos,
        `en ${papel} el QR mide ${anchoPuntos} puntos y la cabeza tiene ${puntos}`)
    }
  })

  await prueba('sin QR nunca se queda sin papel', async () => {
    config = {}
    const p = nuevaImpresora()
    // Una impresora que revienta al pintar imágenes: debe caer al nativo, no tirar.
    p.printImageBuffer = async () => { throw new Error('firmware sin raster') }
    const como = await imprimirQrTermico(p, URL_QR, '80mm')
    assert.equal(como, 'nativo-fallback')
    assert.ok(contiene(p.getBuffer(), GS_PAR_K))
  })

  console.log('\nLA REGLA: NADIE VUELVE A USAR raw()')

  await prueba('printer.js no llama a .raw() en ninguna parte', () => {
    // `raw()` no bufferiza. Cualquier uso nuevo reintroduce exactamente este bug, y en
    // silencio. Si algún día hace falta mandar bytes crudos, es `append()`.
    const usos = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /\.raw\(/.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    assert.deepEqual(usos, [],
      'vuelve a haber llamadas a .raw():\n' + usos.map(([n, l]) => `      ${n}: ${l.trim()}`).join('\n'))
  })

  console.log('\nEL ANCHO SIGUE AL PAPEL CONFIGURADO')

  await prueba('80 mm son 48 columnas y 58 mm son 32', () => {
    assert.equal(anchoTermico('80mm').W, 48)
    assert.equal(anchoTermico('58mm').W, 32)
    assert.equal(anchoTermico(undefined).W, 48, 'sin configurar debe asumir 80 mm')
    assert.equal(anchoTermico('80mm').HALF, 24)
    assert.equal(anchoTermico('80mm').LINE.length, 48)
    assert.equal(anchoTermico('58mm').DASH.length, 32)
  })

  await prueba('un renglón de importe ocupa el ancho entero', () => {
    const { W, HALF } = anchoTermico('80mm')
    const renglon = pad('TOTAL:', HALF) + pad('RD$810.00', HALF, true)
    assert.equal(renglon.length, W, `el renglón mide ${renglon.length}, no ${W}`)
    assert.ok(renglon.endsWith('RD$810.00'), 'el importe debe quedar pegado al borde derecho')
  })

  await prueba('ninguna plantilla térmica fija el ancho a mano', () => {
    const malos = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /const W = 32|'={20,}'|, 16\)|, 16, true\)/.test(l))
      .filter(([, l]) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    assert.deepEqual(malos, [],
      'hay anchos fijos otra vez:\n' + malos.map(([n, l]) => `      ${n}: ${l.trim()}`).join('\n'))
  })

  try { fs.unlinkSync(DUMMY) } catch {}
  console.log(`\n${fallos.length ? '✗' : '✓'} ${ok} comprobaciones pasaron` +
              (fallos.length ? `, ${fallos.length} fallaron: ${fallos.join(', ')}` : ''))
  process.exit(fallos.length ? 1 : 0)
})()
