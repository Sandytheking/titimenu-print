// Una cola por IMPRESORA: en serie lo que comparte papel, en paralelo lo que no.
//
// ## Por qué existe
// Los trabajos iban encadenados con `await`, uno detrás de otro, **aunque fueran a
// impresoras distintas**. Medido en Windows: la comanda de cocina nacía con la venta y
// esperaba 1.849 ms a que terminara el recibo de caja — y 1.849 era exactamente la edad
// del recibo (494 ms) más lo que tardó en imprimirse (1.354 ms). Clavado al milisegundo.
//
// La cocina no tiene por qué esperar a la caja: son dos impresoras, dos rollos y dos
// personas distintas mirándolas.
//
// Lo que SÍ tiene que seguir en serie es lo que va a la misma impresora, y **en orden**:
// dos comandas simultáneas al mismo rollo saldrían intercaladas, y un recibo antes que su
// comanda confunde a quien los recoge.

/** La última promesa encolada de cada impresora. Nunca rechaza (ver abajo). */
const cadenas = new Map()

/**
 * Encola un trabajo para esa impresora y devuelve su promesa.
 *
 * La cadena que se guarda es deliberadamente **a prueba de fallos**: si un trabajo
 * revienta, el siguiente de esa misma impresora tiene que salir igual. Un recibo que no
 * imprime no puede llevarse por delante la comanda que venía detrás.
 */
function encolar(impresora, fn) {
  const clave = impresora || '(sin impresora)'
  const anterior = cadenas.get(clave) || Promise.resolve()
  const actual = anterior.then(() => fn())
  cadenas.set(clave, actual.then(() => {}, () => {}))
  return actual
}

/** Cuántas impresoras tienen cola viva. Para pruebas. */
function colasActivas() {
  return cadenas.size
}

module.exports = { encolar, colasActivas }
