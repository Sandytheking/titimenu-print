/**
 * Impresora térmica por BLUETOOTH, sin driver.
 *
 * ## Cómo llega una impresora Bluetooth a una PC
 * Al emparejarla, el sistema crea un PUERTO SERIE virtual (perfil SPP): `COM5` en Windows
 * («Vínculo serie estándar sobre Bluetooth»), `/dev/cu.<Nombre>` en Mac. NO aparece como
 * impresora del sistema, así que el selector —que lista impresoras instaladas— no la veía.
 * Aquí se le escriben los bytes ESC/POS directo a ese puerto: los MISMOS que van por USB o
 * por red, salidos de las mismas plantillas.
 *
 * ## Las reglas, las de la tablet (`BluetoothPrinting.kt` de TitiStaff)
 *  · Una conexión POR TRABAJO (abrir, escribir, cerrar): no se retiene la impresora entre
 *    ventas y el fallo aparece cuando el cajero puede actuar.
 *  · Dos intentos, con 1,5 s entre ellos: el primer connect tras un rato inactivo falla a
 *    menudo en estas térmicas.
 *  · 8 s para conectar y 400 ms de margen antes de cerrar (sin él, el cierre puede cortar
 *    el final del ticket).
 *  · Mismos mensajes de fallo.
 *
 * ## Las dos trampas, y por qué están cubiertas
 *  1. **Mac traduce `\n` por `\r\n` en un puerto serie** (ONLCR de la terminal) si no se le
 *     dice lo contrario: los bytes de una imagen —el QR fiscal— saldrían corruptos. Se pone
 *     el puerto en crudo (`stty raw`) sobre el MISMO descriptor abierto, antes de escribir.
 *  2. **Un puerto que no conecta CUELGA el proceso.** Medido con la 2C-POS80 en Mac: `open` y
 *     `write` vuelven al instante (los datos quedan en el búfer de la terminal) y es `close`
 *     el que espera a que salgan… para siempre si el enlace nunca se establece — ni
 *     `process.exit` lo saca de ahí, solo `kill -9`. Dentro de la app eso dejaría la cola de
 *     esa impresora bloqueada sin un solo error, y además un hilo del pool de libuv tomado
 *     (con cuatro, la app entera dejaría de leer y escribir archivos). Por eso cada intento
 *     corre en un PROCESO HIJO con tiempo límite: si no termina, se le mata y se avisa.
 *
 * El nombre guardado es `bt:<puerto>` (`bt:COM5`, `bt:/dev/cu.Printer`): así ninguna otra
 * parte del bridge lo confunde con una IP ni con una cola del sistema.
 */
const fs = require('fs')
const { spawn, execFile } = require('child_process')

const PREFIJO = 'bt:'
const CONNECT_TIMEOUT_MS = 8_000
const FLUSH_GRACE_MS = 400
const ENTRE_INTENTOS_MS = 1_500
/** Windows: el margen antes de cerrar, el de la prueba a mano que imprimió (ver `PS_SERIE`). */
const GRACIA_WINDOWS_MS = 1_000

const esBluetooth = (nombre) => typeof nombre === 'string' && nombre.startsWith(PREFIJO)
const puertoDe = (nombre) => nombre.slice(PREFIJO.length)
const espera = (ms) => new Promise(r => setTimeout(r, ms))

// ─── Listado ──────────────────────────────────────────────────────────────────

/** Puertos de Mac que NO son impresoras: los del sistema y los adaptadores USB-serie. */
const MAC_NO_IMPRESORA = /^(Bluetooth-Incoming-Port|debug-console|wlan-debug|usbserial|usbmodem|SLAB_|wchusbserial)/i

