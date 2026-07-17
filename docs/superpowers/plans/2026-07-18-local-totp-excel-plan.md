# Excel 本地 TOTP 模块实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不访问公网 TOTP 服务的前提下，从配置 Excel 的 A/B/C 列匹配当前登录凭据，在 Native Host 内生成 RFC 6238 验证码，并安全填写当前 Chrome 登录标签页。

**Architecture:** Python Native Host 负责 Excel 精确匹配、Base32 校验和 HMAC-SHA1 TOTP 计算，只向扩展返回短期验证码。Chrome Service Worker 负责运行 ID、Native Messaging、取消和标签页绑定，并通过 `chrome.scripting.executeScript` 在具有 `activeTab` 授权的当前标签页执行一个自包含的页面动作函数。现有 CC 批处理控制器保持独立，不改变其下载状态机。

**Tech Stack:** Python 3.11+ 标准库、现有无依赖 XLSX XML 读取器、Chrome Extension Manifest V3、JavaScript ES modules、Node.js `node:test`。

---

## 文件映射

- `native_host/cc_batch/account_totp.py`：按 Excel A/B 精确匹配并返回同一行 C 列密钥。
- `native_host/cc_batch/totp.py`：Base32 校验、RFC 6238 计算和过期时间。
- `native_host/host.py`：新增 `get_totp` Native Messaging 命令。
- `native_host/tests/test_account_totp.py`：Excel 匹配边界测试。
- `native_host/tests/test_totp.py`：算法向量和错误测试。
- `native_host/tests/test_host_protocol.py`：`get_totp` 协议与秘密不泄漏测试。
- `extension/totp-page.js`：可直接注入的自包含页面稳定、填写和提交函数。
- `extension/totp-controller.js`：Native 请求、运行状态、取消和 `chrome.scripting` 调度。
- `extension/background.js`：把 `run_totp`/`cancel_totp` 消息连接到 TOTP 控制器。
- `extension/manifest.json`：增加最小的 `activeTab` 与 `scripting` 权限。
- `extension/tests/totp-page.test.mjs`：页面动作测试。
- `extension/tests/totp-controller.test.mjs`：Native 响应、竞态与标签页绑定测试。
- `extension/tests/background.test.mjs`：现有 CC 流程回归和 TOTP 消息路由测试。
- `README.md`：新增本地 TOTP 使用、安全边界和调用接口说明。

## Task 1：实现 Excel A/B/C 精确匹配

**Files:**
- Create: `native_host/cc_batch/account_totp.py`
- Create: `native_host/tests/test_account_totp.py`

- [ ] **Step 1：先写失败测试**

```python
from pathlib import Path
import tempfile
import unittest

from native_host.cc_batch.account_totp import AccountTotpError, find_totp_secret
from native_host.tests.xlsx_fixture import write_xlsx


class AccountTotpTests(unittest.TestCase):
    def test_returns_column_c_from_the_unique_exact_ab_match(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", "pass-1", "JBSWY3DPEHPK3PXP"], ["bob", "pass-2", "KRUGS4ZANFZSAYJA"]])
            self.assertEqual(find_totp_secret(path, "bob", "pass-2"), "KRUGS4ZANFZSAYJA")

    def test_does_not_trim_or_normalize_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", " pass ", "JBSWY3DPEHPK3PXP"]])
            with self.assertRaisesRegex(AccountTotpError, "account_not_found"):
                find_totp_secret(path, "alice", "pass")

    def test_rejects_missing_duplicate_and_empty_secret_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["alice", "pass", "A"], ["alice", "pass", "B"], ["empty", "pass", ""]])
            with self.assertRaisesRegex(AccountTotpError, "account_duplicate"):
                find_totp_secret(path, "alice", "pass")
            with self.assertRaisesRegex(AccountTotpError, "account_not_found"):
                find_totp_secret(path, "missing", "pass")
            with self.assertRaisesRegex(AccountTotpError, "totp_secret_missing"):
                find_totp_secret(path, "empty", "pass")
```

- [ ] **Step 2：运行测试并确认 RED**

