/**
 * Pruebas de la CAJA SIN CONEXIÓN de la PC: reglas (`cajaReglas.js`) y almacén
 * (`cajaAlmacen.js`).
 *
 *     node test-caja-offline.js
 *
 * Con `node` pelado, sin Electron, como el resto de pruebas de este repo. Lo que vigila es lo
 * que en TitiStaff cubren `ReglasColaTest`, `VentaSinConexionTest`, `ContingenciaTest` y
 * `SincronizadorColaTest`, más lo propio de la PC: que la cola sobreviva a cerrar la app (otro
 * proceso lee el mismo archivo) y que un archivo dañado no se convierta en una cola vacía.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const R = require('./cajaReglas')
const { CajaAlmacen, CajaDanada, ColaLlena } = require('./cajaAlmacen')

let pasadas = 0
function prueba(nombre, fn) {
  try { fn(); pasadas++; console.log(`  ✓ ${nombre}`) } catch (e) { console.error(`  ✗ ${nombre}\n    ${e.stack}`); process.exitCode = 1 }
}

function dirTemporal() { return fs.mkdtempSync(path.join(os.tmpdir(), 'caja-offline-')) }

let n = 0
const uuidSec = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

function almacen(dir, ahora = { t: Date.parse('2026-10-17T15:00:00Z') }) {
  return new CajaAlmacen(dir || dirTemporal(), { reloj: () => ahora.t, uuid: uuidSec })
}

const NEG = 'biz-1'
const SES = 'ses-1'
function venta(total = 100, metodo = 'cash', extra = {}) {
  return {
    negocioId: NEG, sesionId: SES, total, metodoPago: metodo,
    payload: {
      business_id: NEG, session_id: SES, items: [{ name: 'X', qty: 1, price: total, subtotal: total, product_id: 'p1' }],
      subtotal: total, discount_type: null, discount_value: 0, discount_amount: 0, total,
      payment_method: metodo, cash_given: metodo === 'card' ? null : total, card_amount: metodo === 'card' ? total : null,
      change_amount: metodo === 'card' ? null : 0, notes: null, order_type: 'local', customer_name: null,
      customer_phone: null, customer_address: null, delivery_fee: 0, cashier_name: 'Ana',
      precios: [{ product_id: 'p1', precio: total }], ...extra,
    },
  }
}

const RESP_APARTAR = {
  activo: true, motivo: null, entorno: 'TEST', vence: '2026-12-31',
  qr_base: 'https://ecf.digifact.com.do/consulta?rnc=132752155&authnumber=',
  apartados_ahora: 3, avisos: [],
  reservas: [
    { tipo: '32', encf: 'E320000000102', entorno: 'TEST', vence: '2026-12-31' },
    { tipo: '32', encf: 'E320000000101', entorno: 'TEST', vence: '2026-12-31' },
    { tipo: '31', encf: 'E310000000050', entorno: 'TEST', vence: '2026-12-31' },
  ],
}

console.log('Reglas')

prueba('número provisional con cuatro cifras', () => {
  assert.strictEqual(R.etiquetaProvisional(7), 'P-0007')
  assert.strictEqual(R.etiquetaProvisional(12345), 'P-12345')
})

prueba('límite de 200 ventas sin confirmar', () => {
  assert.strictEqual(R.motivoColaLlena(199), null)
  assert.match(R.motivoColaLlena(200), /máximo es 200/)
})

prueba('solo dueño y cajero; efectivo, tarjeta o mixto; transferencia no', () => {
  assert.strictEqual(R.rolCobraSinConexion('owner'), true)
  assert.strictEqual(R.rolCobraSinConexion('cashier'), true)
  assert.strictEqual(R.rolCobraSinConexion('waiter'), false)
  assert.strictEqual(R.motivoNoCobrarSinConexion(true, true, 'cash'), null)
  assert.strictEqual(R.motivoNoCobrarSinConexion(true, true, 'mixed'), null)
  assert.match(R.motivoNoCobrarSinConexion(true, true, 'transfer'), /transferencias/)
  assert.match(R.motivoNoCobrarSinConexion(false, true, 'cash'), /dueño y el cajero/)
  assert.match(R.motivoNoCobrarSinConexion(true, false, 'cash'), /no se puede abrir la caja/)
})

prueba('cierre: bloqueado con pendientes, confirmado con problemas', () => {
  assert.deepStrictEqual(R.bloqueoCierre(2, 1, 50), { tipo: 'pendientes', cuantas: 2 })
  assert.deepStrictEqual(R.bloqueoCierre(0, 1, 50), { tipo: 'problemas', cuantas: 1, efectivo: 50 })
  assert.strictEqual(R.bloqueoCierre(0, 0, 0), null)
})

prueba('vencimiento: hoy o mañana no se usa; pasado mañana sí; fecha ilegible no', () => {
  const hoy = '2026-10-17'
  assert.strictEqual(R.usable('2026-10-17', hoy), false)
  assert.strictEqual(R.usable('2026-10-18', hoy), false)
  assert.strictEqual(R.usable('2026-10-19', hoy), true)
  assert.strictEqual(R.usable('2026-10-31T00:00:00', hoy), true)
  assert.strictEqual(R.usable('mañana', hoy), false)
  assert.strictEqual(R.usable(null, hoy), false)
})

prueba('el «hoy» se mide en hora de RD, no en UTC', () => {
  // 02:00 UTC del 18 = 22:00 del 17 en RD.
  assert.strictEqual(R.hoyRd(Date.parse('2026-10-18T02:00:00Z')), '2026-10-17')
})

prueba('motivo sin número: «vence pronto» distinto de «no quedan»', () => {
  const hoy = '2026-10-17'
  const proximos = [{ tipo: '32', estado: 'DISPONIBLE', vence: '2026-10-18', encf: 'E32' }]
  assert.match(R.motivoSinNumero(proximos, '32', hoy), /vence pronto/)
  assert.match(R.motivoSinNumero([], '32', hoy), /No quedan comprobantes de consumo/)
})

prueba('URL de contingencia: solo con una base https que termina en authnumber=', () => {
  assert.strictEqual(R.urlContingencia(RESP_APARTAR.qr_base, 'E32'), RESP_APARTAR.qr_base + 'E32')
  assert.strictEqual(R.urlContingencia('http://x?authnumber=', 'E32'), null)
  assert.strictEqual(R.urlContingencia('https://x?rnc=1', 'E32'), null)
})

prueba('E31 exige RNC y nombre; E32 no', () => {
  assert.match(R.errorFactura('31', '', 'Ana'), /necesita el RNC/)
  assert.match(R.errorFactura('31', '132752155', ''), /nombre o la razón social/)
  assert.strictEqual(R.errorFactura('31', '132-75215-5', 'Ana SRL'), null)
  assert.strictEqual(R.errorFactura('32', '', ''), null)
  assert.match(R.errorFactura('32', '123456', ''), /un RNC tiene 9/)
})

prueba('resolver la factura que subió con la venta', () => {
  const v = { fiscalEncf: 'E320000000101' }
  assert.deepStrictEqual(R.resolverContingencia(v, { encf: 'E320000000101', tipo: '32', estado: 'pendiente' }),
    { estado: 'EMITIDA', encf: 'E320000000101', error: null })
  assert.match(R.resolverContingencia(v, null).error, /no su factura E320000000101/)
  const e = R.resolverContingencia(v, { encf: 'E320000000101', error: 'SYNC_ENCF: el número no es de este aparato' })
  assert.strictEqual(e.estado, 'ERROR')
  assert.match(e.error, /^El número no es de este aparato — el cliente tiene un papel con E320000000101/)
})

prueba('avisos de corte largo: 4 h y 12 h', () => {
  const t0 = 0
  assert.strictEqual(R.nivelCorte(false, t0, 3.9 * 3600000), 'ninguno')
  assert.strictEqual(R.nivelCorte(false, t0, 4 * 3600000), 'cuatro')
  assert.strictEqual(R.nivelCorte(false, t0, 12 * 3600000), 'doce')
  assert.strictEqual(R.nivelCorte(true, t0, 20 * 3600000), 'ninguno')
  assert.match(R.textoFranja(false, t0, t0, 13 * 3600000).texto, /Más de 12 h sin conexión/)
})

prueba('el efectivo de la gaveta usa la fórmula de close_pos_session', () => {
  assert.strictEqual(R.efectivoEnGaveta({ payment_method: 'cash', total: 100 }), 100)
  assert.strictEqual(R.efectivoEnGaveta({ payment_method: 'card', total: 100 }), 0)
  assert.strictEqual(R.efectivoEnGaveta({ payment_method: 'mixed', total: 100, cash_given: 80, change_amount: 20 }), 60)
  assert.strictEqual(R.efectivoEnGaveta({ payment_method: 'mixed', total: 100, card_amount: 30 }), 70)
})

console.log('Almacén')

prueba('cada venta nace con client_uuid, vendido_en y número provisional, en disco', () => {
  const dir = dirTemporal()
  const a = almacen(dir)
  const v = a.encolar(venta())
  assert.ok(v.payload.client_uuid)
  assert.strictEqual(v.payload.vendido_en, '2026-10-17T15:00:00.000Z')
  assert.strictEqual(v.numeroProvisional, 1)
  // «Cerrar la app»: otra instancia lee lo mismo del disco.
  const b = almacen(dir)
  assert.strictEqual(b.venta(v.clientUuid).payload.total, 100)
  assert.strictEqual(b.encolar(venta()).numeroProvisional, 2)
})

prueba('orden de subida = orden de cobro', () => {
  const reloj = { t: 1000 }
  const a = almacen(null, reloj)
  const v1 = a.encolar(venta(1))
  reloj.t = 3000
  const v2 = a.encolar(venta(2))
  reloj.t = 2000
  const v3 = a.encolar(venta(3))
  assert.deepStrictEqual(a.pendientesEnOrden(NEG).map(v => v.clientUuid), [v1.clientUuid, v3.clientUuid, v2.clientUuid])
})

prueba('nunca sale de la cola sin la confirmación del servidor', () => {
  const a = almacen()
  const v = a.encolar(venta())
  a.registrarIntentoFallido(v.clientUuid, 'Sin conexión con el servidor')
  assert.strictEqual(a.venta(v.clientUuid).estado, 'PENDIENTE')
  assert.throws(() => a.marcarSubida(v.clientUuid, { ok: true }), /sigue pendiente/)
  assert.strictEqual(a.venta(v.clientUuid).estado, 'PENDIENTE')
  a.marcarSubida(v.clientUuid, { id: 'po-1', order_number: 41, ya_existia: false, avisos: [] })
  const s = a.venta(v.clientUuid)
  assert.strictEqual(s.estado, 'SUBIDA')
  assert.strictEqual(s.numeroDefinitivo, 41)
  assert.strictEqual(a.pendientesEnOrden(NEG).length, 0)
})

prueba('un reenvío (ya_existia) se marca igual: idempotente', () => {
  const a = almacen()
  const v = a.encolar(venta())
  a.marcarSubida(v.clientUuid, { id: 'po-1', order_number: 41, ya_existia: true, avisos: ['sesion_cerrada: …'] })
  assert.strictEqual(a.venta(v.clientUuid).avisos, 'sesion_cerrada: …')
})

prueba('rechazo por dato → «Ventas con problema», y se puede devolver a la cola', () => {
  const a = almacen()
  const v = a.encolar(venta())
  a.marcarProblema(v.clientUuid, 'Los renglones suman 90 y el subtotal dice 100')
  let r = a.resumen(NEG)
  assert.strictEqual(r.pendientes, 0)
  assert.strictEqual(r.problemas, 1)
  assert.strictEqual(r.efectivoProblemas, 100)
  a.devolverACola(v.clientUuid)
  r = a.resumen(NEG)
  assert.strictEqual(r.pendientes, 1)
})

prueba('límite de 200: la 201 no entra (pendientes + con problema)', () => {
  const a = almacen()
  for (let i = 0; i < 199; i++) a.encolar(venta(1))
  const v = a.encolar(venta(1))
  a.marcarProblema(v.clientUuid, 'x')
  assert.throws(() => a.encolar(venta(1)), ColaLlena)
  assert.strictEqual(a.ventas(NEG).length, 200)
})

prueba('el cierre se bloquea mientras haya pendientes', () => {
  const a = almacen()
  a.encolar(venta())
  const r = a.resumen(NEG)
  assert.deepStrictEqual(R.bloqueoCierre(r.pendientes, r.problemas, r.efectivoProblemas), { tipo: 'pendientes', cuantas: 1 })
})

prueba('apartar: entran los del servidor; un DISPONIBLE que ya no lista se borra; un USADO nunca', () => {
  const a = almacen()
  a.aplicarApartar(NEG, RESP_APARTAR)
  assert.deepStrictEqual(a.disponibles(NEG), { e32: 2, e31: 1 })
  const v = a.encolar(venta())
  const t = a.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  assert.strictEqual(t.tipo, 'tomado')
  // El servidor ya no lista nada (rango cambiado): el disponible se va, el usado se queda.
  a.aplicarApartar(NEG, { ...RESP_APARTAR, reservas: [] })
  const lista = a.apartados(NEG)
  assert.deepStrictEqual(lista.map(x => [x.encf, x.estado]), [[t.encf, 'USADO']])
})

prueba('apartar sin base de QR válida no guarda números', () => {
  const a = almacen()
  a.aplicarApartar(NEG, { ...RESP_APARTAR, qr_base: 'http://malo' })
  assert.deepStrictEqual(a.disponibles(NEG), { e32: 0, e31: 0 })
})

prueba('tomar: el MENOR número, USADO antes de imprimir; doble clic devuelve el mismo', () => {
  const dir = dirTemporal()
  const a = almacen(dir)
  a.aplicarApartar(NEG, RESP_APARTAR)
  const v = a.encolar(venta())
  const t1 = a.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  assert.strictEqual(t1.encf, 'E320000000101')
  assert.strictEqual(t1.qr, RESP_APARTAR.qr_base + 'E320000000101')
  // En disco, desde otro proceso: el número ya está USADO y asignado a esa venta.
  const b = almacen(dir)
  assert.strictEqual(b.apartados(NEG).find(x => x.encf === 'E320000000101').estado, 'USADO')
  assert.strictEqual(b.venta(v.clientUuid).fiscalEncf, 'E320000000101')
  assert.ok(b.venta(v.clientUuid).fiscalDeviceId.startsWith('pc-'))
  const t2 = b.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  assert.strictEqual(t2.encf, 'E320000000101')
  assert.strictEqual(t2.yaExistia, true)
  assert.deepStrictEqual(b.disponibles(NEG), { e32: 1, e31: 1 })
})

prueba('tomar: E31 sin nombre no gasta número', () => {
  const a = almacen()
  a.aplicarApartar(NEG, RESP_APARTAR)
  const v = a.encolar(venta())
  const t = a.tomarContingencia(NEG, v.clientUuid, 'B01', '132752155', '')
  assert.strictEqual(t.tipo, 'invalida')
  assert.deepStrictEqual(a.disponibles(NEG), { e32: 2, e31: 1 })
})

prueba('tomar: si vence mañana, no hay factura sin conexión', () => {
  const a = almacen()
  a.aplicarApartar(NEG, { ...RESP_APARTAR, reservas: RESP_APARTAR.reservas.map(r => ({ ...r, vence: '2026-10-18' })) })
  const v = a.encolar(venta())
  const t = a.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  assert.strictEqual(t.tipo, 'no_disponible')
  assert.match(t.motivo, /vence pronto/)
})

prueba('la factura de contingencia sube DENTRO del paquete de la venta', () => {
  const a = almacen()
  a.aplicarApartar(NEG, RESP_APARTAR)
  const v = a.encolar(venta())
  a.tomarContingencia(NEG, v.clientUuid, 'B01', '132-75215-5', 'Ana SRL')
  const p = R.payloadConFactura(a.venta(v.clientUuid))
  assert.deepStrictEqual(p.factura, { tipo: '31', encf: 'E310000000050', rnc: '132752155', nombre: 'Ana SRL', device_id: a.deviceId() })
  assert.strictEqual(p.client_uuid, v.clientUuid)
  // Sin factura, el paquete es el mismo objeto guardado, sin `factura`.
  const w = a.encolar(venta())
  assert.strictEqual(R.payloadConFactura(a.venta(w.clientUuid)).factura, undefined)
})

prueba('al confirmar la venta con su factura, el número deja de ser de la PC', () => {
  const a = almacen()
  a.aplicarApartar(NEG, RESP_APARTAR)
  const v = a.encolar(venta())
  const t = a.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  const r = a.marcarSubida(v.clientUuid, { id: 'po-9', order_number: 9, ya_existia: false, avisos: [], factura: { encf: t.encf, tipo: '32', estado: 'pendiente' } })
  assert.strictEqual(r.factura.estado, 'EMITIDA')
  assert.strictEqual(a.venta(v.clientUuid).fiscalEncf, t.encf)
  assert.ok(!a.apartados(NEG).some(x => x.encf === t.encf))
})

prueba('dos aparatos: identidades y UUIDs distintos, números que no se cruzan', () => {
  const pc = new CajaAlmacen(dirTemporal())
  const otra = new CajaAlmacen(dirTemporal())
  assert.notStrictEqual(pc.deviceId(), otra.deviceId())
  const v1 = pc.encolar(venta())
  const v2 = otra.encolar(venta())
  assert.notStrictEqual(v1.clientUuid, v2.clientUuid)
  // Cada uno toma solo de lo que el servidor le apartó a ÉL.
  pc.aplicarApartar(NEG, RESP_APARTAR)
  otra.aplicarApartar(NEG, { ...RESP_APARTAR, reservas: [{ tipo: '32', encf: 'E320000000201', entorno: 'TEST', vence: '2026-12-31' }] })
  assert.strictEqual(pc.tomarContingencia(NEG, v1.clientUuid, 'B02', '', '').encf, 'E320000000101')
  assert.strictEqual(otra.tomarContingencia(NEG, v2.clientUuid, 'B02', '', '').encf, 'E320000000201')
})

prueba('dueño y empleado en la misma PC: UNA identidad y UNA reserva (no van por partición)', () => {
  const dir = dirTemporal()
  // El almacén no recibe rol: el device_id y los e-NCF son del EQUIPO. Solo la foto va por rol.
  const a = almacen(dir)
  a.guardarFoto('owner', { negocioId: NEG, tomadaEn: 1 })
  a.guardarFoto('staff', { negocioId: NEG, tomadaEn: 2 })
  const id = a.deviceId()
  a.aplicarApartar(NEG, RESP_APARTAR)
  // «El empleado» (otra ventana, otro proceso que abre el mismo almacén) ve lo mismo.
  const b = almacen(dir)
  assert.strictEqual(b.deviceId(), id)
  assert.deepStrictEqual(b.disponibles(NEG), { e32: 2, e31: 1 })
  // Un número tomado desde un rol ya no está para el otro.
  const v = b.encolar(venta())
  b.tomarContingencia(NEG, v.clientUuid, 'B02', '', '')
  assert.deepStrictEqual(a.disponibles(NEG), { e32: 1, e31: 1 })
  // Y vive en el almacén del equipo (userData), no en una partición del navegador.
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  assert.ok(/new CajaAlmacen\(path\.join\(app\.getPath\('userData'\), 'caja-sin-conexion'\)/.test(main))
})

prueba('un archivo dañado NO se convierte en una cola vacía', () => {
  const dir = dirTemporal()
  const a = almacen(dir)
  a.encolar(venta())
  fs.writeFileSync(path.join(dir, 'caja.json'), '{"ventas": [ roto')
  const b = almacen(dir)
  assert.throws(() => b.ventas(NEG), CajaDanada)
  assert.throws(() => b.encolar(venta()), CajaDanada)
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('caja.danada-')))
})

prueba('la foto se guarda y se lee por rol', () => {
  const a = almacen()
  assert.strictEqual(a.leerFoto('owner'), null)
  a.guardarFoto('owner', { negocioId: NEG, tomadaEn: 5 })
  assert.deepStrictEqual(a.leerFoto('owner'), { negocioId: NEG, tomadaEn: 5 })
  assert.strictEqual(a.leerFoto('staff'), null)
})

prueba('el historial poda solo las confirmadas viejas', () => {
  const reloj = { t: Date.parse('2026-10-01T00:00:00Z') }
  const a = almacen(null, reloj)
  const v1 = a.encolar(venta())
  const v2 = a.encolar(venta())
  a.marcarSubida(v1.clientUuid, { id: 'a', order_number: 1, avisos: [] })
  reloj.t += 8 * 86400000
  assert.strictEqual(a.podarSubidas(), 1)
  assert.ok(a.venta(v2.clientUuid))
})

console.log('Papel de contingencia (printer.js)')

// Igual que test-ecf-imprimible.js: se extrae la función por texto (printer.js carga Electron).
const src = fs.readFileSync(path.join(__dirname, 'printer.js'), 'utf8')
function extraer(nombre) {
  const i = src.indexOf(`function ${nombre}(`)
  assert.ok(i >= 0, `no encontré ${nombre}`)
  let k = src.indexOf('{', i), prof = 0
  for (; k < src.length; k++) {
    if (src[k] === '{') prof++
    else if (src[k] === '}' && --prof === 0) { k++; break }
  }
  return src.slice(i, k)
}
// eslint-disable-next-line no-eval
const fiscalDesdeRepresentacion = eval(`(${extraer('fiscalDesdeRepresentacion')})`)

prueba('contingencia solo sin QR oficial, con URL y sin rechazo (como el módulo compartido)', () => {
  const base = { estado: 'contingencia', encf: 'E320000000101', tipo_nombre: 'Factura de Consumo Electrónica', lineas: [] }
  const qr = RESP_APARTAR.qr_base + 'E320000000101'
  assert.strictEqual(fiscalDesdeRepresentacion({ representacion: { ...base, qr_contingencia: qr } }).contingencia, true)
  assert.strictEqual(fiscalDesdeRepresentacion({ representacion: { ...base } }).contingencia, false)
  assert.strictEqual(fiscalDesdeRepresentacion({ representacion: { ...base, qr_contingencia: qr, qr_url: 'https://dgii' } }).contingencia, false)
  assert.strictEqual(fiscalDesdeRepresentacion({ representacion: { ...base, estado: 'anulado', qr_contingencia: qr } }).contingencia, false)
})

prueba('el papel de contingencia lleva el QR y «Contingencia», y si el QR falla no sale', () => {
  assert.ok(src.includes("const LEYENDA_CONTINGENCIA = 'Contingencia'"))
  const pie = extraer('pieSinFirmaTermico')
  assert.ok(pie.includes("comoSalio === 'ninguno'") && pie.includes('throw new Error'))
  assert.ok(!/\.raw\(/.test(pie), 'raw() no escribe en el buffer: prohibido')
})

console.log('Conexión (cajaConexion.js)')

;(async () => {
  const { Conexion } = require('./cajaConexion')
  const espera = (ms) => new Promise(r => setTimeout(r, ms))
  async function pruebaAsync(nombre, fn) {
    try { await fn(); pasadas++; console.log(`  ✓ ${nombre}`) } catch (e) { console.error(`  ✗ ${nombre}\n    ${e.stack}`); process.exitCode = 1 }
  }

  await pruebaAsync('con el POS abierto: apagar el wifi se nota en segundos, no a los 2 minutos', async () => {
    let red = true, sondas = 0
    const cambios = []
    const c = new Conexion({ url: 'https://x', anonKey: 'k', sistemaTieneRed: () => red,
      fetchImpl: async () => { sondas++; return { ok: red, status: red ? 200 : 0 } }, alCambiar: e => cambios.push(e.enLinea) })
    c.iniciar()
    c.vigilarSistema(20)   // ya vigila (3 s); esto no crea otro vigía
    await espera(30)
    assert.strictEqual(c.estado.enLinea, true)
    // El vigía real es de 3 s: aquí se acelera para la prueba.
    c.detener(); c.vigia = null; c.vigilarSistema(20)
    red = false
    await espera(80)
    assert.deepStrictEqual(cambios, [false])
    assert.strictEqual(c.estado.enLinea, false)
    red = true
    await espera(80)
    assert.deepStrictEqual(cambios, [false, true])
    c.detener()
    assert.strictEqual(sondas, 2)   // la de arranque y la de volver: sin red del sistema no se pregunta a nadie
  })

  await pruebaAsync('una petición del POS que falla por red adelanta la sonda (router vivo, proveedor caído)', async () => {
    let internet = true, sondas = 0
    const c = new Conexion({ url: 'https://x', anonKey: 'k', sistemaTieneRed: () => true,
      fetchImpl: async () => { sondas++; if (!internet) throw new Error('fetch failed'); return { ok: true, status: 200 } } })
    await c.probarAhora()
    internet = false
    c.pistaDeRed('net::ERR_INTERNET_DISCONNECTED')
    c.pistaDeRed('net::ERR_INTERNET_DISCONNECTED')   // dentro de los 10 s: no sondea otra vez
    await espera(20)
    assert.strictEqual(c.estado.enLinea, false)
    assert.strictEqual(sondas, 2)
    c.detener()
  })

  console.log(`\n${pasadas} pruebas en verde${process.exitCode ? ' — HAY FALLOS' : ''}`)
})()
