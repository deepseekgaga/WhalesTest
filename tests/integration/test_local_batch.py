from pathlib import Path
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.cc_batch.config import Config
from native_host.cc_batch.processor import BatchProcessor
from native_host.cc_batch.xlsx_xml import read_workbook
from native_host.tests.xlsx_fixture import write_xlsx


class FixtureHandler(BaseHTTPRequestHandler):
    payloads = {}

    def do_GET(self):
        if self.path not in self.payloads:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.end_headers()
        self.wfile.write(self.payloads[self.path])

    def log_message(self, *_args):
        return


def make_zip(text: str) -> bytes:
    import io

    buffer = io.BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.writestr("data.json", b"{}")
        archive.writestr("data.txt", text.encode("utf-8"))
    return buffer.getvalue()


class LocalBatchIntegrationTests(unittest.TestCase):
    def test_local_http_downloads_produce_ordered_six_column_history(self):
        FixtureHandler.payloads = {"/ok.zip": make_zip("Name: Alice\n"), "/missing.zip": make_zip("City: Shanghai\n")}
        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        base_url = f"http://127.0.0.1:{server.server_port}"
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            input_path = directory / "source.xlsx"
            write_xlsx(input_path, [["CC地址"], [f"{base_url}/ok.zip"], [f"{base_url}/missing.zip"], [f"{base_url}/404.zip"]])
            config = Config(input_path, "CC地址", directory / "txt", directory / "summary.xlsx", 30, {"A": "Name", "B": "", "C": "", "D": ""}, directory / "config.json")
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            for task in plan.tasks:
                if task.url.endswith("404.zip"):
                    processor.process_result(task, None)
                    continue
                zip_path = config.txt_directory / f"{task.sequence}.zip"
                try:
                    with urlopen(task.url, timeout=5) as response:
                        zip_path.write_bytes(response.read())
                except HTTPError:
                    processor.process_result(task, None)
                else:
                    processor.process_result(task, zip_path)
            rows = read_workbook(config.output_excel)["汇总"]
            self.assertEqual(rows[0], ["编号_文件名", "A", "B", "C", "D", "是否执行成功"])
            self.assertEqual([row[-1] for row in rows[1:]], ["成功", "失败", "失败"])
            self.assertEqual(sorted(path.suffix for path in config.txt_directory.iterdir()), [".txt", ".txt"])
            self.assertNotIn("Alice", config.log_path.read_text(encoding="utf-8") if hasattr(config, "log_path") else (directory / "events.jsonl").read_text(encoding="utf-8"))
