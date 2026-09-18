// ¿Se está ejecutando este módulo como programa principal?
//
// Bun trae `import.meta.main`; Node solo desde la v24. Sin esto, `node src/x.js`
// no arrancaba nada (salía con código 0 sin hacer nada), que es un fallo difícil
// de ver.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {ImportMeta} meta  `import.meta` del módulo que pregunta. */
export function esPrincipal(meta) {
  if (typeof meta.main === 'boolean') return meta.main;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(argv1) === resolve(fileURLToPath(meta.url));
  } catch {
    return false;
  }
}

/** Arranca `main()` si el módulo es el principal; si no, no hace nada. */
export async function ejecutarSiEsPrincipal(meta, main) {
  if (esPrincipal(meta)) await main();
}
