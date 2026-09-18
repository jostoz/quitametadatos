// Inspección y limpieza de metadatos en paquetes OOXML:
// Word (.docx/.docm), Excel (.xlsx/.xlsm) y PowerPoint (.pptx/.pptm).
// Todo el trabajo ocurre en memoria, en el navegador.

import { readZip, writeZip, formatDosDateTime } from './zip.js';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  threaded: 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments',
};
const W = NS.w;

const CORE_EMPTY =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
  + '<cp:coreProperties xmlns:cp="' + NS.cp + '" xmlns:dc="' + NS.dc + '"'
  + ' xmlns:dcterms="' + NS.dcterms + '"'
  + ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"'
  + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';

const APP_MIN =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
  + '<Properties xmlns="' + NS.ep + '"'
  + ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
  + '<Application>Microsoft Office Word</Application></Properties>';

export const FORMATS = {
  word: {
    label: 'Word',
    ext: ['docx', 'docm', 'dotx', 'dotm'],
    changes: true,
    deleteComments: true,
    persons: /^word\/people\.xml$/,
    comments: /^word\/comments(Extended|Ids|Extensible)?\.xml$/,
  },
  excel: {
    label: 'Excel',
    ext: ['xlsx', 'xlsm', 'xltx', 'xltm'],
    changes: false,
    deleteComments: false,
    persons: /^xl\/persons\/person\.xml$/,
    comments: /^xl\/(?:comments\d*\.xml|comments\/comment\d*\.xml|threadedComments\/threadedComment\d*\.xml)$/,
  },
  powerpoint: {
    label: 'PowerPoint',
    ext: ['pptx', 'pptm', 'potx', 'potm'],
    changes: false,
    deleteComments: false,
    persons: /^ppt\/persons\/person\.xml$/,
    comments: /^ppt\/(commentAuthors|comments\/comment\d*)\.xml$/,
  },
};

const REVISION_TAGS = [
  'ins', 'del', 'moveFrom', 'moveTo', 'cellIns', 'cellDel', 'cellMerge',
  'pPrChange', 'rPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange',
  'sectPrChange', 'numberingChange', 'tblGridChange',
  'customXmlInsRangeStart', 'customXmlInsRangeEnd',
  'customXmlDelRangeStart', 'customXmlDelRangeEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
];
const FORMAT_CHANGES = [
  ['pPrChange', 'pPr'], ['rPrChange', 'rPr'], ['tblPrChange', 'tblPr'],
  ['trPrChange', 'trPr'], ['tcPrChange', 'tcPr'], ['sectPrChange', 'sectPr'],
];
const WORD_REVISION_PART =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;
const MACROS = /(?:^|\/)(vbaProject(?:Signature)?\.bin|vbaData\.xml)$/;

// ---------------------------------------------------------------- utilidades

export function decode(bytes) {
  return new TextDecoder().decode(bytes);
}
export function encode(text) {
  return new TextEncoder().encode(text);
}

export function parseXml(bytes) {
  const doc = new DOMParser().parseFromString(decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('El archivo contiene XML inválido.');
  }
  return doc;
}

export function serializeXml(doc) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    + new XMLSerializer().serializeToString(doc.documentElement);
}

const elems = (root, ns, local) =>
  Array.from(root.getElementsByTagNameNS(ns, local));
const val = (root, ns, local) => {
  if (!root) return '';
  const el = root.getElementsByTagNameNS(ns, local)[0];
  return el ? (el.textContent || '').trim() : '';
};
const remove = (el) => el.parentNode && el.parentNode.removeChild(el);

function allElements(root) {
  return [root, ...Array.from(root.getElementsByTagName('*'))];
}

function renameElement(el, newLocal) {
  const name = el.prefix ? el.prefix + ':' + newLocal : newLocal;
  const next = el.ownerDocument.createElementNS(el.namespaceURI, name);
  for (const a of Array.from(el.attributes)) next.setAttributeNode(a.cloneNode());
  while (el.firstChild) next.appendChild(el.firstChild);
  return next;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  for (const child of Array.from(el.childNodes)) parent.insertBefore(child, el);
  parent.removeChild(el);
}