/** Lo que devuelve la consulta de Windows → impresoras. Puro, para los tests. */
function parsearWindows(salida) {
  const nombres = new Map()   // MAC → nombre del dispositivo
  const puertos = []          // { com, mac }
  for (const linea of String(salida).split(/\r?\n/)) {
    const [nombre, id] = linea.split('|')
    if (!nombre || !id) continue
    const dev = /^BTHENUM\\DEV_([0-9A-F]{12})/i.exec(id)
    if (dev) { nombres.set(dev[1].toUpperCase(), nombre.trim()); continue }
    const com = /\((COM\d+)\)/i.exec(nombre)
    if (!com) continue
    // El puerto SALIENTE lleva la MAC del aparato; el ENTRANTE, ceros. Solo sirve el saliente.
    const mac = /&([0-9A-F]{12})_/i.exec(id)?.[1]?.toUpperCase()
    if (!mac || /^0+$/.test(mac)) continue
    puertos.push({ com: com[1].toUpperCase(), mac })
  }
  return puertos.map(({ com, mac }) => ({
    name: PREFIJO + com,
    displayName: `Bluetooth · ${nombres.get(mac) || 'impresora'} (${com})`,
  }))
}

/** Lo que hay en /dev de una Mac → impresoras. Puro, para los tests. */
function parsearMac(entradas) {
  return entradas
    .filter(f => f.startsWith('cu.'))
    .map(f => f.slice(3))
    .filter(n => !MAC_NO_IMPRESORA.test(n))
    .map(n => ({ name: `${PREFIJO}/dev/cu.${n}`, displayName: `Bluetooth · ${n}` }))
}

const WIN_CONSULTA =
  "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'BTHENUM*' } | " +
  "ForEach-Object { $_.Name + '|' + $_.PNPDeviceID }"

/** Impresoras Bluetooth emparejadas con esta PC. Nunca lanza: si falla, lo dice y devuelve []. */
async function listarBluetooth() {
  try {
    // Mac: NO se ofrece. Medido con la 2C-POS80 (2026-11-15): sale el PRIMER ticket tras
    // emparejar y ninguno más — el enlace cae al cerrar y macOS no lo vuelve a levantar,
    // pero `write` y `close` terminan bien, así que la app diría «impreso» sin papel. Es el
    // peor fallo posible (silencioso). `parsearMac` se queda, con su test, para cuando se
    // pruebe otro camino en Mac (IOBluetooth directo).
    if (process.platform === 'darwin') return []
    if (process.platform === 'win32') {
      const salida = await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', WIN_CONSULTA],
          { timeout: 15_000, windowsHide: true },
          (err, stdout) => err ? reject(err) : resolve(stdout))
      })
      return parsearWindows(salida)
    }
  } catch (err) {
    console.warn('[bluetooth] no se pudieron listar las impresoras Bluetooth:', err.message)
  }
  return []
}

// ─── Envío ────────────────────────────────────────────────────────────────────

/**
 * El código del proceso hijo: abrir, (Mac) poner en crudo, escribir, esperar, cerrar.
 *
 * Va como TEXTO, autocontenido, y se lanza con `-e`: NO con `fork(__filename)`. TitiMenu Staff
 * de escritorio empaqueta todo su proceso principal en un solo `main.js` (vite), así que ahí
 * `__filename` es la app entera y el «hijo» habría sido una segunda copia de la app. Un texto
 * sin dependencias funciona igual empaquetado o no, en Electron (ELECTRON_RUN_AS_NODE) y en Node.
 *
 * Mac (trampa 1): `stty raw -echo 115200` sobre el MISMO descriptor. La velocidad no es la del
 * Bluetooth, pero la terminal de la Mac reparte la salida al ritmo del puerto, que nace en 9600
 * (≈1 KB/s): una factura con QR (7 KB) tardaba 9 s. Medido con la 2C-POS80: 8.953 → 858 ms.
 */
const HIJO = `
const fs = require('fs'), { spawn } = require('child_process')
const espera = (ms) => new Promise(r => setTimeout(r, ms))
const fin = (r) => process.send(r, () => process.exit(0))
process.once('message', async ({ ruta, datos, crudo, graciaMs }) => {
  let h
  try {
    // 'r+' = abrir lo que EXISTE (OPEN_EXISTING en Windows); 'w' intentaría crearlo.
    h = await fs.promises.open(ruta, 'r+')
    if (crudo) await new Promise((ok, mal) => {
      const p = spawn('stty', ['raw', '-echo', '115200'], { stdio: [h.fd, 'ignore', 'pipe'] })
      let e = ''
      p.stderr.on('data', d => { e += d })
      p.on('error', mal)
      p.on('close', c => c === 0 ? ok() : mal(new Error('stty falló (' + c + '): ' + e.trim())))
    })
    const b = Buffer.from(datos, 'base64')
    let hecho = 0
    while (hecho < b.length) {
      const { bytesWritten } = await h.write(b, hecho, b.length - hecho)
      if (!bytesWritten) throw new Error('el puerto no aceptó más datos')
      hecho += bytesWritten
    }
    await espera(graciaMs)
    await h.close(); h = null
    fin({ ok: true })
  } catch (err) {
    if (h) await h.close().catch(() => {})
    fin({ ok: false, code: err.code, message: err.message })
  }
})
`

