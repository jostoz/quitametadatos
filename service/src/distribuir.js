// Distribución de un servicio x402/MCP: qué canales ya publicaste y qué te falta.
//
// Un agente no adivina URLs: encuentra servicios donde alguien los registra. Esta
// herramienta recorre los canales de descubrimiento y dice, canal por canal, si
// estás publicado, si ya hiciste lo que depende de ti (p. ej. el PR) o si falta el
// paso que solo puede dar una persona (el mantenedor que firma y paga: tú).
//
// Modo por defecto: SECO y gratuito. No envía nada, no usa credenciales de
// publicación, no abre PRs: solo te dice qué haría y deja la acción irreversible
// en tus manos.
//
// Uso:
//   npm run distribuir                                  # seco: lista los canales
//   npm run distribuir -- --canal catalogado --verbose  # cómo se comprueba uno
//   npm run distribuir -- --servicio <url> [archivo]    # empuja de verdad:
//                                                       #   levanta TU servicio en
//                                                       #   local con esa URL pública y
//                                                       #   le hace un cobro real que lo
//                                                       #   cataloga en el "bazaar".
//
// (El empuje paga de verdad con EVM_PRIVATE_KEY: es el "humano en la puerta" de
// las acciones irreversibles. El catálogo se dispara con el primer cobro que lleva
// la extensión de descubrimiento, así que el primer listado sale de un autopago.)

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { esPrincipal, ejecutarSiEsPrincipal } from './es-main.js';
import { startServer } from './server.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(HERE, '..', '..'); // la raíz del repo (donde viven los fixtures)

const args = process.argv.slice(2);
const arg = (nombre) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 ? args[i + 1] : null;
};
const TIENE = (nombre) => args.includes(`--${nombre}`);

const config = (() => {
  try { return loadConfig(); } catch { return null; }
})();

const CANALES = [
  {
    id: 'catalogado',
    nombre: 'Catálogo del facilitador (bazaar)',
    donde: 'https://facilitator.payai.network/discovery/resources',
    responsable: 'agente (primer cobro real) + humano (ese cobro paga de verdad)',
    comando: 'npm run catalogado',
    explicacion:
      'El agente lo consulta para encontrar APIs x402. Un servicio se cataloga cuando '
      + 'procesa un pago que lleva la extensión de descubrimiento — o sea, en la primera venta.',
  },
  {
    id: 'mcp-directory',
    nombre: 'mcp.directory',
    donde: 'https://mcp.directory',
    responsable: 'agente (formulario) + humano (ya enviado una vez)',
    comando: '(releer los metadatos del repo y republicar)',
    explicacion: 'Auto-lee metadatos de GitHub y publica en ~24h.',
  },
  {
    id: 'awesome-x402-mcp-services',
    nombre: 'cyberwareX/awesome-x402-mcp-services',
    donde: 'https://github.com/cyberwareX/awesome-x402-mcp-services',
    responsable: 'agente (abre el PR) + humano (aceptación en GitHub)',
    comando: 'PR #1 (ya abierto)',
    explicacion: 'Lista nicho: solo servicios MCP que cobran con x402.',
  },
  {
    id: 'awesome-x402',
    nombre: 'xpaysh/awesome-x402',
    donde: 'https://github.com/xpaysh/awesome-x402',
    responsable: 'agente (abre el PR) + humano (aceptación en GitHub)',
    comando: 'PR #1562 (ya abierto)',
    explicacion: 'La lista grande del ecosistema, 280+ estrellas.',
  },
  {
    id: 'smithery',
    nombre: 'Smithery',
    donde: 'https://smithery.ai',
    responsable: 'código primero (Streamable HTTP en el MCP) + humano (el registro)',
    comando: 'pendiente: exige transporte Streamable HTTP, no stdio',
    explicacion: 'Más tráfico real de agentes vía su gateway; hoy está bloqueado por el transporte.',
  },
  {
    id: 'registry-mcp',
    nombre: 'Registro oficial de MCP',
    donde: 'https://registry.modelcontextprotocol.io',
    responsable: 'humano (login por device flow de GitHub + cuenta npm real)',
    comando: 'pendiente: no es código',
    explicacion: 'Exige un login de GitHub por device flow (lo aprueba una persona) y publicar el servidor como paquete npm.',
  },
  {
    id: 'erc-8004',
    nombre: 'Identidad del servicio en ERC-8004',
    donde: 'Identity Registry (ERC-721 con agentURI)',
    responsable: 'agente (redacta el fichero de registro) + humano (manda la transacción)',
    comando: 'pendiente: el registro de identidad',
    explicacion: 'Da a tu servicio un identificador portable y resistente a censura (un ERC-721 que apunta a un fichero de registro con tus endpoints). Tú ya tienes la parte difícil: el servicio existe y liquida de verdad.',
  },
];