function relsBase(name) {
  return name.slice(0, name.lastIndexOf('_rels/'));
}

function resolvePath(base, target) {
  const out = [];
  for (const part of (base + target).split('/')) {
    if (part === '..') out.pop();
    else if (part !== '' && part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Detecta el formato por la estructura del paquete, no por la extensión. */
export function detectFormat(byName) {
  for (const name of byName.keys()) {
    if (name.startsWith('word/')) return 'word';
    if (name.startsWith('xl/')) return 'excel';
    if (name.startsWith('ppt/')) return 'powerpoint';
  }
  throw new Error('El archivo no parece un documento de Office (.docx/.xlsx/.pptx).');
}

// ---------------------------------------------------------------- inspección

const CORE_FIELDS = [
  [NS.dc, 'title', 'Título', 'media'],
  [NS.dc, 'subject', 'Asunto', 'media'],
  [NS.dc, 'creator', 'Autor', 'personal'],
  [NS.cp, 'keywords', 'Palabras clave', 'media'],
  [NS.dc, 'description', 'Comentarios', 'media'],
  [NS.cp, 'lastModifiedBy', 'Última persona que guardó', 'personal'],
  [NS.cp, 'revision', 'Número de revisión', 'media'],
  [NS.dcterms, 'created', 'Creado', 'media'],
  [NS.dcterms, 'modified', 'Modificado', 'media'],
  [NS.cp, 'category', 'Categoría', 'media'],
  [NS.cp, 'contentStatus', 'Estado del contenido', 'baja'],
  [NS.cp, 'lastPrinted', 'Última impresión', 'media'],
  [NS.cp, 'version', 'Versión', 'baja'],
];
const APP_FIELDS = [
  ['Template', 'Plantilla', 'media'],
  ['TotalTime', 'Tiempo de edición', 'media'],
  ['Company', 'Empresa', 'personal'],
  ['Manager', 'Responsable', 'personal'],
  ['HyperlinkBase', 'Ruta base de hipervínculos', 'personal'],
  ['Application', 'Aplicación', 'baja'],
  ['AppVersion', 'Versión de la aplicación', 'baja'],
  ['Pages', 'Páginas', 'baja'],
  ['Words', 'Palabras', 'baja'],
  ['Characters', 'Caracteres', 'baja'],
  ['Paragraphs', 'Párrafos', 'baja'],
  ['LastPrinted', 'Última impresión', 'media'],
];

function inspectPersons(byName, format, add) {
  const re = FORMATS[format].persons;
  let found = false;
  for (const [name, entry] of byName) {
    if (!re.test(name)) continue;
    found = true;
    const root = parseXml(entry.data).documentElement;
    for (const el of allElements(root)) {
      const author = el.getAttributeNS(NS.w15, 'author');
      if (author || el.localName === 'person') {
        const label = author || el.getAttribute('displayName') || '(sin nombre)';
        const userId = el.getAttributeNS(NS.w15, 'userId')
          || el.getAttribute('userId') || '';
        const provider = el.getAttributeNS(NS.w15, 'providerId')
          || el.getAttribute('providerId') || '';
        add('Personas con cuenta vinculada', label,
          [provider, userId].filter(Boolean).join(' ') || '(sin identificador)', 'personal');
      } else if (el.getAttribute('userId') || el.getAttribute('providerId')) {
        add('Personas con cuenta vinculada', el.getAttribute('displayName') || '(sin nombre)',
          [el.getAttribute('providerId'), el.getAttribute('userId')].filter(Boolean).join(' '),
          'personal');
      }
    }
  }
  return found;
}

function inspectComments(byName, format, add) {
  const re = FORMATS[format].comments;
  let count = 0;
  const authors = new Set();
  for (const [name, entry] of byName) {
    if (!re.test(name)) continue;
    const root = parseXml(entry.data).documentElement;
    if (format === 'word') {
      for (const c of elems(root, W, 'comment')) {
        count++;
        const a = c.getAttributeNS(W, 'author');
        if (a) authors.add(a);
      }
    } else if (format === 'excel') {
      for (const a of elems(root, 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'author')) {
        if ((a.textContent || '').trim()) authors.add(a.textContent.trim());
      }
      for (const c of elems(root, NS.threaded, 'threadedComment')) count++;
    } else {
      for (const a of elems(root, NS.p, 'cmAuthor')) {
        const name_ = a.getAttribute('name');
        if (name_) authors.add(name_);
      }
    }
  }
  if (count) add('Comentarios', 'Comentarios en el documento', String(count), 'media');
  if (authors.size) {
    add('Comentarios', 'Autores de los comentarios', Array.from(authors).join(', '), 'personal');
  }
  return { count, authors: authors.size };
}

function inspectExcel(byName, add) {
  const names = Array.from(byName.keys());
  const SECRET_KEYS = new Set(['connection', 'command', 'password', 'user', 'uid', 'pwd']);
  let connections = 0;
  const strings = [];
  for (const n of names) {
    if (!/^xl\/connections\.xml$/.test(n)) continue;
    connections++;
    const root = parseXml(byName.get(n).data).documentElement;
    for (const el of allElements(root)) {
      for (const a of Array.from(el.attributes)) {
        if (SECRET_KEYS.has(a.localName.toLowerCase()) && a.value.length > 1) {
          strings.push(a.value.slice(0, 140));
        }
      }
    }
  }
  if (connections) {
    add('Excel · datos externos', 'Conexiones a bases de datos',
      `${connections} (cadena de conexión)`, 'personal');
    for (const s of strings.slice(0, 4)) {
      add('Excel · datos externos', 'Cadena de conexión', s, 'personal');
    }
  }
  const links = names.filter((n) => /^xl\/externalLinks\/_rels\//.test(n));
  for (const n of links) {
    const root = parseXml(byName.get(n).data).documentElement;
    for (const rel of allElements(root)) {
      const t = rel.getAttribute('Target') || '';
      if (/^https?:|^[A-Za-z]:|^\\\\|^\//.test(t)) {
        add('Excel · datos externos', 'Enlace a otro libro', t, 'personal', true);
      }
    }
  }
  const printers = names.filter((n) => /^xl\/printerSettings\//.test(n)).length;
  if (printers) {
    add('Excel · datos externos', 'Configuración de impresora guardada',
      `${printers} parte(s)`, 'media');
  }
  const revisions = names.filter((n) => /^xl\/revisions\//.test(n)).length;
  if (revisions) {
    add('Excel · datos externos', 'Registro de revisiones (libro compartido)',
      `${revisions} parte(s) con usuarios y valores anteriores`, 'personal', true);
  }
  if (byName.has('xl/workbook.xml')) {
    const root = parseXml(byName.get('xl/workbook.xml').data).documentElement;
    const sheets = elems(root, 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'sheet');
    const hidden = sheets.filter((s) => s.getAttribute('state') === 'hidden').length;
    const veryHidden = sheets.filter((s) => s.getAttribute('state') === 'veryHidden').length;
    if (hidden || veryHidden) {
      add('Excel · hojas ocultas', 'Hojas ocultas',
        `${hidden} oculta(s), ${veryHidden} muy oculta(s)`, 'media', true);
    }
    const defined = elems(root, 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'definedName')
      .filter((d) => (d.textContent || '').includes('['));
    if (defined.length) {
      add('Excel · datos externos', 'Nombres definidos apuntando a otros archivos',
        defined.map((d) => d.getAttribute('name')).join(', '), 'media', true);
    }
  }
  for (const n of names) {
    if (!/^xl\/pivotCache\/pivotCacheDefinition\d*\.xml$/.test(n)) continue;
    const root = parseXml(byName.get(n).data).documentElement;
    const src = allElements(root).find((el) => el.localName === 'cacheSource');
    if (src && src.getAttribute('type') === 'external') {
      const ref = allElements(root).find((el) => el.localName === 'worksheetSource');
      add('Excel · datos externos', 'Tabla dinámica con origen externo',
        ref ? (ref.getAttribute('name') || ref.getAttribute('ref') || '') : '', 'media', true);
    }
  }
}

function inspectPowerpoint(byName, add) {
  const notes = Array.from(byName.keys())
    .filter((n) => /^ppt\/notesSlides\/notesSlide\d*\.xml$/.test(n)).length;
  if (notes) {
    add('PowerPoint · notas', 'Diapositivas con notas del orador', String(notes), 'media', true);
  }
}

function inspectWordRevisions(byName, add, info) {
  const tracked = new Map();
  const authors = new Set();
  const dates = [];
  for (const [name, entry] of byName) {
    if (!WORD_REVISION_PART.test(name)) continue;
    const root = parseXml(entry.data).documentElement;
    for (const local of REVISION_TAGS) {
      const list = elems(root, W, local);
      if (list.length) tracked.set(local, (tracked.get(local) || 0) + list.length);
    }
    for (const el of allElements(root)) {
      for (const a of Array.from(el.attributes || [])) {
        if (a.namespaceURI !== W) continue;
        if (a.localName === 'author' && a.value) authors.add(a.value);
        if (a.localName === 'date' && a.value) dates.push(a.value);
      }
    }
  }
  const LABELS = {
    ins: 'Inserciones', del: 'Borrados', moveFrom: 'Movimientos (origen)',
    moveTo: 'Movimientos (destino)', pPrChange: 'Cambios de formato de párrafo',
    rPrChange: 'Cambios de formato de texto', tblPrChange: 'Cambios de formato de tabla',
    trPrChange: 'Cambios de formato de fila', tcPrChange: 'Cambios de formato de celda',
    cellIns: 'Celdas insertadas', cellDel: 'Celdas borradas',
  };
  for (const [tag, count] of tracked) {
    add('Control de cambios', LABELS[tag] || tag, String(count), 'edicion');
    info.trackedChanges += count;
  }
  if (authors.size) {
    add('Control de cambios', 'Autores registrados', Array.from(authors).join(', '), 'personal');
    info.distinctAuthors = authors.size;
  }
  if (dates.length) {
    const sorted = dates.slice().sort();
    add('Control de cambios', 'Fechas registradas',
      `${dates.length} marcas entre ${sorted[0]} y ${sorted[sorted.length - 1]}`, 'edicion');
  }
}

export function inspect(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const format = detectFormat(byName);
  const profile = FORMATS[format];
  const findings = [];
  const info = {
    format,
    formatLabel: profile.label,
    parts: entries.length,
    changes: profile.changes,
    deleteComments: profile.deleteComments,
    hasComments: false,
    hasCustomProps: byName.has('docProps/custom.xml'),
    hasMacros: Array.from(byName.keys()).some((n) => MACROS.test(n)),
    hasPeople: false,
    hasThumbnail: Array.from(byName.keys()).some((n) => /^docProps\/thumbnail\./.test(n)),
    trackedChanges: 0,
    distinctAuthors: 0,
    technical: 0,
    connections: byName.has('xl/connections.xml'),
  };
  const add = (group, label, value, sev, keep = false) => {
    const v = (value ?? '').toString().trim();
    if (v) findings.push({ group, label, value: v, sev, keep });
  };

  add('Archivo', 'Tipo detectado', `${profile.label} · ${entries.length} partes`, 'baja');

  const core = byName.has('docProps/core.xml')
    ? parseXml(byName.get('docProps/core.xml').data).documentElement : null;
  for (const [ns, local, label, sev] of CORE_FIELDS) {
    add('Propiedades del documento', label, val(core, ns, local), sev);
  }
  const app = byName.has('docProps/app.xml')
    ? parseXml(byName.get('docProps/app.xml').data).documentElement : null;
  for (const [local, label, sev] of APP_FIELDS) {
    let v = val(app, NS.ep, local);
    if (local === 'TotalTime' && v) v = v + ' minutos';
    add('Propiedades de la aplicación', label, v, sev);
  }
  if (info.hasCustomProps) {
    const root = parseXml(byName.get('docProps/custom.xml').data).documentElement;
    for (const p of elems(root, NS.custom, 'property')) {
      const child = Array.from(p.children)[0];
      add('Propiedades personalizadas', p.getAttribute('name') || '(sin nombre)',
        child ? child.textContent : '', 'personal');
    }
  }
  info.hasPeople = inspectPersons(byName, format, add);
  const commentInfo = inspectComments(byName, format, add);
  info.hasComments = commentInfo.count > 0 || commentInfo.authors > 0;

  if (format === 'excel') inspectExcel(byName, add);
  if (format === 'powerpoint') inspectPowerpoint(byName, add);
  if (format === 'word') inspectWordRevisions(byName, add, info);

  if (Array.from(byName.keys()).some((n) => /^docProps\/thumbnail\./.test(n))) {
    add('Miniatura y adjuntos', 'Miniatura incrustada (vista previa guardada)',
      'puede mostrar una versión anterior del contenido', 'media');
  }
  if (info.hasMacros) {
    add('Contenido incrustado', 'Macros (vbaProject.bin)', 'presentes', 'personal');
  }
  for (const name of byName.keys()) {
    if (name.includes('_xmlsignatures/')) {
      add('Contenido incrustado', 'Firma digital (se conserva: retirarla invalida el archivo)', name, 'media', true);
    }
  }

  let rsid = 0;
  let paraId = 0;
  let docId = 0;
  for (const [name, entry] of byName) {
    if (!name.endsWith('.xml')) continue;
    const root = parseXml(entry.data).documentElement;
    for (const el of allElements(root)) {
      for (const a of Array.from(el.attributes || [])) {
        const ln = a.localName || '';
        if (/^rsid/i.test(ln)) rsid++;
        else if (ln === 'paraId' || ln === 'paraIdParent' || ln === 'textId') paraId++;
        else if (ln === 'docId') docId++;
      }
      if ((el.namespaceURI === NS.w14 || el.namespaceURI === NS.w15) && el.localName === 'docId') docId++;
    }
  }
  info.technical = rsid + paraId + docId;
  if (rsid) add('Rastros técnicos de edición', 'Identificadores rsid (sesiones de edición)', String(rsid), 'baja');
  if (paraId) add('Rastros técnicos de edición', 'Identificadores de párrafo/texto', String(paraId), 'baja');
  if (docId) add('Rastros técnicos de edición', 'Identificador persistente del documento (docId)', String(docId), 'media');

  const stamps = Array.from(
    new Set(entries.map((e) => formatDosDateTime(e.time, e.date)))).sort();
  if (stamps.length) {
    const shown = stamps.slice(0, 3).join(' · ');
    add('Paquete ZIP', 'Fechas internas de cada archivo',
      stamps.length > 3 ? `${shown} (+${stamps.length - 3} más)` : shown, 'baja');
  }

  return { findings, info, format };
}

// ---------------------------------------------------------------- limpieza

function stripRevisionAuthors(root, stats) {
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes || [])) {
      if (a.namespaceURI !== W) continue;
      if (a.localName === 'author') {
        el.setAttributeNS(a.namespaceURI, a.name, '');
        stats.authors++;
      } else if (a.localName === 'date') {
        el.removeAttributeNS(a.namespaceURI, a.localName);
        stats.dates++;
      }
    }
  }
}

function acceptChanges(root, stats) {
  for (const el of elems(root, W, 'del')) {
    remove(el);
    stats.del++;
  }
  for (const el of elems(root, W, 'ins')) {
    unwrap(el);
    stats.ins++;
  }
  for (const el of elems(root, W, 'moveFrom')) {
    remove(el);
    stats.del++;
  }
  for (const el of elems(root, W, 'moveTo')) {
    unwrap(el);
    stats.ins++;
  }
  for (const el of elems(root, W, 'cellIns')) unwrap(el);
  for (const local of ['cellDel', 'numberingChange', 'tblGridChange',
    'customXmlInsRangeStart', 'customXmlInsRangeEnd',
    'customXmlDelRangeStart', 'customXmlDelRangeEnd',
    'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']) {
    for (const el of elems(root, W, local)) remove(el);
  }
  removeFormatChanges(root, stats);
}

function removeFormatChanges(root, stats) {
  for (const [change] of FORMAT_CHANGES) {
    for (const el of elems(root, W, change)) {
      remove(el);
      stats.format++;
    }
  }
}

function rejectChanges(root, stats) {
  for (const el of elems(root, W, 'ins')) {
    remove(el);
    stats.ins++;
  }
  for (const local of ['moveTo', 'cellIns']) {
    for (const el of elems(root, W, local)) {
      remove(el);
      stats.ins++;
    }
  }
  for (const [change, pr] of FORMAT_CHANGES) {
    for (const el of elems(root, W, change)) {
      const parent = el.parentNode;
      const inner = Array.from(el.children).find(
        (c) => c.localName === pr && c.namespaceURI === W);
      if (parent && inner) {
        while (parent.firstChild) parent.removeChild(parent.firstChild);
        for (const c of Array.from(inner.childNodes)) parent.appendChild(c);
      } else if (parent) {
        parent.removeChild(el);
      }
      stats.format++;
    }
  }
  removeFormatChanges(root, stats);
  for (const local of ['del', 'moveFrom', 'cellDel']) {
    for (const el of elems(root, W, local)) {
      for (const delText of Array.from(el.getElementsByTagNameNS(W, 'delText'))) {
        delText.parentNode.replaceChild(renameElement(delText, 't'), delText);
      }
      unwrap(el);
      stats.del++;
    }
  }
  for (const local of ['numberingChange', 'tblGridChange',
    'customXmlInsRangeStart', 'customXmlInsRangeEnd',
    'customXmlDelRangeStart', 'customXmlDelRangeEnd',
    'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd']) {
    for (const el of elems(root, W, local)) remove(el);
  }
}

/** Vacía nombres e identificadores de cuenta conservando los GUID de referencia. */
function anonymizePersons(root, stats) {
  const ACCOUNT = /^(displayName|userId|providerId|initials|author|sip|email|alias)$/i;
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes || [])) {
      if (ACCOUNT.test(a.localName) && a.value) {
        el.setAttributeNS(a.namespaceURI, a.name, '');
        stats.accounts++;
      }
    }
  }
}

