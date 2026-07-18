# TOTP Lab 辅助流程实施计划

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 实现一个由上层工作流传入母页、无痕页和 Excel 行号的 TOTP Lab 辅助控制器：从 cc汇总.xlsx C 列构造本地测试 URL，在母页右侧后台读取唯一 6 位验证码，15 秒刷新、60 秒截止，关闭辅助 tab 后在无痕页完成 TOTP 提交。

**Architecture:** Native Host 负责精确读取第一个工作表的物理行和构造 totp-lab.local 测试 URL；Chrome Service Worker 负责校验 tab 归属、创建母页右侧的后台辅助 tab、读取可见验证码、清理辅助 tab，并调用现有一次性验证码页面动作。母页保持普通窗口的 active tab，TOTP 子模块不推进 Excel 行、不提取随机链接、不启动下一轮。

**Tech Stack:** Python 3.11 标准库、XLSX Open XML 读取器、Chrome Manifest V3、Native Messaging、chrome.tabs、chrome.scripting、Node.js built-in test runner、Python unittest。

---

## 执行约束

- 当前工作区存在其他未提交改动。每个任务只暂存本任务列出的文件，禁止使用 git add -A、git reset --hard 或覆盖无关改动。
- 每个生产代码变更都必须先有一个能按预期失败的测试，再写最小实现，再运行相关回归，最后单独提交。
- 不实现滑块识别、鼠标轨迹、拖动或 CAPTCHA 绕过逻辑；测试钩子只由 totp-lab.local 自建靶场解释。
- 母页永远不得被 tabs.update、tabs.reload、tabs.remove 或 windows.remove 操作。
- 辅助 URL 中的实验密钥会出现在普通浏览历史中，这是已确认的本地实验取舍；代码不得额外记录 URL 或密钥。

## 文件地图

- Modify: native_host/cc_batch/xlsx_xml.py
- Modify: native_host/cc_batch/config.py
- Create: native_host/cc_batch/totp_lab.py
- Modify: native_host/host.py
- Create: native_host/tests/test_xlsx_xml.py
- Create: native_host/tests/test_totp_lab.py
- Modify: native_host/tests/test_config.py
- Modify: native_host/tests/test_host_protocol.py
- Modify: native_host/tests/xlsx_fixture.py
- Create: extension/totp-lab-page.js
- Create: extension/tests/totp-lab-page.test.mjs
- Create: extension/totp-lab-controller.js
- Create: extension/tests/totp-lab-controller.test.mjs
- Modify: extension/background.js
- Modify: extension/tests/background.test.mjs
- Modify: extension/manifest.json
- Modify: scripts/package-extension.ps1
- Modify: native_host/config.json
- Modify: README.md

---

### Task 1: 保留 XLSX 物理行号

**Files:** native_host/tests/xlsx_fixture.py, native_host/tests/test_xlsx_xml.py, native_host/cc_batch/xlsx_xml.py

- [ ] Step 1: 写失败测试

让 write_xlsx 接受可选 row_numbers，新增测试：

~~~
from pathlib import Path
import tempfile
import unittest
from native_host.cc_batch.xlsx_xml import read_numbered_workbook, read_workbook
from native_host.tests.xlsx_fixture import write_xlsx

class NumberedWorkbookTests(unittest.TestCase):
    def test_preserves_physical_row_numbers_and_legacy_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["header"], ["target"]], row_numbers=[1, 5])
            numbered = read_numbered_workbook(path)
            self.assertEqual(numbered["Sheet1"], [(1, ["header"]), (5, ["target"])])
            self.assertEqual(read_workbook(path)["Sheet1"], [["header"], ["target"]])

    def test_rejects_duplicate_or_invalid_physical_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.xlsx"
            write_xlsx(path, [["a"], ["b"]], row_numbers=[2, 2])
            with self.assertRaisesRegex(ValueError, "invalid_row_number"):
                read_numbered_workbook(path)
~~~

- [ ] Step 2: 运行红灯

~~~
python -m unittest native_host.tests.test_xlsx_xml -v
~~~

预期：FAIL，因为 read_numbered_workbook 尚未定义。

- [ ] Step 3: 实现

抽取 sheet 解析函数，保留 XML row 的 r 属性，并让旧 read_workbook 只投影 values：

