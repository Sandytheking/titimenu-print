/**
 * Verifica el criterio de «¿se imprime esta factura?» del bridge.
 *
 *     node test-ecf-imprimible.js
 *
 * ## Por qué así
 * El bridge no tiene runner de pruebas (`test-printer.js`, el único que había, es un
 * script manual que habla con una impresora real). Esto corre con `node` pelado y sin
 * dependencias, y extrae las funciones de `printer.js` por texto para no tener que
 * arrancar Electron — `printer.js` hace `require('electron')` al cargarse.
 *
 * ## Qué vigila
 * Dos cosas que ya fallaron:
 *
 *   1. `E320000015506` se certificó en 4 segundos y el ticket salió «sin QR». En la
 *      ventana del fallo el estado era `certificado` (no `aceptado`: el salto ocurre
 *      minutos después, cuando el worker consulta a la DGII) y el código venía como
 *      `He%2BUBK`. **El estado que se ve al imprimir es casi siempre `certificado`.**
 *
 *   2. La lista de estados sin valor fiscal de este archivo tenía TRES y le faltaba
 *      `anulado`, mientras el nativo y el web tenían los cuatro. Una factura ANULADA
 *      —que tiene XML firmado perfectamente válido— se habría impreso por este canal
 *      como si valiera.
 */
const fs = require('fs')
const assert = require('assert')

// Extraer las dos funciones de printer.js sin cargar el módulo (lleva Electron dentro).
const src = fs.readFileSync(require('path').join(__dirname, 'printer.js'), 'utf8')
function extraer(nombre) {
  const i = src.indexOf(`function ${nombre}(`)
  assert.ok(i >= 0, `no encontré ${nombre} en printer.js`)
  // Equilibrar llaves desde la firma.
  let k = src.indexOf('{', i), prof = 0
  for (; k < src.length; k++) {
    if (src[k] === '{') prof++
    else if (src[k] === '}' && --prof === 0) { k++; break }
  }
  return src.slice(i, k)
}
// eslint-disable-next-line no-eval
eval(extraer('fiscalDesdeRepresentacion'))

/** Copiado literal de `select ecf_representacion_impresa('E320000015506')`. */
const repReal = {
  encf: 'E320000015506',
  estado: 'aceptado',
  lineas: [{ nombre: 'Chicharrón (1 lb)', cantidad: '1.00', precio: '350.0000', monto: '350.00', servicio: false }],
  qr_url: 'https://fc.dgii.gov.do/TesteCF/ConsultaTimbreFC?RncEmisor=132752155&ENCF=E320000015506&MontoTotal=350.00&CodigoSeguridad=He%2BUBK',
  totales: { itbis: '53.39', total: '350.00', gravado: '296.61' },
  tipo_ecf: '32',
  emisor_rnc: '132752155',
  fecha_firma: '04-10-2026 07:16:13',
  tipo_nombre: 'Factura de Consumo Electrónica',
  emisor_nombre: 'Sandy Burger SRL',
  fecha_emision: '04-10-2026',
  codigo_seguridad: 'He+UBK',
  comprador_nombre: 'Consumidor Final',
  emisor_direccion: 'URB. Los maestros Calle #1',
  nombre_comercial: 'Sandy Burge',
}
const conRep = (rep) => fiscalDesdeRepresentacion({ representacion: rep })

let ok = 0
function check(nombre, fn) {
  try { fn(); ok++; console.log('  OK    ' + nombre) }
  catch (e) { console.error('  FALLA ' + nombre + '\n        ' + e.message); process.exitCode = 1 }
}

console.log('\n═══ bridge: ¿se imprime esta factura? ═══')

check('el JSON real de E320000015506 sale con QR', () => {
  const F = conRep(repReal)
  assert.equal(F.conQr, true)
  assert.equal(F.rechazada, false)
  // Y los importes del XML, tal cual: ni un recálculo.
  assert.equal(F.gravado, '296.61')
  assert.equal(F.itbis, '53.39')
  assert.equal(F.total, '350.00')
})

check('el payload EXACTO de la ventana del fallo sale con QR', () => {
  const F = conRep({ ...repReal, estado: 'certificado', codigo_seguridad: 'He%2BUBK' })
  assert.equal(F.rechazada, false)
  assert.equal(F.conQr, true, 'una certificada y firmada tiene que salir con QR')
})

check('certificado y aceptado: los dos estados con los que se imprime', () => {
  for (const estado of ['certificado', 'aceptado']) {
    const F = conRep({ ...repReal, estado })
    assert.equal(F.rechazada, false, estado)
    assert.equal(F.conQr, true, estado)
  }
})

check('los CUATRO estados sin valor fiscal (anulado incluido)', () => {
  // `anulado` es el que faltaba en este archivo. Tiene XML firmado válido, así que sin
  // esto el papel salía con eNCF y QR como si la factura siguiera valiendo.
  for (const estado of ['rechazado', 'rechazado_esquema', 'requiere_revision', 'anulado']) {
    assert.equal(conRep({ ...repReal, estado }).rechazada, true, estado)
  }
})

check('la longitud del código de seguridad no decide nada', () => {
  for (const codigo of ['He%2BUBK', 'He+UBK', 'abc']) {
    assert.equal(conRep({ ...repReal, codigo_seguridad: codigo }).conQr, true, codigo)
  }
})

check('sin qr_url no hay QR', () => {
  const { qr_url, ...sinQr } = repReal
  assert.equal(conRep(sinQr).conQr, false)
})

check('un estado desconocido no bloquea la impresión', () => {
  // Lista NEGRA, no blanca: `aceptado_condicional` hoy no existe (el CHECK de
  // `ecf_invoices` tiene ocho estados), pero si llegara es una aceptación y el papel
  // tiene que salir. Una lista blanca dejaría de imprimir facturas buenas en silencio.
  for (const estado of ['aceptado_condicional', 'estado_que_no_existe_todavia']) {
    assert.equal(conRep({ ...repReal, estado }).conQr, true, estado)
  }
})

check('sin representacion no hay nada que imprimir', () => {
  // Cliente anterior a octubre de 2026: el bridge cae a su camino viejo, que no saca QR.
  assert.equal(fiscalDesdeRepresentacion({ ncf: 'B0200000049' }), null)
})

console.log(`\n${ok} comprobaciones` + (process.exitCode ? ' — CON FALLOS\n' : ' — todas OK\n'))
