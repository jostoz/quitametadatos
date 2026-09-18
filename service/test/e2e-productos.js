// Prueba de la separación en microservicios (variable PRODUCTOS).
//
// El objetivo: la MISMA imagen y el MISMO motor tienen que poder desplegarse
// como un servicio con los tres productos o como tres servicios de uno solo,
// sin duplicar código. Aquí se comprueba que un proceso con PRODUCTOS=scan es
// de verdad el microservicio de escaneo:
//
//   1. publica su ruta y solo la suya: las demás dan 404, no 402 (no se puede
//      cobrar por lo que no se sirve)
//   2. su descriptor, /v1/pricing y /healthz hablan solo de sus productos
//   3. cobra su precio, liquida una sola vez y devuelve el veredicto
//   4. la página para navegadores no presume de lo que no sirve
//   5. la superficie MCP también se recorta (una herramienta, no tres)
//   6. un PRODUCTOS inválido no arranca, y el mensaje dice qué valores valen
//   7. sin PRODUCTOS siguen estando los tres: un despliegue ya existente no cambia
//
// Ejecutar: bun test/e2e-productos.js

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';

import { loadConfig, ConfigError } from '../src/config.js';
import { startServer } from '../src/server.js';
import { buildServer as buildServicioMCP } from '../src/mcp-service.js';
import { startStubFacilitator } from './stub-facilitator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAICES = join(HERE, '..', '..');

let ok = 0;
const fallos = [];
function check(nombre, condicion, detalle = '') {
  if (condicion) {
    ok++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos.push(nombre);
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function section(titulo) {
  console.log(`\n${titulo}`);
}

const agent = privateKeyToAccount(generatePrivateKey());
const merchant = privateKeyToAccount(generatePrivateKey());
const facilitator = await startStubFacilitator({ network: 'eip155:84532' });

const cliente = x402Client.fromConfig({
  schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(agent) }],
});
const fetchPaid = wrapFetchWithPayment(fetch, cliente);

const ENV_BASE = {
  X402_NETWORKS: 'eip155:84532',
  X402_PAY_TO: merchant.address,
  X402_PRICE: '$0.02',
  X402_PRICE_SCAN: '$0.01',
  X402_PRICE_SECRETS: '$0.01',
  X402_FACILITATOR_URL: facilitator.url,
  PORT: '0',
  HOST: '127.0.0.1',
};

/** Levanta un servicio con los productos indicados (sin argumento: PRODUCTOS sin definir). */
async function montar(productos) {
  const env = { ...ENV_BASE };
  if (productos !== undefined) env.PRODUCTOS = productos;
  const config = loadConfig(env);
  const { url, stop } = await startServer(config);
  return { url, config, stop };
}

