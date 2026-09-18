#!/usr/bin/env python3
"""Genera un PDF de prueba 'sucio' con las fugas reales de un PDF:
  - /Info con autor, título, asunto, palabras clave, programas y fechas
  - paquete XMP con autor y fechas
  - /ID (par de huellas del archivo)
  - JavaScript (/OpenAction)
  - un archivo adjunto incrustado
  - y lo más importante: una "redacción" mal hecha, es decir, texto que se
    quitó de la vista pero sigue dentro del archivo por una actualización
    incremental
Uso: make_fixture_pdf.py salida.pdf
"""
import sys

import fitz
from pypdf import PdfWriter

CONFIDENTIAL = 'EXPEDIENTE 000/2026 CONFIDENCIAL-BORRADO'

XMP = '''<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">
   <dc:creator><rdf:Seq><rdf:li>Ariadna Betsab\u00e9 Mart\u00ednez Andrade</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>Microsoft Word</xmp:CreatorTool>
   <xmp:CreateDate>2026-09-17T19:54:00-06:00</xmp:CreateDate>
   <xmp:ModifyDate>2026-09-17T19:59:00-06:00</xmp:ModifyDate>
   <pdf:Producer>Adobe Acrobat 24.0</pdf:Producer>
   <photoshop:City>Quer\u00e9taro</photoshop:City>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>'''


def build_base(path):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), 'P\u00e1gina uno del documento.', fontsize=11)
    # flujo de contenido propio, con texto LITERAL (como los generadores reales
    # que dejan el texto en claro dentro del archivo)
    literal = (f'BT /helv 14 Tf 72 742 Td ({CONFIDENTIAL}) Tj ET'.encode())
    stream_xref = doc.get_new_xref()
    doc.update_object(stream_xref, '<<>>')
    doc.update_stream(stream_xref, literal)
    page.set_contents(stream_xref)
    page2 = doc.new_page()
    page2.insert_text((72, 100), 'ANEXO UNO', fontsize=14)
    doc.set_metadata({
        'author': 'Ariadna Betsab\u00e9 Mart\u00ednez Andrade',
        'title': 'Conceptos de violaci\u00f3n',
        'subject': 'Demanda de amparo indirecto',
        'keywords': 'amparo, detenci\u00f3n, vinculaci\u00f3n',
        'creator': 'Microsoft Word',
        'producer': 'Adobe Acrobat 24.0',
        'creationDate': 'D:20260917195400-06\'00\'',
        'modDate': 'D:20260917195900-06\'00\'',
    })
    doc.save(path, deflate=False)   # sin comprimir: el texto queda legible en claro
    doc.close()


def add_js_and_attachment(path):
    writer = PdfWriter(clone_from=path)
    writer.add_js("app.alert('documento interno del despacho');")
    with open(path, 'rb') as fh:
        writer.add_attachment('borrador-interno.txt', fh.read())
    with open(path, 'wb') as fh:
        writer.write(fh)
    print('js + adjunto a\u00f1adidos')


def add_xmp_and_incremental_redaction(path):
    doc = fitz.open(path)
    doc.set_xml_metadata(XMP)
    page = doc[0]
    for rect in page.search_for('CONFIDENCIAL-BORRADO'):
        page.add_redact_annot(rect)
    page.apply_redactions()
    doc.save(path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
    doc.close()
    print('XMP + redacci\u00f3n incremental aplicados')


if __name__ == '__main__':
    out = sys.argv[1]
    build_base(out)
    add_js_and_attachment(out)
    add_xmp_and_incremental_redaction(out)
    raw = open(out, 'rb').read()
    print('fixture pdf:', out, len(raw), 'bytes')
    print('¿el texto "borrado" sigue dentro?', CONFIDENTIAL.split()[-1].encode() in raw)
    print('revisiones:', raw.count(b'%%EOF'))
