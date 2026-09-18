#!/usr/bin/env python3
"""Verifica un paquete OOXML limpiado (Word, Excel o PowerPoint) contra el original.

modos (solo tienen efecto en Word con control de cambios):
  same      contenido y marcas iguales; solo se retiraron metadatos
  accepted  marcas resueltas aceptando; texto = original sin lo borrado
  rejected  marcas resueltas rechazando; texto = original sin lo insertado
            y con lo borrado restaurado
Uso: verify_clean_ooxml.py original limpiado [modo]
"""
import re
import sys
import zipfile

import lxml.etree as LET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
REVISION_TAGS = ['ins', 'del', 'pPrChange', 'rPrChange']
WORD_REVISION_PART = re.compile(
    r'^word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$')

# partes que el limpiador puede retirar
ALLOWED_REMOVED = re.compile(
    r'^(docProps/(custom\.xml|thumbnail\..+)|word/(vbaProject\.bin|comments(Extended|Ids|Extensible)?\.xml)'
    r'|xl/(vbaProject\.bin|connections\.xml|printerSettings/.+)'
    r'|ppt/vbaProject\.bin)')
# partes cuyo contenido de texto puede cambiar legítimamente
TEXT_MAY_CHANGE = [
    re.compile(r'^docProps/(core|app)\.xml$'),
    re.compile(r'comments|commentAuthors', re.I),
]
TEXT_MAY_CHANGE_SOLVED = WORD_REVISION_PART
# rastros personales que nunca deben quedar
PATTERNS = {
    'nombre de autor': r'Ariadna|ari martinez',
    'cuenta de Windows Live': r'windows live|bbf90fce0664e5a7|04293925dad62832',
    'rsid': r'\sw:rsid[A-Za-z]*\s*=|<w:rsid\s|<w:rsidRoot',
    'paraId/textId': r'\s(?:w14|w15):(?:paraId|paraIdParent|textId)\s*=',
    'docId persistente': r'w1[45]:docId',
    'autor o fecha de revisión': r'\sw:author\s*=\s*"[^"]+"|\sw:date\s*=',
    'autor de comentario (Word)': r'<w:comment[^>]*\sw:author="[^"]+"',
    'autor en lista de autores (Excel)': r'<author>\s*\S+\s*</author>',
    'nombre en lista de personas': r'(?:displayName|w15:author)="[^"]+"',
    'cuenta en lista de personas': r'(?:userId|providerId)="[^"]+"',
    'autor de comentario (PowerPoint)': r'<p:cmAuthor[^>]*\sname="[^"]+"',
    'fecha de comentario': r'<p:cm\b[^>]*\sdt="|<threadedComment[^>]*\sdT="',
}
BINARY = re.compile(r'\.(bin|png|jpe?g|gif|emf|wmf|vml|mp4|ttf|otf|xlsx)$', re.I)


def local(el):
    return LET.QName(el).localname if isinstance(el.tag, str) else None


def inside(el, name):
    node = el.getparent()
    while node is not None:
        if local(node) == name:
            return True
        node = node.getparent()
    return False


def part_text(xml):
    return ''.join(LET.fromstring(xml).itertext())


def collect_text(xml, mode):
    root = LET.fromstring(xml)
    out = []
    for el in root.iter():
        name = local(el)
        if name == 'delText':
            if mode != 'accepted':
                out.append(el.text or '')
        elif name in ('t', 'instrText'):
            if mode == 'rejected' and inside(el, 'ins'):
                continue
            out.append(el.text or '')
    return ''.join(out)


def count(xml, tag):
    return len(re.findall('<w:' + tag + '[ >]', xml))


def resolve(base, target):
    out = []
    for part in (base + target).replace('\\', '/').split('/'):
        if part == '..':
            if out:
                out.pop()
        elif part not in ('', '.'):
            out.append(part)
    return '/'.join(out)


def rels_targets(part, base):
    out = []
    for tag in re.findall(r'<Relationship\b[^>]*>', part):
        if 'TargetMode="External"' in tag:
            continue
        m = re.search(r'Target="([^"]+)"', tag)
        if not m:
            continue
        t = m.group(1)
        if t.startswith(('http://', 'https://', '/')) or re.match(r'^[A-Za-z]:', t):
            continue
        out.append(resolve(base, t))
    return out


def detect(names):
    for n in names:
        if n.startswith('word/'):
            return 'word'
        if n.startswith('xl/'):
            return 'excel'
        if n.startswith('ppt/'):
            return 'powerpoint'
    return '?'


