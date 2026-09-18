// Metadatos en imágenes: JPEG, PNG y WebP.
// La eliminación es SIN PÉRDIDA: se quitan segmentos/chunks de metadatos y el
// píxel no se vuelve a comprimir. Se conservan la orientación y el perfil de
// color (ICC), que no son rastros personales pero sí cambian cómo se ve.

import { crc32 } from './zip.js';

const JPEG_SOI = 0xffd8;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP12 = 0xec;
const APP13 = 0xed;
const APP14 = 0xee;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;

// APP2 con perfil ICC: se conserva (afecta al color)
const ICC_HEADER = 'ICC_PROFILE\0';
const PS_HEADER = 'Photoshop 3.0\0';
const DUCKY_HEADER = 'Ducky';

const PNG_META = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

// ------------------------------------------------------------------ sniff

export function sniff(bytes) {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50
    && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length > 4 && (ascii(bytes, 0, 2) === 'II' || ascii(bytes, 0, 2) === 'MM')) return 'tiff';
  if (bytes.length > 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif)$/.test(brand)) return brand.startsWith('avif') ? 'avif' : 'heic';
  }
  return null;
}

function ascii(bytes, start, len) {
  let out = '';
  for (let i = start; i < start + len; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// ------------------------------------------------------------------ EXIF

const EXIF_TAGS = {
  0x010f: ['Fabricante de la cámara', 'personal'],
  0x0110: ['Modelo de cámara', 'personal'],
  0x0112: ['Orientación', 'baja'],
  0x0131: ['Software', 'media'],
  0x0132: ['Fecha de modificación', 'media'],
  0x013b: ['Autor (Artist)', 'personal'],
  0x8298: ['Copyright', 'personal'],
  0x9003: ['Fecha de captura', 'media'],
  0x9004: ['Fecha original digitalizada', 'media'],
  0x9286: ['Comentario de usuario', 'media'],
  0xa002: ['Ancho', 'baja'],
  0xa003: ['Alto', 'baja'],
  0xa420: ['Identificador único de imagen', 'personal'],
  0xa430: ['Propietario de la cámara', 'personal'],
  0xa431: ['Número de serie del cuerpo', 'personal'],
  0xa433: ['Fabricante del objetivo', 'personal'],
  0xa434: ['Modelo del objetivo', 'personal'],
  0xa435: ['Número de serie del objetivo', 'personal'],
  0xc62f: ['Persona fotografiada', 'personal'],
  0x8825: ['Puntos GPS', 'personal'],
};
const GPS_TAGS = {
  1: 'latitud', 2: 'longitud', 3: 'referencia de altitud', 4: 'altitud',
  5: 'referencia de altitud', 6: 'altitud', 7: 'hora GPS', 29: 'fecha GPS',
  18: 'datum', 27: 'dirección de la imagen',
};

/** Lee el bloque TIFF de un EXIF y devuelve los campos útiles. */
export function readExif(bytes) {
  // algunos escritores incluyen la cabecera 'Exif\0\0' dentro del bloque
  if (bytes.length > 6 && ascii(bytes, 0, 6) === EXIF_HEADER) {
    bytes = bytes.subarray(6);
  }
  if (bytes.length < 8) return null;
  const order = ascii(bytes, 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
  const u32 = (o) => (little
    ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
    : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
  if (u16(2) !== 0x2a) return null;

  const readIfd = (offset) => {
    const out = new Map();
    if (offset + 2 > bytes.length) return out;
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const base = offset + 2 + i * 12;
      if (base + 12 > bytes.length) break;
      const tag = u16(base);
      const type = u16(base + 2);
      const n = u32(base + 4);
      const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] || 1;
      const total = size * n;
      const valueOff = total <= 4 ? base + 8 : u32(base + 8);
      let value = null;
      if (type === 2) {
        const chars = [];
        for (let k = 0; k < n && valueOff + k < bytes.length; k++) {
          const c = bytes[valueOff + k];
          if (!c) break;
          chars.push(c);
        }
        value = new TextDecoder('latin1').decode(new Uint8Array(chars));
      } else if (type === 3) {
        value = u16(valueOff);
      } else if (type === 4 || type === 9) {
        value = u32(valueOff);
      } else if (type === 5 || type === 10) {
        value = `${u32(valueOff)}/${u32(valueOff + 4)}`;
      } else if (type === 1 && n <= 4) {
        value = bytes[valueOff];
      }
      out.set(tag, { tag, type, count: n, value, size: total });
    }
    return out;
  };

  const ifd0 = readIfd(u32(4));
  const gpsOffset = ifd0.get(0x8825)?.value;
  const gps = gpsOffset ? readIfd(gpsOffset) : new Map();
  const nextIfd = u32(u32(4) + 2 + ifd0.size * 12);
  const hasThumbnail = nextIfd > 8 && nextIfd < bytes.length;
  return { ifd0, gps, hasThumbnail, orientation: ifd0.get(0x0112)?.value || 0 };
}

/** Construye un EXIF mínimo que solo conserva la orientación. */
export function minimalExif(orientation, width, height) {
  const entries = [];
  if (width) entries.push([0xa002, 4, 1, width]);
  if (height) entries.push([0xa003, 4, 1, height]);
  entries.sort((a, b) => a[0] - b[0]);
  const withOrientation = orientation ? [[0x0112, 3, 1, orientation], ...entries]
    .sort((a, b) => a[0] - b[0]) : entries;
  const count = withOrientation.length;
  const ifdSize = 2 + count * 12 + 4;
  const buf = new Uint8Array(8 + ifdSize);
  buf[0] = 0x4d; buf[1] = 0x4d; // 'MM' = big endian
  buf[2] = 0x00; buf[3] = 0x2a;
  buf[4] = 0; buf[5] = 0; buf[6] = 0; buf[7] = 8;
  buf[8] = (count >> 8) & 0xff; buf[9] = count & 0xff;
  withOrientation.forEach(([tag, type, n, value], i) => {
    const o = 10 + i * 12;
    set16(buf, o, tag);
    set16(buf, o + 2, type);
    set32(buf, o + 4, n);
    // los tipos cortos van en los dos primeros bytes del campo de valor
    if (type === 3 || type === 8) set16(buf, o + 8, value);
    else set32(buf, o + 8, value);
  });
  return buf;
}

function set16(buf, o, v) { buf[o] = (v >> 8) & 0xff; buf[o + 1] = v & 0xff; }
function set32(buf, o, v) {
  buf[o] = (v >>> 24) & 0xff; buf[o + 1] = (v >>> 16) & 0xff;
  buf[o + 2] = (v >>> 8) & 0xff; buf[o + 3] = v & 0xff;
}

// ------------------------------------------------------------------ JPEG

function jpegHeader(bytes) {
  if (bytes.length < 4 || ((bytes[0] << 8) | bytes[1]) !== JPEG_SOI) {
    throw new Error('JPEG inválido.');
  }
  const segs = [];
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('JPEG dañado (marcador inesperado).');
    const marker = bytes[i + 1];
    if (marker === SOS || marker === EOI) return { segs, scanStart: i };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    segs.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  throw new Error('JPEG sin datos de imagen.');
}

function segmentPayload(bytes, seg) {
  return bytes.subarray(seg.start + 4, seg.end);
}

function inspectJpeg(bytes, add, info) {
  const { segs } = jpegHeader(bytes);
  const kinds = [];
  let exif = null;
  for (const seg of segs) {
    const payload = segmentPayload(bytes, seg);
    const head = ascii(payload, 0, 32);
    if (seg.marker === APP1 && head.startsWith(EXIF_HEADER)) {
      kinds.push('EXIF');
      exif = readExif(payload.subarray(6));
    } else if (seg.marker === APP1 && head.startsWith(XMP_HEADER)) {
      kinds.push('XMP');
      info.xmp = true;
      scanXmp(payload, add);
    } else if (seg.marker === APP2 && ascii(payload, 0, ICC_HEADER.length) === ICC_HEADER) {
      kinds.push('ICC');
      info.icc = (info.icc || 0) + payload.length;
    } else if (seg.marker === APP13 && ascii(payload, 0, PS_HEADER.length) === PS_HEADER) {
      kinds.push('IPTC');
      scanIptc(payload, add);
    } else if (seg.marker === COM) {
      kinds.push('COM');
      add('Comentario JPEG', 'Comentario guardado en el archivo',
        ascii(payload, 0, Math.min(payload.length, 140)).trim(), 'media');
    } else if (seg.marker === APP12 && ascii(payload, 0, 5) === DUCKY_HEADER) {
      kinds.push('APP12');
      add('Datos de cámara antiguos', 'Segmento APP12 (Ducky)', 'presente', 'personal');
    }
  }
  if (exif) reportExif(exif, add, info);
  if (info.icc) {
    add('Perfil de color', 'Perfil ICC incrustado', `${info.icc} bytes (se conserva)`, 'baja');
  }
  if (!kinds.length) add('Metadatos de imagen', 'Segmentos con metadatos', 'ninguno', 'baja');
}

function scanXmp(payload, add) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
  const creator = /<dc:creator>[\s\S]{0,300}?<rdf:li[^>]*>([^<]{1,80})</.exec(text);
  if (creator) add('XMP', 'Autor declarado en XMP', creator[1].trim(), 'personal');
  const tool = /<xmp:CreatorTool>([^<]{1,80})</.exec(text);
  if (tool) add('XMP', 'Herramienta que creó el archivo', tool[1].trim(), 'media');
  const city = /<photoshop:(?:City|Country)>([^<]{1,60})</.exec(text);
  if (city) add('XMP', 'Lugar declarado en XMP', city[1].trim(), 'personal');
  if (/<(?:exif:)?GPS(?:Latitude|Longitude)>/.test(text)) {
    add('XMP', 'Coordenadas GPS en XMP', 'presentes', 'personal');
  }
  const rights = /<dc:rights>[\s\S]{0,200}?<rdf:li[^>]*>([^<]{1,80})</.exec(text);
  if (rights) add('XMP', 'Derechos declarados', rights[1].trim(), 'media');
}

function scanIptc(payload, add) {
  const text = new TextDecoder('latin1').decode(payload);
  const read = (id) => {
    const m = new RegExp(`\\x1c\\x02${id}([\\s\\S]{0,140}?)\\x1c`).exec(text);
    return m ? m[1].replace(/[^\x20-\x7e\u00c0-\u00ff]/g, ' ').trim() : '';
  };
  const byline = read('P');
  const credit = read('E');
  const copyright = read('g');
  const caption = read('I');
  if (byline) add('IPTC (Photoshop)', 'Autor (byline)', byline, 'personal');
  if (credit) add('IPTC (Photoshop)', 'Crédito', credit, 'personal');
  if (copyright) add('IPTC (Photoshop)', 'Copyright', copyright, 'media');
  if (caption) add('IPTC (Photoshop)', 'Pie de foto', caption, 'media');
  if (!byline && !credit && !copyright && !caption) {
    add('IPTC (Photoshop)', 'Bloque IPTC', 'presente', 'media');
  }
}

function reportExif(exif, add, info) {
  for (const [tag, entry] of exif.ifd0) {
    const meta = EXIF_TAGS[tag];
    if (!meta || tag === 0x8825 || tag === 0x0112) continue;
    if (entry.value === null || entry.value === '') continue;
    add('EXIF', meta[0], String(entry.value), meta[1]);
  }
  if (exif.gps.size) {
    const keys = [...exif.gps.keys()].map((k) => GPS_TAGS[k] || String(k));
    add('EXIF · ubicación', 'Coordenadas GPS', `presentes: ${[...new Set(keys)].join(', ')}`, 'personal');
    info.gps = true;
  }
  if (exif.hasThumbnail) {
    add('EXIF', 'Miniatura incrustada en el EXIF',
      'puede mostrar una versión distinta de la foto', 'media');
  }
  if (exif.orientation) {
    add('EXIF', 'Orientación', `${exif.orientation} (se conserva)`, 'baja');
    info.orientation = exif.orientation;
  }
}

/** Primer APP1 con EXIF del archivo (orientación, tamaño y campos). */
function findApp1Exif(segs, bytes) {
  for (const seg of segs) {
    if (seg.marker !== APP1) continue;
    const payload = segmentPayload(bytes, seg);
    if (ascii(payload, 0, EXIF_HEADER.length) !== EXIF_HEADER) continue;
    const exif = readExif(payload.subarray(6));
    if (exif) return exif;
  }
  return null;
}

function buildExifSegment(orientation, width, height) {
  const tiff = minimalExif(orientation, width, height);
  const total = tiff.length + 6;
  const seg = new Uint8Array(total + 4);
  seg[0] = 0xff;
  seg[1] = APP1;
  const len = total + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  const header = [...EXIF_HEADER].map((c) => c.charCodeAt(0));
  seg.set(new Uint8Array(header), 4);
  seg.set(tiff, 10);
  return seg;
}

function stripJpeg(bytes, opts, stats, notes) {
  const { segs, scanStart } = jpegHeader(bytes);
  const exif = findApp1Exif(segs, bytes);
  const orientation = exif ? exif.orientation : 0;
  const width = exif ? Number(exif.ifd0.get(0xa002)?.value) || 0 : 0;
  const height = exif ? Number(exif.ifd0.get(0xa003)?.value) || 0 : 0;
  if (exif) {
    stats.exifFields = exif.ifd0.size;
    if (exif.gps.size) stats.gps = [...exif.gps.keys()].length;
    if (exif.hasThumbnail) stats.thumbnails++;
  }

  const kept = [];
  for (const seg of segs) {
    const payload = segmentPayload(bytes, seg);
    const head = ascii(payload, 0, 32);
    let drop = false;
    if (seg.marker === APP1 && (head.startsWith(EXIF_HEADER) || head.startsWith(XMP_HEADER))) {
      drop = true;
      if (head.startsWith(XMP_HEADER)) stats.xmp++;
    } else if (seg.marker === APP13 && ascii(payload, 0, PS_HEADER.length) === PS_HEADER) {
      drop = true;
      stats.iptc++;
    } else if (seg.marker === COM) {
      drop = true;
      stats.comments++;
    } else if (seg.marker === APP12 && ascii(payload, 0, 5) === DUCKY_HEADER) {
      drop = true;
      stats.vendor++;
    } else if (seg.marker === APP2 && ascii(payload, 0, ICC_HEADER.length) === ICC_HEADER) {
      if (opts.icc === 'remove') {
        drop = true;
        stats.icc++;
      }
    }
    if (!drop) kept.push({ marker: seg.marker, data: bytes.subarray(seg.start, seg.end) });
  }

  const keepOrientation = opts.orientation !== 'remove' && orientation;
  const pieces = [bytes.subarray(0, 2)];
  let inserted = false;
  if (keepOrientation && (kept.length === 0 || kept[0].marker !== 0xe0)) {
    pieces.push(buildExifSegment(orientation, width, height));
    inserted = true;
    stats.keptOrientation = orientation;
  }
  kept.forEach((seg, i) => {
    pieces.push(seg.data);
    if (!inserted && keepOrientation && seg.marker === 0xe0
        && (i + 1 === kept.length || kept[i + 1].marker !== 0xe0)) {
      pieces.push(buildExifSegment(orientation, width, height));
      inserted = true;
      stats.keptOrientation = orientation;
    }
  });
  if (orientation && !keepOrientation) {
    notes.add('Orientación descartada: la foto puede verse girada');
  }
  pieces.push(bytes.subarray(scanStart));
  const total = pieces.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of pieces) { merged.set(c, o); o += c.length; }
  return merged;
}

