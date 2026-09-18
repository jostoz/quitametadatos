// Pruebas de las dos superficies MCP, con pago de verdad (firma EIP-712 real,
// facilitador de pruebas que sí verifica la firma):
//
//  A. Puente MCP que paga la API HTTP (src/mcp.js), conectado por transporte en
//     memoria: se llama a la herramienta y se comprueba el archivo limpio en disco.
//  B. Servicio MCP que cobra por herramienta (src/mcp-service.js): sin pago
//     devuelve "payment required"; con pago ejecuta y liquida.
//
// Ejecutar: bun test/mcp.js

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { x402MCPClient } from '@x402/mcp';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { loadAgentWallet } from '../src/wallet.js';
import { buildServer as buildBridge } from '../src/mcp.js';
import { buildServer as buildPaidService } from '../src/mcp-service.js';
import { startStubFacilitator } from './stub-facilitator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAICES = join(HERE, '..', '..');
const FOTO = join(RAICES, '_fixture_foto.jpg');
const XLSX_RIESGOSO = join(RAICES, '_fixture_sucio.xlsx');

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

const agentKey = generatePrivateKey();
const merchant = privateKeyToAccount(generatePrivateKey());
const walletEnv = { EVM_PRIVATE_KEY: agentKey };

const facilitator = await startStubFacilitator({ network: 'eip155:84532' });
const config = loadConfig({
  X402_PAY_TO: merchant.address,
  X402_FACILITATOR_URL: facilitator.url,
  PORT: '0',
});
const { url, stop } = await startServer(config);
const carpeta = await mkdtemp(join(tmpdir(), 'metaclean-'));
const foto = join(carpeta, 'foto.jpg');
await import('node:fs/promises').then(({ copyFile }) => copyFile(FOTO, foto));
console.log(`servicio en ${url} · agente ${privateKeyToAccount(agentKey).address} · cobra a ${merchant.address}`);

