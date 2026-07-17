from pathlib import Path
import tempfile
import unittest

from native_host.cc_batch.account_totp import AccountTotpError, find_totp_secret
from native_host.tests.xlsx_fixture import write_xlsx


class AccountTotpTests(unittest.TestCase):
    def test_returns_column_c_from_the_unique_exact_ab_match(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", "pass-1", "JBSWY3DPEHPK3PXP"], ["bob", "pass-2", "KRUGS4ZANFZSAYJA"]])
            self.assertEqual(find_totp_secret(path, "bob", "pass-2"), "KRUGS4ZANFZSAYJA")

    def test_does_not_trim_or_normalize_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", " pass ", "JBSWY3DPEHPK3PXP"]])
            with self.assertRaisesRegex(AccountTotpError, "account_not_found"):
                find_totp_secret(path, "alice", "pass")

    def test_rejects_missing_duplicate_and_empty_secret_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", "pass", "A"], ["alice", "pass", "B"], ["empty", "pass", ""]])
            with self.assertRaisesRegex(AccountTotpError, "account_duplicate"):
                find_totp_secret(path, "alice", "pass")
            with self.assertRaisesRegex(AccountTotpError, "account_not_found"):
                find_totp_secret(path, "missing", "pass")
            with self.assertRaisesRegex(AccountTotpError, "totp_secret_missing"):
                find_totp_secret(path, "empty", "pass")

    def test_rejects_a_corrupt_xlsx_without_crashing_the_host(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            path.write_bytes(b"not-an-xlsx")
            with self.assertRaisesRegex(AccountTotpError, "input_excel_invalid"):
                find_totp_secret(path, "alice", "pass")
