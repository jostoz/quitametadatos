// Cobrar con otro token (no solo USDC).
//
// En Solana vale cualquier SPL (USDC, USDT...). En EVM solo los que soportan
// EIP-3009 (USDC, PYUSD, USDP, FDUSD, USDT0); el USDT clásico no lo soporta, así
// que aquí se prueba con un token EIP-3009 cualquiera, que es lo que de verdad
// valida el mecanismo.
//
// Ejecutar: bun test/e2e-asset.js

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';

import { readZip } from '../../web/zip.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { startServer } from '../src/server.js';
import { startStubFacilitator } from './stub-facilitator.js';
import { startStubRpc } from './stub-rpc.js';
import { cabeceraDePagoSolana } from './svm-payment.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '..', '_fixture_foto.jpg');
const RED_SVM = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

// Un ERC-20 cualquiera con EIP-3009 y su dominio EIP-712 (como USDT0 o PYUSD).
const TOKEN_EVM = privateKeyToAccount(generatePrivateKey()).address;
const DOMINIO_EVM = '{"name":"USDT0","version":"1"}';
const MINT_SVM = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDT de Solana

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

const foto = new Uint8Array(await readFile(FIXTURE));
const formulario = () => {
  const f = new FormData();
  f.append('file', new File([foto], 'foto.jpg', { type: 'image/jpeg' }));
  return f;
};
const retoDe = async (url) => decodePaymentRequiredHeader(
  (await fetch(`${url}/v1/clean`, { method: 'POST', body: formulario() })).headers.get('payment-required'),
);

const rpc = await startStubRpc({ mints: [MINT_SVM] });
const facilitator = await startStubFacilitator({ networks: ['eip155:84532', RED_SVM] });
const agentEvm = privateKeyToAccount(generatePrivateKey());
const merchantEvm = privateKeyToAccount(generatePrivateKey());
const agenteSvm = await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)));
const cobradorSvm = (await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)))).address;

