from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_DEFLATED, ZipFile

from native_host.cc_batch.config import Config
from native_host.cc_batch.sms_lab import SMS_LAB_ORIGIN, SmsLabChallenge, SmsLabError, build_sms_lab_challenge
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


class SmsLabTests(unittest.TestCase):
    def config(self, directory: str, workbook: Path) -> Config:
        base = Path(directory)
        return Config(
            input_excel=workbook,
            url_column="CC",
            txt_directory=base / "txt",
            output_excel=base / "summary.xlsx",
            download_timeout_seconds=180,
            field_mappings={"A": "", "B": "", "C": "", "D": ""},
            config_path=base / "config.json",
        )

    def test_builds_challenge_from_exact_first_sheet_physical_row(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(
                workbook,
                [
                    ["header", "", "", "Phone", "SMS URL"],
                    ["skip", "", "", "+ignored", "http://sms-lab.local/ignored"],
                    ["target", "", "", "  +1 (555) 0100  ", "http://sms-lab.local/challenge?id=abc%201"],
                ],
                row_numbers=[1, 3, 5],
            )

            challenge = build_sms_lab_challenge(self.config(directory, workbook), 5)

            self.assertEqual(challenge, SmsLabChallenge("  +1 (555) 0100  ", "http://sms-lab.local/challenge?id=abc%201"))
            self.assertEqual(challenge.phone, "  +1 (555) 0100  ")
            self.assertEqual(challenge.challenge_url, "http://sms-lab.local/challenge?id=abc%201")

    def test_accepts_local_http_urls_and_preserves_path_and_query(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["header", "", "", "phone", "url"], ["", "", "", "1", f"{SMS_LAB_ORIGIN}/a/b?x=1&y=%2F"]])

            challenge = build_sms_lab_challenge(self.config(directory, workbook), 2)

            self.assertEqual(challenge.challenge_url, f"{SMS_LAB_ORIGIN}/a/b?x=1&y=%2F")

    def test_rejects_header_row_non_integer_boolean_and_low_excel_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["header", "", "", "phone", "url"], ["", "", "", "1", f"{SMS_LAB_ORIGIN}/"]])
            config = self.config(directory, workbook)

            for row in (1, 0, True, 2.0, "2"):
                with self.subTest(row=row):
                    with self.assertRaisesRegex(SmsLabError, "excel_row_invalid"):
                        build_sms_lab_challenge(config, row)  # type: ignore[arg-type]

    def test_rejects_missing_physical_row_phone_and_url(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(
                workbook,
                [
                    ["header", "", "", "phone", "url"],
                    ["no phone", "", "", "", f"{SMS_LAB_ORIGIN}/ok"],
                    ["no url", "", "", "555", ""],
                    ["too short", "", "", "555"],
                ],
                row_numbers=[1, 4, 6, 8],
            )
            config = self.config(directory, workbook)

            with self.assertRaisesRegex(SmsLabError, "account_row_not_found"):
                build_sms_lab_challenge(config, 2)
            with self.assertRaisesRegex(SmsLabError, "sms_phone_missing"):
                build_sms_lab_challenge(config, 4)
            with self.assertRaisesRegex(SmsLabError, "sms_url_missing"):
                build_sms_lab_challenge(config, 6)
            with self.assertRaisesRegex(SmsLabError, "sms_url_missing"):
                build_sms_lab_challenge(config, 8)

    def test_rejects_invalid_sms_urls(self):
        rejects = [
            "https://sms-lab.local/path",
            "http://example.com/path",
            "http://evil.sms-lab.local/path",
            "http://sms-lab.local:80/path",
            "http://user@sms-lab.local/path",
            "http://sms-lab.local/path#fragment",
            "http:///path",
            "not a url",
        ]
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            config = self.config(directory, workbook)
            for url in rejects:
                with self.subTest(url=url):
                    write_xlsx(workbook, [["header", "", "", "phone", "url"], ["", "", "", "555", url]])
                    with self.assertRaisesRegex(SmsLabError, "sms_url_invalid"):
                        build_sms_lab_challenge(config, 2)

    def test_rejects_non_string_sms_url(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            config = self.config(directory, workbook)
            with patch("native_host.cc_batch.sms_lab.read_numbered_workbook", return_value={"Sheet1": [(2, ["", "", "", "555", 123])]}):
                with self.assertRaisesRegex(SmsLabError, "sms_url_invalid"):
                    build_sms_lab_challenge(config, 2)

    def test_maps_missing_invalid_malformed_and_incomplete_workbooks(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.xlsx"
            with self.assertRaisesRegex(SmsLabError, "input_excel_missing"):
                build_sms_lab_challenge(self.config(directory, missing), 2)

            invalid = Path(directory) / "invalid.xlsx"
            invalid.write_text("not xlsx", encoding="utf-8")
            with self.assertRaisesRegex(SmsLabError, "input_excel_invalid"):
                build_sms_lab_challenge(self.config(directory, invalid), 2)

            missing_rels = Path(directory) / "missing-rels.xlsx"
            write_incomplete_xlsx_without_workbook_rels(missing_rels)
            with self.assertRaisesRegex(SmsLabError, "input_excel_invalid"):
                build_sms_lab_challenge(self.config(directory, missing_rels), 2)

            malformed_sheet = Path(directory) / "malformed-sheet.xlsx"
            write_malformed_sheet_xlsx(malformed_sheet)
            with self.assertRaisesRegex(SmsLabError, "input_excel_invalid"):
                build_sms_lab_challenge(self.config(directory, malformed_sheet), 2)