// ------------------------------------------------------------------ PNG

function pngChunks(bytes) {
  const chunks = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
    const type = ascii(bytes, i + 4, 4);
    chunks.push({ type, start: i, end: i + 12 + len });
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function inspectPng(bytes, add, info) {
  const chunks = pngChunks(bytes);
  const types = chunks.map((c) => c.type);
  for (const c of chunks) {
    if (!PNG_META.has(c.type)) continue;
    const data = bytes.subarray(c.start + 8, c.end - 4);
    if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      const text = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 160)));
      add('Texto incrustado en el PNG', `Chunk ${c.type}`,
        text.replace(/[^\x20-\x7e\u00c0-\u00ff]/g, ' ').trim(), 'media');
    } else if (c.type === 'eXIf') {
      const exif = readExif(data);
      if (exif) {
        reportExif(exif, add, info);
        if (exif.gps.size) info.gps = true;
        if (exif.orientation) info.orientation = exif.orientation;
      }
    } else if (c.type === 'tIME') {
      add('Texto incrustado en el PNG', 'Fecha de modificación (tIME)', 'presente', 'media');
    }
  }
  const icc = chunks.find((c) => c.type === 'iCCP');
  if (icc) {
    info.icc = icc.end - icc.start;
    add('Perfil de color', 'Perfil ICC incrustado', `${info.icc} bytes (se conserva)`, 'baja');
  }
  if (types.includes('acTL')) add('PNG animado', 'Animación (APNG)', 'se conserva', 'baja');
}

