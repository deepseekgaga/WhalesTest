# 母页提链与无痕登录全流程设计

## 1. 目标

在现有 Manifest V3 Chrome 扩展和 Native Messaging 主机中增加一个独立的总工作流控制器。用户预先打开母页 `http://127.0.0.1:9527/`，点击扩展中的“开始执行任务”后，扩展自动完成：

1. 在母页创建账号并生成随机授权链接；
2. 在新的 Chrome 无痕窗口打开授权链接；
3. 使用与当前序号绑定的 Excel 行执行账号密码登录；
4. 复用现有 TOTP Lab 和 SMS Lab 模块完成双重验证；
5. 点击最终“接受/Accept”按钮；
6. 读取无痕页最终 URL，并回填母页；
7. 只有母页确认成功后才递增序号、关闭成功的无痕窗口并继续下一行；
8. Excel 数据遍历完成后正常结束整批任务。

本设计只面向用户已授权的隔离测试环境。它不加入验证码绕过、商业接码服务、宽泛网页权限或系统剪贴板读取。

## 2. 已确认的业务约定

- Excel 第 1 行是表头，第 2 行是第一条数据。
- 账号序号 `N` 对应 Excel 物理行 `N + 1`。
- 每次点击“开始执行任务”都新建一个批次，并从序号 1 开始。
- 一次点击会自动连续处理 Excel 第 2 行到最后一行。
- Excel 数据行中间不存在空白行。
- 序号只有在以下完整链路全部成功后才提交：
  - 母页成功创建账号；
  - 成功生成并读取授权链接；
  - 账号密码登录成功；
  - TOTP 验证成功；
  - 手机短信验证成功；
  - 点击接受按钮并进入最终主页；
  - 最终 URL 成功回填母页并得到成功确认。
- 任一步失败都不递增序号，也不读取下一行。
- 每个可恢复阶段自动重试 1 次；第二次仍失败时停止整批任务并报错。
- 成功轮次关闭其无痕窗口；失败轮次保留无痕窗口，供用户检查现场。

## 3. 权限边界与配置

### 3.1 Manifest 权限

扩展继续使用现有最小权限，并增加工作流所需的权限：

- `tabs`
- `scripting`
- `storage`
- `nativeMessaging`
- `alarms`

Host permissions 限定为：

- `http://127.0.0.1:9527/*`
- `http://totp-lab.local/*`
- `http://sms-lab.local/*`
- `http://auth-target.local/*`

其中 `http://auth-target.local/*` 是一个语法有效的本地测试域名占位。加载用于真实联调的扩展前，必须把它替换为随机授权链接实际使用的固定来源域名。扩展不声明 `<all_urls>`，也不声明 `clipboardRead`、`debugger` 或任意 HTTP/HTTPS 通配权限。

Manifest 显式使用 `incognito: "spanning"`。用户仍需在 Chrome 扩展详情页开启“允许在无痕模式下运行”。控制器不请求额外宽权限；如果创建无痕窗口失败，则把 Chrome 的该类失败映射为 `incognito_access_required`。

固定 Host permission 同时解决一个 Chrome 权限边界：用户在母页点击扩展获得的 `activeTab` 权限不会自动转移到新建的无痕标签。后续页面注入依赖精确授权域名的 Host permission，而不假设 `activeTab` 会跨标签传递。

### 3.2 页面选择器配置

新增 `extension/workflow-selectors.js`，集中定义：

- `accountManagement`
- `addAccount`
- `accountDialog`
- `accountNameInput`
- `platformControl`
- `platformOptions`
- `groupContainer`
- `nextButton`
- `generateLinkSection`
- `generateLinkButton`
- `authorizationUrl`
- `copyUrlButton`
- `loginSubmitButton`
- `acceptButton`
- `motherFinalUrlInput`
- `motherFinalConfirmButton`
- `motherFinalSuccess`

母页创建账号和生成链接阶段允许在精确选择器未配置时使用唯一可见中文文本回退。最终 URL 输入框、最终确认按钮和最终成功标志必须配置精确选择器；缺少配置时停止运行，不能猜测页面上的普通输入框或按钮。

