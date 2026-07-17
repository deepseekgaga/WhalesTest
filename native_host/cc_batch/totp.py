"""Dependency-free RFC 6238 TOTP generation for the local Native Host."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timezone


class TotpError(ValueError):
    """Raised when a TOTP secret or clock value is invalid."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TotpResult:
    code: str
    expires_at: str


def generate_totp(secret: str, *, timestamp: int | float | None = None) -> TotpResult:
    normalized = secret.upper()
    if not normalized or not re.fullmatch(r"[A-Z2-7]+=*", normalized):
        raise TotpError("totp_secret_invalid")
    padded = normalized + "=" * ((8 - len(normalized) % 8) % 8)
    try:
        key = base64.b32decode(padded, casefold=False)
    except (binascii.Error, ValueError):
        raise TotpError("totp_secret_invalid") from None
    current = time.time() if timestamp is None else timestamp
    if not isinstance(current, (int, float)) or isinstance(current, bool) or current < 0:
        raise TotpError("totp_clock_error")
    counter = int(current // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    expires = (counter + 1) * 30
    expires_at = datetime.fromtimestamp(expires, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return TotpResult(f"{value % 1_000_000:06d}", expires_at)