function buildPngExifChunk(orientation, width, height) {
  const tiff = minimalExif(orientation, width, height);
  const type = new Uint8Array([0x65, 0x58, 0x49, 0x66]); // 'eXIf'
  const body = new Uint8Array(type.length + tiff.length);
  body.set(type, 0);
  body.set(tiff, type.length);
  // chunk = longitud(4) + tipo(4) + datos + crc(4)
  const out = new Uint8Array(8 + body.length);
  out[0] = (tiff.length >>> 24) & 0xff;
  out[1] = (tiff.length >>> 16) & 0xff;
  out[2] = (tiff.length >>> 8) & 0xff;
  out[3] = tiff.length & 0xff;
  out.set(body, 4);
  const crc = crc32(body);
  const at = 4 + body.length;
  out[at] = (crc >>> 24) & 0xff;
  out[at + 1] = (crc >>> 16) & 0xff;
  out[at + 2] = (crc >>> 8) & 0xff;
  out[at + 3] = crc & 0xff;
  return out;
}

function stripPng(bytes, opts, stats) {
  const chunks = pngChunks(bytes);
  const out = [bytes.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'eXIf') {
      const data = bytes.subarray(c.start + 8, c.end - 4);
      const exif = readExif(data);
      if (exif) {
        if (exif.gps.size) stats.gps = [...exif.gps.keys()].length;
        stats.exifFields = exif.ifd0.size;
        if (exif.hasThumbnail) stats.thumbnails++;
        if (exif.orientation && opts.orientation !== 'remove') {
          const width = Number(exif.ifd0.get(0xa002)?.value) || 0;
          const height = Number(exif.ifd0.get(0xa003)?.value) || 0;
          out.push(buildPngExifChunk(exif.orientation, width, height));
          stats.keptOrientation = exif.orientation;
        }
      }
      stats.pngExif++;
      continue;
    }
    if (PNG_META.has(c.type)) {
      stats.pngText++;
      continue;
    }
    if (c.type === 'iCCP' && opts.icc === 'remove') {
      stats.icc++;
      continue;
    }
    out.push(bytes.subarray(c.start, c.end));
  }
  const total = out.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of out) { merged.set(c, o); o += c.length; }
  return merged;
}

