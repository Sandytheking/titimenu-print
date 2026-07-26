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
