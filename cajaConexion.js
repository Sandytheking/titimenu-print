/**
 * ¿Hay conexión DE VERDAD? Espejo de `Conectividad` + `ReglasConexion` de TitiStaff.
 *
 * El caso típico del apagón en un restaurante es el que el sistema no ve: el router sigue en el
 * inversor, la wifi está, y lo que se cayó es la salida del proveedor. Por eso manda una sonda
 * contra Supabase (`/auth/v1/health`, que no toca la base) y no `navigator.onLine` ni lo que diga
 * el sistema operativo; si el sistema dice que no hay red, no se pregunta a nadie.
 *
 * Regla del proyecto («no decidas desde una fuente secundaria»): esto solo ELIGE qué pantalla y
 * qué mensaje mostrar. La subida de la cola la hace el web contra el servidor y falla contra la
 * autoridad, no contra este veredicto.
 */
const R = require('./cajaReglas')

const TIMEOUT_MS = 5000

class Conexion {
  /**
   * @param {{url: string, anonKey: string, sistemaTieneRed?: () => boolean, log?: (m: string) => void,
   *          alCambiar?: (estado) => void, reloj?: () => number, fetchImpl?: typeof fetch}} o
   */
  constructor(o) {
    this.url = o.url.replace(/\/$/, '') + '/auth/v1/health'
    this.anonKey = o.anonKey
    this.sistemaTieneRed = o.sistemaTieneRed || (() => true)
    this.log = o.log || (() => {})
    this.alCambiar = o.alCambiar || (() => {})
    this.reloj = o.reloj || Date.now
    this.fetch = o.fetchImpl || ((...a) => fetch(...a))
    // Hasta la primera sonda se supone que sí: así arranca como siempre (el web) y, si no hay
    // red, la carga fallida o la primera sonda lo corrigen en segundos.
    this.estado = { enLinea: true, desdeMs: this.reloj(), verificado: false }
    this.timer = null
    this.sondeando = null
    this.vigia = null
    this.ultimoSistema = null
    this.ultimaPista = 0
  }

  /**
   * Con conexión la sonda espera 2 minutos (el ritmo de TitiStaff): sola, tardaba eso en notar
   * que se fue el internet con el POS abierto, y la barra no ofrecía «Cobrar sin conexión».
   * Por eso hay dos disparadores que la adelantan, y ninguno decide nada por su cuenta:
   *   · `vigilarSistema`: cada 3 s mira si el sistema perdió (o recuperó) la red. No hace
   *     ninguna petición; si cambió, se sondea YA. Cubre «apagué el wifi / saqué el cable».
   *   · `pistaDeRed`: una petición REAL del POS falló por red. Cubre «el router sigue, pero
   *     se cayó el proveedor», que el sistema no ve.
   */
  iniciar() {
    this._programar(0)
    this.vigilarSistema()
  }

  vigilarSistema(ms = 3000) {
    if (this.vigia) return
    this.ultimoSistema = this.sistemaTieneRed()
    this.vigia = setInterval(() => {
      const ahora = this.sistemaTieneRed()
      if (ahora !== this.ultimoSistema) {
        this.ultimoSistema = ahora
        this.log(`[conexion] el sistema ${ahora ? 'recuperó' : 'perdió'} la red: se comprueba ya`)
        this.probarAhora().catch(() => {})
      }
    }, ms)
    if (this.vigia.unref) this.vigia.unref()
  }

  /** Una petición real falló por red: se sondea ya, como mucho una vez cada 10 s. */
  pistaDeRed(motivo) {
    const t = this.reloj()
    if (t - this.ultimaPista < 10000) return
    this.ultimaPista = t
    if (this.estado.enLinea) this.log(`[conexion] una petición del POS falló por red (${motivo}): se comprueba ya`)
    this.probarAhora().catch(() => {})
  }

  detener() {
    if (this.timer) clearTimeout(this.timer)
    if (this.vigia) clearInterval(this.vigia)
    this.timer = null
    this.vigia = null
  }

  _programar(ms) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.probarAhora().catch(() => {}) }, ms)
    if (this.timer.unref) this.timer.unref()
  }

  /** Sondea ya (al fallar una carga, o al pedirlo la pantalla). Una sola sonda a la vez. */
  probarAhora() {
    if (this.sondeando) return this.sondeando
    this.sondeando = this._sondear().finally(() => {
      this.sondeando = null
      this._programar(R.intervaloSondaMs(this.estado.enLinea))
    })
    return this.sondeando
  }

  async _sondear() {
    let ok
    let motivo = ''
    if (!this.sistemaTieneRed()) {
      ok = false
      motivo = 'el sistema no tiene red'
    } else {
      try {
        const r = await this.fetch(this.url, { headers: { apikey: this.anonKey }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        ok = r.ok
        if (!ok) motivo = `Supabase respondió HTTP ${r.status}`
      } catch (e) {
        ok = false
        motivo = e && e.name === 'TimeoutError' ? `sin respuesta de Supabase en ${TIMEOUT_MS / 1000} s` : (e && e.message) || 'fallo de red'
      }
    }
    const previo = this.estado
    if (previo.enLinea === ok) {
      this.estado = { ...previo, verificado: true }
    } else {
      this.estado = { enLinea: ok, desdeMs: this.reloj(), verificado: true }
      this.log(ok ? '[conexion] Conexión restablecida (Supabase responde)' : `[conexion] Sin conexión: ${motivo}`)
      try { this.alCambiar(this.estado) } catch (e) { this.log(`[conexion] fallo al avisar del cambio: ${e.message}`) }
    }
    return this.estado
  }
}

module.exports = { Conexion }
