"""Fixed local configuration for the batch processor."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ConfigError(ValueError):
    """Raised when the fixed configuration is invalid."""


MAX_CONTINUATION_LINES = 100


@dataclass(frozen=True)
class Config:
    input_excel: Path
    url_column: str
    txt_directory: Path
    output_excel: Path
    download_timeout_seconds: int
    field_mappings: dict[str, str]
    config_path: Path
    download_directory: Path | None = None
    field_continuation_lines: dict[str, int] | None = None
    totp_lab_url: str = ""
    totp_lab_test_hook: str = ""


def _required_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"missing_config:{key}")
    return value.strip()


def _optional_string(payload: dict[str, Any], key: str, *, error_code: str) -> str:
    value = payload.get(key, "")
    if value == "":
        return ""
    if not isinstance(value, str):
        raise ConfigError(error_code)
    return value.strip()


def load_config(path: str | Path) -> Config:
    config_path = Path(path).expanduser().resolve()
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError("config_unreadable") from exc
    if not isinstance(payload, dict):
        raise ConfigError("config_must_be_object")

    mapping = payload.get("field_mappings", {})
    if (
        not isinstance(mapping, dict)
        or any(key not in {"A", "B", "C", "D"} for key in mapping)
        or any(not isinstance(value, str) for value in mapping.values())
    ):
        raise ConfigError("invalid_field_mappings")
    normalized_mapping = {
        key: (value.strip() if isinstance(value, str) else "")
        for key, value in ({"A": "", "B": "", "C": "", "D": ""} | mapping).items()
    }
    timeout = payload.get("download_timeout_seconds", 180)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
        raise ConfigError("invalid_download_timeout")
    continuation = payload.get("field_continuation_lines", {})
    if not isinstance(continuation, dict) or any(key not in {"A", "B", "C", "D"} for key in continuation):
        raise ConfigError("invalid_field_continuation_lines")
    normalized_continuation = {"A": 0, "B": 0, "C": 0, "D": 0}
    for key, value in continuation.items():
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_CONTINUATION_LINES:
            raise ConfigError("invalid_field_continuation_lines")
        normalized_continuation[key] = value

    base = config_path.parent

    def resolve(value: str) -> Path:
        candidate = Path(value).expanduser()
        return candidate if candidate.is_absolute() else (base / candidate).resolve()

    txt_directory = resolve(_required_string(payload, "txt_directory"))
    download_directory_value = payload.get("download_directory")
    if download_directory_value is not None and (not isinstance(download_directory_value, str) or not download_directory_value.strip()):
        raise ConfigError("invalid_download_directory")
    return Config(
        input_excel=resolve(_required_string(payload, "input_excel")),
        url_column=_required_string(payload, "url_column"),
        txt_directory=txt_directory,
        output_excel=resolve(_required_string(payload, "output_excel")),
        download_timeout_seconds=timeout,
        field_mappings=normalized_mapping,
        config_path=config_path,
        download_directory=resolve(download_directory_value) if download_directory_value else txt_directory,
        field_continuation_lines=normalized_continuation,
        totp_lab_url=_optional_string(payload, "totp_lab_url", error_code="invalid_totp_lab_url"),
        totp_lab_test_hook=_optional_string(payload, "totp_lab_test_hook", error_code="invalid_totp_lab_test_hook"),
    )
