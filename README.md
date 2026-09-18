# quitametadatos

Quita los metadatos —autor, empresa, GPS, fechas, comentarios, macros— de documentos de Office, PDF e imágenes.

Tiene dos caras y las dos comparten **el mismo motor de limpieza** (`web/*.js`):

| | Quién lo usa | Cómo |
|---|---|---|
| **App del navegador** (`web/`) | Personas | Abres la página y el archivo **no sale de tu equipo**: se procesa en el navegador. Funciona sin conexión |
| **Servicio para agentes** (`service/`) | Agentes de IA | API HTTP y herramienta MCP que **cobra por petición con x402**: el agente paga desde su propia cartera, sin cuentas ni claves de API |

El motor es el mismo a propósito: hay una sola implementación de la limpieza y no dos que se desincronicen.

---

## La app del navegador

```bash
python -m http.server 5173 --directory web
# y abre http://127.0.0.1:5173
```

También funciona abriendo `web/index.html` directamente. Soporta varios archivos a la vez, muestra un informe de lo que va a quitar **antes** de limpiar, y descarga los archivos limpios (o un ZIP si son varios) más un `informe.json`.

## El servicio para agentes

### Qué cobra

Precio por **petición** (no por archivo), hasta 10 archivos y 64 MB. Dos productos, dos precios:

| Producto | Precio por defecto | Qué hace |
|---|---|---|
| `POST /v1/clean` | 0,02 USDC | Limpia los metadatos y devuelve los archivos |
| `POST /v1/scan` | 0,01 USDC | Evalúa el riesgo de abrir un archivo, sin modificarlo |

Se puede cobrar en varias redes a la vez: el agente elige con la cartera que tenga.

**Si el trabajo falla, no se cobra.** El pago se liquida solo cuando el trabajo terminó bien.

### Endpoints

| Método | Ruta | Pago | Qué devuelve |
|---|---|---|---|
| `POST` | `/v1/clean` | **sí** | ZIP con los archivos limpios + `informe.json` (o JSON en base64 con `Accept: application/json`) |
| `POST` | `/v1/scan` | **sí** | JSON con un veredicto de riesgo por archivo (nunca ZIP; no modifica nada) |
| `GET` | `/` | no | Descripción del servicio, formatos y cómo pagar |
| `GET` | `/v1/pricing` | no | Precio de cada producto, redes, direcciones de cobro y límites |
| `GET` | `/healthz` | no | Estado |

Formatos: PDF, Word (`.docx`/`.docm`), Excel (`.xlsx`/`.xlsm`), PowerPoint (`.pptx`/`.pptm`), JPEG, PNG y WebP. Las imágenes **no se recodifican**: los píxeles quedan idénticos. TIFF, HEIC y AVIF se rechazan (habría que recodificar) y los PDF cifrados también — en esos casos la petición falla **sin cobrar**.

### Cómo paga un agente

Sin cabecera de pago la petición responde `402` con los requisitos (`PAYMENT-REQUIRED`). El agente firma una autorización EIP-3009 con su cartera y repite la petición con `PAYMENT-SIGNATURE`. El gas lo paga el facilitador: el agente solo necesita USDC.

```bash
# JSON en el cuerpo, para agentes que no pueden enviar multipart
curl -X POST https://tu-servicio/v1/clean \
  -H 'Accept: application/json' \
  -d '{"name":"foto.jpg","bytesBase64":"..."}'
```

Opciones de limpieza (todas opcionales, por defecto las mismas que la app):

```json
{"changes": "keep|accept|reject", "comments": "anonymize|delete",
 "icc": "keep|remove", "orientation": "keep|remove",
 "customProps": true, "macros": true, "connections": true, "attachments": false}
```

### `/v1/scan`: ¿es prudente abrir este archivo?

Pregunta distinta de la limpieza: no es "qué datos personales lleva este archivo que
voy a mandar" (eso es `/v1/clean`), es "¿debería tener cuidado con este archivo que
acabo de recibir". No modifica nada, no reescribe el archivo: solo analiza y devuelve
un veredicto. Reutiliza el mismo análisis que ya hace `/v1/clean` para saber qué
quitar — no hay ningún parseo nuevo, es una capa de interpretación sobre esas señales.

Detecta (cuando existen): macros incrustadas (VBA), JavaScript o acciones automáticas
en PDF (`/OpenAction`, `/AA`), conexiones a bases de datos externas (pueden llevar
usuario y contraseña), enlaces a otros archivos, tablas dinámicas u hojas ocultas con
origen externo, y archivos incrustados dentro de un PDF.

```bash
curl -X POST https://tu-servicio/v1/scan \
  -d '{"name":"informe.xlsx","bytesBase64":"..."}'
```