Run: `python -m unittest native_host.tests.test_account_totp -v`

Expected: FAIL，原因是 `native_host.cc_batch.account_totp` 尚不存在。

- [ ] **Step 3：实现最小 Excel 匹配器**

```python
"""Exact A/B credential lookup for same-row C-column TOTP secrets."""

from pathlib import Path

from .xlsx_xml import XlsxError, read_workbook


class AccountTotpError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def find_totp_secret(path: str | Path, username: str, password: str) -> str:
    path = Path(path)
    if not path.exists():
        raise AccountTotpError("input_excel_missing")
    try:
        sheets = read_workbook(path)
    except (OSError, XlsxError, KeyError, ValueError):
        raise AccountTotpError("input_excel_invalid") from None

    matches: list[str] = []
    for rows in sheets.values():
        for row in rows:
            account = row[0] if len(row) > 0 else ""
            row_password = row[1] if len(row) > 1 else ""
            if account == username and row_password == password:
                matches.append(row[2] if len(row) > 2 else "")
    if not matches:
        raise AccountTotpError("account_not_found")
    if len(matches) != 1:
        raise AccountTotpError("account_duplicate")
    if not matches[0]:
        raise AccountTotpError("totp_secret_missing")
    return matches[0]
```

- [ ] **Step 4：运行测试并确认 GREEN**

Run: `python -m unittest native_host.tests.test_account_totp -v`

Expected: 3 tests pass。

- [ ] **Step 5：Lore 提交**

提交只包含新匹配器和测试；`Directive:` 说明不得对账号或密码做 trim/大小写转换。

## Task 2：实现标准 RFC 6238 TOTP

**Files:**
- Create: `native_host/cc_batch/totp.py`
- Create: `native_host/tests/test_totp.py`

- [ ] **Step 1：先写标准向量失败测试**

```python
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
        for value in ("", "NOT-BASE32!", "秘密"):
            with self.subTest(value=value), self.assertRaises(TotpError) as caught:
                generate_totp(value, timestamp=59)
            self.assertEqual(caught.exception.code, "totp_secret_invalid")
            self.assertNotIn(value, str(caught.exception))
```

- [ ] **Step 2：运行测试并确认 RED**

Run: `python -m unittest native_host.tests.test_totp -v`

Expected: FAIL，模块不存在。

- [ ] **Step 3：实现算法**

```python
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import struct
import time
from dataclasses import dataclass
from datetime import datetime, timezone


class TotpError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TotpResult:
    code: str
    expires_at: str


def generate_totp(secret: str, *, timestamp: int | float | None = None) -> TotpResult:
    normalized = secret.upper()
    if not normalized or not re.fullmatch(r"[A-Z2-7]+=*", normalized):
        raise TotpError("totp_secret_invalid")
    padded = normalized + "=" * ((8 - len(normalized) % 8) % 8)
    try:
        key = base64.b32decode(padded, casefold=False)
    except (binascii.Error, ValueError):
        raise TotpError("totp_secret_invalid") from None
    current = time.time() if timestamp is None else timestamp
    if not isinstance(current, (int, float)) or current < 0:
        raise TotpError("totp_clock_error")
    counter = int(current // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    expires = (counter + 1) * 30
    expires_at = datetime.fromtimestamp(expires, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return TotpResult(f"{value % 1_000_000:06d}", expires_at)
```

- [ ] **Step 4：运行测试并确认 GREEN**

Run: `python -m unittest native_host.tests.test_totp -v`

Expected: 3 tests pass。

- [ ] **Step 5：Lore 提交**

`Constraint:` 固定 Base32/HMAC-SHA1/30 秒/6 位，不增加算法猜测。

## Task 3：新增 `get_totp` Native Messaging 命令

**Files:**
- Modify: `native_host/host.py`
- Modify: `native_host/tests/test_host_protocol.py`

- [ ] **Step 1：写失败协议测试**

新增测试，使用临时配置和 Excel：

