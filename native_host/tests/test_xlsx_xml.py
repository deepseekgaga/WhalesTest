from pathlib import Path
import tempfile
import unittest

from native_host.cc_batch.xlsx_xml import read_numbered_workbook, read_workbook
from native_host.tests.xlsx_fixture import write_xlsx


class NumberedWorkbookTests(unittest.TestCase):
    def test_preserves_physical_row_numbers_and_legacy_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["header"], ["target"]], row_numbers=[1, 5])
            numbered = read_numbered_workbook(path)
            self.assertEqual(numbered["Sheet1"], [(1, ["header"]), (5, ["target"])])
            self.assertEqual(read_workbook(path)["Sheet1"], [["header"], ["target"]])

    def test_rejects_duplicate_or_invalid_physical_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["a"], ["b"]], row_numbers=[2, 2])
            with self.assertRaisesRegex(ValueError, "invalid_row_number"):
                read_numbered_workbook(path)
