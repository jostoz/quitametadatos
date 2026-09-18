// Puente MCP que PAGA (lado del agente que consume el servicio).
//
// Para clientes MCP que no tienen cartera propia (Claude Desktop, Claude Code,
// Cursor...). Expone la herramienta `limpiar_metadatos`: lee el archivo del
// disco, lo manda a la API pagada, resuelve el 402 con la cartera del agente
// (Privy o clave local) y deja el archivo limpio en disco.
//
// Arrancar:  SERVICIO_URL=https://tu-servicio node src/mcp.js
//
// Variables: SERVICIO_URL (obligatoria), más las de la cartera (src/wallet.js):
//   PRIVY_APP_ID + PRIVY_APP_SECRET [+ PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS]
//   o EVM_PRIVATE_KEY

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { loadAgentWallet, WalletError } from './wallet.js';
import { esPrincipal } from './es-main.js';

const OPCIONES = {
  changes: z.enum(['keep', 'accept', 'reject']).optional(),
  comments: z.enum(['anonymize', 'delete']).optional(),
  customProps: z.boolean().optional(),
  macros: z.boolean().optional(),
  connections: z.boolean().optional(),
  icc: z.enum(['keep', 'remove']).optional(),
  orientation: z.enum(['keep', 'remove']).optional(),
  attachments: z.boolean().optional(),
};

export const nombreSalida = (ruta) =>
  `${ruta.replace(/\.[^.]+$/, '')} - sin metadatos${ruta.slice(ruta.lastIndexOf('.'))}`;

export async function buildServer({ servicioUrl, wallet } = {}) {
  const base = (servicioUrl || process.env.SERVICIO_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('Falta SERVICIO_URL (la URL del servicio que cobra).');
  const cartera = wallet || await loadAgentWallet();

  const server = new McpServer({ name: 'quitametadatos-cliente', version: '1.0.0' });

  server.tool(
    'limpiar_metadatos',
    'Quita los metadatos de un PDF, documento de Office o imagen JPEG/PNG/WebP. '
    + 'Se paga solo desde la cartera del agente (x402, se cobra por llamada al servicio). '
    + 'Deja el archivo limpio en disco y devuelve el informe de lo que se quitó.',
    {
      ruta: z.string().describe('Ruta del archivo a limpiar'),
      opciones: z.object(OPCIONES).optional().describe('Ajustes de limpieza'),
    },
    async ({ ruta, opciones }) => {
      const origen = resolve(ruta);
      const bytes = new Uint8Array(await readFile(origen));
      const cuerpo = {
        name: origen.split(/[\\/]/).pop(),
        bytesBase64: Buffer.from(bytes).toString('base64'),
      };
      if (opciones) cuerpo.options = opciones;

      const respuesta = await cartera.fetchPaid(`${base}/v1/clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const texto = await respuesta.text();
      if (!respuesta.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `El servicio respondió ${respuesta.status}: ${texto}` }],
        };
      }
      const datos = JSON.parse(texto);
      const ficha = datos.files[0];
      const destino = join(dirname(origen), nombreSalida(origen.split(/[\\/]/).pop()));
      await writeFile(destino, Buffer.from(ficha.bytesBase64, 'base64'));

      return {
        content: [{
          type: 'text',
          text: `Archivo limpio: ${destino}\n`
            + `${JSON.stringify({
              archivo: ficha,
              eliminado: ficha.removed,
              hallazgos: ficha.findings,
              pagadoCon: cartera.direccion,
              topePorPago: cartera.tope,
            }, null, 2)}`,
        }],
      };
    },
  );

  return { server, cartera };
}

if (esPrincipal(import.meta)) {
  try {
    const { server, cartera } = await buildServer();
    await server.connect(new StdioServerTransport());
    console.error(`[mcp] listo. Paga desde ${cartera.direccion} (${cartera.origen}), tope ${cartera.tope} por pago`);
  } catch (err) {
    console.error(`[mcp] ${err instanceof WalletError ? err.message : err}`);
    process.exit(1);
  }
}
