#!/usr/bin/env python3
"""Verifica una imagen limpiada contra el original.

Comprueba lo que importa:
  - los píxeles y los datos comprimidos son BYTE A BYTE idénticos (sin pérdida)
  - no quedan metadatos personales (EXIF, GPS, XMP, IPTC, comentarios, XMP/chunks)
  - la orientación y el perfil de color se conservan o se quitan según lo pedido
Uso: verify_clean_image.py original limpiado [keep-icc|remove-icc] [keep-orient|remove-orient]
"""
import struct
import sys

from PIL import Image

SENSITIVE = [b'Apple', b'iPhone', b'F2LX90012345', b'LENS-99887766', b'Eduardo',
             b'Ariadna', b'Despacho', b'xpacket', b'8BIM', b'oficina del cliente',
             b'Adobe Photoshop', b'expediente', b'146/2025']


def parts_jpeg(raw):
    segs, i = [], 2
    while i + 1 < len(raw):
        if raw[i] != 0xFF:
            break
        marker = raw[i + 1]
        if marker in (0xDA, 0xD9):
            return segs, raw[i:]
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack('>H', raw[i + 2:i + 4])[0]
        segs.append((marker, raw[i + 4:i + 2 + length]))
        i += 2 + length
    return segs, b''


def parts_png(raw):
    chunks, i = {}, 8
    order = []
    while i + 8 <= len(raw):
        length = struct.unpack('>I', raw[i:i + 4])[0]
        kind = raw[i + 4:i + 8].decode('latin1')
        data = raw[i + 8:i + 8 + length]
        chunks.setdefault(kind, []).append(data)
        order.append(kind)
        i += 12 + length
        if kind == 'IEND':
            break
    return chunks, order


def parts_webp(raw):
    chunks, i = {}, 12
    while i + 8 <= len(raw):
        kind = raw[i:i + 4].decode('latin1')
        size = struct.unpack('<I', raw[i + 4:i + 8])[0]
        chunks[kind] = raw[i + 8:i + 8 + size]
        i += 8 + size + (size % 2)
    return chunks


