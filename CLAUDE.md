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

## 🐞 BUG ABIERTO — `printDeliveryTicket` imprime la dirección del negocio como si fuera del cliente
**Qué pasa:** `printDeliveryTicket` resuelve la dirección con
`order.customer_address || order.delivery_address || order.address`. En los payloads del
web, **`address` es la dirección del NEGOCIO** (va en el encabezado). Así que un pedido sin
`customer_address` —un **takeout**, o un delivery de texto libre que quedó sin dirección—
imprime `Dir: <dirección del local>` como si fuera la del cliente. No es cosmético: manda
al repartidor a la puerta del propio restaurante.

**Por qué no se arregló todavía:** es la plantilla que se está usando de referencia para el
careo de tickets entre los dos bridges (v1.2.0). Se corrige en su propio turno, con su
prueba: quitar el fallback `|| order.address` y verificar que un takeout imprima sin línea
`Dir:` en vez de con la del local.

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