登录账号和密码输入框固定为 `#username`、`#password`。登录提交按钮优先使用配置选择器，未配置时只接受唯一、可见、已启用的 `button[type="submit"]`。接受按钮优先使用配置选择器，未配置时只接受唯一的可见文本“接受”或“Accept”。

### 3.3 URL 校验

授权 URL 必须同时满足：

- 使用 `http:` 或 `https:`；
- 不包含 URL username/password 字段；
- 来源与 Manifest 中配置的固定授权域名精确匹配；
- 页面中只出现一个符合条件的候选 URL。

最终 URL 从无痕标签的 `chrome.tabs.get(tabId).url` 读取，不从系统剪贴板读取。授权链接同样从母页 DOM 的文本、链接属性或输入框值读取。“COPY URL”按钮仍按业务流程点击，但它的系统剪贴板内容不是数据源。

## 4. 组件设计

### 4.1 `workflow-controller.js`

这是完整批次的唯一总调度器，负责：

- 创建和管理批次状态；
- 维护序号与物理 Excel 行的映射；
- 调用 Native Host；
- 调用母页、登录页和最终页面动作；
- 创建、切换和关闭无痕窗口；
- 复用现有 TOTP/SMS 控制器；
- 统一执行页面稳定等待、阶段重试、取消和清理；
- 只有最终母页提交成功后才推进序号。

现有 `background.js` 只增加严格的消息路由，不承载完整业务流程。

### 4.2 `mother-page.js`

提供可序列化的页面动作：

- 验证母页状态；
- 打开账号管理；
- 打开添加账号对话框；
- 填写账号名称；
- 选择第二个平台；
- 勾选分组复选框；
- 进入下一步；
- 生成并读取授权 URL；
- 点击 COPY URL；
- 回填最终 URL；
- 判断最终回填是否成功。

页面动作只返回结构化结果和固定错误码，不返回整个 DOM、页面 Cookie 或无关页面内容。

### 4.3 `login-page.js`

负责：

- 等待 `#username` 和 `#password` 可用；
- 写入账号密码并触发必要的 `input`、`change` 事件；
- 再次读取输入框值，确认页面实际接收了数据；
- 定位并点击登录提交按钮；
- 识别明确的登录错误；
- 在 30 秒等待结束后确认页面进入 TOTP 阶段。

### 4.4 Native Host

新增严格命令：

```text
get_workflow_credentials(excel_row)
```

输入只接受 `command`、整数 `excel_row` 和协议需要的 `request_id`。`excel_row` 必须大于等于 2。

返回行为：

- 行存在且 A/B 列有效：返回该行账号和密码；
- 物理行不存在：返回 `excel_exhausted`；
- 行存在但账号或密码为空或类型无效：返回 `credentials_invalid`；
- 其他 Excel 读取错误：返回清洗后的固定错误码。

控制器在创建母页账号前调用一次该命令作为行预检，并立即丢弃响应中的凭据。这样不会在 Excel 已遍历完成时额外创建一个母页账号。进入登录阶段后再次读取同一物理行，立即用于登录，并在函数返回后释放引用。凭据不会跨阶段写入 Chrome Storage。

### 4.5 现有 TOTP/SMS 控制器

两个现有控制器继续以 `{motherTabId, incognitoTabId, excelRow}` 为调用契约：

- TOTP Lab 使用同一物理行 C 列；
- SMS Lab 使用同一物理行 D 列手机号和 E 列本地接码 URL；
- 辅助标签创建在母页普通窗口中、母页标签右侧，并保持后台标签；
- 辅助标签使用后关闭，母页不被替换或关闭；
- 验证码只接受唯一、独立的 6 位数字。

目标页访问检查改为实际尝试受限的 `chrome.scripting.executeScript`：精确 Host permission 或当前标签已有的合法 `activeTab` 授权任一满足即可。访问失败统一映射为 `target_host_permission_required`，不得通过 `<all_urls>` 修复。

本次工作流明确把 TOTP Lab 的物理行下界统一收紧为 2：后台 direct route、`totp-lab-controller.js` 和 Native Host 的 TOTP Lab 行号校验都拒绝 `excelRow === 1`。SMS Lab 已经使用相同下界。这样所有入口都不会误把表头当作数据行。

## 5. 状态机与数据流

### 5.1 阶段

