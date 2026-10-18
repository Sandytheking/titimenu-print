/**
 * Los dos papeles de una venta cobrada SIN CONEXIÓN en la PC, armados como payload del contrato
 * de siempre (`/print-receipt` y `/print-fiscal`) para que los imprima `handlePrintJob`, la misma
 * función que usan el POS web y el servidor HTTP. Aquí no se dibuja nada.
 *
 * ## Espejo de TitiStaff
 *   · Recibo: `posReceipt(…, provisional)` — label «Venta P-0007» (o «TAKEOUT - Ana - P-0007»),
 *     y la leyenda «VENTA SIN CONEXIÓN (P-0007) — pendiente de registrar.» en la NOTA, para no
 *     tocar el contrato de los bridges.
 *   · Factura: `ReglasReserva.representacion` + `respaldoLocal` + `bridgeEcfJson` — estado
 *     `contingencia`, sin líneas ni totales del XML (no hay XML), el respaldo local de la venta
 *     y `qr_contingencia`. La fecha es la de la VENTA, no la de imprimir.
 * El desglose de ITBIS del recibo usa la fórmula de `src/lib/tip.ts` (`taxBreakdown`).
 */
const R = require('./cajaReglas')

const ITBIS_RATE = 0.18

/** `taxBreakdown` de `src/lib/tip.ts`, sin propina (el POS no la lleva). */
function taxBreakdown(total, itbisEnabled) {
  if (!itbisEnabled) return null
  if (total <= 0) return null
  const base = Math.round((total / (1 + ITBIS_RATE)) * 100) / 100
  return { base, itbis: Math.round((total - base) * 100) / 100 }
}

function etiquetaRecibo(p, provisional) {
  if (p.order_type === 'delivery') return `DELIVERY${p.customer_name ? ' - ' + p.customer_name : ''} - ${provisional}`
  if (p.order_type === 'takeout') return `TAKEOUT${p.customer_name ? ' - ' + p.customer_name : ''} - ${provisional}`
  return `Venta ${provisional}`
}

/**
 * El recibo provisional. Mismo payload que `buildReceiptPayload` del web con `order_type: 'pos'`
 * (que elige la plantilla), más el número provisional y la leyenda.
 */
function reciboSinConexion(venta, config) {
  const p = venta.payload
  const provisional = R.etiquetaProvisional(venta.numeroProvisional)
  const tax = config.show_tax_breakdown_receipt ? taxBreakdown(p.total, !!config.itbis_enabled) : null
  const nota = [`VENTA SIN CONEXIÓN (${provisional}) — pendiente de registrar.`, (p.notes || '').trim() || null]
    .filter(Boolean).join(' · ')
  return {
    business_name: config.name ?? null,
    rnc: config.rnc ?? null,
    address: config.address ?? null,
    order_type: 'pos',
    order_number: provisional,
    table_label: etiquetaRecibo(p, provisional),
    customer_name: p.customer_name ?? null,
    customer_phone: p.customer_phone ?? null,
    customer_address: p.customer_address ? String(p.customer_address).split('\n')[0].trim() || null : null,
    notes: nota,
    cashier_name: p.cashier_name ?? null,
    items: p.items.map(i => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.subtotal })),
    subtotal: p.subtotal,
    delivery_fee: p.delivery_fee > 0 ? p.delivery_fee : null,
    discount_amount: p.discount_amount > 0 ? p.discount_amount : null,
    discount_pct: null,
    tip_amount: null,
    tip_pct: null,
    tax_base: tax ? tax.base : null,
    itbis: tax ? tax.itbis : null,
    total: p.total,
    payment_method: p.payment_method,
    cash_given: p.cash_given ?? null,
    change_amount: p.change_amount ?? null,
    card_amount: p.card_amount ?? null,
    currency: config.currency ?? null,
    date: R.fechaTicket(venta.vendidoEn),
  }
}

/** 'yyyy-MM-dd…' → 'dd-MM-yyyy', como el certificado. null si no se puede leer. */
function venceDdMm(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''))
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

/**
 * El papel de la factura emitida sin conexión, con el e-NCF ya tomado (USADO) para la venta.
 * `venta` debe traer ya `fiscalEncf`, `fiscalQr`, `fiscalTipo`, `fiscalRnc`, `fiscalNombre`.
 */
function facturaContingencia(venta, config, venceSecuencia) {
  const p = venta.payload
  const tipo = R.tipoDe(venta.fiscalTipo)
  const fecha = R.fechaTicket(venta.vendidoEn)
  const rncEmisor = (config.ecf_rnc || config.rnc || '').trim()
  const razon = config.legal_name || config.name || ''
  return {
    // `?? ''` como el web y TitiStaff: TitiPrint declara estos NO nulos.
    business_name: config.name || razon,
    legal_name: razon,
    rnc: rncEmisor,
    address: config.address ?? null,
    ncf: venta.fiscalEncf,
    ncf_type: tipo === '31' ? 'B01' : 'B02',
    client_name: venta.fiscalNombre ?? null,
    client_rnc: venta.fiscalRnc ?? null,
    items: [],
    subtotal: null,
    itbis: null,
    tip_amount: null,
    tip_pct: null,
    total: p.total,
    date: fecha,
    currency: config.currency ?? null,
    representacion: {
      estado: 'contingencia',
      encf: venta.fiscalEncf,
      tipo_ecf: tipo,
      tipo_nombre: tipo === '31' ? 'Factura de Crédito Fiscal Electrónica' : 'Factura de Consumo Electrónica',
      emisor_rnc: null,
      emisor_nombre: null,
      nombre_comercial: null,
      emisor_direccion: null,
      fecha_emision: fecha,
      comprador_rnc: venta.fiscalRnc ?? null,
      comprador_nombre: venta.fiscalNombre ?? null,
      // Como el certificado: solo el crédito fiscal lleva el vencimiento de la secuencia.
      vence_secuencia: tipo === '31' ? venceDdMm(venceSecuencia) : null,
      lineas: [],
      codigo_seguridad: null,
      fecha_firma: null,
      qr_url: null,
      qr_contingencia: venta.fiscalQr,
    },
    respaldo: {
      negocio_nombre: razon,
      negocio_nombre_comercial: config.name || '',
      negocio_rnc: rncEmisor,
      negocio_direccion: config.address || '',
      // Sin conexión, la hora de la VENTA (el papel puede salir un rato después).
      fecha,
      items: p.items.map(i => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.subtotal })),
      envio: p.delivery_fee > 0 ? p.delivery_fee : null,
      descuento: p.discount_amount > 0 ? p.discount_amount : null,
      total: p.total,
    },
  }
}

module.exports = { reciboSinConexion, facturaContingencia, taxBreakdown, etiquetaRecibo }
