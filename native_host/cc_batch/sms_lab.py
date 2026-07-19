"""Build fixed local SMS Lab challenges from physical workbook rows."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from .config import Config
from .xlsx_xml import XlsxError, read_numbered_workbook


SMS_LAB_ORIGIN = "http://sms-lab.local"


class SmsLabError(ValueError):
    """Raised when the local SMS Lab challenge cannot be built."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SmsLabChallenge:
    phone: str
    challenge_url: str


def _load_first_sheet_rows(path: Path) -> list[tuple[int, list[str]]]:
    try:
        workbook = read_numbered_workbook(path)
    except FileNotFoundError as exc:
        raise SmsLabError("input_excel_missing") from exc
    except (OSError, BadZipFile, KeyError, ParseError, XlsxError, ValueError) as exc:
        raise SmsLabError("input_excel_invalid") from exc
    return next(iter(workbook.values()), [])


def _validate_sms_url(value: object) -> str:
    if not isinstance(value, str):
        raise SmsLabError("sms_url_invalid")
    if _has_unsafe_url_character(value):
        raise SmsLabError("sms_url_invalid")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as exc:
        raise SmsLabError("sms_url_invalid") from exc
    if (
        parsed.scheme != "http"
        or parsed.netloc != "sms-lab.local"
        or parsed.hostname != "sms-lab.local"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise SmsLabError("sms_url_invalid")
    canonical_url = urlunsplit(parsed)
    if _has_unsafe_url_character(canonical_url):
        raise SmsLabError("sms_url_invalid")
    return canonical_url


def _has_unsafe_url_character(value: str) -> bool:
    return any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F for character in value)


def build_sms_lab_challenge(config: Config, excel_row: int, *, workbook_path: str | Path | None = None) -> SmsLabChallenge:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
        raise SmsLabError("excel_row_invalid")

    rows = _load_first_sheet_rows(Path(workbook_path or config.input_excel))
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise SmsLabError("account_row_not_found")

    phone = values[3] if len(values) > 3 else ""
    if not phone:
        raise SmsLabError("sms_phone_missing")

    challenge_url = values[4] if len(values) > 4 else ""
    if not challenge_url:
        raise SmsLabError("sms_url_missing")

    return SmsLabChallenge(phone=phone, challenge_url=_validate_sms_url(challenge_url))