function anonymizeComments(root, format, stats) {
  if (format === 'word') {
    for (const comment of elems(root, W, 'comment')) {
      for (const a of Array.from(comment.attributes || [])) {
        if (a.namespaceURI !== W) continue;
        if (a.localName === 'author' || a.localName === 'initials') {
          comment.setAttributeNS(a.namespaceURI, a.name, '');
        } else if (a.localName === 'date') {
          comment.removeAttributeNS(a.namespaceURI, a.localName);
        }
      }
      stats.comments++;
    }
    return;
  }
  if (format === 'powerpoint') {
    for (const author of elems(root, NS.p, 'cmAuthor')) {
      for (const name of ['name', 'initials']) {
        if (author.getAttribute(name)) {
          author.setAttribute(name, '');
          stats.comments++;
        }
      }
    }
    for (const comment of elems(root, NS.p, 'cm')) {
      for (const a of Array.from(comment.attributes || [])) {
        if (a.localName === 'dt') comment.removeAttributeNS(a.namespaceURI, a.localName);
      }
    }
    return;
  }
  const SS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  for (const author of elems(root, SS, 'author')) {
    if ((author.textContent || '').trim()) {
      author.textContent = '';
      stats.comments++;
    }
  }
  for (const c of elems(root, NS.threaded, 'threadedComment')) {
    for (const a of Array.from(c.attributes || [])) {
      if (a.localName === 'dT') c.removeAttributeNS(a.namespaceURI, a.localName);
    }
    stats.comments++;
  }
}

