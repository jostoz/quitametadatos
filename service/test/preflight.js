// Pruebas del chequeo previo (src/preflight.js).
//
// Se ejecuta como proceso hijo (como lo harías tú) y se comprueba tanto el caso
// "listo para cobrar" como los cuatro motivos por los que NO debe dejar cobrar.
//
// Ejecutar: bun test/preflight.js

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import { USDC_DEVNET_ADDRESS } from '@x402/svm';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { startStubFacilitator } from './stub-facilitator.js';
import { startStubRpc } from './stub-rpc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAICES = join(HERE, '..');
const RED_SVM = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

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

/**
 * Ejecuta el preflight con ese entorno y devuelve {codigo, salida}.
 * Tiene que ser asíncrono: el facilitador de pruebas vive en ESTE proceso, así
 * que bloquear el bucle de eventos esperando al hijo sería un abrazo mortal.
 */
function preflight(env) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, ['src/preflight.js'], {
      cwd: RAICES,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    hijo.on('close', (codigo) => resolve({ codigo, salida }));
  });
}

const merchantEvm = privateKeyToAccount(generatePrivateKey()).address;
const cobradorSvm = (await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)))).address;
const [ataDelCobrador] = await findAssociatedTokenPda({
  mint: USDC_DEVNET_ADDRESS,
  owner: cobradorSvm,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
});

const base = {
  X402_PAY_TO: merchantEvm,
  X402_PAY_TO_SVM: cobradorSvm,
  X402_NETWORKS: `eip155:84532,${RED_SVM}`,
  X402_SVM_RPC_URL: '', // se rellena en cada caso
};

// 1) Todo en orden: el cobrador ya tiene su cuenta de token.
console.log('\n1. Todo listo');
{
  const facilitator = await startStubFacilitator({ networks: ['eip155:84532', RED_SVM] });
  const rpc = await startStubRpc({ existentes: [ataDelCobrador] });
  const { codigo, salida } = await preflight({
    ...base,
    X402_FACILITATOR_URL: facilitator.url,
    X402_SVM_RPC_URL: rpc.url,
  });
  check('sale con código 0', codigo === 0, salida);
  check('dice que está listo', /Listo para cobrar de verdad/.test(salida), salida);
  check('avisa de que la cuenta de token existe', /existe/.test(salida));
  await facilitator.stop();
  await rpc.stop();
}

// 2) Falta la cuenta de token en Solana.
console.log('\n2. Falta la cuenta de token en Solana');
{
  const facilitator = await startStubFacilitator({ networks: ['eip155:84532', RED_SVM] });
  const rpc = await startStubRpc(); // ninguna cuenta "existe"
  const { codigo, salida } = await preflight({
    ...base,
    X402_FACILITATOR_URL: facilitator.url,
    X402_SVM_RPC_URL: rpc.url,
  });
  check('sale con código 1', codigo === 1);
  check('explica que falta la cuenta de token', /le falta la cuenta de token/.test(salida), salida);
  check('dice qué hacer', /crea la cuenta del token/.test(salida));
  await facilitator.stop();
  await rpc.stop();
}

// 3) El facilitador no ofrece la red que quieres cobrar.
console.log('\n3. El facilitador no ofrece esa red');
{
  const facilitator = await startStubFacilitator({ networks: ['eip155:84532'] }); // sin Solana
  const { codigo, salida } = await preflight({ ...base, X402_FACILITATOR_URL: facilitator.url });
  check('sale con código 1', codigo === 1);
  check('señala la red que falta', /no ofrece esta red/.test(salida), salida);
  await facilitator.stop();
}

// 4) Facilitador que no anuncia fee payer de Solana.
console.log('\n4. Facilitador sin fee payer de Solana');
{
  const facilitator = await startStubFacilitator({ network: RED_SVM, sinFeePayer: true });
  const rpc = await startStubRpc({ existentes: [ataDelCobrador] });
  const { codigo, salida } = await preflight({
    ...base,
    X402_NETWORKS: RED_SVM,
    X402_FACILITATOR_URL: facilitator.url,
    X402_SVM_RPC_URL: rpc.url,
  });
  check('sale con código 1', codigo === 1);
  check('explica que falta el fee payer', /no anuncia fee payer/.test(salida), salida);
  await facilitator.stop();
  await rpc.stop();
}

// 5) Facilitador caído.
console.log('\n5. Facilitador que no responde');
{
  const { codigo, salida } = await preflight({ ...base, X402_FACILITATOR_URL: 'http://127.0.0.1:1' });
  check('sale con código 1', codigo === 1);
  check('explica que el facilitador no responde', /no responde/.test(salida), salida);
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
