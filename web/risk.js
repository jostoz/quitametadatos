// Evalúa el riesgo de abrir un documento, a partir del mismo análisis que ya
// hace inspect()/inspectPdf()/inspectImage() para poder limpiarlo. No añade
// ningún parseo nuevo: es una capa de interpretación sobre señales que el
// motor ya extrae.
//
// Esto responde una pregunta distinta de la limpieza de metadatos: no es
// "¿qué datos personales lleva este archivo que yo voy a mandar?", es
// "¿es prudente abrir o procesar este archivo que ACABO de recibir?". Por eso
// no puntúa autoría/privacidad (eso es /v1/clean): puntúa contenido que puede
// ejecutarse o filtrar credenciales.
//
// Ni esto ni nada que dependa solo de la estructura del archivo es un
// antivirus: no analiza el código de las macros, no tiene firmas de malware,
// no sustituye un escáner de verdad. Es un primer filtro barato y explicable.

import { hallazgo, puntuacionYVeredicto } from './veredicto.js';

function assessOffice(report) {
  const { info, findings } = report;
  const hallazgos = [];

  if (info.hasMacros) {
    hallazgos.push(hallazgo('alto', 'Macros incrustadas (VBA)',
      'El archivo trae código que puede ejecutarse automáticamente al abrirlo o al habilitar '
      + 'el contenido. Es el vector más común de documentos maliciosos de Office.'));
  }

  const externos = findings.filter((f) => f.group === 'Excel · datos externos');
  const conexion = externos.find((f) => f.label === 'Conexiones a bases de datos');
  if (conexion) {
    hallazgos.push(hallazgo('alto', 'Conexión a una base de datos externa',
      `${conexion.value}. La cadena de conexión puede incluir usuario y contraseña en texto plano.`));
  }
  const enlaces = externos.filter((f) => f.label === 'Enlace a otro libro');
  if (enlaces.length) {
    hallazgos.push(hallazgo('medio', 'Enlaces a otros archivos',
      `${enlaces.length} referencia(s) a rutas o direcciones fuera de este archivo `
      + '(se consultan al recalcular el libro).'));
  }
  const dinamica = externos.find((f) => f.label === 'Tabla dinámica con origen externo');
  if (dinamica) {
    hallazgos.push(hallazgo('medio', 'Tabla dinámica con origen externo',
      'Una tabla dinámica lee de una fuente de datos fuera de este archivo.'));
  }
  const nombres = externos.find((f) => f.label === 'Nombres definidos apuntando a otros archivos');
  if (nombres) {
    hallazgos.push(hallazgo('medio', 'Nombres definidos que apuntan fuera del archivo', nombres.value));
  }
  if (findings.some((f) => f.group === 'Excel · hojas ocultas')) {
    hallazgos.push(hallazgo('bajo', 'Hojas ocultas',
      'Hay hojas de cálculo ocultas a la vista; puede haber contenido que no se muestra directamente.'));
  }

  return hallazgos;
}

function assessPdf(report) {
  const { findings } = report;
  const hallazgos = [];
  if (findings.some((f) => f.group === 'JavaScript')) {
    hallazgos.push(hallazgo('alto', 'Código que se ejecuta al abrir el PDF',
      'El documento tiene JavaScript, una acción de apertura (/OpenAction) o una acción '
      + 'adicional (/AA) que el lector puede ejecutar automáticamente.'));
  }
  const adjuntos = findings.filter((f) => f.group === 'Adjuntos');
  if (adjuntos.length) {
    hallazgos.push(hallazgo('medio', 'Archivos incrustados dentro del PDF',
      'El PDF contiene otros archivos empaquetados dentro; pueden ser de cualquier tipo, '
      + 'incluido un ejecutable, y el lector no siempre avisa antes de abrirlos.'));
  }
  return hallazgos;
}

const RECOMENDACION = {
  alto: 'No lo abras ni lo proceses con privilegios normales sin comprobarlo antes: mejor en una '
    + 'máquina aislada, o pide el archivo en un formato sin macros/código (.docx en vez de .docm, PDF '
    + 'sin JavaScript).',
  medio: 'Revisa el detalle antes de confiar en el archivo a ciegas; nada aquí ejecuta código sin que '
    + 'tú o el programa que lo abra deis un paso más, pero puede intentar acceder a redes o rutas de fuera.',
  bajo: 'No se han encontrado señales de contenido activo o credenciales expuestas en la estructura del '
    + 'archivo. Esto no es un análisis de malware: solo mira la estructura, no el contenido.',
};

/**
 * @param {'office'|'pdf'|'image'} kind
 * @param {object} report  el resultado de inspect()/inspectPdf()/inspectImage()
 * @returns {{riesgo: 'alto'|'medio'|'bajo', puntuacion: number, hallazgos: object[], recomendacion: string}}
 */
export function assessRisk(kind, report) {
  if (report.supported === false) {
    return {
      riesgo: 'desconocido',
      puntuacion: 0,
      hallazgos: [],
      recomendacion: 'No se ha podido leer la estructura del archivo (formato no soportado o cifrado); '
        + 'no se puede evaluar el riesgo.',
    };
  }
  const hallazgos = kind === 'office' ? assessOffice(report)
    : kind === 'pdf' ? assessPdf(report)
      : []; // las imágenes no llevan contenido ejecutable
  const { puntuacion, riesgo } = puntuacionYVeredicto(hallazgos);
  return { riesgo, puntuacion, hallazgos, recomendacion: RECOMENDACION[riesgo] };
}
