from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.authorized_slider_lab import (
    LabRunnerError,
    RunnerConfig,
    SliderLabRunner,
    build_parser,
    config_from_args,
    load_playwright,
    run_with_browser,
    validate_target,
)


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    def wait_for(self, *, state, timeout):
        self.page.visibility_waits.append((self.selector, state, timeout))
        if self.selector != self.page.success_selector:
            raise TimeoutError("not visible")
        if not self.page.value_for(self.page.success_visible, False):
            raise TimeoutError("not visible")

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
        goto_urls=None,
        reload_urls=None,
        success_selector=".captcha-success",
        slider_selector="#slider-handle",
    ):
        self.hook_results = hook_results
        self.success_visible = success_visible or []
        self.slider_counts = slider_counts or []
        self.goto_urls = goto_urls or []
        self.reload_urls = reload_urls or []
        self.success_selector = success_selector
        self.slider_selector = slider_selector
        self.url = "about:blank"
        self.attempt_index = -1
        self.goto_calls = []
        self.reload_calls = []
        self.evaluated_tokens = []
        self.screenshots = []
        self.visibility_waits = []

    def value_for(self, values, default):
        if not values:
            return default
        return values[min(self.attempt_index, len(values) - 1)]

    def goto(self, url, *, wait_until):
        self.attempt_index += 1
        self.goto_calls.append((url, wait_until))
        self.url = self.value_for(self.goto_urls, url)

    def evaluate(self, script, token):
        self.evaluated_tokens.append((script, token))
        return self.value_for(self.hook_results, {"ok": False, "status": 500})

    def reload(self, *, wait_until):
        self.reload_calls.append(wait_until)
        self.url = self.value_for(self.reload_urls, self.url)

    def locator(self, selector):
        return FakeLocator(self, selector)

    def screenshot(self, *, path, full_page):
        self.screenshots.append(path)
        self.last_screenshot_full_page = full_page


class FakeBrowserContext:
    def __init__(self, page=None, page_error=None):
        self.page = page
        self.page_error = page_error
        self.closed = False

    def new_page(self):
        if self.page_error:
            raise self.page_error
        return self.page

    def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self, context):
        self.context = context
        self.closed = False

    def new_context(self):
        return self.context

    def close(self):
        self.closed = True


class FakeChromium:
    def __init__(self, browser):
        self.browser = browser
        self.headless_values = []

    def launch(self, *, headless):
        self.headless_values.append(headless)
        return self.browser


class FakePlaywright:
    def __init__(self, *, page=None, page_error=None):
        self.context = FakeBrowserContext(page=page, page_error=page_error)
        self.browser = FakeBrowser(self.context)
        self.chromium = FakeChromium(self.browser)
        self.exited = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        del exc_type, exc, traceback
        self.exited = True


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
    def test_redirected_page_is_rejected_before_the_token_is_used(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            goto_urls=["http://evil.test/token-capture"],
        )

        with self.assertRaisesRegex(LabRunnerError, "target_not_allowed"):
            SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)

        self.assertEqual(page.evaluated_tokens, [])

    def test_reload_redirect_is_rejected_before_success_is_accepted(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            success_visible=[True],
            reload_urls=["http://evil.test/fake-success"],
        )

        with self.assertRaisesRegex(LabRunnerError, "target_not_allowed"):
            SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)

        self.assertEqual(len(page.evaluated_tokens), 1)

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
        self.assertEqual(
            page.visibility_waits,
            [(".captcha-success", "visible", 5_000)],
        )

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


class CliTests(TestCase):
    def test_security_boundary_errors_are_not_downgraded_to_browser_errors(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            goto_urls=["http://evil.test/token-capture"],
        )
        fake = FakePlaywright(page=page)

        with self.assertRaisesRegex(LabRunnerError, "target_not_allowed"):
            run_with_browser(
                RunnerConfig(),
                token="token",
                playwright_factory=lambda: fake,
            )

        self.assertTrue(fake.context.closed)
        self.assertTrue(fake.browser.closed)

    def test_missing_token_stops_before_browser_factory_is_called(self):
        called = False

        def factory():
            nonlocal called
            called = True
            return FakePlaywright()

        with self.assertRaisesRegex(LabRunnerError, "test_token_missing"):
            run_with_browser(RunnerConfig(), token="", playwright_factory=factory)

        self.assertFalse(called)

    def test_browser_and_context_close_on_page_failure(self):
        fake = FakePlaywright(page_error=RuntimeError("page failed"))

        result = run_with_browser(
            RunnerConfig(),
            token="token",
            playwright_factory=lambda: fake,
        )

        self.assertFalse(result.ok)
        self.assertEqual(result.error, "browser_error")
        self.assertTrue(fake.context.closed)
        self.assertTrue(fake.browser.closed)
        self.assertTrue(fake.exited)

    def test_successful_browser_run_uses_the_configured_headless_mode(self):
        page = FakePage(
            hook_results=[{"ok": True, "status": 200}],
            success_visible=[True],
        )
        fake = FakePlaywright(page=page)

        result = run_with_browser(
            RunnerConfig(headless=False),
            token="token",
            playwright_factory=lambda: fake,
        )

        self.assertTrue(result.ok)
        self.assertEqual(fake.chromium.headless_values, [False])
        self.assertTrue(fake.context.closed)
        self.assertTrue(fake.browser.closed)

    def test_load_playwright_maps_missing_dependency_to_a_fixed_error(self):
        def missing_import(_name):
            raise ImportError("missing")

        with self.assertRaisesRegex(LabRunnerError, "playwright_not_installed"):
            load_playwright(import_module=missing_import)

    def test_cli_arguments_build_a_valid_runner_config(self):
        args = build_parser().parse_args(
            [
                "--attempts",
                "2",
                "--headed",
                "--screenshot-dir",
                "lab-artifacts",
            ]
        )

        config = config_from_args(args)

        self.assertEqual(config.attempts, 2)
        self.assertFalse(config.headless)
        self.assertEqual(config.screenshot_dir, Path("lab-artifacts"))
