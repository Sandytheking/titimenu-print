/**
 * Reglas de la CAJA SIN CONEXIÓN de la PC, en JS puro (lo que cubre `test-caja-offline.js`).
 *
 * ## Es un ESPEJO, no un diseño nuevo
 * Todo lo de aquí existe ya en TitiStaff y tiene que decir lo mismo, con los mismos textos:
 *   · `ReglasCola.kt`      — límite de 200, número provisional, orden, bloqueo del cierre,
 *                            quién y cómo cobra sin conexión, la factura que sube con la venta.
 *   · `ReglasReserva.kt`   — los e-NCF apartados: vigencia («vence hoy o mañana: no se usa»),
 *                            el siguiente número, la URL del QR, la fusión con el servidor.
 *   · `ReglasConexion.kt`  — los avisos de corte largo (4 h y 12 h).
 *   · `Rnc.kt` / `src/lib/rnc.ts` — RNC y nombre obligatorios en el crédito fiscal.
 * Si una regla cambia allá, cambia aquí. La clasificación de errores al SUBIR vive en el web
 * (`src/lib/cajaSinConexion.ts`), que es quien sube: no se duplica aquí.
 *
 * Sin Electron ni disco: el almacén (`cajaAlmacen.js`) y la pantalla llaman a esto.
 */

// ─── Cola ─────────────────────────────────────────────────────────────────────

/**
 * Tope de ventas sin confirmar en este equipo. No es técnico: 200 ventas son varios turnos de
 * dinero viviendo en una sola PC. Pasado eso se para y alguien busca conexión.
 */
const LIMITE = 200

const EstadoVenta = { PENDIENTE: 'PENDIENTE', PROBLEMA: 'PROBLEMA', SUBIDA: 'SUBIDA' }
const EstadoFiscal = { NO: 'NO', CONTINGENCIA: 'CONTINGENCIA', EMITIDA: 'EMITIDA', ERROR: 'ERROR' }
const EstadoApartado = { DISPONIBLE: 'DISPONIBLE', USADO: 'USADO' }

/** Días que se conserva el historial de ventas ya subidas (igual que la tablet). */
const DIAS_HISTORIAL = 7

/** «P-0007»: el número del ticket hasta que el servidor dé el definitivo. */
function etiquetaProvisional(n) {
  return 'P-' + String(Math.max(0, n | 0)).padStart(4, '0')
}

/** null = se puede encolar otra; si no, el motivo para el cajero. Cuenta pendientes + con problema. */
function motivoColaLlena(sinConfirmar) {
  if (sinConfirmar < LIMITE) return null
  return `Hay ${sinConfirmar} ventas sin subir en esta computadora, el máximo es ${LIMITE}. ` +
    'Busca conexión (otra wifi o datos del teléfono) para subirlas antes de seguir cobrando.'
}

/** El orden de subida: como se cobraron. El número provisional desempata dos del mismo ms. */
function ordenar(ventas) {
  return [...ventas].sort((a, b) => (a.vendidoEn - b.vendidoEn) || (a.numeroProvisional - b.numeroProvisional))
}

/**
 * Por qué no se puede cerrar la caja, o null si se puede.
 *   · Pendientes: el cuadre del efectivo saldría mal. No se cierra.
 *   · Problemas: se puede cerrar, pero confirmándolo a sabiendas.
 */
function bloqueoCierre(pendientes, problemas, efectivoProblemas) {
  if (pendientes > 0) return { tipo: 'pendientes', cuantas: pendientes }
  if (problemas > 0) return { tipo: 'problemas', cuantas: problemas, efectivo: efectivoProblemas }
  return null
}

/**
 * ¿Se puede cobrar sin conexión? null = sí; si no, el motivo.
 * Transferencia no: sin conexión nadie puede comprobar que el dinero llegó.
 */
function motivoNoCobrarSinConexion(rolPermitido, hayCajaAbierta, metodo) {
  if (!rolPermitido) return 'Sin conexión solo cobran el dueño y el cajero.'
  if (!hayCajaAbierta) return 'Sin conexión no se puede abrir la caja. Ábrela cuando vuelva el internet.'
  if (metodo === 'transfer') return 'Sin conexión no se aceptan transferencias: no hay cómo comprobar que llegó el dinero.'
  if (!['cash', 'card', 'mixed'].includes(metodo)) return 'Ese método de pago no está disponible sin conexión.'
  return null
}

