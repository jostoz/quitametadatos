// Configuración del servicio, toda por variables de entorno.
//
// Se puede cobrar en varias redes a la vez: cada red en la lista de
// X402_NETWORKS añade una opción al reto 402 y el agente elige con qué cartera
// paga. Cada familia necesita su dirección de cobro:
//
//   X402_NETWORKS=eip155:8453,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
//   X402_PAY_TO=0x...            (EVM)
//   X402_PAY_TO_SVM=<base58>     (Solana)
//
// Al menos una dirección de cobro es obligatoria: un paywall apuntando a la
// dirección cero sería un servicio regalado sin avisar.

import { getAddress, isAddress } from 'viem';
import { address as svmAddress } from '@solana/kit';

import { ledgerFile } from './ledger.js';

export const DEFAULTS = Object.freeze({
  network: 'eip155:84532', // Base Sepolia (pruebas con USDC de faucet)
  price: '$0.02',
  priceScan: '$0.01',
  facilitatorUrl: 'https://x402.org/facilitator',
  host: '127.0.0.1',
  port: 8402,
  maxFiles: 10,
  maxFileBytes: 32 * 1024 * 1024,
  maxRequestBytes: 64 * 1024 * 1024,
  maxJsonOutputBytes: 8 * 1024 * 1024,
});

