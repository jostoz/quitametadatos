#!/usr/bin/env python3
"""Escanea metadatos personales en formatos distintos de .docx:
xlsx/xlsm, pptx, pdf, jpg/jpeg, png, tiff, doc (OLE).
Solo lee cabeceras y bloques de metadatos; no interpreta el contenido.
Uso: scan_otros_formatos.py archivo [archivo...]
"""
import re
import struct
import sys
import zipfile
from pathlib import Path

OK = '  [x] '
NO = '  [ ] '


def line(present, text):
    print((OK if present else NO) + text)


# ------------------------------------------------------------------ OOXML

def scan_zip_ooxml(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        kind = 'xlsx' if any(n.startswith('xl/') for n in names) else (
            'pptx' if any(n.startswith('ppt/') for n in names) else 'docx')
        print(f'  contenedor ZIP/{kind} con {len(names)} partes')

        if 'docProps/core.xml' in names:
            core = z.read('docProps/core.xml').decode('utf-8', 'replace')
            for tag in ('dc:title', 'dc:subject', 'dc:creator', 'cp:keywords',
                        'dc:description', 'cp:lastModifiedBy', 'cp:revision',
                        'dcterms:created', 'dcterms:modified', 'cp:category'):
                m = re.search(f'<{tag}[^>]*>([^<]*)</{tag}>', core)
                line(bool(m and m.group(1).strip()), f'core.xml {tag} = {m.group(1) if m else ""}')
        if 'docProps/app.xml' in names:
            app = z.read('docProps/app.xml').decode('utf-8', 'replace')
            for tag in ('Template', 'TotalTime', 'Company', 'Manager'):
                m = re.search(f'<{tag}>([^<]*)</{tag}>', app)
                line(bool(m and m.group(1).strip()), f'app.xml {tag} = {m.group(1) if m else ""}')
        line('docProps/custom.xml' in names, 'docProps/custom.xml (propiedades personalizadas)')

        persons = [n for n in names if re.search(r'persons?/person|person\.xml', n, re.I)]
        if persons:
            for n in persons:
                txt = z.read(n).decode('utf-8', 'replace')
                users = re.findall(r'userId="([^"]+)"', txt)
                names_ = re.findall(r'(?:displayName|author)="([^"]+)"', txt)
                line(True, f'{n}: nombres={names_} cuentas={users}')
        else:
            line(False, 'persons/person.xml (lista de personas con cuenta)')

        if kind == 'xlsx':
            ext = [n for n in names if n.startswith('xl/externalLinks/') and n.endswith('.rels')]
            line(bool(ext), f'enlaces externos a otros archivos ({len(ext)})')
            if ext:
                for n in ext:
                    print('        ', z.read(n).decode('utf-8', 'replace')[:200])
            conn = 'xl/connections.xml' in names
            line(conn, 'xl/connections.xml (cadenas de conexión a bases de datos)')
            if conn:
                txt = z.read('xl/connections.xml').decode('utf-8', 'replace')
                for m in re.findall(r'(?:connectionString|DBPassword|command)="([^"]{0,120})"', txt):
                    print('         ', m)
            wb = 'xl/workbook.xml' in names
            if wb:
                txt = z.read('xl/workbook.xml').decode('utf-8', 'replace')
                dn = re.findall(r'<definedName name="([^"]+)"', txt)
                line(bool(dn), f'nombres definidos ({len(dn)}): {dn[:5]}')
            pr = [n for n in names if n.startswith('xl/printerSettings/')]
            line(bool(pr), f'configuración de impresora ({len(pr)})')
        if kind == 'pptx':
            ca = 'ppt/commentAuthors.xml' in names
            line(ca, 'ppt/commentAuthors.xml (autores de comentarios)')
            if ca:
                txt = z.read('ppt/commentAuthors.xml').decode('utf-8', 'replace')
                print('         ', re.findall(r'name="([^"]+)" initials="([^"]*)"', txt))
        rev = [n for n in names if 'revision' in n.lower()]
        line(bool(rev), f'registros de revisión ({rev[:3]})')
        comments = [n for n in names if 'comment' in n.lower()]
        line(bool(comments), f'partes de comentarios: {comments[:4]}')


# ------------------------------------------------------------------ imágenes

def gps_summary(gps):
    keys = {1: 'latitud', 2: 'longitud', 3: 'altitud', 5: 'altitud',
            29: 'fecha GPS'}
    found = [keys.get(int(k), str(k)) for k in gps]
    return found


def scan_image(path):
    from PIL import Image, ExifTags
    raw = Path(path).read_bytes()
    print(f'  {len(raw)} bytes')
    if raw[:2] == b'\xff\xd8':
        segs = re.findall(rb'\xff(\xe1|\xe2|\xed|\xfe)\x00(.)', raw[:400000], re.S)
        xmp = b'ns.adobe.com/xap' in raw[:400000]
        iptc = b'Photoshop 3.0' in raw[:400000] or b'8BIM' in raw[:400000]
        comment = b'\xff\xfe' in raw[:400000]
        line(xmp, 'XMP (Adobe)')
        line(iptc, 'IPTC / Photoshop (autor, copyright)')
        line(comment, 'segmento COM (comentario JPEG)')
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        chunks = re.findall(rb'\x00\x00\x00\x00|tEXt|iTXt|zTXt|eXIf|tIME',
                            raw[:200000])
        line(b'tEXt' in raw or b'iTXt' in raw, 'chunks de texto PNG')
        line(b'eXIf' in raw, 'chunk eXIf (EXIF dentro de PNG)')

    try:
        img = Image.open(path)
        exif = img.getexif()
    except Exception as e:  # noqa: BLE001
        line(False, f'no se pudo abrir con Pillow: {e}')
        return
    interesting = {
        'Make': 'fabricante', 'Model': 'modelo', 'Software': 'software',
        'DateTime': 'fecha', 'DateTimeOriginal': 'fecha de captura',
        'Artist': 'autor', 'Copyright': 'copyright', 'OwnerName': 'propietario',
        'SerialNumber': 'número de serie de la cámara',
        'LensSerialNumber': 'número de serie del objetivo',
        'BodySerialNumber': 'serie del cuerpo', 'HostComputer': 'equipo',
        'ImageUniqueID': 'identificador único de imagen',
    }
    for tag_id, value in exif.items():
        name = ExifTags.TAGS.get(tag_id, str(tag_id))
        if name in interesting:
            line(True, f'{interesting[name]} ({name}) = {str(value)[:60]}')
    gps = exif.get_ifd(0x8825) if hasattr(exif, 'get_ifd') else {}
    if gps:
        line(True, f'GPS presente: {gps_summary(gps)} (coordenadas omitidas)')
    else:
        line(False, 'GPS')
    try:
        thumb = img.getexif().get_ifd(1)
        line(bool(thumb), f'miniatura incrustada ({len(thumb)} campos)')
    except Exception:  # noqa: BLE001
        line(False, 'miniatura incrustada')


# ------------------------------------------------------------------ PDF

def scan_pdf(path):
    import pypdf
    r = pypdf.PdfReader(path)
    meta = r.metadata or {}
    print(f'  {len(r.pages)} páginas')
    for key in ('/Author', '/Creator', '/Producer', '/Title', '/Subject',
                '/Keywords', '/CreationDate', '/ModDate'):
        line(key in meta, f'{key} = {meta.get(key)}')
    raw = Path(path).read_bytes()
    line(b'<x:xmpmeta' in raw, 'XMP incrustado')
    line(b'/AcroForm' in raw, 'formulario (puede llevar valores previos)')
    line(b'%%EOF' in raw, 'actualizaciones incrementales (texto anterior recuperable)')
    line(b'/Annots' in raw, 'anotaciones/comentarios')
    line(b'/EmbeddedFiles' in raw, 'archivos adjuntos incrustados')


# ------------------------------------------------------------------ .doc OLE

def scan_doc(path):
    raw = Path(path).read_bytes()
    line(raw[:8] == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'contenedor OLE2')
    marker = '\x05SummaryInformation'.encode('utf-16-le')
    line(marker in raw, 'flujo SummaryInformation (autor, plantilla, fechas)')
    docsum = '\x05DocumentSummaryInformation'.encode('utf-16-le')
    line(docsum in raw, 'flujo DocumentSummaryInformation (empresa, propiedades)')


HANDLERS = {
    'xlsx': scan_zip_ooxml, 'xlsm': scan_zip_ooxml, 'docx': scan_zip_ooxml,
    'docm': scan_zip_ooxml, 'pptx': scan_zip_ooxml, 'pptm': scan_zip_ooxml,
    'jpg': scan_image, 'jpeg': scan_image, 'png': scan_image, 'tif': scan_image,
    'tiff': scan_image, 'webp': scan_image,
    'pdf': scan_pdf,
    'doc': scan_doc, 'xls': scan_doc,
}


def main(paths):
    for p in paths:
        ext = p.rsplit('.', 1)[-1].lower()
        print('=' * 72)
        print(p)
        handler = HANDLERS.get(ext)
        if not handler:
            print('  sin analizador para .' + ext)
            continue
        try:
            handler(p)
        except Exception as e:  # noqa: BLE001
            print(f'  error: {type(e).__name__}: {e}')


if __name__ == '__main__':
    main(sys.argv[1:])
