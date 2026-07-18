"""Build fixed local TOTP Lab challenge URLs from physical workbook rows."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote, urlencode
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from .config import Config
from .xlsx_xml import XlsxError, read_numbered_workbook


TOTP_LAB_BASE_URL = "http://totp-lab.local/"
TEST_HOOK_PLACEHOLDER = "__FILL_TOTP_TEST_HOOK__"


class TotpLabError(ValueError):
    """Raised when the local TOTP Lab challenge cannot be built."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _validate_base_url(value: str) -> str:
    if value != TOTP_LAB_BASE_URL:
        raise TotpLabError("totp_lab_url_invalid")
    return value


def _load_first_sheet_rows(path: Path) -> list[tuple[int, list[str]]]:
    try:
        workbook = read_numbered_workbook(path)
    except FileNotFoundError as exc:
        raise TotpLabError("input_excel_missing") from exc
    except (OSError, BadZipFile, KeyError, ParseError, XlsxError, ValueError) as exc:
        raise TotpLabError("input_excel_invalid") from exc
    return next(iter(workbook.values()), [])


def build_totp_lab_challenge(config: Config, excel_row: int) -> str:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 1:
        raise TotpLabError("excel_row_invalid")
    base_url = _validate_base_url(config.totp_lab_url)
    if not config.totp_lab_test_hook or config.totp_lab_test_hook == TEST_HOOK_PLACEHOLDER:
        raise TotpLabError("totp_test_hook_not_configured")

    rows = _load_first_sheet_rows(Path(config.input_excel))
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise TotpLabError("account_row_not_found")

    secret = values[2] if len(values) > 2 else ""
    if not secret:
        raise TotpLabError("totp_secret_missing")

    encoded_secret = quote(secret, safe="")
    encoded_hook = urlencode({"test_hook": config.totp_lab_test_hook}, quote_via=quote)
    return f"{base_url}{encoded_secret}?{encoded_hook}"
