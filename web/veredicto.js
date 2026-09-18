// Utilidades compartidas para construir un veredicto (riesgo/puntuación/hallazgos)
// a partir de una lista de hallazgos con nivel alto/medio/bajo. Las usan
// risk.js (¿es prudente abrir este archivo?) y secrets.js (¿hay secretos
// expuestos en este texto?): mismo lenguaje, mismos umbrales, para que un
// agente que ya conoce uno de los dos productos no tenga que aprender otro
// formato de respuesta.

export const PESO = { alto: 40, medio: 15, bajo: 5 };

export function hallazgo(nivel, titulo, detalle) {
  return { nivel, titulo, detalle };
}

/** @param {{nivel: 'alto'|'medio'|'bajo'}[]} hallazgos */
export function puntuacionYVeredicto(hallazgos) {
  const puntuacion = Math.min(100, hallazgos.reduce((s, h) => s + PESO[h.nivel], 0));
  const riesgo = puntuacion >= 40 ? 'alto' : puntuacion >= 15 ? 'medio' : 'bajo';
  return { puntuacion, riesgo };
}