/** El rol que cobra sin conexión. Mismos dos que acepta `pos_sincronizar_venta` (SYNC_ROL). */
function rolCobraSinConexion(rol) {
  return rol === 'owner' || rol === 'cashier'
}

/**
 * El efectivo que esta venta metió en la gaveta — la fórmula de `close_pos_session`:
 * efectivo = total; mixto = cash_given − change_amount (o total − card_amount); tarjeta = 0.
 * Solo para AVISAR en el cierre cuánto dinero no entraría en el arqueo.
 */
function efectivoEnGaveta(p) {
  if (p.payment_method === 'cash') return p.total
  if (p.payment_method === 'mixed') {
    return p.cash_given != null ? p.cash_given - (p.change_amount || 0) : p.total - (p.card_amount || 0)
  }
  return 0
}

/**
 * El paquete de la venta + el bloque `factura` de contingencia. La venta va EXACTAMENTE como
 * se armó al cobrar (no se rearma); solo se le añade la factura. Tipo en 31/32.
 */
function payloadConFactura(v) {
  if (v.fiscalEstado !== EstadoFiscal.CONTINGENCIA) return v.payload
  return {
    ...v.payload,
    factura: {
      tipo: tipoDe(v.fiscalTipo) || v.fiscalTipo,
      encf: v.fiscalEncf,
      rnc: v.fiscalRnc,
      nombre: v.fiscalNombre,
      device_id: v.fiscalDeviceId,
    },
  }
}

/** El mensaje del servidor sin el prefijo técnico: «SYNC_PLAN: el negocio…» → «El negocio…». */
function motivoLegible(m) {
  const sin = String(m || '').replace(/^.*?SYNC_[A-Z]+:\s*/, '')
  return sin ? sin[0].toUpperCase() + sin.slice(1) : 'El servidor rechazó la venta'
}

/**
 * Qué quedó de la factura de contingencia según la respuesta de `pos_sincronizar_venta`. El
 * e-NCF del papel se conserva aunque haya error: es lo que el dueño necesita para avisar al
 * cliente. Espejo de `ReglasCola.resolverContingencia`.
 */
function resolverContingencia(v, f) {
  if (f == null) {
    return { estado: EstadoFiscal.ERROR, encf: v.fiscalEncf,
      error: `El servidor registró la venta pero no su factura ${v.fiscalEncf} (¿el servidor no está actualizado?). ` +
        'El cliente tiene un papel con ese número: avisa a TitiMenu.' }
  }
  if (f.error != null) {
    const m = motivoLegible(f.error)
    return { estado: EstadoFiscal.ERROR, encf: v.fiscalEncf,
      error: /papel/i.test(m) ? m : `${m} — el cliente tiene un papel con ${v.fiscalEncf}.` }
  }
  if (f.encf != null) return { estado: EstadoFiscal.EMITIDA, encf: f.encf, error: null }
  return { estado: EstadoFiscal.ERROR, encf: v.fiscalEncf, error: `El servidor no dijo qué pasó con la factura ${v.fiscalEncf}.` }
}

// ─── Conexión ─────────────────────────────────────────────────────────────────

/** Escalón del aviso de corte largo. Se avisa a las 4 h y a las 12 h. */
function nivelCorte(enLinea, desdeMs, ahoraMs) {
  if (enLinea) return 'ninguno'
  const horas = (ahoraMs - desdeMs) / 3600000
  if (horas >= 12) return 'doce'
  if (horas >= 4) return 'cuatro'
  return 'ninguno'
}

/** Cada cuánto se sondea: rápido sin conexión (para notar que volvió), lento con ella. */
function intervaloSondaMs(enLinea) {
  return enLinea ? 120000 : 15000
}

