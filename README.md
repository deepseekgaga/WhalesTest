# Chrome 批量下载与本地 TOTP 测试扩展

本项目用于完全授权、隔离的本地网络安全测试环境。Chrome 扩展负责页面操作，Python Native Messaging Host 负责读取本地 Excel、生成 TOTP，并维护批处理状态。

## 功能概览

- 按 Excel 中的地址列顺序执行批量下载，并汇总 TXT 结果。
- 从 Excel 同一行的 A、B、C 列读取账号、密码和 TOTP 密钥。
- 在本地 Native Host 内按 RFC 6238 生成 6 位验证码。
- 等待登录页稳定后，填写稳定的一次性验证码输入框并提交。
- 不访问公共验证码网站，不把 TOTP 密钥写入日志、扩展存储或页面 URL。

## Excel 与配置

Native Host 配置文件为 `native_host/config.json`，关键字段如下：

```json
{
  "input_excel": "C:\\path\\to\\accounts.xlsx",
  "field_mappings": {
    "A": "username",
    "B": "password",
    "C": "totp_secret"
  }
}
```

TOTP 查找规则：

1. 在所有工作表中查找 A 列与当前登录用户名完全相等、B 列与当前登录密码完全相等的行。
2. 必须且只能匹配一行；找不到或匹配多行都会安全失败。
3. 从该行 C 列读取 Base32 密钥，使用标准 HMAC-SHA1、30 秒时间步长和 6 位数字生成验证码。

## TOTP 工作流

扩展通过 Service Worker 路由以下消息：

```js
{
  type: "run_totp",
  tabId: 7,
  username: "alice",
  password: "实验账号密码"
}
```

Service Worker 将请求发送给 `com.whalestest.cc_batch` Native Host。Native Host 只返回验证码和过期时间，不返回密钥。随后扩展在指定 tab 中执行页面动作：

- 等待 `document.readyState === "complete"`；
- 等待 DOM 和控件短暂稳定；
- 查找 `input[autocomplete="one-time-code"][name="code"][maxlength="6"]`；
- 查找 `button[type="submit"][name="intent"][value="verify"]`；
- 填入验证码并触发 `input`、`change` 事件；
- 调用 `requestSubmit()` 或点击提交按钮。

页面动作默认最多等待 15 秒。运行状态只保留 `IDLE`、`FETCHING_TOTP`、`FILLING_TOTP`、`SUCCEEDED`、`FAILED`、`CANCELLED` 等非敏感字段。

## 安装

1. 打开 `chrome://extensions`，启用“开发者模式”，加载 `extension` 目录。
2. 确认 PowerShell 中可执行 Python 3.11 或更高版本：

   ```powershell
   python --version
   ```

3. 使用扩展实际 ID 注册 Native Host：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId <32位扩展ID>
   ```

4. 修改 `native_host/config.json` 后重新执行安装脚本，使 Native Host 拷贝到本地安装目录的配置保持同步。

扩展只声明 `nativeMessaging`、`tabs`、`downloads`、`storage`、`activeTab` 和 `scripting` 权限；没有声明 `<all_urls>` 或宽泛站点权限。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-native-host.ps1
```

## 测试

```powershell
python -m unittest discover -s native_host/tests -v
node --test extension/tests/*.test.mjs
```

## 安全边界

本项目仅面向自建靶场和虚拟账号。请不要将真实账号、真实密码、真实手机号或生产环境 TOTP 密钥写入测试 Excel，也不要把扩展用于未授权网站。
