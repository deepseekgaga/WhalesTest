import unittest

from native_host.cc_batch.totp import TotpError, generate_totp


class TotpTests(unittest.TestCase):
    def test_generates_six_digit_sha1_totp_from_rfc_vector(self):
        result = generate_totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", timestamp=59)
        self.assertEqual(result.code, "287082")
        self.assertEqual(result.expires_at, "1970-01-01T00:01:00Z")

    def test_is_case_insensitive_and_accepts_standard_padding(self):
        upper = generate_totp("JBSWY3DPEHPK3PXP", timestamp=1_700_000_000)
        lower = generate_totp("jbswy3dpehpk3pxp", timestamp=1_700_000_000)
        self.assertEqual(lower, upper)

    def test_rejects_empty_and_non_base32_secrets_without_echoing_them(self):
        with self.assertRaisesRegex(TotpError, "totp_secret_invalid"):
            generate_totp("", timestamp=59)
        for value in ("NOT-BASE32!", "秘密"):
            with self.subTest(value=value), self.assertRaises(TotpError) as caught:
                generate_totp(value, timestamp=59)
            self.assertEqual(caught.exception.code, "totp_secret_invalid")
            self.assertNotIn(value, str(caught.exception))
