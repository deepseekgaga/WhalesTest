"""JSON-lines event logging without TXT contents."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


class EventLogger:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def event(self, **fields: object) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {"timestamp": datetime.now(timezone.utc).isoformat(), **fields}
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