```python
def test_get_totp_returns_only_code_and_expiry_for_exact_credentials(self):
    with tempfile.TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        input_path = directory / "accounts.xlsx"
        write_xlsx(input_path, [["alice", "pass", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]])
        config_path = self._write_config(directory, input_path)
        app = HostApplication(config_path, totp_clock=lambda: 59)
        result = app.dispatch({"command": "get_totp", "username": "alice", "password": "pass"})
        self.assertEqual(result, {"ok": True, "code": "287082", "expires_at": "1970-01-01T00:01:00Z"})

def test_get_totp_rejects_invalid_requests_and_never_echoes_secrets(self):
    app = HostApplication("unused.json")
    result = app.dispatch({"command": "get_totp", "username": 7, "password": "secret"})
    self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
    self.assertNotIn("secret", str(result))
```

在测试类增加 `_write_config`，写入现有配置所需的全部字段，避免修改生产配置。

- [ ] **Step 2：运行并确认 RED**

Run: `python -m unittest native_host.tests.test_host_protocol.HostProtocolTests.test_get_totp_returns_only_code_and_expiry_for_exact_credentials -v`

Expected: FAIL，`HostApplication` 不接受 `totp_clock` 且命令未知。

- [ ] **Step 3：实现命令分支**

在 `HostApplication.__init__` 注入 `totp_clock=time.time`。在创建 BatchProcessor 之前处理 `get_totp`：

```python
if command == "get_totp":
    username = message.get("username")
    password = message.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        return {"ok": False, "error": "request_invalid", "fatal": False}
    try:
        config = load_config(self.config_path)
        secret = find_totp_secret(config.input_excel, username, password)
        result = generate_totp(secret, timestamp=self.totp_clock())
        return {"ok": True, "code": result.code, "expires_at": result.expires_at}
    except (AccountTotpError, TotpError) as exc:
        return {"ok": False, "error": exc.code, "fatal": False}
    except ConfigError:
        return {"ok": False, "error": "input_excel_invalid", "fatal": False}
```

导入 `ConfigError`、`find_totp_secret`、`AccountTotpError`、`generate_totp`、`TotpError` 和 `time`。不要把 TOTP 错误交给现有会返回 `fatal: true` 的批处理异常分支。

- [ ] **Step 4：运行协议与全套 Native Host 测试**

Run:

```text
python -m unittest native_host.tests.test_host_protocol -v
python -m unittest discover -s native_host/tests -v
```

Expected: 新增测试和所有现有 Native Host 测试通过。

- [ ] **Step 5：Lore 提交**

`Directive:` `get_totp` 错误响应不得包含 username、password、secret 或 code。

## Task 4：实现可注入的验证码页面动作

**Files:**
- Create: `extension/totp-page.js`
- Create: `extension/tests/totp-page.test.mjs`

- [ ] **Step 1：写失败测试**

测试导出函数：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fillTotpOnPage } from "../totp-page.js";

test("waits for stable one-time-code controls, fills events, and submits once", async () => {
  const events = [];
  let submitted = 0;
  const input = fakeInput(events);
  const button = fakeButton(() => { submitted += 1; });
  const env = stableEnvironment({ input, button });
  const result = await fillTotpOnPage({ code: "123456", timeoutMs: 100 }, env);
  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, "123456");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(submitted, 1);
});

test("rejects disabled controls, unstable pages, invalid codes, and aborted runs", async () => {
  // 分别断言 otp_submit_disabled、page_not_stable、otp_code_invalid 和 AbortError。
});
```

`stableEnvironment` 提供 fake document、MutationObserver、Event、timers、clock 和 AbortSignal，使测试不依赖真实 Chrome。

- [ ] **Step 2：运行并确认 RED**

Run: `node --test extension/tests/totp-page.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3：实现单个自包含导出函数**

`fillTotpOnPage({ code, timeoutMs = 15000, quietMs = 800, sampleGapMs = 250 }, env = defaultBrowserEnv)` 必须把所有注入所需辅助逻辑定义在函数体内，以便作为 `chrome.scripting.executeScript({ func })` 序列化。固定选择器：

