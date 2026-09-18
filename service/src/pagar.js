// Paga a un servicio x402 desde una cartera local. Sirve para comprobar que TU
// servicio cobra de verdad, desde fuera, como lo haría un agente.
//
// Uso:  npm run pagar -- <url> [archivo]
//       EVM_PRIVATE_KEY=<clave que paga>   (obligatoria; en testnet, de faucet)
//
// Envía el archivo, resuelve el 402 solo (firma EIP-712), y cuenta lo que pasó:
// la liquidación, el importe y el archivo limpio que devuelve el servicio.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

import { createPublicClient, formatUnits, http, parseAbi } from 'viem';
import { base, baseSepolia } from 'viem/chains';

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

// Validar la clave aquí y no dentro de viem: su error ("expected hex or 32 bytes")
// no dice qué hacer, y es fácil pegar un texto de ejemplo o un hash.
const bruta = process.env.EVM_PRIVATE_KEY.trim();
const clave = bruta.startsWith('0x') ? bruta : `0x${bruta}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(clave)) {
  console.error('\nEVM_PRIVATE_KEY no parece una clave privada de una cartera EVM.');
  console.error(`  Debe ser 0x + 64 dígitos hexadecimales (recibido "${bruta.slice(0, 14)}…", ${bruta.length} caracteres).`);
  if (/^(0x)?(TU_|your|xxx|abc|123)/i.test(bruta)) {
    console.error('  Parece un texto de ejemplo: sustitúyelo por la clave real de tu cartera.');
  }
  console.error('\n  ¿No quieres usar la clave de tu cartera principal? Genera una desechable:');
  console.error('     npm run cartera        (te da dirección y clave, y a dónde mandarle USDC)\n');
  process.exit(1);
}
const pagador = privateKeyToAccount(clave);
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

// 1b) ¿Tiene saldo? Mejor saberlo antes de intentar pagar.
const RPC = {
  'eip155:8453': { chain: base, url: process.env.RPC_URL || 'https://mainnet.base.org' },
  'eip155:84532': { chain: baseSepolia, url: process.env.RPC_URL || 'https://sepolia.base.org' },
};
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
for (const a of (reto.status === 402 ? (decodePaymentRequiredHeader(reto.headers.get('payment-required')).accepts || []) : [])) {
  const red = RPC[a.network];
  if (!red) continue;
  try {
    const cadena = createPublicClient({ chain: red.chain, transport: http(red.url) });
    const saldo = await cadena.readContract({ address: a.asset, abi: ERC20, functionName: 'balanceOf', args: [pagador.address] });
    const falta = BigInt(a.amount) - saldo;
    if (falta > 0n) {
      console.log(`  saldo del pagador: ${formatUnits(saldo, 6)} USDC — faltan ${formatUnits(falta, 6)} para pagar en ${a.network}`);
      console.log(`  manda USDC (${a.network === 'eip155:8453' ? 'red Base' : 'Base Sepolia'}) a ${pagador.address} y repite.`);
      if (a.network === 'eip155:84532') console.log('  en testnet es gratis: https://faucet.circle.com');
      process.exit(1);
    }
    console.log(`  saldo del pagador: ${formatUnits(saldo, 6)} USDC ✓`);
  } catch (err) {
    console.log(`  (no pude leer el saldo: ${err.message.slice(0, 60)})`);
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

// El facilitador dice por esta cabecera si catalogó el servicio en el "bazaar"
// (el catálogo con el que los agentes encuentran APIs x402).
const extensiones = pagado.headers.get('extension-responses');
if (extensiones) {
  try {
    const d = JSON.parse(Buffer.from(extensiones, 'base64').toString('utf8'));
    for (const [nombre, r] of Object.entries(d)) {
      console.log(`Extensión ${nombre}: ${r.status}${r.rejectedReason ? ` (${r.rejectedReason})` : ''}`);
      if (nombre === 'bazaar' && r.status === 'success') {
        console.log('  → el servicio quedó catalogado para que otros agentes lo encuentren');
      }
    }
  } catch { /* cabecera no legible: no es crítico */ }
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
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, limpio.data);
    console.log(`\nGuardado: ${destino} (original ${foto.length} → ${limpio.data.length} bytes)`);
  }
} else {
  console.log(`\nRespuesta de ${bytes.length} bytes (no es un ZIP)`);
  console.log(new TextDecoder().decode(bytes).slice(0, 500));
}
