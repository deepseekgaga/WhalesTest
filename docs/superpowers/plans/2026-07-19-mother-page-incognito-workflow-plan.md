# 母页提链与无痕登录全流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 `http://127.0.0.1:9527/` 母页自动创建账号、生成授权链接、在无痕窗口完成账号密码/TOTP/短信验证、点击接受并把最终 URL 回填母页，只有完整成功后才推进 Excel 行。

**Architecture:** 新增独立 `workflow-controller.js` 作为可恢复的 Manifest V3 状态机，页面 DOM 动作拆分为自包含的可注入函数，Native Host 按物理 Excel 行提供 A/B 凭据并复用现有 C/D/E TOTP/SMS 模块。工作流状态只保存非秘密元数据到 `chrome.storage.session`，使用 `chrome.alarms` 跨 Service Worker 生命周期继续执行，并用唯一 `about:blank#whalestest-handoff-<batchId>` 标记避免重复创建无痕窗口。

**Tech Stack:** Chrome Extension Manifest V3、ES modules、`chrome.tabs/windows/scripting/storage/alarms/nativeMessaging`、Node.js built-in test runner、Python 3.11 标准库、现有 XLSX Open XML 读取器、Python `unittest`、PowerShell 打包脚本。

---

## 文件结构

### 新增文件

- `native_host/cc_batch/workflow_credentials.py`：按物理 Excel 行读取 A/B 列。
- `native_host/tests/test_workflow_credentials.py`：凭据读取、耗尽和错误清洗测试。
- `extension/workflow-selectors.js`：母页、登录、接受和最终回填选择器配置及严格校验。
- `extension/workflow-urls.js`：授权 URL、最终 URL 和 handoff marker 的纯函数校验。
- `extension/workflow-state.js`：阶段、序号映射、公开状态和可恢复/确定性错误分类。
- `extension/workflow-page-context.js`：母页和目标页的批次令牌注册、替换和取消。
- `extension/mother-page.js`：创建账号、生成授权链接、COPY URL 和最终回填页面动作。
- `extension/login-page.js`：账号密码填写、提交和 TOTP 阶段检测。
- `extension/final-page.js`：接受按钮与最终主页检测。
- `extension/workflow-controller.js`：完整批次状态机、Alarm、Native Messaging、无痕窗口所有权、重试和清理。
- `extension/tests/workflow-selectors.test.mjs`
- `extension/tests/workflow-urls.test.mjs`
- `extension/tests/workflow-state.test.mjs`
- `extension/tests/workflow-page-context.test.mjs`
- `extension/tests/mother-page.test.mjs`
- `extension/tests/login-page.test.mjs`
- `extension/tests/final-page.test.mjs`
- `extension/tests/workflow-controller.test.mjs`
- `extension/tests/page-fixture.mjs`：母页、登录和接受页面测试共享的无依赖 DOM 夹具。

### 修改文件

- `native_host/host.py`：增加 `get_workflow_credentials` 严格命令。
- `native_host/cc_batch/totp_lab.py`：物理行下界从 1 收紧为 2。
- `native_host/tests/test_host_protocol.py`、`test_totp_lab.py`：协议和表头行回归测试。
- `extension/totp-lab-controller.js`、`sms-lab-controller.js`：统一目标页访问错误和行号下界。
- `extension/tests/totp-lab-controller.test.mjs`、`sms-lab-controller.test.mjs`：访问与行号回归。
- `extension/background.js`、`extension/tests/background.test.mjs`：装配工作流、Alarm 和严格消息路由，同时保留旧 CC 路由。
- `extension/manifest.json`：增加 `alarms`、母页/目标精确 Host permission 和 `incognito: "spanning"`。
- `extension/popup.html`、`popup.js`、`popup.css`：新增授权登录分区，旧 CC 分区保持可用并互斥运行。
- `scripts/package-extension.ps1`：打包全部新扩展文件。
- `README.md`：中文配置、运行和排错说明。

`__FILL_MOTHER_*__` 和 `http://auth-target.local/*` 是用户明确要求的 fail-closed 运行时配置标记，不是未完成的实施步骤。所有代码、测试、接口和错误行为在本计划中均已定义；标记未替换时必须返回固定配置错误。

---

### Task 1: 按物理 Excel 行读取登录凭据

**Files:**
- Create: `native_host/cc_batch/workflow_credentials.py`
- Create: `native_host/tests/test_workflow_credentials.py`
- Modify: `native_host/host.py`
- Modify: `native_host/tests/test_host_protocol.py`

- [ ] **Step 1: 写凭据读取失败测试**

在 `native_host/tests/test_workflow_credentials.py` 写入：

```python
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from native_host.cc_batch.workflow_credentials import (
    WorkflowCredentialsError,
    read_workflow_credentials,
)
from native_host.tests.xlsx_fixture import write_xlsx


class WorkflowCredentialsTests(unittest.TestCase):
    def test_reads_a_and_b_from_exact_physical_row(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(
                workbook,
                [["账号", "密码"], ["alice", "secret"], ["bob", "pass-2"]],
                row_numbers=[1, 3, 8],
            )
            result = read_workflow_credentials(workbook, 8)
            self.assertEqual(result.username, "bob")
            self.assertEqual(result.password, "pass-2")

    def test_rejects_header_boolean_and_non_integer_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["账号", "密码"], ["alice", "secret"]])
            for row in [1, 0, True, 2.0, "2"]:
                with self.subTest(row=row), self.assertRaisesRegex(
                    WorkflowCredentialsError, "excel_row_invalid"
                ):
                    read_workflow_credentials(workbook, row)

    def test_distinguishes_exhaustion_from_invalid_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            workbook = Path(directory) / "accounts.xlsx"
            write_xlsx(workbook, [["账号", "密码"], ["", "secret"]])
            with self.assertRaisesRegex(WorkflowCredentialsError, "credentials_invalid"):
                read_workflow_credentials(workbook, 2)
            with self.assertRaisesRegex(WorkflowCredentialsError, "excel_exhausted"):
                read_workflow_credentials(workbook, 3)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest native_host.tests.test_workflow_credentials -v`

Expected: FAIL with `ModuleNotFoundError: native_host.cc_batch.workflow_credentials`.

- [ ] **Step 3: 实现最小物理行读取器**

创建 `native_host/cc_batch/workflow_credentials.py`：

```python
"""Read workflow login credentials from one physical workbook row."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from .xlsx_xml import XlsxError, read_numbered_workbook


class WorkflowCredentialsError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class WorkflowCredentials:
    username: str
    password: str


def read_workflow_credentials(path: str | Path, excel_row: int) -> WorkflowCredentials:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
        raise WorkflowCredentialsError("excel_row_invalid")
    try:
        workbook = read_numbered_workbook(Path(path))
    except FileNotFoundError as exc:
        raise WorkflowCredentialsError("input_excel_missing") from exc
    except (OSError, BadZipFile, KeyError, ParseError, XlsxError, ValueError) as exc:
        raise WorkflowCredentialsError("input_excel_invalid") from exc
    rows = next(iter(workbook.values()), [])
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise WorkflowCredentialsError("excel_exhausted")
    username = values[0] if len(values) > 0 else ""
    password = values[1] if len(values) > 1 else ""
    if not username or not password:
        raise WorkflowCredentialsError("credentials_invalid")
    return WorkflowCredentials(username=username, password=password)
```

- [ ] **Step 4: 运行读取器测试并确认绿灯**

Run: `python -m unittest native_host.tests.test_workflow_credentials -v`

Expected: 3 tests PASS.

- [ ] **Step 5: 写 Native Host 命令失败测试**

在 `native_host/tests/test_host_protocol.py` 的 `HostProtocolTests` 增加：

```python
def test_get_workflow_credentials_returns_only_a_and_b_from_exact_row(self):
    with tempfile.TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        input_path = directory / "accounts.xlsx"
        write_xlsx(input_path, [["账号", "密码", "密钥"], ["alice", "pass", "SECRET"]])
        app = HostApplication(self._write_totp_config(directory, input_path))
        result = app.dispatch({
            "command": "get_workflow_credentials",
            "excel_row": 2,
            "request_id": "credentials-1",
        })
        self.assertEqual(result, {"ok": True, "username": "alice", "password": "pass"})
        self.assertNotIn("SECRET", str(result))

def test_get_workflow_credentials_rejects_extra_fields_and_header_row(self):
    app = HostApplication("missing-config.json")
    for message in [
        {"command": "get_workflow_credentials", "excel_row": 1},
        {"command": "get_workflow_credentials", "excel_row": True},
        {"command": "get_workflow_credentials", "excel_row": 2, "username": "leak"},
    ]:
        with self.subTest(message=message):
            result = app.dispatch(message)
            self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
            self.assertNotIn("leak", str(result))
```

- [ ] **Step 6: 运行协议测试并确认红灯**

Run: `python -m unittest native_host.tests.test_host_protocol.HostProtocolTests.test_get_workflow_credentials_returns_only_a_and_b_from_exact_row native_host.tests.test_host_protocol.HostProtocolTests.test_get_workflow_credentials_rejects_extra_fields_and_header_row -v`

Expected: FAIL because `get_workflow_credentials` returns `unknown_command`.

- [ ] **Step 7: 接入严格 Native Host 路由**

在 `native_host/host.py` 导入读取器，并加入：

```python
from native_host.cc_batch.workflow_credentials import (
    WorkflowCredentialsError,
    read_workflow_credentials,
)

def _get_workflow_credentials(self, message: dict[str, Any]) -> dict[str, Any]:
    if set(message) - {"command", "excel_row", "request_id"}:
        return {"ok": False, "error": "request_invalid", "fatal": False}
    excel_row = message.get("excel_row")
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
        return {"ok": False, "error": "request_invalid", "fatal": False}
    try:
        config = load_config(self.config_path)
        credentials = read_workflow_credentials(config.input_excel, excel_row)
        return {"ok": True, "username": credentials.username, "password": credentials.password}
    except WorkflowCredentialsError as exc:
        return {"ok": False, "error": exc.code, "fatal": False}
    except ConfigError:
        return {"ok": False, "error": "input_excel_invalid", "fatal": False}
```

在 `dispatch()` 的 Lab 命令旁增加：

```python
if command == "get_workflow_credentials":
    return self._get_workflow_credentials(message)
```

- [ ] **Step 8: 运行 Native 目标测试和全量回归**

Run:

```powershell
python -m unittest native_host.tests.test_workflow_credentials native_host.tests.test_host_protocol -v
python -m unittest discover -s native_host/tests -v
```

Expected: targeted tests and all Native Host tests PASS.

- [ ] **Step 9: 提交 Task 1**

```powershell
git add native_host/cc_batch/workflow_credentials.py native_host/tests/test_workflow_credentials.py native_host/host.py native_host/tests/test_host_protocol.py
git commit -m "Bind workflow credentials to physical Excel rows" `
  -m "Add a strict Native Host command that reads only A/B from one data row and distinguishes workbook exhaustion from invalid credentials." `
  -m "Constraint: Excel row 1 is always the header" `
  -m "Confidence: high" `
  -m "Scope-risk: narrow" `
  -m "Tested: workflow credential unit tests, host protocol tests, full native suite" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 2: 统一 TOTP/SMS 物理行与目标页权限错误

**Files:**
- Modify: `native_host/cc_batch/totp_lab.py`
- Modify: `native_host/tests/test_totp_lab.py`
- Modify: `native_host/host.py`
- Modify: `extension/totp-lab-controller.js`
- Modify: `extension/sms-lab-controller.js`
- Modify: `extension/background.js`
- Modify: `extension/tests/totp-lab-controller.test.mjs`
- Modify: `extension/tests/sms-lab-controller.test.mjs`
- Modify: `extension/tests/background.test.mjs`

- [ ] **Step 1: 写 row 1 和目标权限失败测试**

把 `native_host/tests/test_totp_lab.py` 的行号测试扩展为：

```python
def test_rejects_header_non_positive_or_boolean_excel_rows(self):
    with tempfile.TemporaryDirectory() as directory:
        workbook = Path(directory) / "accounts.xlsx"
        write_xlsx(workbook, [["header", "", "secret"], ["alice", "pass", "secret"]])
        config = self.config(directory, workbook)
        for row in [1, 0, True]:
            with self.subTest(row=row), self.assertRaisesRegex(TotpLabError, "excel_row_invalid"):
                build_totp_lab_challenge(config, row)
```

在 `extension/tests/totp-lab-controller.test.mjs` 增加：

```js
test("rejects the header row before opening a helper", async () => {
  const chrome = makeChrome();
  const result = await createTotpLabController(chrome).run({ motherTabId: 10, incognitoTabId: 20, excelRow: 1 });
  assert.equal(result.error, "request_invalid");
  assert.equal(chrome.createdTabs.length, 0);
});

test("maps target injection denial to target_host_permission_required", async () => {
  const chrome = makeChrome({ incognitoTab: { id: 20, windowId: 2, active: true, incognito: true, activeTabGranted: false } });
  const result = await createTotpLabController(chrome).run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });
  assert.equal(result.error, "target_host_permission_required");
});
```

