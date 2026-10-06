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
      console.log(`[tiempos] ${tipo}${ref} | ${partes} | TOTAL ${total}ms${extra ? ' | ' + extra : ''}`)
      return total
    },
  }
}

module.exports = { cronometro }
