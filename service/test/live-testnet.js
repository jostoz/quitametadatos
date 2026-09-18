// Prueba EN VIVO contra el facilitador real de testnet (no requiere dinero).
//
// El servicio no necesita fondos nunca (el gas lo paga el facilitador). Lo único
// que necesita saldo es la cartera del AGENTE, y en testnet ese USDC es gratis
// (faucet de Circle). Este script hace todo el circuito real:
//
//   1. arranca el servicio y pide el 402 al facilitador de verdad
//   2. firma un pago y lo manda a /verify del facilitador real, que lo simula
//      contra el contrato de USDC de Base Sepolia
//   3. si la cartera tiene USDC → cobra de verdad y comprueba el archivo limpio
//      si no tiene     → te dice exactamente eso, sin fallar (falta el faucet)
//
// Uso:  npm run prueba:testnet        (opcional: EVM_PRIVATE_KEY=<cartera>)
// Necesita internet. No gasta dinero: como mucho, USDC de testnet.

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createPublicClient, formatUnits, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZip } from '../../web/zip.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';

const FACILITADOR = process.env.FACILITADOR_URL || 'https://x402.org/facilitator';
const RPC = process.env.RPC_URL || 'https://sepolia.base.org'; // Base Sepolia
const FAUCET = 'https://faucet.circle.com/';
const AQUI = dirname(fileURLToPath(import.meta.url));
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

const cadena = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
/** Saldo de USDC de una dirección, leído de la cadena. null si no se pudo. */
async function saldoUSDC(token, direccion) {
  try {
    return await cadena.readContract({
      address: token, abi: ERC20, functionName: 'balanceOf', args: [direccion],
    });
  } catch {
    return null;
  }
}
const usdc = (v) => (v === null ? '?' : `${formatUnits(v, 6)} USDC`);

/**
 * Espera a que el saldo suba. La liquidación ya está confirmada cuando el
 * facilitador responde, pero el RPC público puede tardar un par de segundos en
 * reflejarlo: sin esto se reporta un fallo que no existe.
 */
async function esperarSaldoMayor(token, direccion, antes, { intentos = 12, esperaMs = 1000 } = {}) {
  let saldo = await saldoUSDC(token, direccion);
  for (let i = 0; i < intentos && (saldo === null || saldo <= antes); i++) {
    await new Promise((r) => setTimeout(r, esperaMs));
    saldo = await saldoUSDC(token, direccion);
  }
  return saldo;
}

const claveDelEntorno = process.env.EVM_PRIVATE_KEY;
const claveNueva = claveDelEntorno ? null : generatePrivateKey();
const agente = privateKeyToAccount(claveDelEntorno || claveNueva);
// Si defines X402_PAY_TO, el cobro va a ESA cartera (así el USDC de prueba acaba
// en una cartera tuya y lo puedes gastar/repetir); si no, se genera una al azar.
const cobradorPedido = (process.env.X402_PAY_TO || '').trim();
const comercio = cobradorPedido ? { address: cobradorPedido } : privateKeyToAccount(generatePrivateKey());

// Un facilitador en localhost es el doble de pruebas: no mueve dinero de verdad.
const esDePruebas = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(FACILITADOR);
console.log(`Facilitador ${esDePruebas ? 'de pruebas' : 'real'}:`, FACILITADOR);
console.log('Cartera del agente:', agente.address, claveDelEntorno ? '(la tuya)' : '(recién generada)');
if (claveNueva) {
  // Sin esto la clave se pierde al terminar el proceso y el USDC que pidas al
  // faucet acabaría en una cartera que ya no puedes usar.
  console.log('Clave privada de esa cartera (de prueba, sin valor):');
  console.log(`   ${claveNueva}`);
  console.log('   guárdala si vas a pedir USDC de prueba para esta dirección.');
}
console.log('Cobra a:', comercio.address, cobradorPedido ? '(tuya)' : '(al azar, no la controla nadie)');

const config = loadConfig({
  X402_PAY_TO: comercio.address,
  X402_NETWORK: 'eip155:84532',
  X402_PRICE: '$0.02',
  X402_FACILITATOR_URL: FACILITADOR,
  PORT: '0',
});
const { url, stop } = await startServer(config);

const foto = new Uint8Array(await readFile(join(AQUI, '..', '..', '_fixture_foto.jpg')));
const formulario = () => {
  const f = new FormData();
  f.append('file', new File([foto], '_fixture_foto.jpg', { type: 'image/jpeg' }));
  return f;
};

