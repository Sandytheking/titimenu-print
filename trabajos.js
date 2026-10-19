/**
 * De un payload del contrato HTTP (`/print-receipt`, `/print-fiscal`, `/print-closing`) a la
 * plantilla que lo imprime. Es el ÚNICO mapeo: lo usan el servidor HTTP y el IPC del POS de
 * este bridge, y la app de escritorio nativa (menuqr/desktop) lo copia LITERAL —su
 * `scripts/verificar-copias.mjs` sale en rojo si difieren—, así el mismo payload da el mismo
 * papel salga por donde salga.
 *
 * Por qué una fábrica y no funciones sueltas: el mapeo necesita la configuración (`store`), la
 * impresora de caja, la cola por impresora y las plantillas, y cada app tiene las suyas.
 */

/** Error de impresión que sabe con qué código HTTP debe contestar el servidor. */
class PrintJobError extends Error {
  constructor(message, httpStatus) {
    super(message)
    this.name = 'PrintJobError'
    this.httpStatus = httpStatus
  }
}

/**
 * @param {{ store: { get(k: string, d?: any): any },
 *           impresoraCaja: () => string,
 *           encolar: (impresora: string, fn: () => Promise<any>) => Promise<any>,
 *           printer: { printPOSReceipt: Function, printDeliveryTicket: Function,
 *                      printFiscalReceipt: Function, printClosingReport: Function } }} deps
 */
function crearHandlePrintJob({ store, impresoraCaja, encolar, printer }) {
  const { printPOSReceipt, printDeliveryTicket, printFiscalReceipt, printClosingReport } = printer
/**
 * Imprime uno de los tres documentos.
 * @param {'print-receipt'|'print-fiscal'|'print-closing'} endpoint
 * @param {object} data payload tal como lo manda el web
 * @returns {Promise<string>} resumen para el log (el caller le pone el prefijo del
 *          transporte: "HTTP: …" o "POS: …")
 */
  return async function handlePrintJob(endpoint, data) {
  const printerCaja = impresoraCaja()

  if (endpoint === 'print-receipt') {
    const order = {
      order_number: data.order_number,
      table_label: data.table_label || null,
      table_number: data.table_number || null,
      order_type: data.order_type || null,
      // Campos del cliente para el ticket de delivery/takeout (la plantilla los
      // imprime como Cliente/Tel/Dir/Nota). Nombres idénticos a la BD/camino automático.
      customer_name: data.customer_name || null,
      customer_phone: data.customer_phone || null,
      customer_address: data.customer_address || null,
      // El whitelist de este mapeo es explícito: lo que no se liste NO llega a la
      // plantilla por muy bien que lo mande el web. cashier_name faltaba, y por eso
      // el "Cajero/a" no salía aunque el payload lo traía.
      cashier_name: data.cashier_name || null,
      notes: data.notes || null,
      delivery_fee: data.delivery_fee || null,
      items: (data.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price, subtotal: i.subtotal })),
      subtotal: data.subtotal,
      total: data.total,
      tip_amount: data.tip_amount,
      tip_pct: data.tip_pct,
      // Desglose de ITBIS del recibo, YA calculado por el web. Si no se lista acá NO
      // llega a la plantilla por muy bien que lo mande el web — es exactamente lo que
      // pasó con cashier_name y costó tres rondas.
      tax_base: data.tax_base ?? null,
      itbis: data.itbis ?? null,
      discount_amount: data.discount_amount,
      discount_pct: data.discount_pct,
      payment_method: data.payment_method,
      // Recibido/Cambio: el ticket los muestra en cobros en efectivo (transparencia
      // del cobro en la puerta). En el camino automático son columnas de pos_orders;
      // aquí hay que listarlos o no llegan a la plantilla.
      cash_given: data.cash_given ?? null,
      card_amount: data.card_amount ?? null,
      change_amount: data.change_amount ?? null,
      created_at: data.date
    }
    const businessInfo = {
      name: data.business_name || store.get('businessName', 'Mi Negocio'),
      legalName: store.get('businessLegalName', ''),
      rnc: store.get('businessRnc', ''),
      ecfRnc: store.get('businessEcfRnc', ''),
      address: store.get('businessAddress', ''),
      currency: data.currency || store.get('businessCurrency', 'RD$'),
      itbisEnabled: store.get('businessItbisEnabled', false),
      showTaxBreakdown: store.get('businessShowTaxBreakdown', false)
    }
    console.log('[business] currency:', businessInfo.currency)
    // Ruteo por order_type: delivery/takeout usan la plantilla que desglosa
    // Subtotal + Envío + TOTAL; el resto (pos/mesa) sigue con el recibo POS.
    // Por la MISMA cola que los trabajos de realtime: si no, un recibo por HTTP y una
    // comanda por realtime podrían escribir a la vez en el mismo rollo e intercalarse.
    if (data.order_type === 'delivery' || data.order_type === 'takeout') {
      await encolar(printerCaja, () => printDeliveryTicket(order, printerCaja, businessInfo))
    } else {
      await encolar(printerCaja, () => printPOSReceipt(order, printerCaja, businessInfo))
    }
    return `Recibo impreso — Orden #${data.order_number}`
  }

  if (endpoint === 'print-fiscal') {
    data.currency = data.currency || store.get('businessCurrency', 'RD$')
    console.log('[business] currency:', data.currency)
    await encolar(printerCaja, () => printFiscalReceipt(data, printerCaja))
    return `Comprobante fiscal impreso — ${data.ncf || ''}`
  }

  if (endpoint === 'print-closing') {
    data.business_name = data.business_name || store.get('businessName', 'Mi Negocio')
    data.currency = data.currency || store.get('businessCurrency', 'RD$')
    console.log('[business] currency:', data.currency)
    await printClosingReport(data, printerCaja)
    return `Cierre de caja impreso — ${data.closing_id || data.closed_at || ''}`
  }

  // Inalcanzable por los dos transportes (ambos filtran contra la misma lista antes
  // de llegar aquí), pero un tercero futuro no puede colarse por defecto.
  throw new PrintJobError(`endpoint de impresión desconocido: ${endpoint}`, 404)
}

}