在 `extension/tests/sms-lab-controller.test.mjs` 把对应权限断言改为 `target_host_permission_required`，并在 `background.test.mjs` 增加 `run_totp_lab` 对 `excelRow: 1` 和布尔值的 `request_invalid` 路由测试。

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```powershell
python -m unittest native_host.tests.test_totp_lab -v
node --test extension/tests/totp-lab-controller.test.mjs extension/tests/sms-lab-controller.test.mjs extension/tests/background.test.mjs
```

Expected: FAIL because TOTP still accepts row 1 and controllers still expose `incognito_active_tab_required`.

- [ ] **Step 3: 收紧校验并统一错误码**

修改 `native_host/cc_batch/totp_lab.py`：

```python
if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
    raise TotpLabError("excel_row_invalid")
```

在 `native_host/host.py::_get_totp_lab_challenge` 首行加入与 SMS 相同的严格字段白名单：

```python
if set(message) - {"command", "excel_row", "request_id"}:
    return {"ok": False, "error": "request_invalid", "fatal": False}
```

修改 `extension/totp-lab-controller.js::assertTabs` 为 `excelRow < 2`，并把两个 Lab 控制器目标注入失败统一映射为：

```js
throw new Error("target_host_permission_required");
```

修改 `extension/background.js::validateTotpLabMessage`：

```js
function validateTotpLabMessage(message) {
  return hasExactKeys(message, allowedTotpLabKeys) &&
    isPositiveInteger(message?.motherTabId) &&
    isPositiveInteger(message?.incognitoTabId) &&
    Number.isInteger(message?.excelRow) &&
    typeof message.excelRow !== "boolean" &&
    message.excelRow >= 2;
}
```

- [ ] **Step 4: 运行目标测试和扩展回归**

Run:

```powershell
python -m unittest native_host.tests.test_totp_lab native_host.tests.test_host_protocol -v
node --test extension/tests/totp-lab-controller.test.mjs extension/tests/sms-lab-controller.test.mjs extension/tests/background.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 5: 提交 Task 2**

```powershell
git add native_host/cc_batch/totp_lab.py native_host/tests/test_totp_lab.py native_host/host.py extension/totp-lab-controller.js extension/sms-lab-controller.js extension/background.js extension/tests/totp-lab-controller.test.mjs extension/tests/sms-lab-controller.test.mjs extension/tests/background.test.mjs
git commit -m "Keep all MFA routes below the Excel header" `
  -m "Reject physical row 1 everywhere and expose one permission error whether access comes from activeTab or an exact host grant." `
  -m "Constraint: Workflow data starts at physical row 2" `
  -m "Confidence: high" `
  -m "Scope-risk: moderate" `
  -m "Tested: Native TOTP tests and full extension tests" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 3: 锁定工作流配置、URL 和状态纯函数

**Files:**
- Create: `extension/workflow-selectors.js`
- Create: `extension/workflow-urls.js`
- Create: `extension/workflow-state.js`
- Create: `extension/workflow-page-context.js`
- Create: `extension/tests/workflow-selectors.test.mjs`
- Create: `extension/tests/workflow-urls.test.mjs`
- Create: `extension/tests/workflow-state.test.mjs`
- Create: `extension/tests/workflow-page-context.test.mjs`

- [ ] **Step 1: 写配置、URL 和状态失败测试**

`extension/tests/workflow-selectors.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_SELECTORS, requireWorkflowSelectors } from "../workflow-selectors.js";

test("requires exact final mother selectors and preserves semantic fallbacks", () => {
  assert.equal(WORKFLOW_SELECTORS.loginUsername, "#username");
  assert.equal(WORKFLOW_SELECTORS.loginPassword, "#password");
  assert.throws(() => requireWorkflowSelectors(WORKFLOW_SELECTORS), /selector_not_configured/);
  const configured = requireWorkflowSelectors({
    ...WORKFLOW_SELECTORS,
    motherFinalUrlInput: "#result-url",
    motherFinalConfirmButton: "#save-result",
    motherFinalSuccess: ".save-success",
  });
  assert.equal(configured.motherFinalUrlInput, "#result-url");
  assert.ok(Object.isFrozen(configured));
});
```

`extension/tests/workflow-urls.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { makeHandoffUrl, validateAuthorizationUrl, validateFinalUrl } from "../workflow-urls.js";

test("accepts only the configured authorization origin", () => {
  assert.equal(
    validateAuthorizationUrl("http://auth-target.local/start?id=1", "http://auth-target.local"),
    "http://auth-target.local/start?id=1",
  );
  for (const value of [
    "https://auth-target.local/start",
    "http://evil.local/start",
    "http://user:pass@auth-target.local/start",
    "http://auth-target.local/start#fragment",
  ]) assert.throws(() => validateAuthorizationUrl(value, "http://auth-target.local"));
});

test("builds one exact about blank handoff marker", () => {
  assert.equal(makeHandoffUrl("batch-123"), "about:blank#whalestest-handoff-batch-123");
  assert.throws(() => makeHandoffUrl("bad id"), /batch_id_invalid/);
});

test("final URL is http or https without URL credentials", () => {
  assert.equal(validateFinalUrl("https://final.test/home"), "https://final.test/home");
  assert.throws(() => validateFinalUrl("javascript:alert(1)"), /final_url_invalid/);
});
```

`extension/tests/workflow-state.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowState, formatAccountName, nextRowState, publicWorkflowState } from "../workflow-state.js";

test("starts every batch at sequence one and physical row two", () => {
  const state = createWorkflowState({ batchId: "batch-1", motherTabId: 10, motherWindowId: 1, now: 0 });
  assert.equal(state.sequence, 1);
  assert.equal(state.excelRow, 2);
  assert.equal(state.stage, "ROW_PREFLIGHT");
});

test("advances sequence only through the commit reducer", () => {
  const next = nextRowState({ sequence: 1, excelRow: 2 });
  assert.deepEqual(next, { sequence: 2, excelRow: 3 });
});

test("formats the approved minute precision account name", () => {
  assert.equal(formatAccountName(new Date(2026, 6, 19, 14, 38), 3), "20260719-1438 SHARKPIX PLUS 3");
});

test("public state removes tab ids and all secret-bearing fields", () => {
  const value = publicWorkflowState({ stage: "LOGIN", batchId: "b", sequence: 1, excelRow: 2, incognitoTabId: 20, password: "secret" });
  assert.deepEqual(value, { running: true, state: "LOGIN", batchId: "b", sequence: 1, excelRow: 2, error: "", updatedAt: null });
});
```

`extension/tests/workflow-page-context.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cancelWorkflowOnPage, registerWorkflowOnPage } from "../workflow-page-context.js";

test("registers one page token, aborts a replaced token, and cancels by run id", () => {
  const key = "__whalestestWorkflowRunControllers__";
  delete globalThis[key];
  assert.deepEqual(registerWorkflowOnPage({ runId: "batch-1" }), { ok: true });
  const first = globalThis[key].get("batch-1");
  assert.deepEqual(registerWorkflowOnPage({ runId: "batch-1" }), { ok: true });
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(cancelWorkflowOnPage({ runId: "batch-1" }), { ok: true });
  assert.equal(globalThis[key].has("batch-1"), false);
  delete globalThis[key];
});

test("rejects empty run ids without creating a registry", () => {
  delete globalThis.__whalestestWorkflowRunControllers__;
  assert.deepEqual(registerWorkflowOnPage({ runId: "" }), { ok: false, error: "request_invalid" });
  assert.equal(globalThis.__whalestestWorkflowRunControllers__, undefined);
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/workflow-selectors.test.mjs extension/tests/workflow-urls.test.mjs extension/tests/workflow-state.test.mjs extension/tests/workflow-page-context.test.mjs`

Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: 实现选择器配置**

创建 `extension/workflow-selectors.js`：

```js
export const WORKFLOW_SELECTORS = Object.freeze({
  accountManagement: "",
  addAccount: "",
  accountDialog: "",
  accountNameInput: "",
  platformControl: "",
  platformOptions: "",
  groupContainer: "",
  nextButton: "",
  generateLinkSection: "",
  generateLinkButton: "",
  authorizationUrl: "",
  copyUrlButton: "",
  loginUsername: "#username",
  loginPassword: "#password",
  loginSubmitButton: "",
  loginError: "",
  totpStage: "input[autocomplete='one-time-code'][name='code']",
  acceptButton: "",
  finalPageReady: "",
  motherFinalUrlInput: "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
  motherFinalConfirmButton: "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
  motherFinalSuccess: "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
});

const REQUIRED_EXACT = Object.freeze({
  motherFinalUrlInput: "__FILL_MOTHER_FINAL_URL_INPUT_SELECTOR__",
  motherFinalConfirmButton: "__FILL_MOTHER_FINAL_CONFIRM_BUTTON_SELECTOR__",
  motherFinalSuccess: "__FILL_MOTHER_FINAL_SUCCESS_SELECTOR__",
});

export function requireWorkflowSelectors(candidate = WORKFLOW_SELECTORS) {
  const copy = { ...WORKFLOW_SELECTORS, ...candidate };
  for (const [key, marker] of Object.entries(REQUIRED_EXACT)) {
    if (typeof copy[key] !== "string" || !copy[key] || copy[key] === marker) {
      throw new Error("selector_not_configured");
    }
  }
  return Object.freeze(copy);
}
```

- [ ] **Step 4: 实现 URL 纯函数**

创建 `extension/workflow-urls.js`：

```js
function parseHttpUrl(value, errorCode) {
  if (typeof value !== "string" || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(errorCode);
  let url;
  try { url = new URL(value); } catch { throw new Error(errorCode); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(errorCode);
  return url;
}

export function validateAuthorizationUrl(value, expectedOrigin) {
  const url = parseHttpUrl(value, "authorization_url_invalid");
  if (url.origin !== expectedOrigin || url.hash) throw new Error("authorization_origin_mismatch");
  return url.toString();
}

export function validateFinalUrl(value) {
  return parseHttpUrl(value, "final_url_invalid").toString();
}

export function makeHandoffUrl(batchId) {
  if (typeof batchId !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(batchId)) throw new Error("batch_id_invalid");
  return `about:blank#whalestest-handoff-${batchId}`;
}
```

- [ ] **Step 5: 实现状态纯函数**

创建 `extension/workflow-state.js`：

```js
export const TERMINAL_STAGES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export function createWorkflowState({ batchId, motherTabId, motherWindowId, now = Date.now() }) {
  return {
    batchId,
    stage: "ROW_PREFLIGHT",
    sequence: 1,
    excelRow: 2,
    motherTabId,
    motherWindowId,
    incognitoTabId: null,
    incognitoWindowId: null,
    attempt: 0,
    loginSubmittedAt: null,
    error: "",
    startedAt: now,
    updatedAt: now,
  };
}

export function nextRowState({ sequence, excelRow }) {
  if (!Number.isInteger(sequence) || !Number.isInteger(excelRow) || excelRow !== sequence + 1) throw new Error("workflow_state_invalid");
  return { sequence: sequence + 1, excelRow: excelRow + 1 };
}

export function formatAccountName(date, sequence) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf()) || !Number.isInteger(sequence) || sequence < 1) throw new Error("account_name_invalid");
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())} SHARKPIX PLUS ${sequence}`;
}

export function publicWorkflowState(state) {
  if (!state) return { running: false, state: "IDLE", batchId: null, sequence: 0, excelRow: 0, error: "", updatedAt: null };
  return {
    running: !TERMINAL_STAGES.has(state.stage),
    state: state.stage,
    batchId: state.batchId,
    sequence: state.sequence,
    excelRow: state.excelRow,
    error: state.error || "",
    updatedAt: state.updatedAt ?? null,
  };
}
```

- [ ] **Step 6: 实现可中止页面令牌**

创建 `extension/workflow-page-context.js`：

```js
export function registerWorkflowOnPage({ runId } = {}) {
  const registryKey = "__whalestestWorkflowRunControllers__";
  if (typeof runId !== "string" || runId.length === 0) return { ok: false, error: "request_invalid" };
  const registry = globalThis[registryKey] ?? new Map();
  globalThis[registryKey] = registry;
  registry.get(runId)?.abort?.();
  registry.set(runId, new AbortController());
  return { ok: true };
}

export function cancelWorkflowOnPage({ runId } = {}) {
  const registryKey = "__whalestestWorkflowRunControllers__";
  const registry = globalThis[registryKey];
  const controller = typeof runId === "string" ? registry?.get?.(runId) : null;
  controller?.abort?.();
  registry?.delete?.(runId);
  return { ok: true };
}
```

- [ ] **Step 7: 运行纯函数测试和扩展回归**

Run:

