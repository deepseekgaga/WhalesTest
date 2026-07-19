"""Chrome Native Messaging entrypoint for the CC batch processor."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

from native_host.cc_batch.account_totp import AccountTotpError, find_totp_secret
from native_host.cc_batch.config import ConfigError, load_config
from native_host.cc_batch.processor import BatchPlan, BatchProcessor, PlannedTask, ProcessorFatal
from native_host.cc_batch.protocol import ProtocolError, read_message, write_message
from native_host.cc_batch.sms_lab import SmsLabError, build_sms_lab_challenge
from native_host.cc_batch.totp import TotpError, generate_totp
from native_host.cc_batch.totp_lab import TotpLabError, build_totp_lab_challenge
from native_host.cc_batch.workflow_credentials import WorkflowCredentialsError, read_workflow_credentials


class HostApplication:
    def __init__(self, config_path: str | Path, *, totp_clock=time.time):
        self.config_path = Path(config_path)
        self.totp_clock = totp_clock
        self.processor: BatchProcessor | None = None
        self.plan: BatchPlan | None = None

    def _get_processor(self) -> BatchProcessor:
        if self.processor is None:
            config = load_config(self.config_path)
            runtime = self.config_path.parent / "runtime"
            self.processor = BatchProcessor(config, state_path=runtime / "state.json", log_path=runtime / "events.jsonl")
        return self.processor

    def _get_totp(self, message: dict[str, Any]) -> dict[str, Any]:
        username = message.get("username")
        password = message.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            return {"ok": False, "error": "request_invalid", "fatal": False}
        try:
            config = load_config(self.config_path)
            secret = find_totp_secret(config.input_excel, username, password)
            result = generate_totp(secret, timestamp=self.totp_clock())
            return {"ok": True, "code": result.code, "expires_at": result.expires_at}
        except (AccountTotpError, TotpError) as exc:
            return {"ok": False, "error": exc.code, "fatal": False}
        except ConfigError:
            return {"ok": False, "error": "input_excel_invalid", "fatal": False}

    def _get_totp_lab_challenge(self, message: dict[str, Any]) -> dict[str, Any]:
        if set(message) - {"command", "excel_row", "request_id"}:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        excel_row = message.get("excel_row")
        if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        try:
            config = load_config(self.config_path)
            return {"ok": True, "challenge_url": build_totp_lab_challenge(config, excel_row, workbook_path=config.workflow_excel)}
        except TotpLabError as exc:
            return {"ok": False, "error": exc.code, "fatal": False}
        except ConfigError:
            return {"ok": False, "error": "input_excel_invalid", "fatal": False}

    def _get_sms_lab_challenge(self, message: dict[str, Any]) -> dict[str, Any]:
        if set(message) - {"command", "excel_row", "request_id"}:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        excel_row = message.get("excel_row")
        if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        try:
            config = load_config(self.config_path)
            challenge = build_sms_lab_challenge(config, excel_row, workbook_path=config.workflow_excel)
            return {"ok": True, "phone": challenge.phone, "challenge_url": challenge.challenge_url}
        except SmsLabError as exc:
            return {"ok": False, "error": exc.code, "fatal": False}
        except ConfigError:
            return {"ok": False, "error": "input_excel_invalid", "fatal": False}

    def _get_workflow_credentials(self, message: dict[str, Any]) -> dict[str, Any]:
        if set(message) - {"command", "excel_row", "request_id"}:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        excel_row = message.get("excel_row")
        if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
            return {"ok": False, "error": "request_invalid", "fatal": False}
        try:
            config = load_config(self.config_path)
            credentials = read_workflow_credentials(config.workflow_excel, excel_row)
            return {"ok": True, "username": credentials.username, "password": credentials.password}
        except WorkflowCredentialsError as exc:
            return {"ok": False, "error": exc.code, "fatal": False}
        except ConfigError:
            return {"ok": False, "error": "input_excel_invalid", "fatal": False}

    def dispatch(self, message: dict[str, Any]) -> dict[str, Any]:
        command = message.get("command")
        if command == "ping":
            return {"ok": True, "command": "ping"}
        if command == "get_totp":
            return self._get_totp(message)
        if command == "get_totp_lab_challenge":
            return self._get_totp_lab_challenge(message)
        if command == "get_sms_lab_challenge":
            return self._get_sms_lab_challenge(message)
        if command == "get_workflow_credentials":
            return self._get_workflow_credentials(message)
        if command not in {"preflight", "prepare_batch", "process_result", "get_state", "finish_batch"}:
            return {"ok": False, "error": "unknown_command"}
        try:
            processor = self._get_processor()
            if command == "preflight":
                processor.preflight()
                return {"ok": True}
            if command == "prepare_batch":
                self.plan = processor.prepare_batch()
                return {
                    "ok": True,
                    "batch_id": self.plan.batch_id,
                    "tasks": [
                        {
                            "source_row": task.source_row,
                            "url": task.url,
                            "sequence": task.sequence,
                            "validation_error": task.validation_error,
                        }
                        for task in self.plan.tasks
                    ],
                }
            if command == "process_result":
                if self.plan is None:
                    return {"ok": False, "error": "batch_not_prepared"}
                sequence = message.get("sequence")
                task = next((item for item in self.plan.tasks if item.sequence == sequence), None)
                if task is None:
                    return {"ok": False, "error": "unknown_sequence"}
                status = processor.process_result(task, message.get("download_path"))
                record = next(
                    (item for item in processor.state.load().get("tasks", []) if item.get("sequence") == sequence),
                    {},
                )
                return {"ok": True, "sequence": sequence, "status": status, "error": record.get("error")}
            if command == "get_state":
                return {"ok": True, "state": processor.state.load()}
            return {"ok": True, "batch_id": self.plan.batch_id if self.plan else None}
        except (ProcessorFatal, OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc), "fatal": True}


def main() -> int:
    application = HostApplication(Path(__file__).with_name("config.json"))
    while True:
        try:
            message = read_message(sys.stdin.buffer)
        except ProtocolError as exc:
            print(f"protocol_error:{exc}", file=sys.stderr, flush=True)
            return 2
        if message is None:
            return 0
        response = application.dispatch(message)
        if "request_id" in message:
            response["request_id"] = message["request_id"]
        write_message(sys.stdout.buffer, response)


if __name__ == "__main__":
    raise SystemExit(main())
