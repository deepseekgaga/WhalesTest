# 本地短信验证码辅助模块设计

## 1. 目标与范围

在现有 TOTP Lab 模块之后新增独立短信验证码模块。上层工作流在 TOTP 成功后调用：

```javascript
run_sms_lab({ motherTabId, incognitoTabId, excelRow })
```

模块从 Excel 同一物理行读取 D 列手机号和 E 列短信辅助链接，在同一个无痕标签页完成手机号提交；随后在母页右侧后台打开本地短信辅助页，读取唯一 6 位验证码，关闭辅助页并回到同一个无痕标签页提交验证码。

本阶段不实现母页随机链接提取、Excel 行推进、最终“接受”按钮、手机号码注册、商业短信平台接入或任何人机验证绕过。本次文档校准只同步已经验证的页面动作、时序和错误契约，不扩展上述行为范围。

## 2. 固定安全边界

- E 列链接只允许 `http://sms-lab.local/*`。
- 用户信息、端口、片段、其他协议、其他主机和伪造子域名全部拒绝。
- 辅助标签页发生重定向后，最终 URL 仍必须属于 `http://sms-lab.local/*`；否则在页面脚本执行前失败。
- Manifest 只增加精确权限 `http://sms-lab.local/*`，不增加 `<all_urls>`。
- 调用方只能提供 `motherTabId`、`incognitoTabId` 和 `excelRow`，不能提供手机号、辅助 URL、验证码或选择器。
- 日志和公开状态不保存手机号、短信链接、验证码、账号或密码。
- 模块不访问商业接码服务，不解析短信供应商协议，只读取自建靶场页面上可见的独立 6 位数字。

## 3. Excel 数据契约

- 第 1 行是表头，实际任务从第 2 行开始。
- 使用上层传入的物理 `excelRow`，其值必须大于等于 2；不在短信模块中自行推进 Excel 行。
- D 列是手机号；保持原字符串，不去空格、不补国家代码、不做格式化。
- E 列是完整短信辅助 URL；必须通过固定域名验证。
- 中间不存在空白任务行；如果指定物理行不存在则返回 `account_row_not_found`。
- D 或 E 为空分别返回 `sms_phone_missing`、`sms_url_missing`。

## 4. Native Host

新增 `native_host/cc_batch/sms_lab.py`：

- 使用现有 `read_numbered_workbook()` 读取第一个工作表的物理行。
- 定义 `SmsLabError(code)`。
- 定义 `SmsLabChallenge(phone, challenge_url)`。
- `build_sms_lab_challenge(config, excel_row)` 返回同一行的 D/E 列值。
- URL 只接受 `http://sms-lab.local/*`，并保留原路径和查询参数。

新增 Native Messaging 命令：

```json
{
  "command": "get_sms_lab_challenge",
  "excel_row": 2
}
```

成功响应只包含：

```json
{
  "ok": true,
  "phone": "实验手机号",
  "challenge_url": "http://sms-lab.local/..."
}
```

响应不会包含整行 Excel 数据。失败响应只包含固定错误码和 `fatal:false`。

## 5. 页面选择器占位符

新增 `extension/sms-lab-selectors.js`，集中保存四个不可由消息调用方覆盖的占位符：

```javascript
export const SMS_LAB_SELECTORS = Object.freeze({
  phoneInput: "__FILL_SMS_PHONE_INPUT_SELECTOR__",
  sendButton: "__FILL_SMS_SEND_BUTTON_SELECTOR__",
  codeInput: "__FILL_SMS_CODE_INPUT_SELECTOR__",
  submitButton: "__FILL_SMS_SUBMIT_BUTTON_SELECTOR__",
});
```

任一值仍为占位符、为空或不是字符串时，运行在读取 Excel 前失败并返回 `sms_selectors_not_configured`。

## 6. 无痕页页面动作

新增 `extension/sms-lab-page.js`，包含两个可序列化的独立页面函数。

### 6.1 请求短信

`requestSmsOnPage({ phone, selectors, timeoutMs:30000 })`：

1. 验证手机号为非空字符串，但不修改其内容。
2. 等待 `document.readyState === "complete"`。
3. 等待手机号输入框和发送按钮可见、启用且页面稳定。
4. 使用原生 `value` setter 写入手机号。
5. 触发冒泡的 `input`、`change` 事件。
6. 如果发送按钮提供 `click()`，优先调用 `button.click()`；这同时支持 `type="button"` 的点击处理器和原生提交按钮。只有按钮没有可调用的 `click()` 时，才回退到所属表单的 `requestSubmit(button)`。
7. 点击或回退提交抛出异常时返回固定错误 `sms_send_failed`。

