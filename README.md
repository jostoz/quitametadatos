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

Precio por **petición** (no por archivo), hasta 10 archivos y 64 MB. Tres productos, tres precios:

| Producto | Precio por defecto | Qué hace |
|---|---|---|
| `POST /v1/clean` | 0,02 USDC | Limpia los metadatos y devuelve los archivos |
| `POST /v1/scan` | 0,01 USDC | Evalúa el riesgo de abrir un archivo, sin modificarlo |
| `POST /v1/secrets` | 0,01 USDC | Busca credenciales expuestas en texto o código, sin modificarlo |

Se puede cobrar en varias redes a la vez: el agente elige con la cartera que tenga.

**Si el trabajo falla, no se cobra.** El pago se liquida solo cuando el trabajo terminó bien.

### Endpoints

| Método | Ruta | Pago | Qué devuelve |
|---|---|---|---|
| `POST` | `/v1/clean` | **sí** | ZIP con los archivos limpios + `informe.json` (o JSON en base64 con `Accept: application/json`) |
| `POST` | `/v1/scan` | **sí** | JSON con un veredicto de riesgo por archivo (nunca ZIP; no modifica nada) |
| `POST` | `/v1/secrets` | **sí** | JSON con un veredicto de secretos expuestos por archivo (nunca ZIP; no modifica nada) |
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

### `/v1/secrets`: ¿hay credenciales expuestas en este texto?

Mismo espíritu que `/v1/scan` pero antes de compartir, no después de recibir: revisa
texto o código (un `.env`, un diff, un log, un fragmento) en busca de claves y
credenciales antes de pegarlo en un gist, mandarlo a otra API o hacer push. Reglas
deterministas (como gitleaks), nada de IA: cubre claves de AWS, GitHub, Slack,
Stripe, OpenAI, Anthropic, Google, SendGrid y npm, claves privadas PEM, cadenas de
conexión con contraseña y JWT, más una heurística genérica de menor confianza para
"algo que suena a secreto".

```bash
curl -X POST https://tu-servicio/v1/secrets \
  -d '{"name":"deploy.env","bytesBase64":"..."}'
```

```json
{"ok": true, "files": [{
  "file": {"name": "deploy.env", "bytesInput": 183, "sha256Input": "…"},
  "riesgo": "alto", "puntuacion": 100,
  "hallazgos": [{"nivel": "alto", "titulo": "Access key de AWS", "detalle": "1 coincidencia (línea 1). Ejemplo: AKIA************LE"}],
  "recomendacion": "…"
}]}
```

La credencial nunca vuelve completa en la respuesta (se enmascara: `AKIA************LE`).
**No es un escáner exhaustivo**: cubre los formatos de credencial más comunes, no
analiza el significado del texto ni verifica si la credencial sigue siendo válida.

### Herramientas incluidas

