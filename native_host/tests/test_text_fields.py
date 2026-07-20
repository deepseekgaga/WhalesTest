import unittest

from native_host.cc_batch.text_fields import decode_text, extract_fields


class TextFieldTests(unittest.TestCase):
    def test_extracts_configured_names_with_supported_delimiters(self):
        text = "Name: Alice\nCity： Shanghai\nCode=42\nNote\tready\n"
        result = extract_fields(text, {"A": "name", "B": "city", "C": "code", "D": "note"})
        self.assertEqual(result.values, {"A": "Alice", "B": "Shanghai", "C": "42", "D": "ready"})
        self.assertEqual(result.missing_fields, [])

    def test_missing_non_empty_mapping_is_reported_without_losing_other_values(self):
        result = extract_fields("Name: Alice\n", {"A": "Name", "B": "Missing", "C": "", "D": ""})
        self.assertEqual(result.values["A"], "Alice")
        self.assertEqual(result.values["B"], "")
        self.assertEqual(result.missing_fields, ["B"])

    def test_decodes_utf8_bom_and_gb18030(self):
        self.assertEqual(decode_text("字段: 值\n".encode("utf-8-sig")), "字段: 值\n")
        self.assertEqual(decode_text("字段: 值\n".encode("gb18030")), "字段: 值\n")

    def test_email_address_field_includes_the_following_line(self):
        text = "账户: account-value\n密码: password-value\n2FA 密钥: key-value\n邮箱接码地址: first-line\nsecond-line\n"
        result = extract_fields(
            text,
            {"A": "账户", "B": "密码", "C": "2FA 密钥", "D": "邮箱接码地址"},
            continuation_lines={"D": 1},
        )
        self.assertEqual(result.values["A"], "account-value")
        self.assertEqual(result.values["B"], "password-value")
        self.assertEqual(result.values["C"], "key-value")
        self.assertEqual(result.values["D"], "first-line\nsecond-line")
