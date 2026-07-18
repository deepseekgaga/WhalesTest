# 仅供授权测试与学术研究使用，禁止用于任何未授权系统

"""通过显式实验钩子验证本地滑块靶场的后续页面流程。"""

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ALLOWED_HOST = "test-target.local"
ALLOWED_NETLOC = ALLOWED_HOST


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