~~~
def _read_sheet_rows(zf, sheet_path, shared):
    root = ET.fromstring(zf.read(sheet_path))
    sheet_data = root.find(_tag(MAIN, "sheetData"))
    if sheet_data is None:
        return []
    result = []
    seen = set()
    for row in sheet_data.findall(_tag(MAIN, "row")):
        try:
            row_number = int(row.attrib.get("r", "0"))
        except ValueError:
            raise XlsxError("invalid_row_number") from None
        if row_number < 1 or row_number in seen:
            raise XlsxError("invalid_row_number")
        seen.add(row_number)
        values = []
        for cell in row.findall(_tag(MAIN, "c")):
            index = column_index(cell.attrib.get("r", "A1"))
            while len(values) < index:
                values.append("")
            values[index - 1] = _cell_value(cell, shared)
        result.append((row_number, values))
    return result

def read_numbered_workbook(path):
    with ZipFile(Path(path), "r") as zf:
        shared = _shared_strings(zf)
        return {name: _read_sheet_rows(zf, part, shared) for name, part in _sheet_parts(zf)}

def read_workbook(path):
    return {name: [values for _number, values in rows]
            for name, rows in read_numbered_workbook(path).items()}
~~~

更新 fixture 时，row_numbers 默认使用 1..len(rows)，同时写入 row r 和 cell reference。不要改变旧 API 返回结构。

- [ ] Step 4: 运行测试

~~~
python -m unittest native_host.tests.test_xlsx_xml native_host.tests.test_account_totp -v
~~~

预期：全部 PASS。

- [ ] Step 5: 提交

~~~
git add native_host/cc_batch/xlsx_xml.py native_host/tests/xlsx_fixture.py native_host/tests/test_xlsx_xml.py
git commit -m "Preserve physical spreadsheet row numbers" -m "TOTP Lab row selection must use Excel physical rows while existing workbook consumers retain their list-based API." -m "Constraint: Existing batch readers keep their return shape" -m "Rejected: Use list indexes as row numbers | sparse XML rows would select the wrong account" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: numbered workbook and account matching tests" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

### Task 2: 增加 TOTP Lab 配置字段

**Files:** native_host/tests/test_config.py, native_host/cc_batch/config.py

- [ ] Step 1: 写失败测试

增加字段读取、缺省和类型测试：

~~~
def test_loads_totp_lab_fields_without_changing_legacy_defaults(self):
    path = self.write_config({
        "input_excel": "input.xlsx", "url_column": "url",
        "txt_directory": "txt", "output_excel": "summary.xlsx",
        "download_timeout_seconds": 180, "field_mappings": {},
        "totp_lab_url": "http://totp-lab.local/",
        "totp_lab_test_hook": "lab-test",
    })
    config = load_config(path)
    self.assertEqual(config.totp_lab_url, "http://totp-lab.local/")
    self.assertEqual(config.totp_lab_test_hook, "lab-test")

def test_missing_totp_lab_fields_default_to_empty_strings(self):
    config = load_config(self.write_config({
        "input_excel": "input.xlsx", "url_column": "url",
        "txt_directory": "txt", "output_excel": "summary.xlsx",
        "download_timeout_seconds": 180, "field_mappings": {},
    }))
    self.assertEqual(config.totp_lab_url, "")
    self.assertEqual(config.totp_lab_test_hook, "")

def test_rejects_non_string_totp_lab_fields(self):
    path = self.write_config({
        "input_excel": "input.xlsx", "url_column": "url",
        "txt_directory": "txt", "output_excel": "summary.xlsx",
        "download_timeout_seconds": 180, "field_mappings": {},
        "totp_lab_url": 7,
    })
    with self.assertRaisesRegex(ConfigError, "invalid_totp_lab_url"):
        load_config(path)
~~~

- [ ] Step 2: 运行红灯

~~~
python -m unittest native_host.tests.test_config -v
~~~

预期：FAIL，因为 Config 尚无 Lab 字段。

- [ ] Step 3: 实现

在 Config 默认字段后增加 totp_lab_url: str = "" 和 totp_lab_test_hook: str = ""。在 load_config 增加：

~~~
def _optional_string(payload, key):
    value = payload.get(key, "")
    if not isinstance(value, str):
        raise ConfigError(f"invalid_{key}")
    return value.strip()
~~~

返回 Config 时传入两个字段。缺失字段必须保持空字符串，以免破坏旧配置。

- [ ] Step 4: 运行配置全测

~~~
python -m unittest native_host.tests.test_config -v
~~~

预期：全部 PASS。

- [ ] Step 5: 提交

~~~
git add native_host/cc_batch/config.py native_host/tests/test_config.py
git commit -m "Add local TOTP Lab configuration fields" -m "Keep Lab URL and test-hook settings optional so existing batch and local RFC6238 configurations remain valid." -m "Constraint: Missing Lab fields must not break existing Native Host commands" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: native_host.tests.test_config" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

