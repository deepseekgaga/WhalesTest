# 单扩展双阶段工作流实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一个 Chrome 扩展通过两个按钮分别运行 CC 批量处理和授权登录/MFA 工作流；第二阶段每次从第一阶段输出 Excel 的物理第 2 行重新开始。

**Architecture:** 保留一个 MV3 扩展和现有 Native Host。CC 阶段继续使用 `input_excel` 并生成 `output_excel`；MFA 阶段默认读取 `output_excel`，每次手动启动创建新状态（`excelRow=2`、`sequence=1`），不会自动触发。

**Tech Stack:** Chrome MV3、JavaScript ES modules、Chrome Storage/Alarms/Native Messaging、Python 3、现有 XML XLSX 读写器、PowerShell、Node test runner、Python unittest。

---

### Task 1: Native Host 从第一阶段输出工作簿读取 MFA 行

**Files:**
- Modify: `native_host/cc_batch/config.py`
- Modify: `native_host/config.json`
- Modify: `native_host/host.py`
- Modify: `native_host/cc_batch/workflow_credentials.py`
- Modify: `native_host/cc_batch/totp_lab.py`
- Modify: `native_host/cc_batch/sms_lab.py`
- Test: `native_host/tests/test_config.py`
- Test: `native_host/tests/test_host_protocol.py`
- Test: `native_host/tests/test_totp_lab.py`
- Test: `native_host/tests/test_sms_lab.py`

- [ ] **Step 1: Add failing path-selection tests.** Test that missing `workflow_input_excel` defaults to `output_excel`, an override resolves relative to `config.json`, and workflow A/B/C/D/E reads use the override while legacy `get_totp` still uses `input_excel`.
- [ ] **Step 2: Run the focused tests and observe failure.**

```powershell
python -m unittest native_host.tests.test_config native_host.tests.test_host_protocol -v
```

- [ ] **Step 3: Add the safe config property.** Add optional `workflow_input_excel: Path | None = None` after existing dataclass defaults and expose `workflow_excel` as `workflow_input_excel or output_excel`. Parse the optional JSON field relative to the config file and write it explicitly in `native_host/config.json`.
- [ ] **Step 4: Route MFA readers through `workflow_excel`.** Change only `get_workflow_credentials`, `get_totp_lab_challenge`, and `get_sms_lab_challenge` to use the output-workbook path. Preserve existing error codes and secret filtering.
- [ ] **Step 5: Add separate-workbook coverage and run all Native Host tests.**

```powershell
python -m unittest discover -s native_host/tests -v
```

- [ ] **Step 6: Commit.**

```powershell
git add native_host native_host/config.json
git commit -m "Read MFA rows from the CC output workbook"
```

### Task 2: Reset every manual MFA run to row two

**Files:**
- Modify: `extension/workflow-state.js`
- Modify: `extension/workflow-controller.js`
- Test: `extension/tests/workflow-state.test.mjs`
- Test: `extension/tests/workflow-controller.test.mjs`
- Test: `extension/tests/background.test.mjs`

- [ ] **Step 1: Add failing reset tests.** After a terminal failure, call `start()` again and assert a new batch ID, `excelRow === 2`, and `sequence === 1`. Assert that CC completion does not call `start_workflow` or create a workflow alarm.
- [ ] **Step 2: Define and use `WORKFLOW_START_ROW = 2` and `WORKFLOW_START_SEQUENCE = 1`.** `createWorkflowState` must use these constants. `start()` must create a new state for every terminal prior state and must not reuse prior row, sequence, batch ID, or failed window IDs.
- [ ] **Step 3: Run focused workflow tests.**

```powershell
node --unhandled-rejections=strict --test extension/tests/workflow-state.test.mjs extension/tests/workflow-controller.test.mjs extension/tests/background.test.mjs
```

- [ ] **Step 4: Commit.**

```powershell
git add extension/workflow-state.js extension/workflow-controller.js extension/tests
git commit -m "Reset each manual MFA run to the generated workbook header"
```

### Task 3: Make the popup explicitly expose two manual stages

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup-view.js`
- Modify: `extension/manifest.json`
- Modify: `README.md`
- Create: `extension/tests/popup-markup.test.mjs`
- Test: `extension/tests/popup-view.test.mjs`

- [ ] **Step 1: Add markup tests.** Read `popup.html` and assert the two unique buttons are labelled `CC 批量下载与 TXT 汇总` and `授权登录与 MFA 测试工作流`; assert there is no automatic second-stage trigger text.
- [ ] **Step 2: Update labels without adding automatic chaining.** Keep the existing mutual exclusion rules. Do not add any CC completion listener that sends `start_workflow`. Use a neutral manifest identity such as `Whalestest 双阶段授权测试工具`, with a description covering both functions.
- [ ] **Step 3: Rewrite README workflow sections.** Remove the obsolete “two independent extensions” wording and document one extension, two buttons, manual handoff, output workbook source, and row-two reset.
- [ ] **Step 4: Run popup tests and commit.**

```powershell
node --unhandled-rejections=strict --test extension/tests/popup-markup.test.mjs extension/tests/popup-view.test.mjs
git add extension README.md
git commit -m "Present CC and MFA as manual stages in one extension"
```

### Task 4: Package and verify the single extension

**Files:**
- Modify: `scripts/package-extension.ps1`
- Modify: `scripts/install-native-host.ps1`
- Modify: `scripts/verify-install.ps1`
- Test: `extension/tests/background.test.mjs`
- Test: `native_host/tests/test_config.py`

- [ ] **Step 1: Keep one package.** Package only `authorized-mfa-workflow-chrome-extension-v0.1.0.zip`; verify manifest labels, fixed local Host permissions, and absence of `<all_urls>`, `clipboardRead`, and `debugger`.
- [ ] **Step 2: Preserve one Native Host registration.** Keep `com.whalestest.cc_batch`, existing registry paths, and one Excel state file; do not introduce a second Host.
- [ ] **Step 3: Run complete verification.**

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --unhandled-rejections=strict --test extension/tests/*.test.mjs
python -m compileall -q native_host
git diff --check
& .\scripts\package-extension.ps1 -OutputDirectory $env:TEMP\whalestest-single-extension
```

- [ ] **Step 4: Commit only after all checks pass.**

```powershell
git status --short --untracked-files=no
git add README.md extension native_host scripts
git commit -m "Finalize the single-extension two-stage workflow"
```

After implementation, inspect `git remote -v`; only add `origin` and push after the user provides the remote URL.

## Plan self-review

- Spec coverage: single extension, two buttons, manual handoff, first-stage output workbook, row-two reset, header skip, failure semantics, security boundary, and Git prerequisite are covered.
- Placeholder scan: no unfinished placeholder instructions or unspecified implementation steps.
- Type consistency: `workflow_input_excel`, `workflow_excel`, `WORKFLOW_START_ROW`, and `WORKFLOW_START_SEQUENCE` are used consistently.
