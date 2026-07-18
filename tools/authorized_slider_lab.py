# 仅供授权测试与学术研究使用，禁止用于任何未授权系统

"""通过显式实验钩子验证本地滑块靶场的后续页面流程。"""

import argparse
import importlib
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ALLOWED_HOST = "test-target.local"
ALLOWED_NETLOC = ALLOWED_HOST
HOOK_SCRIPT = """
async (token) => {
  const response = await fetch('/__lab__/slider/approve', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'X-Lab-Test-Token': token}
  });
  return {ok: response.ok, status: response.status};
}
"""


class LabRunnerError(RuntimeError):
    """表示固定安全边界或运行配置不满足要求。"""


def validate_target(value: str) -> str:
    """仅接受固定本地 HTTP 靶场，拒绝凭据、端口和片段。"""
    if not isinstance(value, str):
        raise LabRunnerError("target_not_allowed")

    try:
        parsed = urlsplit(value)
        explicit_port = parsed.port
    except ValueError as exc:
        raise LabRunnerError("target_not_allowed") from exc

    if (
        parsed.scheme != "http"
        or parsed.hostname != ALLOWED_HOST
        or parsed.netloc != ALLOWED_NETLOC
        or parsed.username is not None
        or parsed.password is not None
        or explicit_port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise LabRunnerError("target_not_allowed")

    return urlunsplit(parsed)


@dataclass(frozen=True)
class RunnerConfig:
    """授权靶场运行器的非敏感配置。"""

    url: str = "http://test-target.local/slider-captcha"
    success_selector: str = ".captcha-success"
    slider_selector: str = "#slider-handle"
    attempts: int = 3
    screenshot_dir: Path = Path("artifacts/slider-lab")
    headless: bool = True

    def __post_init__(self) -> None:
        validate_target(self.url)
        if not 1 <= self.attempts <= 3:
            raise LabRunnerError("attempts_invalid")


@dataclass(frozen=True)
class RunResult:
    """不包含测试令牌或服务器响应正文的公开运行结果。"""

    ok: bool
    attempts: int
    error: str = ""


class SliderLabRunner:
    """通过固定同源测试钩子验证滑块后的页面状态。"""

    def __init__(self, config: RunnerConfig, token: str):
        if not isinstance(token, str) or not token:
            raise LabRunnerError("test_token_missing")
        self.config = config
        self._token = token

    def _screenshot_path(self, attempt: int) -> Path:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        return self.config.screenshot_dir / f"attempt-{attempt}-{timestamp}.png"

    def _capture_failure(self, page, attempt: int) -> None:
        self.config.screenshot_dir.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(self._screenshot_path(attempt)), full_page=True)

    def run_page(self, page) -> RunResult:
        last_error = "success_state_missing"

        for attempt in range(1, self.config.attempts + 1):
            page.goto(self.config.url, wait_until="networkidle")
            hook_result = page.evaluate(HOOK_SCRIPT, self._token)

            if isinstance(hook_result, dict) and hook_result.get("ok") is True:
                page.reload(wait_until="networkidle")
                success_visible = page.locator(
                    self.config.success_selector,
                ).is_visible(timeout=5_000)
                slider_missing = page.locator(self.config.slider_selector).count() == 0
                if success_visible or slider_missing:
                    return RunResult(ok=True, attempts=attempt)
                last_error = "success_state_missing"
            else:
                last_error = "test_hook_rejected"

            self._capture_failure(page, attempt)

        return RunResult(
            ok=False,
            attempts=self.config.attempts,
            error=last_error,
        )


def _close_quietly(resource) -> None:
    if resource is None:
        return
    try:
        resource.close()
    except Exception:
        pass


def run_with_browser(
    config: RunnerConfig,
    token: str,
    playwright_factory,
) -> RunResult:
    """启动 Playwright，保证浏览器资源在成功和失败路径均被关闭。"""
    runner = SliderLabRunner(config, token)
    browser = None
    context = None

    try:
        with playwright_factory() as playwright:
            browser = playwright.chromium.launch(headless=config.headless)
            try:
                context = browser.new_context()
                page = context.new_page()
                return runner.run_page(page)
            except Exception:
                return RunResult(ok=False, attempts=0, error="browser_error")
            finally:
                _close_quietly(context)
                _close_quietly(browser)
    except Exception:
        _close_quietly(context)
        _close_quietly(browser)
        return RunResult(ok=False, attempts=0, error="browser_error")


def load_playwright(import_module=importlib.import_module):
    """延迟加载 Playwright，使 `--help` 和单元测试不依赖该软件包。"""
    try:
        module = import_module("playwright.sync_api")
    except ImportError as exc:
        raise LabRunnerError("playwright_not_installed") from exc
    return module.sync_playwright


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="通过授权靶场的显式测试钩子验证滑块后的页面流程。",
    )
    parser.add_argument(
        "--url",
        default="http://test-target.local/slider-captcha",
        help="授权页面 URL；仅允许 http://test-target.local。",
    )
    parser.add_argument(
        "--success-selector",
        default=".captcha-success",
        help="验证成功元素选择器。",
    )
    parser.add_argument(
        "--slider-selector",
        default="#slider-handle",
        help="滑块按钮选择器；按钮消失也可作为成功状态。",
    )
    parser.add_argument(
        "--attempts",
        type=int,
        choices=range(1, 4),
        default=3,
        metavar="1-3",
        help="最大尝试次数，范围 1 到 3。",
    )
    parser.add_argument(
        "--screenshot-dir",
        type=Path,
        default=Path("artifacts/slider-lab"),
        help="失败截图目录。",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="显示 Chromium 窗口；默认使用无头模式。",
    )
    return parser


def config_from_args(args: argparse.Namespace) -> RunnerConfig:
    return RunnerConfig(
        url=args.url,
        success_selector=args.success_selector,
        slider_selector=args.slider_selector,
        attempts=args.attempts,
        screenshot_dir=args.screenshot_dir,
        headless=not args.headed,
    )


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    try:
        config = config_from_args(args)
        token = os.environ.get("SLIDER_LAB_TEST_TOKEN", "")
        if not token:
            raise LabRunnerError("test_token_missing")
        result = run_with_browser(config, token, load_playwright())
    except LabRunnerError as exc:
        error = str(exc)
        print(f"失败：{error}", file=sys.stderr)
        if error == "playwright_not_installed":
            print(
                "安装：python -m pip install playwright；然后运行 playwright install chromium",
                file=sys.stderr,
            )
        return 2

    if result.ok:
        print(f"验证成功；尝试次数：{result.attempts}")
        return 0

    print(f"验证失败：{result.error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