### Task 3: 构造指定 Excel 行的 TOTP Lab URL

**Files:** native_host/cc_batch/totp_lab.py, native_host/tests/test_totp_lab.py

- [ ] Step 1: 写失败测试

使用 row_numbers=[1, 3, 5]，断言读取物理第 5 行并进行 path/query 编码：

~~~
def test_builds_encoded_challenge_url_from_physical_c_row(self):
    workbook = directory / "accounts.xlsx"
    write_xlsx(workbook,
        [["header", "", ""], ["skip", "", ""], ["target", "", "A B/+测"]],
        row_numbers=[1, 3, 5])
    url = build_totp_lab_challenge(self.config(directory, workbook), 5)
    self.assertEqual(
        url,
        "http://totp-lab.local/A%20B%2F%2B%E6%B5%8B?test_hook=hook%20%2F%201",
    )
~~~

同时覆盖 row=0、bool、row 不存在、C 为空、非固定本地域名和测试钩子占位符，分别断言固定错误码。

- [ ] Step 2: 运行红灯

~~~
python -m unittest native_host.tests.test_totp_lab -v
~~~

预期：FAIL，因为 totp_lab.py 不存在。

- [ ] Step 3: 实现 URL builder

~~~
from urllib.parse import quote, urlencode, urlsplit
from .config import Config
from .xlsx_xml import XlsxError, read_numbered_workbook

TEST_HOOK_PLACEHOLDER = "__FILL_TOTP_TEST_HOOK__"

class TotpLabError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code

def _validate_base_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.netloc != "totp-lab.local"
        or parsed.path != "/" or parsed.query or parsed.fragment):
        raise TotpLabError("totp_lab_url_invalid")
    return value

def build_totp_lab_challenge(config: Config, excel_row: int) -> str:
    if isinstance(excel_row, bool) or not isinstance(excel_row, int) or excel_row < 1:
        raise TotpLabError("excel_row_invalid")
    base_url = _validate_base_url(config.totp_lab_url)
    if not config.totp_lab_test_hook or config.totp_lab_test_hook == TEST_HOOK_PLACEHOLDER:
        raise TotpLabError("totp_test_hook_not_configured")
    try:
        workbook = read_numbered_workbook(config.input_excel)
    except FileNotFoundError:
        raise TotpLabError("input_excel_missing") from None
    except (OSError, XlsxError, ValueError):
        raise TotpLabError("input_excel_invalid") from None
    rows = next(iter(workbook.values()), [])
    values = next((values for row_number, values in rows if row_number == excel_row), None)
    if values is None:
        raise TotpLabError("account_row_not_found")
    secret = values[2] if len(values) > 2 else ""
    if not secret:
        raise TotpLabError("totp_secret_missing")
    encoded_secret = quote(secret, safe="")
    encoded_hook = urlencode({"test_hook": config.totp_lab_test_hook}, quote_via=quote)
    return base_url + encoded_secret + "?" + encoded_hook
~~~

不返回 secret 或 test_hook 独立字段；成功值只有完整本地挑战 URL。

- [ ] Step 4: 运行测试

~~~
python -m unittest native_host.tests.test_totp_lab native_host.tests.test_xlsx_xml -v
~~~

预期：全部 PASS。

- [ ] Step 5: 提交

~~~
git add native_host/cc_batch/totp_lab.py native_host/tests/test_totp_lab.py
git commit -m "Build bounded local TOTP Lab challenge URLs" -m "Construct the exact lab URL from the selected physical Excel row while keeping the C column out of standalone Native Host response fields." -m "Constraint: Only http://totp-lab.local/ is accepted" -m "Rejected: Accept arbitrary URL configuration | it would become an open secret-forwarding primitive" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: TOTP Lab URL and physical-row tests" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~


### Task 4: 暴露 get_totp_lab_challenge Native Messaging 命令

**Files:** native_host/tests/test_host_protocol.py, native_host/host.py

- [ ] Step 1: 写 Native Host 失败测试

让现有 config helper 接受 Lab 字段，增加：

