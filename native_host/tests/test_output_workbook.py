from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from native_host.cc_batch.output_workbook import HistoryWorkbook, HistoryWorkbookError
from native_host.cc_batch.xlsx_xml import MAIN, append_row, write_minimal_workbook
from native_host.tests.xlsx_fixture import write_xlsx


class OutputWorkbookTests(unittest.TestCase):
    def test_creates_history_headers_and_appends_success_row(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            history = HistoryWorkbook(path)
            self.assertEqual(history.next_sequence(), 1)
            history.append(sequence=1, zip_name="archive.zip", fields={"A": "one", "B": "two", "C": "", "D": ""}, success=True)
            reopened = HistoryWorkbook(path)
            self.assertEqual(reopened.next_sequence(), 2)
            self.assertEqual(reopened.rows()[-1], ["0001_archive", "one", "two", "", "", "成功"])

    def test_existing_incompatible_header_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            write_xlsx(path, [["wrong", "A", "B", "C", "D", "是否执行成功"]], sheet_name="汇总")
            with self.assertRaises(HistoryWorkbookError):
                HistoryWorkbook(path).preflight()

    def test_malformed_workbook_xml_is_rejected_without_crashing_the_host(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            with ZipFile(path, "w") as archive:
                archive.writestr("xl/workbook.xml", b"<workbook>")
            with self.assertRaisesRegex(HistoryWorkbookError, "history_unreadable"):
                HistoryWorkbook(path).preflight()

    def test_incomplete_workbook_package_is_rejected_without_crashing_the_host(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            with ZipFile(path, "w"):
                pass
            with self.assertRaisesRegex(HistoryWorkbookError, "history_unreadable"):
                HistoryWorkbook(path).preflight()

    def test_failure_rows_keep_known_or_unknown_filename_and_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            history = HistoryWorkbook(path)
            history.append(sequence=1, zip_name="bad.zip", fields={}, success=False)
            history.append(sequence=2, zip_name=None, fields={"A": "partial"}, success=False)
            self.assertEqual(history.rows()[-2:], [["0001_bad", "", "", "", "", "失败"], ["0002_下载失败", "partial", "", "", "", "失败"]])

    def test_next_sequence_uses_largest_numeric_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            write_xlsx(path, [["编号_文件名", "A", "B", "C", "D", "是否执行成功"], ["0009_old", "", "", "", "", "成功"], ["10000_new", "", "", "", "", "失败"]], sheet_name="汇总")
            self.assertEqual(HistoryWorkbook(path).next_sequence(), 10001)

    def test_new_history_workbook_sets_readable_column_widths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            HistoryWorkbook(path).append(sequence=1, zip_name="archive.zip", fields={}, success=True)
            with ZipFile(path) as archive:
                root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            columns = root.find(f"{{{MAIN}}}cols")
            self.assertIsNotNone(columns)
            widths = [float(column.attrib["width"]) for column in columns]
            self.assertGreaterEqual(widths[0], 24)
            self.assertGreaterEqual(widths[-1], 14)

    def test_existing_completely_empty_workbook_is_initialized_as_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            write_xlsx(path, [], sheet_name="Sheet1")
            history = HistoryWorkbook(path)
            history.preflight()
            history.append(sequence=1, zip_name="archive.zip", fields={}, success=True)
            self.assertEqual(history.rows()[0], ["编号_文件名", "A", "B", "C", "D", "是否执行成功"])

    def test_existing_completely_empty_workbook_must_still_be_writable(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            write_xlsx(path, [], sheet_name="Sheet1")
            original_open = Path.open

            def locked_open(candidate, mode="r", *args, **kwargs):
                if candidate == path and mode == "a+b":
                    raise OSError("locked")
                return original_open(candidate, mode, *args, **kwargs)

            with patch.object(Path, "open", new=locked_open):
                with self.assertRaisesRegex(HistoryWorkbookError, "history_not_writable"):
                    HistoryWorkbook(path).preflight()

    def test_empty_workbook_initialization_failure_is_wrapped(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            write_xlsx(path, [], sheet_name="Sheet1")
            with patch("native_host.cc_batch.output_workbook.write_minimal_workbook", side_effect=OSError("locked")):
                with self.assertRaisesRegex(HistoryWorkbookError, "history_append_failed"):
                    HistoryWorkbook(path).append(sequence=1, zip_name="archive.zip", fields={}, success=True)

    def test_append_row_uses_a_unique_temp_file_and_cleans_it_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            HistoryWorkbook(path).append(sequence=1, zip_name="archive.zip", fields={}, success=True)
            temp_paths: list[Path] = []

            original_named_temp = tempfile.NamedTemporaryFile

            def named_temp(*args, **kwargs):
                handle = original_named_temp(*args, **kwargs)
                temp_paths.append(Path(handle.name))
                return handle

            def fail_replace(src, dst):
                with ZipFile(src) as archive:
                    sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
                self.assertIn("0002_archive", sheet)
                raise OSError("locked")

            with patch("native_host.cc_batch.xlsx_xml.os.replace", side_effect=fail_replace):
                with patch("native_host.cc_batch.xlsx_xml.tempfile.NamedTemporaryFile", side_effect=named_temp):
                    with self.assertRaises(OSError):
                        append_row(path, "汇总", ["0002_archive", "", "", "", "", "成功"])

            self.assertEqual(len(temp_paths), 1)
            self.assertFalse(temp_paths[0].exists())
            self.assertEqual(path.read_bytes()[:4], b"PK\x03\x04")

    def test_write_minimal_workbook_uses_a_temp_file_and_cleans_it_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "summary.xlsx"
            path.write_bytes(b"original")
            temp_paths: list[Path] = []

            original_named_temp = tempfile.NamedTemporaryFile

            def named_temp(*args, **kwargs):
                handle = original_named_temp(*args, **kwargs)
                temp_paths.append(Path(handle.name))
                return handle

            def fail_replace(src, dst):
                with ZipFile(src) as archive:
                    sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
                self.assertIn("secret", sheet)
                raise OSError("locked")

            with patch("native_host.cc_batch.xlsx_xml.os.replace", side_effect=fail_replace):
                with patch("native_host.cc_batch.xlsx_xml.tempfile.NamedTemporaryFile", side_effect=named_temp):
                    with self.assertRaises(OSError):
                        write_minimal_workbook(path, [["secret"]], sheet_name="汇总")

            self.assertEqual(len(temp_paths), 1)
            self.assertFalse(temp_paths[0].exists())
            self.assertEqual(path.read_bytes(), b"original")
