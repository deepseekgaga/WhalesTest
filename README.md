# Chrome 批量下载、本地 TOTP 与授权滑块靶场测试工具

本项目面向完全授权、隔离的本地测试环境。Chrome 扩展覆盖批处理和 TOTP 验证流程；独立 Python 工具通过 Flask 靶场显式提供的实验钩子验证滑块之后的页面流程。

## 当前范围

- 母窗口必须处于正常激活状态。
- 目标窗口必须是无痕窗口。
- 辅助页会在母窗口右侧打开。
- Excel 第 1 行是表头，数据从第 2 行开始。
- 不允许空白行参与映射。
- 验证码页在约 15、30、45 秒最多刷新三次，并在约 55–60 秒完成最后一次有界读取；60 秒是硬截止。
- 辅助页同时显示多个候选验证码时，直接拒绝，不做猜测。
- TOTP 成功后的短信流程由上层显式调用独立 `run_sms_lab`，并复用同一组 `motherTabId`、`incognitoTabId` 和 `excelRow`。
- 滑块研究工具只允许 `http://test-target.local`，不会生成真人化鼠标轨迹。

## 配置文件

`native_host/config.json` 需要保持固定、本地化、可审计的测试配置：

- `input_excel`: `C:\Users\HE\Downloads\jingshajingsha\cc汇总.xlsx`
- `totp_lab_url`: `http://totp-lab.local/`
- `totp_lab_test_hook`: `__FILL_TOTP_TEST_HOOK__`

其余批处理占位字段保持原有用途不变。

## 安装

1. 在 `chrome://extensions` 打开开发者模式。
2. 加载 `extension` 目录。
3. 执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId <32位扩展ID>
```

4. 修改 `native_host/config.json` 后，重新运行安装脚本，让本地 Native Host 配置同步。

## 本地短信验证码靶场

短信模块只用于本地授权靶场。它不会接管批处理主循环，也不会替 TOTP 模块推进 Excel 行号。

### 调用边界

上层流程在 TOTP 成功后调用独立消息 `run_sms_lab`。调用方必须传入与 TOTP 成功时相同的：

- `motherTabId`：普通窗口中的母页标签页，必须保持 active。
- `incognitoTabId`：同一个无痕标签页，先接收手机号，再接收短信验证码。
- `excelRow`：Excel 物理行号。第 1 行是表头，数据行从第 2 行开始。

短信模块不会推进到下一行，不会点击最终接受按钮，也不会启动下一任务。它只完成本地短信请求、读取唯一可见 6 位验证码、回填到同一个无痕标签页这一个阶段。

### Excel 列约定

`native_host/cc_batch/sms_lab.py` 只读取第一个工作表的同一物理行：

| 列 | 内容 |
| --- | --- |
| D | 手机号，按单元格原值精确传递，不修剪格式。 |
| E | 完整 `http://sms-lab.local/*` 靶场 URL。 |

E 列 URL 必须是 `http://sms-lab.local/` 下的完整 URL；模块拒绝 HTTPS、外部主机、子域名、端口、凭据、片段、空白或控制字符。Native Host 响应只返回 `phone` 和 `challenge_url`，不返回账号、密码、TOTP secret 或短信验证码。

### 选择器配置

运行前必须在 `extension/sms-lab-selectors.js` 配置四个页面选择器字面量。不要修改内部 `PLACEHOLDERS` 哨兵值；它们用于检测未配置状态。保留 `PLACEHOLDERS` 不变，并把导出的 `SMS_LAB_SELECTORS` 替换为四个真实选择器字符串：

```javascript
export const SMS_LAB_SELECTORS = Object.freeze({
  phoneInput: "#sms-phone",
  sendButton: "#sms-send",
  codeInput: "#sms-code",
  submitButton: "#sms-submit",
});
```

四个导出值分别定位手机号输入框、发送短信按钮、验证码输入框和提交验证码按钮。只要 `SMS_LAB_SELECTORS` 仍等于占位哨兵值，控制器会在请求 Native Host 前失败。

页面动作在按钮提供 `click()` 时优先点击，兼容 `type="button"` 点击处理器和原生提交按钮；只有按钮没有可调用的 `click()` 时才回退到 `form.requestSubmit(button)`。发送和提交动作异常分别返回固定错误 `sms_send_failed`、`sms_submit_failed`。

### 标签页与验证码读取

短信控制器保持母页 active，不切换母页焦点。辅助页使用 `chrome.tabs.create` 在母页右侧打开，参数包含 `active: false`，并且只允许停留在 `http://sms-lab.local/*`。如果辅助页加载后重定向到其他来源，控制器会拒绝并停止读取。

