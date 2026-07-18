from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def cell_ref(column: int, row: int) -> str:
    letters = ""
    while column:
        column, remainder = divmod(column - 1, 26)
        letters = chr(65 + remainder) + letters
    return f"{letters}{row}"


def inline_cell(ref: str, value: str) -> str:
    escaped = (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
    return f'<c r="{ref}" t="inlineStr"><is><t>{escaped}</t></is></c>'


def write_xlsx(
    path: Path,
    rows: list[list[str]],
    sheet_name: str = "Sheet1",
    row_numbers: list[int] | None = None,
) -> None:
    if row_numbers is None:
        row_numbers = list(range(1, len(rows) + 1))
    if len(row_numbers) != len(rows):
        raise ValueError("row_numbers_length_mismatch")
    max_row_number = max(row_numbers, default=1)
    sheet_rows = []
    for row_number, row in zip(row_numbers, rows):
        cells = "".join(inline_cell(cell_ref(index, row_number), value) for index, value in enumerate(row, 1))
        sheet_rows.append(f'<row r="{row_number}">{cells}</row>')
    sheet_xml = (
        f'<worksheet xmlns="{MAIN}"><dimension ref="A1:Z{max(1, max_row_number)}"/>'
        f"<sheetData>{''.join(sheet_rows)}</sheetData></worksheet>"
    )
    workbook_xml = (
        f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
        f'<sheet name="{sheet_name}" sheetId="1" r:id="rId1"/>'
        "</sheets></workbook>"
    )
    workbook_rels = (
        f'<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    root_rels = (
        f'<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        f'Target="xl/workbook.xml"/></Relationships>'
    )
    content_types = (
        f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        f'<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        f'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
