// API HTTP de limpieza de metadatos, con cobro por petición vía x402 v2.
//
// GET  /                 → descripción del servicio (gratis)
// GET  /v1/pricing       → precio, red, dirección de cobro y límites (gratis)
// GET  /healthz          → estado (gratis)
// POST /v1/clean         → limpia los archivos; exige pago x402
//
// El cobro lo aplica el middleware de @x402/hono: sin cabecera de pago la
// petición recibe 402 con los requisitos; con un pago válido se ejecuta el
// trabajo y solo entonces se liquida (si el trabajo falla, no se cobra).

import { Hono } from 'hono';

import { paymentMiddleware } from '@x402/hono';
import { writeZip } from '../../web/zip.js';

import { clean, BadRequest, UnsupportedFormat, DEFAULT_OPTIONS, sanitizeFilename } from './core.js';
import { loadConfig } from './config.js';
import { buildResourceServer, buildRoutes } from './payments.js';
import { comprobarRegistro } from './ledger.js';
import { esPrincipal } from './es-main.js';

export const CLEAN_PATH = '/v1/clean';
export const SERVICE_VERSION = '1.0.0';

const FORMATOS = {
  pdf: 'PDF (se reescribe el documento; se quitan /Info, XMP, adjuntos, JavaScript y versiones anteriores)',
  office: 'Word (.docx/.docm), Excel (.xlsx/.xlsm), PowerPoint (.pptx/.pptm)',
  image: 'JPEG, PNG y WebP (sin recodificar: los píxeles no cambian)',
  noSoportado: 'TIFF, HEIC y AVIF (habría que recodificar la imagen), PDF cifrado',
};

// ------------------------------------------------------------------ ayuda

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

function errorResponse(err) {
  if (err instanceof BadRequest) return json({ error: err.message }, 400);
  if (err instanceof UnsupportedFormat) {
    return json({ error: err.message, informe: err.report }, 422);
  }
  console.error('[quitametadatos] error inesperado:', err);
  return json({ error: 'Error interno del servicio.' }, 500);
}

// ------------------------------------------------------------------ trabajo

async function readUpload(c, config) {
  const tipo = (c.req.header('content-type') || '').toLowerCase();
  const { files, options } = tipo.includes('application/json')
    ? await readJsonUpload(c, config)
    : await readMultipartUpload(c);

  if (!files.length) {
    throw new BadRequest('No se ha enviado ningún archivo.');
  }
  if (files.length > config.maxFiles) {
    throw new BadRequest(`Demasiados archivos: máximo ${config.maxFiles} por petición.`);
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.length > config.maxFileBytes) {
      throw new BadRequest(
        `"${file.name}" ocupa ${file.bytes.length} bytes: el máximo por archivo es ${config.maxFileBytes}.`,
      );
    }
    total += file.bytes.length;
    if (total > config.maxRequestBytes) {
      throw new BadRequest(`El total supera el máximo de ${config.maxRequestBytes} bytes por petición.`);
    }
  }
  return { files, options };
}

async function readMultipartUpload(c) {
  let form;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    throw new BadRequest('El cuerpo debe ser multipart/form-data con el campo "file".');
  }
  const raw = form.file;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((f) => typeof File !== 'undefined' && f instanceof File);
  if (!parts.length) {
    throw new BadRequest('No se ha enviado ningún archivo: usa el campo "file" (se puede repetir).');
  }
  const files = [];
  for (const part of parts) {
    files.push({ name: sanitizeFilename(part.name), bytes: new Uint8Array(await part.arrayBuffer()) });
  }
  return { files, options: parseOptions(form.options) };
}

/**
 * Cuerpo JSON, para agentes que no pueden enviar multipart (p.ej. la CLI de
 * Privy Agent Wallets: `fetch-x402 <url> --method POST --body '<json>'`):
 *   { "name": "foto.jpg", "bytesBase64": "...", "options": {...} }
 *   { "files": [{ "name": "foto.jpg", "bytesBase64": "..." }], "options": {...} }
 */
async function readJsonUpload(c, config) {
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequest('El cuerpo JSON no se pudo leer.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('El cuerpo debe ser un objeto JSON.');
  }
  const crudos = Array.isArray(body.files) ? body.files : [body];
  if (crudos.length > config.maxFiles) {
    throw new BadRequest(`Demasiados archivos: máximo ${config.maxFiles} por petición.`);
  }
  const files = [];
  for (const item of crudos) {
    if (!item || typeof item !== 'object' || typeof item.bytesBase64 !== 'string') {
      throw new BadRequest('Cada archivo necesita "name" y "bytesBase64".');
    }
    // Comprobación previa en base64 para no reservar memoria de más.
    if (item.bytesBase64.length * 0.75 > config.maxFileBytes * 1.1) {
      throw new BadRequest(`"${item.name}" supera el máximo de ${config.maxFileBytes} bytes.`);
    }
    const bytes = new Uint8Array(Buffer.from(item.bytesBase64, 'base64'));
    if (!bytes.length) throw new BadRequest(`"${item.name}" está vacío o no es base64 válido.`);
    files.push({ name: sanitizeFilename(item.name), bytes });
  }
  return { files, options: parseOptions(body.options) };
}

