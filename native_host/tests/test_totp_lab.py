from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.cc_batch.config import Config
from native_host.cc_batch.totp_lab import TEST_HOOK_PLACEHOLDER, TotpLabError, build_totp_lab_challenge
from native_host.tests.xlsx_fixture import write_xlsx


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def write_incomplete_xlsx_without_workbook_rels(path: Path) -> None:
    workbook_xml = (
        f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
        f'<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
        "</sheets></workbook>"
    )
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", workbook_xml)


def write_malformed_sheet_xlsx(path: Path) -> None:
    workbook_xml = (
        f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
        f'<sheet name="Sheet1" sheetId="1" r:id="rId1"/>'
        "</sheets></workbook>"
    )
    workbook_rels = (
        f'<Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet1.xml"/></Relationships>'
    )
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row>")


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
                build_totp_lab_challenge(self.config(directory, workbook, url="HTTP://totp-lab.local/"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_lab_url_invalid"):
                build_totp_lab_challenge(self.config(directory, workbook, url="https://totp-lab.local/"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_lab_url_invalid"):
                build_totp_lab_challenge(self.config(directory, workbook, url="http://totp-lab.local/path"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_lab_url_invalid"):
                build_totp_lab_challenge(self.config(directory, workbook, url="http://totp-lab.local/?debug=1"), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_test_hook_not_configured"):
                build_totp_lab_challenge(self.config(directory, workbook, hook=""), 1)
            with self.assertRaisesRegex(TotpLabError, "totp_test_hook_not_configured"):
                build_totp_lab_challenge(self.config(directory, workbook, hook=TEST_HOOK_PLACEHOLDER), 1)

    def test_rejects_incomplete_or_malformed_xlsx_without_leaking_parser_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            missing_rels = Path(directory) / "missing-rels.xlsx"
            write_incomplete_xlsx_without_workbook_rels(missing_rels)
            with self.assertRaisesRegex(TotpLabError, "input_excel_invalid"):
                build_totp_lab_challenge(self.config(directory, missing_rels), 1)

            malformed_sheet = Path(directory) / "malformed-sheet.xlsx"
            write_malformed_sheet_xlsx(malformed_sheet)
            with self.assertRaisesRegex(TotpLabError, "input_excel_invalid"):
                build_totp_lab_challenge(self.config(directory, malformed_sheet), 1)
