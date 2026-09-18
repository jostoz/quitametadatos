// Metadatos y limpieza de PDF.
//
// Lo que de verdad filtra un PDF no es /Info: son las actualizaciones
// incrementales, que dejan dentro del archivo el texto y los objetos de las
// versiones anteriores (una "redacción" mal hecha se recupera con un editor de
// texto). Aquí se reescribe el documento: se conserva la última versión de cada
// objeto, se extraen los objetos comprimidos en flujos y se eliminan las claves
// de metadatos. Los flujos de contenido se copian byte a byte —no se
// reinterpretan ni se recomprimen—, así que la imagen no cambia.

const WS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const enc = new TextEncoder();

const latin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const utf8 = new TextDecoder('utf-8', { fatal: false });

export function sniffPdf(bytes) {
  if (bytes.length < 5) return false;
  for (let i = 0; i < Math.min(bytes.length - 5, 1024); i++) {
    if (latin1(bytes.subarray(i, i + 5)) === '%PDF-') return true;
  }
  return false;
}

const isWs = (b, i) => WS.has(b[i]);
function skipWs(b, i, end) {
  while (i < end && WS.has(b[i])) i++;
  return i;
}

function readIntAt(b, i, end) {
  const start = i;
  while (i < end && b[i] >= 0x30 && b[i] <= 0x39) i++;
  if (i === start) return null;
  return { value: Number(latin1(b.subarray(start, i))), next: i };
}

/** Si en i empieza "N G R", devuelve el índice tras la R. */
function readRefAt(b, start, end) {
  let i = skipWs(b, start, end);
  const n1 = readIntAt(b, i, end);
  if (!n1) return 0;
  i = skipWs(b, n1.next, end);
  const n2 = readIntAt(b, i, end);
  if (!n2) return 0;
  i = skipWs(b, n2.next, end);
  if (b[i] !== 0x52) return 0;
  const after = i + 1;
  if (after < end && !isWs(b, after) && !DELIM.has(b[after])) return 0;
  return after;
}

/** Índice justo después del valor que empieza en i. */
function skipValue(b, i, end) {
  i = skipWs(b, i, end);
  if (i >= end) return end;
  const c = b[i];
  if (c === 0x2f) {
    i++;
    while (i < end && !isWs(b, i) && !DELIM.has(b[i])) i++;
    return i;
  }
  if (c === 0x28) {
    i++;
    let depth = 1;
    while (i < end) {
      const ch = b[i];
      if (ch === 0x5c) { i += 2; continue; }
      if (ch === 0x28) depth++;
      else if (ch === 0x29) { depth--; if (!depth) return i + 1; }
      i++;
    }
    return end;
  }
  if (c === 0x3c) {
    if (b[i + 1] === 0x3c) {
      i += 2;
      let depth = 1;
      while (i < end) {
        if (b[i] === 0x3c && b[i + 1] === 0x3c) { depth++; i += 2; continue; }
        if (b[i] === 0x3e && b[i + 1] === 0x3e) {
          depth--; i += 2;
          if (!depth) return i;
          continue;
        }
        if (b[i] === 0x28 || b[i] === 0x2f || b[i] === 0x5b || b[i] === 0x3c) {
          i = skipValue(b, i, end);
          continue;
        }
        i++;
      }
      return end;
    }
    i++;
    while (i < end && b[i] !== 0x3e) i++;
    return i + 1;
  }
  if (c === 0x5b) {
    i++;
    for (;;) {
      i = skipWs(b, i, end);
      if (i >= end || b[i] === 0x5d) return i + 1;
      i = skipValue(b, i, end);
    }
  }
  if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
    const ref = readRefAt(b, i, end);
    if (ref) return ref;
    i = skipWs(b, i, end);
    while (i < end && !isWs(b, i) && !DELIM.has(b[i])) i++;
    return i;
  }
  while (i < end && !isWs(b, i) && !DELIM.has(b[i])) i++;
  return i;
}

/** Claves de nivel superior de un diccionario, con sus rangos absolutos. */
function parseDict(b, start, end) {
  start = skipWs(b, start, end);
  if (b[start] !== 0x3c || b[start + 1] !== 0x3c) return null;
  let i = skipWs(b, start + 2, end);
  const entries = [];
  while (i < end) {
    if (b[i] === 0x3e && b[i + 1] === 0x3e) return { start, end: i + 2, entries };
    if (b[i] !== 0x2f) {
      const next = skipValue(b, i, end);
      if (next <= i) break;
      i = skipWs(b, next, end);
      continue;
    }
    const keyStart = i;
    i++;
    while (i < end && !isWs(b, i) && !DELIM.has(b[i])) i++;
    const key = latin1(b.subarray(keyStart + 1, i));
    const valStart = skipWs(b, i, end);
    const valEnd = skipValue(b, valStart, end);
    if (valEnd <= valStart) break;
    entries.push({ key, keyStart, valStart, valEnd });
    i = skipWs(b, valEnd, end);
  }
  return { start, end, entries };
}