```powershell
node --test extension/tests/workflow-selectors.test.mjs extension/tests/workflow-urls.test.mjs extension/tests/workflow-state.test.mjs extension/tests/workflow-page-context.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: 提交 Task 3**

```powershell
git add extension/workflow-selectors.js extension/workflow-urls.js extension/workflow-state.js extension/workflow-page-context.js extension/tests/workflow-selectors.test.mjs extension/tests/workflow-urls.test.mjs extension/tests/workflow-state.test.mjs extension/tests/workflow-page-context.test.mjs
git commit -m "Lock workflow selectors URLs and sequence state" `
  -m "Define fail-closed configuration, exact authorization boundaries, incognito handoff markers, and the only sequence advancement reducer." `
  -m "Constraint: Final mother-page selectors must never use fuzzy fallback" `
  -m "Confidence: high" `
  -m "Scope-risk: narrow" `
  -m "Tested: workflow selector, URL, and state unit tests plus extension regression" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 4: 实现母页账号创建、授权链接和最终回填页面动作

**Files:**
- Create: `extension/mother-page.js`
- Create: `extension/tests/mother-page.test.mjs`
- Create: `extension/tests/page-fixture.mjs`

- [ ] **Step 1: 写母页动作失败测试夹具**

创建 `extension/tests/page-fixture.mjs`，供 Task 4 和 Task 5 共同导入：

```js
export function element({ text = "", value = "", disabled = false, checked = false, href = "", children = [] } = {}) {
  return {
    textContent: text,
    value,
    disabled,
    checked,
    href,
    children,
    clicked: 0,
    events: [],
    getAttribute(name) { return name === "aria-disabled" ? (this.disabled ? "true" : "false") : null; },
    getBoundingClientRect() { return { width: 50, height: 20, top: 0, left: 0 }; },
    scrollIntoView() {},
    dispatchEvent(event) { this.events.push(event.type); return true; },
    click() { this.clicked += 1; this.checked = true; },
    querySelectorAll(selector) { return selector === "input[type='checkbox']" ? children : []; },
  };
}

export function environment({ one = {}, many = {} } = {}) {
  return {
    document: {
      readyState: "complete",
      documentElement: {},
      querySelector(selector) { return one[selector] ?? null; },
      querySelectorAll(selector) { return many[selector] ?? []; },
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    },
    Event: class { constructor(type) { this.type = type; } },
    PointerEvent: class { constructor(type) { this.type = type; } },
    now: () => 0,
    sleep: async () => {},
    waitForQuiet: async () => {},
  };
}
```

`extension/tests/mother-page.test.mjs` 顶部明确导入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { backfillFinalUrlOnPage, generateAuthorizationUrlOnPage, prepareMotherAccountOnPage } from "../mother-page.js";
```

- [ ] **Step 2: 写账号创建、第二个平台和全选分组测试**

```js
test("fills the approved account name, selects platform two, and checks every group", async () => {
  const accountManagement = element();
  const addAccount = element();
  const accountName = element();
  const platform = element();
  const firstOption = element({ text: "平台一" });
  const secondOption = element({ text: "平台二" });
  const groups = [element(), element({ checked: true }), element()];
  const next = element();
  const env = environment({
    one: {
      "#account-management": accountManagement,
      "#add-account": addAccount,
      "#account-name": accountName,
      "#platform": platform,
      "#groups": element({ children: groups }),
      "#next": next,
    },
    many: { ".platform-option": [firstOption, secondOption] },
  });
  const result = await prepareMotherAccountOnPage({
    accountName: "20260719-1438 SHARKPIX PLUS 1",
    selectors: {
      accountManagement: "#account-management",
      addAccount: "#add-account",
      accountNameInput: "#account-name",
      platformControl: "#platform",
      platformOptions: ".platform-option",
      groupContainer: "#groups",
      nextButton: "#next",
    },
  }, env);
  assert.deepEqual(result, { ok: true });
  assert.equal(accountName.value, "20260719-1438 SHARKPIX PLUS 1");
  assert.equal(secondOption.clicked, 1);
  assert.ok(groups.every((item) => item.checked));
  assert.equal(next.clicked, 1);
});
```

加入以下表驱动边界测试：

```js
const baseSelectors = {
  accountManagement: "#manager", addAccount: "#add", accountNameInput: "#name",
  platformControl: "#platform", platformOptions: ".platform-option",
  groupContainer: "#groups", nextButton: "#next", generateLinkSection: "#generate-section",
};

test("rejects ambiguous Add Account text fallback", async () => {
  const result = await prepareMotherAccountOnPage({ accountName: "20260719-1438 SHARKPIX PLUS 1", selectors: { ...baseSelectors, addAccount: "" }, timeoutMs: 1 }, environment({
    one: { "#manager": element() },
    many: { "button,[role='button'],a": [element({ text: "添加账号" }), element({ text: "添加账号" })] },
  }));
  assert.equal(result.error, "element_ambiguous");
});

test("requires a second enabled platform option", async () => {
  const result = await prepareMotherAccountOnPage({ accountName: "20260719-1438 SHARKPIX PLUS 1", selectors: baseSelectors }, environment({
    one: { "#manager": element(), "#add": element(), "#name": element(), "#platform": element() },
    many: { ".platform-option": [element()] },
  }));
  assert.equal(result.error, "platform_option_missing");
});

test("requires at least one group checkbox", async () => {
  const result = await prepareMotherAccountOnPage({ accountName: "20260719-1438 SHARKPIX PLUS 1", selectors: baseSelectors }, environment({
    one: { "#manager": element(), "#add": element(), "#name": element(), "#platform": element(), "#groups": element({ children: [] }) },
    many: { ".platform-option": [element(), element()] },
  }));
  assert.equal(result.error, "group_options_missing");
});

test("does not click next after the generate section is already visible", async () => {
  const next = element();
  const result = await prepareMotherAccountOnPage({ accountName: "20260719-1438 SHARKPIX PLUS 1", selectors: { ...baseSelectors, nextButton: "#next", generateLinkSection: "#generate-section" } }, environment({ one: { "#next": next, "#generate-section": element() } }));
  assert.deepEqual(result, { ok: true });
  assert.equal(next.clicked, 0);
});

test("stops before DOM side effects when the page token is aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  const env = environment({ one: { "#manager": element() } });
  env.signal = abort.signal;
  const result = await prepareMotherAccountOnPage({ accountName: "20260719-1438 SHARKPIX PLUS 1", selectors: baseSelectors }, env);
  assert.equal(result.error, "workflow_cancelled");
  assert.equal(env.document.querySelector("#manager").clicked, 0);
});
```

- [ ] **Step 3: 写授权链接和回填测试**

```js
test("uses one existing DOM URL without regenerating and then clicks COPY URL", async () => {
  const generate = element();
  const copy = element();
  const url = element({ value: "http://auth-target.local/start?id=7" });
  const env = environment({ one: { "#generate": generate, "#auth-url": url, "#copy": copy } });
  const result = await generateAuthorizationUrlOnPage({
    selectors: { generateLinkButton: "#generate", authorizationUrl: "#auth-url", copyUrlButton: "#copy" },
  }, env);
  assert.deepEqual(result, { ok: true, authorizationUrl: "http://auth-target.local/start?id=7" });
  assert.equal(generate.clicked, 0);
  assert.equal(copy.clicked, 1);
});

test("backfills only exact configured selectors and waits for success", async () => {
  const input = element();
  const confirm = element();
  const success = element();
  const one = { "#result-url": input, "#save": confirm };
  confirm.click = () => { confirm.clicked += 1; one[".saved"] = success; };
  const env = environment({ one });
  const result = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: {
      motherFinalUrlInput: "#result-url",
      motherFinalConfirmButton: "#save",
      motherFinalSuccess: ".saved",
    },
  }, env);
  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, "https://final.test/home");
  assert.equal(confirm.clicked, 1);
});

test("treats an existing mother success marker as an idempotent completed backfill", async () => {
  const confirm = element();
  const result = await backfillFinalUrlOnPage({
    finalUrl: "https://final.test/home",
    selectors: { motherFinalUrlInput: "#result-url", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" },
  }, environment({ one: { "#result-url": element(), "#save": confirm, ".saved": element() } }));
  assert.deepEqual(result, { ok: true });
  assert.equal(confirm.clicked, 0);
});
```

再用下列明确断言覆盖 URL 和回填失败：

```js
test("rejects missing and ambiguous authorization URLs", async () => {
  const missing = await generateAuthorizationUrlOnPage({ selectors: { generateLinkButton: "#generate", authorizationUrl: ".url", copyUrlButton: "#copy" }, timeoutMs: 1 }, environment({ one: { "#generate": element(), "#copy": element() } }));
  assert.equal(missing.error, "authorization_url_missing");
  const ambiguous = await generateAuthorizationUrlOnPage({ selectors: { authorizationUrl: ".url", copyUrlButton: "#copy" } }, environment({ one: { "#copy": element() }, many: { ".url": [element({ value: "http://auth-target.local/a" }), element({ value: "http://auth-target.local/b" })] } }));
  assert.equal(ambiguous.error, "authorization_url_ambiguous");
});

test("fails closed when final selectors or success are missing", async () => {
  const unconfigured = await backfillFinalUrlOnPage({ finalUrl: "https://final.test/home", selectors: {} }, environment());
  assert.equal(unconfigured.error, "selector_not_configured");
  const noSuccess = await backfillFinalUrlOnPage({ finalUrl: "https://final.test/home", selectors: { motherFinalUrlInput: "#url", motherFinalConfirmButton: "#save", motherFinalSuccess: ".saved" }, timeoutMs: 1 }, environment({ one: { "#url": element(), "#save": element() } }));
  assert.equal(noSuccess.error, "mother_backfill_failed");
});
```

- [ ] **Step 4: 运行测试并确认红灯**

Run: `node --test extension/tests/mother-page.test.mjs`

Expected: FAIL because `mother-page.js` does not exist.

- [ ] **Step 5: 实现自包含稳定等待和元素定位**

创建 `extension/mother-page.js`。三个导出函数内部不得依赖模块级 DOM helper，因为 `chrome.scripting.executeScript({func})` 会序列化函数。每个函数使用相同的内嵌规则：

```js
const documentObject = env.document ?? globalThis.document;
const EventCtor = env.Event ?? globalThis.Event;
const PointerEventCtor = env.PointerEvent ?? globalThis.PointerEvent ?? EventCtor;
const now = env.now ?? Date.now;
const registry = globalThis.__whalestestWorkflowRunControllers__;
const signal = requireExistingToken ? registry?.get?.(runId)?.signal : env.signal;
if (requireExistingToken && !signal) return { ok: false, error: "workflow_page_context_reset" };
if (signal?.aborted) return { ok: false, error: "workflow_cancelled" };
const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
const waitForQuiet = env.waitForQuiet ?? ((ms) => new Promise((resolve) => {
  const Observer = env.MutationObserver ?? globalThis.MutationObserver;
  if (!Observer || !documentObject?.documentElement) return setTimeout(resolve, ms);
  let timer;
  const observer = new Observer(() => {
    clearTimeout(timer);
    timer = setTimeout(done, ms);
  });
  const done = () => { observer.disconnect(); resolve(); };
  observer.observe(documentObject.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(done, ms);
}));
const visible = (node) => {
  if (!node || node.disabled || node.getAttribute?.("aria-disabled") === "true") return false;
  const rect = node.getBoundingClientRect?.();
  const style = documentObject.defaultView?.getComputedStyle?.(node);
  return (!rect || (rect.width > 0 && rect.height > 0)) && style?.display !== "none" && style?.visibility !== "hidden";
};
```

所有查找都在 30 秒 deadline 内轮询，并在每次轮询、sleep 和 DOM quiet 前后检查 `signal.aborted`；取消时返回 `workflow_cancelled`。动作后调用 `waitForQuiet(500)`。精确 selector 返回多个可见候选或文本回退返回多个候选时必须返回 `element_ambiguous`。

- [ ] **Step 6: 实现 `prepareMotherAccountOnPage`**

函数签名固定为：

```js
export async function prepareMotherAccountOnPage({ runId, requireExistingToken = false, accountName, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
```

实现顺序固定为：

```js
// 1. 如果 generateLinkSection 已经可见，直接 return { ok: true }。
// 2. 点击 accountManagement 或唯一文本“账号管理”。
// 3. 点击 addAccount 或唯一文本“添加账号”。
// 4. 用 selector 或“账号名称”label 关联输入框，写入 accountName 并触发 input/change。
// 5. 点击 platformControl；在对应可见 listbox 或 platformOptions 中选择第二个未禁用项。
// 6. 在 groupContainer 中获取 input[type='checkbox']，把未选项逐个 click。
// 7. 点击 nextButton 或对话框内唯一文本“下一步”。
// 8. 等待 generateLinkSection 或生成按钮可见，return { ok: true }。
```

鼠标选择平台前执行 `scrollIntoView({block: "center"})`，按顺序 dispatch `pointerover`、`mousemove`、`pointerdown`、`mousedown`、`pointerup`、`mouseup`，最后调用 `click()`。

- [ ] **Step 7: 实现授权 URL 和最终回填动作**

函数签名：

```js
export async function generateAuthorizationUrlOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
export async function backfillFinalUrlOnPage({ runId, requireExistingToken = false, finalUrl, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
```

`generateAuthorizationUrlOnPage` 先读取已有唯一 URL；只有不存在时才点击唯一“生成授权链接”。URL 候选依次读取 `value`、`href`、`textContent`，只收集以 `http://` 或 `https://` 开头的完整字符串。取得唯一 URL 后点击相邻配置的 COPY URL 按钮，返回 `{ok:true, authorizationUrl}`，不调用 Clipboard API。

`backfillFinalUrlOnPage` 必须要求三个精确 selector。它先检查 `motherFinalSuccess`；若已经唯一可见则直接返回 `{ok:true}`，避免 Service Worker 恢复时重复提交。否则填写 final URL、dispatch `input/change`、点击确认，并等待 `motherFinalSuccess` 唯一可见后返回 `{ok:true}`。

- [ ] **Step 8: 运行母页测试和扩展回归**