/** La franja, con las mismas palabras que `FranjaConexion` de TitiStaff. */
function textoFranja(enLinea, desdeMs, fotoDe, ahoraMs) {
  if (enLinea) return null
  const base = fotoDe != null ? `Sin conexión — trabajando con los datos de las ${horaRd(fotoDe)}` : 'Sin conexión'
  const nivel = nivelCorte(enLinea, desdeMs, ahoraMs)
  if (nivel === 'doce') return { texto: `${base} · Más de 12 h sin conexión: las ventas siguen solo en esta computadora. Busca otra red para subirlas.`, grave: true }
  if (nivel === 'cuatro') return { texto: `${base} · Más de 4 h sin conexión: las ventas siguen guardadas en esta computadora.`, grave: true }
  return { texto: base, grave: false }
}

// ─── Fechas en hora de RD ─────────────────────────────────────────────────────

const ZONA_RD = 'America/Santo_Domingo'

function partesRd(ms) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_RD, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const o = {}
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value
  return o
}

/** 'yyyy-MM-dd' de hoy en RD. La vigencia es de la DGII: se mide en hora de RD, no en la de la PC. */
function hoyRd(ms) {
  const p = partesRd(ms)
  return `${p.year}-${p.month}-${p.day}`
}

/** «3:05 p. m.» en hora de RD, para la franja. */
function horaRd(ms) {
  return new Date(ms).toLocaleTimeString('es-DO', { timeZone: ZONA_RD, hour: 'numeric', minute: '2-digit' })
    .replace(/[  ]/g, ' ')
}

/** «dd/MM/yyyy, hh:mm a» en hora de RD: el formato del ticket de TitiStaff (`posTicketDateAt`). */
function fechaTicket(ms) {
  const p = partesRd(ms)
  let h = Number(p.hour) % 24
  const ampm = h >= 12 ? 'p. m.' : 'a. m.'
  h = h % 12 || 12
  return `${p.day}/${p.month}/${p.year}, ${String(h).padStart(2, '0')}:${p.minute} ${ampm}`
}