```json
{"ok": true, "files": [{
  "file": {"name": "informe.xlsx", "kind": "office", "format": "Excel", "bytesInput": 9473, "sha256Input": "…"},
  "riesgo": "alto", "puntuacion": 75,
  "hallazgos": [{"nivel": "alto", "titulo": "Conexión a una base de datos externa", "detalle": "…"}],
  "recomendacion": "…"
}]}
```

**No es un antivirus.** Mira la estructura del archivo (qué elementos trae), no el
contenido del código: no analiza qué hace una macro, no tiene firmas de malware.

### Herramientas incluidas

```bash
npm run preflight        # antes del primer cobro real: comprueba facilitador, reto 402 y cuenta de token
npm run pagar -- <url> [archivo]   # paga a un servicio x402 desde una cartera local
npm run cartera          # genera el par de carteras de prueba (pagadora + cobradora)
npm run saldo -- 0x...   # saldo de USDC de una dirección, leído de la cadena
npm run prueba:testnet   # circuito completo contra el facilitador real de testnet (no cuesta dinero)
npm run mcp:sell         # expone limpiar_metadatos y evaluar_riesgo como herramientas MCP que cobran por llamada
npm run mcp              # puente MCP que PAGA (para agentes sin cartera propia)
```

Además, si el servicio declara la extensión `bazaar`, los agentes pueden descubrirlo en el catálogo del facilitador (`GET /discovery/resources`). `npm run pagar` avisa cuando el catalogado funciona.

---

## Ponerlo en marcha