Run:

```powershell
node --test extension/tests/mother-page.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 9: 提交 Task 4**

```powershell
git add extension/mother-page.js extension/tests/mother-page.test.mjs extension/tests/page-fixture.mjs
git commit -m "Make mother-page side effects stable and idempotent" `
  -m "Add bounded DOM actions for account creation, platform and group selection, authorization URL extraction, COPY URL, and exact final backfill." `
  -m "Constraint: Clipboard contents are never read" `
  -m "Confidence: high" `
  -m "Scope-risk: moderate" `
  -m "Tested: mother-page action tests and full extension regression" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 5: 实现登录、TOTP 阶段检测和接受页面动作

**Files:**
- Create: `extension/login-page.js`
- Create: `extension/final-page.js`
- Create: `extension/tests/login-page.test.mjs`
- Create: `extension/tests/final-page.test.mjs`

- [ ] **Step 1: 写登录页面失败测试**

在 `extension/tests/login-page.test.mjs` 导入共享夹具并加入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { detectTotpStageOnPage, submitLoginOnPage } from "../login-page.js";

test("fills exact username and password then submits once", async () => {
  const username = element();
  const password = element();
  const submit = element();
  const env = environment({ one: { "#username": username, "#password": password, "#login": submit } });
  const result = await submitLoginOnPage({
    username: "alice",
    password: "secret",
    selectors: { loginUsername: "#username", loginPassword: "#password", loginSubmitButton: "#login" },
  }, env);
  assert.deepEqual(result, { ok: true });
  assert.equal(username.value, "alice");
  assert.equal(password.value, "secret");
  assert.deepEqual(username.events, ["input", "change"]);
  assert.equal(submit.clicked, 1);
});

test("detects login rejection before reporting a missing TOTP stage", async () => {
  const env = environment({ one: { ".login-error": element({ text: "bad credentials" }) } });
  const result = await detectTotpStageOnPage({
    selectors: { loginError: ".login-error", totpStage: "#totp" },
    timeoutMs: 1,
  }, env);
  assert.deepEqual(result, { ok: false, error: "login_rejected" });
});
```

加入明确边界测试：

```js
test("rejects invalid credentials and page-rewritten input values", async () => {
  assert.equal((await submitLoginOnPage({ username: "", password: "secret", selectors: {} }, environment())).error, "credentials_invalid");
  const username = element();
  const password = element();
  Object.defineProperty(password, "value", { get: () => "rewritten", set: () => {} });
  const result = await submitLoginOnPage({ username: "alice", password: "secret", selectors: { loginUsername: "#u", loginPassword: "#p", loginSubmitButton: "#s" } }, environment({ one: { "#u": username, "#p": password, "#s": element() } }));
  assert.equal(result.error, "login_input_rejected");
});

test("requires one submit fallback and recognizes the TOTP stage", async () => {
  const ambiguous = await submitLoginOnPage({ username: "alice", password: "secret", selectors: { loginUsername: "#u", loginPassword: "#p", loginSubmitButton: "" } }, environment({ one: { "#u": element(), "#p": element() }, many: { "button[type='submit']": [element(), element()] } }));
  assert.equal(ambiguous.error, "element_ambiguous");
  const totp = await detectTotpStageOnPage({ selectors: { loginError: ".error", totpStage: "#totp" } }, environment({ one: { "#totp": element() } }));
  assert.deepEqual(totp, { ok: true });
});
```

30 秒最短等待由控制器测试覆盖，页面函数测试不得加入固定 sleep。

- [ ] **Step 2: 写接受与最终页面失败测试**

在 `extension/tests/final-page.test.mjs` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { element, environment } from "./page-fixture.mjs";
import { clickAcceptOnPage, detectFinalPageOnPage } from "../final-page.js";

test("clicks one configured accept button", async () => {
  const accept = element({ text: "Accept" });
  const result = await clickAcceptOnPage({ selectors: { acceptButton: "#accept" } }, environment({ one: { "#accept": accept } }));
  assert.deepEqual(result, { ok: true });
  assert.equal(accept.clicked, 1);
});

test("uses only a unique visible Accept text fallback", async () => {
  const result = await clickAcceptOnPage({ selectors: { acceptButton: "" } }, environment({ many: { "button,[role='button']": [element({ text: "Accept" }), element({ text: "Other" })] } }));
  assert.deepEqual(result, { ok: true });
});

test("final page readiness can be exact or URL-stable", async () => {
  const result = await detectFinalPageOnPage({ selectors: { finalPageReady: ".home" } }, environment({ one: { ".home": element() } }));
  assert.deepEqual(result, { ok: true });
});
```

加入明确失败测试：

```js
test("rejects ambiguous or missing Accept buttons", async () => {
  const ambiguous = await clickAcceptOnPage({ selectors: { acceptButton: "" }, timeoutMs: 1 }, environment({ many: { "button,[role='button']": [element({ text: "Accept" }), element({ text: "接受" })] } }));
  assert.equal(ambiguous.error, "element_ambiguous");
  const missing = await clickAcceptOnPage({ selectors: { acceptButton: "" }, timeoutMs: 1 }, environment({ many: { "button,[role='button']": [] } }));
  assert.equal(missing.error, "accept_button_missing");
});

test("requires a unique configured final marker and otherwise returns only readiness", async () => {
  const ambiguous = await detectFinalPageOnPage({ selectors: { finalPageReady: ".home" }, timeoutMs: 1 }, environment({ many: { ".home": [element(), element()] } }));
  assert.equal(ambiguous.error, "element_ambiguous");
  assert.deepEqual(await detectFinalPageOnPage({ selectors: { finalPageReady: "" } }, environment()), { ok: true });
});
```

这些返回对象不得包含 Cookie、页面正文或 URL。

- [ ] **Step 3: 运行测试并确认红灯**

Run: `node --test extension/tests/login-page.test.mjs extension/tests/final-page.test.mjs`

Expected: FAIL because `login-page.js` and `final-page.js` do not exist.

- [ ] **Step 4: 实现登录页面动作**

创建 `extension/login-page.js`，导出：

```js
export async function submitLoginOnPage({ runId, requireExistingToken = false, username, password, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
export async function detectTotpStageOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
```

两个函数复制 Task 4 的自包含稳定等待和页面令牌规则。生产调用传 `runId: batchId`、`requireExistingToken: true`；直接单元测试保持默认 false。`submitLoginOnPage` 必须：

```js
if (typeof username !== "string" || !username || typeof password !== "string" || !password) {
  return { ok: false, error: "credentials_invalid" };
}
// 等待 #username/#password；写值；dispatch input/change；重新读取值；
// 使用精确 selector 或唯一 button[type='submit']；click 一次；等待 DOM quiet；
// 返回 { ok: true }，不得返回 username/password。
```

`detectTotpStageOnPage` 在 deadline 内优先检查唯一可见 `loginError`，其次检查唯一可见 `totpStage`；前者返回 `login_rejected`，后者返回 `{ok:true}`，超时返回 `totp_stage_not_reached`。

- [ ] **Step 5: 实现接受和最终页面动作**

创建 `extension/final-page.js`，导出：

```js
export async function clickAcceptOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
export async function detectFinalPageOnPage({ runId, requireExistingToken = false, selectors, timeoutMs = 30_000, quietMs = 500 } = {}, env = {})
```

`clickAcceptOnPage` 优先精确 selector，否则在可见 `button,[role='button']` 中对规范化文本 `接受` 或 `Accept` 做唯一匹配。`detectFinalPageOnPage` 在配置 `finalPageReady` 时等待唯一可见元素；未配置时只等待 document ready + 500ms DOM quiet，由控制器负责验证最终 tab URL。

- [ ] **Step 6: 运行页面测试和扩展回归**

Run:

```powershell
node --test extension/tests/login-page.test.mjs extension/tests/final-page.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: 提交 Task 5**

```powershell
git add extension/login-page.js extension/final-page.js extension/tests/login-page.test.mjs extension/tests/final-page.test.mjs
git commit -m "Separate login and acceptance page actions" `
  -m "Add stable credential submission, login rejection detection, TOTP stage gating, unique Accept handling, and final page readiness checks." `
  -m "Constraint: Login submission is checked no earlier than 30 seconds by the outer workflow controller" `
  -m "Confidence: high" `
  -m "Scope-risk: moderate" `
  -m "Tested: login/final page action tests and full extension regression" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 6: 建立可恢复控制器并完成母页到无痕授权页

**Files:**
- Create: `extension/workflow-controller.js`
- Create: `extension/tests/workflow-controller.test.mjs`

- [ ] **Step 1: 写 Chrome API 测试夹具**

在 `extension/tests/workflow-controller.test.mjs` 创建完全内存化的 fake API。测试不得启动真实 Chrome：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowController } from "../workflow-controller.js";
import { WORKFLOW_SELECTORS } from "../workflow-selectors.js";
import { createWorkflowState } from "../workflow-state.js";

const configuredSelectors = Object.freeze({
  ...WORKFLOW_SELECTORS,
  motherFinalUrlInput: "#result-url",
  motherFinalConfirmButton: "#save-result",
  motherFinalSuccess: ".save-success",
});

function minimalOptions(overrides = {}) {
  return {
    now: () => 1_000,
    makeBatchId: () => "batch-0000",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async () => ({ ok: false, error: "excel_exhausted" }),
    pageActions: {},
    totpLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => {} },
    smsLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => {} },
    ...overrides,
  };
}

function makeChrome({ motherUrl = "http://127.0.0.1:9527/" } = {}) {
  const session = {};
  const alarms = new Map();
  const tabs = new Map([[10, { id: 10, windowId: 1, index: 0, active: true, incognito: false, url: motherUrl, status: "complete" }]]);
  const windows = new Map([[1, { id: 1, incognito: false, focused: true }]]);
  let nextTabId = 20;
  let nextWindowId = 2;
  const calls = [];
  return {
    calls,
    session,
    alarmsByName: alarms,
    tabsById: tabs,
    windowsById: windows,
    storage: {
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, structuredClone(values)); calls.push(["session.set", structuredClone(values)]); },
        async remove(key) { delete session[key]; },
      },
    },
    alarms: {
      create(name, info) { alarms.set(name, { name, ...info }); calls.push(["alarm.create", name, info]); },
      async clear(name) { return alarms.delete(name); },
    },
    tabs: {
      async query(query) {
        if (query.active && query.currentWindow) return [...tabs.values()].filter((tab) => tab.active && tab.windowId === 1);
        return [...tabs.values()].filter((tab) => query.incognito == null || tab.incognito === query.incognito);
      },
      async get(id) { const tab = tabs.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return { ...tab }; },
      async update(id, changes) { Object.assign(tabs.get(id), changes, { status: "complete" }); calls.push(["tabs.update", id, changes]); return { ...tabs.get(id) }; },
      async remove(id) { tabs.delete(id); calls.push(["tabs.remove", id]); },
    },
    windows: {
      async create(details) {
        const windowId = nextWindowId++;
        const tabId = nextTabId++;
        windows.set(windowId, { id: windowId, incognito: Boolean(details.incognito), focused: Boolean(details.focused) });
        tabs.set(tabId, { id: tabId, windowId, index: 0, active: true, incognito: Boolean(details.incognito), url: details.url, status: "complete" });
        calls.push(["windows.create", details]);
        return { ...windows.get(windowId), tabs: [{ ...tabs.get(tabId) }] };
      },
      async update(id, changes) { Object.assign(windows.get(id), changes); return { ...windows.get(id) }; },
      async remove(id) { windows.delete(id); for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId); calls.push(["windows.remove", id]); },
    },
    scripting: {
      async executeScript(details) { calls.push(["executeScript", details.func?.name]); return [{ result: { ok: true } }]; },
    },
  };
}

async function fireNextAlarm(controller, chrome, nowRef) {
  const alarm = [...chrome.alarmsByName.values()][0];
  assert.ok(alarm, "expected one scheduled workflow alarm");
  chrome.alarmsByName.delete(alarm.name);
  if (typeof alarm.when === "number") nowRef.value = Math.max(nowRef.value, alarm.when);
  await controller.onAlarm(alarm);
}
```

- [ ] **Step 2: 写启动、预检、母页和 handoff 失败测试**

```js
test("binds sequence one to row two and reaches LOGIN through one owned incognito window", async () => {
  const chrome = makeChrome();
  const now = { value: new Date(2026, 6, 19, 14, 38).getTime() };
  const nativeCalls = [];
  const pageCalls = [];
  const controller = createWorkflowController(chrome, {
    now: () => now.value,
    makeBatchId: () => "batch-0001",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async (command, payload) => {
      nativeCalls.push([command, payload]);
      return { ok: true, username: "alice", password: "secret" };
    },
    pageActions: {
      prepareMother: async (args) => { pageCalls.push(["prepare", args]); return { ok: true }; },
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    },
  });
  await controller.start();
  while (controller.getState().state !== "LOGIN") await fireNextAlarm(controller, chrome, now);
  assert.deepEqual(nativeCalls[0], ["get_workflow_credentials", { excel_row: 2 }]);
  assert.equal(pageCalls[0][1].accountName, "20260719-1438 SHARKPIX PLUS 1");
  assert.equal([...chrome.windowsById.values()].filter((item) => item.incognito).length, 1);
  assert.equal(controller.getState().excelRow, 2);
  assert.equal(chrome.session.workflowState.incognitoTabId, 20);
  assert.equal(Object.hasOwn(chrome.session.workflowState, "password"), false);
});

