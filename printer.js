const { printer: ThermalPrinter, types: PrinterTypes, BreakLine } = require('node-thermal-printer')
const { exec, spawn } = require('child_process')
const { promisify } = require('util')
const fs = require('fs')
const path = require('path')
const execAsync = promisify(exec)

// Método de pago TOLERANTE al desfase de versiones web↔bridge. Si el valor es un
// crudo conocido (cash/card/transfer/mixed) lo traduce; si NO lo reconoce (p.ej.
// ya viene en español desde un web nuevo, o un método futuro) lo imprime TAL CUAL.
// Nunca coacciona un valor real a "Efectivo" (eso imprimía dinero falso). Solo el
// vacío/ausente cae al default histórico.
function translatePaymentMethod(raw) {
  const v = (raw == null ? '' : String(raw)).trim()
  switch (v.toLowerCase()) {
    case 'cash':     return 'Efectivo'
    case 'card':     return 'Tarjeta'
    case 'transfer': return 'Transferencia'
    case 'mixed':    return 'Mixto'
    default:         return v || 'Efectivo'
  }
}

const Store = require('electron-store')
const store = new Store()
const { BrowserWindow, Notification } = require('electron')
const { ensureQueueHealthy } = require('./printQueue')

// Descartar trabajos encolados no puede ser silencioso: son ventas ya cobradas cuyo
// recibo no va a salir nunca. Va al log y a una notificación del sistema, porque quien
// tiene que enterarse está en la caja, no mirando la consola.
function logQueue(message) {
  console.warn(`[printQueue] ${message}`)
  try {
    new Notification({ title: 'TitiMenu — impresión', body: message }).show()
  } catch {}
}

const TEST_MODE = false
const os = require('os')
const TEST_FILE = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'titimenu-print-test.txt')
  : '/tmp/titimenu-print-test.txt'

const TEST_FILE_HTML = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'titimenu-print-test.html')
  : '/tmp/titimenu-print-test.html'

const TEST_PRINTER_NAME = 'TEST_MODE'

// ─── Test mode: write text to file and show notification ─────────────────────

function writeTestOutput(lines) {
  // Mismo saneo que el camino real: si el modo test no saneara, el careo mentiría.
  lines = lines.map(sanitizeForThermal)
  const separator = '\n' + '='.repeat(40) + '\n'
  const timestamp = `[${new Date().toLocaleString('es-DO')}]`
  const content = timestamp + '\n' + lines.join('\n') + '\n'

  // Append so multiple orders accumulate in the file
  fs.appendFileSync(TEST_FILE, separator + content)
}

function isTestMode(printerName) {
  return TEST_MODE || printerName === TEST_PRINTER_NAME
}

// ─── Printer discovery ────────────────────────────────────────────────────────

async function getUSBPrinters() {
  const printers = []
  const platform = process.platform

  try {
    if (platform === 'darwin') {
      const { stdout } = await execAsync("lpstat -p 2>/dev/null | awk '{print $2}' || echo ''")
      stdout.split('\n').forEach(name => {
        name = name.trim()
        if (name) printers.push({ name, displayName: name })
      })
    } else if (platform === 'win32') {
      const { stdout } = await execAsync('wmic printer get Name /format:list 2>nul')
      stdout.split('\n').forEach(line => {
        const name = line.replace(/^Name=/, '').trim()
        if (name) printers.push({ name, displayName: name })
      })
    } else {
      const { stdout } = await execAsync("lpstat -p 2>/dev/null | awk '{print $2}' || echo ''")
      stdout.split('\n').forEach(name => {
        name = name.trim()
        if (name) printers.push({ name, displayName: name })
      })
    }
  } catch (err) {
    console.error('Error listing printers:', err.message)
  }

  // Always append test mode option at the end
  printers.push({ name: TEST_PRINTER_NAME, displayName: 'Modo prueba (sin impresora)' })

  return printers
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function pad(str, len, right = false) {
  str = String(str || '')
  if (str.length >= len) return str.substring(0, len)
  const padding = ' '.repeat(len - str.length)
  return right ? padding + str : str + padding
}

/**
 * El ancho del papel térmico, en COLUMNAS, y las dos reglas que se dibujan con él.
 *
 * ## Por qué existe
 * Las plantillas térmicas tenían `const W = 32` a mano, y 32 columnas es papel de
 * **58 mm**. En un rollo de 80 mm el texto ocupaba dos tercios y los importes alineados
 * a la derecha caían en el medio: el `paperWidth` de la configuración no lo leía nadie en
 * esta rama (la de HTML sí, en `getReceiptStyles`).
 *
 * 48 columnas es fuente A en 80 mm (576 puntos de cabeza / 12 por carácter); 32 lo es en
 * 58 mm (384 / 12). `HALF` es el ancho de cada mitad para los renglones de
 * `pad(etiqueta, HALF) + pad(importe, HALF, true)`, que es como se alinea a la derecha.
 *
 * ## Por qué hace falta `explicito` y no basta `paperWidth`
 * El bridge **se autoactualiza solo en Windows**, así que un cambio de ancho le cambia el
 * papel a todos los negocios a la vez, sin que nadie lo pida. Y hasta la 2.1.0 TODOS
 * imprimían a 32 columnas pasara lo que pasara, así que el `paperWidth` guardado no
 * significa «elegí este ancho»: significa «esto es lo que tenía el desplegable».
 *
 * Peor: **`store.has('paperWidth')` no sirve para distinguirlo.** `save-config` escribe
 * siempre la clave con lo que manda el formulario, y el desplegable arranca en `80mm`,
 * así que cualquier negocio que haya guardado la configuración alguna vez —es decir,
 * todos, porque hay que guardar la impresora para usar el bridge— tiene `80mm` escrito
 * sin haberlo pensado nunca. La intención no quedó registrada en ninguna parte y no se
 * puede reconstruir hacia atrás.
 *
 * Por eso: **sin marca explícita, 32 columnas** —el comportamiento de siempre, idéntico
 * al que ese negocio ya conoce— y 48 sólo cuando `paperWidthExplicit` dice que alguien
 * pasó por la configuración y la guardó. Un negocio en 58 mm da 32 por los dos caminos,
 * así que para él nada cambia nunca.
 */
function anchoTermico(paperWidth, explicito) {
  const W = (explicito && paperWidth !== '58mm') ? 48 : 32
  return { W, HALF: W / 2, LINE: '='.repeat(W), DASH: '-'.repeat(W) }
}

/**
 * Un renglón de «concepto a la izquierda, importe a la derecha» que SIEMPRE cabe.
 *
 * ## Por qué no basta con rellenar de espacios
 * Las ocho plantillas hacían `left + ' '.repeat(Math.max(1, W - left - right)) + right`.
 * Ese `max(1, …)` garantiza un espacio de separación, pero **a cambio deja que el renglón
 * se pase del ancho**: con un nombre largo, 23 + 1 + 9 = 33 columnas en un papel de 32, y
 * la térmica envuelve el sobrante a la línea siguiente. El importe aparece solo en el
 * renglón de abajo, que en un documento fiscal se lee como otra cosa.
 *
 * Se vio midiendo los bytes reales de `1x Pizza Pepperoni Pers` + `RD$690.00`: 33
 * columnas. Es el mismo síntoma que la regla de `=` que se pasaba un carácter, y por eso
 * se arregla aquí y no en cada plantilla: **el importe no se recorta nunca y el concepto
 * cede el espacio**, porque un nombre a medias se entiende y un precio a medias, no.
 */
function renglonImporte(left, right, W) {
  const sitio = W - String(right).length - 1          // 1 columna de separación mínima
  const concepto = String(left).length > sitio ? String(left).slice(0, Math.max(0, sitio)) : String(left)
  const huecos = W - concepto.length - String(right).length
  return concepto + ' '.repeat(Math.max(1, huecos)) + right
}

/** El ancho que toca a ESTE equipo según su configuración guardada. */
function anchoTermicoDeLaConfig() {
  return anchoTermico(
    store.get('paperWidth', '80mm'),
    store.get('paperWidthExplicit', false),
  )
}

function center(str, width = 32) {
  str = String(str || '')
  if (str.length >= width) return str
  const total = width - str.length
  const left = Math.floor(total / 2)
  return ' '.repeat(left) + str
}

function formatDate(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatTime(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
}

// ── Desglose de ITBIS del recibo (opción del negocio, NO fiscal) ──────────────
// Devuelve las líneas a imprimir debajo del TOTAL, o [] si no toca.
//
// Prioridad: lo que MANDA EL WEB (tax_base + itbis del payload) gana siempre — el web es la
// fuente del dinero y este bridge solo imprime. El cálculo local es el respaldo del camino
// AUTOMÁTICO (realtime), donde la plantilla recibe la fila cruda de la BD y no hay payload:
// sin él, el mismo negocio vería el desglose en un recibo y no en el otro.
//
// La fórmula es la misma de TaxBreakdown (módulo compartido) y tip.ts (web): la propina se
// resta ANTES de dividir —la propina queda FUERA de la base imponible por la DGII— y el
// envío se queda dentro (Reglamento 293-11 art. 10). Los pedidos del POS y del menú no
// llevan propina, así que en la práctica el gravable es el total.
/**
 * Código QR nativo de la impresora: `GS ( k`, modelo 2, corrección M.
 *
 * ## Es una COPIA DELIBERADA de `EscPosCommands.qr` del módulo compartido Kotlin
 * Mismos bytes, mismos defaults (tamaño 5, ecc 50 = 'M'), mismo orden de instrucciones.
 * No se usa `printer.printQR()` de node-thermal-printer a propósito: sería una SEGUNDA
 * implementación con otros parámetros, y entonces el QR de la misma factura saldría
 * distinto según se imprimiera desde TitiStaff o desde aquí. Es exactamente la clase de
 * divergencia que el módulo compartido existe para impedir, y en un documento fiscal.
 * **Si se toca allá, se toca aquí.**
 *
 * El largo de la instrucción de datos (`fn=80`) es `pL + pH*256` y cuenta los datos
 * **MÁS 3 bytes** (cn, fn, m). Olvidar el +3 deja a la impresora esperando bytes que no
 * llegan.
 *
 * La URL va en UTF-8 sin sanear: son datos del QR, no texto que la impresora dibuje con
 * su code page. Sanearla cambiaría la URL y el QR apuntaría a otro sitio.
 */
function qrGsK(data, size = 5, ecc = 50) {
  const bytes = Buffer.from(String(data), 'utf8')
  const largo = bytes.length + 3
  const pL = largo % 256
  const pH = Math.floor(largo / 256)
  return Buffer.concat([
    Buffer.from([0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),            // modelo 2
    Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, size))]),
    Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, Math.min(51, Math.max(48, ecc))]),
    Buffer.from([0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30]),                      // datos
    bytes,
    Buffer.from([0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]),                  // imprimir
  ])
}

/**
 * Pone el QR en el papel TÉRMICO. Raster por defecto, nativo como opción.
 *
 * ## Por qué NO se usa `printer.raw()` — el bug que costó la 2.1.0
 * `raw()` de node-thermal-printer **no escribe en el buffer**: hace
 * `Interface.execute(bytes)` y los manda por su cuenta (`core.js:470`). Pero la ruta
 * USB/local de este bridge imprime con `getBuffer()` + `sendRawToPrinter()`, así que el
 * QR salía por una interfaz que en esa ruta es **un fichero temporal dummy** —el que
 * existe para que node-thermal-printer no deje ficheros en el directorio de trabajo— y
 * **nunca llegaba al papel**. Todo lo demás salía perfecto porque va al buffer.
 *
 * El modo de fallo es el peor: no hay error, no hay log, el papel sale completo y sólo
 * falta el QR. Se diagnosticó en un papel real de la 2.1.0 (E320000015515, 2Connect
 * POS80 por USB) y la pista falsa que lo retrasó fue la apariencia del papel: parecía
 * HTML del driver de Windows, pero las líneas `===` y el ancho corto son la huella de
 * ESTA rama. La leyenda lo confirmó: aquí dice «escaneando el QR» y el HTML dice
 * «escaneando el código QR».
 *
 * Por eso, para bytes crudos, **se usa `append()`, que sí bufferiza** (y acepta Buffer
 * sin pasarlo por el saneo de texto). `raw()` no se usa en ninguna parte.
 *
 * ## Por qué el raster es el default
 * `GS ( k` depende de que el firmware lo implemente, y una térmica que no lo soporta se
 * come la instrucción en silencio. El raster (`GS v 0`, vía `printImageBuffer`) lo dibuja
 * la impresora como cualquier imagen y funciona en cualquier modelo. El QR es el único
 * dato del papel que el cliente no puede teclear a mano, así que aquí pesa más
 * funcionar en todas que ser idéntico al byte con TitiStaff.
 *
 * Quien quiera el nativo —más nítido y más rápido— lo enciende con `qrNativo`. Ojo: la
 * app de Android sigue mandando `GS ( k` por Bluetooth, así que si una térmica no lo
 * soporta, allá el QR también falta; eso se arregla en el módulo compartido, no aquí.
 */