function removeCommentReferences(root, format) {
  if (format !== 'word') return;
  for (const local of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
    for (const el of elems(root, W, local)) {
      const parent = el.parentNode;
      remove(el);
      if (parent && parent.localName === 'r' && !parent.children.length) remove(parent);
    }
  }
}

function stripTechnical(root, stats) {
  for (const el of allElements(root)) {
    for (const a of Array.from(el.attributes || [])) {
      const ln = a.localName || '';
      if (/^rsid/i.test(ln)) {
        el.removeAttributeNS(a.namespaceURI, a.localName);
        stats.rsid++;
      } else if (ln === 'paraId' || ln === 'paraIdParent' || ln === 'textId') {
        el.removeAttributeNS(a.namespaceURI, a.localName);
        stats.paraId++;
      } else if (ln === 'docId') {
        el.removeAttributeNS(a.namespaceURI, a.localName);
        stats.docId++;
      }
    }
    if ((el.namespaceURI === NS.w14 || el.namespaceURI === NS.w15) && el.localName === 'docId') {
      remove(el);
      stats.docId++;
    }
  }
  for (const local of ['rsid', 'rsidRoot', 'rsids']) {
    for (const el of elems(root, W, local)) {
      stats.rsid += local === 'rsids' ? Array.from(el.children).length + 1 : 1;
      remove(el);
    }
  }
}

