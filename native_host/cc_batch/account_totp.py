"""Exact A/B credential lookup for same-row C-column TOTP secrets."""

from __future__ import annotations

from pathlib import Path
from zipfile import BadZipFile

from .xlsx_xml import XlsxError, read_workbook


class AccountTotpError(ValueError):
    """Raised when the configured workbook cannot yield one TOTP secret."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def find_totp_secret(path: str | Path, username: str, password: str) -> str:
    path = Path(path)
    if not path.exists():
        raise AccountTotpError("input_excel_missing")
    try:
        sheets = read_workbook(path)
    except (OSError, BadZipFile, XlsxError, KeyError, ValueError):
        raise AccountTotpError("input_excel_invalid") from None

    matches: list[str] = []
    for rows in sheets.values():
        for row in rows:
            account = row[0] if len(row) > 0 else ""
            row_password = row[1] if len(row) > 1 else ""
            if account == username and row_password == password:
                matches.append(row[2] if len(row) > 2 else "")
    if not matches:
        raise AccountTotpError("account_not_found")
    if len(matches) != 1:
        raise AccountTotpError("account_duplicate")
    if not matches[0]:
        raise AccountTotpError("totp_secret_missing")
    return matches[0]
