// Constructor de un pago Solana para los tests.
//
// Hace lo mismo que el cliente oficial (@x402/svm) pero sin RPC: el cliente real
// consulta al RPC los decimales y el programa dueño del mint, y pide el
// blockhash; aquí se dan por conocidos para que la prueba no dependa de la red.
// La transacción se firma de verdad (ed25519) y el facilitador de pruebas la
// verifica de verdad.

import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction } from '@solana-program/token-2022';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { encodePaymentSignatureHeader } from '@x402/core/http';

const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const BLOCKHASH_FIJO = '11111111111111111111111111111111';

/**
 * Construye la cabecera PAYMENT-SIGNATURE para pagar en Solana.
 *
 * @param {object} opciones
 * @param {object} opciones.requisitos  La entrada de `accepts` para la red Solana
 * @param {object} opciones.firmante    KeyPairSigner del pagador (@solana/kit)
 * @param {string} opciones.feePayer    Dirección del fee payer del facilitador
 * @param {string} [opciones.destino]   Destinatario (para probar pagos mal dirigidos)
 * @param {string} [opciones.importe]   Importe en unidades base (para probar pagos cortos)
 * @param {string} [opciones.origenDe]  Dueño de la cuenta desde la que se paga, si no
 *                                      es el firmante (para probar que nadie paga
 *                                      desde la cuenta de otro)
 * @param {string} [opciones.mint]      Token con el que se paga, si no es el pedido
 *                                      (para probar que no cuela otro token)
 * @param {number} [opciones.decimales] Decimales del token
 */
export async function cabeceraDePagoSolana({ requisitos, firmante, feePayer, destino, importe, origenDe, mint: mintDado, decimales = 6 }) {
  const mint = address(mintDado || requisitos.asset);
  const programa = TOKEN_PROGRAM_ADDRESS;
  const [origen] = await findAssociatedTokenPda({
    mint,
    owner: address(origenDe || firmante.address),
    tokenProgram: programa,
  });
  const [destinoAta] = await findAssociatedTokenPda({
    mint,
    owner: address(destino || requisitos.payTo),
    tokenProgram: programa,
  });

  const transferencia = getTransferCheckedInstruction({
    source: origen,
    mint,
    destination: destinoAta,
    authority: firmante,
    amount: BigInt(importe || requisitos.amount),
    decimals: decimales,
  }, { programAddress: programa });

  const mensaje = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(feePayer), tx),
    (tx) => prependTransactionMessageInstruction(getSetComputeUnitLimitInstruction({ units: 100_000 }), tx),
    (tx) => appendTransactionMessageInstructions([
      transferencia,
      { programAddress: MEMO, accounts: [], data: new TextEncoder().encode(randomHex()) },
    ], tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: BLOCKHASH_FIJO, lastValidBlockHeight: 0n }, tx,
    ),
  );

  const firmada = await partiallySignTransactionMessageWithSigners(mensaje);
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: requisitos,
    payload: { transaction: getBase64EncodedWireTransaction(firmada) },
  });
}

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { generateKeyPairSigner };