### 6.2 提交短信验证码

`submitSmsCodeOnPage({ code, selectors, timeoutMs:30000 })`：

1. 只接受精确 6 位数字。
2. 等待验证码输入框和提交按钮可见、启用且页面稳定。
3. 使用原生 setter 写入验证码并触发 `input`、`change`。
4. 如果提交按钮提供 `click()`，优先调用 `button.click()`；只有按钮没有可调用的 `click()` 时，才回退到所属表单的 `requestSubmit(button)`。
5. 点击或回退提交抛出异常时返回固定错误 `sms_submit_failed`。

两个页面函数均不读取其他表单字段，不返回手机号或验证码，只返回 `{ok:true}` 或固定错误码。

## 7. 短信辅助页读取

复用现有 `readVisibleTotpCode()`，因为其实际行为是通用的可见 6 位数字读取器：

- 读取 `document.body.innerText`。
- 独立数字正则为 `(?<!\d)\d{6}(?!\d)`。
- 同一数字重复出现会去重。
- 没有候选值返回 `code_not_present`。
- 一个唯一值返回成功。
- 多个不同值返回 `totp_code_ambiguous`；短信控制器对外映射为 `sms_code_ambiguous`。
- 页面未稳定或读取超时返回固定页面错误码。

不点击、拖动或操作辅助页中的其他控件。

## 8. 控制器状态机

新增 `extension/sms-lab-controller.js`：

```text
IDLE
  -> VALIDATING
  -> READING_CHALLENGE
  -> REQUESTING_SMS
  -> OPENING_HELPER
  -> WAITING_FOR_CODE
  -> SUBMITTING_SMS
  -> SUCCEEDED | FAILED | CANCELLED
```

公开状态只包含：

```javascript
{ state, runId, error }
```

不包含手机号、Excel 行内容、辅助 URL 或验证码。

## 9. 标签页与权限规则

- `motherTabId` 必须属于普通窗口且 `active === true`。
- `incognitoTabId` 必须属于无痕窗口，且与母页 ID 不同。
- 调用方必须已在目标无痕页触发扩展，以提供该页自己的 `activeTab` 授权。
- 手机号提交和验证码提交始终在同一个 `incognitoTabId` 上执行。
- 辅助页创建参数固定为母页窗口、`index: mother.index + 1`、`active:false`。
- 母页不能收到 `update`、`reload`、`remove` 或脚本注入。
- 所有刷新和关闭操作只使用记录的 `helperTabId`。
- 找到验证码后先关闭辅助页，再重新确认母页仍为 active，随后提交验证码。
- 已知 Chrome `tabs.get` 缺失错误（例如 `No tab with id`、`Invalid tab ID`）在初始校验时分别映射为 `mother_tab_missing` 或 `incognito_tab_missing`，在辅助页读取阶段映射为 `helper_tab_closed`；其他意外 `tabs.get` 拒绝不会伪装成缺失标签页，无法识别的消息对外清洗为 `sms_lab_failed`。

## 10. 刷新与截止时间

- Native Host 请求超时 15 秒。
- 两个无痕页面动作分别最多等待 30 秒。
- 辅助页首次加载完成后立即读取，起始读取预算最多为 `HELPER_READ_TIMEOUT_MS = 5_000` 毫秒。
- 如果验证码持续缺失，则在约 15、30、45 秒各刷新一次；每次刷新完成加载后再次读取，完整超时路径恰好刷新三次。
- 约 55 秒开始保留最后一个 `HELPER_READ_TIMEOUT_MS = 5_000` 毫秒读取窗口，不在 55 秒或 60 秒再次刷新。
- 最后一次读取必须在 60 秒硬截止前完成；仍无验证码返回 `sms_code_not_found`。
- 慢加载不能无限延长 60 秒总截止时间。
- 每次加载完成后先验证辅助页最终 URL，再注入读取函数。

## 11. 取消和竞态

控制器提供：

```javascript
cancel_sms_lab(runId)
```

取消规则：

- 中止 Native Host 等待、15 秒 sleep、辅助页读取和无痕页脚本等待。
- 如果辅助页已经创建，只关闭该辅助页。
- 不关闭或导航母页和无痕登录页。
- 延迟 Native Host 响应、延迟 `tabs.create`、延迟页面读取和延迟提交返回后都必须重新检查运行状态。
- 如果取消发生在辅助页创建过程中，延迟创建出的辅助页必须立即且只关闭一次。
- 如果辅助页被人工关闭，返回 `helper_tab_closed`，不尝试相邻标签页。