try {
  // ------------------------------------------------------------ A
  console.log('\nA. Puente MCP que paga (src/mcp.js)');
  const cartera = await loadAgentWallet(walletEnv);
  check('la cartera del agente carga desde EVM_PRIVATE_KEY', cartera.origen.includes('clave local'));
  check('el tope por pago es 1 USD', cartera.tope === '$1', cartera.tope);

  const { server: puente } = await buildBridge({ servicioUrl: url, wallet: cartera });
  const [transporteCliente, transporteServidor] = InMemoryTransport.createLinkedPair();
  await puente.connect(transporteServidor);
  const cliente = new Client({ name: 'agente-de-prueba', version: '1.0.0' });
  await cliente.connect(transporteCliente);

  const herramientas = await cliente.listTools();
  check('expone la herramienta limpiar_metadatos',
    herramientas.tools.some((t) => t.name === 'limpiar_metadatos'),
    herramientas.tools.map((t) => t.name).join(', '));

  const antes = facilitator.calls.settle.length;
  const resultado = await cliente.callTool({
    name: 'limpiar_metadatos',
    arguments: { ruta: foto },
  });
  check('la llamada MCP funciona', !resultado.isError, JSON.stringify(resultado.content?.[0]).slice(0, 200));
  const texto = resultado.content.map((c) => c.text).join('\n');
  check('informa de la ruta del archivo limpio', texto.includes('Archivo limpio:'), texto.slice(0, 200));
  check('el puente pagó al servicio', facilitator.calls.settle.length === antes + 1);

  const limpio = join(carpeta, 'foto - sin metadatos.jpg');
  const info = await stat(limpio);
  check('el archivo limpio existe en disco', info.size > 0);
  check('el archivo limpio es más pequeño que el original',
    info.size < (await stat(foto)).size, `${(await stat(foto)).size} → ${info.size}`);
  const bytes = new Uint8Array(await readFile(limpio));
  check('sigue siendo un JPEG válido', bytes[0] === 0xff && bytes[1] === 0xd8);
  check('el informe dice qué se quitó', /eliminado/.test(texto) && /GPS|EXIF/i.test(texto));

  await cliente.close();

  // ------------------------------------------------------------ B
  console.log('\nB. Servicio MCP que cobra (src/mcp-service.js)');
  const { server: servicio } = await buildPaidService(config);
  const [tc2, ts2] = InMemoryTransport.createLinkedPair();
  await servicio.connect(ts2);

  const pagador = await loadAgentWallet(walletEnv);
  const clienteMCP = new Client({ name: 'agente-que-paga', version: '1.0.0' });
  await clienteMCP.connect(tc2);

  const fotoBase64 = Buffer.from(new Uint8Array(await readFile(foto))).toString('base64');
  const argumentos = { nombre: 'foto.jpg', bytesBase64: fotoBase64 };

  const antesCobro = facilitator.calls.settle.length;
  const sinPago = await clienteMCP.callTool({ name: 'limpiar_metadatos', arguments: argumentos });
  const textoReto = sinPago.content.map((c) => c.text).join('\n');
  check('sin pago la herramienta responde "payment required"',
    sinPago.isError === true && /Payment required|x402Version/.test(textoReto),
    textoReto.slice(0, 160));
  check('el reto incluye importe y destinatario',
    textoReto.includes('20000') && textoReto.includes(merchant.address), textoReto.slice(0, 300));
  check('sin pago NO se ejecuta la herramienta (no hay archivo limpio)',
    !/base64, \d+ bytes/.test(textoReto));
  check('y no se cobró nada', facilitator.calls.settle.length === antesCobro);

  const conPago = new x402MCPClient(clienteMCP, pagador.client);
  const pagado = await conPago.callTool('limpiar_metadatos', argumentos);
  check('con pago la herramienta responde', !pagado.isError, JSON.stringify(pagado.content?.[0]).slice(0, 300));
  const salida = pagado.content.map((c) => c.text).join('\n');
  check('devuelve el informe en JSON', /"ok":true/.test(salida) || /"ok": true/.test(salida), salida.slice(0, 200));
  const base64Limpio = (salida.match(/base64, (\d+) bytes\):\n([A-Za-z0-9+/=]+)/) || [])[2];
  check('devuelve el archivo limpio en base64', !!base64Limpio);
  if (base64Limpio) {
    const limpio = Buffer.from(base64Limpio, 'base64');
    check('el archivo limpio es más pequeño', limpio.length < fotoBase64.length * 0.75);
    check('y sigue siendo JPEG', limpio[0] === 0xff && limpio[1] === 0xd8);
  }
  check('el servicio MCP cobró una vez', facilitator.calls.settle.length === antesCobro + 1);
  check('cobró el importe pedido', facilitator.calls.settle.at(-1)?.amount === '20000');
  check('cobró al comercio', facilitator.calls.settle.at(-1)?.payTo === merchant.address);

  const malo = await conPago.callTool('limpiar_metadatos', {
    nombre: 'notas.txt',
    bytesBase64: Buffer.from('esto no es un documento').toString('base64'),
  });
  check('un archivo ilegible devuelve error', malo.isError === true, JSON.stringify(malo.content).slice(0, 200));
  check('y no se cobra por el intento fallido', facilitator.calls.settle.length === antesCobro + 1);

  // ------------------------------------------------------------ C
  console.log('\nC. Herramienta evaluar_riesgo (mismo servicio, precio distinto)');
  const herramientasServicio = await clienteMCP.listTools();
  check('expone la herramienta evaluar_riesgo',
    herramientasServicio.tools.some((t) => t.name === 'evaluar_riesgo'),
    herramientasServicio.tools.map((t) => t.name).join(', '));

  const xlsxBase64 = Buffer.from(new Uint8Array(await readFile(XLSX_RIESGOSO))).toString('base64');
  const argRiesgo = { nombre: 'cartera.xlsx', bytesBase64: xlsxBase64 };

  const sinPagoRiesgo = await clienteMCP.callTool({ name: 'evaluar_riesgo', arguments: argRiesgo });
  const textoRetoRiesgo = sinPagoRiesgo.content.map((c) => c.text).join('\n');
  check('sin pago pide el importe de scan (10000), no el de clean',
    sinPagoRiesgo.isError === true && textoRetoRiesgo.includes('10000') && !textoRetoRiesgo.includes('20000'),
    textoRetoRiesgo.slice(0, 300));

  const antesRiesgo = facilitator.calls.settle.length;
  const pagadoRiesgo = await conPago.callTool('evaluar_riesgo', argRiesgo);
  check('con pago responde sin error', !pagadoRiesgo.isError, JSON.stringify(pagadoRiesgo.content?.[0]).slice(0, 300));
  const salidaRiesgo = pagadoRiesgo.content.map((c) => c.text).join('\n');
  check('detecta riesgo alto en el archivo con conexión a base de datos',
    /"riesgo":"alto"/.test(salidaRiesgo), salidaRiesgo.slice(0, 300));
  check('no devuelve el archivo (solo el veredicto)', !/bytesBase64/.test(salidaRiesgo));
  check('cobró el importe de scan, no el de clean', facilitator.calls.settle.at(-1)?.amount === '10000');
  check('la llamada anterior (limpiar_metadatos) y esta suman dos cobros distintos',
    facilitator.calls.settle.length === antesRiesgo + 1);

  await clienteMCP.close();
} finally {
  await stop();
  await facilitator.stop();
  await rm(carpeta, { recursive: true, force: true });
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
