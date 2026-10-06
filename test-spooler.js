/**
 * El host persistente de impresión de Windows.
 *
 *     node test-spooler.js
 *
 * No puede lanzar PowerShell fuera de Windows, así que comprueba lo que sí es verificable
 * en cualquier sitio: el contrato del protocolo, que el script compile UNA sola vez, y
 * —lo más importante— que fuera de Windows rechace limpio para que el llamador caiga al
 * camino de siempre en vez de quedarse sin papel.
 */
const assert = require('assert')
const { enviarPorHost, parsearRespuesta, HOST_PS1, TOPE_TRABAJO_MS } = require('./spoolerWin')

let ok = 0
const prueba = (n, f) => { try { f(); ok++; console.log(`  ✓ ${n}`) }
                           catch (e) { console.log(`  ✗ ${n}\n      ${e.message}`); process.exitCode = 1 } }

prueba('el protocolo distingue OK de ERR y recupera el id', () => {
  assert.deepEqual(parsearRespuesta('OK 7'), { ok: true, id: '7', error: undefined })
  const e = parsearRespuesta('ERR 9 WritePrinter devolvio false')
  assert.equal(e.ok, false); assert.equal(e.id, '9')
  assert.equal(e.error, 'WritePrinter devolvio false')
  assert.equal(parsearRespuesta('LISTO'), null, 'LISTO no es una respuesta de trabajo')
  assert.equal(parsearRespuesta('ruido'), null)
})

prueba('el C# se compila UNA vez, fuera del bucle', () => {
  // Si Add-Type quedara dentro del while, cada ticket volvería a pagar la compilación,
  // que es justo lo que este módulo vino a quitar.
  assert.equal((HOST_PS1.match(/Add-Type/g) || []).length, 1)
  assert.ok(HOST_PS1.indexOf('Add-Type') < HOST_PS1.indexOf('while ($true)'),
    'Add-Type tiene que ir ANTES del bucle')
  assert.ok(HOST_PS1.includes('[Console]::In.ReadLine()'), 'falta la lectura por stdin')
  assert.ok(HOST_PS1.includes('[Console]::Out.Flush()'),
    'sin Flush la respuesta se queda en el búfer y el trabajo parece colgado')
})

prueba('hay un tope por trabajo, y es un techo, no una espera', () => {
  assert.ok(TOPE_TRABAJO_MS >= 3000 && TOPE_TRABAJO_MS <= 15000, `tope raro: ${TOPE_TRABAJO_MS}`)
})

;(async () => {
  // Fuera de Windows debe rechazar SIN lanzar nada: es lo que activa el camino de
  // respaldo en `enviarAlSpooler`.
  if (process.platform !== 'win32') {
    await assert.rejects(enviarPorHost(Buffer.from('x'), 'cualquiera'), /sólo Windows/)
    ok++; console.log('  ✓ fuera de Windows rechaza limpio y deja caer al camino de siempre')
  }
  console.log(`\n✓ ${ok} comprobaciones del host`)
})()
