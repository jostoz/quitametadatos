// ¿Ya llegó el USDC de prueba? Lee el saldo en la cadena.
//
// Uso:  npm run saldo -- 0xDireccion
//       (sin dirección usa X402_PAY_TO; y si no, la del .env)
// Opcional: RPC_URL=https://sepolia.base.org (por defecto) y X402_ASSET para otro token.

import { createPublicClient, formatUnits, http, parseAbi } from 'viem';
import { baseSepolia, base } from 'viem/chains';

const USDC = {
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
};

const direccion = (process.argv[2] || process.env.X402_PAY_TO || '').trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(direccion)) {
  console.error('\nUso: npm run saldo -- 0xTuDireccion\n');
  process.exit(1);
}

const red = process.env.X402_NETWORKS?.split(',')[0]?.trim()
  || process.env.X402_NETWORK?.trim()
  || 'eip155:84532';
const token = (process.env.X402_ASSET || '').trim() || USDC[red] || USDC['eip155:84532'];
const cadena = createPublicClient({
  chain: red === 'eip155:8453' ? base : baseSepolia,
  transport: http(process.env.RPC_URL || (red === 'eip155:8453' ? undefined : 'https://sepolia.base.org')),
});

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const saldo = await cadena.readContract({
  address: token, abi: ERC20, functionName: 'balanceOf', args: [direccion],
}).catch((err) => {
  console.error(`\nNo pude leer la cadena: ${err.message}\n`);
  process.exit(1);
});

const cantidad = Number(formatUnits(saldo, 6));
console.log(`\n${direccion}`);
console.log(`  ${formatUnits(saldo, 6)} USDC · ${red} · token ${token}`);
if (cantidad === 0) console.log('  (sin saldo: si acabas de pedir el faucet, espera un minuto y repite)');
console.log('');