try {
  // 1) Reto real
  console.log('1. Pidiendo el reto 402 al servicio (facilitador real)');
  const reto = await fetch(`${url}/v1/clean`, { method: 'POST', body: formulario() });
  if (reto.status !== 402) {
    console.error(`   ✗ esperaba 402 y llegó ${reto.status}`);
    process.exit(1);
  }
  const required = decodePaymentRequiredHeader(reto.headers.get('payment-required'));
  const requisitos = required.accepts[0];
  console.log(`   ✓ ${requisitos.network} · ${requisitos.amount} de ${requisitos.asset} → ${requisitos.payTo}`);

  const token = requisitos.asset;
  if (comercio.address.toLowerCase() === agente.address.toLowerCase()) {
    console.error('   ✗ X402_PAY_TO es la misma cartera que paga: el dinero saldría y entraría');
    console.error('     en la misma cuenta y el saldo no subiría. Usa otra dirección como cobrador.');
    process.exit(1);
  }
  const saldoAgenteAntes = await saldoUSDC(token, agente.address);
  const saldoCobradorAntes = await saldoUSDC(token, comercio.address);
  console.log(`   saldos en cadena → agente ${usdc(saldoAgenteAntes)} · cobrador ${usdc(saldoCobradorAntes)}`);

  // 2) Pago firmado y simulado por el facilitador real
  console.log('\n2. Firmando el pago y pidiéndole al facilitador que lo verifique');
  const cliente = x402Client.fromConfig({
    schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(agente) }],
  });
  const payload = await cliente.createPaymentPayload(required);
  const verificacion = await (await fetch(`${FACILITADOR}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requisitos }),
  })).json();
  console.log(`   facilitador dice: isValid=${verificacion.isValid} (${verificacion.invalidReason || 'ok'})`);

  if (!verificacion.isValid) {
    const faltaSaldo = /insufficient_balance/.test(verificacion.invalidReason || '');
    // El mensaje del facilitador trae el motivo en la segunda línea
    // ("ERC20: transfer amount exceeds balance", "invalid signature"...).
    const lineas = (verificacion.invalidMessage || '').split('\n').map((l) => l.trim()).filter(Boolean);
    console.log(`\n   ${faltaSaldo ? '✓' : '✗'} ${lineas[1] || lineas[0] || verificacion.invalidReason || ''}`);
    if (faltaSaldo) {
      console.log(`\nEl circuito está completo: ${esDePruebas ? 'el facilitador de pruebas' : 'el facilitador real'} simuló tu pago contra el contrato real`);
      console.log('de USDC de Base Sepolia y lo único que falta es saldo. Consigue USDC de prueba');
      console.log('(gratis, sin tarjeta) aquí y mándalo a tu cartera:');
      console.log(`\n   ${FAUCET}   →   red "Base Sepolia"   →   ${agente.address}\n`);
      console.log('Si prefieres el par completo (pagadora + cobradora) y los comandos ya');
      console.log('hechos, en vez de copiarlos a mano:   npm run cartera');
      console.log('\nO repite la prueba con la cartera de arriba:');
      console.log('\n   cmd (Windows):');
      console.log(`      set EVM_PRIVATE_KEY=${claveNueva || process.env.EVM_PRIVATE_KEY}`);
      console.log('      npm run prueba:testnet');
      console.log('\n   bash:');
      console.log(`      EVM_PRIVATE_KEY=${claveNueva || process.env.EVM_PRIVATE_KEY} npm run prueba:testnet\n`);
      process.exit(0);
    }
    process.exit(1);
  }

  // 3) Con saldo: cobro real de punta a punta
  console.log('\n3. La cartera tiene saldo: cobrando de verdad');
  const pagado = await wrapFetchWithPayment(fetch, cliente)(`${url}/v1/clean`, {
    method: 'POST', body: formulario(),
  });
  if (pagado.status !== 200) {
    console.error(`   ✗ esperaba 200 y llegó ${pagado.status}: ${(await pagado.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const liquidacion = decodePaymentResponseHeader(pagado.headers.get('payment-response'));
  console.log(`   ✓ cobrado · liquidación ${liquidacion?.transaction?.slice(0, 18)}… en ${liquidacion?.network}`);
  if (liquidacion?.transaction) {
    console.log(`     compruébalo en la cadena: https://sepolia.basescan.org/tx/${liquidacion.transaction}`);
  }
  const zip = await readZip(new Uint8Array(await pagado.arrayBuffer()));
  const limpio = zip.find((e) => e.name === '_fixture_foto - sin metadatos.jpg');
  console.log(`   ✓ ZIP con ${zip.length} entradas; el archivo limpio pesa ${limpio?.data.length} bytes (original ${foto.length})`);

  const saldoCobradorDespues = await esperarSaldoMayor(token, comercio.address, saldoCobradorAntes ?? 0n);
  const subida = saldoCobradorAntes !== null && saldoCobradorDespues !== null
    ? saldoCobradorDespues - saldoCobradorAntes
    : null;
  console.log(`   saldo del cobrador: ${usdc(saldoCobradorAntes)} → ${usdc(saldoCobradorDespues)}`);
  if (subida === null) {
    console.log('   · no pude leer el saldo en la cadena para confirmarlo');
  } else if (subida > 0n) {
    console.log(`   ✓ el dinero está en la cartera del cobrador (+${usdc(subida)} en la cadena)`);
  } else if (esDePruebas) {
    console.log('   · el facilitador es el doble de pruebas: no mueve dinero de verdad, es lo esperado');
  } else {
    console.log('   ✗ la liquidación dijo OK pero el saldo no subió: revísalo');
    process.exit(1);
  }
  console.log(`\n${subida > 0n
    ? 'PRUEBA EN VIVO COMPLETA: el USDC llegó a la cartera del cobrador y el servicio entregó el archivo limpio.'
    : 'PRUEBA COMPLETA con el facilitador de pruebas: el pago se verificó y el servicio entregó el archivo limpio (sin dinero real).'}\n`);
} finally {
  await stop();
}
