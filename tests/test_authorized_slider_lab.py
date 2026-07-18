from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.authorized_slider_lab import (
    LabRunnerError,
    RunnerConfig,
    SliderLabRunner,
    validate_target,
)


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    def is_visible(self, timeout=0):
        del timeout
        if self.selector != self.page.success_selector:
            return False
        return self.page.value_for(self.page.success_visible, False)

    def count(self):
        if self.selector != self.page.slider_selector:
            return 0
        return self.page.value_for(self.page.slider_counts, 1)


class FakePage:
    def __init__(
        self,
        *,
        hook_results,
        success_visible=None,
        slider_counts=None,
        success_selector=".captcha-success",
        slider_selector="#slider-handle",
    ):
        self.hook_results = hook_results
        self.success_visible = success_visible or []
        self.slider_counts = slider_counts or []
        self.success_selector = success_selector
        self.slider_selector = slider_selector
        self.attempt_index = -1
        self.goto_calls = []
        self.reload_calls = []
        self.evaluated_tokens = []
        self.screenshots = []

    def value_for(self, values, default):
        if not values:
            return default
        return values[min(self.attempt_index, len(values) - 1)]

    def goto(self, url, *, wait_until):
        self.attempt_index += 1
        self.goto_calls.append((url, wait_until))

    def evaluate(self, script, token):
        self.evaluated_tokens.append((script, token))
        return self.value_for(self.hook_results, {"ok": False, "status": 500})

    def reload(self, *, wait_until):
        self.reload_calls.append(wait_until)

    def locator(self, selector):
        return FakeLocator(self, selector)

    def screenshot(self, *, path, full_page):
        self.screenshots.append(path)
        self.last_screenshot_full_page = full_page


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


class SliderLabRunnerTests(TestCase):
    def test_hook_success_and_visible_success_element_finishes_once(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            success_visible=[True],
        )

        result = SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)

        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(len(page.goto_calls), 1)
        self.assertEqual(page.reload_calls, ["networkidle"])
        self.assertEqual(page.screenshots, [])

    def test_missing_slider_is_accepted_when_success_element_is_absent(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            success_visible=[False],
            slider_counts=[0],
        )

        result = SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)

        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 1)

    def test_rejected_hook_retries_three_times_and_captures_failures(self):
        page = FakePage(hook_results=[{"ok": False, "status": 403}] * 3)

        with TemporaryDirectory() as directory:
            config = RunnerConfig(screenshot_dir=Path(directory))
            result = SliderLabRunner(config, token="lab-token").run_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.attempts, 3)
        self.assertEqual(result.error, "test_hook_rejected")
        self.assertEqual(len(page.goto_calls), 3)
        self.assertEqual(len(page.screenshots), 3)
        self.assertNotIn("lab-token", "".join(page.screenshots))

    def test_missing_success_state_retries_without_exposing_the_token(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}] * 3,
            success_visible=[False] * 3,
            slider_counts=[1] * 3,
        )

        with TemporaryDirectory() as directory:
            config = RunnerConfig(screenshot_dir=Path(directory))
            result = SliderLabRunner(config, token="private-token").run_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.error, "success_state_missing")
        self.assertEqual(len(page.reload_calls), 3)
        self.assertNotIn("private-token", repr(result))
        self.assertNotIn("private-token", "".join(page.screenshots))