function parseOptions(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new BadRequest('El campo "options" debe ser un objeto JSON.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('El campo "options" debe ser JSON válido.');
  }
}

async function handleClean(c, config) {
  const { files, options } = await readUpload(c, config);
  const results = [];
  for (const file of files) {
    const out = await clean(file.name, file.bytes, options);
    results.push({ name: file.name, ...out });
  }

  const wantsJson = (c.req.header('accept') || '').includes('application/json');
  if (wantsJson) {
    const total = results.reduce((sum, r) => sum + r.bytes.length, 0);
    if (total > config.maxJsonOutputBytes) {
      throw new BadRequest(
        `La respuesta JSON (archivos en base64) superaría ${config.maxJsonOutputBytes} bytes. `
        + 'Pide el ZIP (sin cabecera "Accept: application/json") para archivos grandes.',
      );
    }
    return json({
      ok: true,
      files: results.map((r) => ({
        ...r.report.file,
        removed: r.report.removed,
        stats: r.report.stats,
        findings: r.report.findings,
        info: r.report.info,
        bytesBase64: Buffer.from(r.bytes).toString('base64'),
      })),
      options: results[0]?.report.options || { ...DEFAULT_OPTIONS },
    });
  }

  const entries = results.map((r) => ({ name: r.report.file.outputName, data: r.bytes }));
  entries.push({
    name: 'informe.json',
    data: new TextEncoder().encode(JSON.stringify({
      servicio: config.serviceName,
      version: SERVICE_VERSION,
      files: results.map((r) => r.report),
    }, null, 2)),
  });
  const zip = await writeZip(entries);
  return new Response(zip, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="sin metadatos.zip"',
      'Content-Length': String(zip.length),
    },
  });
}

// ------------------------------------------------------------------ app

export async function createApp(config, { resourceServer } = {}) {
  const app = new Hono();
  const server = resourceServer || await buildResourceServer(config);
  const routes = buildRoutes(config, CLEAN_PATH);

  // Rechazo temprano de cuerpos enormes: nunca se cobra por esto.
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === CLEAN_PATH) {
      const len = Number(c.req.header('content-length') || 0);
      if (len > config.maxRequestBytes) {
        return json({
          error: `El cuerpo de la petición supera el máximo de ${config.maxRequestBytes} bytes.`,
        }, 413);
      }
    }
    await next();
  });

  app.use('*', paymentMiddleware(routes, server));

  app.get('/', (c) => json({
    servicio: config.serviceName,
    version: SERVICE_VERSION,
    descripcion: 'Quita los metadatos de documentos, PDF e imágenes. Cobra por petición '
      + 'con x402: el agente paga desde su propia cartera, sin cuentas ni claves de API.',
    protocolo: { nombre: 'x402', version: 2, cabeceraPago: 'PAYMENT-SIGNATURE', reto: 402 },
    precio: config.price,
    redes: config.networks.map(({ network, family, payTo }) => ({ red: network, familia: family, cobrarA: payTo })),
    limites: {
      archivosPorPeticion: config.maxFiles,
      bytesPorArchivo: config.maxFileBytes,
      bytesPorPeticion: config.maxRequestBytes,
    },
    endpoints: {
      [`POST ${CLEAN_PATH}`]: 'multipart/form-data, campo "file" (repetible) y "options" (JSON opcional). '
        + 'Devuelve un ZIP con los archivos limpios y informe.json. '
        + 'Con "Accept: application/json" devuelve los archivos en base64 (necesario si no puedes leer binario).',
      'GET /v1/pricing': 'precio, red y límites (gratis)',
      'GET /healthz': 'estado del servicio (gratis)',
    },
    comoPagar: {
      'cualquier agente x402': 'Pide POST '
        + `${CLEAN_PATH} sin pagar y recibirás un 402 con la cabecera PAYMENT-REQUIRED `
        + '(requisitos: esquema "exact", USDC en la red indicada, importe y dirección). '
        + 'Firma con la cartera del agente y repite la petición con la cabecera PAYMENT-SIGNATURE. '
        + 'Si el trabajo falla, la petición responde 4xx y no se liquida el pago.',
      'CLI de Privy Agent Wallets':
        'privy-agent-wallet fetch-x402 "<url>/v1/clean" --method POST '
        + '--header "Accept: application/json" --body \'{"name":"foto.jpg","bytesBase64":"..."}\' '
        + '--max-value 20000 (--max-value va en unidades base de USDC: 20000 = 0,02 USDC; '
        + 'mira el importe exacto del reto 402 antes de fijarlo)',
    },
    formatos: FORMATOS,
    opciones: {
      changes: ['keep', 'accept', 'reject'],
      comments: ['anonymize', 'delete'],
      icc: ['keep', 'remove'],
      orientation: ['keep', 'remove'],
      customProps: 'booleano',
      macros: 'booleano',
      connections: 'booleano',
      attachments: 'booleano',
      porDefecto: DEFAULT_OPTIONS,
    },
  }));

  app.get('/v1/pricing', (c) => json({
    precio: config.price,
    por: 'petición (hasta '
      + `${config.maxFiles} archivos, ${Math.round(config.maxRequestBytes / (1024 * 1024))} MB)`,
    protocolo: 'x402',
    version: 2,
    esquema: 'exact',
    redes: config.networks.map(({ network, family, payTo }) => ({ red: network, familia: family, cobrarA: payTo })),
    facilitador: config.facilitatorUrl,
    limites: {
      archivosPorPeticion: config.maxFiles,
      bytesPorArchivo: config.maxFileBytes,
      bytesPorPeticion: config.maxRequestBytes,
    },
    nota: 'Sin cabecera de pago la petición responde 402 con los requisitos exactos. '
      + 'Si el trabajo falla (formato no soportado, archivo ilegible), no se cobra.',
  }));

  app.get('/healthz', (c) => json({
    ok: true,
    servicio: config.serviceName,
    version: SERVICE_VERSION,
    redes: config.networks.map((n) => n.network),
    uptimeSegundos: Math.round(process.uptime()),
  }));

  app.post(CLEAN_PATH, async (c) => {
    try {
      return await handleClean(c, config);
    } catch (err) {
      return errorResponse(err);
    }
  });

  return app;
}

