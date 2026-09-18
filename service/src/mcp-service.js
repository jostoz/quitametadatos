// Servicio MCP con cobro por llamada (lado que vende).
//
// Expone la limpieza de metadatos como herramienta MCP y exige el pago x402
// dentro del propio protocolo MCP: el cliente recibe un error 402 con los
// requisitos, firma con la cartera del agente y repite la llamada con el pago en
// el campo _meta. El archivo limpio viaja en la respuesta (base64) y, si el
// agente lo pide, también se escribe en disco.
//
// Arrancar:  SERVICIO_MCP=1 node src/mcp-service.js   (transporte stdio)
//
// Variables: X402_PAY_TO, X402_NETWORK, X402_PRICE, X402_FACILITATOR_URL
//            MAX_FILES, MAX_FILE_BYTES y las de src/config.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPaymentWrapper } from '@x402/mcp';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { loadConfig, PRODUCTOS } from './config.js';
import { clean, assess, scanText, DEFAULT_OPTIONS, sanitizeFilename } from './core.js';
import { aceptes, buildResourceServer } from './payments.js';
import { esPrincipal } from './es-main.js';
import { comprobarRegistro } from './ledger.js';

const OPCIONES = {
  changes: z.enum(['keep', 'accept', 'reject']).optional()
    .describe('Control de cambios de Word: conservar (keep), aceptar o rechazar'),
  comments: z.enum(['anonymize', 'delete']).optional()
    .describe('Comentarios: quitar autor y fecha (anonymize) o borrarlos (delete)'),
  customProps: z.boolean().optional().describe('Quitar propiedades personalizadas'),
  macros: z.boolean().optional().describe('Quitar macros incrustadas'),
  connections: z.boolean().optional().describe('Quitar conexiones a bases de datos'),
  icc: z.enum(['keep', 'remove']).optional().describe('Perfil de color ICC de las imágenes'),
  orientation: z.enum(['keep', 'remove']).optional().describe('Orientación EXIF de las imágenes'),
  attachments: z.boolean().optional().describe('Quitar también los adjuntos del PDF'),
};

/** Herramienta de pago genérica: mismo patrón para las tres, distinto precio y trabajo. */
async function registrarHerramientaDePago(server, resourceServer, config, {
  nombre, url, descripcion, precio, esquema, trabajo,
}) {
  const accepts = await resourceServer.buildPaymentRequirementsFromOptions(aceptes(config, precio), {});
  const cobrar = createPaymentWrapper(resourceServer, {
    accepts,
    resource: { url, description: descripcion, mimeType: 'application/json', serviceName: config.serviceName },
  });
  server.tool(nombre, descripcion, esquema, cobrar(trabajo));
}

