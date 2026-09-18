// Registro de ventas (para contabilidad y para saber qué entra).
//
// Se activa con LEDGER_FILE=<ruta> (p.ej. ventas.jsonl). Sin esa variable no
// escribe nada: así las pruebas no ensucian tu contabilidad.
//
// Escribe una línea JSON por liquidación, con lo que pide el SAT para el ISR:
// fecha, importe, token, red, quién pagó y el hash de la transacción. El tipo de
// cambio MXN del día lo añade tu contador (o lo puedes cruzar después).

import { appendFile, access, constants, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** @returns {string|null} ruta del registro, o null si está desactivado */
export function ledgerFile(env = process.env) {
  const ruta = (env.LEDGER_FILE || '').trim();
  if (!ruta || ruta.toLowerCase() === 'off') return null;
  return ruta;
}

/**
 * Comprueba al arrancar que se puede escribir el registro y lo dice por el log.
 * Sin esto, un volumen mal montado solo se nota cuando ya has cobrado (y el
 * asiento se pierde): mejor saberlo antes de la primera venta.
 *
 * @returns {Promise<string>} mensaje para el log
 */
export async function comprobarRegistro(ruta) {
  const destino = resolve(ruta);
  try {
    await mkdir(dirname(destino), { recursive: true });
    await access(dirname(destino), constants.W_OK);
    await appendFile(destino, '', 'utf8');
    return `registro de ventas: ${destino} (escribible)`;
  } catch (err) {
    return `AVISO: no puedo escribir el registro de ventas en ${destino} (${err.message}). `
      + 'Se seguirá cobrando, pero las ventas no quedarán registradas.';
  }
}

/**
 * Engancha el registro al servidor de pagos: una línea por cada cobro liquidado
 * y otra por cada liquidación fallida (esas sí hay que mirarlas).
 * La ruta sale de la configuración (`config.ledgerFile`), no del entorno.
 */
export function registrarVentas(server, config) {
  const ruta = config.ledgerFile;
  if (!ruta) return server;

  const escribir = (registro) => {
    appendFile(ruta, `${JSON.stringify({ fecha: new Date().toISOString(), ...registro })}\n`, 'utf8')
      .catch((err) => console.error('[quitametadatos] no pude escribir el registro de ventas:', err.message));
  };

  return server
    .onAfterSettle(({ requirements, result }) => {
      escribir({
        resultado: 'liquidado',
        servicio: config.serviceName,
        red: result.network || requirements.network,
        importe: `${result.amount || requirements.amount} (unidades base)`,
        token: requirements.asset,
        cobradoA: requirements.payTo,
        pagador: result.payer,
        tx: result.transaction,
      });
    })
    .onSettleFailure(({ requirements, error }) => {
      escribir({
        resultado: 'fallo_de_liquidacion',
        servicio: config.serviceName,
        red: requirements.network,
        importe: `${requirements.amount} (unidades base)`,
        token: requirements.asset,
        cobradoA: requirements.payTo,
        error: error?.message,
      });
    });
}