```bash
npm run preflight        # antes del primer cobro real: comprueba facilitador, reto 402 y cuenta de token
npm run pagar -- <url> [archivo]   # paga a un servicio x402 desde una cartera local
npm run cartera          # genera el par de carteras de prueba (pagadora + cobradora)
npm run saldo -- 0x...   # saldo de USDC de una dirección, leído de la cadena
npm run prueba:testnet   # circuito completo contra el facilitador real de testnet (no cuesta dinero)
npm run mcp:sell         # expone limpiar_metadatos, evaluar_riesgo y escanear_secretos como herramientas MCP que cobran por llamada
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
| `X402_PRICE_SECRETS` | `0.01` | Precio de `/v1/secrets` por petición (mismas reglas que `X402_PRICE`) |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Quien verifica y liquida. Solo testnet; para mainnet, PayAI o CDP |
| `X402_ASSET` / `X402_ASSET_MINT` | USDC | Cobrar en otro token. En EVM tiene que soportar EIP-3009 (USDC, PYUSD, USDP, FDUSD, USDT0). **El USDT clásico no lo soporta**; en Solana vale cualquier SPL |
| `LEDGER_FILE` | vacío | Registro de ventas (una línea JSON por cobro, con tx y pagador). `off` para desactivarlo |
| `PUBLIC_URL` | vacío | Si estás detrás de un proxy o túnel, para que el reto anuncie la URL pública |
| `MAX_FILES`, `MAX_FILE_BYTES`, `MAX_REQUEST_BYTES` | 10 / 32 MB / 64 MB | Límites por petición |
| `PRODUCTOS` | los tres | Qué productos expone **este** proceso (`clean`, `scan`, `secrets`). Sin la variable, los tres en un solo servicio; con `PRODUCTOS=scan`, solo el de escaneo (ver [Despliegue](#despliegue)) |

Todo está comentado en `service/.env.example`.

### Despliegue

```bash
railway up     # desde la raíz: el Dockerfile se construye aquí a propósito
```

El `Dockerfile` se construye desde la **raíz** (no desde `service/`) porque el servicio importa `web/*.js`. Escucha en `0.0.0.0` y usa el `$PORT` que le inyecte el host. Si usas `LEDGER_FILE`, monta un volumen (en Railway, `/data`) o el registro se pierde en cada despliegue; el servicio avisa por el log al arrancar si no puede escribir.

Dos avisos sobre ese registro, que es el único sitio donde queda la prueba on-chain
de los cobros reales (hash de la transacción, pagador, importe):

- **Descárgalo de vez en cuando.** Railway borra el contenido de los volúmenes
  **30 días** después de que expire un plan Free o Trial (60 si es Hobby).
- **Un volumen por servicio** si acabas desplegando varios: el registro es un
  `.jsonl` al que cada proceso hace `append`, y dos procesos escribiendo el mismo
  fichero se pisan.

### Un servicio o tres, con la misma imagen

El motor es uno solo; qué publica cada proceso lo decide `PRODUCTOS`. Tres
servicios de un producto cada uno, con la misma imagen y el mismo código:

| Servicio | `PRODUCTOS` | Precio | Cartera |
|---|---|---|---|
| `quitametadatos-clean` | `clean` | `X402_PRICE` | `X402_PAY_TO` propia |
| `quitametadatos-scan` | `scan` | `X402_PRICE_SCAN` | `X402_PAY_TO` propia |
| `quitametadatos-secrets` | `secrets` | `X402_PRICE_SECRETS` | `X402_PAY_TO` propia |

```bash
docker build -t quitametadatos .    # una sola imagen para los tres

# cada servicio: su PRODUCTOS, su cartera, su PORT, su PUBLIC_URL
# y su LEDGER_FILE (con SERVICE_NAME distinto, para contabilidad por producto)
```

Son tres microservicios de verdad —cada uno con su URL, su escalado, su entrada
en el catálogo del facilitador y su cartera de cobro— pero **el motor y la
limpieza siguen siendo los mismos ficheros**: no hay tres implementaciones que
se puedan desincronizar. Si un proceso no sirve un producto, esa ruta responde
**404** (no se puede cobrar por lo que no se sirve), su descriptor,
`/v1/pricing`, `/healthz`, su página y sus herramientas MCP hablan solo de sus
productos, y un `PRODUCTOS` con un valor desconocido no arranca el servicio.

Sin `PRODUCTOS`, un proceso expone los tres productos: el despliegue que ya
existe se comporta exactamente igual.

## Pruebas

```bash
cd service && npm run test:all
```

**273 comprobaciones** (pasan en Bun y en Node), sin red y sin dinero:

| Fichero | Qué cubre |
|---|---|
| `test/e2e.js` | Reto 402 en dos redes, cobro, replay, pagos mal dirigidos, nombres peligrosos, registro de ventas, descubrimiento (`/v1/clean`) |
| `test/e2e-scan.js` | `/v1/scan`: precio independiente, veredicto de riesgo en fixtures reales, sin cobro si el archivo no se puede leer |
| `test/e2e-secrets.js` | `/v1/secrets`: precio independiente, detección de credenciales reales sin falsos positivos, sin cobro con texto no-UTF8 |
| `test/e2e-svm.js` | Pago en Solana con el cliente oficial |
| `test/e2e-asset.js` | Cobrar con otro token (EVM y Solana) |
| `test/preflight.js` | Los cinco motivos por los que NO debe dejar cobrar |
| `test/mcp.js` | Las dos superficies MCP: la que cobra y la que paga |
| `test/verify-fixtures.js` | Los archivos limpios, validados con los verificadores Python del proyecto |
| `test/e2e-productos.js` | La separación en microservicios (`PRODUCTOS`): cada proceso publica lo suyo y lo demás da 404, el descriptor y el MCP se recortan, y sin `PRODUCTOS` siguen los tres |

Los tests usan un **facilitador de pruebas** que verifica de verdad las firmas (EIP-712 en EVM, ed25519 en Solana) pero no mueve dinero, y un RPC de Solana de mentira. Por eso pueden correr sin red.

## Estado

Verificado de punta a punta, con **cobros reales** en testnet y en mainnet:

| | |
|---|---|
| Limpieza, escáner de riesgo, escáner de secretos, paywall, rechazos sin cobro, doble red, MCP (HTTP y las tres herramientas), registro de ventas | **273 comprobaciones** (`npm run test:all`), sin red y sin dinero |
| `/v1/scan` y `/v1/secrets` en testnet real (Base Sepolia, facilitador PayAI) | pago liquidado y confirmado on-chain en cada uno, precio independiente de `/v1/clean` |
| Liquidación en testnet (Base Sepolia) | transacciones confirmadas y USDC de prueba en la cartera del cobrador |
| Liquidación en **mainnet** (Base) | `/v1/clean`, `/v1/scan` y `/v1/secrets`: cada uno con transacción confirmada, importe correcto, gas pagado por el facilitador |
| Descubrimiento | los tres productos aparecen en el catálogo del facilitador, cada uno con su precio (`npm run catalogado`) |

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
montarlo. `/v1/scan` (evaluar el riesgo de abrir un archivo) y `/v1/secrets`
(buscar credenciales antes de compartir texto/código) son los dos primeros: los dos
reutilizan motor y patrones ya escritos (`/v1/scan` el análisis de `/v1/clean`;
`/v1/secrets` la misma capa de veredicto de `/v1/scan`), así que fueron extensiones
baratas y de bajo riesgo, no proyectos nuevos.

### El mercado medido (a septiembre de 2026)

La apuesta de arriba es a futuro, así que conviene tener a mano lo que hoy se puede
**medir** —no proyectar— del comercio entre agentes. Todo lo de esta sección es de
terceros, con fuente y fecha; ninguna cifra es estimación propia.

| Dato medido | Cifra | Fuente |
|---|---|---|
| Comercio **agente-a-agente genuino** (quitando autofinanciación y *wash*) | **~$621.000 en 69 días ≈ $9.000/día** en todo el mundo medido | [Agent Almanac](https://agentalmanac.org/economy), 2026-09-17 |
| Proveedores que han cobrado algo, alguna vez | **2.524**, frente a 76.698 listados (**1 de cada 30**) | Agent Almanac |
| Endpoints catalogados que responden | 453 de 484 probados = **0,7% de 74.332** | Agent Almanac |
| Precio mediano *cotizado* / media *cobrada* | **$0,01** / **$0,38** | Agent Almanac |
| Pagos por debajo de 10¢ | **96,9%** (y 52,5% por debajo de 1¢) | Agent Almanac |
| Volumen ajustado de x402 | **$15,0M en 109,6M transacciones = $0,14/petición** | Visa + Artemis, 2026-04-21 |
| Volumen real diario de **todo** el protocolo | **~$28.000–$40.000** | CoinDesk / Major Matters |
| Actividad artificial (autopago, *wash trading*) | **~50%** | Artemis Analytics |
| Comercio real (Categoría 3) | **<5%** del volumen; el resto es señalización | Forkast |
| Confianza del consumidor en que una IA compre sin verificación | **14%** | Product.ai, abril 2026 (n=1.463) |
| A2A en Virtuals ACP, decodificado de los logs de Base | **12.345.880 memos acumulados, pero 21 el 2026-09-17** (base ~200/día) | [agenteconomy.to](https://agenteconomy.to/stats/virtuals-acp-activity) |

**Cuidado con la banda de precio.** La media de $0,14 y la mediana de $0,01 son
promedios de una distribución dominada por llamadas de *señalización* (el 52,5% de los
pagos son de menos de un céntimo), no el precio de los servicios que facturan. En la
lista de los 20 que más ingresan, **ninguno cobra $0,01**: cobran entre $1 y $3.000
por operación. Los dos modelos que hoy funcionan:

| Modelo | Ejemplo real | Números | Ingreso/día |
|---|---|---|---|
| Pocos clientes, ticket alto | `mcp.blocksize.info` (datos de mercado vía MCP) | 12 pagadores × $1.879 | ~$1.361 |
| Muchos pagadores, ticket bajo | Nansen (analítica cripto) | 313 pagadores × 10.067 llamadas a $1,12 | ~$164 |

Y el patrón que domina el catálogo: de 74.332 endpoints, 484 probados y **453
responden**; el resto está muerto. Esa misma lista publica un *"wash hall of shame"*
con servicios de más de $100.000 de volumen bruto cuyo **98,9%–100% sale de un solo
pagador** (BlockRun.AI: $280.534 brutos, 98,9% de un pagador).

**Lo que esto significa para este proyecto:** el cuello de botella no es el precio ni
la falta de productos —es que la economía agéntica todavía no ha llegado—, pero
tampoco está muerta: la x402 Foundation (Linux Foundation, 40 miembros: Visa,
Mastercard, Stripe, Google, Coinbase) está poniendo la tubería. Mantener el servicio
cuesta ~$1,43/mes, así que se mantiene como **opción sobre esa fase siguiente**, y lo
que conviene resolver hoy es el **descubrimiento** (Smithery, registro MCP): es lo
único que mueve la aguja del tráfico. El precio de $0,02 no es el obstáculo —un agente
que paga $7 por una inferencia paga centavos por una limpieza sin pensarlo—; lo que
falta es que ese agente **exista** y que la limpieza sea un paso de su flujo.

### Descubrimiento

Construir los tres productos no sirve de nada si ningún agente de un tercero los
encuentra sin que nosotros movamos el dinero (todas las ventas reales hasta ahora
son autopago, para probar el cobro — no tráfico orgánico). Hecho hasta ahora:

- Repo hecho público otra vez (se privatizó una vez por precaución tras una
  exposición accidental; se auditó **todo el historial de git**, no solo el
  árbol actual, con nuestro propio `scanSecrets()` antes de republicarlo — cero
  secretos reales, solo fixtures de prueba y el email del autor de los commits).
- Enviado a [mcp.directory](https://mcp.directory) (auto-lee metadatos de GitHub,
  publica en 24h).
- PR abierto en [cyberwareX/awesome-x402-mcp-services](https://github.com/cyberwareX/awesome-x402-mcp-services/pull/1)
  (lista nicho: solo servicios MCP que cobran con x402).
- PR abierto en [xpaysh/awesome-x402](https://github.com/xpaysh/awesome-x402/pull/1562)
  (la lista grande del ecosistema, 280+ estrellas — reveló que ya hay cientos de
  microservicios x402 activos, varios en el mismo espacio de seguridad de
  documentos: la competencia por atención es real, no solo el pago).

Pendiente, requiere más que un formulario:

- **Smithery** (más tráfico real de agentes vía su gateway) exige transporte
  **Streamable HTTP** en el MCP, no stdio como tenemos hoy. Es código nuevo
  (`StreamableHTTPServerTransport` del mismo SDK, expuesto como ruta en
  Railway) — tamaño parecido a añadir una cuarta ruta, no solo un listado.
- **Registro oficial de MCP** (`registry.modelcontextprotocol.io`) exige (a)
  login de GitHub por *device flow* — lo tiene que aprobar una persona con su
  navegador, no un agente — y (b) publicar el servidor como paquete de npm
  bajo una cuenta real. Ninguno de los dos es código: son decisiones/acciones
  que le tocan al mantenedor, no al agente.

**Esto es lo prioritario.** Lo demás queda anotado como posible implementación
futura, no como el camino que se está siguiendo ahora:

- App gratis para personas (`web/`): ya montada, pero es el embudo hacia la API,
  no un producto de pago aparte.
- Cobro a empresas o despachos con tarjeta y factura (Stripe + CFDI): **aparcado**.
  Tendría sentido el día que haya demanda real, no antes. (El mercado medido de
  arriba apunta a que ese día puede llegar **antes** por aquí —clientes con
  presupuesto y obligación de cumplir— que por el raíl agéntico, que hoy factura
  ~$9.000/día en todo el mundo medido.)
- Cuentas, créditos o un plan "Pro" tipo SaaS: **aparcado**, y además
  contradice la promesa de la app gratis (no sube nada, no hay servidor que
  gatear con un paywall).

## Estructura

```
web/                     app del navegador (el motor de limpieza: pdf.js, images.js, ooxml.js, zip.js)
web/risk.js              evalúa el riesgo a partir del mismo análisis (lo usa /v1/scan)
web/secrets.js           detecta credenciales expuestas en texto/código (lo usa /v1/secrets)
web/veredicto.js         puntuación y umbrales compartidos por risk.js y secrets.js
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
