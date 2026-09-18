// Prueba de extremo a extremo de /v1/scan (evaluación de riesgo).
//
// Mismo montaje que test/e2e.js (servicio real + cliente x402 real + facilitador
// de pruebas), pero centrada en lo que es propio de /v1/scan, no en volver a
// probar el middleware de pago (eso ya lo cubre e2e.js):
//   1. sin pago → 402 con el importe de SCAN, distinto del de CLEAN
//   2. con pago → 200, JSON (nunca ZIP), veredicto correcto en un archivo de
//      riesgo alto real (conexión a base de datos) y en uno de riesgo bajo
//   3. archivo ilegible → 422 y NO se cobra
//   4. el registro de ventas distingue la venta de /v1/scan de la de /v1/clean
//
// Ejecutar: bun test/e2e-scan.js

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
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

const xlsxRiesgoso = new Uint8Array(await readFile(join(RAICES, '_fixture_sucio.xlsx')));
const fotoLimpia = new Uint8Array(await readFile(join(RAICES, '_fixture_foto.jpg')));

const agent = privateKeyToAccount(generatePrivateKey());
const merchant = privateKeyToAccount(generatePrivateKey());

const facilitator = await startStubFacilitator({ networks: ['eip155:84532'] });
const registroVentas = join(tmpdir(), `ventas-e2e-scan-${Date.now()}.jsonl`);
const config = loadConfig({
  LEDGER_FILE: registroVentas,
  X402_NETWORKS: 'eip155:84532',
  X402_PAY_TO: merchant.address,
  X402_PRICE: '$0.02',
  X402_PRICE_SCAN: '$0.01',
  X402_FACILITATOR_URL: facilitator.url,
  PORT: '0',
  HOST: '127.0.0.1',
});
const { url, stop } = await startServer(config);
console.log(`servicio en ${url} · agente ${agent.address} · cobra a ${merchant.address}`);

const client = x402Client.fromConfig({
  schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(agent) }],
});
const fetchPaid = wrapFetchWithPayment(fetch, client);

const upload = (nombre, bytes) => {
  const form = new FormData();
  form.append('file', new File([bytes], nombre));
  return form;
};

try {
  // ---------------------------------------------------------------- 1
  section('1. Sin pago: el reto de /v1/scan es más barato que el de /v1/clean');
  const retoScan = await fetch(`${url}/v1/scan`, { method: 'POST', body: upload('x.xlsx', xlsxRiesgoso) });
  check('responde 402', retoScan.status === 402, `status ${retoScan.status}`);
  const reqScan = decodePaymentRequiredHeader(retoScan.headers.get('payment-required'))?.accepts?.[0];
  check('pide 0.01 USDC (10000 unidades)', reqScan?.amount === '10000', reqScan?.amount);
  check('paga a la dirección del comercio', reqScan?.payTo === merchant.address);

  const retoClean = await fetch(`${url}/v1/clean`, { method: 'POST', body: upload('x.xlsx', xlsxRiesgoso) });
  const reqClean = decodePaymentRequiredHeader(retoClean.headers.get('payment-required'))?.accepts?.[0];
  check('/v1/clean sigue pidiendo 0.02 USDC (20000 unidades): precios independientes',
    reqClean?.amount === '20000', reqClean?.amount);
  check('no se liquidó nada todavía', facilitator.calls.settle.length === 0);

  // ---------------------------------------------------------------- 2
  section('2. Pago válido: veredicto de riesgo alto en un archivo con conexión a base de datos');
  const pagado = await fetchPaid(`${url}/v1/scan`, { method: 'POST', body: upload('cartera.xlsx', xlsxRiesgoso) });
  check('responde 200', pagado.status === 200, `status ${pagado.status}`);
  check('devuelve JSON (nunca ZIP)', (pagado.headers.get('content-type') || '').includes('application/json'),
    pagado.headers.get('content-type'));
  check('se liquidó una sola vez', facilitator.calls.settle.length === 1);
  check('liquidó el importe de scan, no el de clean', facilitator.calls.settle[0]?.amount === '10000');

  const cuerpo = await pagado.json();
  const ficha = cuerpo.files?.[0];
  check('el archivo no se modifica ni se devuelve (solo análisis)', cuerpo.files?.length === 1 && !ficha?.bytesBase64);
  check('describe el archivo analizado', ficha?.file?.name === 'cartera.xlsx', JSON.stringify(ficha?.file));
  check('detecta riesgo alto', ficha?.riesgo === 'alto', JSON.stringify(ficha));
  check('la puntuación es coherente con el veredicto', ficha?.puntuacion >= 40, ficha?.puntuacion);
  check('lista el hallazgo de la conexión a base de datos',
    ficha?.hallazgos?.some((h) => /base de datos/i.test(h.titulo)), JSON.stringify(ficha?.hallazgos));
  check('trae una recomendación en texto', typeof ficha?.recomendacion === 'string' && ficha.recomendacion.length > 0);

  // ---------------------------------------------------------------- 3
  section('3. Una imagen (sin contenido ejecutable) da riesgo bajo');
  const limpio = await fetchPaid(`${url}/v1/scan`, { method: 'POST', body: upload('foto.jpg', fotoLimpia) });
  const cuerpoLimpio = await limpio.json();
  check('responde 200', limpio.status === 200);
  check('riesgo bajo y sin hallazgos', cuerpoLimpio.files?.[0]?.riesgo === 'bajo'
    && cuerpoLimpio.files[0].hallazgos.length === 0, JSON.stringify(cuerpoLimpio.files?.[0]));

  // ---------------------------------------------------------------- 4
  section('4. Archivo ilegible: 422 y NO se cobra');
  const antesDeFallar = facilitator.calls.settle.length;
  const malo = await fetchPaid(`${url}/v1/scan`, {
    method: 'POST',
    body: upload('notas.txt', new TextEncoder().encode('esto no es un documento ni una imagen')),
  });
  check('responde 422', malo.status === 422, `status ${malo.status}`);
  check('NO se liquidó el pago', facilitator.calls.settle.length === antesDeFallar);

  // ---------------------------------------------------------------- 5
  section('5. El registro de ventas identifica el recurso vendido');
  const asientos = (await readFile(registroVentas, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  check('hay dos ventas liquidadas (las dos llamadas a /v1/scan)',
    asientos.filter((a) => a.resultado === 'liquidado').length === 2,
    JSON.stringify(asientos.map((a) => ({ recurso: a.recurso, importe: a.importe }))));
  check('las dos apuntan /v1/scan como recurso, con su propio importe',
    asientos.every((a) => a.recurso?.endsWith('/v1/scan') && a.importe?.startsWith('10000')),
    JSON.stringify(asientos.map((a) => ({ recurso: a.recurso, importe: a.importe }))));

  // ---------------------------------------------------------------- 6
  section('6. Descubrimiento (bazaar) también cataloga /v1/scan');
  const descriptor = await (await fetch(`${url}/`, { headers: { Accept: 'application/json' } })).json();
  check('el descriptor lista el precio de scan por separado', descriptor.precioScan === '$0.01', descriptor.precioScan);
  check('el descriptor documenta el endpoint /v1/scan', !!descriptor.endpoints?.['POST /v1/scan']);
} finally {
  await stop();
  await facilitator.stop();
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
