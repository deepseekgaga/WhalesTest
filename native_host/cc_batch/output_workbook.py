"""Six-column history workbook with global sequence allocation."""

from __future__ import annotations

import re
from pathlib import Path
from xml.etree import ElementTree as ET

from .xlsx_xml import XlsxError, append_row, read_workbook, write_minimal_workbook


HEADERS = ["编号_文件名", "A", "B", "C", "D", "是否执行成功"]


class HistoryWorkbookError(ValueError):
    """Raised when the history workbook is incompatible or unavailable."""


class HistoryWorkbook:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def _sheets(self) -> dict[str, list[list[str]]]:
        if not self.path.exists():
            return {}
        try:
            return read_workbook(self.path)
        except (OSError, XlsxError, KeyError, ET.ParseError) as exc:
            raise HistoryWorkbookError("history_unreadable") from exc

    @staticmethod
    def _is_completely_empty(sheets: dict[str, list[list[str]]]) -> bool:
        return all(not any(cell for row in rows for cell in row) for rows in sheets.values())

    def _rows(self) -> list[list[str]]:
        return self._sheets().get("汇总", [])

    def preflight(self) -> None:
        if not self.path.exists():
            return
        sheets = self._sheets()
        if not self._is_completely_empty(sheets):
            rows = sheets.get("汇总", [])
            if not rows or rows[0][: len(HEADERS)] != HEADERS or len(rows[0]) != len(HEADERS):
                raise HistoryWorkbookError("history_header_mismatch")
        try:
            with self.path.open("a+b"):
                pass
        except OSError as exc:
            raise HistoryWorkbookError("history_not_writable") from exc

    def next_sequence(self) -> int:
        rows = self._rows()
        if rows and rows[0][: len(HEADERS)] != HEADERS:
            raise HistoryWorkbookError("history_header_mismatch")
        maximum = 0
        for row in rows[1:]:
            if not row:
                continue
            match = re.match(r"^(\d+)_", row[0])
            if match:
                maximum = max(maximum, int(match.group(1)))
        return maximum + 1

    def rows(self) -> list[list[str]]:
        return self._rows()

    def recorded_sequences(self) -> set[int]:
        sequences: set[int] = set()
        for row in self._rows()[1:]:
            if not row:
                continue
            match = re.match(r"^(\d+)_", row[0])
            if match:
                sequences.add(int(match.group(1)))
        return sequences

    def status_for_sequence(self, sequence: int) -> str | None:
        for row in reversed(self._rows()[1:]):
            if not row:
                continue
            match = re.match(r"^(\d+)_", row[0])
            if match and int(match.group(1)) == sequence:
                return "success" if len(row) >= 6 and row[5] == "成功" else "failure"
        return None

    def append(self, *, sequence: int, zip_name: str | None, fields: dict[str, str], success: bool) -> None:
        self.preflight()
        if not self.path.exists() or self._is_completely_empty(self._sheets()):
            try:
                write_minimal_workbook(self.path, [HEADERS], sheet_name="汇总")
            except (OSError, XlsxError) as exc:
                raise HistoryWorkbookError("history_append_failed") from exc
        filename = (Path(zip_name).stem if zip_name else "下载失败")
        prefix = f"{sequence:04d}"
        row = [f"{prefix}_{filename}", fields.get("A", ""), fields.get("B", ""), fields.get("C", ""), fields.get("D", ""), "成功" if success else "失败"]
        try:
            append_row(self.path, "汇总", row)
        except (OSError, XlsxError) as exc:
            raise HistoryWorkbookError("history_append_failed") from exc
