// Extremo a extremo con el cliente OFICIAL de Solana (@x402/svm).
//
// A diferencia de test/e2e.js (que arma el payload a mano), aquí paga el cliente
// real: consulta el mint al RPC, construye la transferencia, firma y reintenta la
// petición al recibir el 402. El RPC y el facilitador son de pruebas, pero la
// firma ed25519 y su verificación son reales.
//
// Ejecutar: bun test/e2e-svm.js

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPayment } from '@x402/fetch';

import { readZip } from '../../web/zip.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { loadAgentWallet } from '../src/wallet.js';
import { startStubFacilitator } from './stub-facilitator.js';
import { startStubRpc } from './stub-rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', '_fixture_foto.jpg');
const RED_SVM = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // devnet

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

// Cartera del agente: solo Solana, con su RPC (el de pruebas).
const semilla = crypto.getRandomValues(new Uint8Array(32));
const agente = await createKeyPairSignerFromPrivateKeyBytes(semilla);
const claveBase58 = getBase58Decoder().decode(semilla);
const svmCobrador = (await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)))).address;

const rpc = await startStubRpc();
const facilitator = await startStubFacilitator({ networks: [RED_SVM] });
const config = loadConfig({
  X402_NETWORKS: RED_SVM,
  X402_PAY_TO_SVM: svmCobrador,
  X402_PRICE: '$0.02',
  X402_FACILITATOR_URL: facilitator.url,
  // El servicio incrusta el blockhash del RPC en el reto 402.
  X402_SVM_RPC_URL: rpc.url,
  PORT: '0',
});
const { url, stop } = await startServer(config);
const foto = new Uint8Array(await readFile(FIXTURE));
console.log(`servicio en ${url} · agente Solana ${agente.address} · cobra a ${svmCobrador}\n`);

try {
  // 1) La cartera del agente se carga solo con la clave de Solana.
  const cartera = await loadAgentWallet({
    SVM_PRIVATE_KEY: claveBase58,
    SVM_RPC_URL: rpc.url,
  });
  check('la cartera se carga solo con SVM_PRIVATE_KEY', cartera.origen.includes('Solana'), cartera.origen);
  check('la dirección derivada es la del firmante', cartera.direcciones[0] === agente.address);

  // 2) Reto 402: solo ofrece Solana y con el blockhash ya incrustado.
  const reto = await fetch(`${url}/v1/clean`, { method: 'POST', body: form(foto) });
  check('responde 402', reto.status === 402, `status ${reto.status}`);
  const crudo = reto.headers.get('payment-required');
  const aceptado = decodePaymentRequiredHeader(crudo).accepts[0];
  check('el reto es de la red de Solana', aceptado.network === RED_SVM, aceptado.network);
  check('el reto trae blockhash (el agente no necesita pedirlo)',
    aceptado.extra?.recentBlockhash === rpc.blockhash, aceptado.extra?.recentBlockhash);

  // 3) Pago con el cliente oficial: consulta el mint al RPC, firma y reintenta.
  const client = x402Client.fromConfig({
    schemes: [{ network: 'solana:*', client: new ExactSvmScheme(agente, { rpcUrl: rpc.url }) }],
  });
  const fetchPaid = wrapFetchWithPayment(fetch, client);
  const antes = facilitator.calls.settle.length;
  const pagado = await fetchPaid(`${url}/v1/clean`, { method: 'POST', body: form(foto) });
  check('el cliente oficial paga y recibe 200', pagado.status === 200, `status ${pagado.status}`);
  check('consultó el mint al RPC', rpc.llamadas.getAccountInfo > 0, String(rpc.llamadas.getAccountInfo));
  const liquidacion = decodePaymentResponseHeader(pagado.headers.get('payment-response'));
  check('la liquidación es en Solana', liquidacion?.network === RED_SVM && liquidacion?.success === true,
    JSON.stringify(liquidacion));
  check('se liquidó una vez', facilitator.calls.settle.length === antes + 1);
  check('el pagador es la cartera del agente',
    facilitator.calls.settle.at(-1)?.payer === agente.address,
    facilitator.calls.settle.at(-1)?.payer);
  const zip = await readZip(new Uint8Array(await pagado.arrayBuffer()));
  check('el ZIP trae el archivo limpio', zip.some((e) => e.name === 'foto - sin metadatos.jpg'),
    zip.map((e) => e.name).join(', '));
  const limpio = zip.find((e) => e.name === 'foto - sin metadatos.jpg').data;
  check('y el archivo está limpio (más pequeño, sigue JPEG)',
    limpio.length < foto.length && limpio[0] === 0xff && limpio[1] === 0xd8,
    `${foto.length} → ${limpio.length}`);

  // 4) Un archivo no soportado sigue sin cobrarse.
  const antesMalo = facilitator.calls.settle.length;
  const malo = await fetchPaid(`${url}/v1/clean`, {
    method: 'POST',
    body: form(new TextEncoder().encode('no soy un documento'), 'notas.txt'),
  });
  check('un archivo ilegible responde 422', malo.status === 422, `status ${malo.status}`);
  check('y no se cobra', facilitator.calls.settle.length === antesMalo);
} finally {
  await stop();
  await facilitator.stop();
  await rpc.stop();
}

function form(bytes, nombre = 'foto.jpg') {
  const datos = new FormData();
  datos.append('file', new File([bytes], nombre, { type: 'application/octet-stream' }));
  return datos;
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
