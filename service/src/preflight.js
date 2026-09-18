// Chequeo previo al primer cobro real.
//
// Comprueba, con la configuración real (.env), las tres cosas que se pueden
// saber ANTES de que un agente pague:
//
//   1. que el facilitador ofrezca la red y el esquema que quieres cobrar
//   2. que el reto 402 salga completo (importe, dirección, y para Solana el
//      fee payer que anuncia el facilitador)
//   3. que la cuenta de token del cobrador exista en Solana (si no, la
//      transferencia falla en cadena: el cliente no la crea)
//
// No mueve dinero ni cobra: es solo lectura. Uso:  node src/preflight.js
// (o `npm run preflight`). Sale con código 1 si algo no está listo.

import { address, createSolanaRpc } from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';

import { loadConfig } from './config.js';
import { esPrincipal } from './es-main.js';
import { aceptes, buildResourceServer } from './payments.js';

const visto = [];
function apunta(ok, red, mensaje, arreglo = null) {
  visto.push({ ok, red, mensaje });
  console.log(`  ${ok ? '✓' : '✗'} [${red}] ${mensaje}`);
  if (!ok && arreglo) console.log(`      → ${arreglo}`);
}

/** ¿Existe la cuenta de token (ATA) del cobrador para ese mint? */
async function revisarAtaSvm(config, red, token) {
  if (!config.svmRpcUrl) {
    console.log(`  · [${red}] sin X402_SVM_RPC_URL: no se puede comprobar la cuenta de token`);
    return;
  }
  const rpc = createSolanaRpc(config.svmRpcUrl);
  const mint = address(token.address);

  const infoMint = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
  if (!infoMint.value) {
    apunta(false, red, `el mint ${token.address} no existe en la red de ${config.svmRpcUrl}`,
      '¿el X402_SVM_RPC_URL apunta a la red correcta (mainnet vs devnet)?');
    return;
  }
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: address(red.payTo),
    tokenProgram: address(infoMint.value.owner),
  });
  const infoAta = await rpc.getAccountInfo(ata, { encoding: 'base64' }).send();
  apunta(!!infoAta.value, red.network,
    infoAta.value
      ? `la cuenta de token del cobrador existe (${ata})`
      : `al cobrador le falta la cuenta de token ${ata}`,
    'abre tu cartera (o la CLI de Privy) y crea la cuenta del token, o envía ahí un poco de ese token una vez: sin la cuenta, la transferencia falla en cadena');
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n[preflight] ${err.message}\n`);
    process.exit(1);
  }

  console.log(`\nServicio: ${config.serviceName} · ${config.price} por petición`);
  console.log(`Facilitador: ${config.facilitatorUrl}`);

  const server = await buildResourceServer(config);
  try {
    await server.initialize();
  } catch (err) {
    console.error(`\n[preflight] el facilitador no responde: ${err.message}\n`);
    process.exit(1);
  }

  console.log('\n1. El facilitador y el reto 402');
  let requisitos;
  try {
    requisitos = await server.buildPaymentRequirementsFromOptions(aceptes(config), {});
  } catch (err) {
    apunta(false, 'config', `no se pudo construir el reto: ${err.message}`);
  }

  for (const red of config.networks) {
    const req = requisitos?.find((r) => r.network === red.network);
    if (!req) {
      apunta(false, red.network, 'el facilitador no ofrece esta red con el esquema "exact"',
        `mira ${config.facilitatorUrl}/supported o cambia X402_FACILITATOR_URL`);
      continue;
    }
    apunta(true, red.network, `importe ${req.amount} de ${req.asset} → ${req.payTo}`);
    if (red.family === 'svm' && !req.extra?.feePayer) {
      apunta(false, red.network, 'el facilitador no anuncia fee payer para Solana',
        'sin fee payer el cliente no puede construir la transacción; usa otro facilitador');
    }
  }

  console.log('\n2. Cuenta de token del cobrador (solo Solana)');
  for (const red of config.networks) {
    if (red.family !== 'svm') continue;
    const req = requisitos?.find((r) => r.network === red.network);
    if (!req) continue;
    await revisarAtaSvm(config, red, { address: req.asset });
  }

  const fallos = visto.filter((v) => !v.ok);
  console.log(`\n${visto.length - fallos.length}/${visto.length} comprobaciones OK`);
  if (fallos.length) {
    console.log('Pendiente antes de cobrar:');
    for (const f of fallos) console.log(` - [${f.red}] ${f.mensaje}`);
    console.log('');
    process.exit(1);
  }
  console.log('Listo para cobrar de verdad.\n');
}

if (esPrincipal(import.meta)) await main();
