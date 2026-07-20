"""Chrome Native Messaging framing helpers."""

from __future__ import annotations

import json
import struct
from typing import BinaryIO, Any


MAX_MESSAGE_BYTES = 8 * 1024 * 1024


class ProtocolError(ValueError):
    """Raised when a Native Messaging frame is malformed or too large."""


def encode_message(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        raise ProtocolError("message_too_large")
    return struct.pack("<I", len(body)) + body


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message(stream: BinaryIO) -> dict[str, Any] | None:
    header = _read_exact(stream, 4)
    if not header:
        return None
    if len(header) != 4:
        raise ProtocolError("truncated_length_prefix")
    (size,) = struct.unpack("<I", header)
    if size > MAX_MESSAGE_BYTES:
        raise ProtocolError("message_too_large")
    body = _read_exact(stream, size)
    if len(body) != size:
        raise ProtocolError("truncated_message")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError("invalid_json") from exc
    if not isinstance(value, dict):
        raise ProtocolError("message_must_be_object")
    return value


def write_message(stream: BinaryIO, payload: dict[str, Any]) -> None:
    stream.write(encode_message(payload))
    stream.flush()
