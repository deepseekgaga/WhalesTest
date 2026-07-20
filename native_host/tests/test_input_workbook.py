from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from native_host.cc_batch.input_workbook import read_input_tasks
from native_host.tests.xlsx_fixture import write_xlsx


class InputWorkbookTests(unittest.TestCase):
    def test_reads_cc_address_in_order_and_retains_invalid_non_empty_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.xlsx"
            write_xlsx(path, [["名称", "CC地址"], ["first", "https://example.test/a"], ["blank", ""], ["bad", "ftp://bad"]])
            tasks = read_input_tasks(path, "CC地址")

        self.assertEqual([task.source_row for task in tasks], [2, 4])
        self.assertEqual(tasks[0].url, "https://example.test/a")
        self.assertIsNone(tasks[0].validation_error)
        self.assertEqual(tasks[1].validation_error, "invalid_url")

    def test_missing_url_column_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.xlsx"
            write_xlsx(path, [["名称"], ["only name"]])
            with self.assertRaises(ValueError):
                read_input_tasks(path, "CC地址")

    def test_malformed_workbook_xml_is_rejected_as_a_value_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.xlsx"
            with ZipFile(path, "w") as archive:
                archive.writestr("xl/workbook.xml", b"<workbook>")
            with self.assertRaises(ValueError):
                read_input_tasks(path, "CC地址")
