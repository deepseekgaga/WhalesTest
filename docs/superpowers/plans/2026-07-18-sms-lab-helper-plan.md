# 本地短信验证码辅助模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TOTP 成功后，使用同一 Excel 物理行的 D 列手机号和 E 列 `sms-lab.local` 链接，在同一个无痕标签页完成短信验证码提交。

**Architecture:** Native Host 单次读取并验证同一行的 D/E 列；扩展页面函数负责稳定等待、填写手机号和验证码；独立短信控制器负责标签页边界、15 秒刷新、60 秒截止和取消竞态；Service Worker 只暴露严格字段白名单的短信路由。

**Tech Stack:** Python 3.11 标准库、现有 XLSX Open XML 读取器、Chrome Manifest V3、Native Messaging、`chrome.tabs`、`chrome.scripting`、Node.js test runner、Python `unittest`。

---

## 文件结构

- `native_host/cc_batch/sms_lab.py`：物理行 D/E 读取和短信 URL 验证。
- `native_host/tests/test_sms_lab.py`：Native 数据与安全边界测试。
- `native_host/host.py`：`get_sms_lab_challenge` 命令。
- `extension/sms-lab-selectors.js`：四个固定选择器占位符及校验函数。
- `extension/sms-lab-page.js`：手机号发送、验证码提交页面函数。
- `extension/sms-lab-controller.js`：短信状态机、辅助页和取消管理。
- `extension/tests/sms-lab-page.test.mjs`：页面动作测试。
- `extension/tests/sms-lab-controller.test.mjs`：控制器、刷新、重定向和取消测试。
- `extension/background.js`、`manifest.json`：运行路由和精确权限。
- `scripts/package-extension.ps1`、`README.md`：打包和中文说明。

### Task 1: 同一物理行读取 D/E 列并验证短信 URL

**Files:**
- Create: `native_host/cc_batch/sms_lab.py`
- Create: `native_host/tests/test_sms_lab.py`

- [ ] **Step 1: 写失败测试**

```python
class SmsLabTests(unittest.TestCase):
    def make_config(self, workbook: Path) -> Config:
        return Config(
            input_excel=workbook,
            url_column="CC地址",
            txt_directory=workbook.parent / "txt",
            output_excel=workbook.parent / "output.xlsx",
            download_timeout_seconds=180,
            field_mappings={"A": "", "B": "", "C": "", "D": ""},
            config_path=workbook.parent / "config.json",
        )

    def test_reads_exact_phone_and_url_from_one_physical_row(self):
        with tempfile.TemporaryDirectory() as directory_name:
            workbook = Path(directory_name) / "accounts.xlsx"
            write_xlsx(
                workbook,
                [["header", "", "", "phone", "url"], ["alice", "pass", "key", " +86 138-0000 ", "http://sms-lab.local/c/abc?x=1"]],
                row_numbers=[1, 7],
            )
            challenge = build_sms_lab_challenge(self.make_config(workbook), 7)
            self.assertEqual(challenge.phone, " +86 138-0000 ")
            self.assertEqual(challenge.challenge_url, "http://sms-lab.local/c/abc?x=1")

    def test_rejects_header_row_missing_values_and_external_urls(self):
        rejected_urls = [
            "https://sms-lab.local/a",
            "http://evil.test/a",
            "http://sub.sms-lab.local/a",
            "http://sms-lab.local:8080/a",
            "http://user@sms-lab.local/a",
            "http://sms-lab.local/a#fragment",
        ]
        for value in rejected_urls:
            with tempfile.TemporaryDirectory() as directory_name:
                workbook = Path(directory_name) / "accounts.xlsx"
                write_xlsx(workbook, [["header", "", "", "", ""], ["alice", "pass", "key", "13800000000", value]])
                with self.subTest(value=value), self.assertRaisesRegex(SmsLabError, "sms_url_invalid"):
                    build_sms_lab_challenge(self.make_config(workbook), 2)
```

测试同时覆盖：`excel_row` 为布尔值、非整数或小于 2；物理行不存在；D/E 为空；损坏或不完整 XLSX 映射为固定错误码。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest native_host.tests.test_sms_lab -v`

Expected: FAIL because `native_host.cc_batch.sms_lab` does not exist.

- [ ] **Step 3: 实现最小 Native 模块**

```python
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

SMS_LAB_ORIGIN = "http://sms-lab.local"


class SmsLabError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SmsLabChallenge:
    phone: str
    challenge_url: str