function skipName(b, i, end) {
  i++;
  while (i < end && !isWs(b, i) && !DELIM.has(b[i])) i++;
  return i;
}

/** Recorre un valor entero (diccionarios y arreglos incluidos) y devuelve sus referencias. */
function walkValue(b, i, end, out) {
  i = skipWs(b, i, end);
  if (i >= end) return end;
  const c = b[i];
  if (c === 0x3c && b[i + 1] === 0x3c) {
    i += 2;
    for (;;) {
      i = skipWs(b, i, end);
      if (i >= end) return i;
      if (b[i] === 0x3e && b[i + 1] === 0x3e) return i + 2;
      if (b[i] === 0x2f) {
        i = skipName(b, i, end);
        continue;
      }
      i = walkValue(b, i, end, out);
    }
  }
  if (c === 0x5b) {
    i++;
    for (;;) {
      i = skipWs(b, i, end);
      if (i >= end || b[i] === 0x5d) return i + 1;
      i = walkValue(b, i, end, out);
    }
  }
  const ref = readRefAt(b, i, end);
  if (ref) {
    const n = readIntAt(b, i, end);
    if (n) out.push(n.value);
    return ref;
  }
  return skipValue(b, i, end);
}

function collectRefs(b, start, end) {
  const out = [];
  walkValue(b, start, end, out);
  return out;
}

function decodeString(b, start, end) {
  if (b[start] === 0x28) {
    const raw = [];
    let i = start + 1;
    let depth = 1;
    while (i < end) {
      const ch = b[i];
      if (ch === 0x5c) {
        const nxt = b[i + 1];
        if (nxt === 0x6e) raw.push(0x0a);
        else if (nxt === 0x72) raw.push(0x0d);
        else if (nxt === 0x74) raw.push(0x09);
        else if (nxt >= 0x30 && nxt <= 0x37) {
          let oct = '';
          let k = i + 1;
          while (k < end && oct.length < 3 && b[k] >= 0x30 && b[k] <= 0x37) {
            oct += String.fromCharCode(b[k]);
            k++;
          }
          raw.push(parseInt(oct, 8) & 0xff);
          i = k;
          continue;
        } else raw.push(nxt);
        i += 2;
        continue;
      }
      if (ch === 0x28) depth++;
      if (ch === 0x29) {
        depth--;
        if (!depth) break;
      }
      raw.push(ch);
      i++;
    }
    const arr = new Uint8Array(raw);
    if (arr[0] === 0xfe && arr[1] === 0xff) {
      let s = '';
      for (let k = 2; k + 1 < arr.length; k += 2) {
        s += String.fromCharCode((arr[k] << 8) | arr[k + 1]);
      }
      return s;
    }
    return latin1(arr);
  }
  if (b[start] === 0x3c && b[start + 1] !== 0x3c) {
    let hex = '';
    for (let i = start + 1; i < end && b[i] !== 0x3e; i++) hex += String.fromCharCode(b[i]);
    if (hex.length % 2) hex += '0';
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return latin1(arr);
  }
  return '';
}

function concat(pieces) {
  const total = pieces.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of pieces) { out.set(p, o); o += p.length; }
  return out;
}

/** Borra de `body` los rangos absolutos indicados (referidos al archivo). */
function deleteRanges(body, bodyStart, ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const r of sorted) {
    const s = Math.max(0, r.start - bodyStart);
    const e = Math.max(0, r.end - bodyStart);
    if (s > pos) out.push(body.subarray(pos, s));
    pos = Math.max(pos, e);
  }
  if (pos < body.length) out.push(body.subarray(pos));
  return concat(out);
}

// ---------------------------------------------------------------- objetos

