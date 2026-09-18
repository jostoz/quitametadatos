// Detecta secretos y credenciales expuestas en texto o código, antes de
// compartirlo: pegarlo en un gist público, mandarlo a otra API, hacer push a
// un repo. Mismo espíritu que risk.js: reglas deterministas (como gitleaks),
// nada de IA, nada que ejecute el texto que se analiza.
//
// No es un escáner exhaustivo: cubre los formatos de credencial de alta
// confianza más comunes (claves de proveedores conocidos, cadenas de
// conexión con contraseña, claves privadas PEM) más una heurística genérica
// de menor confianza para "algo que suena a secreto". No analiza el
// significado del texto ni verifica si la credencial sigue siendo válida.

import { hallazgo, puntuacionYVeredicto } from './veredicto.js';

// Patrones específicos, de alta confianza: van primero para que la heurística
// genérica no vuelva a contar lo que ya identificó un patrón con nombre.
const PATRONES = [
  { tipo: 'Clave privada (PEM)', nivel: 'alto',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { tipo: 'Access key de AWS', nivel: 'alto', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { tipo: 'Secret key de AWS', nivel: 'alto',
    re: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}['"]?/gi },
  { tipo: 'Token de GitHub', nivel: 'alto',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { tipo: 'Token de Slack', nivel: 'alto', re: /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/g },
  { tipo: 'Webhook de Slack', nivel: 'medio',
    re: /https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z]+\/B[0-9A-Z]+\/[0-9A-Za-z]+/g },
  { tipo: 'Clave de Stripe', nivel: 'alto', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { tipo: 'Clave de Anthropic', nivel: 'alto', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { tipo: 'Clave de OpenAI', nivel: 'alto', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g },
  { tipo: 'Clave de Google API', nivel: 'alto', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { tipo: 'Clave de SendGrid', nivel: 'alto', re: /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}\b/g },
  { tipo: 'Token de npm', nivel: 'alto', re: /\bnpm_[0-9A-Za-z]{36}\b/g },
  { tipo: 'Cadena de conexión con contraseña', nivel: 'alto',
    re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:/\s"']+:[^@/\s"']+@[^\s"']+/gi },
  { tipo: 'JSON Web Token (JWT)', nivel: 'medio',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Heurística genérica: una variable con nombre de secreto y un valor largo.
// Más falsos positivos que los patrones de arriba (por eso "medio"), y solo
// cuenta si no lo detectó ya alguno de ellos.
const GENERICO = /\b(?:api[_-]?key|secret|password|passwd|pwd|token)\b\s*[:=]\s*['"]([^'"\s]{8,})['"]/gi;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function lineaDe(texto, indice) {
  let linea = 1;
  for (let i = 0; i < indice; i++) if (texto.charCodeAt(i) === 10) linea++;
  return linea;
}

function oculta(valor) {
  if (valor.length <= 8) return '*'.repeat(valor.length);
  return `${valor.slice(0, 4)}${'*'.repeat(Math.min(12, valor.length - 6))}${valor.slice(-2)}`;
}

function ocultaCorreo(correo) {
  const [local, dominio] = correo.split('@');
  return `${local[0] || '*'}***@${dominio || '***'}`;
}

const seSolapa = (inicio, fin, rangos) => rangos.some(([a, b]) => inicio < b && fin > a);

function lineasTexto(lineas) {
  const unicas = [...new Set(lineas)];
  const mostradas = unicas.slice(0, 5).join(', ');
  return ` (línea${unicas.length > 1 ? 's' : ''} ${mostradas}${unicas.length > 5 ? '…' : ''})`;
}

const RECOMENDACION = {
  alto: 'No lo compartas así. Rota cualquier credencial que aparezca aquí —asúmela comprometida en '
    + 'cuanto salga de tu control— y quítala del texto antes de mandarlo, pegarlo o publicarlo.',
  medio: 'Revisa cada coincidencia antes de compartir: puede ser una credencial real o un falso '
    + 'positivo (un JWT de ejemplo, una variable con un nombre parecido). Si es real, rótala.',
  bajo: 'No se encontraron patrones de alta confianza. Esto no es un escáner exhaustivo: solo cubre '
    + 'los formatos de credencial más comunes, no analiza el significado del texto.',
};

/**
 * @param {string} texto  texto o código a revisar (ya decodificado a UTF-8)
 * @returns {{riesgo: 'alto'|'medio'|'bajo', puntuacion: number, hallazgos: object[], recomendacion: string}}
 */
export function scanSecrets(texto) {
  const rangos = [];
  const porTipo = new Map();

  for (const { tipo, nivel, re } of PATRONES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(texto))) {
      rangos.push([m.index, m.index + m[0].length]);
      const entrada = porTipo.get(tipo) || { nivel, lineas: [], ejemplo: oculta(m[0]) };
      entrada.lineas.push(lineaDe(texto, m.index));
      porTipo.set(tipo, entrada);
    }
  }

  GENERICO.lastIndex = 0;
  let g;
  while ((g = GENERICO.exec(texto))) {
    const inicio = g.index;
    const fin = inicio + g[0].length;
    if (seSolapa(inicio, fin, rangos)) continue;
    const entrada = porTipo.get('Posible secreto en una asignación') || { nivel: 'medio', lineas: [], ejemplo: oculta(g[1]) };
    entrada.lineas.push(lineaDe(texto, inicio));
    porTipo.set('Posible secreto en una asignación', entrada);
  }

  EMAIL.lastIndex = 0;
  let e;
  const correos = new Set();
  while ((e = EMAIL.exec(texto))) correos.add(e[0]);
  if (correos.size) {
    porTipo.set('Correo electrónico', {
      nivel: 'bajo',
      lineas: [],
      cuenta: correos.size,
      ejemplo: ocultaCorreo([...correos][0]),
    });
  }

  const hallazgos = [...porTipo.entries()].map(([tipo, { nivel, lineas, ejemplo, cuenta }]) => {
    const n = cuenta ?? lineas.length;
    const donde = lineas.length ? lineasTexto(lineas) : '';
    return hallazgo(nivel, tipo, `${n} coincidencia${n > 1 ? 's' : ''}${donde}. Ejemplo: ${ejemplo}`);
  });

  const { puntuacion, riesgo } = puntuacionYVeredicto(hallazgos);
  return { riesgo, puntuacion, hallazgos, recomendacion: RECOMENDACION[riesgo] };
}
