# 授权隔离本地靶场

这是一个仅面向已授权测试环境的 Chrome MV3 + Native Host + Excel 物理行靶场。它把母页授权、无痕登录、TOTP、短信辅助页和最终 URL 回填串成一条受控流程，并保留一个独立的旧 CC 批处理分区。

它不用于未授权系统，也不包含商业验证码绕过、滑块绕过、系统剪贴板读取或通配站点访问。

## 目录

- `extension/`：Chrome 扩展，负责母页、无痕页、TOTP/SMS 和弹窗控制。
- `native_host/`：Native Host，负责从 Excel 物理行读取凭据和本地辅助页参数。
- `scripts/`：安装、验证和打包脚本。
- `tests/`：Python 集成测试。
- `extension/tests/`：Node 测试。
- `tools/`：本地授权靶场辅助脚本。
- `docs/superpowers/`：计划和设计文档。
- `dist/`、`dist-review/`：打包产物和审阅产物。

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions/`。
2. 开启开发者模式。
3. 加载 `extension/` 目录。
4. 在扩展详情页开启“允许在无痕模式下运行”。

### 2. 安装 Native Host

`scripts/install-native-host.ps1` 会把 Native Host 安装到：

- `%LOCALAPPDATA%\WhalestestCcBatch\native_host`
- `%LOCALAPPDATA%\WhalestestCcBatch\manifest\com.whalestest.cc_batch.json`
- `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.whalestest.cc_batch`

安装命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId <32位扩展ID>
```

`ExtensionId` 必须匹配 `^[a-p]{32}$`。

### 3. 验证安装

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-install.ps1 -ExtensionId <32位扩展ID>
```

这个脚本会检查安装清单、Host manifest、注册表项、文件哈希和 Native Messaging ping。

## Native Host 配置

`native_host/config.json` 当前包含以下本地配置：

- `input_excel`：输入 Excel。
- `url_column`：旧 CC 批处理的 URL 列名。
- `txt_directory` / `download_directory`：旧 CC 批处理输出目录。
- `output_excel`：旧 CC 批处理输出工作簿。
- `download_timeout_seconds`：下载等待超时。
- `field_mappings`：旧 CC 批处理字段映射。
- `field_continuation_lines`：旧 CC 批处理续行规则。
- `totp_lab_url`：固定为 `http://totp-lab.local/`。
- `totp_lab_test_hook`：当前仍是 `__FILL_TOTP_TEST_HOOK__` 占位符，真实联调前必须替换。

## Excel 列绑定

本项目按物理行读取数据。第 1 行永远是表头，序号 `N` 对应 Excel 物理行 `N + 1`。

| 列 | 含义 |
| --- | --- |
| A | 登录用户名 |
| B | 登录密码 |
| C | TOTP secret |
| D | 手机号 |
| E | SMS 辅助链接 |

约束：

- `get_workflow_credentials` 只读取同一物理行的 A/B。
- TOTP 辅助页只读取同一物理行的 C。
- SMS 辅助页只读取同一物理行的 D/E。
- 表头行不参与业务处理。
- 空行不作为有效数据行。

## 授权工作流

授权工作流由弹窗中的“授权登录工作流”分区启动，母页必须满足：

- 当前活动标签页是普通窗口。
- URL 精确等于 `http://127.0.0.1:9527/`。
- 不是无痕标签页。

流程顺序是：

1. 读取当前序号对应的 A/B 凭据。
2. 在母页创建账号并生成授权链接。
3. 在新的无痕窗口中打开授权链接。
4. 完成账号密码登录。
5. 进入 TOTP 阶段。
6. 进入 SMS 阶段。
7. 点击最终接受按钮。
8. 读取无痕页最终 URL。
9. 回填到母页。
10. 只有母页最终回填成功后才进入 `COMMIT` 并推进到下一行。

行为边界：

- 成功后，无痕窗口会在清理阶段关闭。
- 失败后，无痕窗口会保留，便于现场排查。
- 失败状态会显示序号、Excel 行、阶段和固定错误码，不显示账号、密码、secret 或最终 URL。

`extension/workflow-selectors.js` 里有三个母页最终回填选择器必须填写：

- `motherFinalUrlInput`
- `motherFinalConfirmButton`
- `motherFinalSuccess`

`auth-target.local` 目前仍是占位 origin。真实联调前必须把 `extension/manifest.json` 里的这个 origin 替换为实际授权站点的固定 origin，并同步 `extension/workflow-controller.js` 的 `targetOrigin`。

