from pathlib import Path
import tempfile
import unittest

from native_host.cc_batch.workflow_credentials import (
    WorkflowCredentialsError,
    read_workflow_credentials,
)
from native_host.tests.xlsx_fixture import write_xlsx


class WorkflowCredentialsTests(unittest.TestCase):
    def test_reads_username_and_password_from_exact_physical_row(self):
        with tempfile.TemporaryDirectory() as directory_name:
            path = Path(directory_name) / "accounts.xlsx"
            write_xlsx(
                path,
                [["header-a", "header-b"], ["alice", "pass-1"], ["bob", "pass-2"]],
                row_numbers=[1, 3, 8],
            )

            credentials = read_workflow_credentials(path, 8)

            self.assertEqual(credentials.username, "bob")
            self.assertEqual(credentials.password, "pass-2")

    def test_rejects_invalid_excel_rows(self):
        with tempfile.TemporaryDirectory() as directory_name:
            path = Path(directory_name) / "accounts.xlsx"
            write_xlsx(path, [["header-a", "header-b"], ["alice", "pass"]])

            for excel_row in (1, 0, True, 2.0, "2"):
                with self.subTest(excel_row=excel_row):
                    with self.assertRaises(WorkflowCredentialsError) as caught:
                        read_workflow_credentials(path, excel_row)
                    self.assertEqual(caught.exception.code, "excel_row_invalid")
                    self.assertEqual(str(caught.exception), "excel_row_invalid")

    def test_rejects_blank_credentials_and_missing_physical_rows(self):
        with tempfile.TemporaryDirectory() as directory_name:
            path = Path(directory_name) / "accounts.xlsx"
            write_xlsx(
                path,
                [["header-a", "header-b"], ["", "pass"], ["alice", ""], ["bob", "pass-2"]],
                row_numbers=[1, 2, 4, 8],
            )

            for excel_row in (2, 4):
                with self.subTest(excel_row=excel_row):
                    with self.assertRaises(WorkflowCredentialsError) as caught:
                        read_workflow_credentials(path, excel_row)
                    self.assertEqual(caught.exception.code, "credentials_invalid")

            with self.assertRaises(WorkflowCredentialsError) as caught:
                read_workflow_credentials(path, 3)
            self.assertEqual(caught.exception.code, "excel_exhausted")


if __name__ == "__main__":
    unittest.main()