/**
 * Detrás de un proxy (túnel, nginx, un host) la petición llega al proceso como
 * http://127.0.0.1, y ese es el origen que acababa en el reto 402 y en los
 * metadatos de descubrimiento. Con PUBLIC_URL se reescribe el origen —igual que
 * hace un proxy inverso— sin tocar la ruta ni el cuerpo.
 */
export function reescribirOrigen(publicUrl) {
  if (!publicUrl) return null;
  const publico = new URL(publicUrl);
  return (req) => {
    const origen = new URL(req.url);
    if (origen.origin === publico.origin) return req;
    // Se construye desde el origen público para no arrastrar el puerto interno.
    const destino = new URL(publico.origin);
    destino.pathname = origen.pathname;
    destino.search = origen.search;
    return new Request(destino, req);
  };
}

/** Arranca el servidor en Bun o Node. Devuelve {url, stop}. */
export async function startServer(config) {
  const app = await createApp(config);
  const reescribir = reescribirOrigen(config.publicUrl);
  const manejar = reescribir ? (req) => app.fetch(reescribir(req)) : app.fetch;
  if (typeof Bun !== 'undefined') {
    const server = Bun.serve({
      port: config.port,
      hostname: config.host,
      fetch: manejar,
      maxRequestBodySize: config.maxRequestBytes + 1024 * 1024,
      idleTimeout: 120,
    });
    return {
      url: `http://${config.host}:${server.port}`,
      stop: () => server.stop(true),
    };
  }
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: manejar, port: config.port, hostname: config.host });
  await new Promise((res) => (server.listening ? res() : server.once('listening', res)));
  const port = server.address()?.port ?? config.port;
  return {
    url: `http://${config.host}:${port}`,
    stop: () => new Promise((res) => server.close(() => res())),
  };
}

if (esPrincipal(import.meta)) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\n[quitametadatos] ${err.message}\n`);
    process.exit(1);
  }
  const { url } = await startServer(config);
  console.log(`[quitametadatos] escuchando en ${url}`);
  console.log(`[quitametadatos] precio ${config.price} por petición`);
  for (const { network, payTo } of config.networks) {
    console.log(`[quitametadatos] cobra en ${network} a ${payTo}`);
  }
  console.log(`[quitametadatos] facilitador ${config.facilitatorUrl}`);
  if (config.publicUrl) console.log(`[quitametadatos] URL pública: ${config.publicUrl}`);
  if (config.ledgerFile) console.log(`[quitametadatos] ${await comprobarRegistro(config.ledgerFile)}`);
  console.log(`[quitametadatos] pruébalo: curl ${url}/v1/pricing`);
}