test("fails before side effects when the active tab is not the exact mother URL", async () => {
  const chrome = makeChrome({ motherUrl: "http://127.0.0.1:9527/other" });
  const controller = createWorkflowController(chrome, minimalOptions());
  const result = await controller.start();
  assert.equal(result.error, "mother_url_invalid");
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
});
```

加入以下启动边界测试：

```js
test("rejects an incognito mother and unconfigured final selectors", async () => {
  const incognitoMother = makeChrome();
  incognitoMother.tabsById.get(10).incognito = true;
  assert.equal((await createWorkflowController(incognitoMother, minimalOptions()).start()).error, "mother_tab_incognito");
  const missingSelectors = makeChrome();
  assert.equal((await createWorkflowController(missingSelectors, minimalOptions({ selectors: WORKFLOW_SELECTORS })).start()).error, "selector_not_configured");
});

test("completes on row exhaustion before touching the mother page", async () => {
  const chrome = makeChrome();
  let motherCalls = 0;
  const controller = createWorkflowController(chrome, minimalOptions({ pageActions: { prepareMother: async () => { motherCalls += 1; return { ok: true }; } } }));
  await controller.start();
  await fireNextAlarm(controller, chrome, { value: 1_000 });
  assert.equal(controller.getState().state, "COMPLETED");
  assert.equal(motherCalls, 0);
});

test("rejects a mismatched authorization origin before creating incognito", async () => {
  const chrome = makeChrome();
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: { prepareMother: async () => ({ ok: true }), generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://evil.local/start" }) },
  }));
  await controller.start();
  for (let index = 0; index < 3; index += 1) await fireNextAlarm(controller, chrome, { value: 1_000 + index });
  assert.equal(controller.getState().error, "authorization_origin_mismatch");
  assert.equal(chrome.calls.some(([name]) => name === "windows.create"), false);
});

test("maps both workflow page injection rejection paths to target_host_permission_required", async () => {
  for (const rejectedFunction of ["registerWorkflowOnPage", "prepareMotherAccountOnPage"]) {
    const chrome = makeChrome();
    chrome.scripting.executeScript = async ({ func }) => {
      if (func?.name === rejectedFunction) throw new Error("Cannot access contents of the page");
      return [{ result: { ok: true } }];
    };
    const controller = createWorkflowController(chrome, minimalOptions({
      pageActions: undefined,
      requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    }));
    await controller.start();
    await fireNextAlarm(controller, chrome, { value: 1_000 }); // ROW_PREFLIGHT
    await fireNextAlarm(controller, chrome, { value: 1_001 }); // MOTHER_ACCOUNT
    assert.equal(controller.getState().error, "target_host_permission_required", rejectedFunction);
  }
});
```

- [ ] **Step 3: 运行测试并确认红灯**

Run: `node --test extension/tests/workflow-controller.test.mjs`

Expected: FAIL because `workflow-controller.js` does not exist.

- [ ] **Step 4: 建立控制器依赖和持久化骨架**

创建 `extension/workflow-controller.js`，导入：

```js
import { clickAcceptOnPage, detectFinalPageOnPage } from "./final-page.js";
import { detectTotpStageOnPage, submitLoginOnPage } from "./login-page.js";
import { backfillFinalUrlOnPage, generateAuthorizationUrlOnPage, prepareMotherAccountOnPage } from "./mother-page.js";
import { cancelWorkflowOnPage, registerWorkflowOnPage } from "./workflow-page-context.js";
import { requireWorkflowSelectors, WORKFLOW_SELECTORS } from "./workflow-selectors.js";
import { createWorkflowState, formatAccountName, nextRowState, publicWorkflowState } from "./workflow-state.js";
import { makeHandoffUrl, validateAuthorizationUrl, validateFinalUrl } from "./workflow-urls.js";
```

工厂签名固定为：

```js
export function createWorkflowController(api, options = {})
```

依赖默认值：

```js
const STATE_KEY = "workflowState";
const ALARM_PREFIX = "whalestest-workflow:";
const MOTHER_URL = "http://127.0.0.1:9527/";
const DEFAULT_TARGET_ORIGIN = "http://auth-target.local";
const now = options.now ?? Date.now;
const makeBatchId = options.makeBatchId ?? (() => globalThis.crypto.randomUUID());
const targetOrigin = options.targetOrigin ?? DEFAULT_TARGET_ORIGIN;
const rawSelectors = options.selectors ?? WORKFLOW_SELECTORS;
const configuredSelectors = () => requireWorkflowSelectors(rawSelectors);
const requestNative = options.requestNative ?? createNativeRequest(api);
const pageActions = options.pageActions ?? createInjectedPageActions();
```

`createInjectedPageActions()` 在控制器闭包内实现，确保每个页面动作都有可取消令牌：

```js
async function executePageAction(tabId, func, args = {}) {
  let registered;
  try {
    registered = await api.scripting.executeScript({
      target: { tabId }, world: "ISOLATED", func: registerWorkflowOnPage, args: [{ runId: state.batchId }],
    });
  } catch {
    throw new Error("target_host_permission_required");
  }
  if (!registered?.[0]?.result?.ok) throw new Error("target_host_permission_required");
  let results;
  try {
    results = await api.scripting.executeScript({
      target: { tabId }, world: "ISOLATED", func,
      args: [{ ...args, runId: state.batchId, requireExistingToken: true }],
    });
  } catch {
    throw new Error("target_host_permission_required");
  }
  return results?.[0]?.result ?? { ok: false, error: "page_action_failed" };
}

function createInjectedPageActions() {
  return {
    prepareMother: ({ tabId, ...args }) => executePageAction(tabId, prepareMotherAccountOnPage, args),
    generateAuthorization: ({ tabId, ...args }) => executePageAction(tabId, generateAuthorizationUrlOnPage, args),
    submitLogin: ({ tabId, ...args }) => executePageAction(tabId, submitLoginOnPage, args),
    detectTotp: ({ tabId, ...args }) => executePageAction(tabId, detectTotpStageOnPage, args),
    clickAccept: ({ tabId, ...args }) => executePageAction(tabId, clickAcceptOnPage, args),
    detectFinal: ({ tabId, ...args }) => executePageAction(tabId, detectFinalPageOnPage, args),
    backfillMother: ({ tabId, ...args }) => executePageAction(tabId, backfillFinalUrlOnPage, args),
  };
}
```

`createNativeRequest` 复用现有 Native Messaging 模式，但每个请求有 15 秒 timeout，响应按 `request_id` 匹配，disconnect 统一拒绝为 `native_host_unavailable`。任何公开状态都通过 `publicWorkflowState` 返回。

持久化和调度 helper：

```js
async function persist(next) {
  state = { ...next, updatedAt: now() };
  await api.storage.session.set({ [STATE_KEY]: state });
}

function schedule(delayMs = 0) {
  api.alarms.create(`${ALARM_PREFIX}${state.batchId}`, { when: now() + Math.max(0, delayMs) });
}

async function transition(stage, patch = {}) {
  await persist({ ...state, ...patch, stage, attempt: 0, error: "" });
  schedule(0);
}
```

- [ ] **Step 5: 实现启动与前四个阶段**

`start()` 必须：

```js
async function start() {
  if (state && !["COMPLETED", "FAILED", "CANCELLED"].includes(state.stage)) {
    return { ...publicWorkflowState(state), error: "workflow_running" };
  }
  if (options.isCcBatchRunning?.() === true) {
    return { ...publicWorkflowState(null), state: "FAILED", error: "another_workflow_running" };
  }
  try {
    configuredSelectors();
  } catch {
    return { ...publicWorkflowState(null), state: "FAILED", error: "selector_not_configured" };
  }
  const activeTabs = await api.tabs.query({ active: true, currentWindow: true });
  const motherTab = activeTabs?.[0];
  if (!motherTab) return { ...publicWorkflowState(null), state: "FAILED", error: "mother_tab_missing" };
  if (motherTab.incognito) return { ...publicWorkflowState(null), state: "FAILED", error: "mother_tab_incognito" };
  if (motherTab.url !== MOTHER_URL) return { ...publicWorkflowState(null), state: "FAILED", error: "mother_url_invalid" };
  state = createWorkflowState({
    batchId: makeBatchId(),
    motherTabId: motherTab.id,
    motherWindowId: motherTab.windowId,
    now: now(),
  });
  await persist(state);
  schedule(0);
  return publicWorkflowState(state);
}
```

`onAlarm(alarm)` 只接受当前批次 `${ALARM_PREFIX}${batchId}`，然后执行一个阶段并持久化下一个阶段：

```js
case "ROW_PREFLIGHT": {
  const response = await requestNative("get_workflow_credentials", { excel_row: state.excelRow });
  if (response.ok !== true) {
    if (response.error === "excel_exhausted") {
      await persist({ ...state, stage: "COMPLETED", error: "" });
      return;
    }
    throw new Error(response.error || "credentials_invalid");
  }
  await transition("MOTHER_ACCOUNT"); // response.username/password are not persisted.
  return;
}
case "MOTHER_ACCOUNT": {
  const result = await pageActions.prepareMother({
    tabId: state.motherTabId,
    accountName: formatAccountName(new Date(now()), state.sequence),
    selectors: configuredSelectors(),
  });
  if (!result?.ok) throw new Error(result?.error || "page_action_failed");
  await transition("AUTH_LINK");
  return;
}
case "AUTH_LINK": {
  const result = await pageActions.generateAuthorization({ tabId: state.motherTabId, selectors: configuredSelectors() });
  if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
  validateAuthorizationUrl(result.authorizationUrl, targetOrigin);
  await transition("OPEN_INCOGNITO");
  return;
}
case "OPEN_INCOGNITO": {
  const result = await pageActions.generateAuthorization({ tabId: state.motherTabId, selectors: configuredSelectors() });
  if (!result?.ok) throw new Error(result?.error || "authorization_url_missing");
  await openOwnedIncognito(validateAuthorizationUrl(result.authorizationUrl, targetOrigin));
  return;
}
```

`createInjectedPageActions()` 使用 `chrome.scripting.executeScript` 调用 Task 4/5 的导出函数，读取 `results?.[0]?.result`，无结果返回 `page_action_failed`。

- [ ] **Step 6: 实现无痕 handoff 所有权**

```js
async function openOwnedIncognito(authorizationUrl) {
  const markerUrl = makeHandoffUrl(state.batchId);
  let tab = state.incognitoTabId ? await getTabOrNull(state.incognitoTabId) : null;
  if (!tab) {
  const matches = (await api.tabs.query({})).filter((candidate) => candidate.incognito === true && candidate.url === markerUrl);
    if (matches.length > 1) throw new Error("incognito_window_ambiguous");
    tab = matches[0] ?? null;
  }
  if (!tab) {
    let created;
    try {
      created = await api.windows.create({ incognito: true, focused: true, type: "normal", url: markerUrl });
    } catch {
      throw new Error("incognito_access_required");
    }
    tab = created?.tabs?.[0];
    if (!created?.id || !tab?.id) throw new Error("incognito_access_required");
    await persist({ ...state, incognitoWindowId: created.id, incognitoTabId: tab.id });
  } else if (!state.incognitoTabId) {
    await persist({ ...state, incognitoWindowId: tab.windowId, incognitoTabId: tab.id });
  }
  if (tab.incognito !== true) throw new Error("incognito_access_required");
  const current = await api.tabs.get(tab.id);
  if (current.url === markerUrl) await api.tabs.update(tab.id, { url: authorizationUrl, active: true });
  else {
    let currentOrigin;
    try { currentOrigin = new URL(current.url).origin; } catch { throw new Error("authorization_origin_mismatch"); }
    if (currentOrigin !== targetOrigin) throw new Error("authorization_origin_mismatch");
  }
  await persist({ ...state, stage: "LOGIN", attempt: 0 });
  schedule(0);
}
```

已存在 target URL 时只允许匹配配置 origin；找不到 marker 时当前阶段只创建一次。重复 marker 直接失败并保留窗口。

- [ ] **Step 7: 运行第一阶段控制器测试**

Run: `node --test --test-name-pattern "binds sequence|exact mother|side effects|origin" extension/tests/workflow-controller.test.mjs`

Expected: matching tests PASS.

- [ ] **Step 8: 提交 Task 6**

```powershell
git add extension/workflow-controller.js extension/tests/workflow-controller.test.mjs
git commit -m "Own mother-page links and incognito handoff windows" `
  -m "Start a persisted workflow at row two, fail closed on the mother tab, generate one authorization URL, and adopt one batch-marked incognito window across worker restarts." `
  -m "Constraint: Incognito spanning cannot use extension pages as main-frame markers" `
  -m "Rejected: Open the authorization URL directly | a worker stop between window creation and ID persistence can duplicate windows" `
  -m "Confidence: high" `
  -m "Scope-risk: broad" `
  -m "Tested: workflow controller startup, preflight, URL, and handoff tests" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 7: 串联登录、TOTP、短信、接受、回填和序号提交

**Files:**
- Modify: `extension/workflow-controller.js`
- Modify: `extension/tests/workflow-controller.test.mjs`

