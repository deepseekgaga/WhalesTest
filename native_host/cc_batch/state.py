"""Atomic JSON state for resumable batch runs."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class StateStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)

    def start(self, batch_id: str, tasks: list[dict[str, Any]]) -> None:
        self.save({"batch_id": batch_id, "tasks": tasks})

    def update(self, sequence: int, result: str, error: str | None = None) -> None:
        state = self.load()
        for task in state.get("tasks", []):
            if task.get("sequence") == sequence:
                task["result"] = result
                if error:
                    task["error"] = error
                break
        self.save(state)
