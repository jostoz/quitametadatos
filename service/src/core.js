// Motor de limpieza de metadatos para el servicio (Node/Bun).
//
// Reutiliza TAL CUAL los módulos del navegador (../web/*.js): misma lógica de
// limpieza, un solo sitio que mantener. Lo único distinto es el runtime: aquí
// los bytes vienen de una petición HTTP, no de un <input type="file">.

import './dom.js';

import { sniffPdf, inspectPdf, stripPdf } from '../../web/pdf.js';
import { sniff, inspectImage, stripImage } from '../../web/images.js';
import { readZip, inspect, strip } from '../../web/ooxml.js';
import { createHash } from 'node:crypto';

// Mismos valores por defecto que la interfaz web (web/index.html): quitar
// propiedades personalizadas, macros y conexiones a bases de datos; conservar
// comentarios (sin autor), cambios, perfil de color y orientación.
export const DEFAULT_OPTIONS = Object.freeze({
  changes: 'keep',
  comments: 'anonymize',
  customProps: true,
  macros: true,
  connections: true,
  icc: 'keep',
  orientation: 'keep',
  attachments: false,
});

const ENUMS = {
  changes: ['keep', 'accept', 'reject'],
  comments: ['anonymize', 'delete'],
  icc: ['keep', 'remove'],
  orientation: ['keep', 'remove'],
};
const FLAGS = ['customProps', 'macros', 'connections', 'attachments'];

/** Valida las opciones que manda el cliente y rellena las que falten. */
export function normalizeOptions(raw) {
  if (raw == null) return { ...DEFAULT_OPTIONS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequest('Las opciones deben ser un objeto JSON.');
  }
  const opts = { ...DEFAULT_OPTIONS };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (raw[key] === undefined) continue;
    if (!allowed.includes(raw[key])) {
      throw new BadRequest(`Opción "${key}" inválida: se espera ${allowed.join(', ')}.`);
    }
    opts[key] = raw[key];
  }
  for (const key of FLAGS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') {
      throw new BadRequest(`Opción "${key}" inválida: se espera true o false.`);
    }
    opts[key] = raw[key];
  }
  const unknown = Object.keys(raw).filter(
    (k) => !ENUMS[k] && !FLAGS.includes(k),
  );
  if (unknown.length) {
    throw new BadRequest(`Opciones desconocidas: ${unknown.join(', ')}.`);
  }
  return opts;
}

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
    this.status = 400;
  }
}

export class UnsupportedFormat extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'UnsupportedFormat';
    this.status = 422;
    this.report = report;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const outputNameFor = (name) =>
  `${name.replace(/\.[^.]+$/, '')} - sin metadatos${name.slice(name.lastIndexOf('.'))}`;

/**
 * Nombre de archivo seguro: sin rutas, sin caracteres de control y con longitud
 * acotada. Evita que un cliente meta "../.." en el nombre del ZIP de salida.
 */
export function sanitizeFilename(raw) {
  const base = String(raw || '')
    .replace(/[\\/]+/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const name = base || 'archivo';
  return name.length > 150 ? `${name.slice(0, 140)}${name.slice(-10)}` : name;
}

/** Detecta el tipo por contenido (no por extensión) e inspecciona los metadatos. */
export async function analyze(bytes) {
  if (sniffPdf(bytes)) {
    return { kind: 'pdf', entries: null, report: await inspectPdf(bytes) };
  }
  const magic = sniff(bytes);
  if (magic) return { kind: 'image', entries: null, report: inspectImage(bytes) };
  const entries = await readZip(bytes);
  return { kind: 'office', entries, report: inspect(entries) };
}

function kindLabel(kind, report) {
  if (kind === 'image') return (report.info.format || 'imagen').toUpperCase();
  if (kind === 'pdf') return 'PDF';
  return report.info.formatLabel;
}

/**
 * Limpia un archivo en memoria.
 * @returns {Promise<{bytes: Uint8Array, report: object}>}
 */
export async function clean(name, input, options) {
  const opts = normalizeOptions(options);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) throw new BadRequest(`"${name}" está vacío.`);

  let kind;
  let entries;
  let report;
  try {
    ({ kind, entries, report } = await analyze(bytes));
  } catch (err) {
    // No sabemos leer el archivo (no es ZIP/OOXML, ni PDF, ni imagen conocida).
    throw new UnsupportedFormat(
      `No se puede procesar "${name}": ${err.message}`,
      { kind: null, format: null, findings: [], info: {} },
    );
  }
  const label = kindLabel(kind, report);
  const findings = report.findings || [];

  if (report.supported === false) {
    const why = report.info && report.info.format === 'pdf'
      ? 'el PDF está cifrado y no se puede reescribir sin la contraseña'
      : 'ese formato todavía no se puede reescribir sin recodificar la imagen';
    throw new UnsupportedFormat(
      `No se puede limpiar "${name}": ${why}.`,
      { kind, format: label, findings, info: report.info },
    );
  }

  let out;
  try {
    out = kind === 'pdf'
      ? await stripPdf(bytes, opts)
      : kind === 'image'
        ? stripImage(bytes, opts)
        : await strip(entries, opts);
  } catch (err) {
    // El motor falló con un archivo que sí reconocimos: casi siempre es un
    // archivo dañado o construido de forma rara. Se registra para poder
    // depurarlo y se responde 422 (la petición no se cobra).
    console.error(`[quitametadatos] fallo al limpiar "${name}":`, err);
    throw new UnsupportedFormat(
      `No se pudo limpiar "${name}": ${err.message}`,
      { kind, format: label, findings, info: report.info || {} },
    );
  }

  const outBytes = out.bytes instanceof Uint8Array ? out.bytes : new Uint8Array(out.bytes);
  return {
    bytes: outBytes,
    report: {
      file: {
        name,
        outputName: outputNameFor(name),
        kind,
        format: label,
        bytesInput: bytes.length,
        bytesOutput: outBytes.length,
        sha256Input: sha256(bytes),
        sha256Output: sha256(outBytes),
      },
      options: opts,
      removed: out.removed || [],
      stats: out.stats || {},
      findings,
      info: report.info || {},
    },
  };
}
