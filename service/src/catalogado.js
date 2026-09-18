// ¿Está el servicio en el catálogo que consultan los agentes?
//
// Los agentes no adivinan URLs: buscan en el catálogo del facilitador (el
// "bazaar"). Un servicio se cataloga cuando se procesa un pago que lleva la
// extensión de descubrimiento — o sea, en la primera venta.
//
// Este comando consulta ese catálogo y dice si ya apareces, y con qué datos.
//
// Uso:  npm run catalogado            (usa la configuración del .env)
//       npm run catalogado -- <facilitador> <url-del-servicio>

import { loadConfig } from './config.js';

const config = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();

const facilitador = (process.argv[2] || config?.facilitatorUrl || 'https://facilitator.payai.network')
  .replace(/\/+$/, '');
const url = (process.argv[3] || config?.publicUrl || '').replace(/\/+$/, '');

console.log(`\nFacilitador: ${facilitador}`);
if (!url) {
  console.error('No sé qué URL buscar. Define PUBLIC_URL en el .env o pásala como segundo argumento.\n');
  process.exit(1);
}
console.log(`Buscando   : ${url}\n`);

const host = new URL(url).host;

async function pedir(ruta) {
  const r = await fetch(`${facilitador}${ruta}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${ruta} → HTTP ${r.status}`);
  return r.json();
}

/** Busca nuestra URL en cualquier parte de un recurso catalogado. */
const esNuestro = (recurso, aguja) => JSON.stringify(recurso).includes(aguja);

let encontrado = null;
let donde = '';
try {
  const busqueda = await pedir(`/discovery/search?query=${encodeURIComponent(host)}`);
  const lista = busqueda.resources || busqueda.items || [];
  encontrado = lista.find((r) => esNuestro(r, url));
  donde = `búsqueda por "${host}" (${lista.length} resultados)`;
  if (!encontrado) {
    // La búsqueda es por lenguaje natural y puede no pillarlo; miramos el listado.
    const todos = await pedir('/discovery/resources');
    const items = todos.items || todos.resources || [];
    encontrado = items.find((r) => esNuestro(r, url));
    donde = `listado completo (${items.length} recursos)`;
  }
} catch (err) {
  console.error(`No pude consultar el catálogo: ${err.message}\n`);
  process.exit(1);
}

if (!encontrado) {
  console.log(`Todavía NO apareces en el catálogo (mirado en: ${donde}).\n`);
  console.log('Es lo esperado si aún no ha habido ninguna venta: el catalogado se dispara');
  console.log('con el primer pago que lleva la extensión de descubrimiento. Para provocarlo,');
  console.log('haz un cobro real (aunque sea pagándote a ti mismo):\n');
  console.log(`   npm run pagar -- ${url}/v1/clean ..\\_fixture_foto.jpg\n`);
  console.log('Y justo después de pagar, el propio cliente te dice si quedó catalogado');
  console.log('(cabecera EXTENSION-RESPONSES). Después vuelve a correr esto para verlo aquí.\n');
  process.exit(0);
}

console.log('SÍ estás catalogado. Así te ve un agente:\n');
console.log(`  recurso     : ${encontrado.resource}`);
console.log(`  actualizado : ${encontrado.lastUpdated || '(sin fecha)'}`);
for (const a of encontrado.accepts || []) {
  console.log(`  pago        : ${Number(a.amount) / 1e6} USDC en ${a.network} → ${a.payTo}`);
}
const bz = encontrado.extensions?.bazaar;
if (bz) {
  console.log('\n  lo que un agente puede leer de tu servicio:');
  console.log(`    entrada: ${JSON.stringify(bz.info?.input || {}).slice(0, 150)}`);
  console.log(`    salida : ${JSON.stringify(bz.info?.output?.example || {}).slice(0, 150)}`);
}
console.log('');