def validate_sms_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        explicit_port = parsed.port
    except (TypeError, ValueError) as exc:
        raise SmsLabError("sms_url_invalid") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname != "sms-lab.local"
        or parsed.netloc != "sms-lab.local"
        or parsed.username is not None
        or parsed.password is not None
        or explicit_port is not None
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise SmsLabError("sms_url_invalid")
    return urlunsplit(parsed)


def build_sms_lab_challenge(config: Config, excel_row: int) -> SmsLabChallenge:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 2:
        raise SmsLabError("excel_row_invalid")
    rows = _load_first_sheet_rows(Path(config.input_excel))
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise SmsLabError("account_row_not_found")
    phone = values[3] if len(values) > 3 else ""
    url = values[4] if len(values) > 4 else ""
    if not phone:
        raise SmsLabError("sms_phone_missing")
    if not url:
        raise SmsLabError("sms_url_missing")
    return SmsLabChallenge(phone=phone, challenge_url=validate_sms_url(url))
```

`_load_first_sheet_rows()` 必须把 `FileNotFoundError` 映射为 `input_excel_missing`，把 `OSError`、`BadZipFile`、`KeyError`、`ParseError`、`XlsxError`、`ValueError` 映射为 `input_excel_invalid`。

- [ ] **Step 4: 运行测试并确认绿灯**

Run: `python -m unittest native_host.tests.test_sms_lab -v`

Expected: 所有短信 Native tests PASS。

- [ ] **Step 5: 提交**

```powershell
git add native_host/cc_batch/sms_lab.py native_host/tests/test_sms_lab.py
git commit -m "Read SMS lab data from one physical workbook row"
```

### Task 2: 暴露 Native Messaging 短信命令

**Files:**
- Modify: `native_host/host.py`
- Modify: `native_host/tests/test_host_protocol.py`

- [ ] **Step 1: 写协议失败测试**

```python
def test_get_sms_lab_challenge_returns_only_phone_and_validated_url(self):
    with tempfile.TemporaryDirectory() as directory_name:
        directory = Path(directory_name)
        input_path = directory / "accounts.xlsx"
        write_xlsx(input_path, [["header", "", "", "", ""], ["alice", "pass", "key", "13800000000", "http://sms-lab.local/challenge/7"]])
        config_path = self._write_totp_config(directory, input_path)
        result = HostApplication(config_path).dispatch({"command": "get_sms_lab_challenge", "excel_row": 2})
        self.assertEqual(result, {
            "ok": True,
            "phone": "13800000000",
            "challenge_url": "http://sms-lab.local/challenge/7",
        })

def test_get_sms_lab_challenge_rejects_invalid_request_without_echoing_values(self):
    result = HostApplication("unused.json").dispatch({
        "command": "get_sms_lab_challenge",
        "excel_row": "2",
        "phone": "sensitive-phone",
        "code": "123456",
    })
    self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
    self.assertNotIn("sensitive", str(result))
    self.assertNotIn("123456", str(result))
```

- [ ] **Step 2: 运行测试并确认红灯**

Run: `python -m unittest native_host.tests.test_host_protocol.HostProtocolTests.test_get_sms_lab_challenge_returns_only_phone_and_validated_url -v`

Expected: FAIL because the command is unknown.

- [ ] **Step 3: 实现命令**

```python
from native_host.cc_batch.sms_lab import SmsLabError, build_sms_lab_challenge


def _get_sms_lab_challenge(self, message):
    excel_row = message.get("excel_row")
    if isinstance(excel_row, bool) or not isinstance(excel_row, int):
        return {"ok": False, "error": "request_invalid", "fatal": False}
    try:
        config = load_config(self.config_path)
        challenge = build_sms_lab_challenge(config, excel_row)
        return {"ok": True, "phone": challenge.phone, "challenge_url": challenge.challenge_url}
    except SmsLabError as exc:
        return {"ok": False, "error": exc.code, "fatal": False}
    except ConfigError:
        return {"ok": False, "error": "input_excel_invalid", "fatal": False}