/** El mensaje para el cajero a partir del error del sistema. */
function mensajeDe(err, puerto) {
  const m = String(err?.message || err)
  if (m.includes('no respondió')) return m
  if (err?.code === 'ENOENT') return `No encontramos la impresora emparejada (${puerto}). Vuelve a elegirla en la configuración.`
  // La Mac contesta EBUSY también cuando el aparato no está a su alcance (apagado, lejos o
  // ya no emparejado), no solo cuando otro lo tiene abierto: el mensaje cubre los dos casos.
  if (err?.code === 'EBUSY' || err?.code === 'EACCES') {
    return `No se pudo conectar con la impresora (${puerto}). ¿Está encendida, cerca y emparejada con esta computadora? Si otra tablet o computadora está imprimiendo en ella, espera un momento.`
  }
  return `No se pudo imprimir: ${m}`
}

/**
 * Tope de un intento: conectar + lo que tarda en salir el ticket a ~1 KB/s (lo más lento que
 * se ha medido) + el margen de cierre. Una factura con QR (7 KB) → ~16 s.
 */
const topeIntentoMs = (bytes) => CONNECT_TIMEOUT_MS + bytes + FLUSH_GRACE_MS

/**
 * Windows: el puerto lo abre `System.IO.Ports.SerialPort` (.NET), por PowerShell.
 *
 * Medido en la PC de Sandy con la 2C-POS80 (2026-11-15): abrir `\\.\COM7` con `fs` de Node
 * falla con `UNKNOWN` —libuv abre los archivos con un modo compartido, y un puerto COM exige
 * acceso EXCLUSIVO—, mientras que `SerialPort` imprimió a la primera. Es el mismo componente
 * que usan las apps de impresoras térmicas en Windows.
 *
 * El ticket entra por stdin en base64 y el puerto por variable de entorno (validado antes:
 * `COM` + número), así que nada del trabajo se interpola en el script.
 */
const PS_SERIE = [
  "$ErrorActionPreference = 'Stop'",
  '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$p = New-Object System.IO.Ports.SerialPort $env:TITI_COM, 115200',
  '$p.WriteTimeout = [int]$env:TITI_TOPE',
  '$p.Open()',
  // try y finally en el MISMO renglón: el `; ` del join entre ellos sería un error de sintaxis.
  // Tras escribir: esperar a que el driver diga que no queda nada por salir (BytesToWrite), y
  // DESPUÉS el margen. Medido en la PC de Sandy: con 400 ms sin esa espera, la página de prueba
  // (372 bytes) se perdía con «Salió la prueba» en verde —Close descartaba lo que el enlace aún
  // no había entregado— mientras la factura (7 KB, tarda más en escribirse) sí salía. Su prueba
  // a mano, con 1 s de espera, imprimió.
  'try { $p.Write($b, 0, $b.Length); $p.BaseStream.Flush(); $r = [Diagnostics.Stopwatch]::StartNew(); while ($p.BytesToWrite -gt 0 -and $r.ElapsedMilliseconds -lt [int]$env:TITI_TOPE) { Start-Sleep -Milliseconds 50 }; Start-Sleep -Milliseconds ([int]$env:TITI_GRACIA) } finally { $p.Close() }',
  "'OK'",
].join('; ')

/** Lo que dice .NET (en inglés o en español, según el Windows) → el código que entiende `mensajeDe`. */
function codigoWindows(stderr) {
  const t = String(stderr)
  if (/semaphore|sem[aá]foro|timed? ?out|tiempo de espera/i.test(t)) return 'TOPE'
  if (/does not exist|no existe/i.test(t)) return 'ENOENT'
  if (/denied|denegado|in use|en uso/i.test(t)) return 'EBUSY'
  return 'WINDOWS'
}

