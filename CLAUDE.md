# TitiMenu Print Bridge (Electron/PC) — contexto para Claude Code

Bridge de impresión para PC: servidor HTTP local (puerto 3001) que recibe trabajos
de impresión de la PWA (menuqr) y los manda a una impresora térmica USB vía ESC/POS
(`node-thermal-printer`). Contraparte de TitiPrint (Android, impresora de RED).

- `main.js` — servidor HTTP + endpoints (`/status`, `/print-receipt`, `/print-fiscal`, …),
  auto-updater, sondeo de Supabase para auto-impresión de pedidos nuevos.
- `printer.js` — renderers ESC/POS: `printPOSReceipt`, `printDeliveryTicket`,
  `printTableComanda`, `printFiscalReceipt`, kitchen/bar comanda, closing.

## Ruteo de `/print-receipt`
El POST rutea por `order_type` del payload: `delivery`/`takeout` → `printDeliveryTicket`
(desglosa Subtotal + Envío + TOTAL); el resto (`pos`/`table`) → `printPOSReceipt`. El WEB
es la fuente única del payload (estructura, `order_type`, desglose, labels).

**Un delivery hecho DESDE EL POS llega con `order_type: 'pos'`** (esa clave elige la
PLANTILLA, no el tipo de pedido), así que lo imprime `printPOSReceipt` — y debe hacerlo
completo: v1.2.0 le agregó Cliente/Tel/Dir, la línea de Envío, la Nota y el Cajero/a, con
las MISMAS claves y la misma regla de dirección (`customer_address.split('\n')[0].trim()`)
que `printDeliveryTicket`. NO rutear el POS a la plantilla del menú: perdería método de
pago, cambio y RNC — que en un delivery del POS importan más, porque el repartidor cobra
en la puerta y el ticket es comprobante fiscal. Todos los bloques son condicionales: una
venta de mostrador sin `customer_*` imprime exactamente igual que antes.

## ✅ DESCARTADO (2026-08-09) — el `order.address` de `printDeliveryTicket` nunca se disparó
Estuvo anotado como bug abierto: `printDeliveryTicket` resuelve la dirección con
`order.customer_address || order.delivery_address || order.address`, y como en los payloads
del web **`address` es la dirección del NEGOCIO**, se dedujo que un takeout sin
`customer_address` imprimiría `Dir: <dirección del local>` como si fuera la del cliente.

**Verificado en papel por Sandy (Electron, takeout sin dirección): no pasa.** Salen Cliente
y Teléfono, sin línea `Dir:`, y la dirección del local aparece solo en el membrete. Y el
código explica por qué — la deducción tenía un eslabón falso:

- **Camino HTTP:** el handler de `/print-receipt` no pasa `data` a la plantilla, construye
  `order` con un **whitelist explícito** (main.js) que **nunca listó `address`**. Verificado
  en el historial: la única clave `address:` que existió en main.js es la de `businessInfo`
  (`store.get('businessAddress')`), jamás una del objeto `order`. O sea que
  `order.address` siempre fue `undefined` por esta vía: el fallback era inalcanzable desde
  el primer día, no se arregló en ningún commit.
- **Camino automático:** la plantilla recibe `payload.new`, la fila cruda de `orders`.
  **Certificado contra la BD por Fable (2026-08-09): la única columna con "address" en
  `orders` es `customer_address` — no existe `address` a secas.** Así que por esta vía la
  clave tampoco llega: no es que venga vacía, es que la columna no existe.

**Ojo con la hipótesis descartada:** no lo arregló el módulo compartido (F0) ni `posReceipt`
(F2) — son Kotlin, y `printer.js` no se tocó en ninguna de las dos. El fallback **sigue
literalmente en el código** (`printer.js:1194`, y otro igual en `:660`); lo que nunca
existió fue el dato que lo activaba.

**Lo que sí hay que cuidar (por lo que esta nota se queda):** el whitelist de main.js es lo
único que sostiene esto en el camino HTTP. Si alguien alguna vez le pasa el payload del web
directo a `printDeliveryTicket` —un spread `{...data}`, un atajo para "no repetir el
mapeo"— el bug aparece de verdad, y manda al repartidor a la puerta del propio restaurante.
Limpieza pendiente y trivial cuando se toque `printer.js` por otra cosa: borrar
`|| order.address` de las dos plantillas y quedarse sin la trampa.

`printPOSReceipt` NO copia ese fallback a propósito (ver v1.2.0).

## LECCIONES DE SANGRE
1. **Cero emojis en payloads de impresión.** Las ESC/POS no soportan emojis: los imprimen
   como `??`. Todo texto que va a papel (labels, líneas, "Envío", "Delivery") es ASCII puro.
   Ni en el payload que manda el web, ni hardcodeado en las plantillas de `printer.js`.
2. **Los bridges son software INSTALADO, desincronizado del web.** El web deploya atómico
   para todos; los bridges se actualizan cuando el cliente quiere. Toda interpretación de
   datos del payload debe TOLERAR versiones viejas y nuevas: si reconoce un valor crudo lo
   traduce, si no lo reconoce lo imprime TAL CUAL — nunca coacciona un valor real a un default
   (p.ej. método de pago desconocido → NO "Efectivo", eso imprime dinero falso en papel).
   Ver `translatePaymentMethod` en `printer.js`. Así el orden de despliegue deja de importar.