/**
 * Las COMANDAS de una orden nueva: la comida a la impresora de cocina y las bebidas a la de
 * barra (por `isDrink`, el ÚNICO criterio de estación). Si cocina y barra son la MISMA
 * impresora, sale una sola comanda con las dos secciones (`printTableComanda`).
 *
 * Devuelve el ARRAY de trabajos ya encolados, sin esperarlos (NO es async: quien llama lo
 * esparce con `...` y lo junta con el recibo; una Promesa ahí revienta el spread). Cada
 * trabajo va a la cola de SU impresora: cocina y barra no se esperan entre sí.
 *
 * @param {{ encolar: Function, estaActiva: (nombre: string) => boolean,
 *           printer: { printTableComanda: Function, printKitchenComanda: Function,
 *                      printBarComanda: Function, isDrink: (item: any) => boolean } }} deps
 */
function crearComandas({ encolar, estaActiva, printer }) {
  const { printTableComanda, printKitchenComanda, printBarComanda, isDrink } = printer
  return function imprimirComandas(order, { printerCocina, printerBar, businessInfo }) {
    const items = order.items || order.order_items || []
    const foodItems = items.filter(i => !isDrink(i))
    const drinkItems = items.filter(isDrink)
    const tableInfo = {
      table_number: order.table_number,
      table_label: order.table_label ?? (
        order.table_number
          ? `Mesa ${order.table_number}`
          : order.order_type === 'delivery'
            ? `Delivery${order.customer_name ? ' - ' + order.customer_name : ''}`
            : order.order_type === 'takeout'
              ? `Takeout${order.customer_name ? ' - ' + order.customer_name : ''}`
              : ''
      ),
      order_id: order.id
    }
    const trabajos = []
    if (printerCocina === printerBar) {
      if (estaActiva(printerCocina)) {
        trabajos.push(encolar(printerCocina,
          () => printTableComanda(order, printerCocina, businessInfo, tableInfo)))
      }
    } else {
      if (foodItems.length > 0 && estaActiva(printerCocina)) {
        trabajos.push(encolar(printerCocina,
          () => printKitchenComanda(foodItems, printerCocina, order, businessInfo, tableInfo)))
      }
      if (drinkItems.length > 0 && estaActiva(printerBar)) {
        trabajos.push(encolar(printerBar,
          () => printBarComanda(drinkItems, printerBar, order, businessInfo, tableInfo)))
      }
    }
    return trabajos
  }
}

module.exports = { PrintJobError, crearHandlePrintJob, crearComandas }