async function inflateZlib(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Deshace el predictor PNG (/Predictor 12 o 15) de un flujo ya inflado. */
function undoPredictor(data, columns) {
  let rowLen = columns + 1;
  if (data.length % rowLen !== 0) {
    if (columns > 0 && data.length % columns === 0) rowLen = columns;
    else return data;
  }
  const withFilter = rowLen !== columns;
  const width = withFilter ? rowLen - 1 : columns;
  if (width <= 0) return data;
  const rows = Math.floor(data.length / rowLen);
  const out = new Uint8Array(rows * width);
  let prev = new Uint8Array(width);
  for (let r = 0; r < rows; r++) {
    const src = r * rowLen;
    const filter = withFilter ? data[src] : 0;
    const row = new Uint8Array(width);
    const offset = src + (withFilter ? 1 : 0);
    for (let i = 0; i < width; i++) {
      const x = data[offset + i] || 0;
      const left = i >= 1 ? row[i - 1] : 0;
      const up = prev[i];
      const upLeft = i >= 1 ? prev[i - 1] : 0;
      let value = x;
      if (filter === 1) value = x + left;
      else if (filter === 2) value = x + up;
      else if (filter === 3) value = x + ((left + up) >> 1);
      else if (filter === 4) value = x + paeth(left, up, upLeft);
      row[i] = value & 0xff;
    }
    out.set(row, r * width);
    prev = row;
  }
  return out;
}

function predictorParams(bytes, obj) {
  const parms = obj.dict && obj.dict.entries.find(
    (e) => e.key === 'DecodeParms' || e.key === 'DP');
  if (!parms) return null;
  const dict = parseDict(bytes, skipWs(bytes, parms.valStart, bytes.length), bytes.length);
  if (!dict) return null;
  const pred = dict.entries.find((e) => e.key === 'Predictor');
  const cols = dict.entries.find((e) => e.key === 'Columns');
  const predictor = pred ? Number(latin1(bytes.subarray(pred.valStart, pred.valEnd))) : 1;
  const columns = cols ? Number(latin1(bytes.subarray(cols.valStart, cols.valEnd))) : 1;
  return { predictor, columns };
}

/** Infla el flujo y deshace el predictor si lo lleva. */
async function inflateMaybe(bytes, obj) {
  const filters = obj.dict && obj.dict.entries.find((e) => e.key === 'Filter');
  const text = filters ? latin1(bytes.subarray(filters.valStart, filters.valEnd)) : '';
  const raw = streamData(bytes, obj);
  if (!raw) return null;
  let data = raw;
  if (text) {
    if (!text.includes('FlateDecode')) return null;
    try {
      data = await inflateZlib(raw);
    } catch (e) {
      return null;
    }
  }
  const params = predictorParams(bytes, obj);
  if (params && params.predictor > 1) data = undoPredictor(data, params.columns);
  return data;
}

/** Cuerpo de un objeto en bodyStart; exige que la estructura cierre con endobj. */
function parseObjectBody(bytes, text, bodyStart) {
  const dict = parseDict(bytes, bodyStart, bytes.length);
  if (dict) {
    const afterDict = skipWs(bytes, dict.end, bytes.length);
    if (latin1(bytes.subarray(afterDict, afterDict + 6)) === 'stream') {
      let dataStart = afterDict + 6;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      const le = dict.entries.find((e) => e.key === 'Length');
      let dataLen = null;
      if (le) {
        const c = bytes[le.valStart];
        if (c >= 0x30 && c <= 0x39) {
          dataLen = Number(latin1(bytes.subarray(le.valStart, skipValue(bytes, le.valStart, bytes.length))));
        }
      }
      const endstreamAt = text.indexOf('endstream', dataLen === null ? dataStart : dataStart + dataLen);
      if (endstreamAt < 0) return null;
      if (!/^\s*endobj\b/.test(latin1(bytes.subarray(endstreamAt + 9, endstreamAt + 40)))) return null;
      return {
        bodyStart, bodyEnd: endstreamAt + 9, dict,
        streamRange: { dataStart, dataLen, endstreamAt },
      };
    }
    if (!/^\s*endobj\b/.test(latin1(bytes.subarray(dict.end, dict.end + 40)))) return null;
    return { bodyStart, bodyEnd: dict.end, dict, streamRange: null };
  }
  const valEnd = skipValue(bytes, bodyStart, bytes.length);
  if (valEnd <= bodyStart) return null;
  if (!/^\s*endobj\b/.test(latin1(bytes.subarray(valEnd, valEnd + 40)))) return null;
  return { bodyStart, bodyEnd: valEnd, dict: null, streamRange: null };
}

function scanObjects(bytes) {
  const text = latin1(bytes);
  const re = /(^|[^\d])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  const found = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[2]);
    const gen = Number(m[3]);
    const bodyStart = skipWs(bytes, m.index + m[0].length, bytes.length);
    const body = parseObjectBody(bytes, text, bodyStart);
    if (!body) continue; // coincidencia dentro de datos binarios: se descarta
    const prev = found.get(num);
    if (!prev || prev.bodyStart < bodyStart) found.set(num, { num, gen, ...body });
  }
  return found;
}

function streamData(bytes, obj) {
  const sr = obj.streamRange;
  if (!sr || sr.endstreamAt < 0) return null;
  const available = sr.endstreamAt - sr.dataStart;
  const len = sr.dataLen === null || sr.dataLen === undefined ? available : sr.dataLen;
  return bytes.subarray(sr.dataStart, sr.dataStart + Math.min(len, available));
}

// ---------------------------------------------------------------- xref

function beValue(b, offset, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + (b[offset + i] || 0);
  return v;
}

/** Lee un objeto en un desplazamiento conocido. */
function parseObjectAt(bytes, offset, text) {
  const m = /^(\d{1,10})\s+(\d{1,5})\s+obj\b/.exec(text.substr(offset, 32));
  if (!m) return null;
  const bodyStart = skipWs(bytes, offset + m[0].length, bytes.length);
  const body = parseObjectBody(bytes, text, bodyStart);
  if (!body) return null;
  return { num: Number(m[1]), gen: Number(m[2]), ...body };
}