// ------------------------------------------------------------------ WebP

const WEBP_EXIF = 0x08;
const WEBP_XMP = 0x04;

function webpChunks(bytes) {
  const chunks = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, 4);
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    chunks.push({ type, start: i, size, end: i + 8 + size + (size % 2) });
    i += 8 + size + (size % 2);
  }
  return chunks;
}

function inspectWebp(bytes, add, info) {
  const chunks = webpChunks(bytes);
  for (const c of chunks) {
    if (c.type === 'EXIF') {
      info.exif = true;
      const exif = readExif(bytes.subarray(c.start + 8, c.start + 8 + c.size));
      if (exif) {
        reportExif(exif, add, info);
        if (exif.gps.size) info.gps = true;
        if (exif.orientation) info.orientation = exif.orientation;
      }
    } else if (c.type === 'XMP ') {
      info.xmp = true;
      scanXmp(bytes.subarray(c.start + 8, c.start + 8 + c.size), add);
    } else if (c.type === 'ICCP') {
      info.icc = c.size;
      add('Perfil de color', 'Perfil ICC incrustado', `${c.size} bytes (se conserva)`, 'baja');
    } else if (c.type === 'ANIM') {
      add('WebP animado', 'Animación', 'se conserva', 'baja');
    }
  }
  if (!info.exif && !info.xmp) {
    add('Metadatos de imagen', 'Bloques EXIF/XMP', 'ninguno', 'baja');
  }
}