- [ ] **Step 1: 写完整成功循环失败测试**

在 `workflow-controller.test.mjs` 加入：

```js
test("commits only after login MFA accept and mother backfill all succeed", async () => {
  const chrome = makeChrome();
  const now = { value: 1_000 };
  let credentialReads = 0;
  const stages = [];
  const controller = createWorkflowController(chrome, {
    now: () => now.value,
    makeBatchId: () => "batch-0002",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async (command, payload) => {
      if (command !== "get_workflow_credentials") throw new Error("unexpected_command");
      credentialReads += 1;
      if (payload.excel_row === 3) return { ok: false, error: "excel_exhausted" };
      return { ok: true, username: "alice", password: "secret" };
    },
    pageActions: {
      prepareMother: async () => ({ ok: true }),
      generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
      submitLogin: async () => ({ ok: true }),
      detectTotp: async () => ({ ok: true }),
      clickAccept: async () => ({ ok: true }),
      detectFinal: async () => ({ ok: true }),
      backfillMother: async ({ finalUrl }) => { stages.push(["backfill", finalUrl]); return { ok: true }; },
    },
    totpLabController: { run: async (request) => { stages.push(["totp", request]); return { state: "SUCCEEDED" }; }, cancel: async () => {} },
    smsLabController: { run: async (request) => { stages.push(["sms", request]); return { state: "SUCCEEDED" }; }, cancel: async () => {} },
  });
  await controller.start();
  let guard = 0;
  while (controller.getState().state !== "COMPLETED" && guard++ < 30) {
    if (controller.getState().state === "FINAL_URL") {
      const target = chrome.tabsById.get(chrome.session.workflowState.incognitoTabId);
      target.url = "https://final.test/home";
    }
    await fireNextAlarm(controller, chrome, now);
  }
  assert.equal(controller.getState().state, "COMPLETED");
  assert.equal(credentialReads, 3); // row 2 preflight + row 2 login + row 3 exhaustion
  assert.deepEqual(stages[0][1], { motherTabId: 10, incognitoTabId: 20, excelRow: 2 });
  assert.deepEqual(stages[1][1], { motherTabId: 10, incognitoTabId: 20, excelRow: 2 });
  assert.deepEqual(stages.at(-1), ["backfill", "https://final.test/home"]);
  assert.equal(controller.getState().sequence, 2);
  assert.equal(controller.getState().excelRow, 3);
  assert.equal([...chrome.windowsById.values()].some((item) => item.incognito), false);
});
```

- [ ] **Step 2: 写“回填前不提交”与秘密不落盘测试**

```js
function makeHappyHarness(pageOverrides = {}) {
  const chrome = makeChrome();
  const now = { value: 1_000 };
  let totpCancelled = 0;
  let smsCancelled = 0;
  const pageActions = {
    prepareMother: async () => ({ ok: true }),
    generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }),
    submitLogin: async () => ({ ok: true }),
    detectTotp: async () => ({ ok: true }),
    clickAccept: async () => ({ ok: true }),
    detectFinal: async () => ({ ok: true }),
    backfillMother: async () => ({ ok: true }),
    ...pageOverrides,
  };
  const controller = createWorkflowController(chrome, {
    now: () => now.value,
    makeBatchId: () => "batch-0099",
    targetOrigin: "http://auth-target.local",
    selectors: configuredSelectors,
    requestNative: async (_command, payload) => payload.excel_row === 3
      ? { ok: false, error: "excel_exhausted" }
      : { ok: true, username: "alice", password: "secret" },
    pageActions,
    totpLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => { totpCancelled += 1; } },
    smsLabController: { run: async () => ({ state: "SUCCEEDED" }), cancel: async () => { smsCancelled += 1; } },
  });
  const driveUntil = async (stage) => {
    for (let guard = 0; controller.getState().state !== stage && guard < 40; guard += 1) {
      if (controller.getState().state === "FINAL_URL") chrome.tabsById.get(chrome.session.workflowState.incognitoTabId).url = "https://final.test/home";
      await fireNextAlarm(controller, chrome, now);
    }
    assert.equal(controller.getState().state, stage);
  };
  return {
    controller,
    chrome,
    driveUntil,
    get totpCancelled() { return totpCancelled; },
    get smsCancelled() { return smsCancelled; },
  };
}

test("does not advance when mother backfill fails and never stores credentials", async () => {
  const { controller, chrome, driveUntil } = makeHappyHarness({
    backfillMother: async () => ({ ok: false, error: "mother_backfill_failed" }),
  });
  await controller.start();
  await driveUntil("FAILED");
  assert.equal(controller.getState().sequence, 1);
  assert.equal(controller.getState().excelRow, 2);
  assert.equal(chrome.windowsById.get(2)?.incognito, true);
  for (const [, values] of chrome.calls.filter(([name]) => name === "session.set")) {
    const serialized = JSON.stringify(values);
    assert.doesNotMatch(serialized, /alice|secret|123456|13800000000/);
  }
});
```

- [ ] **Step 3: 运行测试并确认红灯**

Run: `node --test --test-name-pattern "commits only|does not advance" extension/tests/workflow-controller.test.mjs`

Expected: FAIL because stages after `LOGIN` are not implemented.

- [ ] **Step 4: 实现登录和不少于 30 秒 Alarm 门控**

在 `advance()` 增加：

```js
case "LOGIN": {
  const credentials = await requestNative("get_workflow_credentials", { excel_row: state.excelRow });
  if (credentials.ok !== true) throw new Error(credentials.error || "credentials_invalid");
  const result = await pageActions.submitLogin({
    tabId: state.incognitoTabId,
    username: credentials.username,
    password: credentials.password,
    selectors: configuredSelectors(),
  });
  if (!result?.ok) throw new Error(result?.error || "login_failed");
  await persist({ ...state, stage: "LOGIN_WAIT", loginSubmittedAt: now(), attempt: 0 });
  schedule(30_000);
  return;
}
case "LOGIN_WAIT": {
  const remaining = state.loginSubmittedAt + 30_000 - now();
  if (remaining > 0) { schedule(remaining); return; }
  const result = await pageActions.detectTotp({ tabId: state.incognitoTabId, selectors: configuredSelectors() });
  if (!result?.ok) throw new Error(result?.error || "totp_stage_not_reached");
  await transition("TOTP");
  return;
}
```

`transition(stage)` 将 `attempt` 重置为 0、持久化并 schedule(0)。测试 clock 允许 Alarm 延迟，不能断言精确 30 秒，只断言 `now >= loginSubmittedAt + 30_000` 后才调用 detectTotp。

- [ ] **Step 5: 实现 MFA、接受、回填、COMMIT 和 CLEANUP**

按以下 case 实现：

```js
case "TOTP": {
  const result = await totpLabController.run({ motherTabId: state.motherTabId, incognitoTabId: state.incognitoTabId, excelRow: state.excelRow });
  if (result.state !== "SUCCEEDED") throw new Error(result.error || "totp_lab_failed");
  await transition("SMS");
  return;
}
case "SMS": {
  const result = await smsLabController.run({ motherTabId: state.motherTabId, incognitoTabId: state.incognitoTabId, excelRow: state.excelRow });
  if (result.state !== "SUCCEEDED") throw new Error(result.error || "sms_lab_failed");
  await transition("ACCEPT");
  return;
}
case "ACCEPT": {
  const accepted = await pageActions.clickAccept({ tabId: state.incognitoTabId, selectors: configuredSelectors() });
  if (!accepted?.ok) throw new Error(accepted?.error || "accept_button_missing");
  const finalReady = await pageActions.detectFinal({ tabId: state.incognitoTabId, selectors: configuredSelectors() });
  if (!finalReady?.ok) throw new Error(finalReady?.error || "final_page_not_ready");
  await transition("FINAL_URL");
  return;
}
case "FINAL_URL": {
  const target = await api.tabs.get(state.incognitoTabId);
  const finalUrl = validateFinalUrl(target.url);
  await api.windows.update(state.motherWindowId, { focused: true });
  const result = await pageActions.backfillMother({ tabId: state.motherTabId, finalUrl, selectors: configuredSelectors() });
  if (!result?.ok) throw new Error(result?.error || "mother_backfill_failed");
  await transition("MOTHER_BACKFILL");
  return;
}
case "MOTHER_BACKFILL": {
  await transition("COMMIT");
  return;
}
case "COMMIT": {
  const next = nextRowState(state);
  await persist({ ...state, ...next, stage: "CLEANUP", attempt: 0, error: "" });
  schedule(0);
  return;
}
case "CLEANUP": {
  if (state.incognitoWindowId) await removeWindowOrTreatMissingAsSuccess(state.incognitoWindowId);
  await persist({ ...state, stage: "ROW_PREFLIGHT", incognitoTabId: null, incognitoWindowId: null, loginSubmittedAt: null, attempt: 0, error: "" });
  schedule(0);
  return;
}
```

`excel_exhausted` 只在 `ROW_PREFLIGHT` 映射为 `COMPLETED`。`COMMIT` 使用一次 `storage.session.set` 原子保存新 sequence/row/stage。

- [ ] **Step 6: 运行完整 happy-path 测试**

Run: `node --test extension/tests/workflow-controller.test.mjs`

Expected: happy-path, no-early-commit, no-secret-storage tests PASS；尚未添加的 retry/cancel tests 不存在。

- [ ] **Step 7: 提交 Task 7**

```powershell
git add extension/workflow-controller.js extension/tests/workflow-controller.test.mjs
git commit -m "Commit rows only after the full authentication workflow" `
  -m "Chain credential login, delayed TOTP gating, local TOTP and SMS helpers, acceptance, final URL capture, exact mother backfill, atomic row advancement, and successful window cleanup." `
  -m "Constraint: Login outcome checks run no earlier than 30 seconds after submission" `
  -m "Confidence: high" `
  -m "Scope-risk: broad" `
  -m "Directive: COMMIT remains the only sequence advancement stage" `
  -m "Tested: full workflow happy path, failure-before-commit, and secret-storage tests" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 8: 完成重试、恢复、取消和失败现场保留

**Files:**
- Modify: `extension/workflow-state.js`
- Modify: `extension/workflow-controller.js`
- Modify: `extension/tests/workflow-state.test.mjs`
- Modify: `extension/tests/workflow-controller.test.mjs`

- [ ] **Step 1: 写错误分类和单次重试失败测试**

在 `workflow-state.test.mjs` 增加：

```js
import { isRetryableWorkflowError, safeWorkflowError } from "../workflow-state.js";

