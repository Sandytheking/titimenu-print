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
const srcMain = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
function extraer(nombre, de = src) {
  const src = de
  const i = src.search(new RegExp(`(async )?function ${nombre}\\(`))
  assert.ok(i >= 0, `no encontré ${nombre}`)
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
eval(extraer('anchoTermicoDeLaConfig'))
eval(extraer('pad'))
eval(extraer('renglonImporte'))
eval(extraer('center'))
eval(extraer('imprimirQrTermico'))
eval(extraer('decidirAncho', srcMain))
// Ojo: un `const` dentro de eval() NO sale al ámbito de fuera (las declaraciones de
// función sí). Se convierte a `var` para poder usarlo aquí.
eval(src.slice(src.indexOf('const PLEGADOS ='), src.indexOf('\n\nfunction plegarAAscii'))
       .replace('const PLEGADOS', 'var PLEGADOS'))
eval(extraer('plegarAAscii'))
eval(extraer('formatTableLabel'))
eval(extraer('etiquetaDestino'))
eval(extraer('rncQueEmite'))

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

  console.log('\nUN SOLO CENTRADO, Y NINGÚN COMANDO DE VELOCIDAD')

  // Lo que se comprueba aquí son BYTES de verdad: se arma el encabezado como lo arman
  // ahora las plantillas (alineación de la impresora, texto sin rellenar) y se mira el
  // buffer que saldría por el cable.
  const bufferDeEncabezado = (textos) => {
    const p = nuevaImpresora()
    p.alignCenter()
    textos.forEach(t => p.println(t))
    p.alignLeft()
    return p.getBuffer()
  }
  const ESC_a_1 = [0x1B, 0x61, 0x01]   // centrar
  const ESC_a_0 = [0x1B, 0x61, 0x00]   // izquierda
  const GS_s    = [0x1D, 0x73]         // la velocidad: lo que imprimía la "S" suelta

  // Los renglones reales del encabezado fiscal de E320000015515.
  const ENCABEZADO = ['Sandy Burger SRL', 'RNC: 132752155', 'Factura de Consumo Electrónica', 'E320000015515']

  await prueba('con el centrado de la impresora, ningún renglón lleva relleno izquierdo', () => {
    const buf = bufferDeEncabezado(ENCABEZADO)
    assert.ok(contiene(buf, ESC_a_1), 'falta la orden de centrar')
    // Se parte el buffer por saltos de línea y se mira cada trozo de TEXTO imprimible.
    const renglones = buf.toString('latin1')
      .split('\n')
      .map(r => r.replace(/[\x00-\x1F]/g, ''))     // fuera las órdenes ESC/GS
      .filter(r => r.trim().length > 0)
    assert.ok(renglones.length >= ENCABEZADO.length, `esperaba ${ENCABEZADO.length} renglones, hay ${renglones.length}`)
    const conRelleno = renglones.filter(r => r.startsWith(' '))
    assert.deepEqual(conRelleno, [],
      'estos renglones llevan relleno a la izquierda Y centrado de impresora — es el\n' +
      '      centrado doble que corría el texto a la derecha:\n' +
      conRelleno.map(r => `        «${r}»`).join('\n'))
  })

  await prueba('el texto va literal al buffer, sin espacios añadidos', () => {
    const buf = bufferDeEncabezado(ENCABEZADO)
    for (const t of ENCABEZADO) {
      // `sanitizeForThermal` quita las tildes, así que se compara sin ellas.
      const plano = t.normalize('NFD').replace(/[̀-ͯ]/g, '')
      assert.ok(buf.includes(plano), `no encontré «${plano}» literal en el buffer`)
      assert.ok(!buf.includes(' ' + plano), `«${plano}» aparece con un espacio delante`)
    }
  })

  await prueba('el buffer no lleva el comando de velocidad GS s', () => {
    const buf = bufferDeEncabezado(ENCABEZADO)
    assert.ok(!contiene(buf, GS_s),
      'apareció GS s (0x1D 0x73) en el buffer: esta impresora lo imprime como una «S» ' +
      'suelta y descuadra la primera regla')
  })

  await prueba('printer.js ya no manda el comando de velocidad en ninguna parte', () => {
    const sospechas = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /0x1D,\s*0x73|printSpeed/.test(l))
      .filter(([, l]) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    assert.deepEqual(sospechas, [],
      'volvió el comando de velocidad:\n' + sospechas.map(([n, l]) => `      ${n}: ${l.trim()}`).join('\n'))
  })

  await prueba('ninguna plantilla vuelve a centrar dos veces', () => {
    // El guardia estático que ata las 8 plantillas al contrato de arriba: bajo
    // `alignCenter` se imprime el texto pelado, nunca `center()`.
    const dobles = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /printer\.println\(center\(|printer\.print\(center\(/.test(l))
    assert.deepEqual(dobles, [],
      'hay centrado doble otra vez:\n' + dobles.map(([n, l]) => `      ${n}: ${l.trim()}`).join('\n'))
  })

  console.log('\nEL ANCHO SIGUE AL PAPEL CONFIGURADO')

  await prueba('80 mm son 48 columnas y 58 mm son 32, UNA VEZ configurado', () => {
    assert.equal(anchoTermico('80mm', true).W, 48)
    assert.equal(anchoTermico('58mm', true).W, 32)
    assert.equal(anchoTermico('80mm', true).LINE.length, 48)
    assert.equal(anchoTermico('58mm', true).DASH.length, 32)
  })

  await prueba('SIN configurar se queda en 32 columnas — el papel de siempre', () => {
    // El bridge se autoactualiza solo en Windows. Un negocio que nunca pasó por la
    // configuración no puede amanecer con los tickets a otro ancho, así que mientras no
    // haya marca explícita manda el comportamiento histórico: 32 columnas.
    assert.equal(anchoTermico('80mm', false).W, 32, 'un 80mm no explícito debe seguir en 32')
    assert.equal(anchoTermico('80mm', undefined).W, 32)
    assert.equal(anchoTermico(undefined, false).W, 32)
    assert.equal(anchoTermico('58mm', false).W, 32, 'en 58 mm da 32 por los dos caminos')
    assert.equal(anchoTermico('80mm', false).LINE.length, 32)
  })

  await prueba('la config decide: la marca explícita es la que abre el paso a 48', () => {
    config = { paperWidth: '80mm' }                            // nunca guardada
    assert.equal(anchoTermicoDeLaConfig().W, 32)
    config = { paperWidth: '80mm', paperWidthExplicit: true }   // guardada
    assert.equal(anchoTermicoDeLaConfig().W, 48)
    config = { paperWidth: '58mm', paperWidthExplicit: true }
    assert.equal(anchoTermicoDeLaConfig().W, 32)
    config = {}                                                // equipo recién instalado
    assert.equal(anchoTermicoDeLaConfig().W, 32)
  })

  console.log('\nEL ANCHO LO ELIGE UNA PERSONA (main.js)')

  await prueba('sin elegir el ancho, el guardado se RECHAZA entero', () => {
    // Y se rechaza antes de escribir una sola clave: un guardado a medias dejaría
    // impresoras nuevas con el ancho sin resolver.
    for (const sinElegir of ['', null, undefined, '72mm', 'ancho']) {
      const r = decidirAncho(sinElegir, false, '80mm')
      assert.equal(r.ok, false, `«${sinElegir}» debería rechazarse`)
      assert.ok(r.error && /ancho del papel/i.test(r.error), 'el error debe decir qué falta')
      assert.equal(r.explicito, undefined, 'un rechazo no puede marcar nada como explícito')
    }
  })

  await prueba('elegirlo es lo ÚNICO que escribe la marca', () => {
    for (const w of ['58mm', '80mm']) {
      const r = decidirAncho(w, false, '80mm')
      assert.deepEqual(r, { ok: true, paperWidth: w, explicito: true })
    }
  })

  await prueba('un 58 mm no se convierte en 80 mm por guardar la impresora', () => {
    // El riesgo que hizo estricta esta regla: con el desplegable preseleccionado en
    // 80 mm, un negocio de 58 mm que entra a cambiar de impresora guardaría 80 mm sin
    // verlo y sus tickets saldrían CORTADOS (48 columnas no caben en 384 puntos).
    // Ahora, si no eligió, no se guarda; y si ya había elegido 58, se conserva.
    assert.equal(decidirAncho('', false, '80mm').ok, false)
    const r = decidirAncho(undefined, true, '58mm')
    assert.deepEqual(r, { ok: true, paperWidth: '58mm', explicito: true })
    assert.equal(anchoTermico(r.paperWidth, r.explicito).W, 32, 'un 58 mm debe seguir en 32')
  })

  await prueba('quien ya eligió no vuelve a elegir en cada guardado', () => {
    const r = decidirAncho(undefined, true, '80mm')
    assert.deepEqual(r, { ok: true, paperWidth: '80mm', explicito: true })
    // Y si cambia de opinión, el valor nuevo manda.
    assert.equal(decidirAncho('58mm', true, '80mm').paperWidth, '58mm')
  })

  await prueba('la UI no preselecciona el ancho ni lo deja guardar vacío', () => {
    // El default del formulario era el agujero: `80mm` preseleccionado se guardaba como
    // si alguien lo hubiera elegido. El selector tiene que nacer vacío y ser obligatorio.
    const ui = fs.readFileSync(path.join(__dirname, 'renderer', 'config.html'), 'utf8')
    const sel = ui.slice(ui.indexOf('<select id="paperWidthSelect">'))
    const opciones = sel.slice(0, sel.indexOf('</select>'))
    assert.ok(/<option value="">/.test(opciones), 'falta la opción vacía de "Selecciona…"')
    assert.ok(!/selected/.test(opciones), 'ninguna opción de ancho puede venir preseleccionada')
    assert.ok(/value="58mm"/.test(opciones) && /value="80mm"/.test(opciones), 'faltan los dos anchos')
    assert.ok(ui.includes("if (!paperWidth) {"), 'el ancho no es obligatorio para guardar')
    assert.ok(/config\.paperWidthExplicit && config\.paperWidth/.test(ui),
      'la UI preselecciona el ancho sin comprobar la marca explícita')
    assert.ok(/Mide el rollo/.test(ui), 'falta la ayuda para medir el rollo')
  })

  await prueba('un renglón de importe ocupa el ancho entero, a 48 y a 32', () => {
    for (const W of [48, 32]) {
      const [r] = renglonImporte('TOTAL:', 'RD$810.00', W)
      assert.equal(r.length, W, `«${r}» mide ${r.length} y el papel es de ${W}`)
      assert.ok(r.startsWith('TOTAL:'), 'la etiqueta va a la izquierda')
      assert.ok(r.endsWith('RD$810.00'), 'el importe va pegado al borde derecho')
    }
  })

  await prueba('a DOBLE ANCHO el renglón usa la mitad de columnas', () => {
    // Con `setTextSize(_, 1)` cada carácter ocupa dos columnas, así que el ancho efectivo
    // es la mitad: 24 en 80 mm y 16 en 58 mm. Si el llamador pasa el ancho entero, el
    // renglón se parte en el papel y el importe aparece suelto en otra línea.
    for (const [W, mitad] of [[48, 24], [32, 16]]) {
      const [r] = renglonImporte('TOTAL:', 'RD$810.00', W / 2)
      assert.equal(r.length, mitad, `a doble ancho el renglón debe medir ${mitad}`)
      assert.ok(r.endsWith('RD$810.00'))
    }
  })

  await prueba('un nombre largo con modificadores NO pierde ni un carácter', () => {
    // El papel real: «1x Hamburguesas (Belcon, Papas Frita,» y se perdió «Doble Carne,
    // Refresco, Jugo de naranja». Lo que se imprime no puede perder texto nunca.
    const nombre = '1x Hamburguesas (Belcon, Papas Frita, Doble Carne, Refresco, Jugo de naranja)'
    for (const W of [48, 32, 24]) {
      const lineas = renglonImporte(nombre, 'RD$390.00', W)
      const recuperado = lineas.join(' ').replace('RD$390.00', '').replace(/\s+/g, ' ').trim()
      assert.equal(recuperado, nombre.replace(/\s+/g, ' ').trim(),
        `a ${W} columnas se perdió texto:\n        ${lineas.join('\n        ')}`)
    }
  })

  await prueba('ningún renglón supera NUNCA el ancho efectivo', () => {
    const casos = [
      '1x Hamburguesas (Belcon, Papas Frita, Doble Carne, Refresco, Jugo de naranja)',
      '1x Papitas y Platanitos Chips', '2x Refresco', 'TOTAL:', 'Base imponible:',
      '10x ' + 'Supercalifragilisticoespialidoso'.repeat(3),   // una palabra sin espacios
    ]
    for (const W of [48, 32, 24, 16]) {
      for (const c of casos) {
        for (const imp of ['RD$1.00', 'RD$390.00', 'RD$12,345.67']) {
          renglonImporte(c, imp, W).forEach(l => {
            assert.ok(l.length <= W, `«${l}» mide ${l.length} con W=${W}`)
          })
        }
      }
    }
  })

  await prueba('el importe se queda en la PRIMERA línea y lo demás va con sangría', () => {
    const lineas = renglonImporte('1x Un nombre largo de producto con muchos extras', 'RD$99.00', 32)
    assert.ok(lineas.length > 1, 'este caso tiene que envolver')
    assert.ok(lineas[0].endsWith('RD$99.00'), 'el importe va en la primera línea')
    lineas.slice(1).forEach(l => {
      assert.ok(l.startsWith('   '), `la continuación debe ir con sangría: «${l}»`)
      assert.ok(!/RD\$/.test(l), 'no puede haber importes en las continuaciones')
    })
  })

  await prueba('el plegado a ASCII no mueve la alineación', () => {
    // El saneo corre DESPUÉS de calcular el ancho, así que si cambiara la longitud, el
    // renglón ya alineado se descuadraría.
    for (const t of ['Piñacola sin Alcohol', 'Jamón', '¡Gracias!', 'Café con leche']) {
      assert.equal(plegarAAscii(t).length, t.length, `«${t}» cambió de longitud al plegarse`)
      assert.ok(!/[^\x00-\x7F]/.test(plegarAAscii(t)), `«${t}» no quedó en ASCII`)
    }
    assert.equal(plegarAAscii('Piñacola'), 'Pinacola')
    assert.equal(plegarAAscii('Jamón'), 'Jamon')
  })

  await prueba('la comanda siempre dice a dónde va — nunca «?»', () => {
    assert.equal(etiquetaDestino({}, { table_number: 4 }), 'MESA 4')
    assert.equal(etiquetaDestino({ table_label: 'Mesa 7' }, {}), 'MESA 7')
    assert.equal(etiquetaDestino({}, { order_type: 'delivery', order_number: 9 }), 'DELIVERY')
    assert.equal(etiquetaDestino({}, { order_type: 'takeout', order_number: 9 }), 'PARA LLEVAR')
    // El caso del papel: venta de mostrador, sin mesa. Antes imprimía «?».
    assert.equal(etiquetaDestino({}, { order_type: 'pos', order_number: 1078 }), 'POS #1078')
    assert.equal(etiquetaDestino({}, { id: 'aa3fdbd8' }), 'ORDEN #3FDBD8')
    assert.equal(etiquetaDestino({}, {}), 'MOSTRADOR')
    for (const caso of [[{}, {}], [{}, { order_number: 1 }], [null, null]]) {
      assert.ok(!etiquetaDestino(caso[0], caso[1]).includes('?'), 'volvió el interrogante')
    }
  })

  await prueba('el RNC del recibo es el mismo que el de la factura', () => {
    // En el papel salieron distintos: la factura con `ecf_rnc` (132752155) y el recibo
    // con `rnc` (656473623). Es el mismo negocio y la misma venta.
    assert.equal(rncQueEmite({ rnc: '656473623', ecfRnc: '132752155' }), '132752155')
    assert.equal(rncQueEmite({ rnc: '656473623', ecfRnc: '' }), '656473623')
    assert.equal(rncQueEmite({ rnc: '656473623' }), '656473623')
    assert.equal(rncQueEmite({ rnc: '656473623', ecf_rnc: '132752155' }), '132752155')
    assert.equal(rncQueEmite({}), '')
    assert.equal(rncQueEmite(null), '')
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
