// Facilitador de pruebas (SOLO para tests).
//
// Habla el mismo HTTP que un facilitador x402 real (/supported, /verify,
// /settle) y verifica de verdad los pagos en las dos familias de red:
//
//   EVM    → firma EIP-712 de la autorización EIP-3009 (transferWithAuthorization)
//   Solana → firma ed25519 del pagador sobre el mensaje de la transacción, más
//            la transferencia (mint, destino = ATA del cobrador, importe)
//
// Lo que NO hace es mover dinero: no hay RPC ni fondos, así que la liquidación
// se simula con un hash inventado. Ese es el único punto del flujo que en
// producción ejecuta un facilitador real (el que paga el gas y difunde la
// transacción).

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

import { getAddress, verifyTypedData } from 'viem';
import {
  address as svmAddress,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { verifySignature } from '@solana/keys';
import {
  findAssociatedTokenPda,
  getTransferCheckedInstructionDataDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const EVM_FACILITATOR = '0x1111111111111111111111111111111111111111';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ------------------------------------------------------------------ EVM

async function inspectEvm(payload, requirements) {
  const authorization = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!authorization || !signature) return { isValid: false, invalidReason: 'payload_malformado' };
  if (getAddress(authorization.to) !== getAddress(requirements.payTo)) {
    return { isValid: false, invalidReason: 'destinatario_incorrecto' };
  }
  if (BigInt(authorization.value) < BigInt(requirements.amount)) {
    return { isValid: false, invalidReason: 'importe_insuficiente' };
  }
  const ahora = Math.floor(Date.now() / 1000);
  if (BigInt(authorization.validAfter) > ahora) return { isValid: false, invalidReason: 'todavia_no_valido' };
  if (BigInt(authorization.validBefore) <= ahora) return { isValid: false, invalidReason: 'caducado' };

  const extra = requirements.extra || {};
  if (!extra.name || !extra.version) return { isValid: false, invalidReason: 'dominio_incompleto' };
  const ok = await verifyTypedData({
    address: getAddress(authorization.from),
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: Number(requirements.network.split(':')[1]),
      verifyingContract: getAddress(requirements.asset),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  });
  if (!ok) return { isValid: false, invalidReason: 'firma_invalida' };
  return {
    isValid: true,
    payer: getAddress(authorization.from),
    clave: `evm:${authorization.nonce}`,
  };
}

// ------------------------------------------------------------------ Solana

/** Clave pública (CryptoKey) a partir de una dirección de Solana, para verificar. */
async function clavePublica(direccion) {
  return crypto.subtle.importKey('raw', getAddressEncoder().encode(svmAddress(direccion)),
    { name: 'Ed25519' }, false, ['verify']);
}

async function inspectSvm(payload, requirements, feePayer) {
  const wire = payload?.payload?.transaction;
  if (typeof wire !== 'string') return { isValid: false, invalidReason: 'payload_malformado' };

  let transaccion;
  let mensaje;
  try {
    transaccion = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    mensaje = getCompiledTransactionMessageDecoder().decode(transaccion.messageBytes);
  } catch {
    return { isValid: false, invalidReason: 'transaccion_ilegible' };
  }

  const cuentas = mensaje.staticAccounts;
  if (cuentas[0] !== feePayer) return { isValid: false, invalidReason: 'fee_payer_incorrecto' };

  // El pagador es el firmante que no es el facilitador; su firma debe cubrir el
  // mensaje completo (ed25519 real).
  const pagador = Object.entries(transaccion.signatures).find(([dir]) => dir !== feePayer)?.[0];
  if (!pagador) return { isValid: false, invalidReason: 'falta_firma' };
  const firma = transaccion.signatures[pagador];
  const firmaOk = firma && await verifySignature(await clavePublica(pagador), firma, transaccion.messageBytes);
  if (!firmaOk) return { isValid: false, invalidReason: 'firma_invalida' };

  const decodificador = getTransferCheckedInstructionDataDecoder();
  for (const ix of mensaje.instructions) {
    if (!ix.accountIndices) continue;
    const programa = cuentas[ix.programAddressIndex];
    if (programa !== TOKEN_PROGRAM_ADDRESS && programa !== TOKEN_2022_PROGRAM_ADDRESS) continue;
    let datos;
    try {
      datos = decodificador.decode(ix.data);
    } catch {
      continue; // otra instrucción del programa de tokens
    }
    const [source, mint, destination] = ix.accountIndices.map((i) => cuentas[i]);
    if (mint !== requirements.asset.toString()) {
      return { isValid: false, invalidReason: 'mint_incorrecto' };
    }
    const [destinoEsperado] = await findAssociatedTokenPda({
      mint: svmAddress(requirements.asset),
      owner: svmAddress(requirements.payTo),
      tokenProgram: programa,
    });
    if (destination !== destinoEsperado) {
      return { isValid: false, invalidReason: 'destinatario_incorrecto' };
    }
    if (BigInt(datos.amount) < BigInt(requirements.amount)) {
      return { isValid: false, invalidReason: 'importe_insuficiente' };
    }
    const [origenEsperado] = await findAssociatedTokenPda({
      mint: svmAddress(requirements.asset),
      owner: svmAddress(pagador),
      tokenProgram: programa,
    });
    if (source !== origenEsperado) return { isValid: false, invalidReason: 'origen_incorrecto' };
    return {
      isValid: true,
      payer: pagador,
      clave: `svm:${sha256(transaccion.messageBytes)}`,
    };
  }
  return { isValid: false, invalidReason: 'sin_transferencia' };
}

// ------------------------------------------------------------------ servidor

/**
 * @param {{network?: string, networks?: string[], svmFeePayer?: string, sinFeePayer?: boolean}} opciones
 *   Redes que anuncia el facilitador. Se puede pasar una sola (`network`) o
 *   varias (`networks`). Para Solana se genera una dirección de fee payer, salvo
 *   que se pida `sinFeePayer` (para probar ese fallo).
 */
export async function startStubFacilitator({ network, networks, svmFeePayer, sinFeePayer = false } = {}) {
  const lista = networks || (network ? [network] : ['eip155:84532']);
  const calls = { verify: [], settle: [], supported: 0 };
  const usados = new Set();
  const feePayerSvm = svmFeePayer || (await generateKeyPairSigner()).address;
  const esSvm = (n) => n.startsWith('solana:');

  async function inspect(payload, requirements) {
    if (payload?.x402Version !== 2) return { isValid: false, invalidReason: 'version_no_soportada' };
    const resultado = esSvm(requirements.network)
      ? await inspectSvm(payload, requirements, feePayerSvm)
      : await inspectEvm(payload, requirements);
    // Un pago ya liquidado no se puede volver a usar: el nonce EIP-3009 o el
    // mensaje firmado de Solana son de un solo uso.
    if (resultado.isValid && usados.has(resultado.clave)) {
      return { isValid: false, invalidReason: 'pago_ya_usado' };
    }
    return resultado;
  }

  async function route(req, url, body) {
    const send = (data, status = 200) => ({ status, data });
    if (req.method === 'GET' && url.pathname === '/supported') {
      calls.supported++;
      return send({
        kinds: lista.map((n) => ({
          x402Version: 2,
          scheme: 'exact',
          network: n,
          ...(esSvm(n) && !sinFeePayer ? { extra: { feePayer: feePayerSvm } } : {}),
        })),
        extensions: [],
        signers: { 'eip155:*': [EVM_FACILITATOR], 'solana:*': [feePayerSvm] },
      });
    }
    if (req.method !== 'POST' || !['/verify', '/settle'].includes(url.pathname)) {
      return send({ error: 'not found' }, 404);
    }

    const { paymentPayload, paymentRequirements } = body;
    const resultado = await inspect(paymentPayload, paymentRequirements);
    const operacion = url.pathname.slice(1);
    calls[operacion].push({
      network: paymentRequirements?.network,
      isValid: resultado.isValid,
      invalidReason: resultado.invalidReason,
      amount: paymentRequirements?.amount,
      payTo: paymentRequirements?.payTo,
      payer: resultado.payer,
    });

    if (operacion === 'verify') {
      return send(resultado.isValid
        ? { isValid: true, payer: resultado.payer }
        : { isValid: false, invalidReason: resultado.invalidReason });
    }
    if (!resultado.isValid) {
      return send({
        success: false,
        errorReason: resultado.invalidReason,
        errorMessage: `pago rechazado: ${resultado.invalidReason}`,
        transaction: '',
        network: paymentRequirements?.network,
      });
    }
    if (usados.has(resultado.clave)) {
      return send({
        success: false,
        errorReason: 'pago_ya_usado',
        errorMessage: 'ese pago ya se liquidó',
        transaction: '',
        network: paymentRequirements.network,
      });
    }
    usados.add(resultado.clave);
    return send({
      success: true,
      transaction: `0x${sha256(resultado.clave).slice(0, 64)}`,
      network: paymentRequirements.network,
      payer: resultado.payer,
      amount: paymentRequirements.amount,
    });
  }

  const server = createServer((req, res) => {
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', async () => {
      let body = null;
      if (trozos.length) {
        try {
          body = JSON.parse(Buffer.concat(trozos).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'json inválido' }));
          return;
        }
      }
      const { status, data } = await route(req, new URL(req.url, 'http://127.0.0.1'), body);
      const payload = JSON.stringify(data);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    usados,
    feePayerSvm,
    networks: lista,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export { AUTHORIZATION_TYPES };
