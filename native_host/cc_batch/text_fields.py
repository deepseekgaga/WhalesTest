"""Decode TXT payloads and extract exact configured line-name values."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FieldExtraction:
    values: dict[str, str]
    missing_fields: list[str]


def decode_text(payload: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError("txt_decode_failed")


def extract_fields(
    text: str,
    mappings: dict[str, str],
    *,
    continuation_lines: dict[str, int] | None = None,
) -> FieldExtraction:
    normalized = {
        column: (name.strip().casefold() if isinstance(name, str) else "")
        for column, name in mappings.items()
    }
    values = {column: "" for column in ("A", "B", "C", "D")}
    found: set[str] = set()
    lines = text.splitlines()
    continuation_lines = continuation_lines or {}
    for line_index, line in enumerate(lines):
        delimiter_positions = [(line.find(delimiter), delimiter) for delimiter in (":", "：", "=", "\t") if line.find(delimiter) >= 0]
        if not delimiter_positions:
            continue
        _, delimiter = min(delimiter_positions, key=lambda item: item[0])
        key, value = line.split(delimiter, 1)
        key = key.strip().casefold()
        for column, expected in normalized.items():
            if expected and column not in found and key == expected:
                pieces = [value.strip()]
                count = continuation_lines.get(column, 0)
                pieces.extend(lines[line_index + offset].strip() for offset in range(1, count + 1) if line_index + offset < len(lines))
                values[column] = "\n".join(piece for piece in pieces if piece)
                found.add(column)
    missing = [column for column, expected in normalized.items() if expected and column not in found]
    return FieldExtraction(values, missing)