async function readXrefSection(bytes, offset, text, depth = 0) {
  if (depth > 32 || offset < 0 || offset >= bytes.length) return null;
  if (latin1(bytes.subarray(offset, offset + 4)) === 'xref') {
    const entries = new Map();
    let i = offset + 4;
    for (;;) {
      i = skipWs(bytes, i, bytes.length);
      if (latin1(bytes.subarray(i, i + 7)) === 'trailer') {
        const dict = parseDict(bytes, skipWs(bytes, i + 7, bytes.length), bytes.length);
        let prev = -1;
        if (dict) {
          const p = dict.entries.find((e) => e.key === 'Prev');
          if (p) prev = Number(latin1(bytes.subarray(p.valStart, p.valEnd)));
          const hybrid = dict.entries.find((e) => e.key === 'XRefStm');
          if (hybrid) {
            const extra = await readXrefSection(bytes,
              Number(latin1(bytes.subarray(hybrid.valStart, hybrid.valEnd))), text, depth + 1);
            if (extra) {
              for (const [n, e] of extra.entries) if (!entries.has(n)) entries.set(n, e);
            }
          }
        }
        return { entries, dict, prev };
      }
      const start = readIntAt(bytes, i, bytes.length);
      if (!start) break;
      i = skipWs(bytes, start.next, bytes.length);
      const count = readIntAt(bytes, i, bytes.length);
      if (!count) break;
      i = skipWs(bytes, count.next, bytes.length);
      for (let k = 0; k < count.value; k++) {
        const num = start.value + k;
        const line = text.substr(i, 20);
        if (line.length < 18) break;
        const off = Number(line.slice(0, 10).trim());
        const gen = Number(line.slice(11, 16).trim());
        const kind = line.charAt(17);
        if (kind === 'n' && !entries.has(num)) entries.set(num, { type: 1, offset: off, gen });
        i += 20;
      }
    }
    return { entries, dict: null, prev: -1 };
  }
  const obj = parseObjectAt(bytes, offset, text);
  if (!obj || typeOf(bytes, obj) !== '/XRef') return null;
  const wEntry = obj.dict.entries.find((e) => e.key === 'W');
  const sEntry = obj.dict.entries.find((e) => e.key === 'Size');
  if (!wEntry || !sEntry) return null;
  const w = latin1(bytes.subarray(wEntry.valStart, wEntry.valEnd))
    .replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number);
  const size = Number(latin1(bytes.subarray(sEntry.valStart, sEntry.valEnd)));
  const idxEntry = obj.dict.entries.find((e) => e.key === 'Index');
  const index = idxEntry
    ? latin1(bytes.subarray(idxEntry.valStart, idxEntry.valEnd))
      .replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number)
    : [0, size];
  const data = await inflateMaybe(bytes, obj);
  if (!data) return null;
  const entries = new Map();
  const stride = w.reduce((a, b) => a + b, 0);
  if (!stride) return null;
  let pos = 0;
  for (let k = 0; k + 1 < index.length; k += 2) {
    const first = index[k];
    const count = index[k + 1];
    for (let j = 0; j < count; j++) {
      if (pos + stride > data.length) break;
      const type = w[0] === 0 ? 1 : beValue(data, pos, w[0]);
      const f2 = beValue(data, pos + w[0], w[1]);
      const f3 = beValue(data, pos + w[0] + w[1], w[2]);
      const num = first + j;
      if (type === 1 && !entries.has(num)) entries.set(num, { type: 1, offset: f2, gen: f3 });
      else if (type === 2 && !entries.has(num)) entries.set(num, { type: 2, stmNum: f2, index: f3 });
      pos += stride;
    }
  }
  let prev = -1;
  const p = obj.dict.entries.find((e) => e.key === 'Prev');
  if (p) prev = Number(latin1(bytes.subarray(p.valStart, p.valEnd)));
  return { entries, dict: obj.dict, prev };
}

/** Tabla xref autoritativa, siguiendo la cadena /Prev. */
async function readXref(bytes, text) {
  const at = text.lastIndexOf('startxref');
  if (at < 0) return null;
  const n = readIntAt(bytes, skipWs(bytes, at + 9, bytes.length), bytes.length);
  if (!n) return null;
  const entries = new Map();
  let section = null;
  let offset = n.value;
  const seen = new Set();
  while (offset >= 0 && !seen.has(offset)) {
    seen.add(offset);
    const current = await readXrefSection(bytes, offset, text);
    if (!current) break;
    if (!section && current.dict) section = current.dict;
    for (const [num, e] of current.entries) if (!entries.has(num)) entries.set(num, e);
    offset = current.prev;
  }
  if (!section || !entries.size) return null;
  return { entries, trailer: section };
}