export const MAINNET_NETWORK = 'eip155:8453';
export const TESTNET_NETWORK = 'eip155:84532';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function int(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} debe ser un entero positivo (recibido "${raw}").`);
  }
  return value;
}

function port(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(`${key} debe ser un puerto entre 0 y 65535 (recibido "${raw}").`);
  }
  return value;
}

/** Familia de una red CAIP-2: 'evm' (eip155) o 'svm' (solana). */
export function familyOf(network) {
  if (/^eip155:\d+$/.test(network)) return 'evm';
  if (/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(network)) return 'svm';
  return null;
}

const CAMPO_PAGO = { evm: 'X402_PAY_TO', svm: 'X402_PAY_TO_SVM' };

/**
 * Token con el que se cobra en cada familia. Por defecto el USDC de esa red
 * (el que conoce el SDK). Con X402_ASSET / X402_ASSET_MINT se puede cobrar otro:
 *  - EVM: tiene que soportar EIP-3009 (transferWithAuthorization), como USDC,
 *    PYUSD, USDP, FDUSD o USDT0. El USDT clásico NO lo soporta.
 *  - Solana: vale cualquier SPL (USDC, USDT...).
 */
function tokens(env) {
  const decimales = env.X402_ASSET_DECIMALS ? Number(env.X402_ASSET_DECIMALS) : 6;
  if (!Number.isInteger(decimales) || decimales < 0 || decimales > 18) {
    throw new ConfigError(`X402_ASSET_DECIMALS debe ser un entero entre 0 y 18 (recibido "${env.X402_ASSET_DECIMALS}").`);
  }
  let extra = null;
  if (env.X402_ASSET_EXTRA) {
    try {
      extra = JSON.parse(env.X402_ASSET_EXTRA);
    } catch {
      throw new ConfigError('X402_ASSET_EXTRA debe ser JSON, p.ej. \'{"name":"USDT0","version":"1"}\'.');
    }
  }

  const salida = {};
  const evm = (env.X402_ASSET || '').trim();
  if (evm) {
    if (!isAddress(evm, { strict: false })) {
      throw new ConfigError(`X402_ASSET no es una dirección EVM válida: "${evm}".`);
    }
    salida.evm = { address: getAddress(evm), decimals: decimales, extra };
  }
  const svm = (env.X402_ASSET_MINT || '').trim();
  if (svm) {
    try {
      salida.svm = { address: svmAddress(svm), decimals: decimales, extra };
    } catch {
      throw new ConfigError(`X402_ASSET_MINT no es una dirección de Solana válida: "${svm}".`);
    }
  }
  return salida;
}

function normalizarPago(family, raw) {
  if (family === 'evm') {
    if (!isAddress(raw, { strict: false })) {
      throw new ConfigError(`X402_PAY_TO no es una dirección EVM válida: "${raw}".`);
    }
    if (!isAddress(raw)) {
      console.warn('[quitametadatos] aviso: el checksum EIP-55 de X402_PAY_TO no cuadra; '
        + 'comprueba que la dirección de cobro es la correcta.');
    }
    return getAddress(raw);
  }
  try {
    return svmAddress(raw);
  } catch {
    throw new ConfigError(`X402_PAY_TO_SVM no es una dirección de Solana válida: "${raw}".`);
  }
}

export function loadConfig(env = process.env) {
  const lista = (env.X402_NETWORKS || env.X402_NETWORK || DEFAULTS.network)
    .split(',').map((n) => n.trim()).filter(Boolean);
  if (!lista.length) {
    throw new ConfigError('X402_NETWORKS está vacío: indica al menos una red (p.ej. eip155:84532).');
  }

  const networks = [];
  for (const network of lista) {
    if (networks.some((n) => n.network === network)) continue; // sin duplicados
    const family = familyOf(network);
    if (!family) {
      throw new ConfigError(
        `Red no soportada: "${network}". Usa CAIP-2: eip155:<chainId> (Base, Base Sepolia...) `
        + 'o solana:<genesis> (p.ej. solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp).',
      );
    }
    const raw = (env[CAMPO_PAGO[family]] || '').trim();
    if (!raw) {
      throw new ConfigError(
        `Falta ${CAMPO_PAGO[family]} para cobrar en ${network}. `
        + `Cada familia de red necesita su dirección: ${CAMPO_PAGO.evm} (EVM), ${CAMPO_PAGO.svm} (Solana).`,
      );
    }
    networks.push({ network, family, payTo: normalizarPago(family, raw), scheme: 'exact' });
  }

  const precio = (raw, nombreVar) => {
    const p = (raw || '').trim();
    if (!/^\$?\d+(\.\d+)?$/.test(p)) {
      const pista = p.startsWith('.')
        ? ` Parece que escribiste "$0.02" en el .env: el cargador de .env de Bun expande "$0" y se pierde. `
          + `Escribe el precio sin dólar: ${nombreVar}=0.02`
        : '';
      throw new ConfigError(`${nombreVar} debe ser un importe en dólares, p.ej. 0.02 (recibido "${p}").${pista}`);
    }
    return p.startsWith('$') ? p : `$${p}`;
  };
  const price = precio(env.X402_PRICE || DEFAULTS.price, 'X402_PRICE');
  const priceScan = precio(env.X402_PRICE_SCAN || DEFAULTS.priceScan, 'X402_PRICE_SCAN');

  return {
    networks,
    assets: tokens(env),
    // Red principal (la primera): la usan los mensajes y el MCP.
    network: networks[0].network,
    payTo: networks[0].payTo,
    price,
    priceScan,
    facilitatorUrl: (env.X402_FACILITATOR_URL || DEFAULTS.facilitatorUrl).trim(),
    facilitatorAuthModule: (env.X402_FACILITATOR_AUTH_MODULE || '').trim() || null,
    // Si se define, el reto 402 lleva un blockhash reciente de Solana y el
    // agente se ahorra una consulta a su RPC.
    svmRpcUrl: (env.X402_SVM_RPC_URL || '').trim() || null,
    host: env.HOST || DEFAULTS.host,
    port: port(env, 'PORT', DEFAULTS.port),
    maxFiles: int(env, 'MAX_FILES', DEFAULTS.maxFiles),
    maxFileBytes: int(env, 'MAX_FILE_BYTES', DEFAULTS.maxFileBytes),
    maxRequestBytes: int(env, 'MAX_REQUEST_BYTES', DEFAULTS.maxRequestBytes),
    maxJsonOutputBytes: int(env, 'MAX_JSON_OUTPUT_BYTES', DEFAULTS.maxJsonOutputBytes),
    serviceName: env.SERVICE_NAME || 'quitametadatos',
    // Ruta del registro de ventas, o null si está desactivado (LEDGER_FILE=off).
    ledgerFile: ledgerFile(env),
    publicUrl: (env.PUBLIC_URL || '').trim() || null,
    // La app del navegador (gratis), para enlazarla desde la API.
    publicAppUrl: (env.PUBLIC_APP_URL || '').trim() || null,
  };
}

export { ConfigError };
