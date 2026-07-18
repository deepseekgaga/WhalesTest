# Chrome 批量下载与本地 TOTP 测试扩展

本项目面向完全授权的本地测试环境，当前只覆盖 TOTP 验证流程。

## 当前范围

- 母窗口必须处于正常激活状态。
- 目标窗口必须是无痕窗口。
- 辅助页会在母窗口右侧打开。
- Excel 第 1 行是表头，数据从第 2 行开始。
- 不允许空白行参与映射。
- 验证码页按 15 秒刷新一次，60 秒后放弃。
- 辅助页同时显示多个候选验证码时，直接拒绝，不做猜测。

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

## 测试

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP 'whalestest-extension-package')
```

## 安全边界

- 不做验证码绕过，不做滑块绕过。
- 不记录密钥、验证码或密码。
- 不使用 `<all_urls>`。
- 仅为授权环境中的本地测试保留必要权限。