/** Materializa los objetos según el xref (tipo 1 directos, tipo 2 en flujos). */
async function objectsFromXref(bytes, text, xref) {
  const objects = new Map();
  const stmSpans = new Map();
  const needStm = new Set();
  for (const e of xref.entries.values()) if (e.type === 2) needStm.add(e.stmNum);
  for (const num of needStm) {
    const entry = xref.entries.get(num);
    if (!entry || entry.type !== 1) continue;
    const obj = parseObjectAt(bytes, entry.offset, text);
    if (!obj || !obj.dict) continue;
    const data = await inflateMaybe(bytes, obj);
    if (!data) continue;
    const nEntry = obj.dict.entries.find((e) => e.key === 'N');
    const fEntry = obj.dict.entries.find((e) => e.key === 'First');
    if (!nEntry || !fEntry) continue;
    const count = Number(latin1(bytes.subarray(nEntry.valStart, nEntry.valEnd)));
    const first = Number(latin1(bytes.subarray(fEntry.valStart, fEntry.valEnd)));
    const header = latin1(data.subarray(0, Math.min(first, data.length))).trim().split(/\s+/).map(Number);
    const spans = [];
    for (let i = 0; i < count; i++) {
      const onum = header[i * 2];
      const off = header[i * 2 + 1];
      if (!Number.isFinite(onum) || !Number.isFinite(off)) break;
      spans.push({ start: first + off });
    }
    spans.forEach((span, i) => {
      const end = i + 1 < spans.length ? spans[i + 1].start : data.length;
      if (span.start < end) stmSpans.set(`${num}:${i}`, data.subarray(span.start, end));
    });
    objects.set(num, { ...obj, num, type: 1 });
  }
  for (const [num, e] of xref.entries) {
    if (e.type === 0) continue;
    if (e.type === 1) {
      if (objects.has(num)) continue;
      const obj = parseObjectAt(bytes, e.offset, text);
      if (obj) objects.set(num, { ...obj, type: 1 });
    } else {
      const span = stmSpans.get(`${e.stmNum}:${e.index}`);
      if (span) {
        objects.set(num, { num, gen: 0, extracted: span, dict: parseDict(span, 0, span.length), type: 2 });
      }
    }
  }
  return objects;
}

async function loadObjects(bytes, text) {
  const xref = await readXref(bytes, text);
  if (xref) {
    try {
      const objects = await objectsFromXref(bytes, text, xref);
      // entradas del xref desfasadas (archivos reparados): se completan con el
      // escaneo del archivo, que solo rellena huecos, nunca sustituye objetos
      const scanned = scanObjects(bytes);
      let repaired = 0;
      for (const [num, obj] of scanned) {
        if (!objects.has(num)) {
          objects.set(num, obj);
          repaired++;
        }
      }
      if (objects.size > 1) {
        return { objects, trailer: xref.trailer, source: 'xref', repaired };
      }
    } catch (e) {
      /* se usa el escaneo como respaldo */
    }
  }
  const objects = scanObjects(bytes);
  return { objects, trailer: findTrailer(bytes, text, objects), source: 'scan', repaired: 0 };
}

/** Referencias de los objetos emitidos que no existen: nunca se debe emitir así. */
function danglingRefs(bytes, objects, nums, editedBodies) {
  const missing = new Set();
  for (const num of nums) {
    const obj = objects.get(num);
    if (!obj) continue;
    let refs = [];
    if (editedBodies.has(num)) {
      const body = editedBodies.get(num);
      refs = collectRefs(body, 0, body.length);
    } else if (obj.extracted) {
      refs = collectRefs(obj.extracted, 0, obj.extracted.length);
    } else {
      // también los objetos que son un valor suelto (arreglos) llevan referencias
      const end = obj.streamRange && obj.streamRange.dataStart
        ? obj.streamRange.dataStart : obj.bodyEnd;
      refs = collectRefs(bytes, obj.bodyStart, end);
    }
    for (const r of refs) if (!objects.has(r)) missing.add(r);
  }
  return missing;
}

function findTrailer(bytes, text, objects) {
  let trailer = null;
  for (const m of text.matchAll(/trailer/g)) {
    const dict = parseDict(bytes, skipWs(bytes, m.index + 7, bytes.length), bytes.length);
    if (dict) trailer = dict;
  }
  for (const obj of objects.values()) {
    const t = obj.dict && obj.dict.entries.find((e) => e.key === 'Type');
    if (t && latin1(bytes.subarray(t.valStart, t.valEnd)) === '/XRef') trailer = obj.dict;
  }
  return trailer;
}

const typeOf = (bytes, obj) => {
  const t = obj.dict && obj.dict.entries.find((e) => e.key === 'Type');
  return t ? latin1(bytes.subarray(t.valStart, t.valEnd)) : '';
};

/**
 * Objetos alcanzables desde /Root. Lo que no se alcanza es basura de
 * versiones anteriores (p. ej. el flujo de contenido que se "redactó" antes):
 * si se copiara, el texto borrado seguiría dentro del archivo.
 */
