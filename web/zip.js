// Lector/escritor ZIP para .docx, sin dependencias: usa DecompressionStream /
// CompressionStream nativos del navegador (deflate-raw = método 8 de ZIP).

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// 1980-01-01 00:00:00 en formato MS-DOS (fecha mínima del formato ZIP)
export const FIXED_TIME = 0;
export const FIXED_DATE = 0x0021;

const utf8 = new TextDecoder();
const utf8enc = new TextEncoder();

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) =>
  (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data) {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(data) {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dosDateTime(time, date) {
  return {
    year: 1980 + ((date >> 9) & 0x7f),
    month: (date >> 5) & 0x0f,
    day: date & 0x1f,
    hour: (time >> 11) & 0x1f,
    minute: (time >> 5) & 0x3f,
    second: (time & 0x1f) * 2,
  };
}

export function formatDosDateTime(time, date) {
  const d = dosDateTime(time, date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}:${p(d.second)}`;
}

/** Lee todas las entradas de un ZIP en memoria. */
export async function readZip(bytes) {
  if (bytes.length < 22) throw new Error('El archivo no es un ZIP válido.');
  const limit = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= limit; i--) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('No se encontró el directorio del ZIP (.docx dañado).');
  const count = u16(bytes, eocd + 10);
  const cdOff = u32(bytes, eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) {
    throw new Error('Archivos ZIP64 no soportados.');
  }
  const entries = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (u32(bytes, p) !== SIG_CDH) throw new Error('Directorio central dañado.');
    const versionMadeBy = u16(bytes, p + 4);
    const method = u16(bytes, p + 10);
    const time = u16(bytes, p + 12);
    const date = u16(bytes, p + 14);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const extAttr = u32(bytes, p + 38);
    const lho = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lnameLen = u16(bytes, lho + 26);
    const lextraLen = u16(bytes, lho + 28);
    const start = lho + 30 + lnameLen + lextraLen;
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 8) data = await inflateRaw(raw);
    else if (method === 0) data = raw.slice();
    else throw new Error(`Compresión ZIP no soportada (método ${method}) en ${name}.`);
    if (method === 8 && usize !== data.length) {
      throw new Error(`Entrada dañada en ${name}.`);
    }
    entries.push({
      name,
      data,
      time,
      date,
      extAttr,
      versionMadeBy,
      isDir: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Reescribe el ZIP completo, con fechas fijas y orden de entradas estable. */
export async function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = utf8enc.encode(e.name);
    const raw = e.data;
    const comp = await deflateRaw(raw);
    const crc = crc32(raw);
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, SIG_LFH, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // nombres en UTF-8
    dv.setUint16(8, 8, true);
    dv.setUint16(10, FIXED_TIME, true);
    dv.setUint16(12, FIXED_DATE, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, raw.length, true);
    dv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    chunks.push(lh, comp);
    central.push({ e, nameBytes, crc, comp, raw, offset });
    offset += lh.length + comp.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const ch = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(ch.buffer);
    dv.setUint32(0, SIG_CDH, true);
    dv.setUint16(4, c.e.versionMadeBy || 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, 8, true);
    dv.setUint16(12, FIXED_TIME, true);
    dv.setUint16(14, FIXED_DATE, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.comp.length, true);
    dv.setUint32(24, c.raw.length, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint32(38, c.e.extAttr || 0, true);
    dv.setUint32(42, c.offset, true);
    ch.set(c.nameBytes, 46);
    chunks.push(ch);
    offset += ch.length;
  }

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, SIG_EOCD, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  chunks.push(eocd);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