```

在批处理命令白名单之前路由 `get_sms_lab_challenge`。

- [ ] **Step 4: 运行 Native 回归**

Run:

```powershell
python -m unittest native_host.tests.test_host_protocol native_host.tests.test_sms_lab -v
python -m unittest discover -s native_host/tests -v
```

Expected: 新旧 Native tests 全部 PASS。

- [ ] **Step 5: 提交**

```powershell
git add native_host/host.py native_host/tests/test_host_protocol.py
git commit -m "Expose the SMS lab challenge through the native host"
```

### Task 3: 选择器校验和两个稳定页面动作

**Files:**
- Create: `extension/sms-lab-selectors.js`
- Create: `extension/sms-lab-page.js`
- Create: `extension/tests/sms-lab-page.test.mjs`

- [ ] **Step 1: 写选择器和页面动作失败测试**

```javascript
test("rejects placeholder selectors before page work", () => {
  assert.throws(() => requireSmsLabSelectors(SMS_LAB_SELECTORS), /sms_selectors_not_configured/);
});

test("waits for stable phone controls, preserves the phone, and sends once", async () => {
  const result = await requestSmsOnPage({
    phone: " +86 138-0000 ",
    selectors: configuredSelectors,
    timeoutMs: 100,
  }, stableEnvironment({ input, button }));
  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, " +86 138-0000 ");
  assert.deepEqual(input.events, ["input", "change"]);
  assert.equal(button.form.submitCount, 1);
});

test("waits for stable code controls and submits one six-digit code", async () => {
  const result = await submitSmsCodeOnPage({
    code: "123456",
    selectors: configuredSelectors,
    timeoutMs: 100,
  }, stableEnvironment({ input, button }));
  assert.deepEqual(result, { ok: true });
  assert.equal(input.value, "123456");
});
```

同时覆盖手机号为空、验证码不是 6 位、输入框或按钮不存在、按钮禁用、页面始终不稳定和取消。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/sms-lab-page.test.mjs`

Expected: FAIL because the SMS page modules do not exist.

- [ ] **Step 3: 实现选择器模块**

```javascript
export const SMS_LAB_SELECTORS = Object.freeze({
  phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
  sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
  codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
  submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
});

const PLACEHOLDERS = new Set(Object.values(SMS_LAB_SELECTORS));

export function requireSmsLabSelectors(selectors = SMS_LAB_SELECTORS) {
  const values = [selectors?.phoneInput, selectors?.sendButton, selectors?.codeInput, selectors?.submitButton];
  if (values.some((value) => typeof value !== "string" || !value || PLACEHOLDERS.has(value))) {
    throw new Error("sms_selectors_not_configured");
  }
  return Object.freeze({ ...selectors });
}
```

- [ ] **Step 4: 实现页面函数**

`requestSmsOnPage` 和 `submitSmsCodeOnPage` 必须完全自包含，以便通过 `chrome.scripting.executeScript({func})` 序列化。两者内部实现：稳定采样、可见性检查、原生 value setter、`input`/`change` 事件，以及 `form.requestSubmit(button)` 或 `button.click()`。

固定错误码分别使用：

```javascript
"sms_phone_invalid"
"sms_phone_input_not_found"
"sms_send_button_not_found"
"sms_send_button_disabled"
"sms_code_invalid"
"sms_code_input_not_found"
"sms_submit_button_not_found"
"sms_submit_button_disabled"
"page_not_stable"
"cancelled"
```

- [ ] **Step 5: 运行测试并提交**

Run:

```powershell
node --test extension/tests/sms-lab-page.test.mjs
node --check extension/sms-lab-page.js
node --check extension/sms-lab-selectors.js
```

Expected: 页面 tests PASS，语法检查退出 0。

```powershell
git add extension/sms-lab-selectors.js extension/sms-lab-page.js extension/tests/sms-lab-page.test.mjs
git commit -m "Add stable SMS request and verification page actions"
```

### Task 4: 实现短信控制器成功路径和标签页边界

**Files:**
- Create: `extension/sms-lab-controller.js`
- Create: `extension/tests/sms-lab-controller.test.mjs`

- [ ] **Step 1: 写成功路径和标签边界失败测试**

```javascript
test("sends the same-row phone, reads a helper code, and submits on the same incognito tab", async () => {
  const chrome = makeSmsChrome();
  const controller = createSmsLabController(chrome, {
    selectors: configuredSelectors,
    makeRunId: () => "sms-run-1",
  });
  const result = await controller.run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });
  assert.deepEqual(result, { state: "SUCCEEDED", runId: "sms-run-1", error: "" });
  assert.deepEqual(chrome.nativeMessages[0], {
    request_id: chrome.nativeMessages[0].request_id,
    command: "get_sms_lab_challenge",
    excel_row: 2,
  });
  assert.deepEqual(chrome.createdTabs[0], {
    windowId: 1,
    index: 4,
    active: false,
    url: "http://sms-lab.local/challenge/2",
  });
  assert.deepEqual(chrome.removedTabs, [30]);
  assert.deepEqual(chrome.executions.map((item) => item.func.name), [
    "registerSmsOnPage",
    "requestSmsOnPage",
    "readVisibleTotpCode",
    "submitSmsCodeOnPage",
  ]);
  assert.deepEqual(chrome.motherMutations, []);
});
```