function reachableObjects(bytes, objects, rootNum, dropped, editedBodies) {
  const seen = new Set();
  const queue = [rootNum];
  while (queue.length) {
    const num = queue.pop();
    if (seen.has(num) || dropped.has(num) || !objects.has(num)) continue;
    seen.add(num);
    const obj = objects.get(num);
    let refs = [];
    if (editedBodies.has(num)) {
      const body = editedBodies.get(num);
      refs = collectRefs(body, 0, body.length);
    } else if (obj.extracted) {
      refs = collectRefs(obj.extracted, 0, obj.extracted.length);
    } else {
      // también los objetos que son un valor suelto (arreglos) llevan referencias
      const end = obj.streamRange && obj.streamRange.dataStart
        ? obj.streamRange.dataStart : obj.bodyEnd;
      refs = collectRefs(bytes, obj.bodyStart, end);
    }
    for (const r of refs) if (!seen.has(r)) queue.push(r);
  }
  return seen;
}

// ---------------------------------------------------------------- inspección

const INFO_KEYS = [
  ['Author', 'Autor', 'personal'],
  ['Creator', 'Programa que creó el contenido', 'media'],
  ['Producer', 'Programa que generó el PDF', 'media'],
  ['Title', 'Título', 'media'],
  ['Subject', 'Asunto', 'media'],
  ['Keywords', 'Palabras clave', 'media'],
  ['CreationDate', 'Fecha de creación', 'media'],
  ['ModDate', 'Fecha de modificación', 'media'],
  ['Company', 'Empresa', 'personal'],
  ['SourceModified', 'Origen modificado', 'media'],
  ['Trapped', 'Estado de atrapado', 'baja'],
];

function scanXmp(text, add) {
  const creator = /<dc:creator>[\s\S]{0,400}?<rdf:li[^>]*>([^<]{1,80})</.exec(text);
  if (creator) add('XMP incrustado', 'Autor declarado', creator[1].trim(), 'personal');
  const tool = /<xmp:CreatorTool>([^<]{1,80})</.exec(text);
  if (tool) add('XMP incrustado', 'Herramienta', tool[1].trim(), 'media');
  const producer = /<pdf:Producer>([^<]{1,80})</.exec(text);
  if (producer) add('XMP incrustado', 'Productor', producer[1].trim(), 'media');
  for (const [tag, label] of [['xmp:CreateDate', 'Fecha de creación'],
    ['xmp:ModifyDate', 'Fecha de modificación'], ['xmp:MetadataDate', 'Fecha de metadatos']]) {
    const m = new RegExp(`<${tag}>([^<]{1,40})<`).exec(text);
    if (m) add('XMP incrustado', label, m[1].trim(), 'media');
  }
  const city = /<photoshop:(?:City|Country|Location)>([^<]{1,60})</.exec(text);
  if (city) add('XMP incrustado', 'Lugar declarado', city[1].trim(), 'personal');
}

export async function inspectPdf(bytes) {
  const findings = [];
  const info = { format: 'pdf', size: bytes.length, incremental: 0, xmp: false, id: false };
  const add = (group, label, value, sev, keep = false) => {
    const v = (value ?? '').toString().trim();
    if (v) findings.push({ group, label, value: v, sev, keep });
  };
  add('Archivo', 'Tipo detectado', `PDF · ${(bytes.length / 1024).toFixed(0)} KB`, 'baja');

  const text = latin1(bytes);
  const loaded = await loadObjects(bytes, text);
  const { objects, trailer } = loaded;
  info.objects = objects.size;
  info.xrefSource = loaded.source;
  const eofCount = (text.match(/%%EOF/g) || []).length;
  info.incremental = Math.max(0, eofCount - 1);
  add('Estructura', 'Objetos en el archivo', String(objects.size), 'baja');
  if (loaded.source === 'scan') {
    add('Estructura', 'Tabla de referencias del PDF',
      'ilegible; estructura reconstruida por escaneo', 'media', true);
  }
  if (info.incremental) {
    add('Estructura', 'Versiones anteriores dentro del archivo',
      `${eofCount} actualizaciones incrementales en el mismo archivo`, 'personal', true);
  }

  const entry = (key) => (trailer ? trailer.entries.find((e) => e.key === key) : null);
  if (!trailer || entry('Encrypt')) {
    if (entry && entry('Encrypt')) {
      add('Archivo', 'PDF cifrado', 'no se puede limpiar sin la contraseña', 'media', true);
    }
    return { findings, info: { ...info, encrypted: !!entry }, format: 'pdf', supported: false };
  }

  const infoEntry = entry('Info');
  if (infoEntry) {
    const n = readIntAt(bytes, infoEntry.valStart, bytes.length);
    const target = n && readRefAt(bytes, infoEntry.valStart, bytes.length) ? objects.get(n.value) : null;
    const dict = target ? target.dict
      : parseDict(bytes, skipWs(bytes, infoEntry.valStart, bytes.length), bytes.length);
    if (dict) {
      add('Propiedades del documento', 'Diccionario /Info', 'presente', 'baja');
      for (const e of dict.entries) {
        const meta = INFO_KEYS.find((k) => k[0] === e.key);
        if (!meta) continue;
        const value = decodeString(bytes, e.valStart, e.valEnd);
        if (value) add('Propiedades del documento', meta[1], value.slice(0, 120), meta[2]);
      }
    }
  }
  if (entry('ID')) {
    info.id = true;
    add('Estructura', 'Identificador del archivo (/ID)',
      'huellas que identifican este archivo concreto', 'media');
  }

  for (const obj of objects.values()) {
    const type = typeOf(bytes, obj);
    if (type === '/Metadata') {
      info.xmp = true;
      const data = await inflateMaybe(bytes, obj);
      add('XMP incrustado', 'Paquete XMP', 'presente', 'personal');
      if (data) scanXmp(utf8.decode(data).slice(0, 8000), add);
    } else if (type === '/Sig') {
      add('Firmas', 'Firma digital', 'se invalidará al reescribir el archivo', 'media', true);
    } else if (type === '/Filespec') {
      add('Adjuntos', 'Archivo incrustado dentro del PDF', 'hay documentos dentro del archivo', 'personal', true);
    }
  }

  const pages = Array.from(objects.values()).filter((o) => typeOf(bytes, o) === '/Page').length;
  if (pages) add('Estructura', 'Páginas', String(pages), 'baja');
  const annots = (text.match(/\/Subtype\s*\/(?:Text|FreeText|Highlight|Square|Stamp|Ink|FileAttachment)/g) || []).length;
  if (annots) add('Anotaciones', 'Comentarios y anotaciones', String(annots), 'media', true);
  if (/\/AcroForm/.test(text)) {
    add('Formularios', 'Formulario con campos',
      'los valores escritos siguen dentro del archivo', 'media', true);
  }
  if (/\/JavaScript|\/OpenAction|\/AA\b/.test(text)) {
    add('JavaScript', 'Código que puede ejecutarse al abrir el PDF', 'presente', 'personal');
  }
  if (/\/EmbeddedFiles/.test(text)) {
    add('Adjuntos', 'Archivos incrustados (/EmbeddedFiles)', 'documentos dentro del PDF', 'personal', true);
  }

  return { findings, info, format: 'pdf', supported: true };
}

