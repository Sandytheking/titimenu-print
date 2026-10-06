/**
 * Las colas por impresora: en serie lo que comparte rollo, en paralelo lo que no.
 *
 *     node test-colas.js
 *
 * ## Lo que vigila
 * Medido en Windows: la comanda de cocina esperaba 1.849 ms a que terminara el recibo de
 * caja — exactamente la edad del recibo (494) más lo que tardó en imprimirse (1.354).
 * Iban encadenados con `await` aunque fueran a impresoras distintas.
 */
const assert = require('assert')
const { encolar } = require('./colas')
const dormir = (ms) => new Promise(r => setTimeout(r, ms))

;(async () => {
  // 1. Misma impresora → EN SERIE y en orden.
  const orden = []
  const a = encolar('caja', async () => { await dormir(60); orden.push('recibo') })
  const b = encolar('caja', async () => { await dormir(10); orden.push('segundo') })
  await Promise.all([a, b])
  assert.deepEqual(orden, ['recibo', 'segundo'], 'la misma impresora debe respetar el orden')

  // 2. Impresoras distintas → EN PARALELO.
  const t0 = Date.now()
  await Promise.all([
    encolar('cocina', () => dormir(120)),
    encolar('barra',  () => dormir(120)),
    encolar('caja2',  () => dormir(120)),
  ])
  const total = Date.now() - t0
  assert.ok(total < 300, `tres impresoras tardaron ${total}ms: se están esperando`)

  // 3. Un fallo no puede llevarse por delante al siguiente de esa impresora.
  const despues = []
  const falla = encolar('caja3', async () => { throw new Error('sin papel') })
  const sigue = encolar('caja3', async () => { despues.push('sigue') })
  await assert.rejects(falla, /sin papel/)
  await sigue
  assert.deepEqual(despues, ['sigue'], 'un fallo rompió la cadena de esa impresora')

  console.log('✓ 3 comprobaciones de colas')
})().catch(e => { console.error('✗', e.message); process.exit(1) })

// ── Guardia estático del orquestador de main.js ──────────────────────────────
// El bug que lo justifica salió en el papel de Sandy: `printComandas` seguía siendo
// `async` después de dejar de esperar nada, así que `...printComandas()` esparcía una
// Promesa y reventaba con «Spread syntax requires ...iterable». Lo peor es que NO se ve
// en ningún test de impresión: ocurre en la orquestación, no en la plantilla.
{
  const fs = require('fs')
  const main = fs.readFileSync(require('path').join(__dirname, 'main.js'), 'utf8')
  const esparcidas = [...main.matchAll(/\.\.\.(\w+)\(\)/g)].map(m => m[1])
  for (const nombre of new Set(esparcidas)) {
    const decl = new RegExp(`(const|let|var)\\s+${nombre}\\s*=\\s*async\\b|async\\s+function\\s+${nombre}\\b`)
    assert.ok(!decl.test(main),
      `«${nombre}» se esparce con ... pero es async: eso esparce una Promesa, no un array`)
  }
  console.log(`  ✓ ninguna función esparcida con ... es async (${new Set(esparcidas).size} revisadas)`)
}
