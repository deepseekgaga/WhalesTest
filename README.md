# Chrome 批量下载、本地 TOTP 与授权滑块靶场测试工具

本项目面向完全授权、隔离的本地测试环境。Chrome 扩展覆盖批处理和 TOTP 验证流程；独立 Python 工具通过 Flask 靶场显式提供的实验钩子验证滑块之后的页面流程。

## 当前范围

- 母窗口必须处于正常激活状态。
- 目标窗口必须是无痕窗口。
- 辅助页会在母窗口右侧打开。
- Excel 第 1 行是表头，数据从第 2 行开始。
- 不允许空白行参与映射。
- 验证码页按 15 秒刷新一次，60 秒后放弃。
- 辅助页同时显示多个候选验证码时，直接拒绝，不做猜测。
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
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP 'whalestest-extension-package')
```

## 安全边界

- 不做验证码绕过，不做滑块绕过。
- 不生成或回放真人化拖动轨迹，不使用 `page.mouse` 或 `drag_to`。
- 不记录密钥、验证码或密码。
- 不使用 `<all_urls>`。
- 仅为授权环境中的本地测试保留必要权限。
