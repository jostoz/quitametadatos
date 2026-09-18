// Prueba de extremo a extremo de /v1/secrets (secretos y credenciales en texto).
//
// Mismo montaje que test/e2e.js y test/e2e-scan.js: servicio real + cliente
// x402 real + facilitador de pruebas. Centrada en lo propio de /v1/secrets:
//   1. sin pago → 402 con el importe de SECRETS, independiente de clean/scan
//   2. con pago → 200, JSON (nunca ZIP), detecta credenciales reales sin
//      falsos positivos en texto limpio
//   3. texto no-UTF8 (binario) → 422/400 y NO se cobra
//   4. el registro de ventas identifica el recurso vendido
//
// Ejecutar: bun test/e2e-secrets.js

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { startStubFacilitator } from './stub-facilitator.js';
import { join } from 'node:path';

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

const TEXTO_SUCIO = [
  'const AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";',
  'const GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";',
  'DATABASE_URL=postgres://admin:sup3rSecret!@db.example.com:5432/prod',
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIBOgIBAAJBAK...',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const TEXTO_LIMPIO = [
  'function suma(a, b) {',
  '  return a + b;',
  '}',
  'const apiUrl = "https://api.example.com/v1/users";',
  'const token = process.env.MY_TOKEN; // viene de env, no está en el código',
].join('\n');

const agent = privateKeyToAccount(generatePrivateKey());
const merchant = privateKeyToAccount(generatePrivateKey());

const facilitator = await startStubFacilitator({ networks: ['eip155:84532'] });
const registroVentas = join(tmpdir(), `ventas-e2e-secrets-${Date.now()}.jsonl`);
const config = loadConfig({
  LEDGER_FILE: registroVentas,
  X402_NETWORKS: 'eip155:84532',
  X402_PAY_TO: merchant.address,
  X402_PRICE: '$0.02',
  X402_PRICE_SCAN: '$0.01',
  X402_PRICE_SECRETS: '$0.01',
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
  section('1. Sin pago: precio de /v1/secrets independiente de clean y scan');
  const reto = await fetch(`${url}/v1/secrets`, {
    method: 'POST', body: upload('deploy.env', new TextEncoder().encode(TEXTO_SUCIO)),
  });
  check('responde 402', reto.status === 402, `status ${reto.status}`);
  const req = decodePaymentRequiredHeader(reto.headers.get('payment-required'))?.accepts?.[0];
  check('pide 0.01 USDC (10000 unidades)', req?.amount === '10000', req?.amount);
  check('paga a la dirección del comercio', req?.payTo === merchant.address);
  check('no se liquidó nada todavía', facilitator.calls.settle.length === 0);

  // ---------------------------------------------------------------- 2
  section('2. Pago válido: detecta credenciales reales, sin ZIP');
  const pagado = await fetchPaid(`${url}/v1/secrets`, {
    method: 'POST', body: upload('deploy.env', new TextEncoder().encode(TEXTO_SUCIO)),
  });
  check('responde 200', pagado.status === 200, `status ${pagado.status}`);
  check('devuelve JSON (nunca ZIP)', (pagado.headers.get('content-type') || '').includes('application/json'));
  check('se liquidó el importe de secrets', facilitator.calls.settle.at(-1)?.amount === '10000');

  const cuerpo = await pagado.json();
  const ficha = cuerpo.files?.[0];
  check('describe el archivo analizado', ficha?.file?.name === 'deploy.env', JSON.stringify(ficha?.file));
  check('no devuelve el texto original ni bytes de salida', !ficha?.bytesBase64 && !ficha?.texto);
  check('detecta riesgo alto', ficha?.riesgo === 'alto', JSON.stringify(ficha));
  const titulos = (ficha?.hallazgos || []).map((h) => h.titulo);
  check('detecta la clave de AWS', titulos.includes('Access key de AWS'), titulos.join(', '));
  check('detecta el token de GitHub', titulos.includes('Token de GitHub'), titulos.join(', '));
  check('detecta la cadena de conexión con contraseña',
    titulos.includes('Cadena de conexión con contraseña'), titulos.join(', '));
  check('detecta la clave privada PEM', titulos.includes('Clave privada (PEM)'), titulos.join(', '));
  check('no expone la credencial en texto plano en la respuesta',
    !JSON.stringify(cuerpo).includes('AKIAIOSFODNN7EXAMPLE'), 'la clave completa no debe aparecer');

  // ---------------------------------------------------------------- 3
  section('3. Texto limpio: sin falsos positivos');
  const limpio = await fetchPaid(`${url}/v1/secrets`, {
    method: 'POST', body: upload('utils.js', new TextEncoder().encode(TEXTO_LIMPIO)),
  });
  const cuerpoLimpio = await limpio.json();
  check('responde 200', limpio.status === 200);
  check('riesgo bajo y sin hallazgos', cuerpoLimpio.files?.[0]?.riesgo === 'bajo'
    && cuerpoLimpio.files[0].hallazgos.length === 0, JSON.stringify(cuerpoLimpio.files?.[0]));

  // ---------------------------------------------------------------- 4
  section('4. Binario (no UTF-8): falla y NO se cobra');
  const antesDeFallar = facilitator.calls.settle.length;
  const binario = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xc3, 0x28]);
  const malo = await fetchPaid(`${url}/v1/secrets`, { method: 'POST', body: upload('foto.jpg', binario) });
  check('responde 400 (no es texto UTF-8)', malo.status === 400, `status ${malo.status}`);
  check('NO se liquidó el pago', facilitator.calls.settle.length === antesDeFallar);

  // ---------------------------------------------------------------- 5
  section('5. El registro de ventas identifica el recurso vendido');
  const asientos = (await readFile(registroVentas, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const liquidadas = asientos.filter((a) => a.resultado === 'liquidado');
  check('hay dos ventas liquidadas (las dos llamadas pagadas)', liquidadas.length === 2,
    JSON.stringify(liquidadas.map((a) => ({ recurso: a.recurso, importe: a.importe }))));
  check('las dos apuntan /v1/secrets como recurso, con su propio importe',
    liquidadas.every((a) => a.recurso?.endsWith('/v1/secrets') && a.importe?.startsWith('10000')),
    JSON.stringify(liquidadas.map((a) => ({ recurso: a.recurso, importe: a.importe }))));

  // ---------------------------------------------------------------- 6
  section('6. Descubrimiento (bazaar) también cataloga /v1/secrets');
  const descriptor = await (await fetch(`${url}/`, { headers: { Accept: 'application/json' } })).json();
  check('el descriptor lista el precio de secrets por separado', descriptor.precioSecrets === '$0.01', descriptor.precioSecrets);
  check('el descriptor documenta el endpoint /v1/secrets', !!descriptor.endpoints?.['POST /v1/secrets']);
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