Requiere [Bun](https://bun.sh) (o Node 22+).

```bash
cd service
npm install
cp .env.example .env      # rellena X402_PAY_TO (tu dirección de cobro) y el facilitador
npm run preflight         # debe decir "Listo para cobrar de verdad"
npm start                 # http://127.0.0.1:8402
```

Lo único obligatorio es `X402_PAY_TO`: sin dirección de cobro el servicio no arranca (un paywall apuntando a la dirección cero sería un servicio regalado sin avisar).

### Variables principales

| Variable | Por defecto | Qué es |
|---|---|---|
| `X402_PAY_TO` | — | Dirección EVM de cobro (**obligatoria** si cobras en EVM) |
| `X402_PAY_TO_SVM` | — | Dirección de Solana de cobro (**obligatoria** si cobras en Solana) |
| `X402_NETWORKS` | `eip155:84532` | Redes separadas por comas: `eip155:8453` (Base), `solana:5eykt…` |
| `X402_PRICE` | `0.02` | Precio de `/v1/clean` por petición. **Sin `$`**: el cargador de `.env` de Bun expande `$0` y se pierde |
| `X402_PRICE_SCAN` | `0.01` | Precio de `/v1/scan` por petición (mismas reglas que `X402_PRICE`) |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Quien verifica y liquida. Solo testnet; para mainnet, PayAI o CDP |
| `X402_ASSET` / `X402_ASSET_MINT` | USDC | Cobrar en otro token. En EVM tiene que soportar EIP-3009 (USDC, PYUSD, USDP, FDUSD, USDT0). **El USDT clásico no lo soporta**; en Solana vale cualquier SPL |
| `LEDGER_FILE` | vacío | Registro de ventas (una línea JSON por cobro, con tx y pagador). `off` para desactivarlo |
| `PUBLIC_URL` | vacío | Si estás detrás de un proxy o túnel, para que el reto anuncie la URL pública |
| `MAX_FILES`, `MAX_FILE_BYTES`, `MAX_REQUEST_BYTES` | 10 / 32 MB / 64 MB | Límites por petición |

Todo está comentado en `service/.env.example`.

### Despliegue

```bash
railway up     # desde la raíz: el Dockerfile se construye aquí a propósito
```

El `Dockerfile` se construye desde la **raíz** (no desde `service/`) porque el servicio importa `web/*.js`. Escucha en `0.0.0.0` y usa el `$PORT` que le inyecte el host. Si usas `LEDGER_FILE`, monta un volumen (en Railway, `/data`) o el registro se pierde en cada despliegue; el servicio avisa por el log al arrancar si no puede escribir.

## Pruebas

```bash
cd service && npm run test:all
```

**207 comprobaciones** (pasan en Bun y en Node), sin red y sin dinero:

| Fichero | Qué cubre |
|---|---|
| `test/e2e.js` | Reto 402 en dos redes, cobro, replay, pagos mal dirigidos, nombres peligrosos, registro de ventas, descubrimiento (`/v1/clean`) |
| `test/e2e-scan.js` | `/v1/scan`: precio independiente, veredicto de riesgo en fixtures reales, sin cobro si el archivo no se puede leer |
| `test/e2e-svm.js` | Pago en Solana con el cliente oficial |
| `test/e2e-asset.js` | Cobrar con otro token (EVM y Solana) |
| `test/preflight.js` | Los cinco motivos por los que NO debe dejar cobrar |
| `test/mcp.js` | Las dos superficies MCP: la que cobra y la que paga |
| `test/verify-fixtures.js` | Los archivos limpios, validados con los verificadores Python del proyecto |

Los tests usan un **facilitador de pruebas** que verifica de verdad las firmas (EIP-712 en EVM, ed25519 en Solana) pero no mueve dinero, y un RPC de Solana de mentira. Por eso pueden correr sin red.

## Estado

Verificado de punta a punta, con **cobros reales** en testnet y en mainnet:

| | |
|---|---|
| Limpieza, escáner de riesgo, paywall, rechazos sin cobro, doble red, MCP (HTTP y las dos herramientas), registro de ventas | **207 comprobaciones** (`npm run test:all`), sin red y sin dinero |
| `/v1/scan` en testnet real (Base Sepolia, facilitador PayAI) | pago liquidado y confirmado on-chain, precio independiente de `/v1/clean` |
| Liquidación en testnet (Base Sepolia) | transacciones confirmadas y USDC de prueba en la cartera del cobrador |
| Liquidación en **mainnet** (Base) | `/v1/clean` y `/v1/scan`: cada uno con transacción confirmada, importe correcto, gas pagado por el facilitador |
| Descubrimiento | `/v1/clean` y `/v1/scan` aparecen los dos en el catálogo del facilitador, cada uno con su precio (`npm run catalogado`) |

Nota sobre el catálogo: el buscador del facilitador no filtra por texto (devuelve
lo mismo para cualquier consulta); aparece en el listado de recursos.

Lo que queda de aquí en adelante es sobre todo negocio, no código: precio, promoción,
y decidir si se persigue el plan de empresas de la siguiente sección.

## Tesis y hoja de ruta

La apuesta de este proyecto no es "vender limpieza de metadatos a personas": es
probar que **va a haber una economía de agente a agente**, y que se puede cobrar por
ella. La razón de fondo: los agentes de IA van a ser generalistas —no van a
reescribir un limpiador de OOXML/EXIF/PDF cada vez que lo necesiten— y para la
mayoría, pagar unos centavos por una herramienta especializada y ya probada sale
más barato que montarla ellos mismos. Eso es justo lo que ya está demostrado de
punta a punta: venta real en mainnet, liquidación en cadena, catalogado automático
en el directorio de descubrimiento (`npm run catalogado`), sin que intervenga
ninguna persona ni ninguna tarjeta de crédito.

La forma de seguir probando esa tesis, ahora que `/v1/clean` ya está en producción,
es **más microservicios para agentes** — no más productos para personas. El criterio
para elegir cuál construir: algo que un agente no puede hacer bien por sí mismo (no
tiene el parseo, no quiere mantenerlo) o que le sale más barato pagar por llamada que
montarlo. `/v1/scan` (evaluar el riesgo de abrir un archivo, §"Endpoints") es el
primero: reutiliza el mismo motor de análisis de `/v1/clean`, así que fue una
extensión barata y de bajo riesgo, no un proyecto nuevo.

**Esto es lo prioritario.** Lo demás queda anotado como posible implementación
futura, no como el camino que se está siguiendo ahora:

- App gratis para personas (`web/`): ya montada, pero es el embudo hacia la API,
  no un producto de pago aparte.
- Cobro a empresas o despachos con tarjeta y factura (Stripe + CFDI): **aparcado**.
  Tendría sentido el día que haya demanda real, no antes.
- Cuentas, créditos o un plan "Pro" tipo SaaS: **aparcado**, y además
  contradice la promesa de la app gratis (no sube nada, no hay servidor que
  gatear con un paywall).

## Estructura

```
web/                     app del navegador (el motor de limpieza: pdf.js, images.js, ooxml.js, zip.js)
web/risk.js              evalúa el riesgo a partir del mismo análisis (lo usa /v1/scan)
service/src/core.js      el mismo motor, en el servidor
service/src/dom.js       shim DOMParser/XMLSerializer para correr OOXML fuera del navegador
service/src/payments.js  cableado x402: redes, esquemas, descubrimiento
service/src/server.js    API HTTP
service/src/ledger.js    registro de ventas
service/src/wallet.js    cartera del agente (Privy o claves locales, EVM y Solana)
service/src/preflight.js chequeo previo al primer cobro
service/test/            las pruebas y sus dobles (facilitador, RPC, pagos Solana)
verify_clean_*.py        verificadores de los archivos limpios
make_fixture_*.py        generadores de los ficheros de prueba
```
