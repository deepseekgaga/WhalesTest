from pathlib import Path
from unittest import TestCase

from tools.authorized_slider_lab import LabRunnerError, RunnerConfig, validate_target


class TargetValidationTests(TestCase):
    def test_accepts_only_the_exact_local_http_origin(self):
        self.assertEqual(
            validate_target("http://test-target.local/slider-captcha"),
            "http://test-target.local/slider-captcha",
        )

    def test_rejects_other_origins_ports_credentials_and_fragments(self):
        rejected = [
            "https://test-target.local/slider-captcha",
            "http://evil.test/slider-captcha",
            "http://sub.test-target.local/slider-captcha",
            "http://test-target.local:8080/slider-captcha",
            "http://user@test-target.local/slider-captcha",
            "http://test-target.local/slider-captcha#fragment",
        ]

        for value in rejected:
            with self.subTest(value=value), self.assertRaisesRegex(
                LabRunnerError,
                "target_not_allowed",
            ):
                validate_target(value)

    def test_config_caps_attempts_at_three(self):
        with self.assertRaisesRegex(LabRunnerError, "attempts_invalid"):
            RunnerConfig(attempts=4, screenshot_dir=Path("artifacts"))
