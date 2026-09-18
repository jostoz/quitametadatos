// Cableado del cobro x402: qué redes se aceptan, con qué esquema y cómo se
// habla con el facilitador. Lo comparten la API HTTP (src/server.js) y el
// servicio MCP (src/mcp-service.js) para que solo haya una forma de configurarlo.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { convertToTokenAmount } from '@x402/core/utils';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import { registrarVentas } from './ledger.js';

/** Cabeceras de autenticación del facilitador (p.ej. CDP), si se configuran. */
async function makeAuthHeaders(modulePath) {
  if (!modulePath) return undefined;
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof mod.createAuthHeaders !== 'function') {
    throw new Error(`${modulePath} debe exportar createAuthHeaders(operation).`);
  }
  return mod.createAuthHeaders;
}

/** Opciones de pago: una por red configurada (el agente elige la suya). */
export function aceptes(config) {
  return config.networks.map(({ scheme, network, payTo }) => ({
    scheme,
    price: config.price,
    network,
    payTo,
  }));
}

/** Registra el esquema que corresponde a cada red (EVM o Solana). */
export function registrarEsquemas(server, config) {
  for (const { network, family } of config.networks) {
    server.register(network, crearEsquema(config, family));
  }
  return server;
}

/**
 * Esquema del servidor para una familia de red, con el token configurado.
 * Por defecto se usa el USDC de esa red (el que conoce el SDK); si se configura
 * otro token (`X402_ASSET` / `X402_ASSET_MINT`) se registra un conversor propio.
 */
export function crearEsquema(config, family) {
  const esquema = family === 'svm'
    ? new ExactSvmScheme({ rpcUrl: config.svmRpcUrl || undefined })
    : new ExactEvmScheme();
  const token = config.assets?.[family];
  if (!token) return esquema;
  return esquema.registerMoneyParser(async (amount) => ({
    asset: token.address,
    amount: convertToTokenAmount(amount, token.decimals),
    ...(token.extra ? { extra: token.extra } : {}),
  }));
}

export async function buildResourceServer(config) {
  const client = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: await makeAuthHeaders(config.facilitatorAuthModule),
  });
  const server = registrarEsquemas(new x402ResourceServer(client), config);
  return registrarVentas(server, config);
}

/**
 * Metadatos de descubrimiento (extensión bazaar): con esto los directorios de
 * x402 pueden catalogar el endpoint y un agente puede encontrar el servicio
 * sabiendo qué recibe y qué devuelve, sin leerse el código.
 */
export function descubrimiento(config) {
  return declareDiscoveryExtension({
    method: 'POST',
    bodyType: 'json',
    input: { name: 'foto.jpg', bytesBase64: '<contenido del archivo en base64>' },
    inputSchema: {
      properties: {
        name: { type: 'string', description: 'Nombre del archivo con su extensión' },
        bytesBase64: { type: 'string', description: 'Contenido del archivo en base64' },
        options: { type: 'object', description: 'Ajustes de limpieza (opcional)' },
      },
      required: ['name', 'bytesBase64'],
    },
    output: {
      example: {
        ok: true,
        files: [{
          name: 'foto.jpg',
          outputName: 'foto - sin metadatos.jpg',
          kind: 'image',
          format: 'JPEG',
          bytesInput: 4119,
          bytesOutput: 2791,
          removed: ['EXIF: 18 campos eliminados (cámara, objetivos, fechas, software, autor)',
            'Coordenadas GPS eliminadas (8 campos)'],
          sha256Output: '…',
          bytesBase64: '<archivo limpio en base64>',
        }],
      },
    },
  });
}

/** Rutas HTTP protegidas: el precio y las redes aceptadas de /v1/clean. */
export function buildRoutes(config, path) {
  const redes = config.networks.map((n) => n.network);
  return {
    [`POST ${path}`]: {
      accepts: aceptes(config),
      description: `Quitar los metadatos de hasta ${config.maxFiles} archivos `
        + '(PDF, Word, Excel, PowerPoint, JPEG, PNG, WebP) y devolver un ZIP con los '
        + 'archivos limpios y un informe.json. Precio por petición, no por archivo. '
        + `Se puede pagar en ${redes.join(' o ')}: usa la entrada de "accepts" que `
        + 'corresponda a la cartera de tu agente. '
        + 'Si algún archivo no se puede procesar, la petición falla y NO se cobra.',
      mimeType: 'application/zip',
      extensions: descubrimiento(config),
    },
  };
}