test("retries transient errors but not configuration or permission failures", () => {
  for (const code of ["page_not_stable", "element_not_found", "native_host_timeout", "tab_load_timeout"])
    assert.equal(isRetryableWorkflowError(code), true, code);
  for (const code of ["selector_not_configured", "element_ambiguous", "authorization_origin_mismatch", "credentials_invalid", "incognito_access_required", "target_host_permission_required"])
    assert.equal(isRetryableWorkflowError(code), false, code);
  assert.equal(safeWorkflowError(new Error("page_not_stable:details")), "page_not_stable");
  assert.equal(safeWorkflowError(new Error("secret=value")), "workflow_failed");
});
```

在 controller tests 增加：第一次 `prepareMother` 返回 `page_not_stable`、第二次成功，断言调用两次后继续；连续两次返回同错误，断言 `FAILED`、attempt 为 1、sequence 仍为 1。`element_ambiguous` 只调用一次并直接失败。

- [ ] **Step 2: 写 handoff 恢复、取消和现场保留测试**

```js
test("adopts one marker tab after a worker stop instead of creating another window", async () => {
  const chrome = makeChrome();
  const markerWindow = await chrome.windows.create({ incognito: true, focused: true, type: "normal", url: "about:blank#whalestest-handoff-batch-0003" });
  chrome.session.workflowState = {
    ...createWorkflowState({ batchId: "batch-0003", motherTabId: 10, motherWindowId: 1, now: 0 }),
    stage: "OPEN_INCOGNITO",
  };
  const controller = createWorkflowController(chrome, minimalOptions({
    requestNative: async () => ({ ok: true, username: "alice", password: "secret" }),
    pageActions: { generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start?id=7" }) },
  }));
  await controller.resume();
  await fireNextAlarm(controller, chrome, { value: 0 });
  assert.equal(chrome.calls.filter(([name]) => name === "windows.create").length, 1);
  assert.equal(chrome.session.workflowState.incognitoTabId, markerWindow.tabs[0].id);
});

test("keeps the failed incognito window and closes helper work on cancel", async () => {
  const harness = makeHappyHarness();
  await harness.controller.start();
  await harness.driveUntil("TOTP");
  const targetWindowId = harness.chrome.session.workflowState.incognitoWindowId;
  await harness.controller.cancel(harness.controller.getState().batchId);
  assert.equal(harness.controller.getState().state, "CANCELLED");
  assert.ok(harness.chrome.windowsById.has(targetWindowId));
  assert.equal(harness.totpCancelled, 1);
  assert.equal(harness.smsCancelled, 1);
});
```

加入以下恢复边界测试：

```js
test("fails closed on duplicate markers and preserves both windows", async () => {
  const chrome = makeChrome();
  await chrome.windows.create({ incognito: true, focused: true, type: "normal", url: "about:blank#whalestest-handoff-batch-0004" });
  await chrome.windows.create({ incognito: true, focused: true, type: "normal", url: "about:blank#whalestest-handoff-batch-0004" });
  chrome.session.workflowState = { ...createWorkflowState({ batchId: "batch-0004", motherTabId: 10, motherWindowId: 1, now: 0 }), stage: "OPEN_INCOGNITO" };
  const controller = createWorkflowController(chrome, minimalOptions({ pageActions: { generateAuthorization: async () => ({ ok: true, authorizationUrl: "http://auth-target.local/start" }) } }));
  await controller.resume();
  await fireNextAlarm(controller, chrome, { value: 0 });
  assert.equal(controller.getState().error, "incognito_window_ambiguous");
  assert.equal([...chrome.windowsById.values()].filter((item) => item.incognito).length, 2);
});

test("does not schedule terminal state and sanitizes unknown exceptions", async () => {
  for (const stage of ["COMPLETED", "FAILED", "CANCELLED"]) {
    const chrome = makeChrome();
    chrome.session.workflowState = { ...createWorkflowState({ batchId: `batch-${stage}`, motherTabId: 10, motherWindowId: 1, now: 0 }), stage };
    await createWorkflowController(chrome, minimalOptions()).resume();
    assert.equal(chrome.alarmsByName.size, 0);
  }
  const harness = makeHappyHarness({ prepareMother: async () => { throw new Error("password=secret"); } });
  await harness.controller.start();
  await harness.driveUntil("FAILED");
  assert.equal(harness.controller.getState().error, "workflow_failed");
  assert.equal([...harness.chrome.windowsById.values()].some((item) => item.incognito), false);
});
```

- [ ] **Step 3: 运行测试并确认红灯**

Run: `node --test extension/tests/workflow-state.test.mjs extension/tests/workflow-controller.test.mjs`

Expected: FAIL because error classification, retry wrapper, resume and cancel are incomplete.

- [ ] **Step 4: 实现错误分类和阶段重试包装**

在 `workflow-state.js` 增加：

```js
const RETRYABLE = new Set(["page_not_stable", "element_not_found", "native_host_timeout", "native_host_unavailable", "tab_load_timeout", "page_action_failed"]);

export function isRetryableWorkflowError(code) { return RETRYABLE.has(code); }

export function safeWorkflowError(error, fallback = "workflow_failed") {
  const value = error instanceof Error ? error.message.split(":")[0] : "";
  return /^[a-z][a-z0-9_]{1,64}$/.test(value) ? value : fallback;
}
```

在 `onAlarm` 外层捕获：

```js
const code = safeWorkflowError(error);
if (isRetryableWorkflowError(code) && state.attempt < 1) {
  await persist({ ...state, attempt: state.attempt + 1, error: code });
  schedule(500);
  return;
}
await fail(code);
```

每次成功 `transition()` 都把 `attempt` 和 `error` 清零。有副作用的页面函数负责先检查后置状态；OPEN_INCOGNITO 依赖 marker adoption。

- [ ] **Step 5: 实现恢复、失败和取消**

```js
async function resume() {
  const stored = (await api.storage.session.get(STATE_KEY))[STATE_KEY];
  if (!stored) return publicWorkflowState(null);
  state = stored;
  if (!["COMPLETED", "FAILED", "CANCELLED"].includes(state.stage)) schedule(0);
  return publicWorkflowState(state);
}

async function cancelOwnedPageContexts() {
  const tabIds = [state?.motherTabId, state?.incognitoTabId].filter(Number.isInteger);
  await Promise.allSettled(tabIds.map((tabId) => api.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: cancelWorkflowOnPage,
    args: [{ runId: state.batchId }],
  })));
}

async function fail(code) {
  await totpLabController?.cancel?.();
  await smsLabController?.cancel?.();
  await cancelOwnedPageContexts();
  await persist({ ...state, stage: "FAILED", error: code });
  await api.alarms.clear(`${ALARM_PREFIX}${state.batchId}`);
  return publicWorkflowState(state);
}

