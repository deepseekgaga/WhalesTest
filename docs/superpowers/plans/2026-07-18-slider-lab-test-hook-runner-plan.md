# 授权滑块靶场测试钩子运行器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个严格限制在 `http://test-target.local` 的 Python/Playwright 运行器，通过显式 Flask 实验钩子验证滑块后的页面流程，而不生成或执行真人化拖动轨迹。

**Architecture:** `tools/authorized_slider_lab.py` 将 URL 安全校验、单页重试流程和 Playwright 启动拆成可独立测试的函数与类。单元测试通过假的 Page/Locator 对象验证网络与页面控制流，不启动浏览器、不访问网络；真实 Playwright 仅在 CLI `main()` 执行时延迟导入。

**Tech Stack:** Python 3.11 标准库、Playwright Python 同步 API、`unittest`、现有中文 README。

---

## 文件结构

- `tools/authorized_slider_lab.py`：安全边界、配置、运行器、CLI 入口。
- `tests/test_authorized_slider_lab.py`：URL 校验、令牌、重试、成功判定、截图和 CLI 测试。
- `README.md`：安装 Playwright、启用 Flask 测试钩子和运行命令。

### Task 1: 固定目标 URL 与配置边界

**Files:**
- Create: `tools/authorized_slider_lab.py`
- Create: `tests/test_authorized_slider_lab.py`

- [ ] **Step 1: 写 URL 和配置失败测试**

```python
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
            with self.subTest(value=value), self.assertRaisesRegex(LabRunnerError, "target_not_allowed"):
                validate_target(value)

    def test_config_caps_attempts_at_three(self):
        with self.assertRaisesRegex(LabRunnerError, "attempts_invalid"):
            RunnerConfig(attempts=4, screenshot_dir=Path("artifacts"))
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest tests.test_authorized_slider_lab.TargetValidationTests -v`

Expected: FAIL because `tools.authorized_slider_lab` does not exist.

- [ ] **Step 3: 实现最小安全配置**

```python
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ALLOWED_ORIGIN = "http://test-target.local"


class LabRunnerError(RuntimeError):
    pass


def validate_target(value: str) -> str:
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise LabRunnerError("target_not_allowed") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname != "test-target.local"
        or parsed.netloc != "test-target.local"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise LabRunnerError("target_not_allowed")
    return urlunsplit(parsed)


@dataclass(frozen=True)
class RunnerConfig:
    url: str = "http://test-target.local/slider-captcha"
    success_selector: str = ".captcha-success"
    slider_selector: str = "#slider-handle"
    attempts: int = 3
    screenshot_dir: Path = Path("artifacts/slider-lab")

    def __post_init__(self):
        validate_target(self.url)
        if not 1 <= self.attempts <= 3:
            raise LabRunnerError("attempts_invalid")
```

- [ ] **Step 4: 运行测试并确认绿灯**

Run: `python -m unittest tests.test_authorized_slider_lab.TargetValidationTests -v`

Expected: 3 tests PASS.

- [ ] **Step 5: 提交**

```powershell
git add tools/authorized_slider_lab.py tests/test_authorized_slider_lab.py
git commit -m "Constrain slider lab automation to the authorized origin"
```

### Task 2: 实现同源测试钩子、成功检测与三次重试

**Files:**
- Modify: `tools/authorized_slider_lab.py`
- Modify: `tests/test_authorized_slider_lab.py`

- [ ] **Step 1: 写页面流程失败测试**

测试假的 Page 必须覆盖：钩子成功后 `.captcha-success` 可见；成功元素不可见但滑块消失；钩子拒绝时最多三次并截图；截图路径不包含令牌。

```python
class SliderLabRunnerTests(TestCase):
    def test_hook_success_and_visible_success_element_finishes_once(self):
        page = FakePage(hook_results=[{"ok": True, "status": 200}], success_visible=[True])
        result = SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 1)

    def test_missing_slider_is_accepted_when_success_element_is_absent(self):
        page = FakePage(hook_results=[{"ok": True, "status": 200}], success_visible=[False], slider_counts=[0])
        self.assertTrue(SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page).ok)

    def test_rejected_hook_retries_three_times_and_captures_failures(self):
        page = FakePage(hook_results=[{"ok": False, "status": 403}] * 3)
        result = SliderLabRunner(RunnerConfig(), token="lab-token").run_page(page)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "test_hook_rejected")
        self.assertEqual(len(page.screenshots), 3)
        self.assertNotIn("lab-token", "".join(page.screenshots))
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest tests.test_authorized_slider_lab.SliderLabRunnerTests -v`

Expected: FAIL because `SliderLabRunner` and `RunResult` are missing.

- [ ] **Step 3: 实现最小页面流程**

