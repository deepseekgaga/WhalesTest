"""Read workflow login credentials from physical workbook rows."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from .xlsx_xml import XlsxError, read_numbered_workbook


class WorkflowCredentialsError(ValueError):
    """Raised when workflow credentials cannot be read safely."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class WorkflowCredentials:
    username: str
    password: str


def _load_first_sheet_rows(path: Path) -> list[tuple[int, list[str]]]:
    try:
        workbook = read_numbered_workbook(path)
    except FileNotFoundError as exc:
        raise WorkflowCredentialsError("input_excel_missing") from exc
    except (OSError, BadZipFile, KeyError, ParseError, XlsxError, ValueError) as exc:
        raise WorkflowCredentialsError("input_excel_invalid") from exc
    return next(iter(workbook.values()), [])


def read_workflow_credentials(path: str | Path, excel_row: int) -> WorkflowCredentials:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
        raise WorkflowCredentialsError("excel_row_invalid")

    rows = _load_first_sheet_rows(Path(path))
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise WorkflowCredentialsError("excel_exhausted")

    username = values[0] if len(values) > 0 else ""
    password = values[1] if len(values) > 1 else ""
    if not username or not password:
        raise WorkflowCredentialsError("credentials_invalid")

    return WorkflowCredentials(username=username, password=password)
