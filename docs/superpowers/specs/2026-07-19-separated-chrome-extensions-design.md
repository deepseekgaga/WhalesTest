# Whalestest 双 Chrome 扩展拆分设计

## 目标

将当前仓库中的两个功能拆成两个可以独立加载、独立运行、独立打包的 Chrome MV3 扩展：

- `CC 批量下载与 TXT 汇总`
- `授权登录与 MFA 测试工作流`

两者继续位于同一个 `Whalestest` Git 仓库中，共享 Native Host 和 Python 测试基础设施，但不再共享同一个扩展入口、弹窗或 Service Worker。

## 非目标

- 不重命名或删除已有 Native Host 标识 `com.whalestest.cc_batch`。
- 不扩大目标站点权限，不添加 `<all_urls>`、`clipboardRead` 或 `debugger` 权限。
- 不把两个扩展合并为一个带运行时开关的扩展。
- 不改变现有 Excel 物理行绑定、TOTP/SMS 本地靶场协议和失败窗口保留策略。

## 仓库布局

```text
Whalestest/
├─ extensions/
│  ├─ cc-batch/
│  │  ├─ manifest.json
│  │  ├─ background.js
│  │  ├─ popup.html
│  │  ├─ popup.js
│  │  ├─ popup.css
│  │  └─ cc-batch-runtime-files
│  └─ authorized-mfa-workflow/
│     ├─ manifest.json
│     ├─ background.js
│     ├─ popup.html
│     ├─ popup.js
│     ├─ popup.css
│     └─ workflow-runtime-files
├─ native_host/
├─ scripts/
├─ tests/
└─ README.md
```

两个扩展目录不通过相对路径互相导入。需要同时存在的少量协议辅助代码分别放入对应扩展目录，避免 Chrome 加载目录时依赖扩展根目录之外的文件。

## 扩展身份与 Native Host

- 旧 CC 扩展保留现有 manifest key 和扩展 ID，降低升级风险。
- MFA 扩展使用不同的 manifest key，确保 Chrome 生成不同的扩展 ID。
- Native Host 继续使用 `com.whalestest.cc_batch`，其 `allowed_origins` 同时包含两个扩展 ID。
- 安装脚本保留旧的单扩展参数兼容形式，并增加多扩展 ID 配置形式；写入前校验每个 ID 必须匹配 `^[a-p]{32}$`。
- 两个扩展都只通过 Native Messaging 访问 Host，不互相发送运行时消息。

## 运行时边界

### CC 扩展

只保留旧的 ZIP 下载、TXT 汇总、旧弹窗和对应后台路由。其用户-facing 名称和打包名继续使用 CC 标识。

### MFA 扩展

只保留母页、无痕窗口、登录、TOTP、本地 SMS、接受按钮、最终 URL 回填和工作流状态弹窗。其 manifest 仅声明授权靶场所需的固定 Host 权限：

- `http://127.0.0.1:9527/*`
- `http://auth-target.local/*`
- `http://totp-lab.local/*`
- `http://sms-lab.local/*`

MFA 扩展继续满足以下状态约束：只有完成整个认证与母页回填后才推进 Excel 行；失败时保留无痕窗口；公开状态不包含用户名、密码、TOTP secret、短信验证码或最终 URL。

## 打包与安装

打包脚本支持以下目标：

```powershell
.\scripts\package-extension.ps1 -Target CcBatch
.\scripts\package-extension.ps1 -Target AuthorizedMfa
.\scripts\package-extension.ps1 -Target All
```

输出包名称固定为：

- `cc-batch-chrome-extension-v0.1.0.zip`
- `authorized-mfa-workflow-chrome-extension-v0.1.0.zip`

安装文档说明两个扩展分别加载各自目录；Native Host 只安装一次，但必须注册两个扩展 ID。

## 测试策略

- 为两个扩展分别建立 manifest、路由和打包清单测试。
- 保留并迁移现有 CC 测试，不允许 MFA 工作流测试依赖 CC 的 mock 状态。
- 保留现有 MFA 测试，增加“单独加载 MFA 扩展即可启动完整工作流”的覆盖。
- Native Host 测试覆盖两个 allowed origin、旧参数兼容和错误输入拒绝。
- 打包测试确保两个 ZIP 不包含对方的 Service Worker、弹窗或专属路由。
- 运行 Python 单元测试、Node 扩展测试、语法检查、权限扫描和双目标打包验证。

## 验收标准

1. 两个扩展可分别在 `chrome://extensions/` 中加载并显示不同名称。
2. 单独启用 CC 扩展时，旧批处理流程可用；单独启用 MFA 扩展时，授权登录工作流可用。
3. 任一扩展卸载或停用不影响另一个扩展的加载和运行。
4. Native Host 同时接受两个扩展 ID，且不接受未配置来源。
5. 两个 ZIP 均可独立安装，且文件清单没有跨扩展污染。
6. 现有安全权限边界、秘密不落盘策略和失败证据保留策略不回退。

## Git 同步前置条件

当前仓库没有配置 `origin`。实现并验证拆分后，需要用户提供目标 GitHub/GitLab 远程 URL；在未提供 URL 前不执行 `git push`。