async function imprimirQrTermico(printer, url, paperWidth) {
  if (store.get('qrNativo', false)) {
    // `append`, NO `raw`: ver arriba.
    printer.append(qrGsK(url))
    return 'nativo'
  }
  try {
    const QRCode = require('qrcode')
    // La URL TAL CUAL: es la que la DGII firmó. 180 px en 58 mm (384 puntos de cabeza)
    // y 220 en 80 mm (576): legible por cualquier móvil sin comerse el rollo.
    const png = await QRCode.toBuffer(url, {
      margin: 1, errorCorrectionLevel: 'M', type: 'png',
      width: paperWidth === '58mm' ? 180 : 220,
    })
    await printer.printImageBuffer(png)   // appendea al buffer
    return 'raster'
  } catch (e) {
    // Degradar a nativo antes que rendirse: puede que esta impresora sí lo soporte.
    console.warn('[printer] QR raster falló, probando el nativo:', e.message)
    try {
      printer.append(qrGsK(url))
      return 'nativo-fallback'
    } catch (e2) {
      // Sin QR se imprime igual: el código de seguridad en texto permite la consulta
      // manual en el portal. Quedarse sin papel sería peor.
      console.warn('[printer] tampoco se pudo poner el QR nativo:', e2.message)
      return 'ninguno'
    }
  }
}

/**
 * Normaliza el payload fiscal: **la representación manda si viene**.
 *
 * ## Por qué hay dos caminos y no uno
 * El web manda desde octubre de 2026 un campo `representacion` con el documento que la
 * DGII certificó, y además sigue mandando los campos planos de siempre. Un bridge viejo
 * no sabe de `representacion` y sigue funcionando; éste la prefiere, y con ella saca QR,
 * código de seguridad y fecha de firma.
 *
 * Detalle que importa: los campos planos que manda el web ya vienen **rellenados desde la
 * representación**, no recalculados. Así que incluso por el camino viejo los números son
 * los del XML (932.21, no 932.20) y el envío aparece como línea. Lo único que se pierde
 * sin la representación es el sello.
 *
 * Los importes de la representación se escriben **tal cual, en texto**: son los del
 * documento legal. Aquí NO se hace `total / 1.18` ni ninguna otra cuenta — ése era el bug.
 */
function fiscalDesdeRepresentacion(data) {
  const rep = data && data.representacion ? data.representacion : null
  if (!rep) return null
  const t = rep.totales || {}
  const conQr = !!(rep.qr_url && rep.codigo_seguridad && rep.fecha_firma)
  // ⚠️ LOS CUATRO, y tienen que ser los mismos que en `EcfRepresentation.esRechazada`
  // (Kotlin) y en `esRechazada` de `src/lib/ecfRepresentacion.ts`. Aquí faltaba `anulado`,
  // así que una factura ANULADA —que tiene XML firmado perfectamente válido— se habría
  // impreso por este canal como si valiera, mientras el nativo y el web la bloqueaban. Si
  // la lista cambia en el servidor (`ecf_representacion_impresa`), cambia en los tres.
  //
  // Es una LISTA NEGRA a propósito, no una lista blanca de estados «buenos»: el estado que
  // se ve al imprimir es casi siempre `certificado` —el paso a `aceptado` tarda minutos,
  // hasta que el worker consulta a la DGII— y una lista blanca que se olvide de uno deja
  // de imprimir facturas válidas en silencio. Eso ya pasó con E320000015506.
  const rechazada = ['rechazado', 'rechazado_esquema', 'requiere_revision', 'anulado']
    .includes(rep.estado)
  return {
    rep,
    conQr,
    rechazada,
    titulo: rep.tipo_nombre || 'COMPROBANTE FISCAL',
    encf: rep.encf || '',
    emisorNombre: rep.emisor_nombre || rep.nombre_comercial || '',
    nombreComercial: rep.nombre_comercial || '',
    emisorRnc: rep.emisor_rnc || '',
    emisorDireccion: rep.emisor_direccion || '',
    fechaEmision: rep.fecha_emision || '',
    venceSecuencia: rep.vence_secuencia || '',
    compradorNombre: rep.comprador_nombre || '',
    compradorRnc: rep.comprador_rnc || '',
    lineas: (rep.lineas || []).map(l => ({
      // '1.00' se escribe '1': el XML siempre manda dos decimales y en 32 caracteres
      // son dos tirados por línea.
      cantidad: l.cantidad && String(l.cantidad).endsWith('.00')
        ? String(l.cantidad).slice(0, -3) : (l.cantidad || ''),
      nombre: l.nombre || '',
      descuento: l.descuento || '',
      monto: l.monto || '',
    })),
    gravado: t.gravado || '',
    itbis: t.itbis || '',
    exento: t.exento || '',
    propina: t.propina || '',
    total: t.total || '',
  }
}

/**
 * Los datos LOCALES de la venta, para el papel que sale ANTES de que la DGII firme.
 *
 * Cuando el comprobante no está certificado la representación trae sólo el estado, el eNCF
 * y el nombre del tipo: sin XML no hay emisor, ni líneas, ni totales. Con eso el papel
 * salía casi vacío y el cliente se iba sin saber qué compró.
 *
 * Lo mandan el web (`payloadFiscal`) y TitiStaff (`bridgeEcfJson`) con estas mismas
 * claves. **Sin base ni ITBIS a propósito**: los calcula la DGII por línea y sólo existen
 * en el XML — salen al reimprimir. Y nunca la leyenda del recibo normal: este papel SÍ es
 * un comprobante fiscal, lo que le falta es el sello.
 */
function respaldoFiscal(data) {
  const r = data && data.respaldo ? data.respaldo : null
  if (!r) return null
  return {
    negocioNombre: r.negocio_nombre || '',
    // El comercial va DEBAJO de la razón social y sólo si difiere, igual que en la factura
    // certificada: el XML trae los dos (RazonSocialEmisor y NombreComercial) y el papel
    // provisional tiene que parecerse al definitivo.
    negocioNombreComercial: r.negocio_nombre_comercial || '',
    // Ya viene RESUELTO por el cliente (`ecf_rnc` y, si es nulo, `rnc`): es el RNC que
    // EMITE el e-CF, el que va en RNCEmisor del XML y en el QR. El bridge no lo decide.
    negocioRnc: r.negocio_rnc || '',
    negocioDireccion: r.negocio_direccion || '',
    fecha: r.fecha || '',
    items: (r.items || []).map(i => ({
      name: i.name || '',
      qty: i.qty != null ? i.qty : 1,
      subtotal: i.subtotal != null ? i.subtotal : 0,
    })),
    envio: r.envio != null && r.envio > 0 ? r.envio : null,
    descuento: r.descuento != null && r.descuento > 0 ? r.descuento : null,
    total: r.total != null ? r.total : 0,
  }
}

function taxBreakdownLines(order, businessInfo, currency, total, HALF = 16) {
  let base = order.tax_base != null ? parseFloat(order.tax_base) : null
  let itbis = order.itbis != null ? parseFloat(order.itbis) : null

  if (base == null || itbis == null) {
    if (!businessInfo || !businessInfo.showTaxBreakdown || !businessInfo.itbisEnabled) return []
    const taxable = parseFloat(total || 0) - parseFloat(order.tip_amount || 0)
    if (!(taxable > 0)) return []
    base = Math.round((taxable / 1.18) * 100) / 100
    itbis = Math.round((taxable - base) * 100) / 100
  }
  if (!(itbis > 0)) return []
  return [
    '-'.repeat(32),
    'Incluye ITBIS 18%',
    pad('Base imponible:', HALF) + pad(`${currency}${formatMoney(base)}`, HALF, true),
    pad('ITBIS (18%):', HALF) + pad(`${currency}${formatMoney(itbis)}`, HALF, true),
  ]
}

// ── Saneo del texto que va a papel ───────────────────────────────────────────
// Espejo de `sanitizeForThermal` del módulo compartido (titimenu-escpos), para que el
// ticket del Electron y el de TitiPrint/Bluetooth salgan iguales.
//
// El bug: la hora salía "p.ám." / "p.?m.". El formateador de fecha en es-DO mete un espacio
// que NO es el espacio normal entre "p." y "m." — medido: U+00A0 en la JVM, U+202F en el ICU
// de Electron 28, y espacio normal en Node 24. Como es una codepage de 8 bits (acá
// PC858_EURO), U+00A0 se vuelve el byte 0xA0 —que la térmica dibuja como 'á'— y U+202F ni
// existe, así que sale '?'.
//
// Se ataca la CLASE de carácter y no un literal, porque cuál aparece depende de la versión
// de ICU del runtime: reemplazar solo U+202F se rompería en la próxima actualización.
const SPECIAL_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
const INVISIBLES = /[\u200B-\u200D\u2060\uFEFF]/g
const AM_PM = /\b([ap])\.\s*(m)\./gi

function sanitizeForThermal(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(SPECIAL_SPACES, ' ')
    .replace(INVISIBLES, '')
    // "p. m." → "p.m.": como se escribe en RD y ahorra dos caracteres de la línea.
    .replace(AM_PM, '$1.$2.')
}

function formatMoney(amount) {
  return parseFloat(amount || 0).toFixed(2)
}

function formatTableLabel(label) {
  if (!label) return '?'
  label = String(label).trim()
  if (/^mesa\s+/i.test(label)) {
    return label.toUpperCase()
  }
  if (/^\d+$/.test(label)) {
    return `MESA ${label}`
  }
  return label.toUpperCase()
}

// ─── Real printer factory ─────────────────────────────────────────────────────

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/

async function createPrinter(printerName) {
  console.log('[createPrinter] printerName recibido:', JSON.stringify(printerName))

  const instantiate = (iface) => {
    const p = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: iface,
      characterSet: 'PC858_EURO',
      removeSpecialCharacters: true,
      lineCharacter: '-',
      breakLine: BreakLine.WORD,
      options: { timeout: 5000 }
    })
    // Saneo en la FRONTERA: se envuelven los dos métodos que reciben texto, en la única
    // fábrica de impresoras. Así ninguna de las 7 plantillas tiene que acordarse de sanear
    // —ni las que se agreguen— y da igual de dónde venga la cadena.
    const wrap = (fn) => (t, ...rest) => fn.call(p, sanitizeForThermal(t), ...rest)
    p.println = wrap(p.println)
    p.print = wrap(p.print)
    return p
  }

  if (IP_RE.test(printerName.trim())) {
    const interfaceStr = `tcp://${printerName.trim()}:9100`
    return instantiate(interfaceStr)
  }

  // Local/USB printers: use a temporary dummy file to prevent node-thermal-printer from creating files in the working directory
  const dummyInterface = path.join(os.tmpdir(), `titimenu_spool_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.bin`)
  return instantiate(dummyInterface)
}