~~~
def test_get_totp_lab_challenge_returns_only_the_constructed_url(self):
    with tempfile.TemporaryDirectory() as name:
        directory = Path(name)
        input_path = directory / "accounts.xlsx"
        write_xlsx(input_path, [["header", "", ""], ["alice", "pass", "JBSWY3D/测"]])
        config_path = self._write_totp_config(
            directory, input_path,
            {"totp_lab_url": "http://totp-lab.local/", "totp_lab_test_hook": "lab-hook"},
        )
        result = HostApplication(config_path).dispatch({
            "command": "get_totp_lab_challenge", "excel_row": 2,
        })
        self.assertEqual(result, {
            "ok": True,
            "challenge_url": "http://totp-lab.local/JBSWY3D%2F%E6%B5%8B?test_hook=lab-hook",
        })
        self.assertNotIn("secret", result)
        self.assertNotIn("test_hook", result)

def test_get_totp_lab_challenge_rejects_invalid_requests_without_echoing_values(self):
    result = HostApplication("unused.json").dispatch({
        "command": "get_totp_lab_challenge", "excel_row": "2", "secret": "sensitive",
    })
    self.assertEqual(result, {"ok": False, "error": "request_invalid", "fatal": False})
    self.assertNotIn("sensitive", str(result))
~~~

- [ ] Step 2: 运行红灯

~~~
python -m unittest native_host.tests.test_host_protocol.HostProtocolTests.test_get_totp_lab_challenge_returns_only_the_constructed_url -v
~~~

预期：FAIL，因为 dispatch 返回 unknown_command。

- [ ] Step 3: 接入 dispatch

在 host.py 导入 TotpLabError 和 build_totp_lab_challenge，加入：

~~~
def _get_totp_lab_challenge(self, message):
    excel_row = message.get("excel_row")
    if isinstance(excel_row, bool) or not isinstance(excel_row, int):
        return {"ok": False, "error": "request_invalid", "fatal": False}
    try:
        config = load_config(self.config_path)
        return {"ok": True, "challenge_url": build_totp_lab_challenge(config, excel_row)}
    except TotpLabError as exc:
        return {"ok": False, "error": exc.code, "fatal": False}
    except ConfigError:
        return {"ok": False, "error": "input_excel_invalid", "fatal": False}
~~~

在 dispatch 中把 get_totp_lab_challenge 放在批处理命令白名单之前，确保它不会返回 unknown_command。

- [ ] Step 4: 运行 Native Host 全测

~~~
python -m unittest native_host.tests.test_host_protocol native_host.tests.test_totp_lab -v
~~~

预期：命令成功、错误码和既有 Native Messaging 测试全部 PASS。

- [ ] Step 5: 提交

~~~
git add native_host/host.py native_host/tests/test_host_protocol.py
git commit -m "Expose the local TOTP Lab challenge command" -m "Add a structured Native Messaging command that returns only the constructed local challenge URL for a validated Excel row." -m "Constraint: Native Host errors remain fixed-code and non-fatal" -m "Rejected: Return the C-column secret separately | the browser only needs the assembled lab URL" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: host protocol and Lab challenge tests" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

### Task 5: 页面可见验证码读取函数

**Files:** extension/totp-lab-page.js, extension/tests/totp-lab-page.test.mjs

- [ ] Step 1: 写页面函数失败测试

~~~
import test from "node:test";
import assert from "node:assert/strict";
import { readVisibleTotpCode } from "../totp-lab-page.js";

function environment(text, readyState = "complete") {
    return {
        document: { readyState, body: { innerText: text }, documentElement: {} },
        waitForQuiet: async () => {},
        sleep: async () => {},
        now: () => 1000,
    };
}

test("returns the only independent visible six-digit code", async () => {
    assert.deepEqual(
        await readVisibleTotpCode({ timeoutMs: 100 }, environment("实验验证码：123456")),
        { ok: true, code: "123456" },
    );
});

test("rejects long numbers and multiple candidates", async () => {
    assert.deepEqual(
        await readVisibleTotpCode({ timeoutMs: 100 }, environment("编号 1234567")),
        { ok: false, error: "code_not_present" },
    );
    assert.deepEqual(
        await readVisibleTotpCode({ timeoutMs: 100 }, environment("A 123456 B 654321")),
        { ok: false, error: "totp_code_ambiguous" },
    );
});
~~~

- [ ] Step 2: 运行红灯

~~~
node --test extension/tests/totp-lab-page.test.mjs
~~~

预期：FAIL，因为 totp-lab-page.js 不存在。

- [ ] Step 3: 实现稳定可见文本扫描

函数必须自包含，以便传给 chrome.scripting.executeScript：

