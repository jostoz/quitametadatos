#!/usr/bin/env python3
"""Verifica un lote: descomprime el ZIP entregado y comprueba cada archivo
contra su original con el verificador que le corresponde.
Uso: verify_batch.py lote.zip original1 [original2 ...]
"""
import contextlib
import io
import os
import sys
import zipfile

import verify_clean_image as VI
import verify_clean_ooxml as VO

IMAGE = ('.jpg', '.jpeg', '.png', '.webp')


def verify_pair(orig, clean):
    ext = os.path.splitext(orig)[1].lower()
    if ext in IMAGE:
        return VI.main, (orig, clean, 'keep-icc', 'keep-orient')
    if ext in ('.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm'):
        return VO.main, (orig, clean, 'same')
    return None, None


def main(zip_path, originals):
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        print('contenido del ZIP:', len(names), 'archivos')
        outdir = '_out/lote'
        os.makedirs(outdir, exist_ok=True)
        z.extractall(outdir)

    ok = 0
    failed = []
    checked = []
    for orig in originals:
        base, ext = os.path.splitext(os.path.basename(orig))
        want = f'{base} - sin metadatos{ext}'
        candidates = [n for n in names if n == want]
        if not candidates:
            failed.append(f'{orig}: no está en el ZIP (esperaba {want})')
            continue
        clean = os.path.join(outdir, candidates[0])
        fn, args = verify_pair(orig, clean)
        if fn is None:
            print(f'-- {orig}: sin verificador automático (se comprueba aparte)')
            checked.append(orig)
            continue
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                fn(*args)
            detail = ' / '.join(l.strip() for l in buf.getvalue().splitlines()
                                if 'píxeles' in l or 'comprimidos' in l
                                or 'texto' in l or 'partes con texto' in l)
            print(f'-- {os.path.basename(clean)}: OK | {detail}')
            ok += 1
        except SystemExit:
            print(f'-- {os.path.basename(clean)}: FALLÓ')
            print(buf.getvalue())
            failed.append(orig)
    print()
    print(f'{ok}/{len(originals)} verificados')
    if failed:
        print('FALLOS:', failed)
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:])
