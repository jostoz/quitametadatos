// Verificación con los ficheros de prueba del propio proyecto.
//
// Manda cada original a la API PAGADA (pago x402 real, facilitador de pruebas),
// guarda el resultado en _out/agente/ y lo comprueba con los verificadores
// Python del proyecto (verify_clean_ooxml.py / verify_clean_image.py): mismos
// píxeles, mismo texto, EXIF/GPS fuera.
//
// Ejecutar: bun test/verify-fixtures.js

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { readZip } from '../../web/zip.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { loadAgentWallet } from '../src/wallet.js';
import { startStubFacilitator } from './stub-facilitator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAICES = join(HERE, '..', '..');
const SALIDA = join(RAICES, '_out', 'agente');

// original · verificador de python (o null para solo comprobaciones básicas)
const CASOS = [
  { fichero: '_fixture_sucio.docx', verificador: 'verify_clean_ooxml.py', args: ['same'] },
  { fichero: '_fixture_sucio.xlsx', verificador: 'verify_clean_ooxml.py', args: ['same'] },
  { fichero: '_fixture_foto.jpg', verificador: 'verify_clean_image.py', args: ['keep-icc', 'keep-orient'] },
  { fichero: '_fixture_foto.png', verificador: 'verify_clean_image.py', args: ['keep-icc', 'keep-orient'] },
  { fichero: '_fixture_foto.webp', verificador: 'verify_clean_image.py', args: ['keep-icc', 'keep-orient'] },
  { fichero: '_fixture_foto.pdf', verificador: null },
];

let ok = 0;
const fallos = [];
function check(nombre, condicion, detalle = '') {
  if (condicion) {
    ok++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos.push(nombre);
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const merchant = privateKeyToAccount(generatePrivateKey());
const facilitator = await startStubFacilitator({ network: 'eip155:84532' });
const config = loadConfig({
  X402_PAY_TO: merchant.address,
  X402_FACILITATOR_URL: facilitator.url,
  PORT: '0',
  MAX_FILE_BYTES: String(64 * 1024 * 1024),
});
const { url, stop } = await startServer(config);
const cartera = await loadAgentWallet({ EVM_PRIVATE_KEY: generatePrivateKey() });
await mkdir(SALIDA, { recursive: true });
console.log(`servicio en ${url} · cobrando ${config.price} a ${merchant.address}\n`);

try {
  for (const caso of CASOS) {
    const original = join(RAICES, caso.fichero);
    const bytes = new Uint8Array(await readFile(original));
    const formulario = new FormData();
    formulario.append('file', new File([bytes], caso.fichero, { type: 'application/octet-stream' }));

    const respuesta = await cartera.fetchPaid(`${url}/v1/clean`, { method: 'POST', body: formulario });
    console.log(`${caso.fichero} → ${respuesta.status}`);
    check(`${caso.fichero}: la API cobra y responde 200`, respuesta.status === 200, `status ${respuesta.status}`);
    if (respuesta.status !== 200) continue;

    const zip = await readZip(new Uint8Array(await respuesta.arrayBuffer()));
    const partes = new Map(zip.map((e) => [e.name, e.data]));
    const nombre = `${caso.fichero.replace(/\.[^.]+$/, '')} - sin metadatos${caso.fichero.slice(caso.fichero.lastIndexOf('.'))}`;
    const limpio = partes.get(nombre);
    check(`${caso.fichero}: el ZIP trae el archivo limpio`, !!limpio);
    if (!limpio) continue;
    const rutaLimpia = join(SALIDA, nombre);
    await writeFile(rutaLimpia, limpio);

    const informe = JSON.parse(new TextDecoder().decode(partes.get('informe.json')));
    check(`${caso.fichero}: el informe cuadra con los bytes`, informe.files[0].file.bytesOutput === limpio.length);
    check(`${caso.fichero}: el archivo limpio no es idéntico al original`,
      Buffer.compare(Buffer.from(limpio), Buffer.from(bytes)) !== 0);

    if (caso.verificador) {
      const salida = execFileSync(
        'python',
        [caso.verificador, caso.fichero, rutaLimpia.replace(`${RAICES}\\`, '').replace(`${RAICES}/`, ''), ...caso.args],
        // PYTHONIOENCODING: en Windows el stdout de python es cp1252, así que
        // "VERIFICACIÓN OK" llega con la Ó mal codificada y el test falla sin
        // que el archivo limpio tenga nada malo.
        { cwd: RAICES, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      );
      const verificado = /VERIFICACIÓN OK/.test(salida);
      check(`${caso.fichero}: ${caso.verificador} dice VERIFICACIÓN OK`, verificado,
        salida.split('\n').filter((l) => /FALLOS|✗| - /.test(l)).join(' | ').slice(0, 300));
      if (!verificado) console.log(salida);
    } else {
      const original = Buffer.from(bytes).toString('latin1');
      const limpioTexto = Buffer.from(limpio).toString('latin1');
      check('_fixture_foto.pdf: sigue siendo un PDF válido',
        limpioTexto.startsWith('%PDF-') && limpioTexto.includes('%%EOF'));
      check('_fixture_foto.pdf: el paquete XMP desaparece',
        original.includes('/Metadata') && !limpioTexto.includes('/Metadata'));
      check('_fixture_foto.pdf: se quitan las versiones anteriores del archivo',
        (original.match(/%%EOF/g) || []).length > (limpioTexto.match(/%%EOF/g) || []).length,
        `${(original.match(/%%EOF/g) || []).length} → ${(limpioTexto.match(/%%EOF/g) || []).length}`);
      // Determinismo: limpiar dos veces el mismo archivo debe dar bytes idénticos.
      // (Antes se comparaba con _out/pdf_keep.pdf, un artefacto de una corrida
      // vieja del navegador: en cuanto el fixture cambia un byte, el test falla
      // por algo que no tiene que ver con el código.)
      const { clean } = await import('../src/core.js');
      const otra = await clean(caso.fichero, bytes, {});
      check('_fixture_foto.pdf: limpiar dos veces da el mismo resultado (determinista)',
        Buffer.compare(Buffer.from(otra.bytes), Buffer.from(limpio)) === 0,
        `${otra.bytes.length} vs ${limpio.length} bytes`);
    }
  }

  // Un TIFF no se puede limpiar sin recodificar: el servicio lo dice y no cobra.
  const tiff = new Uint8Array(await readFile(join(RAICES, '_fixture_foto.tiff')));
  const formulario = new FormData();
  formulario.append('file', new File([tiff], '_fixture_foto.tiff', { type: 'image/tiff' }));
  const antes = facilitator.calls.settle.length;
  const rechazo = await cartera.fetchPaid(`${url}/v1/clean`, { method: 'POST', body: formulario });
  console.log(`_fixture_foto.tiff → ${rechazo.status}`);
  check('un TIFF se rechaza con 422', rechazo.status === 422, `status ${rechazo.status}`);
  check('y no se cobra por un formato no soportado', facilitator.calls.settle.length === antes);
} finally {
  await stop();
  await facilitator.stop();
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