```text
IDLE
→ ROW_PREFLIGHT
→ MOTHER_ACCOUNT
→ AUTH_LINK
→ OPEN_INCOGNITO
→ LOGIN
→ LOGIN_WAIT
→ TOTP
→ SMS
→ ACCEPT
→ FINAL_URL
→ MOTHER_BACKFILL
→ COMMIT
→ CLEANUP
→ ROW_PREFLIGHT（下一行）或 COMPLETED
```

失败进入 `FAILED`，用户停止进入 `CANCELLED`。

### 5.2 批次状态

`chrome.storage.session` 只保存非秘密运行元数据：

```text
batchId
state
sequence
excelRow
motherTabId
motherWindowId
incognitoTabId
incognitoWindowId
attempt
loginSubmittedAt
lastError
startedAt
updatedAt
```

不保存：

- 授权 URL；
- 最终 URL；
- 账号或密码；
- TOTP 密钥或验证码；
- 手机号、接码 URL 或短信验证码。

授权 URL 在同一个 `AUTH_LINK` 事件中读取、校验并用于创建无痕窗口。如果 Service Worker 在完成前终止，状态仍停留在 `AUTH_LINK`；再次进入该阶段时先检查链接是否已经生成，再继续打开，不重复生成链接。

最终 URL 在 `FINAL_URL` 阶段读取后立即回填母页。若该事件中断，阶段仍保持不变，重新执行读取和幂等回填。

### 5.3 Service Worker 生命周期

跨阶段继续运行和登录后的等待使用 `chrome.alarms`，不依赖插件弹窗保持打开，也不依赖一个持续数小时的单一 Promise。提交登录时记录 `loginSubmittedAt`；Alarm 只保证在不少于 30 秒后唤醒检查，Chrome 延迟唤醒不会被当成失败。恢复后仍需重新检查页面稳定状态和 TOTP 阶段。

Service Worker 被 Chrome 暂停后，下一次 Alarm 从 `chrome.storage.session` 恢复当前阶段。浏览器完全退出后不自动恢复旧批次；再次点击开始会建立新批次并从序号 1 开始。

## 6. 母页创建账号和提链流程

启动时：

1. 获取当前激活标签；
2. 要求 URL 精确为 `http://127.0.0.1:9527/`；
3. 要求标签属于普通窗口；
4. 保存母页标签和窗口 ID；
5. 设置序号 1、物理 Excel 行 2。

每一行先完成 `ROW_PREFLIGHT`，确认 Excel 行存在且账号密码有效，再操作母页。

母页动作顺序：

1. 查找并点击“账号管理”；
2. 查找并点击“添加账号”；
3. 等待同一 DOM 内的普通对话框；
4. 生成账号名称 `YYYYMMDD-HHmm SHARKPIX PLUS N`；
5. 使用浏览器本地时间和 24 小时制，精确到分钟；
6. 填入“账号名称”；
7. 打开平台控件；
8. 只在对应选项列表中选择第二个未禁用选项；
9. 选择前滚动到元素并触发指针悬停/点击事件；
10. 只在“分组”容器中勾选全部未禁用、未勾选的复选框；
11. 点击对话框右下角“下一步”；
12. 在“点击下方按钮生成授权链接”区域点击唯一的“生成授权链接”按钮；
13. 等待并读取唯一合法授权 URL；
14. 点击该 URL 旁边的“COPY URL”按钮；
15. 创建一个新的无痕普通窗口，在其激活标签中打开授权 URL。

母页在自己的普通窗口中始终保持为选中标签。无痕窗口执行登录时可成为前台焦点；需要母页动作时再切回母页窗口。

## 7. 无痕登录、TOTP、短信和接受流程

### 7.1 无痕窗口

为避免 Service Worker 在“窗口已经创建、窗口 ID 尚未持久化”的瞬间终止而重复创建无痕窗口，控制器不直接用授权 URL 创建窗口。它先使用不发起网络请求的唯一标记 URL `about:blank#whalestest-handoff-<batchId>`；`batchId` 由扩展内部使用密码学安全随机值生成：