/** POST sin cabecera de pago: sirve para ver si la ruta existe (402) o no (404). */
const sinPagar = (url, ruta) => fetch(`${url}${ruta}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"name":"x.png","bytesBase64":"aGk="}',
});

const jsonDe = async (url, ruta = '/') => (await fetch(`${url}${ruta}`)).json();

/** Herramientas MCP que anuncia un servicio (transporte en memoria, sin stdio). */
async function herramientasMCP(config) {
  const servicio = await buildServicioMCP(config);
  const [transporteCliente, transporteServidor] = InMemoryTransport.createLinkedPair();
  await servicio.connect(transporteServidor);
  const mcp = new Client({ name: 'agente-de-prueba', version: '1.0.0' });
  await mcp.connect(transporteCliente);
  const nombres = (await mcp.listTools()).tools.map((t) => t.name);
  await mcp.close();
  return nombres;
}

// ---------------------------------------------------------------- 1
section('1. PRODUCTOS=scan: este proceso es el microservicio de escaneo');
const soloScan = await montar('scan');
{
  const reto = await sinPagar(soloScan.url, '/v1/scan');
  check('POST /v1/scan existe y cobra (402)', reto.status === 402, `status ${reto.status}`);

  const limpieza = await sinPagar(soloScan.url, '/v1/clean');
  const secretos = await sinPagar(soloScan.url, '/v1/secrets');
  check('POST /v1/clean responde 404: en este proceso no existe',
    limpieza.status === 404, `status ${limpieza.status}`);
  check('POST /v1/secrets responde 404: en este proceso no existe',
    secretos.status === 404, `status ${secretos.status}`);
  check('y no se liquidó nada por las rutas que no existen', facilitator.calls.settle.length === 0);

  const info = await jsonDe(soloScan.url);
  check('GET / dice qué productos sirve',
    JSON.stringify(info.productos) === '["scan"]', JSON.stringify(info.productos));
  check('GET / anuncia el precio de scan', info.precioScan === '$0.01', String(info.precioScan));
  check('GET / NO anuncia el precio de la limpieza', info.precio === undefined, String(info.precio));
  check('GET / NO anuncia el precio de los secretos', info.precioSecrets === undefined, String(info.precioSecrets));
  const rutasDocumentadas = Object.keys(info.endpoints).filter((k) => k.startsWith('POST '));
  check('GET / solo documenta la ruta que sirve',
    rutasDocumentadas.join() === 'POST /v1/scan', rutasDocumentadas.join());
  check('GET / no anuncia las "options" de la limpieza', info.opciones === undefined);

  const precios = await jsonDe(soloScan.url, '/v1/pricing');
  check('GET /v1/pricing: solo el precio de scan',
    precios.precioScan === '$0.01' && precios.precio === undefined && precios.precioSecrets === undefined,
    JSON.stringify(precios));
  check('GET /healthz dice qué sirve',
    (await jsonDe(soloScan.url, '/healthz')).productos.join() === 'scan');

  const html = await (await fetch(`${soloScan.url}/`, { headers: { Accept: 'text/html' } })).text();
  check('la página humana dice el precio de lo que sí sirve',
    /Precio:/.test(html) && html.includes('$0.01'), html.slice(0, 80));
  check('y no presume de las rutas que no sirve',
    !html.includes('/v1/clean') && !html.includes('/v1/secrets'));
  check('ni presume del precio de la limpieza', !html.includes('$0.02'));

  // El pago de verdad: una liquidación, con el importe de scan.
  const antes = facilitator.calls.settle.length;
  const xlsx = new Uint8Array(await readFile(join(RAICES, '_fixture_sucio.xlsx')));
  const formulario = new FormData();
  formulario.append('file', new File([xlsx], '_fixture_sucio.xlsx'));
  const pagado = await fetchPaid(`${soloScan.url}/v1/scan`, { method: 'POST', body: formulario });
  const cuerpo = await pagado.json();
  check('con pago responde 200 y devuelve el veredicto',
    pagado.status === 200 && !!cuerpo.files?.[0]?.riesgo, `status ${pagado.status}`);
  check('se liquidó exactamente una vez', facilitator.calls.settle.length === antes + 1);
  check('el importe cobrado es el de scan (10000 unidades base)',
    facilitator.calls.settle.at(-1)?.amount === '10000', String(facilitator.calls.settle.at(-1)?.amount));

  // La superficie MCP se recorta igual que la HTTP.
  const herramientas = await herramientasMCP(soloScan.config);
  check('el servicio MCP expone solo la herramienta de scan',
    herramientas.join() === 'evaluar_riesgo', herramientas.join());
}
await soloScan.stop();

// ---------------------------------------------------------------- 2
section('2. PRODUCTOS=clean,secrets: dos productos en un proceso, sin el tercero');
const par = await montar('clean,secrets');
{
  check('/v1/clean cobra (402)', (await sinPagar(par.url, '/v1/clean')).status === 402);
  check('/v1/secrets cobra (402)', (await sinPagar(par.url, '/v1/secrets')).status === 402);
  check('/v1/scan responde 404', (await sinPagar(par.url, '/v1/scan')).status === 404);

  const precios = await jsonDe(par.url, '/v1/pricing');
  check('el precio del producto ausente no aparece', precios.precioScan === undefined, String(precios.precioScan));
  check('los dos presentes sí, con su importe',
    precios.precio === '$0.02' && precios.precioSecrets === '$0.01', JSON.stringify(precios));
  check('el orden canónico no depende de cómo se escriba PRODUCTOS',
    JSON.stringify((await jsonDe(par.url)).productos) === '["clean","secrets"]',
    JSON.stringify((await jsonDe(par.url)).productos));

  const herramientas = await herramientasMCP(par.config);
  check('el servicio MCP expone las herramientas de esos dos productos',
    herramientas.join() === 'limpiar_metadatos,escanear_secretos', herramientas.join());
}
await par.stop();

// ---------------------------------------------------------------- 3
section('3. PRODUCTOS inválido: no arranca y el mensaje dice qué valores valen');
for (const valor of ['limpiar', ',', 'scan,limpieza']) {
  let fallo = null;
  try {
    loadConfig({ ...ENV_BASE, PRODUCTOS: valor });
  } catch (err) {
    fallo = err;
  }
  check(`PRODUCTOS="${valor}" falla con un ConfigError`, fallo instanceof ConfigError, fallo?.message);
  check('y el mensaje nombra los productos que sí valen',
    !!fallo && /clean, scan, secrets/.test(fallo.message), fallo?.message);
}

// ---------------------------------------------------------------- 4
section('4. Sin PRODUCTOS: los tres, como siempre (un despliegue ya existente no cambia)');
const completo = await montar(undefined);
{
  const estados = [];
  for (const ruta of ['/v1/clean', '/v1/scan', '/v1/secrets']) {
    estados.push(`${ruta}:${(await sinPagar(completo.url, ruta)).status}`);
  }
  check('las tres rutas existen y cobran',
    estados.join(' ') === '/v1/clean:402 /v1/scan:402 /v1/secrets:402', estados.join(' '));

  const info = await jsonDe(completo.url, '/v1/pricing');
  check('el descriptor anuncia los tres precios',
    info.precio === '$0.02' && info.precioScan === '$0.01' && info.precioSecrets === '$0.01',
    JSON.stringify(info));
  check('las tres rutas documentadas',
    Object.keys((await jsonDe(completo.url)).endpoints).filter((k) => k.startsWith('POST ')).length === 3);
  check('el servicio MCP expone las tres herramientas',
    (await herramientasMCP(completo.config)).length === 3);
}
await completo.stop();

await facilitator.stop();

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}