// ---------------------------------------------------------------- limpieza

const CATALOG_DROP = ['Metadata', 'Info', 'PieceInfo', 'OpenAction', 'AA', 'SpiderInfo'];

export async function stripPdf(bytes, opts) {
  if (!sniffPdf(bytes)) throw new Error('El archivo no es un PDF.');
  const notes = new Set();
  const stats = {
    objects: 0, dropped: 0, history: 0, xmp: 0, info: 0, id: 0,
    js: 0, attachments: 0,
  };
  const text = latin1(bytes);
  stats.history = Math.max(0, (text.match(/%%EOF/g) || []).length - 1);

  const { objects, trailer } = await loadObjects(bytes, text);
  const dropped = new Set();
  for (const obj of objects.values()) {
    if (obj.dict && (typeOf(bytes, obj) === '/XRef' || typeOf(bytes, obj) === '/ObjStm')) dropped.add(obj.num);
  }

  if (!trailer) throw new Error('No se encontró la raíz del PDF.');
  const entry = (key) => trailer.entries.find((e) => e.key === key);
  if (entry('Encrypt')) throw new Error('El PDF está cifrado: no se puede limpiar sin la contraseña.');
  const rootEntry = entry('Root');
  const rootNum = rootEntry ? readIntAt(bytes, rootEntry.valStart, bytes.length) : null;
  if (!rootNum) throw new Error('El PDF no declara /Root.');
  const root = objects.get(rootNum.value);
  if (!root || !root.dict) throw new Error('El catálogo del PDF está en un objeto comprimido no soportado.');

  const edits = new Map(); // num -> rangos absolutos a borrar
  const addEdit = (num, range) => {
    if (!edits.has(num)) edits.set(num, []);
    edits.get(num).push(range);
  };

  if (entry('Info')) stats.info++;
  if (entry('ID')) {
    stats.id++;
    notes.add('Identificador del archivo (/ID) eliminado');
  }

  const catalogDrop = [...CATALOG_DROP];
  if (opts.attachments) catalogDrop.push('Names');
  for (const key of catalogDrop) {
    const e = root.dict.entries.find((x) => x.key === key);
    if (!e) continue;
    // solo se elimina la clave: los objetos que referencie quedan fuera por
    // alcanzabilidad. Borrarlos aquí destrozaría destinos compartidos, como un
    // /OpenAction que apunta a una página concreta.
    addEdit(root.num, { start: e.keyStart, end: e.valEnd });
    if (key === 'Metadata') {
      stats.xmp++;
      notes.add('Paquete XMP eliminado (autor, fechas, herramienta)');
    } else if (key === 'Info') {
      stats.info++;
      notes.add('Diccionario /Info del catálogo eliminado');
    } else if (key === 'OpenAction' || key === 'AA') {
      stats.js++;
      notes.add('Acciones automáticas al abrir el PDF eliminadas');
    } else if (key === 'PieceInfo') {
      notes.add('Datos privados de la aplicación que guardó el PDF (PieceInfo)');
    } else if (key === 'Names' && opts.attachments) {
      stats.attachments++;
      notes.add('Archivos incrustados en el PDF eliminados');
    }
  }
  const namesEntry = root.dict.entries.find((e) => e.key === 'Names');
  if (namesEntry && !opts.attachments) {
    const namesDict = parseDict(bytes, skipWs(bytes, namesEntry.valStart, bytes.length), bytes.length);
    const jsEntry = namesDict && namesDict.entries.find((e) => e.key === 'JavaScript');
    if (jsEntry) {
      addEdit(root.num, { start: jsEntry.keyStart, end: jsEntry.valEnd });
      stats.js++;
      notes.add('JavaScript incrustado eliminado');
    }
  }

  // objeto raíz editado: de él se calculan las referencias que sí cuentan
  const editedBodies = new Map();
  if (edits.has(root.num)) {
    const original = bytes.subarray(root.bodyStart, root.bodyEnd);
    editedBodies.set(root.num, deleteRanges(original, root.bodyStart, edits.get(root.num)));
  }
  const reachable = reachableObjects(bytes, objects, rootNum.value, dropped, editedBodies);
  const emitted = Array.from(reachable).filter((n) => !dropped.has(n));
  if (emitted.length < 2) {
    throw new Error('No se pudo reconstruir la estructura del PDF; se cancela para no dañarlo.');
  }
  const missing = danglingRefs(bytes, objects, emitted, editedBodies);
  if (missing.size) {
    const list = Array.from(missing).slice(0, 6).join(', ');
    throw new Error(`El archivo tiene ${missing.size} referencia(s) rota(s) `
      + `(objetos ${list}${missing.size > 6 ? '…' : ''}): se cancela para no entregar un PDF dañado.`);
  }

  // ---- emisión
  const headerEnd = text.indexOf('\n');
  const header = bytes.subarray(0, headerEnd > 0 ? headerEnd + 1 : 15);
  const pieces = [header, new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let offset = pieces.reduce((s, p) => s + p.length, 0);
  const offsets = new Map();
  const nums = Array.from(reachable).filter((n) => !dropped.has(n)).sort((a, b) => a - b);

  for (const num of nums) {
    const obj = objects.get(num);
    const head = enc.encode(`${num} ${obj.gen || 0} obj\n`);
    offsets.set(num, offset);
    let tail = new Uint8Array(0);
    if (obj.extracted) {
      const body = obj.extracted;
      pieces.push(head, body, enc.encode('\nendobj\n'));
      offset += head.length + body.length + 8;
    } else if (obj.streamRange && obj.streamRange.endstreamAt >= 0) {
      const data = streamData(bytes, obj);
      let dictBytes = bytes.subarray(obj.bodyStart, obj.streamRange.dataStart);
      const ranges = edits.get(num);
      if (ranges) dictBytes = deleteRanges(dictBytes, obj.bodyStart, ranges);
      const end = enc.encode('\nendstream\nendobj\n');
      pieces.push(head, dictBytes, data, end);
      offset += head.length + dictBytes.length + data.length + end.length;
    } else {
      let body = editedBodies.get(num) || bytes.subarray(obj.bodyStart, obj.bodyEnd);
      const ranges = editedBodies.has(num) ? null : edits.get(num);
      if (ranges) body = deleteRanges(body, obj.bodyStart, ranges);
      pieces.push(head, body, enc.encode('\nendobj\n'));
      offset += head.length + body.length + 8;
    }
    stats.objects++;
  }
  stats.dropped = objects.size - nums.length;

  const xrefStart = offset;
  const maxNum = nums.length ? Math.max(...nums) : 0;
  const xref = [`xref\n0 ${maxNum + 1}\n`, '0000000000 65535 f\r\n'];
  for (let n = 1; n <= maxNum; n++) {
    xref.push(offsets.has(n)
      ? `${String(offsets.get(n)).padStart(10, '0')} ${String(objects.get(n).gen || 0).padStart(5, '0')} n\r\n`
      : '0000000000 65535 f\r\n');
  }
  const tail = enc.encode(`${xref.join('')}trailer\n<< /Size ${maxNum + 1}`
    + ` /Root ${rootNum.value} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);
  pieces.push(tail);

  const out = concat(pieces);

  if (stats.history) {
    notes.add(`${stats.history} actualización(es) incremental(es) descartadas: el texto y los `
      + 'objetos de las versiones anteriores ya no están en el archivo');
  }
  notes.add('/Info fuera: autor, título, asunto, palabras clave, programas y fechas');
  notes.add(`${stats.dropped} objeto(s) descartados: metadatos, estructura y restos de `
    + 'versiones anteriores del documento');
  notes.add('Los flujos de contenido se copian sin recomprimir: la imagen no cambia');

  return { bytes: out, removed: Array.from(notes), stats, format: 'pdf' };
}
