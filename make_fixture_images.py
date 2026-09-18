#!/usr/bin/env python3
"""Genera imágenes de prueba 'sucias' con las fugas típicas:
  jpg: EXIF completo (cámara, series, objetivos, fechas, autor, copyright,
       propietario, GPS, orientación), XMP, IPTC, comentario JPEG, perfil ICC
  png: tEXt, iTXt, zTXt, tIME, eXIf con GPS, perfil ICC
  webp: EXIF + XMP + perfil ICC
Uso: make_fixture_images.py prefijo
"""
import struct
import sys
import zlib

from PIL import Image, ImageCms

WIDTH, HEIGHT = 120, 60
ORIENTATION = 6


def icc_bytes():
    return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


def exif_object():
    exif = Image.Exif()
    exif[0x010F] = 'Apple'
    exif[0x0110] = 'iPhone 15 Pro'
    exif[0x0112] = ORIENTATION
    exif[0x0131] = 'Adobe Photoshop 25.0 (Windows)'
    exif[0x0132] = '2026:09:17 19:59:00'
    exif[0x013B] = 'Eduardo'
    exif[0x8298] = '\u00a9 2026 Despacho Jur\u00eddico X'
    exif[0x9003] = '2026:09:17 19:54:00'
    exif[0x9286] = b'ASCII\x00\x00\x00nota del fotografo'
    exif[0xA002] = WIDTH
    exif[0xA003] = HEIGHT
    exif[0xA420] = '0123456789ABCDEF'
    exif[0xA430] = 'Ariadna Mart\u00ednez'
    exif[0xA431] = 'F2LX90012345'
    exif[0xA433] = 'Apple'
    exif[0xA434] = 'iPhone 15 Pro back triple camera 6.86mm f/1.78'
    exif[0xA435] = 'LENS-99887766'
    gps = exif.get_ifd(0x8825)
    gps[1] = 'N'
    gps[2] = 20.6750
    gps[3] = 'W'
    gps[4] = 103.3333
    gps[5] = 0
    gps[6] = 1560.0
    gps[7] = 19.9
    gps[29] = '2026:09:17'
    return exif


def paint():
    img = Image.new('RGB', (WIDTH, HEIGHT))
    px = img.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            px[x, y] = ((x * 2) % 256, (y * 4) % 256, ((x + y) * 3) % 256)
    return img


def seg(marker, payload):
    return bytes([0xFF, marker]) + struct.pack('>H', len(payload) + 2) + payload


def xmp_packet():
    return (b'http://ns.adobe.com/xap/1.0/\x00'
            b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
            b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" '
            b'xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
            b'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">'
            b'<dc:creator><rdf:Seq><rdf:li>Ariadna Mart\xc3\xadnez</rdf:li></rdf:Seq></dc:creator>'
            b'<xmp:CreatorTool>Adobe Photoshop 25.0</xmp:CreatorTool>'
            b'<photoshop:City>Quer\xc3\xa9taro</photoshop:City>'
            b'</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')


def iptc_block():
    def ds(dataset, value):
        raw = value.encode('latin1', 'replace')
        return bytes([0x1C, 0x02, dataset]) + struct.pack('>H', len(raw)) + raw
    data = (ds(0x50, 'Eduardo') + ds(0x6E, 'Despacho X')
            + ds(0x74, '\u00a9 2026 Despacho Juridico X')
            + ds(0x78, 'Foto del expediente'))
    if len(data) % 2:
        data += b'\x00'
    return (b'Photoshop 3.0\x00' + b'8BIM' + struct.pack('>H', 0x0404)
            + b'\x00\x00' + struct.pack('>I', len(data)) + data)


def make_jpeg(path):
    img = paint()
    img.save(path, 'JPEG', quality=92, exif=exif_object(), icc_profile=icc_bytes())
    raw = open(path, 'rb').read()
    # insertar XMP, IPTC y comentario justo después del SOI
    injected = (seg(0xE1, xmp_packet())
                + seg(0xED, iptc_block())
                + seg(0xFE, b'Foto tomada en la oficina del cliente'))
    open(path, 'wb').write(raw[:2] + injected + raw[2:])
    print('jpg:', path, len(raw) + len(injected), 'bytes')


def png_chunk(kind, data):
    return (struct.pack('>I', len(data)) + kind + data
            + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))


def make_png(path, prefixed=False):
    img = paint()
    img.save(path, 'PNG', icc_profile=icc_bytes())
    raw = open(path, 'rb').read()
    ihdr_end = 8 + 25  # firma + chunk IHDR completo
    exif = exif_object().tobytes()
    if not prefixed:
        exif = exif[6:]  # el chunk eXIf lleva solo el bloque TIFF
    injected = (png_chunk(b'tEXt', b'Author\x00Ariadna Martinez')
                + png_chunk(b'iTXt', b'Description\x00\x00\x00\x00\x00Expediente 000/2026')
                + png_chunk(b'zTXt', b'Comment\x00\x00' + zlib.compress(b'generado en el despacho'))
                + png_chunk(b'tIME', struct.pack('>HBBBBB', 2026, 9, 17, 19, 54, 0))
                + png_chunk(b'eXIf', exif))
    open(path, 'wb').write(raw[:ihdr_end] + injected + raw[ihdr_end:])
    print('png:', path, len(raw) + len(injected), 'bytes')


def make_webp(path):
    img = paint()
    img.save(path, 'WEBP', quality=92, exif=exif_object().tobytes(),
             icc_profile=icc_bytes())
    raw = open(path, 'rb').read()
    # añadir XMP y activar su marca en la cabecera VP8X
    riff_size = struct.unpack('<I', raw[4:8])[0]
    chunks = []
    i = 12
    while i + 8 <= len(raw):
        kind = raw[i:i + 4].decode('latin1')
        size = struct.unpack('<I', raw[i + 4:i + 8])[0]
        end = i + 8 + size + (size % 2)
        chunks.append([kind, bytearray(raw[i:end])])
        i = end
    xmp = xmp_packet()
    chunks.append(['XMP ', bytearray(b'XMP ' + struct.pack('<I', len(xmp)) + xmp
                                    + (b'\x00' if len(xmp) % 2 else b''))])
    body = b'WEBP'
    for kind, data in chunks:
        if kind == 'VP8X':
            data[8] |= 0x04 | 0x08  # XMP + EXIF
        body += bytes(data)
    out = b'RIFF' + struct.pack('<I', len(body)) + body
    open(path, 'wb').write(out)
    print('webp:', path, len(out), 'bytes')


if __name__ == '__main__':
    prefix = sys.argv[1]
    make_jpeg(prefix + '.jpg')
    make_png(prefix + '.png')
    make_png(prefix + '_exif_prefijo.png', prefixed=True)
    make_webp(prefix + '.webp')