```js
chrome.windows.create({
  incognito: true,
  focused: true,
  type: "normal",
  url: `about:blank#whalestest-handoff-${batchId}`
});
```

该标记不是扩展包页面，因此与 `incognito: "spanning"` 兼容，也不需要 Host permission。扩展已有的 `tabs` 权限用于枚举标签并精确比较完整 marker URL。

`OPEN_INCOGNITO` 的顺序固定为：

1. 先把阶段和 `batchId` 写入 `chrome.storage.session`；
2. 创建带唯一 handoff URL 的无痕窗口；
3. 持久化返回的 `incognitoWindowId` 和 `incognitoTabId`；
4. 再把该标签导航到从母页 DOM 重新读取并校验过的授权 URL；
5. 导航成功后进入 `LOGIN`。

恢复 `OPEN_INCOGNITO` 时：

- 若状态中已有标签 ID，则先复用并验证该标签；
- 若 ID 尚未写入，则枚举无痕标签并查找当前 `batchId` 的唯一 `about:blank` handoff URL；
- 找到唯一 handoff 标签时接管它并继续导航；
- 找到多个同批次 handoff 标签时返回 `incognito_window_ambiguous`，保留现场且不新建窗口；
- 没有找到时才允许当前阶段重试创建一次。

因此即使 Service Worker 在 `chrome.windows.create()` 返回前后暂停，也不会无条件创建第二个无痕窗口。授权 URL 本身仍不写入 Chrome Storage。

创建后确认：

- 窗口和标签都存在；
- 标签 `incognito === true`；
- 标签 URL 来源仍匹配固定授权域名；
- 页面加载完成并达到稳定条件。

### 7.2 登录

1. 使用当前物理 Excel 行再次调用 `get_workflow_credentials`；
2. 填写 `#username` 和 `#password`；
3. 校验输入框实际值；
4. 点击唯一合法的提交按钮；
5. 记录提交时间并进入 `LOGIN_WAIT`，使用 Alarm 在不少于 30 秒后恢复；
6. 等待页面稳定；
7. 若出现明确登录错误，返回 `login_rejected`；
8. 若未出现 TOTP 页面，返回 `totp_stage_not_reached`。

### 7.3 TOTP

调用现有 TOTP Lab 控制器。它按当前物理行读取 C 列，打开 `http://totp-lab.local/<URL编码后的密钥>` 辅助页，按已经确认的 15 秒刷新间隔和 60 秒上限读取唯一六位验证码，再回填同一无痕标签。

本设计不加入自动拖动、行为轨迹或人机验证绕过。现有授权测试钩子契约保持不变。

### 7.4 手机验证

调用现有 SMS Lab 控制器：

1. 使用当前物理行 D 列手机号；
2. 在同一无痕标签填写手机号并点击发送；
3. 在母页旁边创建普通后台辅助标签，打开同一行 E 列的 `http://sms-lab.local/*` URL；
4. 读取唯一六位验证码；
5. 回填同一无痕标签并提交；
6. 关闭 SMS 辅助标签。

### 7.5 接受与最终 URL

1. 等待“接受/Accept”页面稳定；
2. 点击配置选择器或唯一可见文本匹配的接受按钮；
3. 等待最终主页稳定；
4. 读取无痕标签最终 URL；
5. 切换回母页窗口；
6. 把 URL 填入精确配置的母页输入框；
7. 点击精确配置的确认按钮；
8. 必须检测到 `motherFinalSuccess`，才进入 `COMMIT`。

## 8. 页面稳定规则

每个页面动作必须同时满足：

- `document.readyState === "complete"`；
- 当前步骤目标元素存在、可见且未禁用；
- 与当前操作相关的 DOM 连续 500 毫秒没有变化；
- 单步骤最长等待 30 秒。

不把 `networkidle` 作为唯一稳定标准，因为母页和授权页可能是持续请求的 SPA。

文本回退必须得到唯一候选。零个候选返回 `element_not_found`，多个候选返回 `element_ambiguous`，不能选择第一个碰巧匹配的元素。

## 9. 重试、幂等和提交语义

### 9.1 自动重试一次

以下可恢复错误允许当前阶段重试 1 次：

- 页面暂未稳定；
- 元素暂未出现；
- 标签加载超时；
- Native Host 临时无响应；
- 页面动作未观察到预期后置状态。

以下确定性错误直接失败：

- 配置缺失；
- 授权域名不匹配；
- Excel 行存在但数据非法；
- 元素匹配不唯一；
- 母页地址错误；
- 无痕模式未授权；
- 目标 Host permission 缺失。