同时覆盖：选择器未配置时不请求 Native Host；母页缺失/非 active/无痕；目标页非无痕；相同 tab ID；目标页无 `activeTab` 权限；Native 响应不含合法手机号或 URL。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/sms-lab-controller.test.mjs`

Expected: FAIL because `createSmsLabController` is missing.

- [ ] **Step 3: 实现控制器成功路径**

控制器常量：

```javascript
const HOST_NAME = "com.whalestest.cc_batch";
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_ACTION_TIMEOUT_MS = 30_000;
const SMS_ORIGIN = "http://sms-lab.local";
```

`run()` 顺序必须固定：

```javascript
const selectors = requireSmsLabSelectors(options.selectors);
const { motherTab } = await assertTabs(motherTabId, incognitoTabId, excelRow);
await assertTargetActiveTab(run);
const native = await request("get_sms_lab_challenge", { excel_row: excelRow }, run.abort.signal);
throwIfCancelled(run);
const phone = validatePhone(native.phone);
const challengeUrl = validateSmsUrl(native.challenge_url);
await executeTarget(run, requestSmsOnPage, { phone, selectors, timeoutMs: PAGE_ACTION_TIMEOUT_MS });
throwIfCancelled(run);
const helper = await api.tabs.create({
  windowId: motherTab.windowId,
  index: motherTab.index + 1,
  active: false,
  url: challengeUrl,
});
run.helperTabId = helper.id;
const code = await readOnceFromValidatedHelper(run);
await closeHelper(run);
await assertMotherStillActive(run.motherTabId);
await executeTarget(run, submitSmsCodeOnPage, { code, selectors, timeoutMs: PAGE_ACTION_TIMEOUT_MS });
```

`validateSmsUrl()` 必须拒绝协议、origin、hostname、凭据、端口和片段不符合固定边界的值。Helper 加载完成后使用 `tabs.get(helperTabId).url` 再次验证最终 URL，再执行 `readVisibleTotpCode`。

- [ ] **Step 4: 运行成功路径 tests**

Run: `node --test extension/tests/sms-lab-controller.test.mjs`

Expected: 成功路径和 tab 边界 tests PASS；刷新/取消 tests 尚未加入。

- [ ] **Step 5: 提交**

```powershell
git add extension/sms-lab-controller.js extension/tests/sms-lab-controller.test.mjs
git commit -m "Keep SMS verification bound to one mother and incognito tab pair"
```

### Task 5: 加入 15 秒刷新、60 秒截止、重定向和取消竞态

**Files:**
- Modify: `extension/sms-lab-controller.js`
- Modify: `extension/tests/sms-lab-controller.test.mjs`

- [ ] **Step 1: 写刷新和取消失败测试**

测试使用可控 `now()`、`sleep()` 和 helper 结果队列，覆盖：

```javascript
const validRequest = { motherTabId: 10, incognitoTabId: 20, excelRow: 2 };

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition_not_met");
}

function failAfter(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("run_hung")), ms));
}

function createController(chrome) {
  return createSmsLabController(chrome, {
    selectors: configuredSelectors,
    makeRunId: () => "sms-run-1",
    now: clock.now,
    sleep: clock.sleep,
  });
}

test("refreshes at 15, 30, and 45 seconds then performs the final read at 60", async () => {
  const chrome = makeSmsChrome({ helperResults: [
    { ok: false, error: "code_not_present" },
    { ok: false, error: "code_not_present" },
    { ok: false, error: "code_not_present" },
    { ok: false, error: "code_not_present" },
    { ok: false, error: "code_not_present" },
  ]});
  const result = await controllerWithClock(chrome).run(validRequest);
  assert.equal(result.error, "sms_code_not_found");
  assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
  assert.equal(clock.elapsed, 60_000);
});

