// RPC de Solana de pruebas (SOLO para tests).
//
// El cliente oficial @x402/svm necesita un RPC para dos cosas: leer el mint
// (decimales y programa dueño) y, si el reto no trae blockhash, pedir uno. Aquí
// se responde a esas dos llamadas con datos fijos, para que las pruebas no
// dependan de la red.
//
// OJO: no simula ni difunde transacciones; el que "ejecuta" el pago en las
// pruebas es el facilitador de pruebas, que liquida en falso.

import { createServer } from 'node:http';
import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { USDC_DEVNET_ADDRESS } from '@x402/svm';

const BLOCKHASH = '11111111111111111111111111111111';

/** Cuenta de mint SPL (82 bytes): autoridad nula, supply, decimales, inicializado. */
function cuentaMint(decimales) {
  const datos = new Uint8Array(82);
  const vista = new DataView(datos.buffer);
  vista.setUint32(0, 0, true); // mintAuthority: COption None
  vista.setBigUint64(36, 0n, true); // supply
  datos[44] = decimales;
  datos[45] = 1; // isInitialized
  vista.setUint32(46, 0, true); // freezeAuthority: COption None
  return datos;
}

// Qué direcciones "existen" en este RPC de mentira: los mints que se le digan y
// las cuentas de token que se le pasen en `existentes`.
const OWNER = TOKEN_PROGRAM_ADDRESS;

export async function startStubRpc({ decimales = 6, mints = [USDC_DEVNET_ADDRESS], existentes = [] } = {}) {
  const llamadas = { getAccountInfo: 0, getLatestBlockhash: 0, consultados: [] };
  const esMint = new Set(mints);
  const existe = new Set(existentes);

  function responder(metodo, params) {
    if (metodo === 'getAccountInfo') {
      const [direccion] = params;
      llamadas.getAccountInfo++;
      llamadas.consultados.push(direccion);
      if (!esMint.has(direccion) && !existe.has(direccion)) {
        return { context: { slot: 1 }, value: null };
      }
      if (!esMint.has(direccion)) {
        // Cuenta de token cualquiera: basta con que exista.
        return {
          context: { slot: 1 },
          value: {
            data: [Buffer.alloc(165).toString('base64'), 'base64'],
            executable: false,
            lamports: 2039280,
            owner: OWNER,
            rentEpoch: 0,
            space: 165,
          },
        };
      }
      const datos = cuentaMint(decimales);
      return {
        context: { slot: 1 },
        value: {
          data: [Buffer.from(datos).toString('base64'), 'base64'],
          executable: false,
          lamports: 1461600,
          owner: OWNER,
          rentEpoch: 0,
          space: datos.length,
        },
      };
    }
    if (metodo === 'getLatestBlockhash') {
      llamadas.getLatestBlockhash++;
      return {
        context: { slot: 1 },
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 0 },
      };
    }
    throw new Error(`método no soportado en el RPC de pruebas: ${metodo}`);
  }

  const server = createServer((req, res) => {
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => {
      const cuerpo = JSON.parse(Buffer.concat(trozos).toString('utf8'));
      const { id = 1, method, params = [] } = cuerpo;
      let respuesta;
      try {
        respuesta = { jsonrpc: '2.0', id, result: responder(method, params) };
      } catch (err) {
        respuesta = { jsonrpc: '2.0', id, error: { code: -32601, message: err.message } };
      }
      const payload = JSON.stringify(respuesta);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    llamadas,
    blockhash: BLOCKHASH,
    usdcDevnet: address(USDC_DEVNET_ADDRESS),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