### 9.2 有副作用操作

重试前先检查后置状态：

- 添加账号对话框已经打开时，不再次点击“添加账号”；
- 已经进入授权链接页面时，不再次点击“下一步”；
- 授权链接已经存在时，不再次点击“生成授权链接”；
- 已经进入 TOTP/SMS/接受/最终主页时，不重复提交上一阶段；
- 母页已经显示回填成功时，直接进入 `COMMIT`。

### 9.3 序号提交

`COMMIT` 是唯一允许修改序号的阶段：

```text
sequence = sequence + 1
excelRow = sequence + 1
```

进入 `COMMIT` 前，任何成功的局部步骤都不消耗当前序号。

成功提交后关闭对应无痕窗口，再开始下一行预检。下一物理行不存在时进入 `COMPLETED`，不再创建母页账号。

## 10. 失败、取消和清理

第二次尝试仍失败时：

- 状态进入 `FAILED`；
- 停止整批任务；
- 不递增序号；
- 不读取下一行；
- 关闭当前工作流拥有的 TOTP/SMS 普通辅助标签；
- 保留已经创建的失败无痕窗口；
- 保留母页；
- 插件显示批次 ID、序号、Excel 物理行、失败阶段、固定错误码和时间。

用户点击“停止任务”时进入 `CANCELLED`，采用相同的清理规则，并保留无痕窗口。

重新点击“开始执行任务”会创建新批次并从序号 1 开始。此前失败的无痕窗口不会被新批次自动关闭。由于账号名称精确到分钟，用户在同一分钟重新开始可能再次尝试创建同名的序号 1 账号；这是“每次开始都重置序号”的既定结果，界面需要在开始新批次前清楚显示仍存在的失败批次信息。

## 11. 后台消息契约

新增消息：

```text
start_workflow
cancel_workflow
workflow_state
```

- `start_workflow` 不接受调用方提供的 URL、序号、Excel 行、账号、密码、验证码或选择器；所有绑定信息由控制器内部生成。
- `cancel_workflow` 只接受可选的当前 `batchId`。
- `workflow_state` 不接受业务参数。
- 出现额外字段时返回 `request_invalid`。

后台状态响应不包含页面 URL、账号、密码、密钥、手机号或验证码。

## 12. 错误码

至少覆盖：

- `workflow_running`
- `another_workflow_running`
- `mother_url_invalid`
- `mother_tab_missing`
- `mother_tab_incognito`
- `mother_tab_not_active`
- `selector_not_configured`
- `element_not_found`
- `element_ambiguous`
- `page_not_stable`
- `platform_option_missing`
- `group_options_missing`
- `authorization_url_missing`
- `authorization_url_ambiguous`
- `authorization_origin_mismatch`
- `excel_exhausted`
- `credentials_invalid`
- `native_host_unavailable`
- `incognito_access_required`
- `incognito_window_missing`
- `incognito_window_ambiguous`
- `target_host_permission_required`
- `login_rejected`
- `totp_stage_not_reached`
- 现有 TOTP Lab 固定错误码
- 现有 SMS Lab 固定错误码
- `accept_button_missing`
- `final_url_invalid`
- `mother_backfill_failed`
- `workflow_cancelled`
- `workflow_failed`

未知异常必须清洗为固定错误码，不能把页面 HTML、Native Host 原始异常、凭据或验证码直接返回给插件界面。

## 13. 测试设计

### 13.1 母页页面动作测试

覆盖：

- 唯一文本定位账号管理和添加账号；
- 账号名称格式和序号；
- 第二个平台选择；
- 只勾选分组容器内复选框；
- 下一步和生成链接；
- DOM URL 读取和来源校验；
- COPY URL 点击；
- 已完成状态下的幂等重试；
- 元素缺失、禁用和多重匹配。

### 13.2 登录和最终页面动作测试

覆盖：

- `#username`、`#password` 填写和事件触发；
- 页面未接收输入时失败；
- 提交按钮回退规则；
- 登录错误和 TOTP 阶段检测；
- 接受按钮精确选择器与唯一文本回退；
- 最终 URL 回填；
- 只有最终成功标志出现才提交。

### 13.3 工作流状态机测试

覆盖：

