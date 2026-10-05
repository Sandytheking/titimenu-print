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

## Publicar un release — lo construye GitHub, y nace en BORRADOR
**No se compila a mano para publicar.** `.github/workflows/release.yml` se dispara con un
tag `v*` y construye las dos plataformas en runners nativos (`macos-latest` con
`--mac --x64 --arm64`, `windows-latest` con `--win --x64`, `max-parallel: 1` por el cache de
electron-builder, `--publish always`). Así salieron **todas** las releases, la 2.0.0
incluida. El orden completo:

1. `npm version` / bump a mano del `package.json`, commit, push.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` → el workflow construye y adjunta los 12
   ficheros (3 instaladores, 2 zips, sus `.blockmap` y los dos `.yml`).
3. **Publicar el release a mano:** `gh release edit vX.Y.Z --draft=false --latest`.
4. **Solo entonces** subir `BRIDGE_VERSION` en el web
   (`src/app/descargar/DescargarDesktop.tsx`, repo `menuqr`).
5. Comprobar los enlaces **sin autenticar** (`curl -sI -L -o /dev/null -w '%{http_code}'`):
   este repo es PÚBLICO y los clientes descargan de aquí, así que un 404 anónimo es un
   fallo real. *(Al revés que en TitiPrint, que es privado: allá el 404 anónimo es normal
   y no prueba nada — ya despistó un diagnóstico.)*

**El paso 3 es obligatorio y es fácil de olvidar** porque el workflow dice `success` y la
release ya tiene todos los adjuntos: `build.publish.releaseType` es `draft` en el
`package.json`, así que nace en borrador — y **los adjuntos de un borrador no se descargan
públicamente**. Por eso el paso 4 va después: con la página apuntando a una versión sin
publicar, los tres botones dan 404 durante toda la ventana intermedia.

**Dos pistas falsas que ya costaron tiempo, y por eso están escritas:**
- Los adjuntos aparecen subidos por **`Sandytheking`**, no por `github-actions`, porque el
  `GITHUB_TOKEN` del workflow actúa en nombre del repo. Eso **no** prueba que se subieran
  a mano — mirar `gh run list` antes de concluir nada.
- **«El `.exe` no se puede construir en esta Mac sin Wine» es FALSO.** electron-builder
  24.13.3 trae su propio NSIS y produce un PE32 real de ~85 MB en una Mac Intel sin Wine
  instalado (comprobado ejecutándolo, no deducido). Wine sólo haría falta para **firmar**.
  Aunque para publicar no se usa el build local de todos modos: se usa el tag.

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
1. **`printer.raw()` NO escribe en el buffer — nunca se usa. Para bytes crudos, `append()`.**
   `raw()` hace `Interface.execute()` (`node-thermal-printer/lib/core.js:470`) y manda los
   bytes por su cuenta, pero la ruta USB de este bridge imprime con `getBuffer()` +
   `sendRawToPrinter()`: lo que va por `raw()` acaba en **el fichero temporal dummy** y no
   llega al papel. Costó la 2.1.0 entera (el QR de la factura fiscal no salía, con todo lo
   demás perfecto) y había una segunda instancia dormida: el comando de velocidad, que por
   eso nunca se había aplicado en USB. `test-qr-termico.js` prohíbe `.raw(` en todo el
   fichero.
   **Y los bytes crudos que la impresora no reconoce los imprime como TEXTO:** ese mismo
   comando de velocidad (`GS s`), ya bufferizado, sacaba una «S» suelta al principio del
   ticket en una 2Connect POS80 y descuadraba la primera regla. Se eliminó: un comando
   vendor-specific que no está en el estándar no se manda «por si acaso».
2. **Un cambio de FORMATO del papel le cambia el ticket a todos los negocios de golpe,
   porque el bridge se autoactualiza en Windows.** Y el defecto de una preferencia no
   prueba que nadie la eligiera: hasta la 2.1.0 todas las plantillas térmicas imprimían a
   32 columnas ignorando `paperWidth`, así que el `80mm` guardado era lo que traía el
   desplegable, no una decisión. **`store.has()` no distingue**: `save-config` escribe
   siempre la clave. La intención no se puede reconstruir hacia atrás, así que un cambio
   así necesita **marca explícita nueva** (`paperWidthExplicit`), con el comportamiento
   histórico como default, y el valor efectivo IMPRESO en la página de prueba para que sea
   diagnosticable. Ver `anchoTermico`.
   **Y la marca no se regala al guardar: el campo nace VACÍO y es obligatorio**
   (`decidirAncho` en main.js + el `<option value="">` del selector). Marcarlo explícito
   por el simple hecho de guardar parecía suficiente y no lo era: con `80mm`
   preseleccionado, **un negocio de 58 mm que entra a cambiar la impresora guardaría 80 mm
   sin verlo y sus tickets saldrían CORTADOS** —48 columnas no caben en una cabeza de 384
   puntos—, que es peor que el papel estrecho que tenía. Un default que nadie eligió no es
   una elección: cuando la respuesta correcta depende del hardware que hay sobre la mesa,
   se pregunta. El guardado se rechaza **entero** si falta, antes de escribir una sola
   clave, para no dejar impresoras nuevas con el ancho sin resolver.
3. **Lo que se imprime NO puede perder caracteres.** Recortar el concepto para que cupiera
   el importe borró medio producto en una comanda real: «1x Hamburguesas (Belcon, Papas
   Frita,» sin «Doble Carne, Refresco, Jugo de naranja». En una comanda eso es comida mal
   preparada; en un recibo, una reclamación. El concepto **envuelve** con sangría y el
   importe se queda en la primera línea (`renglonImporte`, que devuelve un array). Y el
   ancho que se le pasa es el EFECTIVO: con `setTextSize(_, 1)` cada carácter ocupa dos
   columnas, así que son W/2.
4. **Un solo centrado.** El relleno manual de `center()` se SUMA a `alignCenter()` del
   hardware: el texto se va a la derecha, y más cuanto más corto. Bajo `alignCenter` se
   imprime el texto pelado; `center()` es sólo para el modo test, que no tiene impresora
   que alinee. Pasó en 32 renglones de 5 plantillas a la vez.
5. **Cero emojis en payloads de impresión.** Las ESC/POS no soportan emojis: los imprimen
   como `??`. Todo texto que va a papel (labels, líneas, "Envío", "Delivery") es ASCII puro.
   Ni en el payload que manda el web, ni hardcodeado en las plantillas de `printer.js`.
6. **Los bridges son software INSTALADO, desincronizado del web.** El web deploya atómico
   para todos; los bridges se actualizan cuando el cliente quiere. Toda interpretación de
   datos del payload debe TOLERAR versiones viejas y nuevas: si reconoce un valor crudo lo
   traduce, si no lo reconoce lo imprime TAL CUAL — nunca coacciona un valor real a un default
   (p.ej. método de pago desconocido → NO "Efectivo", eso imprime dinero falso en papel).
   Ver `translatePaymentMethod` en `printer.js`. Así el orden de despliegue deja de importar.
7. **Un archivo nuevo NO viaja solo: `build.files` de package.json es una lista blanca.**
   El 1.3.0 se publicó y no arrancaba —`Cannot find module './bridgeAuth'`— porque el módulo
   nuevo de la credencial de equipo no estaba listado y quedó fuera del `app.asar`. En dev
   funcionaba (los módulos se cargan del disco), así que el error solo aparece en el
   instalador. Ya se cambió a `"*.js"` para matar la clase de error, pero la regla de fondo
   queda: **"BUILD SUCCESSFUL" no prueba que el código viajó.** Antes de publicar, listar el
   paquete: `npx asar list "dist/mac*/TitiMenu*.app/Contents/Resources/app.asar" | grep .js`.
   Es la misma familia que el `cashier_name` (whitelist del payload HTTP) y que el submódulo
   en el checkout de TitiPrint: tres veces un artefacto INSTALADO salió sin algo que sí estaba
   en el código.
