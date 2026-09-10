# TitiMenu (Electron/PC) — contexto para Claude Code

**Desde la 2.0.0 ya no es sólo un bridge de impresión: es la app de escritorio de
TitiMenu.** Carga el POS web REAL (titimenu.com) dentro de su ventana y le imprime por
IPC, además de seguir siendo el servidor HTTP local y el oyente de realtime de siempre.
El producto se llama **TitiMenu** (`build.productName`); el `name` del package y el
`appId` conservan a propósito el nombre viejo — ver «El renombrado» abajo.

- `main.js` — armazón (pantalla de inicio + BrowserView del POS), servidor HTTP
  (`/status`, `/print-receipt`, …), IPC del POS, realtime para auto-impresión.
- `printer.js` — renderers ESC/POS: `printPOSReceipt`, `printDeliveryTicket`,
  `printTableComanda`, `printFiscalReceipt`, kitchen/bar comanda, closing.
- `printQueue.js` — tope de la cola del spooler del sistema.
- **Tres preloads, tres superficies, NO se mezclan:** `preload.js` (config, privilegiado,
  contenido local), `preload-pos.js` (SÓLO `getStatus` + `printJob`, contenido REMOTO) y
  `preload-shell.js` (armazón, contenido local).

## Auto-actualización — condicional por plataforma, y el `latest.yml` que hay que subir
`CAN_SELF_INSTALL = process.platform === 'win32'` en `main.js`. **Se COMPRUEBA en las dos
plataformas; sólo se INSTALA sola en Windows.**

- **Windows:** completa. NSIS instala sin certificado de firma; sin firmar sólo sale el
  aviso de SmartScreen, que se salta. El certificado (100-300 USD/año) queda para cuando
  haya volumen.
- **macOS:** NO descarga ni instala. Sin notarización de Apple (99 USD/año + trámite)
  Squirrel falla en silencio al reemplazar el bundle — el diálogo explicativo de
  `handleQuitAndInstall` existe porque ya pasó.
- **Pero en Mac SÍ se comprueba y se avisa**, y esa distinción es el punto: comprobar es
  una petición HTTP y funciona sin firmar; lo que no funciona es instalar. Si se apagara
  todo, el usuario de Mac no tendría NINGUNA forma de enterarse de que hay versión nueva.
  Se le notifica y se le lleva a `/descargar`. **No apagues el sondeo en Mac "porque no
  puede instalar": el aviso es justamente lo que sí puede.**

**⚠️ AL PUBLICAR UN RELEASE HAY QUE SUBIR EL FEED, no sólo los instaladores.**
`electron-updater` no lee la lista de releases de GitHub: pide `latest.yml` (Windows) y
`latest-mac.yml` (macOS) de los adjuntos. Sin ellos **no hay auto-update de ninguna
clase**, ni siquiera la comprobación — y no se nota al probar la app, sólo el día que
alguien espera una actualización que nunca llega. Pasó en la primera subida de la 2.0.0:
se subieron los tres instaladores y ni un `.yml`.
Los `.blockmap` también van: sin ellos Windows descarga la actualización entera en vez
de sólo lo cambiado.
Y los `.yml` llevan el **sha512 del binario**, así que si se recompila hay que volver a
subir binarios Y feed **juntos** (`gh release upload --clobber`); un feed que no cuadra
con el instalador hace fallar la actualización con un error de checksum.

**Backlog:** notarización Mac + firma Windows, cuando el volumen de clientes de PC lo
justifique. Al notarizar, macOS pasa a poder instalar solo y `CAN_SELF_INSTALL` deja de
tener sentido.

## El renombrado (2.0.0) — qué NO se puede tocar
`build.productName` pasó a **TitiMenu**, pero **`name` (`titimenu-print-bridge`) y
`appId` (`com.titimenu.printbridge`) NO se tocan, y no es cosmético**:
- De `name` salen la ruta de `userData`
  (`~/Library/Application Support/titimenu-print-bridge`) **y** el item del llavero
  (`titimenu-print-bridge Safe Storage`) que descifra `bridgeDeviceToken`. Cambiarlo
  dejaría a cada cliente instalado con el store vacío: equipo sin registrar, impresora
  sin elegir y credencial imposible de descifrar. Silencioso y masivo.
- De `appId` depende que NSIS reconozca la instalación previa y actualice ENCIMA en vez
  de instalarse al lado.

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

**Limpieza HECHA (2026-08-11):** se borró `|| order.address` de la plantilla ESC/POS del
delivery y se eliminó la variable `address` muerta de `generateDeliveryTicketHTML` (no se usaba
en el HTML que genera, y su fallback apuntaba a la dirección del negocio). Ya no queda ni una
referencia a `order.address` en `printer.js`, así que la trampa no puede despertar ni con un
`{...data}` que salte el whitelist de main.js. Verificado EJECUTANDO las plantillas: un takeout
sin dirección no imprime línea `Dir:`, un delivery imprime la del cliente sin la URL de Maps, y
la del local aparece solo en el membrete (línea 3), nunca como dirección de cliente.

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
3. **Un archivo nuevo NO viaja solo: `build.files` de package.json es una lista blanca.**
   El 1.3.0 se publicó y no arrancaba —`Cannot find module './bridgeAuth'`— porque el módulo
   nuevo de la credencial de equipo no estaba listado y quedó fuera del `app.asar`. En dev
   funcionaba (los módulos se cargan del disco), así que el error solo aparece en el
   instalador. Ya se cambió a `"*.js"` para matar la clase de error, pero la regla de fondo
   queda: **"BUILD SUCCESSFUL" no prueba que el código viajó.** Antes de publicar, listar el
   paquete: `npx asar list "dist/mac*/TitiMenu*.app/Contents/Resources/app.asar" | grep .js`.
   Es la misma familia que el `cashier_name` (whitelist del payload HTTP) y que el submódulo
   en el checkout de TitiPrint: tres veces un artefacto INSTALADO salió sin algo que sí estaba
   en el código.
