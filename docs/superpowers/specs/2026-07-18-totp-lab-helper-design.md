# TOTP Lab 辅助标签页流程：设计说明

## 1. 背景与目标

现有项目已经具备 Chrome Manifest V3 扩展、Python Native Messaging Host、Excel Open XML 读取器、本地 RFC 6238 TOTP 生成器，以及在登录页填写一次性验证码的页面动作。本阶段新增一个独立的 TOTP Lab 辅助流程，供后续完整工作流调用。

调用方提供必须保留的母页 tab、需要填写验证码的无痕 tab，以及 Excel 物理行号。模块从 `C:\Users\HE\Downloads\jingshajingsha\cc汇总.xlsx` 指定行的 C 列取得实验 TOTP 密钥，在母页所在普通窗口中创建本地辅助 tab，通过靶场测试钩子取得唯一的 6 位验证码，关闭辅助 tab，最后把验证码填入无痕 tab。

本阶段只实现该 TOTP 辅助流程。账号密码登录、母页取链接、手机接码、“接受”按钮、结果 URL 回填和循环调度均留给后续模块。

## 2. 安全边界

- 只允许固定本地域名 `http://totp-lab.local/*`。
- 不包含滑块识别、鼠标轨迹生成、自动拖动或任何绕过 CAPTCHA / 人机验证的代码。
- 靶场通过显式测试钩子进入可测试状态；扩展只读取页面已经显示的验证码。
- 母页 tab 永远不能被导航、刷新或关闭。
- 辅助 tab 只能在成功、超时、取消或失败清理时被关闭。
- 无痕登录 tab 只能接收验证码页面动作，不能被本模块关闭。
- C 列值不写入扩展日志、`chrome.storage`、公共状态或错误响应。
- 根据用户确认，包含实验密钥的本地 URL 可以进入普通 Chrome 浏览历史；关闭辅助 tab 不代表删除历史记录。

## 3. 调用接口

核心接口：

```js
runTotpLab({
  motherTabId,
  incognitoTabId,
  excelRow
})
```

参数约束：

- `motherTabId`：大于 0 的整数，指向普通窗口中的母页。
- `incognitoTabId`：大于 0 的整数，指向需要填写 TOTP 的无痕 tab。
- `excelRow`：大于 0 的整数，表示第一个工作表中的 Excel 物理行号。
- 三个 ID 由后续总工作流传入。本阶段不增加临时“设置母页”按钮。
- 调用前，用户必须在 `incognitoTabId` 对应 tab 中主动触发扩展，使该 tab 获得自己的 `activeTab` 临时授权；母页 tab 的授权不会转移到无痕 tab。

公共状态只包含：

```text
IDLE
READING_CHALLENGE
OPENING_HELPER
WAITING_FOR_CODE
FILLING_TOTP
SUCCEEDED
FAILED
CANCELLED
```

状态可以包含 `runId` 和固定错误码，但不能包含 tab URL、账号、密码、C 列密钥或验证码。

## 4. 配置

`native_host/config.json` 增加：

```json
{
  "input_excel": "C:\\Users\\HE\\Downloads\\jingshajingsha\\cc汇总.xlsx",
  "totp_lab_url": "http://totp-lab.local/",
  "totp_lab_test_hook": "__FILL_TOTP_TEST_HOOK__"
}
```

规则：

- `totp_lab_url` 必须严格使用 `http` 协议，主机必须是 `totp-lab.local`，不能包含用户名、密码、查询参数或 fragment。
- 基础 URL 的路径必须是 `/`，防止配置改变密钥拼接语义。
- `totp_lab_test_hook` 未替换占位符或为空时返回 `totp_test_hook_not_configured`。
- 测试钩子只用于自建靶场测试模式，不解释为生产验证码服务凭据。

Manifest 增加精确 host permission：

```json
{
  "host_permissions": ["http://totp-lab.local/*"]
}
```

不得增加 `<all_urls>`、通配 HTTP/HTTPS 域名或运行时可扩展到其他站点的权限。

## 5. Native Host 挑战 URL 构造

新增命令：

```json
{
  "command": "get_totp_lab_challenge",
  "excel_row": 3,
  "request_id": "..."
}
```