```js
const inputSelector = 'input[autocomplete="one-time-code"][name="code"][maxlength="6"]';
const submitSelector = 'button[type="submit"][name="intent"][value="verify"]';
```

函数验证 `/^\d{6}$/`，等待 `readyState === "complete"`、DOM 800ms 静默、两次 250ms 稳定采样、输入框与按钮可见/未禁用、按钮 `aria-disabled !== "true"`。使用原生 value setter，派发冒泡的 `input`/`change`，优先 `form.requestSubmit(button)`，并返回 `{ok:true}` 或带固定错误代码的 `{ok:false,error}`。

- [ ] **Step 4：运行并确认 GREEN**

Run: `node --test extension/tests/totp-page.test.mjs`

Expected: 页面动作测试全部通过。

- [ ] **Step 5：Lore 提交**

`Constraint:` 不依赖动态 React ID，只使用稳定属性。

## Task 5：实现扩展 TOTP 控制器

**Files:**
- Create: `extension/totp-controller.js`
- Create: `extension/tests/totp-controller.test.mjs`

- [ ] **Step 1：写失败控制器测试**

使用 fake Native Messaging port 和 fake `chrome.scripting.executeScript`，覆盖：

```js
test("requests get_totp for the bound credentials then injects only the returned code", async () => {
  const chrome = makeChrome();
  const controller = createTotpController(chrome, { makeRunId: () => "run-1" });
  const result = await controller.run({ tabId: 7, username: "alice", password: "pass" });
  assert.equal(chrome.nativeMessages[0].command, "get_totp");
  assert.equal(chrome.nativeMessages[0].username, "alice");
  assert.equal(chrome.executions[0].target.tabId, 7);
  assert.deepEqual(chrome.executions[0].args, [{ code: "123456" }]);
  assert.equal(result.state, "SUCCEEDED");
});

test("cancel prevents a delayed native response from injecting into the tab", async () => {
  // 挂起 Native 响应，调用 cancel，再释放响应；断言 executions 为空。
});
```

同时测试 Native 错误、错误 request ID、错误 tab ID、并发运行和页面动作失败。

- [ ] **Step 2：运行并确认 RED**

Run: `node --test extension/tests/totp-controller.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 3：实现控制器**

导出 `createTotpController(api, options)`，内部维持一个活动运行：

```js
{
  runId,
  tabId,
  state: "FETCHING_TOTP" | "FILLING_TOTP" | "SUCCEEDED" | "FAILED" | "CANCELLED",
  cancelled: false,
  error: ""
}
```

Native 客户端为每个请求生成 `request_id`，只接收匹配响应。Native 成功后再次检查活动 run ID 与取消标志，再执行：

```js
await api.scripting.executeScript({
  target: { tabId: run.tabId },
  world: "ISOLATED",
  func: fillTotpOnPage,
  args: [{ code: response.code }]
});
```

只验证并传递 6 位 `response.code`；不保存 username、password 或 code 到 `chrome.storage`。`cancel(runId)` 立即标记取消并断开/忽略迟到响应。

- [ ] **Step 4：运行并确认 GREEN**

Run: `node --test extension/tests/totp-controller.test.mjs`

Expected: 控制器测试全部通过。

- [ ] **Step 5：Lore 提交**

`Directive:` 任何 Native `await` 之后必须重新校验活动 run ID，才能调用 `executeScript`。

## Task 6：接入 Manifest 和 Service Worker 消息路由

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Modify: `extension/tests/background.test.mjs`

- [ ] **Step 1：写失败 Manifest 与路由测试**

测试 `manifest.permissions` 在保留现有权限基础上只新增 `activeTab`、`scripting`，且没有 `<all_urls>` 或新增 host permissions。扩展 `makeChrome` fake 以支持 `scripting.executeScript` 和 `get_totp` Native 响应。

路由测试调用注册的 runtime listener：

```js
const response = await sendRuntimeMessage(chrome, {
  type: "run_totp", tabId: 7, username: "alice", password: "pass"
});
assert.equal(response.state, "SUCCEEDED");
```

同时测试 `cancel_totp`。

- [ ] **Step 2：运行并确认 RED**

Run: `node --test extension/tests/background.test.mjs`

Expected: TOTP 路由或权限断言失败。

- [ ] **Step 3：最小接线**

Manifest 权限改为：

```json
["nativeMessaging", "tabs", "downloads", "storage", "activeTab", "scripting"]
```

不增加 `host_permissions`。`background.js` 导入并创建 `createTotpController(chrome)`；runtime listener 对 `run_totp` 返回异步响应并 `return true`，对 `cancel_totp` 返回取消结果。现有 `start` 和 `state` 路由保持原样。

- [ ] **Step 4：运行所有扩展测试**

Run:

```text
node --test extension/tests/background.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: TOTP 和现有 CC 批处理扩展测试全部通过。