```python
@dataclass(frozen=True)
class RunResult:
    ok: bool
    attempts: int
    error: str = ""


class SliderLabRunner:
    def __init__(self, config: RunnerConfig, token: str):
        if not token:
            raise LabRunnerError("test_token_missing")
        self.config = config
        self.token = token

    def run_page(self, page) -> RunResult:
        self.config.screenshot_dir.mkdir(parents=True, exist_ok=True)
        last_error = "success_state_missing"
        for attempt in range(1, self.config.attempts + 1):
            page.goto(self.config.url, wait_until="networkidle")
            hook = page.evaluate(HOOK_SCRIPT, self.token)
            if hook.get("ok") is True:
                page.reload(wait_until="networkidle")
                if page.locator(self.config.success_selector).is_visible(timeout=5_000):
                    return RunResult(True, attempt)
                if page.locator(self.config.slider_selector).count() == 0:
                    return RunResult(True, attempt)
                last_error = "success_state_missing"
            else:
                last_error = "test_hook_rejected"
            page.screenshot(path=str(self._screenshot_path(attempt)), full_page=True)
        return RunResult(False, self.config.attempts, last_error)
```

`HOOK_SCRIPT` 必须固定请求路径并且只返回状态，不返回响应正文：

```python
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
```

- [ ] **Step 4: 运行测试并确认绿灯**

Run: `python -m unittest tests.test_authorized_slider_lab.SliderLabRunnerTests -v`

Expected: 页面流程 tests PASS.

- [ ] **Step 5: 提交**

```powershell
git add tools/authorized_slider_lab.py tests/test_authorized_slider_lab.py
git commit -m "Verify slider lab sessions through the explicit test hook"
```

### Task 3: 增加 Playwright CLI、清理保证和安装错误

**Files:**
- Modify: `tools/authorized_slider_lab.py`
- Modify: `tests/test_authorized_slider_lab.py`

- [ ] **Step 1: 写 CLI 和资源清理失败测试**

```python
class CliTests(TestCase):
    def test_missing_token_stops_before_browser_factory_is_called(self):
        called = False
        def factory():
            nonlocal called
            called = True
        with self.assertRaisesRegex(LabRunnerError, "test_token_missing"):
            run_with_browser(RunnerConfig(), token="", playwright_factory=factory)
        self.assertFalse(called)

    def test_browser_and_context_close_on_page_failure(self):
        fake = FakePlaywright(page_error=RuntimeError("page failed"))
        result = run_with_browser(RunnerConfig(), "token", lambda: fake)
        self.assertEqual(result.error, "browser_error")
        self.assertTrue(fake.browser.closed)
        self.assertTrue(fake.context.closed)
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest tests.test_authorized_slider_lab.CliTests -v`

Expected: FAIL because `run_with_browser` is missing.

- [ ] **Step 3: 实现浏览器入口和 CLI**

`run_with_browser` 必须在 `finally` 中关闭 context/browser；`main()` 延迟导入 Playwright，缺失时只输出安装提示：

```python
def load_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise LabRunnerError("playwright_not_installed") from exc
    return sync_playwright


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    token = os.environ.get("SLIDER_LAB_TEST_TOKEN", "")
    try:
        result = run_with_browser(config_from_args(args), token, load_playwright())
    except LabRunnerError as exc:
        print(f"失败：{exc}", file=sys.stderr)
        if str(exc) == "playwright_not_installed":
            print("安装：python -m pip install playwright && playwright install chromium", file=sys.stderr)
        return 2
    print("验证成功" if result.ok else f"验证失败：{result.error}")
    return 0 if result.ok else 1
```

- [ ] **Step 4: 运行测试和帮助命令**

Run:

```powershell
python -m unittest tests.test_authorized_slider_lab -v
python tools/authorized_slider_lab.py --help
```

Expected: tests PASS; help exits 0 without importing Playwright.

- [ ] **Step 5: 提交**

```powershell
git add tools/authorized_slider_lab.py tests/test_authorized_slider_lab.py
git commit -m "Add the authorized slider lab Playwright command"
```

### Task 4: 中文文档与最终验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新中文使用说明**

README 必须增加：

- 安装 `playwright` 和 Chromium 的命令。
- 设置 `SLIDER_LAB_TEST_TOKEN` 的 PowerShell 示例。
- Flask 测试钩子契约和常量时间令牌比较示例。
- 运行命令和退出码：0 成功、1 验证失败、2 配置或依赖错误。
- 明确不生成真人化轨迹、不绕过 CAPTCHA、只允许固定授权域名。

- [ ] **Step 2: 运行完整回归测试**

Run:

```powershell
python -m unittest tests.test_authorized_slider_lab -v
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
python tools/authorized_slider_lab.py --help
git diff --check
rg -n "generate_track|page\.mouse|drag_to|2fa\.run|<all_urls>" tools README.md extension native_host
```

Expected:

- 新运行器 tests 全部通过。
- Native Host、集成测试和扩展测试无回归。
- CLI help 退出 0。
- diff check 退出 0。
- 扫描结果不包含 `generate_track`、`page.mouse` 或 `drag_to` 实现；`<all_urls>` 只允许出现在否定性文档或测试断言中。

- [ ] **Step 3: 提交**

```powershell
git add README.md
git commit -m "Document the authorized slider lab test-hook workflow"
```

## 计划自审

- 规格中的固定域名、固定钩子、环境变量令牌、三次重试、截图、成功元素/滑块消失判定、Playwright 延迟导入和 Flask 契约均有对应任务。
- 函数签名在所有任务中保持一致：`validate_target`、`RunnerConfig`、`RunResult`、`SliderLabRunner.run_page`、`run_with_browser`、`main`。
- 没有实现鼠标轨迹、缺口识别、拖动距离计算或 CAPTCHA 规避。
- 计划未包含占位文本或待补充代码。
