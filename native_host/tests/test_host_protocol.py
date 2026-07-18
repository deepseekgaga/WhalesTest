from pathlib import Path
import tempfile
import unittest
import json
import io
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.host import HostApplication
from native_host.cc_batch.protocol import encode_message, read_message
from native_host.cc_batch.processor import BatchPlan, PlannedTask, ProcessorFatal
from native_host.tests.xlsx_fixture import write_xlsx


class HostProtocolTests(unittest.TestCase):
    def _write_totp_config(self, directory: Path, input_path: Path, extra: dict[str, object] | None = None) -> Path:
        config_path = directory / "config.json"
        payload = {
            "input_excel": str(input_path),
            "url_column": "CC地址",
            "txt_directory": str(directory / "txt"),
            "output_excel": str(directory / "summary.xlsx"),
            "field_mappings": {"A": "", "B": "", "C": "", "D": ""},
        }
        if extra:
            payload.update(extra)
        config_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return config_path

    def test_ping_returns_ok_without_touching_workbook(self):
        with tempfile.TemporaryDirectory() as directory:
            app = HostApplication(Path(directory) / "missing-config.json")
            self.assertEqual(app.dispatch({"command": "ping"}), {"ok": True, "command": "ping"})

    def test_unknown_command_returns_structured_error(self):
        with tempfile.TemporaryDirectory() as directory:
            app = HostApplication(Path(directory) / "missing-config.json")
            result = app.dispatch({"command": "unknown"})
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "unknown_command")

    def test_process_result_returns_persisted_status(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            input_path = directory / "source.xlsx"
            write_xlsx(input_path, [["CC地址"], ["https://example.test/ok"]])
            config_path = directory / "config.json"
            config_path.write_text(json.dumps({
                "input_excel": str(input_path),
                "url_column": "CC地址",
                "txt_directory": str(directory / "txt"),
                "output_excel": str(directory / "summary.xlsx"),
                "field_mappings": {"A": "Name", "B": "", "C": "", "D": ""},
            }, ensure_ascii=False), encoding="utf-8")
            zip_path = directory / "txt" / "archive.zip"
            zip_path.parent.mkdir(parents=True, exist_ok=True)
            with ZipFile(zip_path, "w", ZIP_DEFLATED) as archive:
                archive.writestr("data.json", b"{}")
                archive.writestr("data.txt", b"Name: Alice\n")
            app = HostApplication(config_path)
            prepared = app.dispatch({"command": "prepare_batch", "request_id": "r1"})
            result = app.dispatch({"command": "process_result", "sequence": prepared["tasks"][0]["sequence"], "download_path": str(zip_path)})
            self.assertEqual(result["status"], "success")

    def test_module_entrypoint_round_trips_native_message(self):
        completed = subprocess.run(
            [sys.executable, "-m", "native_host.host"],
            input=encode_message({"command": "ping", "request_id": "process-ping"}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=Path(__file__).resolve().parents[2],
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        response = read_message(io.BytesIO(completed.stdout))
        self.assertEqual(response, {"ok": True, "command": "ping", "request_id": "process-ping"})

    def test_processor_fatal_error_is_classified_for_extension_stop(self):
        class FatalProcessor:
            def process_result(self, *_args):
                raise ProcessorFatal("history_append_failed")

        app = HostApplication("unused.json")
        app.processor = FatalProcessor()
        app.plan = BatchPlan("batch", [PlannedTask(2, "https://example.test/a", 1)])
        result = app.dispatch({"command": "process_result", "sequence": 1, "download_path": "x.zip"})
        self.assertEqual(result, {"ok": False, "error": "history_append_failed", "fatal": True})

    def test_get_totp_returns_only_code_and_expiry_for_exact_credentials(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            input_path = directory / "accounts.xlsx"
            write_xlsx(input_path, [["alice", "pass", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]])
            app = HostApplication(self._write_totp_config(directory, input_path), totp_clock=lambda: 59)
            result = app.dispatch({"command": "get_totp", "username": "alice", "password": "pass"})
            self.assertEqual(result, {"ok": True, "code": "287082", "expires_at": "1970-01-01T00:01:00Z"})

    def test_get_totp_rejects_invalid_requests_and_never_echoes_secrets(self):
        app = HostApplication("unused.json")
        result = app.dispatch({"command": "get_totp", "username": 7, "password": "secret"})
        self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
        self.assertNotIn("secret", str(result))

    def test_get_totp_lab_challenge_returns_only_the_constructed_url(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            input_path = directory / "accounts.xlsx"
            write_xlsx(input_path, [["header", "", ""], ["alice", "pass", "JBSWY3D/测试"]])
            config_path = self._write_totp_config(
                directory,
                input_path,
                {"totp_lab_url": "http://totp-lab.local/", "totp_lab_test_hook": "lab-hook"},
            )
            result = HostApplication(config_path).dispatch({"command": "get_totp_lab_challenge", "excel_row": 2})
            self.assertEqual(
                result,
                {
                    "ok": True,
                    "challenge_url": "http://totp-lab.local/JBSWY3D%2F%E6%B5%8B%E8%AF%95?test_hook=lab-hook",
                },
            )

    def test_get_totp_lab_challenge_rejects_invalid_requests_without_echoing_values(self):
        result = HostApplication("unused.json").dispatch({
            "command": "get_totp_lab_challenge",
            "excel_row": "2",
            "secret": "sensitive",
        })
        self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
        self.assertNotIn("sensitive", str(result))
