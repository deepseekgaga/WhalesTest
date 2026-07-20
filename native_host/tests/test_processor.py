from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.cc_batch.config import Config
from native_host.cc_batch.output_workbook import HistoryWorkbookError
from native_host.cc_batch.processor import BatchProcessor, ProcessorFatal
from native_host.cc_batch.xlsx_xml import read_workbook
from native_host.tests.xlsx_fixture import write_xlsx


class ProcessorTests(unittest.TestCase):
    def make_zip(self, directory: Path, name: str, text: str) -> Path:
        path = directory / name
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            archive.writestr("data.json", b"{}")
            archive.writestr("data.txt", text.encode("utf-8"))
        return path

    def make_config(self, directory: Path, mapping: dict[str, str]) -> Config:
        input_path = directory / "source.xlsx"
        output_path = directory / "summary.xlsx"
        write_xlsx(input_path, [["CC地址"], ["ftp://bad"], ["https://example.test/ok"]])
        return Config(input_path, "CC地址", directory / "txt", output_path, 30, mapping, directory / "config.json")

    def test_invalid_url_gets_failure_row_and_valid_download_gets_success_row(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            zip_path = self.make_zip(config.txt_directory, "archive.zip", "Name: Alice\n")
            processor.process_result(plan.tasks[1], zip_path)
            rows = read_workbook(config.output_excel)["汇总"]
            self.assertEqual(rows[1][0], "0001_下载失败")
            self.assertEqual(rows[1][-1], "失败")
            self.assertEqual(rows[2], ["0002_archive", "Alice", "", "", "", "成功"])

    def test_missing_configured_field_marks_failure_but_keeps_txt(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Missing", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            zip_path = self.make_zip(config.txt_directory, "archive.zip", "Name: Alice\n")
            processor.process_result(plan.tasks[0], None)
            processor.process_result(plan.tasks[1], zip_path)
            rows = read_workbook(config.output_excel)["汇总"]
            self.assertEqual(rows[2][-1], "失败")
            self.assertTrue((config.txt_directory / "archive.txt").exists())

    def test_download_outside_configured_directory_is_not_opened_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            outside = self.make_zip(directory, "outside.zip", "Name: Alice\n")
            processor.process_result(plan.tasks[1], outside)
            self.assertTrue(outside.exists())
            rows = read_workbook(config.output_excel)["汇总"]
            self.assertEqual(rows[-1][-1], "失败")

    def test_prepare_batch_resumes_only_pending_tasks_with_original_sequences(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            state_path = directory / "state.json"
            first_processor = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            first_plan = first_processor.prepare_batch()
            first_processor.process_result(first_plan.tasks[0], None)
            resumed_processor = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            resumed_plan = resumed_processor.prepare_batch()
            self.assertEqual(resumed_plan.batch_id, first_plan.batch_id)
            self.assertEqual([task.sequence for task in resumed_plan.tasks], [first_plan.tasks[1].sequence])

    def test_resume_only_does_not_create_a_new_batch_when_history_covers_all_pending_tasks(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "", "B": "", "C": "", "D": ""})
            state_path = directory / "state.json"
            processor = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            original = processor.prepare_batch()
            for task in original.tasks:
                processor.history.append(sequence=task.sequence, zip_name=None, fields={}, success=False)
            resumed = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            resumed_plan = resumed.prepare_batch(resume_only=True)
            self.assertEqual(resumed_plan.batch_id, original.batch_id)
            self.assertEqual(resumed_plan.tasks, [])
            fresh_plan = resumed.prepare_batch()
            self.assertNotEqual(fresh_plan.batch_id, original.batch_id)
            self.assertEqual([task.sequence for task in fresh_plan.tasks], [3, 4])

    def test_duplicate_success_result_does_not_append_a_second_row(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            zip_path = self.make_zip(config.txt_directory, "archive.zip", "Name: Alice\n")
            task = plan.tasks[1]
            self.assertEqual(processor.process_result(task, zip_path), "success")
            self.assertEqual(processor.process_result(task, zip_path), "success")
            self.assertEqual(len(read_workbook(config.output_excel)["汇总"]), 3)

    def test_duplicate_invalid_url_result_does_not_append_a_second_row(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            task = processor.prepare_batch().tasks[0]
            self.assertEqual(processor.process_result(task, None), "failure")
            self.assertEqual(processor.process_result(task, None), "failure")
            self.assertEqual(len(read_workbook(config.output_excel)["汇总"]), 2)

    def test_history_failure_keeps_zip_for_idempotent_retry_without_duplicate_txt(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            zip_path = self.make_zip(config.txt_directory, "archive.zip", "Name: Alice\n")
            task = plan.tasks[1]
            with patch.object(processor.history, "append", side_effect=HistoryWorkbookError("history_append_failed")):
                with self.assertRaisesRegex(ProcessorFatal, "history_append_failed"):
                    processor.process_result(task, zip_path)
            self.assertTrue(zip_path.exists())
            self.assertEqual(processor.process_result(task, zip_path), "success")
            self.assertFalse(zip_path.exists())
            self.assertEqual(len(list(config.txt_directory.glob("archive*.txt"))), 1)

    def test_state_failure_reconciles_from_history_and_cleans_retained_zip(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            state_path = directory / "state.json"
            processor = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            zip_path = self.make_zip(config.txt_directory, "archive.zip", "Name: Alice\n")
            task = plan.tasks[1]
            with patch.object(processor.state, "update", side_effect=OSError("state locked")):
                with self.assertRaises(OSError):
                    processor.process_result(task, zip_path)
            self.assertTrue(zip_path.exists())
            recovered = BatchProcessor(config, state_path=state_path, log_path=directory / "events.jsonl")
            self.assertEqual(recovered.process_result(task, zip_path), "success")
            self.assertFalse(zip_path.exists())
            self.assertEqual(len(list(config.txt_directory.glob("archive*.txt"))), 1)

    def test_archive_failure_keeps_zip_until_failure_row_is_durable(self):
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            config = self.make_config(directory, {"A": "Name", "B": "", "C": "", "D": ""})
            processor = BatchProcessor(config, state_path=directory / "state.json", log_path=directory / "events.jsonl")
            plan = processor.prepare_batch()
            processor.process_result(plan.tasks[0], None)
            zip_path = config.txt_directory / "broken.zip"
            zip_path.write_bytes(b"not a zip")
            task = plan.tasks[1]
            with patch.object(processor.history, "append", side_effect=HistoryWorkbookError("history_append_failed")):
                with self.assertRaisesRegex(ProcessorFatal, "history_append_failed"):
                    processor.process_result(task, zip_path)
            self.assertTrue(zip_path.exists())
            self.assertEqual(processor.process_result(task, zip_path), "failure")
            self.assertFalse(zip_path.exists())