function stripWebp(bytes, opts, stats) {
  const chunks = webpChunks(bytes);
  const kept = [];
  let orientation = 0;
  let width = 0;
  let height = 0;
  for (const c of chunks) {
    if (c.type === 'EXIF') {
      const exif = readExif(bytes.subarray(c.start + 8, c.start + 8 + c.size));
      if (exif) {
        orientation = exif.orientation;
        width = Number(exif.ifd0.get(0xa002)?.value) || 0;
        height = Number(exif.ifd0.get(0xa003)?.value) || 0;
        stats.exifFields = exif.ifd0.size;
        if (exif.gps.size) stats.gps = [...exif.gps.keys()].length;
        if (exif.hasThumbnail) stats.thumbnails++;
      }
      stats.webpExif++;
      continue;
    }
    if (c.type === 'XMP ') {
      stats.webpXmp++;
      continue;
    }
    if (c.type === 'ICCP' && opts.icc === 'remove') {
      stats.icc++;
      continue;
    }
    kept.push({ type: c.type, data: bytes.subarray(c.start, c.end) });
  }

  const keepOrientation = opts.orientation !== 'remove' && orientation;
  const exifChunk = keepOrientation
    ? minimalChunk('EXIF', minimalExif(orientation, width, height))
    : null;
  for (const c of kept) {
    if (c.type !== 'VP8X') continue;
    const copy = c.data.slice();
    copy[8] &= ~(WEBP_EXIF | WEBP_XMP);
    if (exifChunk) copy[8] |= WEBP_EXIF;
    c.data = copy;
  }

  const body = kept.reduce((s, c) => s + c.data.length, 0) + (exifChunk ? exifChunk.length : 0);
  const out = new Uint8Array(12 + body);
  out.set(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 0);
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  out.set(new Uint8Array([0x57, 0x45, 0x42, 0x50]), 8);
  let o = 12;
  for (const c of kept) { out.set(c.data, o); o += c.data.length; }
  if (exifChunk) {
    out.set(exifChunk, o);
    stats.keptOrientation = orientation;
  }
  return out;
}