/** 'yyyy-MM-dd' + n días, sin zona: aritmética de calendario. */
function sumarDias(isoDia, n) {
  const d = new Date(`${isoDia}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ─── e-NCF apartados ──────────────────────────────────────────────────────────

/** B01 → 31, B02 → 32 (y 31/32 tal cual). null = no es un tipo que se emita aquí. */
function tipoDe(ncfType) {
  const t = String(ncfType || '').trim().toUpperCase()
  if (t === 'B01' || t === '31') return '31'
  if (t === 'B02' || t === '32') return '32'
  return null
}

function nombreTipo(tipo) {
  return tipo === '31' ? 'crédito fiscal' : 'consumo'
}

/**
 * ¿Se puede usar SIN CONEXIÓN un número de una autorización que vence el [vence]?
 * La DGII valida la vigencia contra la fecha de ENVÍO; sin conexión no se sabe cuándo será.
 * Por eso no se usa si vence HOY o MAÑANA. Una fecha ilegible no se usa.
 */
function usable(vence, hoy) {
  const v = String(vence || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return false
  return v > sumarDias(hoy, 1)
}

/** El siguiente número: el MENOR disponible y vigente del tipo pedido. */
function siguiente(lista, tipo, hoy) {
  const ok = lista.filter(a => a.tipo === tipo && a.estado === EstadoApartado.DISPONIBLE && usable(a.vence, hoy))
  ok.sort((a, b) => (a.encf < b.encf ? -1 : a.encf > b.encf ? 1 : 0))
  return ok[0] || null
}

/** Por qué no hay número que usar. Distingue «no quedan» de «vencen pronto». */
function motivoSinNumero(lista, tipo, hoy) {
  const delTipo = lista.filter(a => a.tipo === tipo && a.estado === EstadoApartado.DISPONIBLE)
  if (delTipo.length > 0 && delTipo.every(a => !usable(a.vence, hoy))) {
    return 'La autorización de comprobantes vence pronto; sin conexión no se puede emitir factura fiscal.'
  }
  return `No quedan comprobantes de ${nombreTipo(tipo)} disponibles sin conexión.`
}

/**
 * La URL del QR: la base que armó el servidor + el e-NCF. El formato NO se escribe aquí (vive
 * en `ecf_url_contingencia`); solo se comprueba que la base tenga forma de base.
 */
function urlContingencia(qrBase, encf) {
  const b = String(qrBase || '').trim()
  if (!b.startsWith('https://') || !b.endsWith('authnumber=')) return null
  return b + encf
}

// RNC: espejo de `errorRnc` / `errorNombreCliente` de `src/lib/rnc.ts` (y `Rnc.kt`).
function normalizarRnc(raw) {
  return String(raw ?? '').replace(/[\s.\-]/g, '')
}

function errorRnc(raw, obligatorio) {
  const d = normalizarRnc(raw)
  if (!d) return obligatorio ? 'El crédito fiscal necesita el RNC o la cédula del cliente.' : null
  if (!/^\d+$/.test(d)) return 'Sólo números: un RNC o una cédula no llevan letras.'
  if (d.length !== 9 && d.length !== 11) {
    return `Tiene ${d.length} dígito${d.length === 1 ? '' : 's'}: un RNC tiene 9 y una cédula 11.`
  }
  if (/^(.)\1*$/.test(d)) return 'Ese número no puede ser un RNC ni una cédula.'
  return null
}

function errorNombreCliente(nombre, esCreditoFiscal) {
  if (!esCreditoFiscal) return null
  return String(nombre ?? '').trim() ? null : 'El crédito fiscal necesita el nombre o la razón social del cliente.'
}

/** Antes de gastar un número: E31 con RNC y nombre; si hay RNC, con la forma correcta. */
function errorFactura(tipo, rnc, nombre) {
  return errorRnc(rnc, tipo === '31') || errorNombreCliente(nombre, tipo === '31')
}

/**
 * Junta lo que la PC tiene con lo que el servidor dice que le pertenece (`ecf_apartar`).
 *   · Un DISPONIBLE que el servidor ya no lista → se borra (se liberó o cambió el rango).
 *   · Uno que el servidor lista y la PC no → entra como DISPONIBLE.
 *   · Un USADO no se toca NUNCA aquí: es un papel que ya tiene un cliente.
 *   · Sin URL base válida no se puede imprimir el QR: no entra nada y se borran los disponibles.
 */
function fusionar(negocioId, local, r) {
  const base = r && r.qr_base && urlContingencia(r.qr_base, '') != null ? r.qr_base : null
  const delServidor = new Map()
  if (base) for (const x of (r.reservas || [])) delServidor.set(x.encf, x)
  const enLocal = new Set(local.map(a => a.encf))
  const borrar = local.filter(a => a.negocioId === negocioId && a.estado === EstadoApartado.DISPONIBLE && !delServidor.has(a.encf)).map(a => a.encf)
  const insertar = [...delServidor.values()].filter(x => !enLocal.has(x.encf)).map(x => ({
    negocioId, encf: x.encf, tipo: String(x.tipo), entorno: x.entorno, vence: x.vence,
    qrBase: base, estado: EstadoApartado.DISPONIBLE, usadoEn: null, clientUuid: null,
  }))
  return { insertar, borrar }
}

/**
 * ¿Puede salir el papel de contingencia CON su QR desde esta PC? Lo dibuja el propio bridge
 * (térmica o modo sistema), así que basta con que haya impresora de caja. Sin ella la factura
 * de contingencia NO se emite: no se entrega un papel sin QR.
 */
function motivoSinImpresoraContingencia(hayImpresoraCaja) {
  if (hayImpresoraCaja) return null
  return 'La factura fiscal sin conexión necesita la impresora de caja de esta computadora para imprimir ' +
    'el QR de contingencia. Sin el QR el cliente no puede consultar su factura. Configura la impresora, ' +
    'o entrega la venta sin factura fiscal.'
}

module.exports = {
  LIMITE, DIAS_HISTORIAL, EstadoVenta, EstadoFiscal, EstadoApartado,
  etiquetaProvisional, motivoColaLlena, ordenar, bloqueoCierre, motivoNoCobrarSinConexion,
  rolCobraSinConexion, efectivoEnGaveta, payloadConFactura, motivoLegible, resolverContingencia,
  nivelCorte, intervaloSondaMs, textoFranja,
  ZONA_RD, hoyRd, horaRd, fechaTicket, sumarDias,
  tipoDe, nombreTipo, usable, siguiente, motivoSinNumero, urlContingencia,
  normalizarRnc, errorRnc, errorNombreCliente, errorFactura, fusionar, motivoSinImpresoraContingencia,
}