function stripSettings(root, notes) {
  for (const local of ['trackRevisions', 'saveThroughXslt', 'attachedTemplate', 'rsids', 'rsidRoot']) {
    for (const el of elems(root, W, local)) {
      remove(el);
      if (local === 'trackRevisions') notes.add('Control de cambios desactivado para futuras ediciones');
      if (local === 'saveThroughXslt' || local === 'attachedTemplate') {
        notes.add('Rutas de plantilla o transformación externa');
      }
    }
  }
}

function stripContentTypes(root, drop) {
  for (const el of elems(root, NS.ct, 'Override')) {
    const pn = (el.getAttribute('PartName') || '').replace(/^\//, '');
    if (drop.has(pn)) remove(el);
  }
}

function stripRels(name, root, drop) {
  const base = relsBase(name);
  for (const el of elems(root, NS.rel, 'Relationship')) {
    const target = el.getAttribute('Target') || '';
    const resolved = /^(https?:|\/)/.test(target) ? null : resolvePath(base, target);
    if (resolved && drop.has(resolved)) remove(el);
  }
}

function processPart(name, bytes, opts, ctx) {
  const { format, drop, stats, notes } = ctx;
  if (name === 'docProps/core.xml') return encode(CORE_EMPTY);
  if (name === 'docProps/app.xml') return encode(APP_MIN);
  if (!name.endsWith('.xml') && !name.endsWith('.rels')) return bytes;

  const doc = parseXml(bytes);
  const root = doc.documentElement;

  if (FORMATS[format].persons.test(name)) anonymizePersons(root, stats);

  if (FORMATS[format].comments.test(name)) {
    if (opts.comments === 'anonymize') anonymizeComments(root, format, stats);
  }
  if (format === 'word' && WORD_REVISION_PART.test(name)) {
    if (opts.changes === 'accept') acceptChanges(root, stats);
    else if (opts.changes === 'reject') rejectChanges(root, stats);
    stripRevisionAuthors(root, stats);
    if (opts.comments === 'delete') removeCommentReferences(root, format);
  }
  if (name === 'word/settings.xml') stripSettings(root, notes);
  if (name === '[Content_Types].xml') stripContentTypes(root, drop);
  if (name.endsWith('.rels')) stripRels(name, root, drop);

  stripTechnical(root, stats);
  return encode(serializeXml(doc));
}

export async function strip(entries, opts) {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const format = detectFormat(byName);
  const profile = FORMATS[format];
  const drop = new Set();
  const notes = new Set();

  for (const name of byName.keys()) {
    if (/^docProps\/thumbnail\./.test(name)) {
      drop.add(name);
      notes.add('Miniatura incrustada (vista previa guardada del archivo)');
    }
    if (MACROS.test(name) && opts.macros) {
      drop.add(name);
      notes.add('Macros incrustadas (vbaProject.bin)');
    }
    if (/^xl\/printerSettings\//.test(name)) {
      drop.add(name);
      notes.add('Configuración de impresora guardada en el libro');
    }
  }
  if (opts.customProps && byName.has('docProps/custom.xml')) {
    drop.add('docProps/custom.xml');
    notes.add('Propiedades personalizadas (docProps/custom.xml)');
  }
  if (opts.connections && byName.has('xl/connections.xml')) {
    drop.add('xl/connections.xml');
    notes.add('Conexiones a bases de datos (pueden incluir usuario y contraseña)');
  }
  if (opts.comments === 'delete' && profile.deleteComments) {
    for (const name of byName.keys()) {
      if (/^word\/comments(Extended|Ids|Extensible)?\.xml$/.test(name)) drop.add(name);
    }
  }

  const stats = {
    rsid: 0, paraId: 0, docId: 0, authors: 0, dates: 0,
    ins: 0, del: 0, format: 0, comments: 0, accounts: 0,
  };
  const ctx = { format, drop, stats, notes };

  const out = [];
  for (const e of entries) {
    if (drop.has(e.name)) continue;
    out.push({ ...e, data: processPart(e.name, e.data, opts, ctx) });
  }
  const bytes = await writeZip(out);

  if (profile.changes) {
    if (opts.changes === 'accept') {
      notes.add(`Control de cambios aceptado: ${stats.ins} inserción(es) conservadas, `
        + `${stats.del} borrado(s) eliminados`);
    } else if (opts.changes === 'reject') {
      notes.add(`Control de cambios revertido: ${stats.ins} inserción(es) descartadas, `
        + `${stats.del} borrado(s) restaurados`);
    } else {
      notes.add('Marcas de control de cambios conservadas, sin autor ni fecha');
    }
    if (stats.format) notes.add(`${stats.format} cambio(s) de formato resueltos`);
  }
  if (stats.accounts) notes.add(`${stats.accounts} nombres o cuentas de la lista de personas`);
  if (stats.authors) notes.add(`${stats.authors} campos de autor anonimizados `
    + `y ${stats.dates} fechas borradas`);
  if (stats.comments && opts.comments === 'anonymize') {
    notes.add(`${stats.comments} autor(es) de comentarios sin nombre ni fecha`);
  }
  if (opts.comments === 'delete' && profile.deleteComments && byName.has('word/comments.xml')) {
    notes.add('Comentarios eliminados del documento');
  }
  if (stats.rsid) notes.add(`${stats.rsid} identificadores de sesión de edición (rsid)`);
  if (stats.paraId) notes.add(`${stats.paraId} identificadores de párrafo o texto`);
  if (stats.docId) notes.add(`${stats.docId} identificadores persistentes del documento`);
  notes.add('Título, autor, última persona que guardó, empresa, plantilla, '
    + 'revisión y fechas del archivo');
  notes.add('Fechas internas del paquete ZIP normalizadas');

  return { bytes, removed: Array.from(notes).filter(Boolean), stats, format };
}

export { readZip, writeZip, CORE_EMPTY, APP_MIN };