~~~
export async function readVisibleTotpCode({ timeoutMs = 5_000, quietMs = 800, sampleGapMs = 250 }, env = {}) {
    const resolveDocument = () => env.getDocument?.() ?? env.document ?? globalThis.document;
    const now = env.now ?? Date.now;
    const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const waitForQuiet = env.waitForQuiet ?? (async () => {});
    const started = now();
    const readText = () => {
        const documentObject = resolveDocument();
        if (documentObject?.readyState !== "complete") return null;
        return typeof documentObject.body?.innerText === "string" ? documentObject.body.innerText : null;
    };
    while (now() - started < timeoutMs) {
        await waitForQuiet(quietMs, env.signal);
        const first = readText();
        if (first == null) {
            await sleep(sampleGapMs, env.signal);
            continue;
        }
        await sleep(sampleGapMs, env.signal);
        const second = readText();
        if (first !== second || second == null) continue;
        const unique = [...new Set([...second.matchAll(/(?<!\d)\d{6}(?!\d)/g)].map((match) => match[0]))];
        if (unique.length === 1) return { ok: true, code: unique[0] };
        if (unique.length > 1) return { ok: false, error: "totp_code_ambiguous" };
        return { ok: false, error: "code_not_present" };
    }
    return { ok: false, error: "helper_page_not_stable" };
}
~~~

函数不得点击、拖动或修改人机验证控件。

- [ ] Step 4: 运行页面函数全测

~~~
node --test extension/tests/totp-lab-page.test.mjs extension/tests/totp-page.test.mjs
~~~

预期：新页面测试和现有 OTP 填写测试全部 PASS。

- [ ] Step 5: 提交

~~~
git add extension/totp-lab-page.js extension/tests/totp-lab-page.test.mjs
git commit -m "Read unique visible TOTP Lab codes" -m "Add a serializable page action that only reads stable visible text and refuses missing or ambiguous six-digit codes." -m "Constraint: No human-verification interaction is allowed" -m "Rejected: Select the first six-digit match | multiple candidates can cause an incorrect login" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: Lab page and existing OTP page tests" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

### Task 6: TOTP Lab 控制器的校验和成功路径

**Files:** extension/totp-lab-controller.js, extension/tests/totp-lab-controller.test.mjs

- [ ] Step 1: 写成功路径失败测试

Fake Chrome API 必须提供：
- tabs.get(10) 返回普通且 active 的母页；
- tabs.get(20) 返回无痕目标页；
- tabs.create() 记录 windowId、index、active:false、url 并返回 30；
- tabs.remove() 记录 30；
- scripting.executeScript() 返回注册成功、唯一 code 123456、填写成功；
- Native port 对 get_totp_lab_challenge 返回固定本地域名 URL。

测试断言：

~~~
test("creates a background helper beside the active mother tab and fills the same incognito tab", async () => {
    const chrome = makeChrome();
    const result = await createTotpLabController(chrome, { makeRunId: () => "run-1" })
        .run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.equal(result.state, "SUCCEEDED");
    assert.equal(chrome.createdTabs[0].windowId, 1);
    assert.equal(chrome.createdTabs[0].index, 4);
    assert.equal(chrome.createdTabs[0].active, false);
    assert.equal(chrome.removedTabs[0], 30);
    assert.equal(chrome.fills[0].target.tabId, 20);
    assert.equal(chrome.fills[0].args[0].timeoutMs, 30_000);
    assert.deepEqual(chrome.motherMutations, []);
});
~~~

另外先写母页不存在/不 active、母页为无痕、目标 tab 非无痕、ID 相同四个校验测试，均断言不创建 helper。

- [ ] Step 2: 运行红灯

~~~
node --test extension/tests/totp-lab-controller.test.mjs
~~~

预期：FAIL，因为控制器模块尚不存在。

- [ ] Step 3: 实现最小成功路径

控制器必须实现：
- Native request timeout 15s，只发送 excel_row；
- assertTabs：mother 必须普通窗口且 active===true，target 必须 incognito===true，ID 不同；
- 在 target 执行 registerTotpOnPage，注入失败映射为 incognito_active_tab_required；
- 请求 challenge URL 并验证 origin 为 http://totp-lab.local；
- 创建 tabs.create({windowId: mother.windowId, index: mother.index + 1, active:false, url});
- 创建前后重查母页 active；
- 关闭 helper 后调用 fillTotpOnPage({code, runId, requireExistingToken:true, timeoutMs:30000})；
- 公共状态只能包含 state、runId、error。

复用现有 registerTotpOnPage、fillTotpOnPage、cancelTotpOnPage，不复制 OTP 输入框逻辑。控制器不接受 challengeUrl 或密钥作为调用参数。

