// Paga a un servicio x402 desde una cartera local. Sirve para comprobar que TU
// servicio cobra de verdad, desde fuera, como lo haría un agente.
//
// Uso:  npm run pagar -- <url> [archivo]
//       EVM_PRIVATE_KEY=<clave que paga>   (obligatoria; en testnet, de faucet)
//
// Envía el archivo, resuelve el 402 solo (firma EIP-712), y cuenta lo que pasó:
// la liquidación, el importe y el archivo limpio que devuelve el servicio.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

import { readZip } from '../../web/zip.js';

const url = process.argv[2];
if (!url) {
  console.error('\nUso: npm run pagar -- <url del servicio> [archivo]\n');
  process.exit(1);
}
if (!process.env.EVM_PRIVATE_KEY) {
  console.error('\nFalta EVM_PRIVATE_KEY (la cartera que paga). En testnet puedes pedir USDC de prueba en https://faucet.circle.com\n');
  process.exit(1);
}

const archivo = resolve(process.argv[3] || '_fixture_foto.jpg');
const pagador = privateKeyToAccount(process.env.EVM_PRIVATE_KEY.startsWith('0x')
  ? process.env.EVM_PRIVATE_KEY
  : `0x${process.env.EVM_PRIVATE_KEY}`);
console.log(`Pagador: ${pagador.address}\nServicio: ${url}\nArchivo: ${archivo}\n`);

const formulario = () => {
  const f = new FormData();
  f.append('file', new File([foto], basename(archivo), { type: 'application/octet-stream' }));
  return f;
};
const foto = new Uint8Array(await readFile(archivo));

// 1) Qué pide el servicio
const reto = await fetch(url, { method: 'POST', body: formulario() });
if (reto.status !== 402) {
  console.log(`El servicio respondió ${reto.status} sin pedir pago (¿tienes ya un pago válido?).`);
} else {
  const d = decodePaymentRequiredHeader(reto.headers.get('payment-required'));
  for (const a of d.accepts) {
    console.log(`  pide ${Number(a.amount) / 1e6} USDC en ${a.network} → ${a.payTo}`);
  }
}

// 2) Pagar (el cliente firma y reintenta solo)
const cliente = x402Client.fromConfig({
  schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(pagador) }],
  spendControls: { maxAmountPerPayment: `$${process.env.MAX_USD_POR_PAGO || '1'}` },
});
const pagado = await wrapFetchWithPayment(fetch, cliente)(url, { method: 'POST', body: formulario() });
console.log(`\nRespuesta: ${pagado.status} ${pagado.headers.get('content-type')}`);
const cabecera = pagado.headers.get('payment-response');
if (cabecera) {
  const l = decodePaymentResponseHeader(cabecera);
  console.log(`Liquidación: ${l.success ? 'OK' : 'FALLÓ'} · ${l.network} · tx ${l.transaction}`);
}

if (pagado.status !== 200) {
  console.error(`\nNo se completó: ${(await pagado.text()).slice(0, 300)}`);
  process.exit(1);
}

// 3) El archivo limpio
const bytes = new Uint8Array(await pagado.arrayBuffer());
if (pagado.headers.get('content-type')?.includes('zip')) {
  const zip = await readZip(bytes);
  for (const e of zip) console.log(`  ZIP → ${e.name} (${e.data.length} bytes)`);
  const limpio = zip.find((e) => !e.name.endsWith('.json'));
  if (limpio) {
    const destino = resolve(`_out/${basename(limpio.name)}`);
    await writeFile(destino, limpio.data);
    console.log(`\nGuardado: ${destino} (original ${foto.length} → ${limpio.data.length} bytes)`);
  }
} else {
  console.log(`\nRespuesta de ${bytes.length} bytes (no es un ZIP)`);
  console.log(new TextDecoder().decode(bytes).slice(0, 500));
}
