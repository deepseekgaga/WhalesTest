# Whalestest 单扩展双阶段设计

## 目标

保留一个 Chrome MV3 扩展，在同一个弹窗中提供两个独立按钮：

1. `CC 批量下载与 TXT 汇总`
2. `授权登录与 MFA 测试工作流`

两个阶段由用户手动衔接：第一阶段完成后，不会自动启动第二阶段；用户点击第二个按钮后，第二阶段读取第一阶段生成的 Excel 工作簿。

## Excel 数据流

第一阶段继续使用现有 Native Host 配置中的输入/输出工作簿。第一阶段完成后，其生成的输出 Excel 是第二阶段的唯一数据来源。

第二阶段启动时必须：

- 将工作簿游标重置到物理第 2 行。
- 将第 1 行视为表头，永远不参与业务处理。
- 每次用户点击“授权登录与 MFA 测试工作流”都从第 2 行重新开始。
- 不沿用上一次第二阶段运行保存的行号或序号。
- 按物理行读取 A/B/C/D/E：用户名、密码、TOTP secret、手机号、短信辅助链接。
- 只有当前行完成授权链接、登录、TOTP、SMS、接受按钮和母页回填后，才推进到下一物理行。

如果输出工作簿不存在、无法读取、只有表头或第 2 行为空，第二阶段以固定错误码结束，不启动无痕登录窗口。

## 单扩展布局

继续使用一个 `extension/` 目录和一个 MV3 manifest，不拆分成两个 Chrome 扩展：

```text
Whalestest/
├─ extension/
│  ├─ manifest.json
│  ├─ background.js
│  ├─ popup.html
│  ├─ popup.js
│  ├─ popup.css
│  ├─ popup-view.js
│  └─ workflow / CC runtime files
├─ native_host/
├─ scripts/
├─ tests/
└─ README.md
```

Native Host 标识 `com.whalestest.cc_batch` 保持不变，避免破坏现有安装和注册表配置。

## 弹窗与阶段边界

弹窗包含两个明确的功能区和按钮：

- CC 区：启动/查看/停止第一阶段。
- MFA 区：启动/查看/取消第二阶段。

运行约束：

- 同一时间最多运行一个阶段。
- CC 阶段运行时，MFA 启动按钮禁用。
- MFA 阶段运行时，CC 启动按钮禁用。
- CC 阶段完成或失败后，用户可重新点击 MFA 按钮；不会自动触发。
- 每次 MFA 按钮点击创建新的批次 ID，并把 `excelRow` 初始化为 `2`、`sequence` 初始化为 `1`。
- MFA 失败保留无痕窗口和失败阶段；再次点击 MFA 按钮时创建新批次并重新从第 2 行开始。

## 第二阶段工作流

第二阶段沿用现有授权工作流顺序：

1. 读取第一阶段输出工作簿的第 2 行。
2. 在母页创建账号并生成授权链接。
3. 创建无痕窗口并打开授权链接。
4. 填充用户名和密码，提交后等待 30 秒。
5. 通过 `totp-lab.local` 完成 TOTP。
6. 通过 `sms-lab.local` 完成短信辅助流程。
7. 点击接受按钮并读取最终 URL。
8. 回填母页并确认成功。
9. 完整成功后推进到下一 Excel 行；否则不推进。
10. 当前批次耗尽后进入完成状态。

## 权限与敏感数据

保持现有最小权限边界，不新增 `<all_urls>`、`clipboardRead` 或 `debugger`。MFA 目标 Host 仍限定为：

- `https://api.bridgefloods.com/*`
- `http://auth-target.local/*`
- `http://totp-lab.local/*`
- `http://sms-lab.local/*`

密码、TOTP secret、手机号、短信验证码和最终 URL 不进入公开弹窗状态、`chrome.storage` 或普通日志。公开状态只显示阶段、批次、Excel 行、序号和固定错误码。

## 测试与打包

- 增加测试确保每次 MFA 启动都从 `excelRow=2`、`sequence=1` 开始。
- 增加测试确保第二阶段只使用第一阶段输出工作簿。
- 增加测试确保 CC 完成不会自动启动 MFA。
- 增加测试确保两个按钮互斥、各自状态独立展示。
- 保留现有 Native Host、TOTP、SMS 和母页工作流测试。
- 打包仍输出一个独立扩展 ZIP，名称统一为 `authorized-mfa-workflow-chrome-extension-v0.1.0.zip`；README 同时说明两个阶段按钮。

## 验收标准

1. Chrome 中只需加载一个扩展，即可看到两个阶段按钮。
2. 第一阶段结束后不会自动执行第二阶段。
3. 第二阶段每次点击都从第一阶段输出 Excel 的第 2 行开始。
4. 第 1 行永远跳过；不存在空白行时按顺序遍历到耗尽。
5. 任一阶段失败不会推进第二阶段的 Excel 游标，也不会泄露敏感字段。
6. 现有 CC 功能和授权 MFA 工作流都可以单独运行。

## Git 同步前置条件

当前仓库尚未配置 `origin`。代码实现和验证完成后，需要用户提供 GitHub/GitLab 远程 URL；在 URL 明确前不执行 `git push`。