- [ ] Step 4: 运行成功路径和既有扩展测试

~~~
node --test extension/tests/totp-lab-controller.test.mjs extension/tests/totp-controller.test.mjs extension/tests/totp-page.test.mjs
~~~

预期：新控制器成功/校验测试及既有 TOTP 测试全部 PASS。

- [ ] Step 5: 提交

~~~
git add extension/totp-lab-controller.js extension/tests/totp-lab-controller.test.mjs
git commit -m "Add TOTP Lab tab ownership and success flow" -m "Create the reusable controller that protects the active mother tab, validates the incognito target, creates a background helper beside the mother, and fills the original incognito tab." -m "Constraint: The caller must have triggered activeTab in the target incognito tab" -m "Rejected: Reactivate the mother tab automatically | the module must not hide user or extension state changes" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: controller and existing TOTP tests" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~


### Task 7: 加入 15 秒刷新、60 秒截止和取消清理

**Files:** extension/totp-lab-controller.js, extension/tests/totp-lab-controller.test.mjs

- [ ] Step 1: 写刷新、歧义、截止和取消失败测试

使用可控时钟和 helper 结果队列，覆盖 0/15/30/45/60 秒读取、三次 reload、60 秒失败、歧义不 reload、取消只移除 helper：

~~~
test("refreshes every 15 seconds and stops at the 60-second deadline", async () => {
    const chrome = makeChrome({
        helperResults: [
            { ok: false, error: "code_not_present" },
            { ok: false, error: "code_not_present" },
            { ok: false, error: "code_not_present" },
            { ok: false, error: "code_not_present" },
            { ok: false, error: "code_not_present" },
        ],
    });
    const clock = fakeClock();
    const result = await createTotpLabController(chrome, {
        makeRunId: () => "run-1",
        now: clock.now,
        sleep: clock.sleep,
    }).run({ motherTabId: 10, incognitoTabId: 20, excelRow: 2 });

    assert.deepEqual(result, { state: "FAILED", runId: "run-1", error: "totp_code_not_found" });
    assert.deepEqual(chrome.reloadedTabs, [30, 30, 30]);
    assert.equal(clock.elapsed, 60_000);
});
~~~

- [ ] Step 2: 运行红灯

~~~
node --test extension/tests/totp-lab-controller.test.mjs
~~~

预期：FAIL，因为控制器当前只读取一次。

- [ ] Step 3: 实现有界刷新循环

使用 REFRESH_INTERVAL_MS=15000、TOTAL_TIMEOUT_MS=60000、HELPER_READ_TIMEOUT_MS=5000。核心循环：

~~~
async function waitForCode(run) {
    const deadline = now() + TOTAL_TIMEOUT_MS;
    while (true) {
        await waitForHelperComplete(run, Math.min(HELPER_READ_TIMEOUT_MS, Math.max(1, deadline - now())));
        const result = await executeRead(run, Math.max(1, Math.min(HELPER_READ_TIMEOUT_MS, deadline - now())));
        if (result?.ok) return result.code;
        if (result?.error === "totp_code_ambiguous") throw new Error("totp_code_ambiguous");
        if (result?.error !== "code_not_present") throw new Error(result?.error || "helper_page_not_stable");
        const remaining = deadline - now();
        if (remaining <= 0) throw new Error("totp_code_not_found");
        await sleep(Math.min(15_000, remaining), run.abort.signal);
        if (!stillActive(run)) throw new Error("cancelled");
        if (now() >= deadline) {
            const final = await executeRead(run, 1);
            if (final?.ok) return final.code;
            if (final?.error === "totp_code_ambiguous") throw new Error("totp_code_ambiguous");
            throw new Error("totp_code_not_found");
        }
        await api.tabs.reload(run.helperTabId);
    }
}
~~~

waitForHelperComplete 轮询 tabs.get(helperTabId).status===complete，每次最多等待 100ms，且不超出总 deadline。默认 sleep 必须响应 AbortSignal；cancel 调用 run.abort.abort()，清除 helper 计时器并最佳努力执行 cancelTotpOnPage。

- [ ] Step 4: 运行控制器和全量扩展回归