function intentoWindows(buffer, puerto) {
  return new Promise((resolve, reject) => {
    if (!/^COM\d+$/i.test(puerto)) return reject(Object.assign(new Error(`puerto inválido: ${puerto}`), { code: 'ENOENT' }))
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SERIE], {
      windowsHide: true,
      env: { ...process.env, TITI_COM: puerto.toUpperCase(), TITI_TOPE: String(CONNECT_TIMEOUT_MS), TITI_GRACIA: String(GRACIA_WINDOWS_MS) },
    })
    let out = '', err = '', listo = false
    const terminar = (e) => { if (listo) return; listo = true; clearTimeout(t); e ? reject(e) : resolve() }
    // + 3 s: lo que tarda en arrancar PowerShell, que no es culpa de la impresora.
    const t = setTimeout(() => {
      ps.kill()
      terminar(Object.assign(new Error('La impresora no respondió. ¿Está encendida y cerca?'), { code: 'TOPE' }))
    }, topeIntentoMs(buffer.length) + GRACIA_WINDOWS_MS + 3000)
    ps.stdout.on('data', d => { out += d })
    ps.stderr.on('data', d => { err += d })
    ps.on('error', terminar)
    ps.on('close', (code) => {
      if (code === 0 && out.includes('OK')) return terminar()
      const detalle = err.trim().split(/\r?\n/)[0] || `PowerShell terminó con código ${code}`
      const codigo = codigoWindows(err)
      terminar(Object.assign(
        new Error(codigo === 'TOPE' ? 'La impresora no respondió. ¿Está encendida y cerca?' : detalle),
        { code: codigo },
      ))
    })
    ps.stdin.end(buffer.toString('base64'))
  })
}

/** Un intento en un proceso hijo (ver la trampa 2). Resuelve o lanza; nunca se queda colgado. */
function intentoEnHijo(buffer, puerto) {
  if (process.platform === 'win32') return intentoWindows(buffer, puerto)
  return new Promise((resolve, reject) => {
    // El binario de la app (Electron) en modo Node; en Node pelado, el propio node.
    const hijo = spawn(process.execPath, ['-e', HIJO], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    let listo = false
    const terminar = (err) => {
      if (listo) return
      listo = true
      clearTimeout(t)
      err ? reject(err) : resolve()
    }
    const t = setTimeout(() => {
      // Si quedó colgado en el kernel, el SIGKILL lo saca cuando el sistema lo suelte; a la
      // app ya no le afecta: el trabajo se da por fallido y se avisa.
      hijo.kill('SIGKILL')
      terminar(Object.assign(new Error('La impresora no respondió. ¿Está encendida y cerca?'), { code: 'TOPE' }))
    }, topeIntentoMs(buffer.length))
    hijo.on('message', (r) => {
      if (r && r.ok) terminar()
      else terminar(Object.assign(new Error(r?.message || 'error desconocido'), { code: r?.code }))
    })
    hijo.on('error', terminar)
    hijo.on('exit', (code) => {
      if (!listo) terminar(new Error(`el proceso de impresión terminó sin responder (código ${code})`))
    })
    hijo.send({
      ruta: puerto,
      datos: buffer.toString('base64'),
      crudo: process.platform === 'darwin',
      graciaMs: FLUSH_GRACE_MS,
    })
  })
}

/** Manda el ticket. Dos intentos; lanza con un mensaje para el cajero si no sale. */
async function enviarPorBluetooth(buffer, nombre) {
  const puerto = puertoDe(nombre)
  let ultimo
  for (let intento = 1; intento <= 2; intento++) {
    try {
      await intentoEnHijo(buffer, puerto)
      console.log(`[bluetooth] ${buffer.length} bytes enviados a ${puerto} (intento ${intento})`)
      return
    } catch (err) {
      ultimo = err
      console.warn(`[bluetooth] intento ${intento} a ${puerto} falló: ${err.code || ''} ${err.message}`)
      if (intento === 1) await espera(ENTRE_INTENTOS_MS)
    }
  }
  throw new Error(mensajeDe(ultimo, puerto))
}

module.exports = { esBluetooth, listarBluetooth, enviarPorBluetooth, parsearWindows, parsearMac, mensajeDe, topeIntentoMs, codigoWindows }