/** Chunk RIFF (tipo + tamaño + datos + relleno par). */
function minimalChunk(type, data) {
  const pad = data.length % 2;
  const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  out[4] = data.length & 0xff;
  out[5] = (data.length >> 8) & 0xff;
  out[6] = (data.length >> 16) & 0xff;
  out[7] = (data.length >> 24) & 0xff;
  out.set(data, 8);
  return out;
}

// ------------------------------------------------------------------ API

export function inspectImage(bytes) {
  const format = sniff(bytes);
  const findings = [];
  const info = { format, size: bytes.length, gps: false, xmp: false, icc: 0, orientation: 0 };
  const add = (group, label, value, sev, keep = false) => {
    const v = (value ?? '').toString().trim();
    if (v) findings.push({ group, label, value: v, sev, keep });
  };
  const LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', tiff: 'TIFF', heic: 'HEIC', avif: 'AVIF' };
  add('Archivo', 'Tipo detectado', `${LABEL[format] || format} · ${(bytes.length / 1024).toFixed(0)} KB`, 'baja');
  if (format === 'tiff') {
    // en TIFF el EXIF es el propio archivo: se puede leer aunque no reescribir
    const exif = readExif(bytes);
    if (exif) reportExif(exif, add, info);
  }
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
    add('Archivo', 'Formato no soportado para limpiar',
      'este formato todavía no se puede reescribir sin recodificar la imagen', 'media', true);
    return { findings, info, format, supported: false };
  }
  if (format === 'jpeg') inspectJpeg(bytes, add, info);
  else if (format === 'png') inspectPng(bytes, add, info);
  else if (format === 'webp') inspectWebp(bytes, add, info);
  return { findings, info, format, supported: true };
}

