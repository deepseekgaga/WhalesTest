import json
import tempfile
import unittest
from pathlib import Path

from native_host.cc_batch.config import ConfigError, load_config


class ConfigTests(unittest.TestCase):
    def write_config(self, payload):
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
        with handle:
            json.dump(payload, handle, ensure_ascii=False)
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return handle.name

    def test_loads_fixed_paths_and_empty_field_defaults(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": "", "B": "", "C": "", "D": ""},
                "field_continuation_lines": {"D": 1},
                "totp_lab_url": "https://totp-lab.test",
                "totp_lab_test_hook": "hook-name",
            }
        )
        config = load_config(path)
        self.assertEqual(config.url_column, "\u0043\u0043\u5730\u5740")
        self.assertEqual(config.field_mappings["A"], "")
        self.assertEqual(config.download_timeout_seconds, 180)
        self.assertEqual(config.field_continuation_lines["D"], 1)
        self.assertEqual(config.totp_lab_url, "https://totp-lab.test")
        self.assertEqual(config.totp_lab_test_hook, "hook-name")

    def test_totp_lab_fields_default_to_empty_strings(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": "", "B": "", "C": "", "D": ""},
            }
        )
        config = load_config(path)
        self.assertEqual(config.totp_lab_url, "")
        self.assertEqual(config.totp_lab_test_hook, "")

    def test_unknown_mapping_key_is_rejected(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": "x", "E": "not allowed"},
            }
        )
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_non_string_mapping_value_is_rejected(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": 123},
            }
        )
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_continuation_line_count_has_a_safe_upper_bound(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"D": "\u90ae\u7bb1\u63a5\u7ebf\u5730\u5740"},
                "field_continuation_lines": {"D": 101},
            }
        )
        with self.assertRaises(ConfigError):
            load_config(path)

    def test_non_string_totp_lab_url_is_rejected(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": "", "B": "", "C": "", "D": ""},
                "totp_lab_url": 123,
            }
        )
        with self.assertRaises(ConfigError) as caught:
            load_config(path)
        self.assertEqual(str(caught.exception), "invalid_totp_lab_url")

    def test_non_string_totp_lab_test_hook_is_rejected(self):
        path = self.write_config(
            {
                "input_excel": "input.xlsx",
                "url_column": "\u0043\u0043\u5730\u5740",
                "txt_directory": "txt\u4fdd\u5b58",
                "output_excel": "cc\u6c47\u603b.xlsx",
                "download_timeout_seconds": 180,
                "field_mappings": {"A": "", "B": "", "C": "", "D": ""},
                "totp_lab_test_hook": 123,
            }
        )
        with self.assertRaises(ConfigError) as caught:
            load_config(path)
        self.assertEqual(str(caught.exception), "invalid_totp_lab_test_hook")

    def test_repo_config_uses_the_local_totp_lab_settings(self):
        config = load_config(Path("native_host/config.json"))
        self.assertEqual(str(config.input_excel), r"C:\Users\HE\Downloads\jingshajingsha\cc汇总.xlsx")
        self.assertEqual(config.totp_lab_url, "http://totp-lab.local/")
        self.assertEqual(config.totp_lab_test_hook, "__FILL_TOTP_TEST_HOOK__")