处理步骤：

1. 校验 `excel_row` 是大于 0 的整数；布尔值不算整数。
2. 加载配置并读取 `input_excel` 的第一个工作表。
3. 按 Excel 物理行号定位行，而不是按读取后的数组下标猜测。
4. 读取 C 列；空值返回 `totp_secret_missing`。
5. 使用 UTF-8 URL path segment 编码 C 列值。
6. 使用查询参数编码 `totp_lab_test_hook`。
7. 构造：

   ```text
   http://totp-lab.local/<encoded-secret>?test_hook=<encoded-hook>
   ```

8. 只返回完整的 `challenge_url`，不额外返回 `secret` 或 `test_hook` 字段。

成功响应示意：

```json
{
  "ok": true,
  "challenge_url": "http://totp-lab.local/ENCODED?test_hook=ENCODED",
  "request_id": "..."
}
```

固定错误码不能回显单元格值、URL 或测试钩子。

## 6. 辅助 tab 创建与母页保护

控制器在创建辅助 tab 前分别调用 `chrome.tabs.get(motherTabId)` 和 `chrome.tabs.get(incognitoTabId)`：

- 母页必须存在，且所在窗口不能是无痕窗口。
- 目标 tab 必须存在，且所在窗口必须是无痕窗口。
- 两个 tab ID 不能相同。

辅助 tab 使用以下关键参数创建：

```js
chrome.tabs.create({
  windowId: motherTab.windowId,
  index: motherTab.index + 1,
  active: false,
  url: challengeUrl
})
```

这样辅助 tab 位于母页右侧，同时不导航、不刷新、不关闭母页，也不主动抢走无痕登录窗口的焦点。

创建后记录唯一的 `helperTabId`。后续刷新、脚本注入和关闭操作只能使用这个 ID，禁止使用“当前活动 tab”等不稳定定位方式。

## 7. 页面稳定与验证码提取

新增可注入的纯页面函数，概念接口：

```js
readVisibleTotpCode({ timeoutMs })
```

每次辅助页加载后：

1. 等待 `document.readyState === "complete"`。
2. 等待 DOM 在短时间采样窗口内稳定。
3. 读取 `document.body.innerText`，以页面可见文本为准。
4. 使用独立数字边界匹配 6 位数字，等价于：

   ```regex
   (?<!\d)\d{6}(?!\d)
   ```

5. 去重后：
   - 0 个候选：返回 `code_not_present`，由控制器决定等待和刷新。
   - 1 个候选：返回该验证码。
   - 多于 1 个候选：返回 `totp_code_ambiguous`，立即终止，不选择第一个。

页面函数不点击、拖动或模拟任何人机验证控件。

## 8. 刷新时序与 60 秒上限

从辅助 tab 首次完成加载时开始计算总等待时间：

- 首次加载稳定后立即读取一次。
- 没有验证码时等待到第 15 秒，然后执行 `chrome.tabs.reload(helperTabId)`。
- 后续仍无验证码时，在第 30 秒和第 45 秒附近继续刷新。
- 每次刷新完成并稳定后立即读取。
- 到达 60 秒上限前做最后一次可用读取；仍没有验证码时返回 `totp_code_not_found`。
- 不允许通过加载很慢而无限延长总截止时间。

刷新只能针对 `helperTabId`。在每次等待、刷新和注入后都必须检查当前运行仍未取消，并重新确认辅助 tab 仍存在。

## 9. 填写无痕 TOTP 页面

取得唯一验证码后：

1. 关闭 `helperTabId`。
2. 再次确认母页仍存在；母页丢失时返回 `mother_tab_missing`，但不影响已关闭的辅助 tab。
3. 调用现有 TOTP 页面动作，在 `incognitoTabId` 中等待最多 30 秒。
4. 使用稳定选择器：

   ```css
   input[autocomplete="one-time-code"][name="code"][maxlength="6"]
   button[type="submit"][name="intent"][value="verify"]
   ```

5. 填入验证码，触发 `input`、`change`，并提交。

独立的本地 RFC 6238 TOTP 控制器继续保留。TOTP Lab 使用新的控制器和消息路由，不改变原有调用语义。

## 10. 取消和清理