test("rejects a redirected helper before injecting the reader", async () => {
  const chrome = makeSmsChrome({ helperFinalUrl: "http://evil.test/capture" });
  const result = await controller.run(validRequest);
  assert.equal(result.error, "sms_url_invalid");
  assert.equal(chrome.helperExecutions.length, 0);
});

test("cancel while native response is pending prevents helper creation", async () => {
  const deferred = makeDeferred();
  const chrome = makeSmsChrome({ nativeResponse: deferred.promise });
  const controller = createController(chrome);
  const running = controller.run(validRequest);
  await waitFor(() => controller.getState().state === "READING_CHALLENGE");
  await controller.cancel("sms-run-1");
  deferred.resolve({ ok: true, phone: "13800000000", challenge_url: "http://sms-lab.local/c/2" });
  assert.equal((await running).state, "CANCELLED");
  assert.equal(chrome.createdTabs.length, 0);
});

test("cancel while helper creation is pending removes the late helper exactly once", async () => {
  const deferredCreate = makeDeferred();
  const chrome = makeSmsChrome({ createResult: deferredCreate.promise });
  const controller = createController(chrome);
  const running = controller.run(validRequest);
  await waitFor(() => chrome.createCalls.length === 1);
  await controller.cancel("sms-run-1");
  deferredCreate.resolve({ id: 30, windowId: 1, index: 4, active: false, status: "complete", url: "http://sms-lab.local/c/2" });
  assert.equal((await running).state, "CANCELLED");
  assert.deepEqual(chrome.removedTabs, [30]);
});

test("cancel while code submit is pending settles the original run", async () => {
  const pendingSubmit = new Promise(() => {});
  const chrome = makeSmsChrome({ submitResult: pendingSubmit });
  const controller = createController(chrome);
  const running = controller.run(validRequest);
  await waitFor(() => chrome.executions.some((item) => item.func.name === "submitSmsCodeOnPage"));
  await controller.cancel("sms-run-1");
  assert.equal((await Promise.race([running, failAfter(100)])).state, "CANCELLED");
  assert.equal(chrome.removedTabs.filter((id) => id === 30).length, 1);
});
```

另写两个独立测试：取消 15 秒 sleep 后不 reload；取消 pending helper read 后 `run()` 及时返回。多验证码必须映射为 `sms_code_ambiguous` 且不刷新。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/sms-lab-controller.test.mjs`

Expected: 新增刷新、重定向和取消 tests FAIL。

- [ ] **Step 3: 实现有界循环**

```javascript
const REFRESH_INTERVAL_MS = 15_000;
const TOTAL_TIMEOUT_MS = 60_000;
const HELPER_READ_TIMEOUT_MS = 5_000;
const HELPER_LOAD_POLL_MS = 100;
```

循环必须在每次 helper 完成加载后执行：

1. `tabs.get(helperTabId)` 确认 tab 存在、状态 complete、最终 URL 合法。
2. 使用可取消包装执行 `readVisibleTotpCode({timeoutMs})`。
3. 成功立即返回 code。
4. `totp_code_ambiguous` 映射并抛出 `sms_code_ambiguous`。
5. 非 `code_not_present` 错误立即失败。
6. 等待到下一 15 秒边界；达到 60 秒时执行最后一次有界读取。
7. 只有未取消且未到截止时间时才 `tabs.reload(helperTabId)`。

- [ ] **Step 4: 实现取消**

`cancel(runId)` 必须 abort 当前 run，best-effort 在目标页执行 `cancelSmsOnPage`，关闭已知 helper，并使原 `run()` 及时返回 `CANCELLED`。Native 请求、`tabs.create`、helper read 和短信 submit 均使用 abortable 包装；每个延迟结果后调用 `throwIfCancelled(run)`。

- [ ] **Step 5: 运行全部扩展 tests 并提交**

Run:

```powershell
node --test extension/tests/sms-lab-controller.test.mjs
node --test extension/tests/*.test.mjs
node --check extension/sms-lab-controller.js
git diff --check
```

Expected: 新增和已有扩展 tests 全部 PASS。

```powershell
git add extension/sms-lab-controller.js extension/tests/sms-lab-controller.test.mjs
git commit -m "Bound SMS helper refresh and cancellation"
```

### Task 6: Service Worker 路由、精确权限和打包

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json`
- Modify: `extension/tests/background.test.mjs`
- Modify: `scripts/package-extension.ps1`

- [ ] **Step 1: 写路由和权限失败测试**

```javascript
test("declares only the two fixed lab hosts", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, [
    "http://totp-lab.local/*",
    "http://sms-lab.local/*",
  ]);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});