~~~
node --test extension/tests/totp-lab-controller.test.mjs extension/tests/*.test.mjs
~~~

预期：刷新次数、60 秒截止、歧义、取消测试和所有原有扩展测试 PASS。

- [ ] Step 5: 提交

~~~
git add extension/totp-lab-controller.js extension/tests/totp-lab-controller.test.mjs
git commit -m "Bound TOTP Lab refreshes and cancellation" -m "Retry missing Lab codes every fifteen seconds, enforce a sixty-second deadline, refuse ambiguous codes, and clean up only the helper tab on cancellation." -m "Constraint: The total wait must not be extended by slow page loads" -m "Rejected: Infinite refresh loop | a task must return a stable failure for the parent workflow" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: controller timing, cancellation, and extension suite" -m "Co-authored-by: Omx <omx@oh-my-codex.dev>"
~~~

### Task 8: Service Worker 路由、Manifest 精确权限和扩展打包

**Files:** extension/background.js, extension/tests/background.test.mjs, extension/manifest.json, scripts/package-extension.ps1

- [ ] Step 1: 写路由和权限失败测试

把 Manifest 测试改为：

~~~
test("declares only the fixed TOTP Lab host and never all URLs", async () => {
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.deepEqual(manifest.host_permissions, ["http://totp-lab.local/*"]);
    assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
});
~~~

增加秘密参数拒绝和非敏感状态测试：

~~~
test("rejects caller-supplied challenge URLs or secrets", async () => {
    const chrome = makeChrome();
    createExtensionRuntime(chrome);
    const response = await new Promise((resolve) => {
        const keepChannelOpen = chrome.messageListener(
            { type: "run_totp_lab", motherTabId: 10, incognitoTabId: 20, excelRow: 2, challengeUrl: "secret" },
            { id: "ext" },
            resolve,
        );
        assert.equal(keepChannelOpen, false);
    });
    assert.deepEqual(response, { ok: false, error: "request_invalid" });
});

test("exposes non-sensitive TOTP Lab state", async () => {
    const chrome = makeChrome();
    createExtensionRuntime(chrome);
    const response = await new Promise((resolve) => {
        chrome.messageListener({ type: "totp_lab_state" }, { id: "ext" }, resolve);
    });
    assert.deepEqual(response, { ok: true, result: { state: "IDLE", runId: null, error: "" } });
});
~~~

- [ ] Step 2: 运行红灯

~~~
node --test extension/tests/background.test.mjs
~~~

预期：FAIL，因为没有固定 host permission 和 TOTP Lab 路由。

- [ ] Step 3: 接入控制器和路由

在 background.js 导入并实例化 createTotpLabController。listener 前置增加：

~~~
if (message?.type === "run_totp_lab") {
    const allowed = new Set(["type", "motherTabId", "incognitoTabId", "excelRow"]);
    if (sender?.id !== api.runtime.id || Object.keys(message).some((key) => !allowed.has(key))) {
        sendResponse({ ok: false, error: "request_invalid" });
        return false;
    }
    void totpLabController.run(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: safeRouteError(error) }));
    return true;
}
if (message?.type === "cancel_totp_lab") {
    if (sender?.id !== api.runtime.id) {
        sendResponse({ ok: false, error: "sender_rejected" });
        return false;
    }
    void totpLabController.cancel(message.runId)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: safeRouteError(error) }));
    return true;
}
if (message?.type === "totp_lab_state") {
    if (sender?.id !== api.runtime.id) {
        sendResponse({ ok: false, error: "sender_rejected" });
        return false;
    }
    sendResponse({ ok: true, result: totpLabController.getState() });
    return false;
}
~~~

返回对象增加 totpLabController，保留现有 start/state 路由。Manifest 添加 host_permissions=[http://totp-lab.local/*]，不删除现有 permissions。package-extension.ps1 的 requiredFiles 增加 totp-lab-controller.js 和 totp-lab-page.js。

- [ ] Step 4: 运行路由和打包测试

~~~
node --test extension/tests/background.test.mjs extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-extension-package-check")
~~~

预期：扩展测试全 PASS，打包输出包含两个新脚本。

- [ ] Step 5: 提交

~~~
git add extension/background.js extension/tests/background.test.mjs extension/manifest.json scripts/package-extension.ps1
git commit -m "Route the bounded TOTP Lab workflow" -m "Expose the Lab controller through Service Worker messages, grant only the fixed local Lab host, and include its scripts in extension packaging." -m "Constraint: Caller cannot provide a challenge URL or secret" -m "Rejected: Add broad host permissions | the Lab domain is fixed and local" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: extension suite and package generation" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

### Task 9: 配置、中文 README 和最终回归

**Files:** native_host/config.json, native_host/tests/test_smoke.py, README.md

- [ ] Step 1: 写固定配置失败测试

在 test_smoke.py 增加：

~~~
import json

def test_totp_lab_configuration_points_to_summary_workbook(self):
    payload = json.loads(Path("native_host/config.json").read_text(encoding="utf-8"))
    self.assertTrue(payload["input_excel"].endswith("cc汇总.xlsx"))
    self.assertEqual(payload["totp_lab_url"], "http://totp-lab.local/")
    self.assertEqual(payload["totp_lab_test_hook"], "__FILL_TOTP_TEST_HOOK__")
~~~

- [ ] Step 2: 运行红灯

~~~
python -m unittest native_host.tests.test_smoke -v
~~~

预期：FAIL，因为当前配置仍指向旧输入文件且没有 Lab 字段。

- [ ] Step 3: 更新固定配置和中文说明

config.json 保留旧批处理字段，只替换/增加：

~~~
"input_excel": "C:\\Users\\HE\\Downloads\\jingshajingsha\\cc汇总.xlsx",
"totp_lab_url": "http://totp-lab.local/",
"totp_lab_test_hook": "__FILL_TOTP_TEST_HOOK__"
~~~

README 增加中文说明：调用方传入母页、无痕页和 Excel 行号；母页保持 active；辅助 tab 在母页右侧后台打开；第 1 行是表头、从第 2 行开始；随机链接按获取顺序对应 Excel 行；当前 TOTP 子模块不推进循环；测试钩子由本地靶场解释；15 秒刷新、60 秒截止；多值歧义；普通历史可能保存实验 URL；不包含滑块或 CAPTCHA 绕过。

- [ ] Step 4: 运行最终验证

~~~
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-extension-package-final")
git diff --check
rg -n "2fa\.run|<all_urls>|drag|captcha|secret|password|code" extension native_host README.md
~~~

预期：所有测试 PASS，打包成功，git diff --check 无错误；扫描不出现公共 2fa.run、<all_urls> 或自动滑块代码。secret/password/code 只允许出现在必要协议字段、测试断言和固定错误处理中，不得写入日志或公共状态。

如需更新已安装 Native Host，再执行：

~~~
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId <32位扩展ID>
powershell -ExecutionPolicy Bypass -File .\scripts\verify-install.ps1 -ExtensionId <32位扩展ID>
~~~

- [ ] Step 5: 提交

~~~
git add native_host/config.json native_host/tests/test_smoke.py README.md
git commit -m "Document and configure the local TOTP Lab workflow" -m "Point the Native Host at cc汇总.xlsx, document the parent tab contract and bounded Lab retry behavior in Chinese, and preserve the local-only safety boundary." -m "Constraint: The mother-page link extractor remains a later module" -m "Rejected: Add a loop runner now | the current phase is the independently testable TOTP child module" -m "Confidence: high" -m "Scope-risk: moderate" -m "Directive: Do not advance Excel rows from the TOTP child controller" -m "Tested: full Native Host, integration, extension and packaging verification" -m "Not-tested: Manual Chrome interaction with the user's future mother-page selectors" -m "Co-authored-by: OmX <omx@oh-my-codex.dev>"
~~~

## 计划自检

### 规格覆盖

- 物理 Excel 行和 C 列编码：Task 1、Task 3、Task 4。
- cc汇总.xlsx、Lab URL、测试钩子：Task 2、Task 3、Task 9。
- 精确本地域名权限：Task 8。
- 母页普通窗口 active、右侧后台 helper、绝不操作母页：Task 6、Task 7。
- 唯一可见 6 位数字、歧义拒绝：Task 5、Task 7。
- 15 秒刷新、60 秒截止、最终读取：Task 7。
- 无痕页面 30 秒填写、现有页面动作复用：Task 6。
- 取消、延迟响应和 helper 清理：Task 7。
- 上层随机链接顺序、从第 2 行开始、整轮完成后推进：Task 9 文档，当前控制器不推进行。
- 不实现滑块/CAPTCHA 绕过：所有任务约束和 Task 9 扫描。

### 占位符检查

计划中的 __FILL_TOTP_TEST_HOOK__ 是产品配置要求的字面占位符，不代表实现步骤缺失；其余步骤均给出文件、测试命令、错误码或代码形状。

### 类型和命名一致性

- Python：read_numbered_workbook、TotpLabError、build_totp_lab_challenge、get_totp_lab_challenge。
- Extension：readVisibleTotpCode、createTotpLabController、run_totp_lab、cancel_totp_lab、totp_lab_state。
- 时间常量统一为 REFRESH_INTERVAL_MS=15000、TOTAL_TIMEOUT_MS=60000、TOTP_PAGE_TIMEOUT_MS=30000。