async function sendRawToPrinter(buffer, printerName) {
  console.log(`[sendRawToPrinter] Enviando ${buffer.length} bytes a la impresora: ${printerName}`)
  // Tope de la cola del sistema. Va aquí —en el punto donde el trabajo ENTRA al
  // spooler— y no en cada llamador, para que lo respeten los tres caminos por igual:
  // el realtime, el HTTP y el IPC del POS. Ver printQueue.js.
  await ensureQueueHealthy(printerName, logQueue)
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const tmp = path.join(os.tmpdir(), `titimenu_${Date.now()}.bin`)
      fs.writeFileSync(tmp, buffer)
      
      const ps = `
$printerName = "${printerName.replace(/"/g, '')}"
$filePath = "${tmp.replace(/\\/g, '\\\\')}"

Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static bool SendBytesToPrinter(string printerName, byte[] bytes) {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "TitiMenu Receipt";
        di.pDataType = "RAW";
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
        bool ok = false;
        if (StartDocPrinter(hPrinter, 1, ref di)) {
            if (StartPagePrinter(hPrinter)) {
                int written;
                ok = WritePrinter(hPrinter, bytes, bytes.Length, out written);
                EndPagePrinter(hPrinter);
            }
            EndDocPrinter(hPrinter);
        }
        ClosePrinter(hPrinter);
        return ok;
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($filePath)
$result = [RawPrinter]::SendBytesToPrinter($printerName, $bytes)
if ($result) { Write-Output "OK" } else { throw "WritePrinter failed" }
`
      const psFile = path.join(os.tmpdir(), `titimenu_ps_${Date.now()}.ps1`)
      fs.writeFileSync(psFile, ps)
      
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile
      ])
      let stderr = ''
      child.stderr.on('data', d => stderr += d.toString())
      child.on('close', code => {
        fs.unlink(tmp, () => {})
        fs.unlink(psFile, () => {})
        if (code === 0) resolve()
        else reject(new Error('PowerShell raw print failed: ' + stderr))
      })
      child.on('error', err => {
        fs.unlink(tmp, () => {})
        fs.unlink(psFile, () => {})
        reject(err)
      })
    })
  } else {
    // macOS / Linux: CUPS raw via lp
    return new Promise((resolve, reject) => {
      const lp = spawn('lp', ['-d', printerName, '-o', 'raw'])
      lp.on('close', code => code === 0 ? resolve() : reject(new Error('lp failed ' + code)))
      lp.on('error', reject)
      lp.stdin.write(buffer)
      lp.stdin.end()
    })
  }
}

// ─── HTML Silent Printing Engine & Templates ──────────────────────────────────

