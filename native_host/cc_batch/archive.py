"""Safe ZIP inspection and TXT-only retention."""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from zipfile import BadZipFile, ZipFile

from .text_fields import decode_text


class ArchiveError(ValueError):
    """Raised when a downloaded ZIP cannot produce exactly one safe TXT."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ExtractedTxt:
    zip_name: str
    txt_path: Path
    text: str
    source_path: Path


def _safe_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return False
    return ".." not in PurePosixPath(normalized).parts


def _unique_target(directory: Path, stem: str) -> Path:
    candidate = directory / f"{stem}.txt"
    counter = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{counter}.txt"
        counter += 1
    return candidate


def _existing_or_unique_target(directory: Path, stem: str, text: str) -> tuple[Path, bool]:
    candidate = directory / f"{stem}.txt"
    if candidate.exists():
        try:
            if candidate.read_text(encoding="utf-8") == text:
                return candidate, True
        except OSError:
            pass
    return _unique_target(directory, stem), False


def extract_single_txt(
    zip_path: str | Path,
    target_directory: str | Path,
    *,
    delete_source_on_success: bool = True,
    delete_source_on_failure: bool = True,
) -> ExtractedTxt:
    source = Path(zip_path)
    target_directory = Path(target_directory)
    extracted_successfully = False
    try:
        try:
            target_directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ArchiveError("txt_save_failed") from exc
        try:
            archive = ZipFile(source, "r")
        except (OSError, BadZipFile) as exc:
            raise ArchiveError("invalid_zip") from exc
        with archive:
            members = [info for info in archive.infolist() if not info.is_dir()]
            if any(not _safe_member(info.filename) for info in members):
                raise ArchiveError("unsafe_zip_member")
            txt_members = [info for info in members if info.filename.lower().endswith(".txt")]
            if len(txt_members) != 1:
                raise ArchiveError("txt_count_invalid")
            info = txt_members[0]
            try:
                payload = archive.read(info)
                text = decode_text(payload)
            except (OSError, KeyError, ValueError) as exc:
                if isinstance(exc, ValueError) and str(exc) == "txt_decode_failed":
                    raise ArchiveError("txt_decode_failed") from exc
                raise ArchiveError("txt_read_failed") from exc
        target, already_saved = _existing_or_unique_target(target_directory, source.stem, text)
        temporary_name: str | None = None
        try:
            if already_saved:
                extracted_successfully = True
                return ExtractedTxt(source.name, target, text, source)
            try:
                with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=target_directory, delete=False) as handle:
                    temporary_name = handle.name
                    handle.write(text)
                os.replace(temporary_name, target)
            except OSError as exc:
                raise ArchiveError("txt_save_failed") from exc
        finally:
            if temporary_name:
                Path(temporary_name).unlink(missing_ok=True)
        extracted_successfully = True
        return ExtractedTxt(source.name, target, text, source)
    finally:
        if (extracted_successfully and delete_source_on_success) or (not extracted_successfully and delete_source_on_failure):
            source.unlink(missing_ok=True)
