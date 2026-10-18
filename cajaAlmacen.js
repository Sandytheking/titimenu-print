/**
 * Almacén de la CAJA SIN CONEXIÓN: la cola de ventas, los e-NCF apartados y la foto de la caja,
 * en archivos dentro de `userData`. Es el equivalente de Room en TitiStaff (`ColaVentas`,
 * `ReservasEcf`, `CachePos`).
 *
 * ## Un solo archivo para la cola y los e-NCF, escrito de forma ATÓMICA
 * `caja.json` lleva las ventas, los números apartados y los contadores. Cada cambio se escribe
 * entero en un temporal, se fuerza a disco (`fsync`) y se RENOMBRA encima del bueno: un corte de
 * luz a mitad deja el archivo viejo o el nuevo, nunca uno a medias. Y como las dos cosas viven en
 * el mismo archivo, «marcar USADO el e-NCF y asignarlo a la venta» es UNA escritura: la
 * transacción de Room de la tablet (`ReservasEcf.tomar`) sin base de datos.
 *
 * Todo es síncrono a propósito: en el proceso principal de Electron no hay dos llamadas
 * intercaladas dentro de una función síncrona, así que leer-modificar-escribir no necesita
 * cerrojo.
 *
 * ## Un archivo dañado NO se reemplaza por uno vacío
 * Si `caja.json` no se puede leer, se aparta con otro nombre y la caja sin conexión se niega a
 * cobrar diciendo dónde quedó. Empezar de cero en silencio perdería las ventas que hubiera
 * dentro sin que nadie se enterara.
 *
 * Las fotos (catálogo, configuración, caja abierta) van en archivos aparte —una por rol— porque
 * pesan y se reemplazan enteras; no tienen nada que ver con la atomicidad del dinero.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const R = require('./cajaReglas')

class CajaDanada extends Error {}
class ColaLlena extends Error {}

function escribirAtomico(archivo, datos) {
  const tmp = `${archivo}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(datos))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, archivo)
}

class CajaAlmacen {
  /**
   * @param {string} dir carpeta propia dentro de userData
   * @param {{log?: (m: string) => void, reloj?: () => number, uuid?: () => string}} [opts]
   */
  constructor(dir, opts = {}) {
    this.dir = dir
    this.archivo = path.join(dir, 'caja.json')
    this.log = opts.log || (() => {})
    this.reloj = opts.reloj || Date.now
    this.uuid = opts.uuid || crypto.randomUUID
    this.danada = null
    fs.mkdirSync(dir, { recursive: true })
  }

  // ── Lectura/escritura del estado ───────────────────────────────────────────

  _leer() {
    if (this.danada) throw new CajaDanada(this.danada)
    let txt
    try {
      txt = fs.readFileSync(this.archivo, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, deviceId: null, seq: {}, ventas: [], apartados: [] }
      throw e
    }
    try {
      const s = JSON.parse(txt)
      s.seq = s.seq || {}
      s.ventas = s.ventas || []
      s.apartados = s.apartados || []
      return s
    } catch (e) {
      const apartado = path.join(this.dir, `caja.danada-${this.reloj()}.json`)
      try { fs.renameSync(this.archivo, apartado) } catch {}
      this.danada = `El archivo de ventas sin conexión estaba dañado y se apartó en ${apartado}. ` +
        'No se cobra sin conexión hasta revisarlo: avisa a TitiMenu (las ventas que tenga siguen en ese archivo).'
      this.log(`[caja-offline] ${this.danada} (${e.message})`)
      throw new CajaDanada(this.danada)
    }
  }

  _escribir(s) {
    escribirAtomico(this.archivo, s)
  }

  /** Lee, aplica `fn` y escribe en UNA vuelta. `fn` devuelve el resultado; si lanza, no se escribe nada. */
  _tx(fn) {
    const s = this._leer()
    const r = fn(s)
    this._escribir(s)
    return r
  }

  // ── Identidad del aparato ──────────────────────────────────────────────────

  /**
   * El `device_id` de ESTA PC para `ecf_apartar`. Se genera una vez y se guarda: no es el de
   * ninguna tablet, así que los números de cada aparato no se pisan.
   */
  deviceId() {
    const s = this._leer()
    if (s.deviceId) return s.deviceId
    return this._tx(t => {
      if (!t.deviceId) {
        t.deviceId = `pc-${this.uuid()}`
        this.log(`[caja-offline] identidad nueva de este equipo para los e-NCF: ${t.deviceId}`)
      }
      return t.deviceId
    })
  }

  // ── Foto de la caja ────────────────────────────────────────────────────────

  _archivoFoto(rol) {
    if (rol !== 'owner' && rol !== 'staff') throw new Error(`rol desconocido: ${rol}`)
    return path.join(this.dir, `foto-${rol}.json`)
  }

  /** La foto se REEMPLAZA entera: nunca se mezcla una foto con otra a medias. */
  guardarFoto(rol, foto) {
    escribirAtomico(this._archivoFoto(rol), foto)
  }

  leerFoto(rol) {
    try {
      return JSON.parse(fs.readFileSync(this._archivoFoto(rol), 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[caja-offline] la foto guardada (${rol}) no se pudo leer; se trata como si no hubiera: ${e.message}`)
      return null
    }
  }

  // ── Cola de ventas ─────────────────────────────────────────────────────────

  /**
   * Guarda una venta cobrada sin conexión. ANTES de imprimir nada: el UUID, la hora y el número
   * provisional nacen aquí y quedan en disco en la misma escritura. Si la PC muere después, la
   * venta está; si muere antes, no se imprimió.
   *
   * @param {{negocioId: string, sesionId: string, payload: object, total: number,
   *          metodoPago: string}} v  `payload` es el paquete de `pos_sincronizar_venta` SIN
   *          `client_uuid` ni `vendido_en`, que se ponen aquí.
   */
  encolar(v) {
    return this._tx(s => {
      const sinConfirmar = s.ventas.filter(x => x.negocioId === v.negocioId &&
        (x.estado === R.EstadoVenta.PENDIENTE || x.estado === R.EstadoVenta.PROBLEMA)).length
      const lleno = R.motivoColaLlena(sinConfirmar)
      if (lleno) throw new ColaLlena(lleno)

      const ahora = this.reloj()
      const n = (s.seq[v.negocioId] || 0) + 1
      s.seq[v.negocioId] = n
      const clientUuid = this.uuid()
      const payload = { ...v.payload, client_uuid: clientUuid, vendido_en: new Date(ahora).toISOString() }
      const venta = {
        clientUuid, negocioId: v.negocioId, sesionId: v.sesionId, numeroProvisional: n, vendidoEn: ahora,
        payload, total: v.total, metodoPago: v.metodoPago, efectivo: R.efectivoEnGaveta(payload),
        estado: R.EstadoVenta.PENDIENTE, intentos: 0, ultimoError: null, ultimoIntentoEn: null,
        posOrderId: null, numeroDefinitivo: null, avisos: null, subidaEn: null,
        fiscalTipo: null, fiscalRnc: null, fiscalNombre: null, fiscalEstado: R.EstadoFiscal.NO,
        fiscalEncf: null, fiscalError: null, fiscalDeviceId: null, fiscalQr: null,
      }
      s.ventas.push(venta)
      this.log(`[cola] venta ${R.etiquetaProvisional(n)} guardada en esta computadora (${v.metodoPago}, total ${v.total})`)
      return venta
    })
  }

  venta(uuid) {
    return this._leer().ventas.find(v => v.clientUuid === uuid) || null
  }

  ventas(negocioId) {
    return this._leer().ventas.filter(v => !negocioId || v.negocioId === negocioId)
  }

  /** Las que esperan subir, en orden de cobro. */
  pendientesEnOrden(negocioId) {
    return R.ordenar(this.ventas(negocioId).filter(v => v.estado === R.EstadoVenta.PENDIENTE))
  }

  resumen(negocioId) {
    const vs = this.ventas(negocioId)
    const pend = vs.filter(v => v.estado === R.EstadoVenta.PENDIENTE)
    const prob = vs.filter(v => v.estado === R.EstadoVenta.PROBLEMA)
    return {
      pendientes: pend.length,
      problemas: prob.length,
      efectivoProblemas: prob.reduce((a, v) => a + (v.efectivo || 0), 0),
      sinConfirmar: pend.length + prob.length,
      masVieja: pend.length ? Math.min(...pend.map(v => v.vendidoEn)) : null,
    }
  }

  _mod(uuid, fn) {
    return this._tx(s => {
      const v = s.ventas.find(x => x.clientUuid === uuid)
      if (!v) throw new Error(`venta ${uuid} no encontrada en esta computadora`)
      return fn(v, s)
    })
  }

  /**
   * El servidor CONFIRMÓ la venta (devolvió su id). Es la ÚNICA forma de que deje de estar
   * pendiente: nunca se borra de la cola sin esto. Con factura de contingencia, en la misma
   * escritura se resuelve la factura y se suelta el e-NCF apartado (ya es del servidor).
   *
   * @param resp la respuesta de `pos_sincronizar_venta`: {id, order_number, ya_existia, avisos, factura}
   */
  marcarSubida(uuid, resp) {
    if (!resp || !resp.id || resp.order_number == null) {
      throw new Error('respuesta del servidor sin id ni número: la venta sigue pendiente')
    }
    return this._mod(uuid, (v, s) => {
      const ahora = this.reloj()
      v.estado = R.EstadoVenta.SUBIDA
      v.posOrderId = resp.id
      v.numeroDefinitivo = resp.order_number
      v.avisos = Array.isArray(resp.avisos) && resp.avisos.length ? resp.avisos.join('\n') : null
      v.subidaEn = ahora
      v.ultimoError = null
      v.intentos += 1
      v.ultimoIntentoEn = ahora
      let factura = null
      if (v.fiscalEstado === R.EstadoFiscal.CONTINGENCIA) {
        factura = R.resolverContingencia(v, resp.factura)
        v.fiscalEstado = factura.estado
        v.fiscalEncf = factura.encf
        v.fiscalError = factura.error
        // El número ya es del servidor (emitido, o liberado para el 608): deja de ser de la PC.
        // El e-NCF del papel sigue en la venta (`fiscalEncf`) para el historial.
        s.apartados = s.apartados.filter(a => !(a.negocioId === v.negocioId && a.estado === R.EstadoApartado.USADO && a.clientUuid === v.clientUuid))
      }
      const et = R.etiquetaProvisional(v.numeroProvisional)
      this.log(`[cola] ${et} subida como #${resp.order_number}${resp.ya_existia ? ' (ya estaba: reenvío)' : ''}` +
        (v.avisos ? ` — avisos: ${v.avisos.replace(/\n/g, ' | ')}` : '') +
        (factura ? (factura.estado === R.EstadoFiscal.EMITIDA
          ? ` — factura de contingencia ${factura.encf} registrada con la venta`
          : ` — la venta subió SIN su factura: ${factura.error}`) : ''))
      return { venta: { ...v }, factura }
    })
  }

  /** El servidor rechazó la venta por un DATO: a «Ventas con problema». No se reintenta sola. */
  marcarProblema(uuid, motivo) {
    return this._mod(uuid, v => {
      const ahora = this.reloj()
      v.estado = R.EstadoVenta.PROBLEMA
      v.ultimoError = motivo
      v.intentos += 1
      v.ultimoIntentoEn = ahora
      this.log(`[cola] ${R.etiquetaProvisional(v.numeroProvisional)} RECHAZADA por el servidor, pasa a «Ventas con problema»: ${motivo}`)
      return { ...v }
    })
  }

  /** Red o sesión: sigue en cola, se anota el intento. */
  registrarIntentoFallido(uuid, motivo) {
    return this._mod(uuid, v => {
      v.ultimoError = motivo
      v.intentos += 1
      v.ultimoIntentoEn = this.reloj()
      return { ...v }
    })
  }

  /** Desde «Ventas con problema», el dueño la devuelve a la cola para reintentar. */
  devolverACola(uuid) {
    return this._mod(uuid, v => {
      if (v.estado !== R.EstadoVenta.PROBLEMA) return { ...v }
      v.estado = R.EstadoVenta.PENDIENTE
      this.log(`[cola] ${R.etiquetaProvisional(v.numeroProvisional)} devuelta a la cola desde «Ventas con problema»`)
      return { ...v }
    })
  }

  /** Borra del historial las ya confirmadas hace más de DIAS_HISTORIAL. Nunca una sin confirmar. */
  podarSubidas() {
    const limite = this.reloj() - R.DIAS_HISTORIAL * 86400000
    return this._tx(s => {
      const antes = s.ventas.length
      s.ventas = s.ventas.filter(v => !(v.estado === R.EstadoVenta.SUBIDA && v.subidaEn != null && v.subidaEn < limite))
      const n = antes - s.ventas.length
      if (n > 0) this.log(`[cola] ${n} ventas ya confirmadas salieron del historial de esta computadora`)
      return n
    })
  }

  // ── e-NCF apartados ────────────────────────────────────────────────────────

  apartados(negocioId) {
    return this._leer().apartados.filter(a => a.negocioId === negocioId)
  }

  /** Deja los apartados igual a lo que dice el servidor (`ecf_apartar`), sin tocar un USADO. */
  aplicarApartar(negocioId, resp) {
    return this._tx(s => {
      const f = R.fusionar(negocioId, s.apartados.filter(a => a.negocioId === negocioId), resp)
      if (f.borrar.length) {
        const fuera = new Set(f.borrar)
        s.apartados = s.apartados.filter(a => !(a.negocioId === negocioId && a.estado === R.EstadoApartado.DISPONIBLE && fuera.has(a.encf)))
      }
      s.apartados.push(...f.insertar)
      if (resp && resp.qr_base && R.urlContingencia(resp.qr_base, '') == null) {
        this.log(`[reservas] el servidor mandó una base de QR inválida («${resp.qr_base}»): no se guardan números para usar sin conexión`)
      }
      this.log(`[reservas] ${resp?.apartados_ahora ?? 0} apartados ahora, ${(resp?.reservas || []).length} del aparato en el servidor, ` +
        `+${f.insertar.length}/−${f.borrar.length} en esta computadora` +
        (resp && resp.activo === false ? ` — no aparta: ${resp.motivo}` : '') +
        (resp && resp.avisos && resp.avisos.length ? ` — avisos: ${resp.avisos.join(' | ')}` : ''))
      if (f.borrar.length) this.log(`[reservas] ${f.borrar.length} números ya no son de este equipo (liberados o de un rango anterior): ${f.borrar.join(', ')}`)
      return f
    })
  }

  disponibles(negocioId) {
    const hoy = R.hoyRd(this.reloj())
    const lista = this.apartados(negocioId)
    const n = t => lista.filter(a => a.tipo === t && a.estado === R.EstadoApartado.DISPONIBLE && R.usable(a.vence, hoy)).length
    return { e32: n('32'), e31: n('31') }
  }

  /**
   * Toma el siguiente e-NCF apartado para la venta [uuid]. Espejo de `TomaContingencia`:
   *   · El número queda USADO y asignado a la venta en UNA escritura, ANTES de devolver nada
   *     imprimible. Nunca hay un papel con un número que la PC pueda volver a dar.
   *   · Idempotente por venta: un doble clic devuelve el MISMO número, no gasta otro.
   *
   * @returns {{tipo: 'tomado', encf, tipoEcf, qr, vence, yaExistia} | {tipo: 'no_disponible'|'invalida', motivo}}
   */
  tomarContingencia(negocioId, uuid, ncfType, rnc, nombre) {
    const tipo = R.tipoDe(ncfType)
    if (!tipo) return { tipo: 'invalida', motivo: `Tipo de comprobante no permitido: ${ncfType}` }
    const err = R.errorFactura(tipo, rnc, nombre)
    if (err) return { tipo: 'invalida', motivo: err }
    const deviceId = this.deviceId()

    return this._tx(s => {
      const v = s.ventas.find(x => x.clientUuid === uuid)
      if (!v) return { tipo: 'invalida', motivo: 'No se encontró la venta en esta computadora' }
      if (v.fiscalEstado === R.EstadoFiscal.CONTINGENCIA && v.fiscalEncf && v.fiscalQr) {
        this.log(`[contingencia] la venta ${uuid} ya tiene la factura ${v.fiscalEncf}: se devuelve la misma (no se gasta otro número)`)
        const a = s.apartados.find(x => x.encf === v.fiscalEncf)
        return { tipo: 'tomado', encf: v.fiscalEncf, tipoEcf: tipo, qr: v.fiscalQr, vence: a ? a.vence : null, yaExistia: true }
      }
      if (v.fiscalEstado !== R.EstadoFiscal.NO) {
        return { tipo: 'invalida', motivo: `Esta venta ya tiene una factura pedida (${v.fiscalEstado}).` }
      }
      const ahora = this.reloj()
      const hoy = R.hoyRd(ahora)
      const lista = s.apartados.filter(a => a.negocioId === negocioId)
      const sig = R.siguiente(lista, tipo, hoy)
      if (!sig) {
        const motivo = R.motivoSinNumero(lista, tipo, hoy)
        this.log(`[contingencia] sin número E${tipo} utilizable: ${motivo} (${lista.filter(a => a.tipo === tipo).length} apartados de ese tipo en esta computadora)`)
        return { tipo: 'no_disponible', motivo }
      }
      const qr = R.urlContingencia(sig.qrBase, sig.encf)
      if (!qr) {
        this.log(`[contingencia] la base del QR guardada no es válida («${sig.qrBase}»): no se usa ${sig.encf}`)
        return { tipo: 'no_disponible', motivo: 'No se pudo armar el QR de contingencia: aparta comprobantes de nuevo con conexión.' }
      }
      // Las dos cosas en la MISMA escritura: el número USADO y la venta con su factura.
      sig.estado = R.EstadoApartado.USADO
      sig.usadoEn = ahora
      sig.clientUuid = uuid
      v.fiscalTipo = tipo === '31' ? 'B01' : 'B02'
      v.fiscalRnc = R.normalizarRnc(rnc) || null
      v.fiscalNombre = String(nombre || '').trim() || null
      v.fiscalEstado = R.EstadoFiscal.CONTINGENCIA
      v.fiscalEncf = sig.encf
      v.fiscalDeviceId = deviceId
      v.fiscalQr = qr
      this.log(`[contingencia] ${sig.encf} tomado para la venta ${uuid} y marcado USADO antes de imprimir`)
      return { tipo: 'tomado', encf: sig.encf, tipoEcf: tipo, qr, vence: sig.vence, yaExistia: false }
    })
  }
}

module.exports = { CajaAlmacen, CajaDanada, ColaLlena, escribirAtomico }
