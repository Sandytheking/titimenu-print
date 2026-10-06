// Cronómetro de impresión: dónde se va el tiempo entre que existe el trabajo y sale el
// papel.
//
// ## Por qué existe
// Hay un retraso perceptible al imprimir por el bridge que en la app de Android no
// existe. Antes de tocar nada hay que saber DÓNDE se va, porque las dos sospechas
// naturales —la cascada de canales y el QR— son baratas de descartar o confirmar con
// marcas de tiempo, y caras de "arreglar" a ciegas.
//
// Imprime UNA línea por trabajo con todas las etapas, para poder pegarla en un reporte:
//
//   [tiempos] fiscal E320000015515 | origen 412ms | plantilla 3ms | qr 24ms |
//             buffer 1ms | cola 780ms | spooler 2140ms | TOTAL 2948ms
//
// `origen` es la edad del trabajo cuando llega al bridge: separa "el bridge es lento" de
// "el bridge se entera tarde", que tienen arreglos opuestos (uno es el envío, el otro es
// sondeo vs realtime).

// A dónde sale la línea, además de la consola.
//
// `console.log` NO llega al panel «Actividad» de la app: ese panel sólo muestra lo que
// pasa por `sendLog()` del proceso principal. Y en la app EMPAQUETADA la consola no se ve
// —no hay terminal—, así que una medición que sólo fuera por consola sería invisible justo
// para quien tiene que leerla. `main.js` engancha aquí su `sendLog`.
let salida = null

/** Engancha el panel de la app. Lo llama `main.js` al arrancar. */
function setSalida(fn) {
  salida = typeof fn === 'function' ? fn : null
}

/** Arranca un cronómetro para un trabajo. */
function cronometro(tipo, referencia) {
  const t0 = Date.now()
  let ultimo = t0
  const etapas = []
  let cerrado = false

  return {
    /** Marca el fin de una etapa y empieza la siguiente. */
    etapa(nombre) {
      const ahora = Date.now()
      etapas.push([nombre, ahora - ultimo])
      ultimo = ahora
      return ahora
    },
    /**
     * La edad del trabajo cuando llegó: cuánto llevaba existiendo en origen.
     * No consume tiempo de las etapas, es una medida aparte.
     */
    origen(fechaIso) {
      if (!fechaIso) return
      const t = Date.parse(fechaIso)
      if (!Number.isFinite(t)) return
      etapas.unshift(['origen', t0 - t])
    },
    /** Cierra y escribe la línea. Idempotente: se puede llamar desde un `finally`. */
    fin(extra) {
      if (cerrado) return
      cerrado = true
      const total = Date.now() - t0
      const partes = etapas.map(([n, ms]) => `${n} ${ms}ms`).join(' | ')
      const ref = referencia ? ` ${referencia}` : ''
      const linea = `[tiempos] ${tipo}${ref} | ${partes} | TOTAL ${total}ms${extra ? ' | ' + extra : ''}`
      console.log(linea)
      if (salida) { try { salida(linea) } catch {} }
      return total
    },
  }
}

module.exports = { cronometro, setSalida }
