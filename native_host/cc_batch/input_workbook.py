"""Read ordered URL tasks from the configured workbook."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET
from zipfile import BadZipFile

from .xlsx_xml import XlsxError, read_workbook


@dataclass(frozen=True)
class InputTask:
    source_row: int
    url: str
    validation_error: str | None


def _is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def read_input_tasks(path: str | Path, url_column: str) -> list[InputTask]:
    try:
        sheets = read_workbook(path)
    except (OSError, BadZipFile, XlsxError, KeyError, ET.ParseError) as exc:
        raise ValueError("input_excel_invalid") from exc
    for rows in sheets.values():
        for header_row_index, row in enumerate(rows):
            if url_column not in row:
                continue
            url_index = row.index(url_column)
            tasks: list[InputTask] = []
            for source_row, data_row in enumerate(rows[header_row_index + 1 :], header_row_index + 2):
                value = data_row[url_index].strip() if url_index < len(data_row) else ""
                if not value:
                    continue
                tasks.append(InputTask(source_row, value, None if _is_http_url(value) else "invalid_url"))
            return tasks
    raise ValueError(f"missing_url_column:{url_column}")