try {
  // ---------------------------------------------------------------- 1
  console.log('\n1. Token propio en las dos redes');
  const config = loadConfig({
    X402_NETWORKS: `eip155:84532,${RED_SVM}`,
    X402_PAY_TO: merchantEvm.address,
    X402_PAY_TO_SVM: cobradorSvm,
    X402_ASSET: TOKEN_EVM,
    X402_ASSET_EXTRA: DOMINIO_EVM,
    X402_ASSET_MINT: MINT_SVM,
    X402_FACILITATOR_URL: facilitator.url,
    X402_SVM_RPC_URL: rpc.url,
    PORT: '0',
  });
  const { url, stop } = await startServer(config);
  console.log(`servicio en ${url}`);

  const reto = await retoDe(url);
  const evm = reto.accepts.find((a) => a.network.startsWith('eip155:'));
  const svm = reto.accepts.find((a) => a.network.startsWith('solana:'));
  check('el reto de EVM anuncia el token configurado', evm?.asset === TOKEN_EVM, evm?.asset);
  check('el reto de EVM lleva el dominio EIP-712', evm?.extra?.name === 'USDT0' && evm?.extra?.version === '1',
    JSON.stringify(evm?.extra));
  check('el reto de Solana anuncia el mint configurado', svm?.asset === MINT_SVM, svm?.asset);
  check('con 6 decimales: 0,02 USD son 20000 unidades',
    evm?.amount === '20000' && svm?.amount === '20000', `${evm?.amount} / ${svm?.amount}`);

  // Pago EVM con el token propio (firma EIP-712 sobre el dominio configurado).
  const antesEvm = facilitator.calls.settle.length;
  const clienteEvm = x402Client.fromConfig({
    schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(agentEvm) }],
    // El cliente solo paga tokens conocidos si no se los autorizas (con red).
    spendControls: {
      maxAmountPerPayment: '$1',
      allowedAssets: [{ network: 'eip155:*', asset: TOKEN_EVM }],
    },
  });
  const pagadoEvm = await wrapFetchWithPayment(fetch, clienteEvm)(`${url}/v1/clean`, {
    method: 'POST', body: formulario(),
  });
  check('el pago EVM con el token propio funciona', pagadoEvm.status === 200, `status ${pagadoEvm.status}`);
  check('se liquidó el importe del token propio',
    facilitator.calls.settle.length === antesEvm + 1
    && facilitator.calls.settle.at(-1)?.amount === '20000',
    JSON.stringify(facilitator.calls.settle.at(-1)));
  const zip = await readZip(new Uint8Array(await pagadoEvm.arrayBuffer()));
  check('y devuelve el archivo limpio', zip.some((e) => e.name === 'foto - sin metadatos.jpg'));

  // Pago Solana con el mint propio, con el cliente oficial.
  const clienteSvm = x402Client.fromConfig({
    schemes: [{ network: 'solana:*', client: new ExactSvmScheme(agenteSvm, { rpcUrl: rpc.url }) }],
    spendControls: {
      maxAmountPerPayment: '$1',
      allowedAssets: [{ network: 'solana:*', asset: MINT_SVM }],
    },
  });
  const antesSvm = facilitator.calls.settle.length;
  const pagadoSvm = await wrapFetchWithPayment(fetch, clienteSvm)(`${url}/v1/clean`, {
    method: 'POST', body: formulario(),
  });
  check('el pago Solana con otro mint funciona', pagadoSvm.status === 200, `status ${pagadoSvm.status}`);
  check('se liquidó en la red de Solana', facilitator.calls.settle.at(-1)?.network === RED_SVM,
    facilitator.calls.settle.at(-1)?.network);
  check('el RPC de pruebas sirvió el mint configurado',
    rpc.llamadas.consultados.includes(MINT_SVM), rpc.llamadas.consultados.join(', '));

  // Pagar con OTRO mint (USDC) cuando se cobra en USDT: rechazado.
  const pagoConOtroMint = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: {
      'PAYMENT-SIGNATURE': await cabeceraDePagoSolana({
        requisitos: svm,
        firmante: agenteSvm,
        feePayer: facilitator.feePayerSvm,
        mint: rpc.usdcDevnet,
      }),
    },
    body: formulario(),
  });
  check('pagar con otro token se rechaza (402)', pagoConOtroMint.status === 402, `status ${pagoConOtroMint.status}`);
  check('el motivo es el token', facilitator.calls.verify.at(-1)?.invalidReason === 'mint_incorrecto',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  await stop();

  // ---------------------------------------------------------------- 2
  console.log('\n2. Sin configurar token, se cobra el USDC de la red (por defecto)');
  const porDefecto = loadConfig({
    X402_NETWORKS: `eip155:84532,${RED_SVM}`,
    X402_PAY_TO: merchantEvm.address,
    X402_PAY_TO_SVM: cobradorSvm,
    X402_FACILITATOR_URL: facilitator.url,
    PORT: '0',
  });
  const { url: url2, stop: stop2 } = await startServer(porDefecto);
  const reto2 = await retoDe(url2);
  check('el USDC de Base Sepolia sigue siendo el de por defecto',
    reto2.accepts[0].asset === '0x036CbD53842c5426634e7929541eC2318f3dCF7e', reto2.accepts[0].asset);
  check('y el USDC de Solana devnet en la otra red',
    reto2.accepts[1].asset === rpc.usdcDevnet, reto2.accepts[1].asset);
  await stop2();

  // ---------------------------------------------------------------- 3
  console.log('\n3. Configuración inválida');
  const malas = [
    ['token EVM que no es dirección', { X402_ASSET: 'USDT', X402_PAY_TO: merchantEvm.address }],
    ['dominio EIP-712 que no es JSON', { X402_ASSET: TOKEN_EVM, X402_ASSET_EXTRA: 'name=USDT0', X402_PAY_TO: merchantEvm.address }],
    ['decimales fuera de rango', { X402_ASSET_DECIMALS: '30', X402_PAY_TO: merchantEvm.address }],
    ['mint de Solana que no es dirección', { X402_ASSET_MINT: 'USDT', X402_NETWORKS: RED_SVM, X402_PAY_TO_SVM: cobradorSvm }],
  ];
  for (const [nombre, env] of malas) {
    let err = null;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    check(`${nombre}: se rechaza al arrancar`, err instanceof ConfigError, err?.message);
  }
} finally {
  await facilitator.stop();
  await rpc.stop();
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
