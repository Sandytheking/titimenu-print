// TOPE de la cola de impresión del SISTEMA.
//
// EL PROBLEMA, tal como se ve en el local: `isPrinterActive` sólo comprueba el TEXTO
// del nombre de la impresora — nunca si responde. Con la térmica desconectada, `lp`
// (CUPS) o el spooler de Windows aceptan el trabajo igual y devuelven éxito, así que
// el bridge informa "impreso", el web no cae a su PDF, y no sale nada. Cuando la
// impresora vuelve, el spooler suelta TODO lo acumulado de golpe.
//
// Encolar es lo que queremos —si la impresora vuelve en un rato, los recibos salen—,
// pero sin tope una desconexión de tres horas escupe cincuenta tickets viejos, cada
// uno de una venta ya cobrada y de un cliente que hace rato se fue. Un recibo tardío
// no es un recibo: es basura que confunde al cajero y gasta papel.
//
// LA COLA NO ES NUESTRA, es la del sistema operativo, así que el tope se aplica
// sondeándola y purgándola justo antes de encolar un trabajo nuevo. Perezoso: sin
// temporizadores, sin procesos en segundo plano. Si no se puede saber el estado de la
// cola, NO se estorba — quedarse sin imprimir por un fallo del sondeo sería peor que
// el problema que arregla.

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

/** Cuánto puede llevar una cola ATASCADA (sin avanzar) antes de descartarla. */
const MAX_BACKLOG_MS = 15 * 60 * 1000

/** Cuántos trabajos pendientes se toleran antes de descartar, pase el tiempo que pase. */
const MAX_PENDING_JOBS = 10

// printerName -> { since, lastCount }. `since` es NUESTRO reloj, no la fecha que
// imprime `lpstat` (que viene en el idioma y formato del sistema y sería frágil de
// parsear). Sólo hace falta saber desde cuándo la cola no avanza.
const backlog = new Map()

/** @returns {Promise<number|null>} trabajos pendientes, o null si no se pudo saber. */
async function pendingJobs(printerName) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command',
        `(Get-PrintJob -PrinterName $args[0] -ErrorAction SilentlyContinue | Measure-Object).Count`,
        printerName,
      ])
      const n = parseInt(String(stdout).trim(), 10)
      return Number.isFinite(n) ? n : null
    }
    // macOS / Linux: una línea por trabajo pendiente.
    const { stdout } = await execFileAsync('lpstat', ['-o', printerName])
    return String(stdout).split('\n').filter(l => l.trim()).length
  } catch (err) {
    // `lpstat` sale con código != 0 cuando no hay cola en algunas versiones; eso no es
    // un fallo, es una cola vacía.
    if (err && typeof err.stdout === 'string' && !err.stdout.trim()) return 0
    return null
  }
}

async function purgeQueue(printerName) {
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-PrintJob -PrinterName $args[0] -ErrorAction SilentlyContinue | Remove-PrintJob`,
      printerName,
    ])
    return
  }
  await execFileAsync('cancel', ['-a', printerName])
}

/**
 * Se llama ANTES de mandar un trabajo. Si la cola de esa impresora está atascada
 * —demasiados trabajos, o demasiado tiempo sin avanzar— la vacía para que el trabajo
 * nuevo salga solo, en vez de detrás de media hora de recibos muertos.
 *
 * @param {string} printerName
 * @param {(msg: string) => void} [log]
 */
async function ensureQueueHealthy(printerName, log = () => {}) {
  if (!printerName) return

  const pending = await pendingJobs(printerName)
  if (pending === null) return          // no se sabe → no se estorba
  if (pending === 0) { backlog.delete(printerName); return }

  const prev = backlog.get(printerName)
  // Si la cola BAJÓ, está avanzando: la impresora funciona y esto es sólo una racha de
  // trabajo. Se reinicia el cronómetro para no purgar una cola sana en plena hora pico.
  const since = (!prev || pending < prev.lastCount) ? Date.now() : prev.since
  backlog.set(printerName, { since, lastCount: pending })

  const stuckMs = Date.now() - since
  if (pending < MAX_PENDING_JOBS && stuckMs < MAX_BACKLOG_MS) return

  try {
    await purgeQueue(printerName)
    backlog.delete(printerName)
    log(`Cola de "${printerName}" descartada: ${pending} trabajo(s) sin salir durante ` +
        `${Math.round(stuckMs / 60000)} min. Revisa que la impresora esté encendida y conectada.`)
  } catch (err) {
    log(`No se pudo vaciar la cola de "${printerName}": ${err.message}`)
  }
}

module.exports = { ensureQueueHealthy, MAX_BACKLOG_MS, MAX_PENDING_JOBS }