- [ ] **Step 5：Lore 提交**

`Rejected:` `<all_urls>` 或固定未知目标 host permission，因为 `activeTab` 已覆盖用户明确启动的当前标签页。

## Task 7：文档、全量回归与交付验证

**Files:**
- Modify: `README.md`
- Test: all Python and Node tests

- [ ] **Step 1：更新 README**

增加：

- Excel A/B/C 列定义；
- `run_totp` 调用消息示例；
- 稳定选择器；
- 本地 TOTP 参数；
- 不使用 `2fa.run` 的安全说明；
- Native Host 重新安装要求；
- 手工 Chrome 验证步骤。

- [ ] **Step 2：运行全量验证**

Run:

```text
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\verify-install.ps1
git diff --check
```

Expected:

- 所有 Python 单元与集成测试通过；
- 所有 Node 扩展测试通过；
- 安装验证脚本通过，或在 Native Host 尚未安装时明确记录该外部环境缺口；
- 无空白错误。

- [ ] **Step 3：检查敏感数据和权限**

Run:

```powershell
rg -n "2fa\.run|<all_urls>|totp_secret|password|code" extension native_host
```

逐项确认：

- 没有 `2fa.run` 运行时代码；
- 没有 `<all_urls>`；
- 日志调用不包含 password、secret 或 code；
- Chrome Storage 不保存 username、password、secret 或 code；
- Manifest 只增加 `activeTab` 与 `scripting`。

- [ ] **Step 4：手工 Chrome 验证（环境可用时）**

1. 重新运行 Native Host 安装脚本以复制新代码。
2. 在 Excel 中准备唯一 A/B/C 实验行。
3. 从登录流程调用 `run_totp`。
4. 验证页面稳定后才填写 6 位验证码并提交。
5. 修改为重复账号、空 C、非法 C，确认安全失败。
6. 在 Native 响应前取消，确认页面没有迟到填写。
7. 检查 DevTools 与 Native 日志，确认密钥未离开 Native Host。

如果登录靶场或 Chrome 会话不可用，不宣称手工 E2E 已通过，并把缺口写入最终 `Not-tested:` trailer。

- [ ] **Step 5：最终 Lore 提交**

```text
Confidence: high
Scope-risk: moderate
Directive: Never replace local TOTP generation with a public URL or persist TOTP seeds
Tested: Python unit/integration tests; Node extension tests; git diff --check
Not-tested: <仅列出实际不可用的 Chrome/登录靶场场景>
Co-authored-by: OmX <omx@oh-my-codex.dev>
```

## 计划自审

- 设计中的 Excel A/B/C 精确匹配由 Task 1 覆盖。
- RFC 6238 Base32/HMAC-SHA1/30 秒/6 位由 Task 2 覆盖。
- Native Host 只返回 code/expires_at，错误不含秘密，由 Task 3 覆盖。
- 稳定选择器、800ms/250ms/15s 门控和提交事件由 Task 4 覆盖。
- 运行 ID、tab ID、取消竞态和迟到响应由 Task 5 覆盖。
- 最小 `activeTab`/`scripting` 权限和现有批处理回归由 Task 6 覆盖。
- 文档、全量测试、敏感信息扫描和手工缺口由 Task 7 覆盖。
- 没有新增第三方依赖、公共 TOTP 服务、宽泛 host 权限或密钥持久化。