- 每个运行拥有唯一 `runId`。
- `cancelTotpLab(runId)` 将运行标记为 `CANCELLED`。
- 如果本次运行已经创建辅助 tab，取消时关闭该辅助 tab。
- 取消不得关闭或导航母页和无痕登录 tab。
- Native Host 延迟响应、tab 加载事件、15 秒计时器和页面脚本返回后都必须检查运行是否仍有效。
- 运行结束后清除所有计时器和 tab 事件监听器。
- 如果辅助 tab 已被用户手动关闭，返回固定错误码，不尝试操作相邻 tab。

## 11. Service Worker 路由

新增消息：

- `run_totp_lab`：参数 `motherTabId`、`incognitoTabId`、`excelRow`。
- `cancel_totp_lab`：参数 `runId`。
- `totp_lab_state`：读取非敏感状态。

路由校验：

- `sender.id === chrome.runtime.id`。
- 请求不能提供 `challengeUrl`、C 列密钥、测试钩子或验证码。
- 调用方提供的 tab ID 仍由控制器通过 `chrome.tabs.get()` 验证 normal/incognito 属性。
- 异常文本经过固定错误码过滤后才能进入响应或状态。

## 12. 错误码

至少覆盖：

- `request_invalid`
- `excel_row_invalid`
- `account_row_not_found`
- `totp_secret_missing`
- `input_excel_missing`
- `input_excel_invalid`
- `totp_lab_url_invalid`
- `totp_test_hook_not_configured`
- `mother_tab_missing`
- `mother_tab_incognito`
- `incognito_tab_missing`
- `incognito_tab_required`
- `incognito_active_tab_required`
- `helper_tab_create_failed`
- `helper_tab_closed`
- `helper_page_not_stable`
- `totp_code_ambiguous`
- `totp_code_not_found`
- 现有 TOTP 页面动作错误码
- `cancelled`

## 13. 测试策略

### 13.1 Python

- 按物理行读取 C 列。
- 行号无效、行不存在、C 列为空和损坏 XLSX。
- C 列中的空格、斜杠、加号和非 ASCII 字符正确进行 path segment 编码。
- 测试钩子正确进行查询参数编码。
- 基础 URL 不是精确本地域名时拒绝。
- 测试钩子仍是占位符时拒绝。
- 响应不含单独的 secret/test-hook 字段。

### 13.2 页面函数

- 页面稳定后读取唯一 6 位数字。
- 忽略 5 位、7 位和更长数字中的 6 位子串。
- 相同验证码重复显示时去重为一个候选。
- 不同的多个 6 位数字返回歧义错误。
- 没有数字和页面不稳定分别返回固定错误。

### 13.3 控制器

- 验证普通母页和无痕目标 tab。
- 辅助 tab 创建在母页右侧且 `active: false`。
- 所有刷新和关闭操作只针对 helper ID。
- 0、15、30、45 秒附近读取/刷新并执行 60 秒总截止。
- 找到验证码后关闭辅助 tab，再在同一无痕 tab 填写。
- TOTP 页面动作等待上限为 30 秒。
- 取消关闭辅助 tab，但保留母页和无痕 tab。
- 母页在任意阶段都没有收到 update/reload/remove 调用。
- 公共状态、错误响应和存储不含 URL、密钥、测试钩子或验证码。

### 13.4 路由与回归

- `run_totp_lab` 只接受三个整数参数。
- Manifest 仅增加 `http://totp-lab.local/*` 精确权限。
- 原有批处理、Native Host、本地 TOTP 和页面填写测试继续通过。

## 14. 验收标准

- 调用方传入有效 mother/incognito tab ID 和 Excel 行号后，模块从该行 C 列构造本地 TOTP Lab URL。
- 辅助 tab 出现在母页右侧，母页始终保留且不被改变。
- 测试钩子使靶场展示唯一验证码时，扩展读取验证码、关闭辅助 tab，并在无痕页面等待最多 30 秒完成填写提交。
- 没有验证码时按 15 秒间隔刷新，总运行不超过 60 秒。
- 多个不同验证码时不猜测，返回 `totp_code_ambiguous`。
- 模块不包含任何人机验证绕过逻辑。
- 所有新增测试和原有回归测试通过。