function pintarEstado(c) {
  console.log(`  · ${c.nombre}`);
  console.log(`    ${c.donde}`);
  console.log(`    ${c.explicacion}`);
  console.log(`    quién: ${c.responsable}`);
  console.log(`    cómo : ${c.comando}`);
  console.log('');
}

function listar() {
  console.log('\nCanales de descubrimiento de este servicio\n');
  for (const c of CANALES) pintarEstado(c);
  console.log('Nada de lo anterior envió nada ni usó credenciales: es una lista de qué hacer.');
  console.log('Para empujar el catálogo con un cobro real (de pago):');
  console.log('  npm run distribuir -- --servicio <url-pública> [archivo]\n');
}

function explicarCanal(id) {
  const c = CANALES.find((x) => x.id === id);
  if (!c) {
    console.error(`\nCanal desconocido: "${id}". Canales: ${CANALES.map((x) => x.id).join(', ')}.\n`);
    process.exit(1);
  }
  console.log('');
  pintarEstado(c);
}

/**
 * Levanta TU servicio en local con PUBLIC_URL pública y le hace un cobro real
 * para que el facilitador lo cataloge. Es la única acción irreversible del
 * archivo (gasta dinero de la cartera): por eso pide la URL y el pago.
 */
async function empujar(urlPublica, archivo) {
  if (!config) {
    console.error('\nSin .env no sé cobrar. Define X402_PAY_TO, X402_NETWORKS y el facilitador.\n');
    process.exit(1);
  }
  if (!process.env.EVM_PRIVATE_KEY) {
    console.error('\nFalta EVM_PRIVATE_KEY (la cartera que paga). En testnet es gratis: https://faucet.circle.com\n');
    process.exit(1);
  }
  console.log(`\nEmpujando el catálogo con un cobro real sobre ${urlPublica}`);
  console.log('(levanto el servicio en local, anunciando esa URL pública en el reto 402)\n');

  const { url, stop } = await startServer({
    ...config,
    publicUrl: urlPublica.replace(/\/+$/, ''),
    port: 0,
    host: '127.0.0.1',
  });
  console.log(`servicio local en ${url} · cobrando ${config.price} a ${config.payTo}\n`);

  try {
    // El pago lo hace el propio CLI de pagar.js, que firma con la cartera.
    const { execFileSync } = await import('node:child_process');
    const objetivo = resolve(RAIZ, archivo || '_fixture_foto.jpg');
    const entorno = { ...process.env, EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY };
    execFileSync(process.execPath, [join(HERE, 'pagar.js'), `${url}/v1/clean`, objetivo], { env: entorno, stdio: 'inherit' });
    console.log('\nY ahora comprueba que el facilitador lo catalogó:');
    console.log('  npm run catalogado\n');
  } finally {
    await stop();
  }
}


async function main() {
  const canal = arg('canal');
  if (canal) { explicarCanal(canal); return; }
  const servicio = arg('servicio');
  if (servicio) { await empujar(servicio, arg('archivo')); return; }
  listar();
}

await ejecutarSiEsPrincipal(import.meta, main);
