import { readZip, writeZip } from './zip.js';
import { inspect, strip } from './ooxml.js';
import { sniff, inspectImage, stripImage } from './images.js';
import { sniffPdf, inspectPdf, stripPdf } from './pdf.js';

const $ = (id) => document.getElementById(id);
const state = { items: [], results: [], rejected: [] };
const OFFICE = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm)$/i;
const IMAGE = /\.(jpe?g|png|webp|tiff?|heic|avif)$/i;
const PDF = /\.pdf$/i;
const MAX_FILES = 50;
const MAX_BYTES = 400 * 1024 * 1024;

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function showError(message) {
  const box = $('error');
  box.textContent = message;
  box.hidden = !message;
}

function kindLabel(item) {
  if (item.kind === 'image') return (item.report.info.format || 'imagen').toUpperCase();
  if (item.kind === 'pdf') return 'PDF';
  return item.report.info.formatLabel;
}

// ---------------------------------------------------------------- compartir

// Invitación a compartir, sin rastreo y sin scripts de terceros: los enlaces solo
// se abren cuando el usuario hace clic, y el texto lo pone él.
function setupShare() {
  const url = location.origin + location.pathname;
  const texto = 'Quita los metadatos de tus archivos (fotos, Word, PDF) en el navegador, '
    + 'sin subirlos a ningún sitio:';
  const t = encodeURIComponent(texto);
  const u = encodeURIComponent(url);

  $('shareWa').href = `https://wa.me/?text=${t}%20${u}`;
  $('shareX').href = `https://x.com/intent/post?text=${t}&url=${u}`;
  $('shareLi').href = `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;

  // En el móvil, el botón nativo del sistema (donde el usuario elige a quién).
  const nativo = $('shareNative');
  if (navigator.share) {
    nativo.hidden = false;
    for (const id of ['shareWa', 'shareX', 'shareLi']) $(id).hidden = true;
    nativo.addEventListener('click', () => {
      navigator.share({ title: document.title, text: texto, url }).catch(() => {});
    });
  }

  $('shareCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      $('shareCopied').hidden = false;
    } catch {
      showError('No se pudo copiar el enlace. Cópialo de la barra del navegador.');
    }
  });
}

// ---------------------------------------------------------------- lectura

async function analyze(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffPdf(bytes)) {
    return { file, bytes, kind: 'pdf', report: await inspectPdf(bytes) };
  }
  const magic = sniff(bytes);
  if (magic) return { file, bytes, kind: 'image', report: inspectImage(bytes) };
  const entries = await readZip(bytes);
  return { file, bytes, entries, kind: 'office', report: inspect(entries) };
}

async function loadFiles(fileList) {
  showError('');
  const files = Array.from(fileList);
  state.items = [];
  state.results = [];
  state.rejected = [];
  $('resultCard').hidden = true;
  $('pendingCard').hidden = true;

  let total = 0;
  for (const file of files.slice(0, MAX_FILES)) {
    if (!OFFICE.test(file.name) && !IMAGE.test(file.name) && !PDF.test(file.name)) {
      state.rejected.push(`${file.name}: formato no admitido`);
      continue;
    }
    total += file.size;
    if (total > MAX_BYTES) {
      state.rejected.push(`${file.name}: se superó el límite de ${humanSize(MAX_BYTES)} por lote`);
      continue;
    }
    try {
      state.items.push(await analyze(file));
    } catch (err) {
      state.rejected.push(`${file.name}: ${err.message}`);
    }
  }
  if (files.length > MAX_FILES) {
    state.rejected.push(`solo se procesan ${MAX_FILES} archivos por lote`);
  }
  if (!state.items.length) {
    showError(state.rejected.join(' · ') || 'No se pudo leer ningún archivo.');
    $('fileCard').hidden = true;
    $('reportCard').hidden = true;
    $('optionsCard').hidden = true;
    return;
  }
  renderItems();
  renderReport(state.items[0], state.items.length === 1);
  setupOptions();
  $('fileCard').hidden = false;
  $('reportCard').hidden = state.items.length !== 1;
  $('optionsCard').hidden = false;
  const warnings = state.rejected.length
    ? ` Se omitieron ${state.rejected.length}: ${state.rejected.join(' · ')}` : '';
  showError(warnings.trim());
}

function renderItems() {
  const list = $('fileList');
  list.textContent = '';
  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'item';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.file.name;
    const meta = document.createElement('span');
    meta.className = 'muted';
    const personal = item.report.findings.filter((f) => f.sev === 'personal');
    const bits = [`${kindLabel(item)}`, humanSize(item.file.size)];
    bits.push(personal.length ? `${personal.length} datos personales` : 'sin datos personales');
    if (item.report.supported === false) bits.push('solo informe');
    meta.textContent = ` · ${bits.join(' · ')}`;
    li.append(name, meta);
    if (personal.length) {
      const detail = document.createElement('div');
      detail.className = 'muted indent';
      detail.textContent = personal.slice(0, 3).map((f) => f.label.toLowerCase()).join(', ');
      li.appendChild(detail);
    }
    list.appendChild(li);
  }
  $('fileCount').textContent = state.items.length === 1
    ? '1 archivo' : `${state.items.length} archivos`;
}

// ---------------------------------------------------------------- informe

function renderReport(item, detailed) {
  const wrap = $('report');
  wrap.textContent = '';
  const groups = new Map();
  for (const f of item.report.findings) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  for (const [group, items] of groups) {
    const section = document.createElement('div');
    section.className = 'group';
    const h = document.createElement('h3');
    h.textContent = group;
    section.appendChild(h);
    for (const entry of items) {
      const row = document.createElement('div');
      row.className = 'row sev-' + entry.sev;
      const label = document.createElement('div');
      label.className = 'label';
      const dot = document.createElement('span');
      dot.className = 'dot';
      label.append(dot, entry.label);
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = entry.value;
      row.append(label, value);
      section.appendChild(row);
    }
    wrap.appendChild(section);
  }
  $('reportSummary').textContent = summaryFor(item);
  $('reportTitle').textContent = detailed
    ? 'Qué información personal encontramos'
    : `Informe detallado: ${item.file.name}`;
}

function summaryFor(item) {
  const { info } = item.report;
  const bits = [];
  if (item.report.supported === false) {
    return item.kind === 'image'
      ? `Detectamos una imagen ${kindLabel(item)}, pero este formato todavía no se puede `
        + 'reescribir sin recodificar, así que solo mostramos el informe.'
      : 'Detectamos un PDF cifrado: se puede ver el informe, pero no limpiarlo sin la contraseña.';
  }
  if (item.kind === 'pdf') {
    if (info.incremental) bits.push(`${info.incremental} versión(es) anteriores dentro del archivo`);
    if (info.xmp) bits.push('XMP incrustado');
    if (info.id) bits.push('identificador del archivo');
  } else if (item.kind === 'image') {
    if (info.gps) bits.push('coordenadas GPS');
    if (info.exif) bits.push('datos EXIF');
    if (info.xmp) bits.push('XMP');
    if (info.icc) bits.push('perfil de color (que se conserva)');
    if (info.orientation) bits.push(`orientación ${info.orientation} (que se conserva)`);
  } else {
    if (info.trackedChanges) bits.push(`${info.trackedChanges} marcas de control de cambios`);
    if (info.distinctAuthors) bits.push(`${info.distinctAuthors} autores distintos`);
    if (info.technical) bits.push(`${info.technical} identificadores técnicos`);
    if (info.hasPeople) bits.push('cuentas vinculadas');
    if (info.hasCustomProps) bits.push('propiedades personalizadas');
    if (info.connections) bits.push('conexiones a bases de datos');
    if (info.hasThumbnail) bits.push('miniatura incrustada');
    if (info.hasMacros) bits.push('macros');
  }
  const label = kindLabel(item);
  const noun = item.kind === 'image' ? 'una imagen' : item.kind === 'pdf' ? 'un' : 'un archivo de';
  return bits.length
    ? `Detectamos ${noun} ${label} con ${bits.join(', ')}.`
    : `${label} sin metadatos personales detectados.`;
}

// ---------------------------------------------------------------- opciones

function setupOptions() {
  const kinds = new Set(state.items.map((i) => i.kind));
  const any = (k) => kinds.has(k);
  const anyChanges = state.items.some((i) => i.report.info.changes);
  const anyComments = state.items.some((i) => i.report.info.hasComments);
  const anyCustom = state.items.some((i) => i.report.info.hasCustomProps);
  const anyMacros = state.items.some((i) => i.report.info.hasMacros);
  const anyConn = state.items.some((i) => i.report.info.connections);
  const anyDeletable = state.items.some((i) => i.report.info.deleteComments != null);

  $('officeProps').hidden = !any('office');
  $('imageField').hidden = !any('image');
  $('pdfField').hidden = !any('pdf');
  $('changesField').hidden = !anyChanges;
  $('commentsField').hidden = !anyComments;

  $('optCustom').checked = true;
  $('optCustom').disabled = !anyCustom;
  $('optMacros').checked = true;
  $('optMacros').disabled = !anyMacros;
  $('optConnections').checked = true;
  $('connectionsLabel').hidden = !anyConn;
  $('optIcc').checked = false;
  $('optOrientation').checked = false;
  $('optAttachments').checked = false;

  $('commentDelete').disabled = !anyDeletable;
  if (anyDeletable) {
    $('commentDeleteNote').hidden = true;
  } else {
    $('commentDelete').checked = false;
    document.querySelector('input[name="comments"][value="anonymize"]').checked = true;
    $('commentDeleteNote').hidden = false;
  }
  const cleanable = state.items.filter((i) => i.report.supported !== false).length;
  const button = $('clean');
  button.disabled = cleanable === 0;
  button.textContent = state.items.length === 1
    ? 'Limpiar y descargar'
    : `Limpiar ${cleanable} archivo${cleanable === 1 ? '' : 's'} y descargar .zip`;
}

function currentOptions() {
  return {
    changes: document.querySelector('input[name="changes"]:checked')?.value || 'keep',
    comments: document.querySelector('input[name="comments"]:checked')?.value || 'anonymize',
    customProps: $('optCustom').checked,
    macros: $('optMacros').checked,
    connections: $('optConnections').checked,
    icc: $('optIcc').checked ? 'remove' : 'keep',
    orientation: $('optOrientation').checked ? 'remove' : 'keep',
    attachments: $('optAttachments').checked,
  };
}

// ---------------------------------------------------------------- limpieza

function download(bytes, filename, type) {
  const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return blob.size;
}

const outNameFor = (name) => `${name.replace(/\.[^.]+$/, '')} - sin metadatos${name.slice(name.lastIndexOf('.'))}`;

async function cleanOne(item, opts) {
  if (item.kind === 'pdf') return stripPdf(item.bytes, opts);
  if (item.kind === 'image') return stripImage(item.bytes, opts);
  return strip(item.entries, opts);
}

async function clean() {
  const button = $('clean');
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Procesando...';
  try {
    const opts = currentOptions();
    const done = [];
    const failed = [];
    const notes = new Set();
    for (const item of state.items) {
      if (item.report.supported === false) {
        failed.push(`${item.file.name}: formato no soportado para limpiar`);
        continue;
      }
      button.textContent = `Procesando ${done.length + 1}/${state.items.length}...`;
      try {
        const result = await cleanOne(item, opts);
        done.push({ name: outNameFor(item.file.name), bytes: result.bytes });
        if (state.items.length === 1) for (const n of result.removed) notes.add(n);
      } catch (err) {
        failed.push(`${item.file.name}: ${err.message}`);
      }
    }
    if (!done.length) throw new Error(failed.join(' · ') || 'no se pudo limpiar nada');

    let size;
    let outName;
    if (done.length === 1) {
      outName = done[0].name;
      size = download(done[0].bytes, outName);
    } else {
      const used = new Map();
      const entries = done.map((d) => {
        let name = d.name;
        const count = (used.get(name) || 0) + 1;
        used.set(name, count);
        if (count > 1) name = name.replace(/(\.[^.]+)$/, ` (${count})$1`);
        return { name, data: d.bytes, versionMadeBy: 20, extAttr: 0 };
      });
      const zip = await writeZip(entries);
      outName = `archivos sin metadatos (${done.length}).zip`;
      size = download(zip, outName, 'application/zip');
    }

    $('outName').textContent = outName;
    const totalIn = state.items.reduce((s, i) => s + i.file.size, 0);
    $('outSize').textContent = done.length === 1
      ? `(${humanSize(size)}, antes ${humanSize(state.items[0].file.size)})`
      : `(${humanSize(size)} en total, antes ${humanSize(totalIn)})`;
    const list = $('removed');
    list.textContent = '';
    if (notes.size) {
      for (const note of notes) {
        const li = document.createElement('li');
        li.textContent = note;
        list.appendChild(li);
      }
    } else {
      for (const d of done) {
        const li = document.createElement('li');
        li.textContent = d.name;
        list.appendChild(li);
      }
    }
    if (failed.length) {
      for (const f of failed) {
        const li = document.createElement('li');
        li.className = 'fail';
        li.textContent = `no se pudo limpiar — ${f}`;
        list.appendChild(li);
      }
    }
    renderPending();
    $('resultCard').hidden = false;
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError('No se pudo limpiar: ' + err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function renderPending() {
  const pending = [];
  for (const item of state.items) {
    for (const f of item.report.findings) {
      if (f.keep) pending.push(`${f.label}: ${f.value}`);
    }
  }
  const unique = Array.from(new Set(pending));
  const list = $('pending');
  list.textContent = '';
  $('pendingCard').hidden = unique.length === 0;
  for (const text of unique) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------- eventos

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') $('file').click();
});
$('file').addEventListener('change', (e) => {
  if (e.target.files.length) loadFiles(e.target.files);
  e.target.value = '';
});
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});
$('clean').addEventListener('click', clean);
setupShare();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