function getBaseHTML(styles, bodyContent) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${styles}
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`
}

function getReceiptStyles(paperWidth) {
  const is58 = paperWidth === '58mm'
  const width = is58 ? '48mm' : '72mm'
  const fontSize = is58 ? '10px' : '12px'
  const titleSize = is58 ? '13px' : '16px'
  const subTitleSize = is58 ? '11px' : '13px'

  return `
    @page { margin: 0; size: auto; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: ${fontSize};
      line-height: 1.4;
      color: #000;
      width: ${width};
      margin: 0 auto;
      padding: 4mm 1mm;
      box-sizing: border-box;
      background: #fff;
    }
    .center { text-align: center; }
    .right { text-align: right; }
    .bold { font-weight: bold; }
    .text-large { font-size: ${titleSize}; font-weight: bold; }
    .text-medium { font-size: ${subTitleSize}; font-weight: bold; }
    
    .divider {
      border-top: 1px dashed #000;
      margin: 6px 0;
    }
    .divider-double {
      border-top: 3px double #000;
      margin: 6px 0;
    }
    
    .header { margin-bottom: 8px; }
    .business-name { font-size: ${titleSize}; font-weight: bold; text-transform: uppercase; margin-bottom: 2px; }
    .business-details { color: #333; font-size: 0.95em; margin-bottom: 1px; }
    
    table { width: 100%; border-collapse: collapse; }
    .items-table th { border-bottom: 1px solid #000; padding: 3px 0; text-align: left; font-weight: bold; }
    .items-table td { padding: 4px 0; vertical-align: top; }
    .totals-table td { padding: 2px 0; }
    
    .footer { margin-top: 12px; font-size: 0.9em; color: #333; }
    .tag { display: inline-block; border: 1px solid #000; padding: 2px 6px; font-weight: bold; margin: 4px 0; border-radius: 3px; }
    .notes { font-style: italic; color: #555; font-size: 0.95em; margin-left: 8px; margin-top: 1px; }
    .comanda-section-header {
      background: #f0f0f0;
      text-align: center;
      font-weight: bold;
      padding: 3px 0;
      margin: 8px 0 4px;
      text-transform: uppercase;
      border-radius: 2px;
      border: 1px solid #ccc;
      font-size: 0.95em;
    }
    .delivery-box {
      border: 1px solid #000;
      padding: 6px;
      margin-top: 8px;
      border-radius: 4px;
      font-size: 0.95em;
    }
    .delivery-box div { margin-bottom: 2px; }
  `
}

async function printHTML(htmlContent, printerName) {
  if (isTestMode(printerName)) {
    const separator = '\n' + '='.repeat(40) + '\n'
    const timestamp = `[${new Date().toLocaleString('es-DO')}] [MODO SISTEMA HTML]`
    fs.appendFileSync(TEST_FILE_HTML, separator + timestamp + '\n' + htmlContent + '\n')
    
    const cleanText = htmlContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, '\n')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    writeTestOutput(['--- SIMULACIÓN MODO SISTEMA ---', ...cleanText])
    return
  }

  // El otro punto de entrada al spooler (modo "sistema"/driver). Va DESPUÉS del modo
  // test, que no toca ninguna cola real.
  await ensureQueueHealthy(printerName, logQueue)

  return new Promise((resolve, reject) => {
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))

    printWindow.webContents.on('did-finish-load', () => {
      const printDelay = process.platform === 'win32' ? 2000 : 800
      console.log(`[printer] HTML loaded. Waiting ${printDelay}ms before printing...`)
      
      setTimeout(() => {
        const device = printerName === TEST_PRINTER_NAME ? '' : printerName
        console.log(`[printer] Sending HTML to printer: ${device}`)
        
        printWindow.webContents.print({
          silent: true,
          printBackground: true,
          deviceName: device,
          margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 },
          pageSize: { width: 80000, height: 297000 } // 80mm en microns
        }, (success, errorType) => {
          console.log('[printer] Print result:', success, errorType)
          // NO cerrar la ventana hasta que el callback confirme que la impresión fue enviada
          setTimeout(() => {
            printWindow.destroy()
            if (success) {
              resolve()
            } else {
              reject(new Error(`Fallo al imprimir vía sistema: ${errorType}`))
            }
          }, 500)
        })
      }, printDelay)
    })

    printWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      printWindow.destroy()
      reject(new Error(`Fallo al cargar plantilla: ${errorDescription}`))
    })
  })
}

function generatePOSReceiptHTML(order, businessInfo, paperWidth) {
  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''
  const currency = info.currency || store.get('businessCurrency', 'RD$')
  
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const items = order.items || order.order_items || []
  const total = parseFloat(order.total || order.total_amount || 0)
  const tip = parseFloat(order.tip_amount || 0)
  const hasTip = tip > 0
  const discount = parseFloat(order.discount_amount || 0)
  const hasDiscount = discount > 0
  // El envío entra al desglose: sin su línea, el TOTAL de un delivery del POS no
  // se puede verificar sumando lo impreso.
  const deliveryFee = Number(order.delivery_fee || 0)
  const hasDeliveryFee = deliveryFee > 0
  const showBreakdown = hasTip || hasDiscount || hasDeliveryFee
  const subtotal = showBreakdown
    ? parseFloat(order.subtotal || (total + discount - tip - deliveryFee))
    : 0
  const tipPct = hasTip && order.tip_pct ? parseFloat(order.tip_pct) : null
  const tipLabel = tipPct ? `Propina (${tipPct}%):` : 'Propina:'
  const discountPct = hasDiscount && order.discount_pct ? parseFloat(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  const payMethod = translatePaymentMethod(order.payment_method)
  // Recibido / Cambio: solo en efectivo con recibido > 0 (mismo criterio que la
  // ruta térmica y que TitiPrint, que compara el método CRUDO).
  const rawMethod = (order.payment_method || '').toString().trim().toLowerCase()
  const cashGiven = Number(order.cash_given || 0)
  const changeGiven = Number(order.change_amount || 0)
  const showCashLines = rawMethod === 'cash' && cashGiven > 0
  // ── Datos del cliente (delivery/takeout hechos DESDE EL POS) ──────────────
  // El payload ya los mandaba; esta plantilla no los leía, así que un delivery
  // del POS salía sin nombre ni dirección mientras el del menú digital (que rutea
  // a printDeliveryTicket) sí los imprimía. MISMAS claves que esa plantilla.
  //
  // OJO: la dirección del cliente sale SOLO de `customer_address`. NUNCA de `address`,
  // que en el payload es la dirección del NEGOCIO (encabezado): usarla imprimiría la
  // dirección del local como si fuera la del cliente. Ese fallback existió en la
  // plantilla del delivery y se eliminó — no lo reintroduzcas en ninguna.
  const customerName = order.customer_name || order.client_name || null
  const customerPhone = order.customer_phone || order.phone || order.tel || null
  // customer_address = "dirección legible\nhttps://maps...": en papel la URL es
  // inútil, se imprime solo la parte antes del salto. Misma regla que
  // printDeliveryTicket y que TicketBuilder de TitiPrint. No se trunca: la
  // térmica envuelve la línea larga sola.
  const rawCustomerAddr = order.customer_address || order.delivery_address || ''
  const customerAddr = String(rawCustomerAddr).split('\n')[0].trim()
  const hasCustomer = !!(customerName || customerPhone || customerAddr)
  const orderNotes = (order.notes || '').toString().trim()
  // Cajero que atendió la venta. Paridad con TitiPrint, que ya lo imprime.
  const cashierName = order.cashier_name || null
  // `!= null` y NO `||`: el cero es falsy en JavaScript, así que un `order_number = 0`
  // —un número perfectamente válido— caía al fragmento hexadecimal del id y el cliente
  // recibía "POS #4b5c6d" en vez de "POS #0". Se detectó al poner a un negocio a arrancar
  // su numeración desde cero. El id sigue como respaldo para cuando de verdad no hay número.
  const posNum = order.order_number != null ? order.order_number : (order.id?.slice(-6) || '000')
  const displayLabel = order.table_label 
    ? order.table_label 
    : order.table_number 
      ? `Mesa ${order.table_number}` 
      : order.order_number != null
        ? `POS #${order.order_number}` 
        : 'POS'

  let itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const unitPrice = item.unit_price || item.price || 0
    const itemTotal = unitPrice * qty
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">${currency}${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  let breakdownHtml = ''
  if (showBreakdown) {
    breakdownHtml = `
      <tr>
        <td>SUBTOTAL:</td>
        <td class="right">${currency}${formatMoney(subtotal)}</td>
      </tr>
      ${hasDiscount ? `
      <tr>
        <td>${discountLabel}</td>
        <td class="right">-${currency}${formatMoney(discount)}</td>
      </tr>` : ''}
      ${hasDeliveryFee ? `
      <tr>
        <td>Envio:</td>
        <td class="right">${currency}${formatMoney(deliveryFee)}</td>
      </tr>` : ''}
      ${hasTip ? `
      <tr>
        <td>${tipLabel}</td>
        <td class="right">+${currency}${formatMoney(tip)}</td>
      </tr>` : ''}
    `
  }

  const bodyContent = `
    <div class="header center">
      <div class="business-name">${bizName}</div>
      ${legalName ? `<div class="business-details">${legalName}</div>` : ''}
      ${rnc ? `<div class="business-details">RNC: ${rnc}</div>` : ''}
      ${address ? `<div class="business-details">${address}</div>` : ''}
      <div class="tag">** ${displayLabel} **</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
      ${cashierName ? `<div class="business-details">Cajero/a: ${cashierName}</div>` : ''}
    </div>

    <div class="divider"></div>

    ${hasCustomer ? `
    <div>
      ${customerName ? `<div>Cliente: ${customerName}</div>` : ''}
      ${customerPhone ? `<div>Tel: ${customerPhone}</div>` : ''}
      ${customerAddr ? `<div>Dir: ${customerAddr}</div>` : ''}
    </div>
    <div class="divider"></div>` : ''}
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        ${breakdownHtml}
        <tr class="bold text-medium">
          <td>TOTAL:</td>
          <td class="right">${currency}${formatMoney(total)}</td>
        </tr>
        <tr>
          <td style="padding-top: 6px;">Pago: ${payMethod}${showCashLines ? `<br>Recibido: ${currency}${formatMoney(cashGiven)}${changeGiven > 0 ? `<br><b>Cambio: ${currency}${formatMoney(changeGiven)}</b>` : ''}` : ''}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
    
    <div class="divider-double"></div>
    
    <div class="footer center">
      ¡Gracias por su visita!
      <div>Este documento no es un comprobante fiscal</div>
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateTableComandaHTML(order, businessName, paperWidth, tableInfo = {}) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = tableInfo?.table_label || order.table_label || tableInfo?.table_number || order.table_number || order.table_id || '?'
  const shortId = (tableInfo?.order_id || order.id || '000000').slice(-6).toUpperCase()
  const items = order.items || order.order_items || []
  // `isDrink` es el MISMO criterio que usa main.js para elegir impresora. Antes filtraba
  // por i.bar/i.category/i.station —ninguno existe en los ítems reales— así que barItems
  // salía vacío siempre y los tragos se imprimían como comida.
  const kitchenItems = items.filter(i => !isDrink(i))
  const barItems = items.filter(isDrink)
  const allItems = kitchenItems.length === 0 && barItems.length === 0 ? items : []

  function renderItemsList(itemList) {
    return itemList.map(item => {
      const qty = item.quantity || item.qty || 1
      const name = item.name || item.product_name || ''
      const notes = item.notes || item.special_instructions || ''
      return `
        <div style="padding: 3px 0;">
          <span class="bold">${qty}x</span> ${name}
          ${notes ? `<div class="notes">* ${notes}</div>` : ''}
        </div>
      `
    }).join('')
  }

  let sectionsHtml = ''
  if (kitchenItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Cocina</div>
      <div>${renderItemsList(kitchenItems)}</div>
    `
  }
  if (barItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Bar</div>
      <div>${renderItemsList(barItems)}</div>
    `
  }
  if (allItems.length > 0) {
    sectionsHtml += `
      <div class="comanda-section-header">Items</div>
      <div>${renderItemsList(allItems)}</div>
    `
  }

  const bodyContent = `
    <div class="header center">
      <div class="text-large">** COMANDA **</div>
      <div class="tag" style="font-size: 1.15em;">${formatTableLabel(tableLabel)}</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    ${noteHtml(order.notes)}
    <div class="divider"></div>
    
    <div>
      ${sectionsHtml}
    </div>
    
    <div class="divider-double"></div>
    
    <div class="footer center bold">
      Orden #${shortId}
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateDeliveryTicketHTML(order, businessInfo, paperWidth) {
  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const currency = info.currency || store.get('businessCurrency', 'RD$')
  // Mismo encabezado que el recibo del POS: este papel se va con la comida a casa del
  // cliente y sin él no dice de qué negocio salió.
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const typeLabel = (order.order_type || 'delivery').toUpperCase()
  const customerName = order.customer_name || order.client_name || 'Cliente'
  const customerPhone = order.customer_phone || order.phone || order.tel || 'N/A'
  const items = order.items || order.order_items || []
  const subtotal = Number(order.subtotal || 0)
  const deliveryFee = Number(order.delivery_fee || 0)
  // El descuento (cupón) aplica SOLO al subtotal; el envío nunca se descuenta.
  // Antes se ignoraba → el ticket cobraba de más. TOTAL = subtotal − descuento + envío.
  const discount = Number(order.discount_amount || 0)
  const hasDiscount = discount > 0
  const discountPct = hasDiscount && order.discount_pct ? Number(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  const total = subtotal - discount + deliveryFee

  let itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const unitPrice = item.unit_price || item.price || 0
    const itemTotal = unitPrice * qty
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">${currency}${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="business-name">${bizName}</div>
      ${legalName ? `<div class="business-details">${legalName}</div>` : ''}
      ${rnc ? `<div class="business-details">RNC: ${rnc}</div>` : ''}
      ${address ? `<div class="business-details">${address}</div>` : ''}
      <div class="text-large">** ${typeLabel} **</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <div style="margin-bottom: 6px;">
      <div><span class="bold">Cliente:</span> ${customerName}</div>
      <div><span class="bold">Teléfono:</span> ${customerPhone}</div>
    </div>
    
    <div class="divider"></div>
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        ${(deliveryFee > 0 || hasDiscount) ? `
        <tr>
          <td>Subtotal:</td>
          <td class="right">${currency}${formatMoney(subtotal)}</td>
        </tr>
        ${hasDiscount ? `
        <tr>
          <td>${discountLabel}</td>
          <td class="right">-${currency}${formatMoney(discount)}</td>
        </tr>` : ''}
        ${deliveryFee > 0 ? `
        <tr>
          <td>Envío:</td>
          <td class="right">${currency}${formatMoney(deliveryFee)}</td>
        </tr>` : ''}` : ''}
        <tr class="bold text-medium">
          <td>TOTAL:</td>
          <td class="right">${currency}${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>
    
    ${address ? `
      <div class="delivery-box">
        <div class="bold" style="border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 4px;">DIRECCIÓN DE ENVÍO:</div>
        <div>${address}</div>
      </div>
    ` : ''}
    
    <div class="divider-double"></div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

async function generateFiscalReceiptHTML(data, paperWidth) {
  // ── CAMINO NUEVO: la representación del e-CF certificado ─────────────────
  // Mismo contenido y mismo orden que la rama térmica de `printFiscalReceipt` y que
  // `TicketBuilder.buildEcf` del módulo compartido: los tres pintan la misma
  // representación, así que el papel dice lo mismo salga por donde salga.
  const F = fiscalDesdeRepresentacion(data)
  if (F) {
    if (F.rechazada) {
      throw new Error('La DGII no aceptó este comprobante: no se puede imprimir como factura fiscal')
    }
    const cur = data.currency || store.get('businessCurrency', 'RD$')
    // El QR como <img> en base64. `qrcode` se carga aquí y no arriba: sólo lo necesita
    // este camino, y es el único del bridge que lo usa.
    let qrImg = ''
    if (F.conQr) {
      try {
        const QRCode = require('qrcode')
        // La URL TAL CUAL: es la que la DGII firmó.
        const url = await QRCode.toDataURL(F.rep.qr_url, {
          margin: 1, errorCorrectionLevel: 'M', width: 150,
        })
        qrImg = `<img src="${url}" style="width:150px;height:150px;" alt="QR DGII">`
      } catch (e) {
        // Sin QR se imprime igual: el código de seguridad en texto permite la consulta
        // manual en el portal. Quedarse sin papel sería peor.
        console.warn('[printer] no se pudo generar el QR:', e.message)
      }
    }

    const R = respaldoFiscal(data)
    // Sin XML todavía: el cuerpo se arma con los datos de la venta. Ver `respaldoFiscal`.
    const soloRespaldo = F.lineas.length === 0 && !F.total && !!R
    const bodyRep = `
    <div class="header center">
      <div class="business-name">${F.emisorNombre || (R ? R.negocioNombre : '')}</div>
      ${(() => {
        const razon = F.emisorNombre || (R ? R.negocioNombre : '')
        const comercial = F.nombreComercial || (R ? R.negocioNombreComercial : '')
        return comercial && comercial !== razon
          ? `<div class="business-details">${comercial}</div>` : ''
      })()}
      ${(F.emisorRnc || (R ? R.negocioRnc : '')) ? `<div class="business-details">RNC: ${F.emisorRnc || R.negocioRnc}</div>` : ''}
      ${(F.emisorDireccion || (R ? R.negocioDireccion : '')) ? `<div class="business-details">${F.emisorDireccion || R.negocioDireccion}</div>` : ''}
      <div class="divider" style="margin: 8px 0 4px;"></div>
      <div class="bold" style="font-size: 1.1em;">${F.titulo}</div>
      <div class="tag" style="font-size: 1.15em; margin: 3px 0;">${F.encf}</div>
    </div>
    <div class="divider"></div>
    <table class="totals-table"><tbody>
      ${(F.fechaEmision || (R ? R.fecha : '')) ? `<tr><td>Fecha emisión:</td><td class="right">${F.fechaEmision || R.fecha}</td></tr>` : ''}
      ${F.venceSecuencia ? `<tr><td>Vence secuencia:</td><td class="right">${F.venceSecuencia}</td></tr>` : ''}
      ${F.compradorNombre ? `<tr><td>Cliente:</td><td class="right">${F.compradorNombre}</td></tr>` : ''}
      ${F.compradorRnc ? `<tr><td>RNC/Cédula:</td><td class="right">${F.compradorRnc}</td></tr>` : ''}
    </tbody></table>
    <div class="divider"></div>
    <table class="items-table">
      <thead><tr><th>Descripción</th><th class="right">Total</th></tr></thead>
      <tbody>
        ${soloRespaldo ? R.items.map(i => `
        <tr><td>${i.qty}x ${i.name}</td><td class="right">${cur}${formatMoney(i.subtotal)}</td></tr>`).join('') : ''}
        ${F.lineas.map(l => `
        <tr>
          <td>${l.cantidad ? `${l.cantidad}x ` : ''}${l.nombre}</td>
          <td class="right">${cur}${l.monto}</td>
        </tr>` + (l.descuento ? `
        <tr><td style="padding-left:10px;">Descuento</td>
            <td class="right">-${cur}${l.descuento}</td></tr>` : '')).join('')}
      </tbody>
    </table>
    <div class="divider"></div>
    <table class="totals-table"><tbody>
      ${soloRespaldo && R.descuento ? `<tr><td>Descuento:</td><td class="right">-${cur}${formatMoney(R.descuento)}</td></tr>` : ''}
      ${soloRespaldo && R.envio ? `<tr><td>Envío:</td><td class="right">${cur}${formatMoney(R.envio)}</td></tr>` : ''}
      ${F.gravado ? `<tr><td>Base Imponible:</td><td class="right">${cur}${F.gravado}</td></tr>` : ''}
      ${F.itbis ? `<tr><td>ITBIS (18%):</td><td class="right">${cur}${F.itbis}</td></tr>` : ''}
      ${F.exento ? `<tr><td>Monto exento:</td><td class="right">${cur}${F.exento}</td></tr>` : ''}
      ${F.propina ? `<tr><td>Propina legal (10%):</td><td class="right">+${cur}${F.propina}</td></tr>` : ''}
      <tr class="bold text-medium" style="border-top: 1px solid #000;">
        <td style="padding-top: 4px;">TOTAL:</td>
        <td class="right" style="padding-top: 4px;">${soloRespaldo ? cur + formatMoney(R.total) : cur + F.total}</td>
      </tr>
    </tbody></table>
    <div class="divider-double"></div>
    <div class="footer center">
      ${F.conQr ? `
        <div class="business-details">Código de seguridad: ${F.rep.codigo_seguridad}</div>
        <div class="business-details">Fecha de firma: ${F.rep.fecha_firma}</div>
        <div style="margin:8px 0;">${qrImg}</div>
        <div class="business-details">Consulte este comprobante en la<br>DGII escaneando el código QR</div>
      ` : `
        <div class="bold">Comprobante en proceso de<br>validación ante la DGII</div>
      `}
      <div style="margin-top:6px;">¡Gracias por su visita!</div>
    </div>
  `
    return getBaseHTML(getReceiptStyles(paperWidth), bodyRep)
  }

  // ── CAMINO VIEJO: payload sin `representacion` ───────────────────────────
  const bizName = data.business_name || 'MI NEGOCIO'
  const legalName = data.legal_name || ''
  const rnc = data.rnc || ''
  const address = data.address || ''
  const ncf = data.ncf || ''
  const ncfType = data.ncf_type || 'B02'
  const ncfLabel = ncfType === 'B01' ? 'Crédito Fiscal' : 'Consumidor Final'
  const items = data.items || []
  const subtotal = parseFloat(data.subtotal || 0)
  const itbis = parseFloat(data.itbis || 0)
  const total = parseFloat(data.total || 0)
  const tip = parseFloat(data.tip_amount || 0)
  const hasTip = tip > 0
  const currency = data.currency || store.get('businessCurrency', 'RD$')
  const dateStr = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })

  let itemsHtml = items.map(item => {
    const qty = item.qty || 1
    const name = item.name || ''
    const unitPrice = item.price || 0
    const itemTotal = item.subtotal || (unitPrice * qty)
    return `
      <tr>
        <td>${qty}x ${name}</td>
        <td class="right">${currency}${formatMoney(itemTotal)}</td>
      </tr>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="business-name">${bizName}</div>
      ${legalName ? `<div class="business-details">${legalName}</div>` : ''}
      <div class="business-details">RNC: ${rnc}</div>
      ${address ? `<div class="business-details">${address}</div>` : ''}
      
      <div class="divider" style="margin: 8px 0 4px;"></div>
      <div class="bold" style="font-size: 1.1em; text-transform: uppercase;">Comprobante Fiscal</div>
      <div class="tag" style="font-size: 1.15em; margin: 3px 0;">${ncf}</div>
      <div class="business-details bold">${ncfLabel}</div>
      <div class="business-details" style="margin-top: 3px;">Fecha: ${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    
    <table class="items-table">
      <thead>
        <tr>
          <th>Descripción</th>
          <th class="right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
      </tbody>
    </table>
    
    <div class="divider"></div>
    
    <table class="totals-table">
      <tbody>
        <tr>
          <td>Base Imponible:</td>
          <td class="right">${currency}${formatMoney(subtotal)}</td>
        </tr>
        <tr>
          <td>ITBIS (18%):</td>
          <td class="right">+${currency}${formatMoney(itbis)}</td>
        </tr>
        ${hasTip ? `
        <tr>
          <td>Propina:</td>
          <td class="right">+${currency}${formatMoney(tip)}</td>
        </tr>` : ''}
        <tr class="bold text-medium" style="border-top: 1px solid #000;">
          <td style="padding-top: 4px;">TOTAL:</td>
          <td class="right" style="padding-top: 4px;">${currency}${formatMoney(total)}</td>
        </tr>
      </tbody>
    </table>
    
    ${data.client_name ? `
      <div class="delivery-box" style="margin-top: 10px;">
        <div><span class="bold">Cliente:</span> ${data.client_name}</div>
        ${data.client_rnc ? `<div><span class="bold">RNC:</span> ${data.client_rnc}</div>` : ''}
      </div>
    ` : ''}
    
    <div class="divider-double"></div>
    
    <div class="footer center">
      ¡Gracias por su visita!
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

function generateTestReceiptHTML(businessName, paperWidth) {
  const dateStr = new Date().toLocaleString('es-DO')
  const bodyContent = `
    <div class="header center">
      <div class="text-large">TitiMenu</div>
      <div class="business-name" style="margin-top: 4px;">${businessName || 'Mi Negocio'}</div>
      <div class="tag">PÁGINA DE PRUEBA</div>
      <div class="business-details" style="margin-top: 6px;">${dateStr}</div>
    </div>
    
    <div class="divider"></div>
    <div class="center" style="padding: 10px 0;">
      <span class="bold">¡Impresora configurada OK!</span><br>
      El modo de impresión por sistema (HTML) funciona correctamente en tu impresora.
    </div>
    <div class="divider-double"></div>
  `
  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

// ─── POS Receipt ──────────────────────────────────────────────────────────────

async function printPOSReceipt(order, printerName, businessInfo) {
  const cur = businessInfo?.currency || order?.currency || store.get('businessCurrency', 'RD$')
  console.log('[printer] Using currency:', cur)

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generatePOSReceiptHTML(order, businessInfo, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''
  const currency = cur

  const { W, HALF, LINE, DASH } = anchoTermicoDeLaConfig()
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const items = order.items || order.order_items || []
  const total = parseFloat(order.total || order.total_amount || 0)
  const tip = parseFloat(order.tip_amount || 0)
  const hasTip = tip > 0
  const discount = parseFloat(order.discount_amount || 0)
  const hasDiscount = discount > 0
  // El envío entra al desglose: sin su línea, el TOTAL de un delivery del POS no
  // se puede verificar sumando lo impreso. Declarado ANTES de showBreakdown.
  const deliveryFee = Number(order.delivery_fee || 0)
  const hasDeliveryFee = deliveryFee > 0
  const showBreakdown = hasTip || hasDiscount || hasDeliveryFee
  const subtotal = showBreakdown
    ? parseFloat(order.subtotal || (total + discount - tip - deliveryFee))
    : 0
  const tipPct = hasTip && order.tip_pct ? parseFloat(order.tip_pct) : null
  const tipLabel = tipPct ? `Propina (${tipPct}%):` : 'Propina:'
  const discountPct = hasDiscount && order.discount_pct ? parseFloat(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  // ── Datos del cliente (delivery/takeout hechos DESDE EL POS) ──────────────
  // El payload ya los mandaba; esta plantilla no los leía, así que un delivery del
  // POS salía sin nombre ni dirección mientras el del menú digital (que rutea a
  // printDeliveryTicket) sí los imprimía. MISMAS claves que esa plantilla.
  //
  // OJO: la dirección del cliente sale SOLO de `customer_address`. NUNCA de `address`,
  // que en el payload es la dirección del NEGOCIO (encabezado): usarla imprimiría la
  // dirección del local como si fuera la del cliente. Ese fallback existió en la
  // plantilla del delivery y se eliminó — no lo reintroduzcas en ninguna.
  const customerName = order.customer_name || order.client_name || null
  const customerPhone = order.customer_phone || order.phone || order.tel || null
  // customer_address = "dirección legible\nhttps://maps...": en papel la URL es
  // inútil, se imprime solo la parte antes del salto. Misma regla que
  // printDeliveryTicket y que TicketBuilder de TitiPrint. No se trunca: la térmica
  // envuelve la línea larga sola.
  const rawCustomerAddr = order.customer_address || order.delivery_address || ''
  const customerAddr = String(rawCustomerAddr).split('\n')[0].trim()
  const hasCustomer = !!(customerName || customerPhone || customerAddr)
  const orderNotes = (order.notes || '').toString().trim()
  // Cajero que atendió la venta. Paridad con TitiPrint, que ya lo imprime.
  const cashierName = order.cashier_name || null
  const payMethod = translatePaymentMethod(order.payment_method)
  // Recibido / Cambio: SOLO en efectivo con recibido > 0, igual que TitiPrint (que
  // compara el método CRUDO, no el traducido). En tarjeta no aplica; en mixto tampoco
  // se imprimen, para no divergir del otro bridge.
  const rawMethod = (order.payment_method || '').toString().trim().toLowerCase()
  const cashGiven = Number(order.cash_given || 0)
  const changeGiven = Number(order.change_amount || 0)
  const showCashLines = rawMethod === 'cash' && cashGiven > 0
  // `!= null` y NO `||`: el cero es falsy en JavaScript, así que un `order_number = 0`
  // —un número perfectamente válido— caía al fragmento hexadecimal del id y el cliente
  // recibía "POS #4b5c6d" en vez de "POS #0". Se detectó al poner a un negocio a arrancar
  // su numeración desde cero. El id sigue como respaldo para cuando de verdad no hay número.
  const posNum = order.order_number != null ? order.order_number : (order.id?.slice(-6) || '000')
  // Distintivo del encabezado. Con `table_label` (camino HTTP: el web lo manda ya
  // armado) se usa tal cual; el camino AUTOMÁTICO (realtime de pos_orders) NO tiene
  // esa columna, así que el label se arma aquí desde order_type + customer_name —
  // si no, un delivery del POS salía como "POS #78" y el ticket no se distinguía de
  // una venta de mostrador. ASCII y en mayúsculas, igual que TitiPrint y el web:
  // las ESC/POS imprimen los emojis como "??".
  const typeLabel = (() => {
    const t = (order.order_type || '').toLowerCase()
    if (t !== 'delivery' && t !== 'takeout') return null
    const who = order.customer_name ? ` - ${order.customer_name}` : ''
    return `${t.toUpperCase()}${who}`
  })()
  const displayLabel = order.table_label
    ? order.table_label
    : typeLabel
      ? typeLabel
      : order.table_number
        ? `Mesa ${order.table_number}`
        : order.order_number != null
          ? `POS #${order.order_number}`
          : 'POS'

  const lines = [
    LINE,
    center(bizName, W),
    ...(legalName ? [center(legalName, W)] : []),
    ...(rnc ? [center(`RNC: ${rnc}`, W)] : []),
    ...(address ? [center(address, W)] : []),
    center(`** ${displayLabel} **`, W),
    center(dateStr, W),
    ...(cashierName ? [center(`Cajero/a: ${cashierName}`, W)] : []),
    LINE,
    // Bloque del cliente: SOLO si vino en el payload. Una venta de mostrador
    // (sin customer_*) imprime exactamente igual que antes.
    ...(hasCustomer ? [
      ...(customerName ? [`Cliente: ${customerName}`] : []),
      ...(customerPhone ? [`Tel: ${customerPhone}`] : []),
      ...(customerAddr ? [`Dir: ${customerAddr}`] : []),
      DASH,
    ] : []),
    ...items.map(item => {
      const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
      const right = `${currency}${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
      return renglonImporte(left, right, W)
    }),
    DASH,
    ...(showBreakdown ? [
      pad('SUBTOTAL:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true),
      ...(hasDiscount ? [pad(discountLabel, HALF) + pad(`-${currency}${formatMoney(discount)}`, HALF, true)] : []),
      ...(hasDeliveryFee ? [pad('Envio:', HALF) + pad(`${currency}${formatMoney(deliveryFee)}`, HALF, true)] : []),
      ...(hasTip ? [pad(tipLabel, HALF) + pad(`+${currency}${formatMoney(tip)}`, HALF, true)] : []),
    ] : []),
    pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true),
    ...taxBreakdownLines(order, businessInfo, currency, total, HALF),
    `Pago: ${payMethod}`,
    ...(showCashLines ? [pad('Recibido:', HALF) + pad(`${currency}${formatMoney(cashGiven)}`, HALF, true)] : []),
    ...(showCashLines && changeGiven > 0 ? [pad('Cambio:', HALF) + pad(`${currency}${formatMoney(changeGiven)}`, HALF, true)] : []),
    ...(orderNotes ? [`Nota: ${orderNotes}`] : []),
    LINE,
    center('¡Gracias por su visita!', W),
    // No es un comprobante fiscal: el que lo es lleva eNCF y lo imprime
    // printFiscalReceipt, donde esta línea NO debe aparecer.
    center('Este documento no es un', W),
    center('comprobante fiscal', W),
    LINE,
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.println(bizName)
  if (legalName) printer.println(legalName)
  if (rnc) printer.println(`RNC: ${rnc}`)
  if (address) printer.println(address)
  printer.println(`** ${displayLabel} **`)
  printer.println(dateStr)
  if (cashierName) printer.println(`Cajero/a: ${cashierName}`)
  printer.println(LINE)
  printer.alignLeft()
  // Bloque del cliente: SOLO si vino en el payload (cero regresión en mostrador).
  if (hasCustomer) {
    if (customerName) printer.println(`Cliente: ${customerName}`)
    if (customerPhone) printer.println(`Tel: ${customerPhone}`)
    if (customerAddr) printer.println(`Dir: ${customerAddr}`)
    printer.println(DASH)
  }
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `${currency}${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    printer.println(renglonImporte(left, right, W))
  })
  printer.println(DASH)
  if (showBreakdown) {
    printer.println(pad('SUBTOTAL:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true))
    if (hasDiscount) printer.println(pad(discountLabel, HALF) + pad(`-${currency}${formatMoney(discount)}`, HALF, true))
    if (hasDeliveryFee) printer.println(pad('Envio:', HALF) + pad(`${currency}${formatMoney(deliveryFee)}`, HALF, true))
    if (hasTip) printer.println(pad(tipLabel, HALF) + pad(`+${currency}${formatMoney(tip)}`, HALF, true))
  }
  printer.println(pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true))
  taxBreakdownLines(order, businessInfo, currency, total, HALF).forEach(l => printer.println(l))
  printer.println(`Pago: ${payMethod}`)
  if (showCashLines) {
    printer.println(pad('Recibido:', HALF) + pad(`${currency}${formatMoney(cashGiven)}`, HALF, true))
    if (changeGiven > 0) {
      printer.bold(true)
      printer.println(pad('Cambio:', HALF) + pad(`${currency}${formatMoney(changeGiven)}`, HALF, true))
      printer.bold(false)
    }
  }
  if (orderNotes) printer.println(`Nota: ${orderNotes}`)
  printer.println(LINE)
  printer.alignCenter()
  printer.println('¡Gracias por su visita!')
      printer.println('Este documento no es un')
      printer.println('comprobante fiscal')
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

// ─── Table Comanda ────────────────────────────────────────────────────────────

/**
 * ¿Este renglón va al BAR? **Único criterio de estación en todo el bridge.**
 *
 * La misma pregunta se contestaba en tres sitios con tres vocabularios distintos, y solo
 * uno coincidía con los datos: `main.js` usaba `product_type === 'drink'` (correcto),
 * `printTableComanda` filtraba por `i.bar || i.category === 'bar' || i.station === 'bar'`
 * —tres campos que NO existen en los ítems— y el difunto `/print-comanda` comparaba contra
 * `'bar'`, un valor que nunca se escribe. Resultado en producción: cinco tragos (Santo
 * Libre, Cuba Libre, Tom Collins, jugo y cerveza) impresos bajo "--- COCINA ---" en el
 * mismo ticket que las hamburguesas, y la sección "--- BAR ---" que no podía aparecer
 * jamás. Verificado contra la BD: `product_type` solo toma 'food' (1110) y 'drink' (303).
 *
 * El `?? 'food'` importa: un producto en "auto" se guarda como NULL y el web lo colapsa a
 * comida en todos sus consumidores (`station/page.tsx`, `orders`, `delivery`). Aquí se hace
 * igual — si el papel y la pantalla clasificaran distinto, el cocinero y el mesero verían
 * cosas diferentes del mismo pedido.
 */
function isDrink(item) {
  return (item?.product_type ?? 'food') === 'drink'
}

/**
 * Los platos de una COMANDA, en un solo lugar para las tres (mesa, cocina, bar).
 *
 * Estilo Toast/Square: el cocinero lee este papel de lejos, colgado y con las manos
 * ocupadas — no es un recibo que alguien se acerca a revisar. Cantidad y nombre a DOBLE
 * ALTURA en la misma línea, las notas en tamaño normal e indentadas debajo, y una línea en
 * blanco entre platos para que dos pedidos no se lean como uno.
 *
 * `setTextSize(0, 1)`: ancho normal, alto doble. **El ancho NO se toca a propósito** — con
 * (1,1) la línea pasaría de 32 a 16 caracteres y "2x Sancocho de res" se partiría en dos.
 * Se vuelve a (0,0) antes de las notas: la impresora es un modo, no un estilo por línea, y
 * si no se restaura todo lo que sigue —incluido el pie— sale gigante.
 *
 * Hoy los modificadores viajan DENTRO de `notes`: no existe campo `modifiers` en el
 * contrato de ninguno de los dos bridges. Si algún día se agrega, se dibuja aquí y las tres
 * comandas lo heredan.
 */
/**
 * La NOTA DEL PEDIDO en una comanda ("sin cebolla", "bien cocido").
 *
 * Es la nota que escribe el cliente en el menú público (`orders.notes`, y `p_notes` en
 * `place_table_order`) y NINGUNA comanda la imprimía — ese era el "las notas no salen" que
 * reportó Sandy. Las comandas leían `item.notes`/`item.special_instructions`, campos que el
 * web no escribe nunca: **las notas POR ÍTEM no existen en el modelo de datos**, así que ahí
 * no había nada que arreglar (sería una feature nueva, no un bug).
 *
 * Va ARRIBA, antes de los platos, no al final: el cocinero lee de arriba abajo y empieza a
 * preparar mientras lee. Una nota después de los renglones se descubre con la comida ya
 * hecha, que es justo cuando ya no sirve de nada.
 *
 * En la rama separada (cocina y bar en impresoras distintas) sale en las DOS comandas: la
 * nota es del pedido completo, no de una estación, y el barman también puede necesitarla.
 */
// La misma nota, para el camino de impresora de SISTEMA (HTML).
function noteHtml(notes) {
  const text = (notes || '').toString().trim()
  if (!text) return ''
  return `<div class="divider"></div><div class="center" style="font-weight:700">*** NOTA DEL PEDIDO ***</div><div>${text}</div>`
}

// La misma nota, para los volcados de TEST_MODE (texto plano, sin ESC/POS).
function noteLines(notes) {
  const text = (notes || '').toString().trim()
  return text ? ['*** NOTA DEL PEDIDO ***', text, ''] : []
}

function printComandaNote(printer, notes) {
  const text = (notes || '').toString().trim()
  if (!text) return
  printer.alignCenter()
  printer.bold(true)
  printer.println('*** NOTA DEL PEDIDO ***')
  printer.bold(false)
  printer.alignLeft()
  printer.println(text)          // la térmica envuelve sola; no se trunca
  printer.println('')
}

function printComandaItems(printer, items) {
  items.forEach((item, idx) => {
    if (idx > 0) printer.println('')
    printer.setTextSize(0, 1)
    printer.println(`${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`)
    printer.setTextSize(0, 0)
    const notes = item.notes || item.special_instructions
    if (notes) printer.println(`   * ${notes}`)
  })
}

async function printTableComanda(order, printerName, businessInfo, tableInfo = {}) {
  const currency = businessInfo?.currency || store.get('businessCurrency', 'RD$')
  console.log('[printer] Using currency:', currency)

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateTableComandaHTML(order, businessInfo, paperWidth, tableInfo)
    await printHTML(html, printerName)
    return
  }

  const { W, LINE } = anchoTermicoDeLaConfig()
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = tableInfo?.table_label || order.table_label || tableInfo?.table_number || order.table_number || order.table_id || '?'
  const shortId = (tableInfo?.order_id || order.id || '000000').slice(-6).toUpperCase()
  const items = order.items || order.order_items || []
  // `isDrink` es el MISMO criterio que usa main.js para elegir impresora. Antes filtraba
  // por i.bar/i.category/i.station —ninguno existe en los ítems reales— así que barItems
  // salía vacío siempre y los tragos se imprimían como comida.
  const kitchenItems = items.filter(i => !isDrink(i))
  const barItems = items.filter(isDrink)
  const allItems = kitchenItems.length === 0 && barItems.length === 0 ? items : []

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(`** COMANDA - ${formatTableLabel(tableLabel)} **`),
      center(dateStr),
      LINE,
      ...(noteLines(order.notes)),
      ...(kitchenItems.length > 0 ? ['--- COCINA ---', ...kitchenItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      ...(barItems.length > 0 ? ['--- BAR ---', ...barItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      ...(allItems.length > 0 ? ['--- ITEMS ---', ...allItems.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}`)] : []),
      LINE,
      center(`Orden #${shortId}`),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(`** COMANDA - ${formatTableLabel(tableLabel)} **`)
  printer.bold(false)
  printer.println(dateStr)
  printer.println(LINE)
  printer.alignLeft()

  printComandaNote(printer, order.notes)

  if (kitchenItems.length > 0) {
    printer.alignCenter(); printer.println('--- COCINA ---'); printer.alignLeft()
    printComandaItems(printer, kitchenItems)
  }
  if (barItems.length > 0) {
    printer.alignCenter(); printer.println('--- BAR ---'); printer.alignLeft()
    printComandaItems(printer, barItems)
  }
  if (allItems.length > 0) {
    printer.alignCenter(); printer.println('--- ITEMS ---'); printer.alignLeft()
    printComandaItems(printer, allItems)
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.println(`Orden #${shortId}`)
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

// ─── Delivery / Takeout Ticket ────────────────────────────────────────────────

async function printDeliveryTicket(order, printerName, businessInfo) {
  const cur = businessInfo?.currency || order?.currency || store.get('businessCurrency', 'RD$')
  console.log('[printer] Using currency:', cur)

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateDeliveryTicketHTML(order, businessInfo, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const info = typeof businessInfo === 'string' ? { name: businessInfo } : (businessInfo || {})
  const currency = cur
  // Mismos campos y misma precedencia que `printPOSReceipt`. Este ticket arrancaba directo
  // en "** DELIVERY **": el cliente recibía un papel sin nombre, RNC ni dirección del
  // negocio — imposible saber quién se lo mandó, y el único documento que acompaña la
  // comida a la casa del cliente. El recibo del POS sí lo dibujaba desde siempre.
  const bizName = info.name || 'MI NEGOCIO'
  const legalName = info.legalName || ''
  const rnc = info.rnc || ''
  const address = info.address || ''

  const { W, HALF, LINE, DASH } = anchoTermicoDeLaConfig()
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const typeLabel = (order.order_type || 'delivery').toUpperCase()
  const customerName = order.customer_name || order.client_name || 'Cliente'
  const customerPhone = order.customer_phone || order.phone || order.tel || 'N/A'
  // La dirección real vive en customer_address (la BD). Antes se leía delivery_address/
  // address → nunca coincidía → la dirección no salía en NINGÚN ticket. Fix.
  // customer_address = "dirección legible\nhttps://maps...": en papel la URL es inútil
  // (el repartidor navega desde la app), así que imprime solo la parte antes del \n.
  // Se hace aquí (plantilla) para que aplique también al camino AUTOMÁTICO. La térmica
  // envuelve la línea larga sola — no se trunca.
  const rawAddr = order.customer_address || order.delivery_address || ''
  const deliveryAddr = String(rawAddr).split('\n')[0].trim()
  const orderNotes = (order.notes || '').toString().trim()
  const items = order.items || order.order_items || []

  const subtotal = Number(order.subtotal || 0)
  const deliveryFee = Number(order.delivery_fee || 0)
  // Descuento (cupón): SOLO sobre el subtotal; el envío nunca se descuenta.
  // Antes total = subtotal + envío → cobraba el descuento de más. Fix v1.1.9.
  const discount = Number(order.discount_amount || 0)
  const hasDiscount = discount > 0
  const discountPct = hasDiscount && order.discount_pct ? Number(order.discount_pct) : null
  const discountLabel = discountPct ? `Descuento (${discountPct}%):` : 'Descuento:'
  const total = subtotal - discount + deliveryFee

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(bizName, W),
      ...(legalName ? [center(legalName, W)] : []),
      ...(rnc ? [center(`RNC: ${rnc}`, W)] : []),
      ...(address ? [center(address, W)] : []),
      center(`** ${typeLabel} **`),
      center(dateStr),
      LINE,
      `Cliente: ${customerName}`,
      `Tel: ${customerPhone}`,
      DASH,
      ...items.map(item => {
        const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
        const right = `${currency}${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
        return renglonImporte(left, right, W)
      }),
      DASH,
      ...((deliveryFee > 0 || hasDiscount) ? [
        pad('Subtotal:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true),
        ...(hasDiscount ? [pad(discountLabel, HALF) + pad(`-${currency}${formatMoney(discount)}`, HALF, true)] : []),
        ...(deliveryFee > 0 ? [pad('Envio:', HALF) + pad(`${currency}${formatMoney(deliveryFee)}`, HALF, true)] : []),
      ] : []),
      pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true),
      ...taxBreakdownLines(order, businessInfo, currency, total, HALF),
      ...(deliveryAddr ? [DASH, `Dir: ${deliveryAddr}`] : []),
      ...(orderNotes ? [`Nota: ${orderNotes}`] : []),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.println(bizName)
  if (legalName) printer.println(legalName)
  if (rnc) printer.println(`RNC: ${rnc}`)
  if (address) printer.println(address)
  printer.bold(true)
  printer.println(`** ${typeLabel} **`)
  printer.bold(false)
  printer.println(dateStr)
  printer.println(LINE)
  printer.alignLeft()
  printer.println(`Cliente: ${customerName}`)
  printer.println(`Tel: ${customerPhone}`)
  printer.println(DASH)
  items.forEach(item => {
    const left = `${item.quantity || item.qty || 1}x ${item.name || item.product_name || ''}`
    const right = `${currency}${formatMoney((item.unit_price || item.price || 0) * (item.quantity || item.qty || 1))}`
    printer.println(renglonImporte(left, right, W))
  })
  printer.println(DASH)
  if (deliveryFee > 0 || hasDiscount) {
    printer.println(pad('Subtotal:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true))
    if (hasDiscount) printer.println(pad(discountLabel, HALF) + pad(`-${currency}${formatMoney(discount)}`, HALF, true))
    if (deliveryFee > 0) printer.println(pad('Envio:', HALF) + pad(`${currency}${formatMoney(deliveryFee)}`, HALF, true))
  }
  printer.println(pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true))
  taxBreakdownLines(order, businessInfo, currency, total, HALF).forEach(l => printer.println(l))
  if (deliveryAddr) {
    printer.println(DASH)
    printer.println(`Dir: ${deliveryAddr}`)
  }
  if (orderNotes) {
    printer.println(`Nota: ${orderNotes}`)
  }
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

// ─── Test page ────────────────────────────────────────────────────────────────

async function printTestPage(printerName, businessName) {
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = generateTestReceiptHTML(businessName, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const { W, LINE } = anchoTermicoDeLaConfig()
  // El ancho EFECTIVO, impreso. Puede no coincidir con `paperWidth`: mientras nadie haya
  // guardado la configuración, el papel sigue a 32 columnas aunque el desplegable diga
  // 80 mm (ver `anchoTermico`). Decirlo en el papel es lo único que convierte eso en algo
  // diagnosticable en vez de un misterio.
  const explicito = store.get('paperWidthExplicit', false)
  const lineaAncho = explicito
    ? `Papel: ${paperWidth} - ${W} columnas`
    : `Papel: ${W} columnas (sin configurar)`
  const lines = [
    LINE,
    center('TitiMenu', W),
    center(businessName || 'Mi Negocio', W),
    LINE,
    center('Impresora configurada OK!', W),
    center(lineaAncho, W),
    ...(explicito ? [] : [center('Guarda la configuracion', W), center('para usar el ancho real', W)]),
    center(new Date().toLocaleString('es-DO'), W),
    LINE,
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }
  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println('TitiMenu')
  printer.bold(false)
  printer.println(businessName || 'Mi Negocio')
  printer.println(LINE)
  printer.println('Impresora configurada OK!')
  // El ancho EFECTIVO, impreso: es lo que hace diagnosticable que un equipo siga a 32
  // columnas porque nadie ha guardado la configuración todavía.
  printer.println(lineaAncho)
  if (!explicito) {
    printer.println('Guarda la configuracion')
    printer.println('para usar el ancho real')
  }
  printer.println(new Date().toLocaleString('es-DO'))
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

// ─── Fiscal Receipt ──────────────────────────────────────────────────────────

async function printFiscalReceipt(data, printerName) {
  const cur = data?.currency || store.get('businessCurrency', 'RD$')
  console.log('[printer] Using currency:', cur)

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  if (printMode === 'system') {
    const html = await generateFiscalReceiptHTML(data, paperWidth)
    await printHTML(html, printerName)
    return
  }

  const { W, HALF, LINE, DASH } = anchoTermicoDeLaConfig()

  const bizName = data.business_name || 'MI NEGOCIO'
  const legalName = data.legal_name || ''
  const rnc = data.rnc || ''
  const address = data.address || ''
  const ncf = data.ncf || ''
  const ncfType = data.ncf_type || 'B02'
  const ncfLabel = ncfType === 'B01' ? 'Crédito Fiscal' : 'Consumidor Final'
  const items = data.items || []
  const subtotal = parseFloat(data.subtotal || 0)
  const itbis = parseFloat(data.itbis || 0)
  const total = parseFloat(data.total || 0)
  const tip = parseFloat(data.tip_amount || 0)
  const hasTip = tip > 0
  const currency = cur
  const dateStr = new Date().toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const lines = [
    LINE,
    center(bizName, W),
    ...(legalName ? [center(legalName, W)] : []),
    center(`RNC: ${rnc}`, W),
    ...(address ? [center(address, W)] : []),
    LINE,
    center('COMPROBANTE FISCAL', W),
    center(ncf, W),
    center(ncfLabel, W),
    `Fecha: ${dateStr}`,
    LINE,
    ...items.map(item => {
      const left = `${item.qty || 1}x ${item.name || ''}`
      const right = `${currency}${formatMoney(item.subtotal || (item.price * (item.qty || 1)) || 0)}`
      return renglonImporte(left, right, W)
    }),
    DASH,
    pad('Base imponible:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true),
    pad('ITBIS (18%):', HALF) + pad(`+${currency}${formatMoney(itbis)}`, HALF, true),
    ...(hasTip ? [pad('Propina:', HALF) + pad(`+${currency}${formatMoney(tip)}`, HALF, true)] : []),
    LINE,
    pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true),
    LINE,
    ...(data.client_name ? [
      `Cliente: ${data.client_name}`,
      ...(data.client_rnc ? [`RNC: ${data.client_rnc}`] : []),
      LINE
    ] : []),
    center('¡Gracias por su visita!', W),
    LINE,
    '[CORTE]'
  ]

  if (isTestMode(printerName)) {
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  // ── CAMINO NUEVO: la representación del e-CF certificado ─────────────────
  //
  // Todo sale del XML firmado, incluido el envío como línea y la base/ITBIS por línea.
  // Aquí no hay ni una cuenta: los importes se escriben tal como llegan, en texto.
  const F = fiscalDesdeRepresentacion(data)
  if (F) {
    // Una rechazada NO se imprime como factura fiscal: el papel diría que existe un
    // comprobante que la DGII no aceptó. El web ya no la manda, y esto es el cinturón.
    if (F.rechazada) {
      console.warn('[printer] comprobante rechazado, no se imprime como factura:', F.encf)
      throw new Error('La DGII no aceptó este comprobante: no se puede imprimir como factura fiscal')
    }

    const Rh = respaldoFiscal(data)
    printer.alignCenter()
    printer.println(LINE)
    const razonCab = F.emisorNombre || (Rh ? Rh.negocioNombre : '')
    printer.println(razonCab)
    const comercialCab = F.nombreComercial || (Rh ? Rh.negocioNombreComercial : '')
    if (comercialCab && comercialCab !== razonCab) {
      printer.println(comercialCab)
    }
    const rncCab = F.emisorRnc || (Rh ? Rh.negocioRnc : '')
    const dirCab = F.emisorDireccion || (Rh ? Rh.negocioDireccion : '')
    if (rncCab) printer.println(`RNC: ${rncCab}`)
    if (dirCab) printer.println(dirCab)
    printer.println(LINE)
    printer.bold(true)
    printer.println(F.titulo)
    printer.bold(false)
    printer.println(F.encf)
    printer.alignLeft()
    const fechaCab = F.fechaEmision || (Rh ? Rh.fecha : '')
    if (fechaCab) printer.println(`Fecha emision: ${fechaCab}`)
    if (F.venceSecuencia) printer.println(`Vence secuencia: ${F.venceSecuencia}`)
    if (F.compradorNombre) printer.println(`Cliente: ${F.compradorNombre}`)
    if (F.compradorRnc) printer.println(`RNC/Cedula: ${F.compradorRnc}`)
    printer.println(DASH)

    // ── SIN XML TODAVÍA: el papel se rellena con los datos de la venta ───
    const R = respaldoFiscal(data)
    if (F.lineas.length === 0 && !F.total && R) {
      R.items.forEach(i => {
        const left = `${i.qty}x ${i.name}`
        const right = `${cur}${formatMoney(i.subtotal)}`
        printer.println(renglonImporte(left, right, W))
      })
      if (R.descuento) printer.println(pad('Descuento:', HALF) + pad(`-${cur}${formatMoney(R.descuento)}`, HALF, true))
      if (R.envio) printer.println(pad('Envio:', HALF) + pad(`${cur}${formatMoney(R.envio)}`, HALF, true))
      printer.println(LINE)
      // SIN base ni ITBIS: los calcula la DGII por línea y sólo existen en el XML.
      printer.println(pad('TOTAL:', HALF) + pad(`${cur}${formatMoney(R.total)}`, HALF, true))
      printer.println(LINE)
      printer.alignCenter()
      printer.bold(true)
      printer.println('Comprobante en proceso')
      printer.println('de validacion ante la DGII')
      printer.bold(false)
      printer.println('¡Gracias por su visita!')
      printer.println(LINE)
      printer.cut()
      if (isTCP) { await printer.execute() }
      else {
        const buf = printer.getBuffer()
        await sendRawToPrinter(buf, printerName)
        printer.clear()
      }
      return
    }

    F.lineas.forEach(l => {
      const left = l.cantidad ? `${l.cantidad}x ${l.nombre}` : l.nombre
      const right = `${cur}${l.monto}`
        printer.println(renglonImporte(left, right, W))
      // El descuento del cupón va DEBAJO de su línea, con sangría: es de esa línea y no
      // del total. Al final haría creer que se descuenta del total.
      if (l.descuento) {
        printer.println(pad('   Descuento', HALF) + pad(`-${cur}${l.descuento}`, HALF, true))
      }
    })

    printer.println(DASH)
    if (F.gravado) printer.println(pad('Base imponible:', HALF) + pad(`${cur}${F.gravado}`, HALF, true))
    if (F.itbis)   printer.println(pad('ITBIS (18%):', HALF) + pad(`${cur}${F.itbis}`, HALF, true))
    if (F.exento)  printer.println(pad('Monto exento:', HALF) + pad(`${cur}${F.exento}`, HALF, true))
    if (F.propina) printer.println(pad('Propina legal:', HALF) + pad(`+${cur}${F.propina}`, HALF, true))
    printer.println(LINE)
    printer.println(pad('TOTAL:', HALF) + pad(`${cur}${F.total}`, HALF, true))
    printer.println(LINE)

    printer.alignCenter()
    if (F.conQr) {
      printer.println(`Codigo de seguridad: ${F.rep.codigo_seguridad}`)
      printer.println(`Fecha de firma: ${F.rep.fecha_firma}`)
      printer.newLine()
      // La URL va tal cual: es la firmada. Raster por defecto; ver `imprimirQrTermico`
      // para por qué esto NO puede volver a ser `printer.raw()`.
      const comoSalio = await imprimirQrTermico(printer, F.rep.qr_url, paperWidth)
      console.log(`[printer] QR de ${F.encf} impreso por: ${comoSalio}`)
      printer.newLine()
      printer.println('Consulte este comprobante')
      printer.println('en la DGII escaneando el QR')
    } else {
      printer.bold(true)
      printer.println('Comprobante en proceso')
      printer.println('de validacion ante la DGII')
      printer.bold(false)
    }
    printer.println('¡Gracias por su visita!')
    printer.println(LINE)
    printer.cut()

    if (isTCP) {
      await printer.execute()
    } else {
      const buf = printer.getBuffer()
      await sendRawToPrinter(buf, printerName)
      printer.clear()
    }
    return
  }

  // ── CAMINO VIEJO: payload sin `representacion` ────────────────────────────
  // Lo usa un web anterior a octubre de 2026. Los importes ya no se calculan aquí —
  // llegan en `subtotal`/`itbis`— así que es correcto; lo único que no puede sacar es el
  // QR, porque la URL firmada no viaja en el contrato viejo.
  printer.alignCenter()
  printer.println(LINE)
  printer.println(bizName)
  if (legalName) printer.println(legalName)
  printer.println(`RNC: ${rnc}`)
  if (address) printer.println(address)
  printer.println(LINE)
  printer.bold(true)
  printer.println('COMPROBANTE FISCAL')
  printer.bold(false)
  printer.println(ncf)
  printer.println(ncfLabel)
  printer.alignLeft()
  printer.println(`Fecha: ${dateStr}`)
  printer.println(LINE)
  items.forEach(item => {
    const left = `${item.qty || 1}x ${item.name || ''}`
    const right = `${currency}${formatMoney(item.subtotal || (item.price * (item.qty || 1)) || 0)}`
    printer.println(renglonImporte(left, right, W))
  })
  printer.println(DASH)
  printer.println(pad('Base imponible:', HALF) + pad(`${currency}${formatMoney(subtotal)}`, HALF, true))
  printer.println(pad('ITBIS (18%):', HALF) + pad(`+${currency}${formatMoney(itbis)}`, HALF, true))
  if (hasTip) printer.println(pad('Propina:', HALF) + pad(`+${currency}${formatMoney(tip)}`, HALF, true))
  printer.println(LINE)
  printer.println(pad('TOTAL:', HALF) + pad(`${currency}${formatMoney(total)}`, HALF, true))
  printer.println(LINE)
  if (data.client_name) {
    printer.println(`Cliente: ${data.client_name}`)
    if (data.client_rnc) printer.println(`RNC: ${data.client_rnc}`)
    printer.println(LINE)
  }
  printer.alignCenter()
  printer.println('¡Gracias por su visita!')
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

async function printStationComanda(stationTitle, items, printerName, orderInfo, businessInfo, tableInfo = {}) {
  if (!printerName || printerName === '— No usar —') return

  const currency = businessInfo?.currency || store.get('businessCurrency', 'RD$')
  console.log('[printer] Using currency:', currency)

  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')
  
  const tableLabel = tableInfo?.table_label || orderInfo.table_label || tableInfo?.table_number || orderInfo.table_number || orderInfo.table_id || '?'
  const shortId = (tableInfo?.order_id || orderInfo.id || orderInfo.order_number || '000000').slice(-6).toUpperCase()

  if (printMode === 'system') {
    const html = generateStationComandaHTML(stationTitle, items, orderInfo, paperWidth, tableInfo)
    await printHTML(html, printerName)
    return
  }

  const { W, LINE } = anchoTermicoDeLaConfig()
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + '  ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })

  if (isTestMode(printerName)) {
    const lines = [
      LINE,
      center(`** ${stationTitle} - ${formatTableLabel(tableLabel)} **`),
      center(dateStr),
      LINE,
      ...(noteLines(orderInfo?.notes)),
      ...items.map(i => `${i.quantity || i.qty || 1}x ${i.name || i.product_name || ''}` + (i.notes ? `\n   * ${i.notes}` : '')),
      LINE,
      center(`Orden #${shortId}`),
      LINE,
      '[CORTE]'
    ]
    writeTestOutput(lines)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  printer.alignCenter()
  printer.println(LINE)
  printer.bold(true)
  printer.println(`** ${stationTitle} - ${formatTableLabel(tableLabel)} **`)
  printer.bold(false)
  printer.println(dateStr)
  printer.println(LINE)
  printer.alignLeft()

  printComandaNote(printer, orderInfo?.notes)
  printComandaItems(printer, items)

  printer.alignCenter()
  printer.println(LINE)
  printer.println(`Orden #${shortId}`)
  printer.println(LINE)
  printer.cut()
  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

function generateStationComandaHTML(stationTitle, items, orderInfo, paperWidth, tableInfo = {}) {
  const now = new Date()
  const dateStr = now.toLocaleDateString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + now.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit' })
  const tableLabel = tableInfo?.table_label || orderInfo.table_label || tableInfo?.table_number || orderInfo.table_number || orderInfo.table_id || '?'
  const shortId = (tableInfo?.order_id || orderInfo.id || orderInfo.order_number || '000000').slice(-6).toUpperCase()

  const itemsHtml = items.map(item => {
    const qty = item.quantity || item.qty || 1
    const name = item.name || item.product_name || ''
    const notes = item.notes || item.special_instructions || ''
    return `
      <div style="padding: 3px 0; font-size: 1.1em;">
        <span class="bold">${qty}x</span> ${name}
        ${notes ? `<div class="notes">* ${notes}</div>` : ''}
      </div>
    `
  }).join('')

  const bodyContent = `
    <div class="header center">
      <div class="text-large">** ${stationTitle} **</div>
      <div class="tag" style="font-size: 1.15em;">${formatTableLabel(tableLabel)}</div>
      <div class="business-details" style="margin-top: 4px;">${dateStr}</div>
    </div>
    
    ${noteHtml(orderInfo?.notes)}
    <div class="divider"></div>
    
    <div>
      ${itemsHtml}
    </div>
    
    <div class="divider-double"></div>
    
    <div class="footer center bold">
      Orden #${shortId}
    </div>
  `

  return getBaseHTML(getReceiptStyles(paperWidth), bodyContent)
}

async function printKitchenComanda(items, printerName, orderInfo, businessInfo) {
  return await printStationComanda('COMANDA COCINA', items, printerName, orderInfo, businessInfo)
}

async function printBarComanda(items, printerName, orderInfo, businessInfo) {
  return await printStationComanda('COMANDA BAR', items, printerName, orderInfo, businessInfo)
}

// ─── Cierre de Caja ───────────────────────────────────────────────────────────
async function printClosingReport(data, printerName) {
  const currency = data.currency || store.get('businessCurrency', 'RD$')
  const printMode = store.get('printMode', 'thermal')
  const paperWidth = store.get('paperWidth', '80mm')

  const { W, HALF, LINE, DASH } = anchoTermicoDeLaConfig()

  const bizName = data.business_name || store.get('businessName', 'MI NEGOCIO')
  const openedAt = data.opened_at || ''
  const closedAt = data.closed_at || ''
  const cashierName = data.cashier_name || null
  const openingCash = parseFloat(data.opening_cash || 0)
  const totalSales = parseFloat(data.total_sales || 0)
  const totalCash = parseFloat(data.total_cash || 0)
  const totalCard = parseFloat(data.total_card || 0)
  // Transferencia (septiembre 2026). Los emisores viejos no mandan la clave y cae a 0,
  // que aquí es el neutro correcto: la línea solo se imprime si hay monto.
  const totalTransfer = parseFloat(data.total_transfer || 0)
  // CIERRE CIEGO: el empleado cuenta el efectivo sin ver cuánto se espera, para que un
  // faltante no se pueda "ajustar". Quien emite NO manda los montos del turno cuando es
  // ciego —el control vive en el origen, no en este bridge, que se actualiza por su
  // cuenta— así que aquí ya llegan en 0. La bandera sirve para no imprimir un arqueo
  // lleno de ceros en vez de omitir las líneas.
  const blind = data.blind === true
  const totalOrders = data.total_orders || 0
  const expectedCash = parseFloat(data.expected_cash || 0)
  const closingCash = parseFloat(data.closing_cash || 0)
  const diff = parseFloat(data.cash_difference || 0)
  const diffSign = diff >= 0 ? '+' : ''
  const notes = data.notes || null

  if (isTestMode(printerName)) {
    writeTestOutput([
      center(bizName, W),
      center('CIERRE DE CAJA', W),
      center(closedAt, W),
      ...(cashierName ? [center(`Cajero/a: ${cashierName}`, W)] : []),
      DASH,
      pad('Apertura:', HALF) + pad(openedAt, HALF, true),
      pad('Efectivo apertura:', HALF) + pad(`${currency}${formatMoney(openingCash)}`, HALF, true),
      DASH,
      // Todo el dinero del turno bajo UNA sola puerta: en un cierre ciego basta con que
      // una línea de importe se escape para que el control no sirva.
      ...(blind ? [] : [
        pad('Total ventas:', HALF) + pad(`${currency}${formatMoney(totalSales)}`, HALF, true),
        pad('  Efectivo:', HALF) + pad(`${currency}${formatMoney(totalCash)}`, HALF, true),
        pad('  Tarjeta:', HALF) + pad(`${currency}${formatMoney(totalCard)}`, HALF, true),
        ...(totalTransfer > 0 ? [pad('  Transferencia:', HALF) + pad(`${currency}${formatMoney(totalTransfer)}`, HALF, true)] : []),
      ]),
      pad('  Ordenes:', HALF) + pad(String(totalOrders), HALF, true),
      DASH,
      ...(blind ? [] : [pad('Efectivo esperado:', HALF) + pad(`${currency}${formatMoney(expectedCash)}`, HALF, true)]),
      // El contado SÍ sale en el ciego: es lo que el propio empleado acaba de declarar.
      pad('Efectivo contado:', HALF) + pad(`${currency}${formatMoney(closingCash)}`, HALF, true),
      LINE,
      ...(blind ? [] : [pad('Diferencia:', HALF) + pad(`${diffSign}${currency}${formatMoney(diff)}`, HALF, true)]),
      ...(notes ? [DASH, `Nota: ${notes}`] : []),
      DASH,
      center('Powered by TitiMenu', W),
      '[CORTE]'
    ])
    return
  }

  if (printMode === 'system') {
    const html = generateClosingReportHTML(data, bizName, currency)
    await printHTML(html, printerName)
    return
  }

  const isTCP = printerName && (IP_RE.test(printerName.trim()) || printerName.trim().startsWith('tcp://'))
  const printer = await createPrinter(printerName)
  if (isTCP) {
    const connected = await printer.isPrinterConnected()
    console.log('[printer] Connected:', connected, 'Printer:', printerName)
    if (!connected) {
      throw new Error(`Impresora no encontrada: ${printerName}`)
    }
  }

  printer.alignCenter()
  printer.bold(true)
  printer.setTextSize(1, 1)
  printer.println(bizName)
  printer.setTextSize(0, 0)
  printer.bold(false)
  printer.println('CIERRE DE CAJA')
  printer.println(closedAt)
  if (cashierName) printer.println(`Cajero/a: ${cashierName}`)
  printer.println(DASH)
  printer.alignLeft()
  printer.println(pad('Apertura:', HALF) + pad(openedAt, HALF, true))
  printer.println(pad('Efectivo apertura:', HALF) + pad(`${currency}${formatMoney(openingCash)}`, HALF, true))
  printer.println(DASH)
  if (!blind) {
    printer.bold(true)
    printer.println(pad('Total ventas:', HALF) + pad(`${currency}${formatMoney(totalSales)}`, HALF, true))
    printer.bold(false)
    printer.println(pad('  Efectivo:', HALF) + pad(`${currency}${formatMoney(totalCash)}`, HALF, true))
    printer.println(pad('  Tarjeta:', HALF) + pad(`${currency}${formatMoney(totalCard)}`, HALF, true))
    // Solo si hubo: un negocio que no cobra por transferencia no ve una línea en cero, y
    // así el arqueo de los que ya existen no cambia.
    if (totalTransfer > 0) {
      printer.println(pad('  Transferencia:', HALF) + pad(`${currency}${formatMoney(totalTransfer)}`, HALF, true))
    }
  }
  printer.println(pad('  Ordenes:', HALF) + pad(String(totalOrders), HALF, true))
  printer.println(DASH)
  if (!blind) {
    printer.println(pad('Efectivo esperado:', HALF) + pad(`${currency}${formatMoney(expectedCash)}`, HALF, true))
  }
  printer.println(pad('Efectivo contado:', HALF) + pad(`${currency}${formatMoney(closingCash)}`, HALF, true))
  printer.println(LINE)
  if (!blind) {
    printer.bold(true)
    printer.println(pad('Diferencia:', HALF) + pad(`${diffSign}${currency}${formatMoney(diff)}`, HALF, true))
    printer.bold(false)
  }
  if (notes) {
    printer.println(DASH)
    printer.println(`Nota: ${notes}`)
  }
  printer.println(DASH)
  printer.alignCenter()
  printer.println('Powered by TitiMenu')
  printer.cut()

  if (isTCP) {
    await printer.execute()
  } else {
    const buf = printer.getBuffer()
    await sendRawToPrinter(buf, printerName)
    printer.clear()
  }
}

function generateClosingReportHTML(data, bizName, currency) {
  const diff = parseFloat(data.cash_difference || 0)
  const diffSign = diff >= 0 ? '+' : ''
  const fmt = (n) => Number(n || 0).toLocaleString()
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cierre de Caja</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Courier New',monospace;font-size:12px;width:80mm;max-width:80mm;padding:4mm;color:#000;}
  .c{text-align:center;} .b{font-weight:bold;} .xl{font-size:16px;}
  .div{border-top:1px dashed #000;margin:5px 0;} .div2{border-top:2px solid #000;margin:5px 0;}
  .row{display:flex;justify-content:space-between;margin:2px 0;}
  @media print{body{margin:0;}@page{margin:4mm;size:80mm auto;}}
</style></head><body>
  <div class="c b xl">${bizName}</div>
  <div class="c b">CIERRE DE CAJA</div>
  <div class="c" style="font-size:10px">${data.closed_at || ''}</div>
  ${data.cashier_name ? `<div class="c" style="font-size:10px">Cajero/a: ${data.cashier_name}</div>` : ''}
  <div class="div"></div>
  <div class="row"><span>Apertura</span><span>${data.opened_at || ''}</span></div>
  <div class="row"><span>Efectivo apertura</span><span>${currency}${fmt(data.opening_cash)}</span></div>
  <div class="div"></div>
  ${data.blind === true ? '' : `
  <div class="row b"><span>Total ventas</span><span>${currency}${fmt(data.total_sales)}</span></div>
  <div class="row"><span>  Efectivo</span><span>${currency}${fmt(data.total_cash)}</span></div>
  <div class="row"><span>  Tarjeta</span><span>${currency}${fmt(data.total_card)}</span></div>
  ${parseFloat(data.total_transfer || 0) > 0 ? `<div class="row"><span>  Transferencia</span><span>${currency}${fmt(data.total_transfer)}</span></div>` : ''}
  `}
  <div class="row"><span>  Ordenes</span><span>${data.total_orders ?? 0}</span></div>
  <div class="div"></div>
  ${data.blind === true ? '' : `<div class="row"><span>Efectivo esperado</span><span>${currency}${fmt(data.expected_cash)}</span></div>`}
  <div class="row"><span>Efectivo contado</span><span>${currency}${fmt(data.closing_cash)}</span></div>
  <div class="div2"></div>
  ${data.blind === true ? '' : `<div class="row b"><span>Diferencia</span><span>${diffSign}${currency}${fmt(diff)}</span></div>`}
  ${data.notes ? `<div class="div"></div><div style="font-size:10px">Nota: ${data.notes}</div>` : ''}
  <div class="div"></div>
  <div class="c" style="font-size:10px">Powered by TitiMenu</div>
</body></html>`
}

module.exports = {
  getUSBPrinters,
  isDrink,
  printPOSReceipt,
  printFiscalReceipt,
  printTableComanda,
  printDeliveryTicket,
  printTestPage,
  printKitchenComanda,
  printBarComanda,
  printClosingReport,
  TEST_PRINTER_NAME,
  // Expuesta para poder CAREAR el papel del modo sistema sin una impresora delante:
  // se genera el HTML y se saca con `printToPDF`. Así se cazó el QR que no salía.
  generateFiscalReceiptHTML
}