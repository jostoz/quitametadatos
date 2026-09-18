#!/usr/bin/env python3
"""Abre un archivo de Office con la aplicación real (COM) en solo lectura e
imprime las propiedades que ve el usuario. No guarda nada.
Uso: check_with_office.py archivo.docx|xlsx|pptx [...]
"""
import os
import sys

import win32com.client as win32

WORD = [
    'Title', 'Subject', 'Author', 'Keywords', 'Comments', 'Last author',
    'Revision number', 'Template', 'Company', 'Total editing time',
]
EXCEL = [
    'Title', 'Subject', 'Author', 'Keywords', 'Comments', 'Last author',
    'Revision number', 'Company', 'Manager',
]


def dump(path, doc, props):
    print('#' * 70)
    print(path)
    for p in props:
        try:
            print(f'  {p:<20} {doc.BuiltinDocumentProperties(p)}')
        except Exception as e:  # noqa: BLE001
            print(f'  {p:<20} <error: {e}>')
    try:
        print(f'  {"custom props":<20} {doc.CustomDocumentProperties.Count}')
    except Exception as e:  # noqa: BLE001
        print(f'  {"custom props":<20} <error: {e}>')


def open_doc(app, prog_id, path):
    if prog_id.startswith('Excel'):
        return app.Workbooks.Open(path, ReadOnly=True)
    if prog_id.startswith('PowerPoint'):
        return app.Presentations.Open(path, ReadOnly=True, WithWindow=False)
    return app.Documents.Open(path, ReadOnly=True, AddToRecentFiles=False)


def close_doc(doc, prog_id):
    if prog_id.startswith('PowerPoint'):
        doc.Close()
    else:
        doc.Close(False)


def open_with(prog_id, paths, props, dump):
    app = win32.DispatchEx(prog_id)
    try:
        app.DisplayAlerts = 0
    except Exception:  # noqa: BLE001
        pass
    docs = []
    try:
        for p in paths:
            docs.append((p, open_doc(app, prog_id, p)))
        for p, doc in docs:
            dump(p, doc, props)
            dump_extra(prog_id, doc)
    finally:
        for _, doc in docs:
            try:
                close_doc(doc, prog_id)
            except Exception:  # noqa: BLE001
                pass
        try:
            app.Quit()
        except Exception:  # noqa: BLE001
            pass


def dump_extra(prog_id, doc):
    if prog_id.startswith('Excel'):
        return dump_excel(doc)
    if prog_id.startswith('PowerPoint'):
        return dump_ppt(doc)
    return dump_word(doc)


def dump_word(doc):
    print(f'  {"revisions":<20} {doc.Revisions.Count}')
    print(f'  {"chars":<20} {len(doc.Content.Text)}')
    try:
        print(f'  {"comments":<20} {doc.Comments.Count}')
        for i in range(1, doc.Comments.Count + 1):
            c = doc.Comments.Item(i)
            print(f'    #{i} autor={c.Author!r} texto={(c.Range.Text or "")[:50]!r}')
    except Exception as e:  # noqa: BLE001
        print(f'  {"comments":<20} <error: {e}>')


def dump_excel(doc):
    print(f'  {"hojas":<20} {doc.Sheets.Count}')
    for i in range(1, doc.Sheets.Count + 1):
        s = doc.Sheets(i)
        print(f'    {i}. {s.Name!r} visible={s.Visible}')
    for i in range(1, doc.Sheets.Count + 1):
        try:
            c = doc.Sheets(i).Comments.Count
            if c:
                print(f'  comentarios en {doc.Sheets(i).Name}: {c}')
        except Exception:  # noqa: BLE001
            pass
    try:
        print(f'  {"conexiones":<20} {doc.Connections.Count}')
    except Exception as e:  # noqa: BLE001
        print(f'  {"conexiones":<20} <error: {e}>')


def dump_ppt(doc):
    print(f'  {"diapositivas":<20} {doc.Slides.Count}')


def main(paths):
    groups = {'word': [], 'excel': [], 'powerpoint': []}
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext in ('.docx', '.docm'):
            groups['word'].append(p)
        elif ext in ('.xlsx', '.xlsm'):
            groups['excel'].append(p)
        elif ext in ('.pptx', '.pptm'):
            groups['powerpoint'].append(p)
        else:
            print('extensión no soportada:', p)

    if groups['word']:
        open_with('Word.Application', groups['word'], WORD, dump)
    if groups['excel']:
        open_with('Excel.Application', groups['excel'], EXCEL, dump)
    if groups['powerpoint']:
        open_with('PowerPoint.Application', groups['powerpoint'], EXCEL, dump)


if __name__ == '__main__':
    main(sys.argv[1:])