## 弹窗

弹窗分成两个互斥分区：

| 分区 | 用途 | 消息 |
| --- | --- | --- |
| 授权登录工作流 | 运行母页到无痕登录再回填母页的主流程 | `start_workflow` / `cancel_workflow` / `workflow_state` |
| 旧 CC 批处理 | 旧的批量下载分区 | `start` / `state` |

互斥规则：

- 任一分区运行时，另一个分区的启动按钮会被禁用。
- 工作流和旧 CC 批处理不会同时起跑。

状态展示：

- 授权工作流显示状态、序号、Excel 行、阶段和错误码。
- 旧 CC 批处理显示状态、进度、成功数、失败数、当前 URL 和最近错误。

## TOTP / SMS 辅助页

### TOTP

- 使用 `http://totp-lab.local/`。
- 读取同一物理行的 C 列 secret。
- 只返回构造出的挑战 URL，不回传 secret。
- `totp_lab_test_hook` 必须在真实联调前配置成有效值。

### SMS

- 使用同一物理行的 D 列手机号和 E 列本地 SMS 链接。
- 只允许 `http://sms-lab.local/*`。
- 只返回 `phone` 和 `challenge_url`。
- 不接商业接码平台，也不放宽到任意外部站点。

## 权限与边界

`extension/manifest.json` 当前请求的权限是：

- `nativeMessaging`
- `tabs`
- `downloads`
- `storage`
- `activeTab`
- `scripting`
- `alarms`

当前请求的主机权限只有：

- `http://127.0.0.1:9527/*`
- `http://auth-target.local/*`
- `http://totp-lab.local/*`
- `http://sms-lab.local/*`

它不声明：

- `<all_urls>`
- `clipboardRead`
- `debugger`
- 任意 HTTP/HTTPS 通配权限

扩展显式使用 `incognito: "spanning"`。用户仍需在 Chrome 扩展详情页开启无痕运行。

如果对目标标签执行注入失败，控制器会映射为 `target_host_permission_required`，而不是回退到更宽的权限。

## 固定错误码

这些错误码是当前实现中会公开显示的稳定码：

| 错误码 | 含义 |
| --- | --- |
| `mother_url_invalid` | 当前活动母页不是精确的 `http://127.0.0.1:9527/`。 |
| `selector_not_configured` | 必需选择器缺失、为空或仍是占位符。 |
| `authorization_origin_mismatch` | 授权链接的 origin 与配置的 target origin 不一致。 |
| `incognito_access_required` | Chrome 不允许创建或接管无痕窗口。 |
| `target_host_permission_required` | 对目标标签执行脚本注入时权限不足。 |
| `login_rejected` | 登录表单提交后，页面明确拒绝或未进入 TOTP 阶段。 |
| `totp_stage_not_reached` | 没有观测到 TOTP 阶段。 |
| `mother_backfill_failed` | 最终 URL 回填母页失败。 |
| `incognito_window_ambiguous` | 找到了多个同批次无痕 handoff 标签。 |
| `another_workflow_running` | 旧 CC 批处理或另一个授权工作流已经在运行。 |
| `workflow_failed` | 内部调度、持久化或清理出现通用失败。 |
| `page_not_stable` | 页面在限定时间内一直不稳定，未达到可操作状态。 |
| `credentials_invalid` | 同一物理行的 A/B 凭据为空或无效。 |

## 验证

下面这些命令用于当前仓库的全量验证：

```powershell
python -m unittest discover -s native_host/tests -v
python -m unittest discover -s tests -v
node --test extension/tests/*.test.mjs
python -m py_compile native_host\host.py native_host\cc_batch\*.py tools\authorized_slider_lab.py
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1 -OutputDirectory (Join-Path $env:TEMP 'whalestest-extension-package')
git diff --check
rg -n "<all_urls>|clipboardRead|debugger|2fa\.run|commercial receiver|drag_to|page\.mouse" extension native_host scripts tests README.md
```

## 当前边界

- 真实联调前，`auth-target.local` 必须替换为实际授权 origin。
- 真实联调前，`extension/workflow-selectors.js` 的三个母页最终选择器必须填写。
- 真实联调前，`native_host/config.json` 的 `totp_lab_test_hook` 仍需替换。
- 本 README 只记录当前实现和已接入边界，不声称已经完成真实 Chrome 联调。