def main(orig, clean, mode='same'):
    zo, zn = zipfile.ZipFile(orig), zipfile.ZipFile(clean)
    fails = []
    onames, nnames = set(zo.namelist()), set(zn.namelist())
    fmt = detect(onames)
    assert fmt == detect(nnames), 'el formato cambió'

    removed = sorted(onames - nnames)
    print('formato           :', fmt, '| modo:', mode)
    print('partes eliminadas :', removed)
    for r in removed:
        if not ALLOWED_REMOVED.match(r):
            fails.append(f'parte eliminada no prevista: {r}')
    if nnames - onames:
        fails.append(f'partes añadidas: {sorted(nnames - onames)}')

    for n in zn.namelist():
        if n.endswith(('.xml', '.rels')):
            try:
                LET.fromstring(zn.read(n))
            except Exception as e:  # noqa: BLE001
                fails.append(f'{n}: XML inválido: {e}')

    # el texto de las partes que se conservan debe ser idéntico
    changed_text = []
    for n in sorted(onames & nnames):
        if BINARY.search(n) or not n.endswith(('.xml', '.rels')):
            continue
        skip = any(r.search(n) for r in TEXT_MAY_CHANGE)
        if mode in ('accepted', 'rejected') and TEXT_MAY_CHANGE_SOLVED.match(n):
            skip = True
        if skip:
            continue
        if part_text(zo.read(n)) != part_text(zn.read(n)):
            changed_text.append(n)
    print('partes con texto cambiado:', changed_text or 'ninguna')
    if changed_text:
        fails.append(f'texto alterado en {changed_text}')

    if fmt == 'word':
        do, dn = zo.read('word/document.xml'), zn.read('word/document.xml')
        esperado, obtenido = collect_text(do, mode), collect_text(dn, mode)
        print(f'texto esperado    : {len(esperado)} caracteres')
        print(f'texto obtenido    : {len(obtenido)} caracteres,',
              'idéntico' if esperado == obtenido else 'DISTINTO')
        if esperado != obtenido:
            fails.append('el texto no coincide con el esperado')
        dotext, dntext = do.decode(), dn.decode()
        for tag in REVISION_TAGS:
            a, b = count(dotext, tag), count(dntext, tag)
            ok = b == 0 if mode in ('accepted', 'rejected') else a == b
            print(f'{tag:<12} orig={a:<5} nuevo={b:<5}', 'OK' if ok else 'FALLO')
            if not ok:
                fails.append(f'{tag}: {a} -> {b}')
        if mode in ('accepted', 'rejected'):
            left = count(dntext, 'delText')
            print(f'{"delText":<12} {"":<12} nuevo={left:<5}', 'OK' if not left else 'FALLO')
            if left:
                fails.append(f'quedan {left} w:delText sin resolver')
        settings = zn.read('word/settings.xml').decode()
        if 'trackRevisions' in settings:
            fails.append('settings.xml sigue en modo control de cambios')

    for n in zn.namelist():
        if not n.endswith(('.xml', '.rels')):
            continue
        raw = zn.read(n).decode('utf-8')
        for label, pat in PATTERNS.items():
            if re.search(pat, raw):
                fails.append(f'{n}: queda {label}')

    core = LET.fromstring(zn.read('docProps/core.xml'))
    if len(core):
        fails.append(f'core.xml con {len(core)} elementos')
    app = LET.fromstring(zn.read('docProps/app.xml'))
    print('core.xml          :', 'vacío' if not len(core) else 'CON DATOS')
    print('app.xml           :', [local(e) for e in app])
    if [local(e) for e in app] != ['Application']:
        fails.append('app.xml conserva propiedades no imprescindibles')

    for gone in ('docProps/custom.xml', 'xl/connections.xml'):
        if gone in onames and gone in nnames:
            fails.append(f'{gone} sigue presente')
    for n in onames:
        if re.match(r'^(docProps/thumbnail\.|xl/printerSettings/)', n) and n in nnames:
            fails.append(f'{n} sigue presente')

    rels = zn.read('word/_rels/document.xml.rels').decode() if fmt == 'word' else ''
    root_rels = zn.read('_rels/.rels').decode()
    targets = rels_targets(root_rels, '')
    for n in zn.namelist():
        if n.endswith('.rels'):
            targets += rels_targets(zn.read(n).decode(), n[:n.rindex('_rels/')])
    for t in targets:
        if t not in nnames:
            fails.append(f'relación colgante -> {t}')
    for p in re.findall(r'PartName="([^"]+)"', zn.read('[Content_Types].xml').decode()):
        if p.lstrip('/') not in nnames:
            fails.append(f'content-type colgante -> {p}')
    if 'comments.xml' in rels and 'word/comments.xml' not in nnames:
        fails.append('referencia a comentarios eliminados')

    dates = {i.date_time for i in zn.infolist()}
    print('fechas del zip    :', dates)
    if dates != {(1980, 1, 1, 0, 0, 0)}:
        fails.append('timestamps del zip sin normalizar')

    print()
    if fails:
        print('FALLOS:')
        for f in fails:
            print(' -', f)
        sys.exit(1)
    print('VERIFICACIÓN OK')


if __name__ == '__main__':
    main(*sys.argv[1:])
