# Excel 驱动的本地 TOTP 验证模块设计

## 1. 目标

在现有 Chrome 扩展 + Native Messaging 主机项目中增加一个 TOTP 模块，供上一登录流程调用。模块接收当前登录流程实际使用的账号和密码，在 `native_host/config.json` 指定的 Excel 文件中查找同一行的实验数据：

- A 列：账号
- B 列：密码
- C 列：TOTP Base32 密钥

匹配到唯一行后，由 Python Native Host 在本机内存中依据 RFC 6238 生成 6 位 TOTP，并把验证码短暂返回 Chrome。Chrome 随后在当前登录标签页的稳定验证码页面中填写并提交。

模块不访问 `https://2fa.run/2fa/`，不把 TOTP 密钥发送到第三方网站，不新开公网标签页，也不读取真实短信系统。

## 2. 范围与非目标

### 范围

- 在现有 Native Messaging 协议中新增 `get_totp` 命令。
- 从现有 `input_excel` 配置读取 Excel XML 数据。
- 精确匹配 A/B 列并读取同一行 C 列。
- 使用 Python 标准库 `base64`、`hmac`、`hashlib` 和 `struct` 生成 TOTP。
- 在 Chrome 扩展中增加 TOTP 工作流控制器和页面适配器。
- 复用现有测试体系：Python `unittest` 与 Node.js 扩展测试。

### 非目标

- 不生成或打开公网 `2fa.run` 链接。
- 不从 Excel 导出 JSON、日志或其他密钥副本。
- 不保存 TOTP 密钥到 Chrome Storage、Native Host 状态文件或日志。
- 不修改现有 CC 批量下载与 TXT 汇总流程的行为。
- 不支持多个匹配行的模糊选择、自动猜测或跳过账号密码校验。

## 3. 固定数据边界

Native Host 只使用 `native_host/config.json` 的 `input_excel` 字段。扩展只把当前运行的账号、密码和随机 `request_id` 发送到已经注册的本地 Native Host；Native Host 只返回验证码或不含秘密值的错误代码。

TOTP 密钥的生命周期限定在 Native Host 的单次请求内：

1. 从 Excel 读取 C 列字符串；
2. 校验 Base32 格式并解码；
3. 计算当前 30 秒时间步的 HMAC-SHA1 动态截断结果；
4. 只返回 6 位验证码和下一时间步的过期时间；
5. 请求结束后不把密钥写入任何持久化介质。

错误响应不得包含密码、密钥、验证码或 Excel 行内容。

## 4. Native Messaging 协议

### 4.1 请求

```json
{
  "request_id": "run-123",
  "command": "get_totp",
  "username": "lab-user",
  "password": "lab-password"
}
```

协议层要求 `request_id`、`username` 和 `password` 为字符串。密码按照收到的字符串进行精确匹配，不做 trim、大小写转换或 Unicode 规范化，避免改变凭据含义。账号同样进行精确匹配。

### 4.2 成功响应

```json
{
  "request_id": "run-123",
  "ok": true,
  "code": "123456",
  "expires_at": "2026-07-17T12:00:30Z"
}
```

`code` 必须为 6 位数字。`expires_at` 表示当前 30 秒时间步结束时间，使用 UTC ISO 8601 字符串。

### 4.3 失败响应

```json
{
  "request_id": "run-123",
  "ok": false,
  "error": "account_duplicate",
  "fatal": false
}
```

允许的错误代码：

- `account_not_found`
- `account_duplicate`
- `totp_secret_missing`
- `totp_secret_invalid`
- `input_excel_missing`
- `input_excel_invalid`
- `native_host_unavailable`
- `totp_clock_error`
- `request_invalid`

`fatal` 只表示 Native Host 进程是否应结束当前批处理连接，不改变扩展端的失败闭环。

## 5. Excel 匹配规则

复用现有 `read_workbook` XML 读取器，不引入第三方 Excel 依赖。新增一个职责单一的读取函数，例如：

```python
def find_totp_secret(path: str | Path, username: str, password: str) -> str:
    ...
```

规则：

- 在所有工作表中按行扫描；
- 每行至少读取前三列 A、B、C；
- 仅当 A 单元格与 `username` 完全相等且 B 单元格与 `password` 完全相等时视为匹配；
- 没有匹配行返回 `account_not_found`；
- 超过一行匹配返回 `account_duplicate`；
- C 为空返回 `totp_secret_missing`；
- 找到唯一匹配后立即校验 C 列 Base32，不将密钥写入异常消息。