验证码读取规则：

- 同一个无痕标签页完成手机号发送和验证码提交。
- 辅助页加载完成后立即读取；验证码持续缺失时在约 15、30、45 秒各刷新一次，完整超时路径恰好刷新三次。
- 约 55 秒开始最后一个 5 秒读取窗口，不再刷新；读取必须在 60 秒硬截止前完成，截止后返回未找到验证码。
- 只接受唯一可见的 6 位数字。
- 同时出现多个候选验证码时返回歧义错误，不做猜测。

取消 `cancel_sms_lab` 会中止当前 run，尽力通知无痕页清理页面令牌，并关闭已知辅助页。取消后不会继续提交验证码。

### 消息示例

`run_sms_lab` 示例：

```javascript
chrome.runtime.sendMessage({
  type: "run_sms_lab",
  motherTabId: 101,
  incognitoTabId: 202,
  excelRow: 2,
});
```

`cancel_sms_lab` 示例：

```javascript
chrome.runtime.sendMessage({
  type: "cancel_sms_lab",
  runId: "sms-run-placeholder",
});
```

`sms_lab_state` 示例：

```javascript
chrome.runtime.sendMessage({
  type: "sms_lab_state",
});
```

这些消息不得携带 phone、url、code、password 或其他敏感字段；Service Worker 会拒绝额外字段。

## 授权滑块靶场测试钩子

脚本位于 `tools/authorized_slider_lab.py`。它不会拖动滑块、识别缺口或模拟真人行为，只会调用固定的同源测试接口 `/__lab__/slider/approve`，然后检查 `.captcha-success` 是否可见或 `#slider-handle` 是否已经消失。

### 安装 Playwright

```powershell
python -m pip install playwright
playwright install chromium
```

### Flask 靶场测试接口

测试接口必须只在实验模式下可用。令牌来自服务器环境变量，比较过程使用 `secrets.compare_digest`，并且接口不能接受客户端提供的轨迹、位移或验证分数。

```python
import os
import secrets

from flask import abort, jsonify, request, session


@app.post("/__lab__/slider/approve")
def approve_slider_for_lab():
    if not app.config.get("SLIDER_LAB_TEST_MODE", False):
        abort(404)

    expected = os.environ.get("SLIDER_LAB_TEST_TOKEN", "")
    supplied = request.headers.get("X-Lab-Test-Token", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        abort(403)

    session["slider_verified"] = True
    return jsonify(ok=True)
```

Flask 启动时可通过环境变量显式打开实验模式：

```python
app.config["SLIDER_LAB_TEST_MODE"] = (
    os.environ.get("SLIDER_LAB_TEST_MODE") == "true"
)
```

### 运行

客户端和 Flask 服务端必须设置相同的实验令牌。令牌不会写入命令行参数、日志、截图文件名或公开运行结果。

```powershell
$env:SLIDER_LAB_TEST_MODE = "true"
$env:SLIDER_LAB_TEST_TOKEN = "替换为实验专用随机令牌"

python tools/authorized_slider_lab.py --headed
```

可配置参数：

```powershell
python tools/authorized_slider_lab.py `
  --url http://test-target.local/slider-captcha `
  --success-selector .captcha-success `
  --slider-selector '#slider-handle' `
  --attempts 3 `
  --screenshot-dir artifacts/slider-lab
```

退出码：

- `0`：检测到靶场验证成功状态。
- `1`：测试钩子被拒绝，或三次尝试后没有成功状态。
- `2`：URL、令牌或 Playwright 依赖配置错误。

失败截图默认保存到 `artifacts/slider-lab`。测试钩子路径、授权主机和最多三次尝试均在脚本中固定限制。

## 测试

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
python -m unittest tests.test_authorized_slider_lab -v
python tools/authorized_slider_lab.py --help
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP 'sms-final')
```

## 安全边界

- 不做验证码绕过，不做滑块绕过。
- 不生成或回放真人化拖动轨迹，不使用 `page.mouse` 或 `drag_to`。
- 不记录 phone、url、code、password、手机号、短信链接、验证码、密钥或密码。
- 不使用 `<all_urls>`。
- 不连接商业接码平台、commercial receiver 或 `2fa.run`。
- 不实现 CAPTCHA、拖拽、滑块缺口识别、`generate_track` 或任何自动绕过逻辑。
- 仅为授权环境中的本地测试保留必要权限。
