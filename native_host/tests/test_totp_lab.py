from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from native_host.cc_batch.config import Config
from native_host.cc_batch.totp_lab import TEST_HOOK_PLACEHOLDER, TotpLabError, build_totp_lab_challenge
from native_host.tests.xlsx_fixture import write_xlsx


class TotpLabTests(unittest.TestCase):
    def config(self, directory: str, workbook: Path, *, url: str = "http://totp-lab.local/", hook: str = "hook / 1") -> Config:
        base = Path(directory)
        return Config(
            input_excel=workbook,
            url_column="CC地址",
            txt_directory=base / "txt",
            output_excel=base / "summary.xlsx",
            download_timeout_seconds=180,
            field_mappings={"A": "", "B": "", "C": "", "D": ""},
            config_path=base / "config.json",
            totp_lab_url=url,
            totp_lab_test_hook=hook,
        )

    def test_builds_encoded_challenge_url_from_the_first_sheet_physical_row(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(
                workbook,
                [["header", "", ""], ["skip", "", ""], ["target", "", "A B/+测"]],
                row_numbers=[1, 3, 5],
            )
            url = build_totp_lab_challenge(self.config(directory, workbook), 5)
            self.assertEqual(url, "http://totp-lab.local/A%20B%2F%2B%E6%B5%8B?test_hook=hook%20%2F%201")

    def test_rejects_non_positive_or_boolean_excel_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["header", "", "secret"]])
            config = self.config(directory, workbook)
            with self.assertRaisesRegex(TotpLabError, "excel_row_invalid"):
                build_totp_lab_challenge(config, 0)
            with self.assertRaisesRegex(TotpLabError, "excel_row_invalid"):
                build_totp_lab_challenge(config, True)

    def test_rejects_missing_physical_row_and_empty_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["header", "", "secret"], ["target", "", ""]], row_numbers=[1, 5])
            config = self.config(directory, workbook)
            with self.assertRaisesRegex(TotpLabError, "account_row_not_found"):
                build_totp_lab_challenge(config, 2)
            with self.assertRaisesRegex(TotpLabError, "totp_secret_missing"):
                build_totp_lab_challenge(config, 5)

    def test_rejects_non_exact_base_url_and_placeholder_hook(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["header", "", "secret"]])
            with self.assertRaisesRegex(TotpLabError, "totp_lab_url_invalid"):
                build_totp_lab_challenge(self.config(directory, workbook, url="https://totp-lab.local/"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_lab_url_invalid"):
                build_totp_lab_challenge(self.config(directory, workbook, url="http://totp-lab.local/path"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_test_hook_not_configured"):
                build_totp_lab_challenge(self.config(directory, workbook, hook=""), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_test_hook_not_configured"):
                build_totp_lab_challenge(self.config(directory, workbook, hook=TEST_HOOK_PLACEHOLDER), 1)