## 6. TOTP 算法

固定使用 RFC 6238 常见参数：

- 密钥编码：Base32；
- 哈希：HMAC-SHA1；
- 时间步：30 秒；
- 输出长度：6 位；
- 时间源：Native Host 当前 UTC Unix 时间。

计算步骤：

1. 将密钥转换为大写并校验只包含 Base32 字符及可选 `=` 填充；
2. 解码为字节串；
3. 计算 `counter = floor(unix_time / 30)`；
4. 以大端 8 字节编码 counter；
5. 计算 HMAC-SHA1；
6. 按 RFC 4226 动态截断取 31 位整数；
7. 对 `1_000_000` 取模并格式化为 6 位；
8. 计算下一时间步边界作为 `expires_at`。

不实现时间偏移容忍、不尝试多个哈希算法、不猜测非标准密钥格式。

## 7. Chrome 页面适配

使用稳定属性定位，不依赖动态 React ID：

```css
input[autocomplete="one-time-code"][name="code"][maxlength="6"]
button[type="submit"][name="intent"][value="verify"]
```

动作前必须满足：

- 当前标签页仍是上一登录流程绑定的 tab ID；
- 页面 `document.readyState` 为 `complete`；
- 验证码输入框存在、可见、未禁用且 `aria` 状态合法；
- 提交按钮存在、可见且 `aria-disabled` 不是 `true`；
- DOM 连续 800 毫秒无变化；
- 两次相隔 250 毫秒的采样在阶段、值、属性和几何位置上相同；
- 页面稳定等待不超过 15 秒。

填写时使用原生 value setter，并派发冒泡的 `input` 和 `change` 事件。提交时使用表单 `requestSubmit`，没有表单方法时才使用按钮点击。每个运行 ID 和动作 ID 只能提交一次。

## 8. Chrome 工作流

```text
上一登录流程提交账号密码
  -> Service Worker 保存短暂运行状态
  -> Native Host get_totp
  -> Native Host 匹配 Excel A/B 并读取 C
  -> Native Host 本地生成 TOTP
  -> Service Worker 校验响应和运行 ID
  -> 当前登录标签页等待稳定
  -> 填写 one-time-code 输入框
  -> 提交 verify 按钮
  -> 等待下一页面或登录成功状态
```

Chrome Storage 只保存非敏感的运行状态（阶段、tab ID、错误代码）。密码、C 列密钥和验证码只存在于当前 Promise 调用和消息传递期间；运行结束、失败、取消或超时立即清除。

## 9. 错误与取消

- 找不到 Excel：`input_excel_missing`，停止运行。
- 账号不存在或重复：停止运行，不填写验证码。
- C 列非法：停止运行，不回退到公网服务。
- Native Host 断开或超时：停止运行，向 Popup 展示阶段和错误代码。
- 页面不稳定：15 秒后停止，不盲填、不盲点。
- 输入框或按钮缺失/禁用：停止运行。
- 取消后到达的迟到 Native 响应或页面动作必须被运行 ID 拒绝。
- 异常消息不得包含密码、密钥、验证码或 Excel 行内容。

## 10. 测试设计

### Python Native Host

- A/B 唯一匹配返回 C；
- 未找到、重复匹配、C 为空；
- Base32 合法/非法；
- RFC 6238 标准向量；
- 6 位输出和 30 秒过期时间；
- `get_totp` 协议成功与错误响应；
- 错误响应不包含秘密字段。

### Chrome 扩展

- Native Host 请求只使用当前运行账号和密码；
- 响应的 `request_id`、tab ID 和运行 ID 必须匹配；
- 页面稳定性门控和动态 ID 无关的选择器；
- input/change 事件与 `requestSubmit` 行为；
- 按钮禁用、输入框缺失、页面超时；
- 取消后迟到验证码不会触发填写或提交；
- 现有 CC 批量流程回归测试继续通过。

不执行真实第三方网站、真实短信、生产账号或公网 MFA 测试。

## 11. 验收标准

- 不访问或生成 `2fa.run` URL；
- A/B 精确匹配同一行 C 列；
- Native Host 本地生成标准 6 位 TOTP；
- Chrome 使用给定稳定属性填写并提交验证码；
- 密钥不会进入 Chrome Storage、日志或公网；
- 取消、超时、重复匹配和页面不稳定均安全失败；
- Python 与 Node 测试、现有批处理回归测试全部通过。
