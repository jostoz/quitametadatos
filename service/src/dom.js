// Shim de DOM para ejecutar el motor de limpieza del navegador (web/*.js) en
// Node/Bun. Solo cubre lo que usa ooxml.js: DOMParser y XMLSerializer.
//
// Diferencias con el navegador que importan aquí:
//  - xmldom NO crea un elemento <parsererror>: lanza ParseError en los errores
//    fatales. ooxml.js espera "XML inválido → excepción", así que el contrato
//    se mantiene (y aquí además se convierten los errores no fatales en
//    excepción, para no limpiar a medias un documento que no se pudo leer).
//  - Los avisos del parser se silencian: en el navegador no salen por consola.

import { DOMParser as XmldomParser, XMLSerializer } from '@xmldom/xmldom';

const FATAL = new Set(['fatalError', 'error']);

class StrictDOMParser {
  parseFromString(text, mimeType) {
    if (mimeType && mimeType !== 'application/xml' && mimeType !== 'text/xml') {
      throw new Error(`Tipo MIME no soportado en el servidor: ${mimeType}`);
    }
    return new XmldomParser({
      onError: (level, message) => {
        if (FATAL.has(level)) throw new Error(`XML inválido: ${message}`);
      },
    }).parseFromString(text, mimeType || 'application/xml');
  }
}

/** Instala DOMParser/XMLSerializer globales. Idempotente. */
export function installDom() {
  if (globalThis.__metacleanDom) return;
  globalThis.DOMParser = StrictDOMParser;
  globalThis.XMLSerializer = XMLSerializer;
  globalThis.__metacleanDom = true;
}

installDom();
