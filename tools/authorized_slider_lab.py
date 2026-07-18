# 仅供授权测试与学术研究使用，禁止用于任何未授权系统

"""通过显式实验钩子验证本地滑块靶场的后续页面流程。"""

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
