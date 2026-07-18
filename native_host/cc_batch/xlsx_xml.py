"""Small, dependency-free XLSX Open XML reader/writer for this workflow."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
ET.register_namespace("", MAIN)
ET.register_namespace("r", REL)


class XlsxError(ValueError):
    """Raised when an XLSX package cannot be read or updated safely."""


def _tag(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        raise XlsxError(f"invalid_cell_reference:{reference}")
    value = 0
    for letter in match.group(1):
        value = value * 26 + ord(letter) - 64
    return value


def column_name(index: int) -> str:
    if index < 1:
        raise ValueError("column index must be positive")
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext())


def _relationships(zf: ZipFile) -> dict[str, str]:
    root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    return {item.attrib["Id"]: item.attrib["Target"] for item in root.findall(_tag(PKG_REL, "Relationship"))}


def _sheet_parts(zf: ZipFile) -> list[tuple[str, str]]:
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    relationships = _relationships(zf)
    result = []
    for sheet in workbook.find(_tag(MAIN, "sheets")) or []:
        relation_id = sheet.attrib.get(_tag(REL, "id"))
        target = relationships.get(relation_id or "")
        if not target:
            raise XlsxError(f"missing_sheet_relationship:{sheet.attrib.get('name', '')}")
        target = target.lstrip("/")
        if not target.startswith("xl/"):
            target = f"xl/{target}"
        result.append((sheet.attrib.get("name", ""), target))
    return result


def _shared_strings(zf: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    return [_text(item) for item in root.findall(_tag(MAIN, "si"))]


def _cell_value(cell: ET.Element, shared: list[str]) -> str:
    kind = cell.attrib.get("t")
    if kind == "inlineStr":
        return _text(cell.find(_tag(MAIN, "is")))
    raw = _text(cell.find(_tag(MAIN, "v")))
    if kind == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError) as exc:
            raise XlsxError("invalid_shared_string_reference") from exc
    return raw


def _read_sheet_rows(zf: ZipFile, sheet_path: str, shared: list[str]) -> list[tuple[int, list[str]]]:
    root = ET.fromstring(zf.read(sheet_path))
    sheet_data = root.find(_tag(MAIN, "sheetData"))
    if sheet_data is None:
        return []
    rows: list[tuple[int, list[str]]] = []
    seen_row_numbers: set[int] = set()
    for row in sheet_data.findall(_tag(MAIN, "row")):
        try:
            row_number = int(row.attrib.get("r", "0"))
        except ValueError as exc:
            raise XlsxError("invalid_row_number") from exc
        if row_number < 1 or row_number in seen_row_numbers:
            raise XlsxError("invalid_row_number")
        seen_row_numbers.add(row_number)
        values: list[str] = []
        for cell in row.findall(_tag(MAIN, "c")):
            index = column_index(cell.attrib.get("r", "A1"))
            while len(values) < index:
                values.append("")
            values[index - 1] = _cell_value(cell, shared)
        rows.append((row_number, values))
    return rows


def read_numbered_workbook(path: str | Path) -> dict[str, list[tuple[int, list[str]]]]:
    path = Path(path)
    with ZipFile(path, "r") as zf:
        shared = _shared_strings(zf)
        result: dict[str, list[tuple[int, list[str]]]] = {}
        for sheet_name, sheet_path in _sheet_parts(zf):
            result[sheet_name] = _read_sheet_rows(zf, sheet_path, shared)
        return result


def read_workbook(path: str | Path) -> dict[str, list[list[str]]]:
    return {name: [values for _, values in rows] for name, rows in read_numbered_workbook(path).items()}


def _make_inline_cell(reference: str, value: object) -> ET.Element:
    cell = ET.Element(_tag(MAIN, "c"), {"r": reference, "t": "inlineStr"})
    inline = ET.SubElement(cell, _tag(MAIN, "is"))
    text = ET.SubElement(inline, _tag(MAIN, "t"))
    text.text = "" if value is None else str(value)
    return cell


def _sheet_xml(rows: Iterable[Iterable[object]]) -> bytes:
    root = ET.Element(_tag(MAIN, "worksheet"))
    columns = ET.SubElement(root, _tag(MAIN, "cols"))
    for index, width in enumerate((30, 20, 20, 20, 20, 16), 1):
        ET.SubElement(
            columns,
            _tag(MAIN, "col"),
            {"min": str(index), "max": str(index), "width": str(width), "customWidth": "1"},
        )
    sheet_data = ET.SubElement(root, _tag(MAIN, "sheetData"))
    max_row = 0
    max_col = 0
    for row_number, row_values in enumerate(rows, 1):
        row = ET.SubElement(sheet_data, _tag(MAIN, "row"), {"r": str(row_number)})
        row_values = list(row_values)
        max_row = row_number
        max_col = max(max_col, len(row_values))
        for col_number, value in enumerate(row_values, 1):
            row.append(_make_inline_cell(f"{column_name(col_number)}{row_number}", value))
    dimension = ET.Element(_tag(MAIN, "dimension"), {"ref": f"A1:{column_name(max_col or 1)}{max_row or 1}"})
    root.insert(0, dimension)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _temporary_zip_path(directory: Path) -> Path:
    with tempfile.NamedTemporaryFile("wb", suffix=".tmp", dir=directory, delete=False) as handle:
        return Path(handle.name)


def write_minimal_workbook(path: str | Path, rows: list[list[object]], sheet_name: str = "汇总") -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = ET.Element(_tag(MAIN, "workbook"))
    sheets = ET.SubElement(workbook, _tag(MAIN, "sheets"))
    ET.SubElement(sheets, _tag(MAIN, "sheet"), {"name": sheet_name, "sheetId": "1", _tag(REL, "id"): "rId1"})
    workbook_xml = ET.tostring(workbook, encoding="utf-8", xml_declaration=True)
    rels = (
        f'<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet1.xml"/></Relationships>'
    ).encode()
    root_rels = (
        f'<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        f'Target="xl/workbook.xml"/></Relationships>'
    ).encode()
    content_types = (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '</Types>'
    ).encode()
    styles = f'<styleSheet xmlns="{MAIN}"/>'.encode()
    temporary = _temporary_zip_path(path.parent)
    try:
        with ZipFile(temporary, "w", ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", root_rels)
            zf.writestr("xl/workbook.xml", workbook_xml)
            zf.writestr("xl/_rels/workbook.xml.rels", rels)
            zf.writestr("xl/worksheets/sheet1.xml", _sheet_xml(rows))
            zf.writestr("xl/styles.xml", styles)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def append_row(path: str | Path, sheet_name: str, values: list[object]) -> None:
    path = Path(path)
    with ZipFile(path, "r") as source:
        entries = {info.filename: source.read(info.filename) for info in source.infolist()}
    with ZipFile(path, "r") as source:
        sheet_path = dict(_sheet_parts(source)).get(sheet_name)
    if not sheet_path or sheet_path not in entries:
        raise XlsxError(f"missing_sheet:{sheet_name}")
    root = ET.fromstring(entries[sheet_path])
    sheet_data = root.find(_tag(MAIN, "sheetData"))
    if sheet_data is None:
        sheet_data = ET.SubElement(root, _tag(MAIN, "sheetData"))
    existing_rows = sheet_data.findall(_tag(MAIN, "row"))
    row_number = max((int(row.attrib.get("r", "0")) for row in existing_rows), default=0) + 1
    row = ET.SubElement(sheet_data, _tag(MAIN, "row"), {"r": str(row_number)})
    for col_number, value in enumerate(values, 1):
        row.append(_make_inline_cell(f"{column_name(col_number)}{row_number}", value))
    dimension = root.find(_tag(MAIN, "dimension"))
    if dimension is None:
        dimension = ET.Element(_tag(MAIN, "dimension"))
        root.insert(0, dimension)
    dimension.set("ref", f"A1:{column_name(max(len(values), 1))}{row_number}")
    entries[sheet_path] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    temporary = _temporary_zip_path(path.parent)
    try:
        with ZipFile(temporary, "w", ZIP_DEFLATED) as target:
            for name, data in entries.items():
                target.writestr(name, data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