export async function buildServer(config = loadConfig()) {
  const server = new McpServer({ name: 'quitametadatos', version: '1.0.0' });
  // Herramientas de los productos que sirve ESTE proceso (PRODUCTOS): un
  // servicio dedicado al escaneo no anuncia `limpiar_metadatos`, ni al revés.
  const activos = config.productos || PRODUCTOS;

  const resourceServer = await buildResourceServer(config);
  await resourceServer.initialize();

  if (activos.includes('clean')) await registrarHerramientaDePago(server, resourceServer, config, {
    nombre: 'limpiar_metadatos',
    url: 'mcp://tool/limpiar_metadatos',
    precio: config.price,
    descripcion: `Quita los metadatos (autor, empresa, fechas, GPS, comentarios, macros...) de un PDF, `
      + `documento de Word/Excel/PowerPoint o imagen JPEG/PNG/WebP. Cuesta ${config.price} por `
      + `llamada (se puede pagar en ${config.networks.map((n) => n.network).join(' o ')}), `
      + `pagado con la cartera del agente (x402). `
      + `Si el archivo no se puede procesar, la llamada falla y no se cobra.`,
    esquema: {
      nombre: z.string().describe('Nombre del archivo con su extensión, p.ej. "informe.docx"'),
      bytesBase64: z.string().describe('Contenido del archivo en base64'),
      opciones: z.object(OPCIONES).optional()
        .describe('Ajustes de limpieza; por defecto los mismos que la web'),
      guardarEn: z.string().optional()
        .describe('Ruta donde escribir el archivo limpio (opcional)'),
    },
    trabajo: async ({ nombre, bytesBase64, opciones, guardarEn }) => {
      const bytes = new Uint8Array(Buffer.from(bytesBase64, 'base64'));
      if (bytes.length > config.maxFileBytes) {
        return { isError: true, content: [{ type: 'text', text: `El archivo supera ${config.maxFileBytes} bytes.` }] };
      }
      const salida = await clean(sanitizeFilename(nombre), bytes, opciones);
      const limpioBase64 = Buffer.from(salida.bytes).toString('base64');
      const destino = guardarEn || null;
      if (destino) await writeFile(destino, salida.bytes);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            archivo: salida.report.file,
            eliminado: salida.report.removed,
            estadisticas: salida.report.stats,
            hallazgos: salida.report.findings,
            guardadoEn: destino,
          }),
        }, {
          type: 'text',
          text: `Archivo limpio (base64, ${salida.bytes.length} bytes):\n${limpioBase64}`,
        }],
      };
    },
  });

  if (activos.includes('scan')) await registrarHerramientaDePago(server, resourceServer, config, {
    nombre: 'evaluar_riesgo',
    url: 'mcp://tool/evaluar_riesgo',
    precio: config.priceScan,
    descripcion: `Evalúa si es prudente abrir o procesar un PDF, documento de Office o imagen: busca `
      + `macros, JavaScript/acciones automáticas en PDF, conexiones a bases de datos, archivos `
      + `incrustados y enlaces a otros archivos. No modifica nada, solo analiza. Cuesta `
      + `${config.priceScan} por llamada (se puede pagar en `
      + `${config.networks.map((n) => n.network).join(' o ')}), pagado con la cartera del `
      + `agente (x402). No es un antivirus: mira la estructura del archivo, no el contenido `
      + `del código. Si el archivo no se puede leer, la llamada falla y no se cobra.`,
    esquema: {
      nombre: z.string().describe('Nombre del archivo con su extensión, p.ej. "informe.xlsx"'),
      bytesBase64: z.string().describe('Contenido del archivo en base64'),
    },
    trabajo: async ({ nombre, bytesBase64 }) => {
      const bytes = new Uint8Array(Buffer.from(bytesBase64, 'base64'));
      if (bytes.length > config.maxFileBytes) {
        return { isError: true, content: [{ type: 'text', text: `El archivo supera ${config.maxFileBytes} bytes.` }] };
      }
      const evaluacion = await assess(sanitizeFilename(nombre), bytes);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...evaluacion }) }] };
    },
  });

  if (activos.includes('secrets')) await registrarHerramientaDePago(server, resourceServer, config, {
    nombre: 'escanear_secretos',
    url: 'mcp://tool/escanear_secretos',
    precio: config.priceSecrets,
    descripcion: `Busca secretos y credenciales expuestas en un texto o fragmento de código antes de `
      + `compartirlo: claves de AWS/GitHub/Slack/Stripe/OpenAI/Anthropic/Google/SendGrid/npm, claves `
      + `privadas PEM, cadenas de conexión con contraseña y JWT. No modifica nada, no ejecuta el texto. `
      + `Cuesta ${config.priceSecrets} por llamada (se puede pagar en `
      + `${config.networks.map((n) => n.network).join(' o ')}), pagado con la cartera del agente (x402). `
      + `No es un escáner exhaustivo: cubre los formatos de credencial más comunes. `
      + `Si el texto no es UTF-8 válido, la llamada falla y no se cobra.`,
    esquema: {
      nombre: z.string().describe('Nombre del archivo o fragmento, p.ej. "deploy.env"'),
      bytesBase64: z.string().describe('Texto o código en base64 (debe ser UTF-8)'),
    },
    trabajo: async ({ nombre, bytesBase64 }) => {
      const bytes = new Uint8Array(Buffer.from(bytesBase64, 'base64'));
      if (bytes.length > config.maxFileBytes) {
        return { isError: true, content: [{ type: 'text', text: `El texto supera ${config.maxFileBytes} bytes.` }] };
      }
      const evaluacion = scanText(sanitizeFilename(nombre), bytes);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...evaluacion }) }] };
    },
  });

  return server;
}

if (esPrincipal(import.meta)) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[mcp-service] ${err.message}`);
    process.exit(1);
  }
  const server = await buildServer(config);
  await server.connect(new StdioServerTransport());
  if (config.ledgerFile) console.error(`[mcp-service] ${await comprobarRegistro(config.ledgerFile)}`);
  for (const { network, payTo } of config.networks) {
    console.error(`[mcp-service] cobra ${config.price} (limpiar) / ${config.priceScan} (evaluar riesgo) `
      + `/ ${config.priceSecrets} (escanear secretos) por llamada en ${network} a ${payTo}`);
  }
  console.error(`[mcp-service] ajustes por defecto: ${JSON.stringify(DEFAULT_OPTIONS)}`);
}