def main(orig, clean, icc='keep-icc', orient='keep-orient'):
    fails = []
    a = open(orig, 'rb').read()
    b = open(clean, 'rb').read()
    fmt = Image.open(orig).format
    print(f'formato           : {fmt} | orientación pedida: {orient} | ICC: {icc}')

    ia, ib = Image.open(orig), Image.open(clean)
    print(f'dimensiones       : {ia.size} -> {ib.size}')
    if ia.size != ib.size:
        fails.append('cambiaron las dimensiones')
    pa = ia.convert('RGB').tobytes()
    pb = ib.convert('RGB').tobytes()
    print('píxeles           :', 'idénticos' if pa == pb else 'DISTINTOS')
    if pa != pb:
        fails.append('los píxeles cambiaron (hubo recodificación)')

    if fmt == 'JPEG':
        segs_a, scan_a = parts_jpeg(a)
        segs_b, scan_b = parts_jpeg(b)
        markers_b = [m for m, _ in segs_b]
        print('datos comprimidos :', 'idénticos' if scan_a == scan_b else 'DISTINTOS')
        if scan_a != scan_b:
            fails.append('los datos comprimidos del JPEG cambiaron')
        if 0xE1 in markers_b:
            payloads = [p for m, p in segs_b if m == 0xE1]
            if any(not p.startswith(b'Exif\x00\x00') for p in payloads):
                fails.append('queda un APP1 que no es EXIF (XMP)')
            if any(b'xpacket' in p or b'GPS' in p for p in payloads):
                fails.append('queda XMP o GPS en el APP1')
        if 0xED in markers_b:
            fails.append('queda APP13 (IPTC)')
        if 0xFE in markers_b:
            fails.append('queda un comentario JPEG (COM)')
        if any(m == 0xEC for m in markers_b):
            fails.append('queda APP12 (datos de cámara)')
        icc_present = any(m == 0xE2 and p.startswith(b'ICC_PROFILE') for m, p in segs_b)
    elif fmt == 'PNG':
        chunks_b, order_b = parts_png(b)
        chunks_a, _ = parts_png(a)
        print('datos comprimidos :',
              'idénticos' if chunks_a.get('IDAT') == chunks_b.get('IDAT') else 'DISTINTOS')
        if chunks_a.get('IDAT') != chunks_b.get('IDAT'):
            fails.append('los datos comprimidos del PNG cambiaron')
        for kind in ('tEXt', 'iTXt', 'zTXt', 'tIME'):
            if kind in chunks_b:
                fails.append(f'queda el chunk {kind}')
        if 'eXIf' in chunks_b:
            if orient != 'keep-orient':
                fails.append('queda el chunk eXIf y no se pidió conservar la orientación')
            else:
                from PIL import Image as PILImage
                tiny = PILImage.new('RGB', (1, 1))
                tmp = '_tmp_exif_check.png'
                open(tmp, 'wb').write(b)
                exif_left = PILImage.open(tmp).getexif()
                fields = {k: v for k, v in exif_left.items()}
                if exif_left.get_ifd(0x8825):
                    fails.append('queda GPS en el eXIf conservado')
                if len(fields) > 3:
                    fails.append(f'el eXIf conservado tiene demasiados campos: {fields}')
                print('eXIf conservado   :', fields)
                import os
                os.remove(tmp)
        icc_present = 'iCCP' in chunks_b
    else:
        chunks_a = parts_webp(a)
        chunks_b = parts_webp(b)
        payload_a = {k: v for k, v in chunks_a.items() if k in ('VP8 ', 'VP8L', 'ALPH')}
        payload_b = {k: v for k, v in chunks_b.items() if k in ('VP8 ', 'VP8L', 'ALPH')}
        print('datos comprimidos :',
              'idénticos' if payload_a == payload_b else 'DISTINTOS')
        if payload_a != payload_b:
            fails.append('los datos comprimidos del WebP cambiaron')
        if 'EXIF' in chunks_b:
            if orient != 'keep-orient':
                fails.append('queda el bloque EXIF y no se pidió conservar la orientación')
            else:
                from PIL import Image as PILImage
                open('_tmp_webp_check.webp', 'wb').write(b)
                exif_left = PILImage.open('_tmp_webp_check.webp').getexif()
                fields = {k: v for k, v in exif_left.items()}
                if exif_left.get_ifd(0x8825):
                    fails.append('queda GPS en el EXIF conservado del WebP')
                if len(fields) > 3:
                    fails.append(f'el EXIF del WebP tiene demasiados campos: {fields}')
                print('EXIF conservado   :', fields)
                import os
                os.remove('_tmp_webp_check.webp')
        for kind in ('XMP ',):
            if kind in chunks_b:
                fails.append(f'queda el bloque {kind}')
        icc_present = 'ICCP' in chunks_b
        if 'VP8X' in chunks_b:
            flags = chunks_b['VP8X'][0]
            if flags & 0x04:
                fails.append('VP8X sigue marcando XMP')
            if bool(flags & 0x08) != ('EXIF' in chunks_b):
                fails.append('la marca EXIF del VP8X no coincide con los bloques')
            if icc_present and not flags & 0x20:
                fails.append('VP8X no marca el perfil ICC que sí está')
            print(f'VP8X flags        : 0x{flags:02x}')

    print('perfil ICC        :', 'presente' if icc_present else 'ausente')
    if icc == 'keep-icc' and not icc_present:
        fails.append('se perdió el perfil ICC')
    if icc == 'remove-icc' and icc_present:
        fails.append('el perfil ICC no se quitó')

    exif = Image.open(clean).getexif()
    gps = exif.get_ifd(0x8825)
    if gps:
        fails.append(f'quedan {len(gps)} campos GPS')
    thumb = exif.get_ifd(1)
    if thumb:
        fails.append('queda la miniatura del EXIF')
    orientation = exif.get(0x0112)
    original_orientation = Image.open(orig).getexif().get(0x0112)
    print('EXIF restante     :', dict(exif), '| GPS:', len(gps),
          f'| orientación original: {original_orientation}')
    if orient == 'keep-orient':
        if (original_orientation or 0) != (orientation or 0):
            fails.append(f'orientación cambiada ({original_orientation} -> {orientation})')
    elif orientation not in (None, 0):
        fails.append(f'la orientación no se quitó ({orientation})')

    raw_all = b + b''.join(bytes(p) for p in (Image.open(clean).info.get('icc_profile') or b'',))
    low = b.lower()
    for token in SENSITIVE:
        if token.lower() in low:
            fails.append(f'queda el texto {token!r} en el archivo')

    print()
    if fails:
        print('FALLOS:')
        for f in fails:
            print(' -', f)
        sys.exit(1)
    print('VERIFICACIÓN OK')


if __name__ == '__main__':
    main(*sys.argv[1:])