## 12. Service Worker 路由

`extension/background.js` 新增：

- `run_sms_lab`
- `cancel_sms_lab`
- `sms_lab_state`

`run_sms_lab` 只接受 `type`、`motherTabId`、`incognitoTabId`、`excelRow`。额外字段返回 `request_invalid`。

`cancel_sms_lab` 只接受 `type` 和可选 `runId`。`sms_lab_state` 只接受 `type`。

所有消息必须来自当前扩展 ID。

## 13. 错误码

主要固定错误码：

- `request_invalid`
- `sender_rejected`
- `sms_selectors_not_configured`
- `excel_row_invalid`
- `account_row_not_found`
- `sms_phone_missing`
- `sms_url_missing`
- `sms_url_invalid`
- `mother_tab_missing`
- `mother_tab_not_active`
- `mother_tab_incognito`
- `incognito_tab_missing`
- `incognito_tab_required`
- `incognito_active_tab_required`
- `sms_phone_input_not_found`
- `sms_send_button_not_found`
- `sms_send_failed`
- `sms_code_input_not_found`
- `sms_submit_button_not_found`
- `sms_submit_failed`
- `sms_code_ambiguous`
- `sms_code_not_found`
- `helper_tab_closed`
- `helper_page_not_stable`
- `sms_lab_failed`
- `cancelled`

Native Host 返回的 URL 或辅助页最终 URL 不符合固定边界时统一返回 `sms_url_invalid`。错误消息不拼接手机号、URL、验证码或选择器内容。

## 14. 文件变更

新增：

- `native_host/cc_batch/sms_lab.py`
- `native_host/tests/test_sms_lab.py`
- `extension/sms-lab-selectors.js`
- `extension/sms-lab-page.js`
- `extension/sms-lab-controller.js`
- `extension/tests/sms-lab-page.test.mjs`
- `extension/tests/sms-lab-controller.test.mjs`

修改：

- `native_host/host.py`
- `native_host/tests/test_host_protocol.py`
- `extension/background.js`
- `extension/manifest.json`
- `extension/tests/background.test.mjs`
- `scripts/package-extension.ps1`
- `README.md`

不修改现有独立 RFC 6238 TOTP 模块的行为。

## 15. 测试与验收

必须覆盖：

- 按物理行读取同一行 D/E 列，不发生行号错位。
- 手机号保持原字符串，不格式化。
- E 列空值、外部域名、凭据、端口、片段和伪造子域名被拒绝。
- Native Host 响应只包含手机号和验证后的辅助 URL。
- 选择器仍为占位符时在读取 Excel 前失败。
- 手机号页和验证码页均等待稳定、填写、触发事件，并优先点击按钮且只提交一次；只有按钮没有 `click()` 时才使用 `requestSubmit(button)`。
- 母页保持 active 且没有收到任何修改操作。
- 辅助页位于母页右侧且 `active:false`。
- 辅助页重定向到其他域名时，在脚本读取前失败。
- 加载后约 0、15、30、45 秒读取，约 55 秒进入最终 5 秒读取窗口；完整超时路径恰好刷新三次。
- 多验证码返回 `sms_code_ambiguous`，不猜测。
- 成功后关闭辅助页并在同一无痕页提交验证码。
- 取消覆盖 Native Host、创建辅助页、等待、读取和提交阶段。
- 原有 Native Host、TOTP、扩展和集成测试继续通过。

最终验收命令：

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP "whalestest-extension-package-sms-final")
git diff --check
rg -n "<all_urls>|2fa\.run|commercial|page\.mouse|drag_to|generate_track" extension native_host README.md
```

## 16. 验收标准

- 上层使用 TOTP 相同的物理 `excelRow` 调用短信模块。
- D 列手机号成功提交后，只在母页右侧后台打开 E 列短信辅助 URL。
- 辅助页显示唯一 6 位数字时，模块关闭辅助页并在同一个无痕页提交验证码。
- 验证码持续缺失时在约 15、30、45 秒恰好刷新三次，并在约 55–60 秒完成最后一次有界读取，总等待不超过 60 秒。
- 外部 URL、重定向、多验证码、未配置选择器和取消路径安全失败。
- 模块不推进 Excel 行，不启动下一轮，也不操作母页内容。