- 序号 1 映射物理行 2；
- 完整单轮成功；
- 多行连续成功；
- Excel 结束前不创建多余母页账号；
- 各阶段失败均不递增序号；
- 可恢复阶段只重试一次；
- 有副作用操作不重复；
- 成功关闭无痕窗口；
- 失败和取消保留无痕窗口；
- 辅助标签始终关闭；
- Alarm 驱动阶段恢复；
- Service Worker 在无痕窗口创建前后暂停时只接管同批次 handoff 窗口，不重复创建；
- 插件弹窗关闭不终止任务；
- 浏览器新批次从序号 1 开始。

### 13.4 Native Host 测试

覆盖：

- 从物理行读取 A/B 列；
- 拒绝表头行和布尔行号；
- 行不存在返回 `excel_exhausted`；
- 行存在但 A/B 无效返回 `credentials_invalid`；
- 不返回 C/D/E 列；
- 错误响应不包含账号或密码。

同时更新 TOTP Lab 的扩展和 Native Host 测试，确认所有 direct route 都拒绝物理行 1，并继续接受物理行 2 及以后。

### 13.5 回归、安全和打包验证

执行：

- Native Host 全量单元测试；
- Python 集成测试；
- Node 扩展全量测试；
- Manifest 和 JavaScript 语法检查；
- 扩展打包；
- `git diff --check`；
- 权限和敏感信息静态扫描。

静态扫描必须确认没有：

- `<all_urls>`；
- `clipboardRead`；
- `debugger`；
- 商业验证码或接码服务域名；
- 自动滑块或人机验证绕过逻辑；
- 把账号、密码、密钥、手机号或验证码写入日志和 Chrome Storage 的代码。

## 14. 插件界面和中文文档

现有 CC 下载批处理不被删除或替换。它继续使用原有 `start`、`state` 消息、`ccBatchState` 本地存储和 `downloads` 权限。插件弹窗改为两个明确分区：

1. “授权登录工作流”：使用新的 `start_workflow`、`cancel_workflow`、`workflow_state` 消息和 `chrome.storage.session` 状态；
2. “CC 下载批处理”：保留现有“开始整批任务”入口和原状态展示。

因此 `downloads` 权限继续保留，但只属于旧 CC 下载批处理，不属于新的授权登录工作流。两种批处理不能同时运行；任一控制器处于运行状态时，另一个开始按钮禁用并显示 `another_workflow_running`。

授权登录工作流分区增加：

- “开始执行任务”按钮；
- “停止任务”按钮；
- 当前批次状态；
- 当前序号；
- 当前 Excel 物理行；
- 当前阶段；
- 失败错误码和时间。

运行期间开始按钮禁用。任务进入 `COMPLETED`、`FAILED` 或 `CANCELLED` 后可以再次开始新批次。弹窗分别监听 `chrome.storage.session` 的工作流状态和 `chrome.storage.local` 的旧 CC 批处理状态，不迁移或复用 `ccBatchState`。

中文 README 补充：

- 母页地址要求；
- 授权固定域名替换位置；
- 母页和最终回填选择器配置；
- Chrome“允许在无痕模式下运行”的启用方法；
- 序号与 Excel 物理行映射；
- 成功与失败窗口清理规则；
- 错误码排查方法；
- 实际页面联调步骤。

## 15. 完成标准与已知联调边界

完成必须满足：

- 单击一次开始按钮可自动遍历 Excel 数据行；
- 每个随机授权链接严格绑定同序号的 Excel 数据；
- 母页在普通窗口中保持选中，辅助标签不会替换母页；
- 登录提交后不少于 30 秒才恢复检查，并在每个页面动作前等待页面稳定；
- TOTP 和短信模块使用同一物理 Excel 行；
- 最终母页确认成功前不递增序号；
- 成功关闭无痕窗口，失败保留无痕窗口；
- 所有自动化测试和既有回归测试通过；
- Manifest 保持精确权限范围。

实际母页 DOM 选择器、最终回填选择器和真实授权固定域名尚未由用户提供。本实现会使用已定义的配置入口和安全的本地测试域名占位；未替换必要配置时必须明确失败，不能通过模糊点击或扩大权限继续运行。完整控制逻辑可以通过测试夹具验证，真实页面端到端联调需要在这些配置填入后执行。