export function stripImage(bytes, opts) {
  const format = sniff(bytes);
  const stats = {
    exifFields: 0, gps: 0, xmp: 0, iptc: 0, comments: 0, vendor: 0,
    pngText: 0, pngExif: 0, webpExif: 0, webpXmp: 0, icc: 0,
    thumbnails: 0, keptOrientation: 0,
  };
  const notes = new Set();
  let out;
  if (format === 'jpeg') out = stripJpeg(bytes, opts, stats, notes);
  else if (format === 'png') out = stripPng(bytes, opts, stats);
  else if (format === 'webp') out = stripWebp(bytes, opts, stats);
  else throw new Error('Formato de imagen no soportado para limpiar.');

  if (stats.exifFields) notes.add(`EXIF: ${stats.exifFields} campos eliminados (cámara, objetivos, fechas, software, autor)`);
  if (stats.gps) notes.add(`Coordenadas GPS eliminadas (${stats.gps} campos)`);
  if (stats.thumbnails) notes.add('Miniatura incrustada eliminada');
  if (stats.xmp) notes.add('XMP eliminado (autor, derechos, lugar)');
  if (stats.iptc) notes.add('Bloque IPTC de Photoshop eliminado (autor, crédito, pie de foto)');
  if (stats.comments) notes.add('Comentario guardado en el archivo, eliminado');
  if (stats.vendor) notes.add('Datos de cámara antiguos (APP12) eliminados');
  if (stats.pngText) notes.add(`${stats.pngText} chunks de texto del PNG eliminados (autor, descripción, fecha)`);
  if (stats.pngExif) notes.add('Bloque EXIF del PNG eliminado');
  if (stats.webpExif || stats.webpXmp) {
    const what = [stats.webpExif ? 'EXIF' : null, stats.webpXmp ? 'XMP' : null]
      .filter(Boolean).join(' y ');
    notes.add(`Bloques ${what} del WebP eliminados, y sus marcas en la cabecera`);
  }
  if (stats.icc) notes.add('Perfil de color ICC eliminado (los colores pueden verse distintos)');
  if (stats.keptOrientation) notes.add(`Orientación ${stats.keptOrientation} conservada para que la foto no salga girada`);
  notes.add('La imagen NO se recodifica: los píxeles son idénticos al original');

  return { bytes: out, removed: Array.from(notes), stats, format };
}