test("routes run_sms_lab and rejects caller-supplied sensitive fields", async () => {
  const response = await send({
    type: "run_sms_lab",
    motherTabId: 10,
    incognitoTabId: 20,
    excelRow: 2,
    phone: "sensitive",
    challengeUrl: "http://evil.test",
    code: "123456",
  });
  assert.deepEqual(response, { ok: false, error: "request_invalid" });
});
```

还要覆盖 `cancel_sms_lab` 只允许 `type/runId`、`sms_lab_state` 只允许 `type`、错误 sender 被拒绝、打包脚本包含三个短信文件。

- [ ] **Step 2: 运行测试并确认红灯**

Run: `node --test extension/tests/background.test.mjs`

Expected: FAIL because SMS routing and permission are absent.

- [ ] **Step 3: 接入控制器和严格消息校验**

```javascript
const smsLabController = createSmsLabController(api);
const RUN_SMS_KEYS = new Set(["type", "motherTabId", "incognitoTabId", "excelRow"]);
const CANCEL_SMS_KEYS = new Set(["type", "runId"]);
const STATE_SMS_KEYS = new Set(["type"]);
```

所有短信消息先检查 `sender.id === api.runtime.id`，再检查对应字段集合。`run_sms_lab` 异步调用 `run()`；`cancel_sms_lab` 异步调用 `cancel()`；`sms_lab_state` 同步返回 `getState()`。

- [ ] **Step 4: 更新权限和打包清单**

`manifest.json` 的 `host_permissions` 精确为：

```json
[
  "http://totp-lab.local/*",
  "http://sms-lab.local/*"
]
```

`scripts/package-extension.ps1` 增加：

```powershell
'sms-lab-selectors.js',
'sms-lab-page.js',
'sms-lab-controller.js'
```

- [ ] **Step 5: 运行测试并提交**

Run:

```powershell
node --test extension/tests/background.test.mjs
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-extension-package-sms")
```

Expected: tests 和打包均成功。

```powershell
git add extension/background.js extension/manifest.json extension/tests/background.test.mjs scripts/package-extension.ps1
git commit -m "Route the SMS lab workflow through the extension service worker"
```

### Task 7: 中文文档、完整回归和安全扫描

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新中文说明**

README 必须说明：

- TOTP 成功后由上层调用独立 `run_sms_lab`。
- 同一物理行 D 列为手机号、E 列为 `sms-lab.local` 完整 URL。
- 四个选择器占位符文件和配置方法。
- 母页保持 active，辅助页位于母页右侧后台。
- 15 秒刷新、60 秒截止、多验证码拒绝。
- 不记录手机号、URL、验证码，不连接商业接码平台。
- 当前短信模块不推进 Excel 行、不点击最终接受按钮、不启动下一任务。

- [ ] **Step 2: 运行最终验证**

Run:

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-extension-package-sms-final")
python -m py_compile native_host/host.py native_host/cc_batch/sms_lab.py
node --check extension/sms-lab-page.js
node --check extension/sms-lab-controller.js
git diff --check
rg -n "<all_urls>|2fa\.run|commercial|page\.mouse|drag_to|generate_track" extension native_host README.md
```

Expected:

- Native、集成和扩展测试全部 PASS。
- 扩展 ZIP 成功生成。
- Python/JavaScript 语法检查通过。
- 安全扫描不出现商业接码、鼠标拖动或宽权限实现；否定性文档和测试断言命中可接受。

- [ ] **Step 3: 提交**

```powershell
git add README.md
git commit -m "Document the local SMS verification workflow"
```

## 计划自审

- Task 1/2 覆盖同一物理行 D/E 读取、URL 固定边界和 Native 命令。
- Task 3 覆盖四个选择器占位符、30 秒稳定等待、手机号与验证码页面动作。
- Task 4/5 覆盖同一无痕页、母页 active、辅助页右侧、15/60 时序、重定向和取消竞态。
- Task 6 覆盖严格消息字段、精确 host permission 和打包文件。
- Task 7 覆盖中文说明、完整回归和安全扫描。
- 所有后续任务使用统一函数名：`build_sms_lab_challenge`、`requestSmsOnPage`、`submitSmsCodeOnPage`、`createSmsLabController`。
- 计划不包含未定义的业务阶段，不推进 Excel 行，不实现最终接受按钮或下一轮循环。
