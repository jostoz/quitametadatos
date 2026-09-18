// Cartera del agente (el lado que paga).
//
// Se puede pagar en EVM (Base) y/o en Solana desde el mismo proceso: se
// registran los esquemas de las carteras que tengas configuradas y el SDK elige
// la que encaje con los requisitos del servicio.
//
//   EVM    → PRIVY_APP_ID + PRIVY_APP_SECRET (cartera de Privy, sin claves
//            privadas aquí) o EVM_PRIVATE_KEY (clave local)
//   Solana → SVM_PRIVATE_KEY (base58) — p.ej. la cartera de Solana de la CLI de
//            Privy Agent Wallets
//
// Si configuras las dos, el agente puede pagar en cualquiera de las dos; con
// X402_PREFERIR_RED eliges de cuál tira primero.

import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder } from '@solana/kit';
import { privateKeyToAccount } from 'viem/accounts';

export class WalletError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletError';
  }
}

const RED_EVM = 'eip155:*';
const RED_SVM = 'solana:*';

/**
 * Control de gasto del cliente. Además del tope por pago, el SDK solo permite
 * por defecto los tokens que reconoce (USDC); para pagar con otro token hay que
 * autorizarlo aquí, en forma "red=token":
 *
 *   X402_ASSETS_PERMITIDOS=eip155:8453=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,solana:5eykt...=EPjF...
 *
 * La red es un patrón (vale `eip155:*`); el SDK la exige en cada entrada, así que
 * se valida aquí y se avisa con un error claro en vez de fallar dentro del SDK.
 */
export function spendControls(env = process.env) {
  const lista = (env.X402_ASSETS_PERMITIDOS || '')
    .split(',').map((e) => e.trim()).filter(Boolean)
    .map((entrada) => {
      const [network, asset] = entrada.split('=').map((p) => p.trim());
      if (!network || !asset) {
        throw new WalletError(
          `X402_ASSETS_PERMITIDOS: cada entrada debe ser "red=token" `
          + `(p.ej. eip155:8453=0x8335... o solana:5eykt...=EPjF...). Recibido "${entrada}".`,
        );
      }
      return { network, asset };
    });
  return {
    maxAmountPerPayment: `$${env.MAX_USD_POR_PAGO || '1'}`,
    ...(lista.length ? { allowedAssets: lista } : {}),
  };
}

/** Tope de gasto por pago, en dólares. Protege al agente de un reto abusivo. */
export const TOPE_POR_PAGO = `$${process.env.MAX_USD_POR_PAGO || '1'}`;

async function conPrivy(env) {
  const { PrivyClient } = await import('@privy-io/node');
  const { createX402Client } = await import('@privy-io/node/x402');
  const privy = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });

  let { PRIVY_WALLET_ID: walletId, PRIVY_WALLET_ADDRESS: address } = env;
  if (!walletId || !address) {
    for await (const cartera of privy.wallets().list({ chain_type: 'ethereum' })) {
      walletId = walletId || cartera.id;
      address = address || cartera.address;
      break;
    }
    if (!walletId || !address) {
      throw new WalletError(
        'No se encontró ninguna cartera EVM en la app de Privy: indica PRIVY_WALLET_ID y '
        + 'PRIVY_WALLET_ADDRESS, o crea una cartera en el panel de Privy.',
      );
    }
  }
  const client = createX402Client(privy, { walletId, address })
    .setSpendControls(spendControls(env));
  return { client, direccion: address, origen: 'cartera de servidor de Privy' };
}

async function conClaveSolana(clave) {
  const bytes = getBase58Encoder().encode(clave);
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new WalletError('SVM_PRIVATE_KEY debe ser una clave secreta de Solana en base58 '
      + `(64 bytes, o 32 si es la semilla). Recibidos ${bytes.length} bytes.`);
  }
  const firmante = bytes.length === 64
    ? await createKeyPairSignerFromBytes(bytes)
    : await createKeyPairSignerFromPrivateKeyBytes(bytes);
  return { firmante, direccion: firmante.address };
}

/**
 * Prepara la cartera del agente.
 * @returns {Promise<{client, fetchPaid, direcciones: string[], origen: string, tope: string}>}
 */
export async function loadAgentWallet(env = process.env) {
  const esquemas = [];
  const direcciones = [];
  const origenes = [];

  if (env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
    // Privy firma con su cartera EVM (la de Solana se usa vía SVM_PRIVATE_KEY o
    // la CLI de Privy). El selector de red no se puede personalizar aquí.
    const { client, direccion, origen } = await conPrivy(env);
    return {
      client,
      fetchPaid: wrapFetchWithPayment(fetch, client),
      direcciones: [direccion],
      direccion,
      origen,
      tope: TOPE_POR_PAGO,
    };
  }

  if (env.EVM_PRIVATE_KEY) {
    const cuenta = privateKeyToAccount(env.EVM_PRIVATE_KEY.startsWith('0x')
      ? env.EVM_PRIVATE_KEY
      : `0x${env.EVM_PRIVATE_KEY}`);
    esquemas.push({ network: RED_EVM, client: new ExactEvmScheme(cuenta) });
    direcciones.push(cuenta.address);
    origenes.push('clave local EVM (EVM_PRIVATE_KEY)');
  }

  if (env.SVM_PRIVATE_KEY) {
    const { firmante, direccion } = await conClaveSolana(env.SVM_PRIVATE_KEY.trim());
    // El cliente de Solana necesita un RPC para leer el mint; con SVM_RPC_URL se
    // usa el que prefieras (el público por defecto suele ir lento).
    esquemas.push({
      network: RED_SVM,
      client: new ExactSvmScheme(firmante, env.SVM_RPC_URL ? { rpcUrl: env.SVM_RPC_URL } : undefined),
    });
    direcciones.push(direccion);
    origenes.push('clave local Solana (SVM_PRIVATE_KEY)');
  }

  if (!esquemas.length) {
    throw new WalletError(
      'No hay cartera configurada. Define PRIVY_APP_ID + PRIVY_APP_SECRET (cartera de Privy), '
      + 'EVM_PRIVATE_KEY (Base) o SVM_PRIVATE_KEY (Solana).',
    );
  }

  const client = x402Client.fromConfig({
    schemes: esquemas,
    spendControls: spendControls(env),
    ...(env.X402_PREFERIR_RED
      ? { paymentRequirementsSelector: selectorDeRed(env.X402_PREFERIR_RED) }
      : {}),
  });

  return {
    client,
    fetchPaid: wrapFetchWithPayment(fetch, client),
    direcciones,
    direccion: direcciones[0],
    origen: origenes.join(' + '),
    tope: TOPE_POR_PAGO,
  };
}

/** Elige la red preferida si el servicio la acepta; si no, la primera opción. */
function selectorDeRed(preferida) {
  return (requisitos) => requisitos.find((r) => r.network === preferida) || requisitos[0];
}