async function cancel(batchId) {
  if (!state || (batchId && batchId !== state.batchId)) return publicWorkflowState(state);
  await totpLabController?.cancel?.();
  await smsLabController?.cancel?.();
  await cancelOwnedPageContexts();
  await persist({ ...state, stage: "CANCELLED", error: "workflow_cancelled" });
  await api.alarms.clear(`${ALARM_PREFIX}${state.batchId}`);
  return publicWorkflowState(state);
}
```

`fail()` 和 `cancel()` 不调用 `windows.remove`。现有 TOTP/SMS controllers 在自身 finally/cancel 中关闭 helper tabs；若某 controller 尚未启动，cancel 是 no-op。`ROW_PREFLIGHT` 收到 `excel_exhausted` 进入 `COMPLETED` 前也调用 `cancelOwnedPageContexts()`，移除母页上残留的批次令牌。

- [ ] **Step 6: 运行控制器测试和扩展回归**

Run:

```powershell
node --test extension/tests/workflow-state.test.mjs extension/tests/workflow-controller.test.mjs
node --test extension/tests/*.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: 提交 Task 8**

```powershell
git add extension/workflow-state.js extension/workflow-controller.js extension/tests/workflow-state.test.mjs extension/tests/workflow-controller.test.mjs
git commit -m "Preserve failed workflow evidence across retries and restarts" `
  -m "Retry transient stages once, recover owned handoff windows, sanitize terminal errors, cancel helper work, and keep failed incognito windows for inspection." `
  -m "Constraint: Failed and cancelled target windows must remain open" `
  -m "Confidence: high" `
  -m "Scope-risk: broad" `
  -m "Tested: retry, deterministic failure, marker recovery, cancellation, and resume tests" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 9: 接入后台路由、Alarm、Manifest 和扩展打包

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/tests/background.test.mjs`
- Modify: `extension/manifest.json`
- Modify: `scripts/package-extension.ps1`

- [ ] **Step 1: 写严格工作流路由和 Alarm 失败测试**

在 `extension/tests/background.test.mjs` 扩展 fake Chrome：

```js
function makeEvent() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function dispatch(listener, message, senderId) {
  return new Promise((resolve, reject) => {
    let responded = false;
    const sendResponse = (value) => { responded = true; resolve(value); };
    try {
      const keepChannelOpen = listener(message, { id: senderId }, sendResponse);
      if (keepChannelOpen !== true && !responded) resolve(undefined);
    } catch (error) {
      reject(error);
    }
  });
}

chrome.alarms = {
  onAlarm: makeEvent(),
  create(name, details) { chrome.createdAlarms.push({ name, ...details }); },
  async clear() { return true; },
};
chrome.storage.session = {
  async get(key) { return { [key]: chrome.session[key] }; },
  async set(values) { Object.assign(chrome.session, structuredClone(values)); },
};
```

加入路由测试：

```js
test("routes exact workflow messages and registers one alarm listener", async () => {
  const chrome = makeWorkflowChrome();
  const runtime = createExtensionRuntime(chrome, { workflow: workflowOptions(chrome) });
  const started = await dispatch(runtime.listener, { type: "start_workflow" }, chrome.runtime.id);
  assert.equal(started.ok, true);
  assert.equal(chrome.alarms.onAlarm.listeners.length, 1);
  assert.equal(runtime.workflowController.getState().sequence, 1);
});

test("rejects extra workflow fields and keeps old CC routes", async () => {
  const chrome = makeWorkflowChrome();
  const runtime = createExtensionRuntime(chrome, { workflow: workflowOptions(chrome) });
  for (const message of [
    { type: "start_workflow", excelRow: 2 },
    { type: "workflow_state", password: "secret" },
    { type: "cancel_workflow", batchId: "", code: "123456" },
  ]) assert.deepEqual(await dispatch(runtime.listener, message, chrome.runtime.id), { ok: false, error: "request_invalid" });
  assert.ok(await dispatch(runtime.listener, { type: "state" }, chrome.runtime.id));
});

test("prevents old and new batch controllers from running together", async () => {
  const chrome = makeWorkflowChrome();
  const runtime = createExtensionRuntime(chrome, { workflow: workflowOptions(chrome) });
  runtime.batchController.getState = () => ({ running: true });
  const response = await dispatch(runtime.listener, { type: "start_workflow" }, chrome.runtime.id);
  assert.equal(response.result.error, "another_workflow_running");
});
```

- [ ] **Step 2: 写 Manifest 和打包清单失败断言**

扩展现有 manifest 测试为：

```js
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.permissions, ["nativeMessaging", "tabs", "downloads", "storage", "activeTab", "scripting", "alarms"]);
assert.deepEqual(manifest.host_permissions, [
  "http://127.0.0.1:9527/*",
  "http://auth-target.local/*",
  "http://totp-lab.local/*",
  "http://sms-lab.local/*",
]);
assert.equal(manifest.incognito, "spanning");
assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>|clipboardRead|debugger/);
```

- [ ] **Step 3: 运行测试并确认红灯**

Run: `node --test extension/tests/background.test.mjs`

Expected: FAIL because workflow routes, alarm listener and manifest permissions are absent.

- [ ] **Step 4: 装配工作流控制器**

在 `extension/background.js` 顶部增加：

```js
import { createWorkflowController } from "./workflow-controller.js";
```

在 `createExtensionRuntime` 中：

```js
const workflowController = createWorkflowController(api, {
  ...(options.workflow ?? {}),
  totpLabController,
  smsLabController,
  isCcBatchRunning: () => batchController.getState().running,
});
api.alarms?.onAlarm?.addListener?.((alarm) => { void workflowController.onAlarm(alarm); });
void workflowController.resume();
```

严格消息白名单：

```js
const allowedWorkflowStartKeys = new Set(["type"]);
const allowedWorkflowCancelKeys = new Set(["type", "batchId"]);
const allowedWorkflowStateKeys = new Set(["type"]);
```

`listener` 新增：

```js
if (["start_workflow", "cancel_workflow", "workflow_state"].includes(message?.type)) {
  if (sender?.id !== api.runtime.id) { sendResponse({ ok: false, error: "sender_rejected" }); return false; }
  if (message.type === "start_workflow") {
    if (!hasExactKeys(message, allowedWorkflowStartKeys)) { sendResponse({ ok: false, error: "request_invalid" }); return false; }
    void workflowController.start()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeRouteError(error, "workflow_route_failed") }));
    return true;
  }
  if (message.type === "cancel_workflow") {
    const valid = hasExactKeys(message, allowedWorkflowCancelKeys) &&
      (!Object.hasOwn(message, "batchId") || isNonEmptyString(message.batchId));
    if (!valid) { sendResponse({ ok: false, error: "request_invalid" }); return false; }
    void workflowController.cancel(message.batchId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeRouteError(error, "workflow_route_failed") }));
    return true;
  }
  if (!hasExactKeys(message, allowedWorkflowStateKeys)) { sendResponse({ ok: false, error: "request_invalid" }); return false; }
  sendResponse({ ok: true, result: workflowController.getState() });
  return false;
}
```

旧 `{type:"start"}` 路由执行前检查 `workflowController.getState().running`；冲突时返回旧 CC state 形状并设置 `lastError: "another_workflow_running"`，不得删除旧 `{type:"state"}`。

返回对象增加 `workflowController`，便于测试。

- [ ] **Step 5: 修改 Manifest**

`extension/manifest.json` 保持旧权限并精确增加：

```json
{
  "permissions": ["nativeMessaging", "tabs", "downloads", "storage", "activeTab", "scripting", "alarms"],
  "host_permissions": [
    "http://127.0.0.1:9527/*",
    "http://auth-target.local/*",
    "http://totp-lab.local/*",
    "http://sms-lab.local/*"
  ],
  "incognito": "spanning"
}
```

保留现有 key、action 和 background 配置。`http://auth-target.local/*` 是安全的有效本地默认值，联调前由用户替换为真实固定授权 origin。

- [ ] **Step 6: 更新打包清单**

在 `scripts/package-extension.ps1::$requiredFiles` 增加：

```powershell
'workflow-selectors.js',
'workflow-urls.js',
'workflow-state.js',
'workflow-page-context.js',
'mother-page.js',
'login-page.js',
'final-page.js',
'workflow-controller.js'
```

Task 10 创建 `popup-view.js` 后也必须加入此数组。

- [ ] **Step 7: 运行后台、Manifest 和打包验证**

Run:

```powershell
node --test extension/tests/background.test.mjs extension/tests/workflow-controller.test.mjs
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-workflow-package")
```

Expected: tests PASS；打包输出 ZIP 路径、manifest version 和 SHA256。

- [ ] **Step 8: 提交 Task 9**

```powershell
git add extension/background.js extension/tests/background.test.mjs extension/manifest.json scripts/package-extension.ps1
git commit -m "Expose the bounded workflow through Manifest V3" `
  -m "Wire exact workflow messages and alarms beside the existing CC batch routes, declare only the mother, target, TOTP, and SMS origins, and package every workflow module." `
  -m "Constraint: Old CC downloads remain supported and mutually exclusive with the new workflow" `
  -m "Rejected: Add all-URL access | the authorization origin is fixed" `
  -m "Confidence: high" `
  -m "Scope-risk: moderate" `
  -m "Tested: background routing, manifest assertions, extension tests, package build" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 10: 在插件弹窗中并存授权工作流与旧 CC 批处理

**Files:**
- Create: `extension/popup-view.js`
- Create: `extension/tests/popup-view.test.mjs`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Modify: `extension/popup.css`
- Modify: `scripts/package-extension.ps1`

- [ ] **Step 1: 写弹窗渲染失败测试**

创建 `extension/tests/popup-view.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderPopup } from "../popup-view.js";

function node() { return { textContent: "", disabled: false, hidden: false }; }

function elements() {
  return {
    workflowStart: node(), workflowStop: node(), workflowStatus: node(), workflowSequence: node(), workflowRow: node(), workflowStage: node(), workflowError: node(),
    ccStart: node(), ccStatus: node(), ccProgress: node(), ccSuccess: node(), ccFailure: node(), ccUrl: node(), ccError: node(),
  };
}

test("renders workflow progress and disables both starts while workflow runs", () => {
  const view = elements();
  renderPopup(view, {
    workflow: { running: true, state: "TOTP", sequence: 3, excelRow: 4, error: "" },
    cc: { running: false, current: 0, total: 0 },
  });
  assert.equal(view.workflowStatus.textContent, "状态：执行中");
  assert.equal(view.workflowSequence.textContent, "3");
  assert.equal(view.workflowRow.textContent, "4");
  assert.equal(view.workflowStage.textContent, "TOTP");
  assert.equal(view.workflowStart.disabled, true);
  assert.equal(view.ccStart.disabled, true);
});

test("renders a failed workflow without exposing URLs or credentials", () => {
  const view = elements();
  renderPopup(view, {
    workflow: { running: false, state: "FAILED", sequence: 2, excelRow: 3, error: "login_rejected" },
    cc: { running: false },
  });
  assert.equal(view.workflowError.textContent, "错误：login_rejected");
  assert.equal(view.workflowStart.disabled, false);
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/popup-view.test.mjs`

Expected: FAIL because `popup-view.js` does not exist.

- [ ] **Step 3: 实现纯渲染函数**

创建 `extension/popup-view.js`：

```js
export function renderPopup(elements, { workflow = {}, cc = {} } = {}) {
  const workflowRunning = Boolean(workflow.running);
  const ccRunning = Boolean(cc.running);
  elements.workflowStart.disabled = workflowRunning || ccRunning;
  elements.workflowStop.disabled = !workflowRunning;
  elements.ccStart.disabled = workflowRunning || ccRunning;
  elements.workflowStatus.textContent = `状态：${workflowRunning ? "执行中" : workflow.state === "COMPLETED" ? "已完成" : workflow.state === "FAILED" ? "已失败" : workflow.state === "CANCELLED" ? "已停止" : "空闲"}`;
  elements.workflowSequence.textContent = String(workflow.sequence ?? 0);
  elements.workflowRow.textContent = String(workflow.excelRow ?? 0);
  elements.workflowStage.textContent = workflow.state ?? "IDLE";
  elements.workflowError.textContent = workflow.error ? `错误：${workflow.error}` : "";
  elements.ccStatus.textContent = `状态：${ccRunning ? "执行中" : cc.lastError ? "已停止（有错误）" : "空闲"}`;
  elements.ccProgress.textContent = `${cc.current ?? 0}/${cc.total ?? 0}`;
  elements.ccSuccess.textContent = String(cc.success ?? 0);
  elements.ccFailure.textContent = String(cc.failure ?? 0);
  elements.ccUrl.textContent = cc.currentUrl ? `当前网址：${cc.currentUrl}` : "";
  elements.ccError.textContent = cc.lastError ? `最近错误：${cc.lastError}` : "";
}
```

- [ ] **Step 4: 重构 popup HTML 和入口**

`extension/popup.html` 的 `<main>` 改为两个 `<section>`：

```html
<main>
  <h1>Whalestest 授权工作流</h1>
  <section aria-labelledby="workflow-title">
    <h2 id="workflow-title">授权登录工作流</h2>
    <div class="actions">
      <button id="workflow-start" type="button">开始执行任务</button>
      <button id="workflow-stop" type="button" disabled>停止任务</button>
    </div>
    <p id="workflow-status">状态：空闲</p>
    <dl>
      <div><dt>序号</dt><dd id="workflow-sequence">0</dd></div>
      <div><dt>Excel 行</dt><dd id="workflow-row">0</dd></div>
      <div><dt>阶段</dt><dd id="workflow-stage">IDLE</dd></div>
    </dl>
    <p id="workflow-error" class="error"></p>
  </section>
  <section aria-labelledby="cc-title">
    <h2 id="cc-title">CC 下载批处理</h2>
    <button id="cc-start" type="button">开始整批任务</button>
    <p id="cc-status">状态：空闲</p>
    <dl>
      <div><dt>进度</dt><dd id="cc-progress">0/0</dd></div>
      <div><dt>成功</dt><dd id="cc-success">0</dd></div>
      <div><dt>失败</dt><dd id="cc-failure">0</dd></div>
    </dl>
    <p id="cc-url" class="muted"></p>
    <p id="cc-error" class="error"></p>
  </section>
</main>
```

`popup.js` 导入 `renderPopup`，并维护 `{workflow,cc}` 本地 view model：

```js
const [workflowResponse, ccResponse] = await Promise.all([
  chrome.runtime.sendMessage({ type: "workflow_state" }),
  chrome.runtime.sendMessage({ type: "state" }),
]);
model.workflow = workflowResponse?.result ?? workflowResponse ?? {};
model.cc = ccResponse ?? {};
renderPopup(elements, model);
```

按钮消息：

```js
workflowStart -> { type: "start_workflow" }
workflowStop -> { type: "cancel_workflow", batchId: model.workflow.batchId }
ccStart -> { type: "start" }
```

监听 `chrome.storage.onChanged`：area `session` + `workflowState` 时重新发送 `workflow_state`；area `local` + `ccBatchState` 时更新旧 CC state。不要从 raw session state直接渲染 tab IDs。

- [ ] **Step 5: 更新样式和打包**

`popup.css` 增加：

```css
body { min-width: 320px; margin: 0; font: 14px/1.45 system-ui, sans-serif; }
main { display: grid; gap: 12px; padding: 14px; }
section { border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; }
h1, h2 { margin: 0 0 10px; }
h1 { font-size: 18px; }
h2 { font-size: 15px; }
.actions { display: flex; gap: 8px; }
button { min-height: 32px; }
dl { display: grid; gap: 4px; margin: 10px 0; }
dl div { display: flex; justify-content: space-between; gap: 16px; }
.muted, .error { overflow-wrap: anywhere; }
.muted { color: #667085; }
.error { color: #b42318; }
```

`scripts/package-extension.ps1::$requiredFiles` 增加 `'popup-view.js'`。

- [ ] **Step 6: 运行弹窗、扩展和打包测试**

Run:

```powershell
node --test extension/tests/popup-view.test.mjs
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-workflow-popup")
```

Expected: tests PASS and package succeeds.

- [ ] **Step 7: 提交 Task 10**

```powershell
git add extension/popup-view.js extension/tests/popup-view.test.mjs extension/popup.html extension/popup.js extension/popup.css scripts/package-extension.ps1
git commit -m "Show workflow progress without removing the CC batch UI" `
  -m "Add separate start, stop, sequence, row, stage, and error reporting for the authorization workflow while preserving the existing download controls and mutual exclusion." `
  -m "Constraint: Popup rendering consumes only public workflow state" `
  -m "Confidence: high" `
  -m "Scope-risk: moderate" `
  -m "Tested: popup rendering, extension regression, and package build" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

### Task 11: 更新中文文档并执行完整验证

**Files:**
- Modify: `README.md`
- Verify: all files changed in Tasks 1-10

- [ ] **Step 1: 更新 README 配置和运行章节**

在中文 README 增加明确内容：

```markdown
## 母页提链与无痕登录工作流

1. 在 `extension/manifest.json` 同时替换：
   - `http://auth-target.local/*`
2. 在 `extension/workflow-controller.js` 的默认 target origin 同步替换为同一 origin（不含末尾 `/*`）。
3. 在 `extension/workflow-selectors.js` 填写：
   - `motherFinalUrlInput`
   - `motherFinalConfirmButton`
   - `motherFinalSuccess`
4. Chrome 扩展详情页必须启用“允许在无痕模式下运行”。
5. 普通 Chrome 窗口打开 `http://127.0.0.1:9527/`，保持为当前选中标签。
6. 点击插件“开始执行任务”。序号 1 对应 Excel 物理行 2；只有最终 URL 回填成功才推进序号。

失败时任务停止，TOTP/SMS 辅助标签关闭，失败无痕窗口保留。插件显示序号、Excel 行、阶段和固定错误码，不显示密码、密钥、手机号或验证码。
```

错误码表至少解释：`mother_url_invalid`、`selector_not_configured`、`authorization_origin_mismatch`、`incognito_access_required`、`target_host_permission_required`、`login_rejected`、`totp_stage_not_reached`、`mother_backfill_failed`、`incognito_window_ambiguous`、`another_workflow_running`。

- [ ] **Step 2: 运行 Python 全量测试**

Run:

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
```

Expected: all Native Host and integration tests PASS.

- [ ] **Step 3: 运行 Node 全量测试和语法检查**

Run:

```powershell
node --test extension/tests/*.test.mjs
Get-ChildItem extension -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-ChildItem extension/tests -Filter *.mjs | ForEach-Object { node --check $_.FullName }
```

Expected: all tests PASS and every syntax check exits 0.

- [ ] **Step 4: 运行 Python 语法、安装文件和打包验证**

Run:

```powershell
python -m py_compile native_host/host.py native_host/cc_batch/workflow_credentials.py native_host/cc_batch/totp_lab.py native_host/cc_batch/sms_lab.py
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-workflow-final")
git diff --check
```

Expected: py_compile and diff check exit 0；package prints ZIP path, manifest version and SHA256.

- [ ] **Step 5: 运行权限与敏感信息静态扫描**

Run:

```powershell
rg -n "<all_urls>|clipboardRead|\"debugger\"|2fa\.run|selenium|drag_to|generate_track" extension native_host scripts
rg -n "storage\.(local|session).*password|storage\.(local|session).*code|console\.(log|error).*password|console\.(log|error).*code" extension native_host
```

Expected: first scan only matches negative test assertions if any；second scan has no production-code matches.

- [ ] **Step 6: 检查实际变更范围和未跟踪基线**

Run:

```powershell
git status --short
git diff --stat HEAD~10..HEAD
git log --oneline -12
```

Expected: only Tasks 1-11 owned files are staged/committed；预先存在的未跟踪基线文件仍未被批量暂存或删除。

- [ ] **Step 7: 提交 Task 11**

```powershell
git add README.md
git commit -m "Document the bounded mother-page workflow" `
  -m "Explain exact origin and selector configuration, incognito enablement, sequence-to-row binding, failure evidence, errors, and local verification in Chinese." `
  -m "Constraint: Live end-to-end execution remains blocked until the user fills the real origin and selectors" `
  -m "Confidence: high" `
  -m "Scope-risk: narrow" `
  -m "Tested: full Native, integration, extension, syntax, package, diff, permission, and sensitive-data verification" `
  -m "Not-tested: Live interaction with the unresolved mother-page DOM and real fixed authorization origin" `
  -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
```

---

## 设计覆盖映射

- 序号 `N` → Excel 物理行 `N+1`、每批从 1 开始：Tasks 1、3、6、7。
- 母页账号名称、第二个平台、全选分组、生成和读取 URL：Task 4。
- 无痕 spanning、固定 Host permission、唯一 handoff marker：Tasks 3、6、9。
- `#username/#password` 登录与不少于 30 秒门控：Tasks 5、7。
- 同一物理行 TOTP C 列与 SMS D/E 列：Tasks 2、7。
- 接受、最终 URL 读取和母页精确回填：Tasks 4、5、7。
- 回填成功后才 COMMIT、成功关闭、失败保留：Tasks 7、8。
- 每阶段最多重试一次、Alarm 恢复、取消：Task 8。
- 新旧批处理并存和互斥：Tasks 9、10。
- 中文配置说明、权限/秘密扫描、完整回归：Task 11。

唯一无法在实现阶段自动完成的真实页面联调输入是用户尚未提供的固定授权 origin 和精确母页回填选择器；Task 11 明确以 fixture 自动测试覆盖控制逻辑，并把真实端到端测试标记为配置后执行。

---

## 最终人工联调清单

自动化测试全部通过后，使用用户填写的真实选择器和固定授权 origin 执行一次本地人工联调：

1. 确认扩展已开启无痕权限；
2. 母页根 URL 为 `http://127.0.0.1:9527/`；
3. Excel 第 2 行包含 A-E 完整测试数据；
4. 点击“开始执行任务”；
5. 确认母页名称符合 `YYYYMMDD-HHmm SHARKPIX PLUS 1`；
6. 确认第二个平台和所有分组被选中；
7. 确认只创建一个无痕窗口；
8. 确认登录提交后不少于 30 秒才检测 TOTP；
9. 确认 TOTP/SMS 使用物理行 2，辅助标签位于母页旁边并自动关闭；
10. 确认点击接受后最终 URL 回填母页；
11. 确认回填成功后序号变为 2、物理行变为 3，成功无痕窗口关闭；
12. 人为制造一次登录失败，确认序号不推进、整批停止、失败无痕窗口保留且插件显示行号和错误码。
