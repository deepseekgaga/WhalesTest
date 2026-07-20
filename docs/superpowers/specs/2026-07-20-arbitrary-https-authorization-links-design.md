# 任意 HTTPS 授权链接支持设计

## 背景

Whalestest 的母页固定为 `https://api.bridgefloods.com/admin/dashboard`。母页在“账号管理 → 添加账号”流程中动态生成授权链接；授权链接的路径和查询参数会变化，扩展不依赖或保存其具体域名配置。

现有实现把授权页面限制为 `http://auth-target.local`，并在 Manifest 中只授予该占位域名权限。这会阻止扩展在母页生成的真实 HTTPS 授权页面中继续执行登录、TOTP 和短信验证。

## 已确认需求

- 母页仍必须精确匹配 `https://api.bridgefloods.com/admin/dashboard`。
- 扩展从母页页面元素读取生成的完整授权链接，并原样交给受控无痕标签页导航。
- 接受任意具有有效主机名的 HTTPS 授权链接。
- 拒绝 HTTP、`file:`、`data:`、`javascript:` 等非 HTTPS 链接。
- 拒绝 URL 中包含 `username` 或 `password` 的链接。
- 不再配置或检查固定授权 origin。
- 扩展允许使用 `https://*/*` 主机权限，以便在授权页面及其 HTTPS 重定向页面中执行登录和 MFA 脚本。
- 授权链接不得写入扩展持久化状态、公开状态或日志。

## 方案选择

采用 Manifest 静态 HTTPS 通配权限：

```json
"host_permissions": [
  "https://*/*",
  "http://totp-lab.local/*",
  "http://sms-lab.local/*"
]
```

没有采用运行时可选权限，因为工作流启动后才生成授权链接，而 Chrome 的权限请求需要可靠的用户手势上下文；在长链路后台任务中请求会增加失败状态和人工中断。

没有采用 `<all_urls>`，因为本工作流不需要访问任意 HTTP 站点、本地文件或其他协议。`https://*/*` 是满足随机 HTTPS 授权页面自动化的最小静态通配范围。

## URL 验证规则

`validateAuthorizationUrl(value)` 只承担授权链接的结构与协议验证：

1. 输入必须是非空字符串。
2. 使用标准 `URL` 解析器解析。
3. `protocol` 必须精确等于 `https:`。
4. `hostname` 必须非空。
5. `username` 和 `password` 必须为空。
6. 路径、查询参数和片段不做业务限制，并保留解析后的完整 `href`。

验证失败统一映射为固定错误码 `authorization_url_invalid`，不得在公开错误或日志中包含原始 URL。

## 工作流变更

- 删除 `DEFAULT_TARGET_ORIGIN` 和 target-origin 标准化逻辑。
- `GENERATE_LINK` 阶段只验证母页返回值是安全的 HTTPS URL，不比较 origin。
- `OPEN_INCOGNITO` 阶段使用已经验证的完整 URL 导航。
- 后续登录、TOTP、短信验证和最终页面处理继续复用同一个受控无痕标签页。
- 页面发生 HTTPS 重定向时仍具有脚本注入权限；若降级到 HTTP，扩展不具备注入权限，工作流按现有固定权限错误失败。
- 授权 URL 仍仅存在于当前阶段的局部变量中，不加入持久化 workflow state。

## 兼容性与错误处理

- 母页、TOTP Lab 和 SMS Lab 的现有权限与流程不变。
- 原来的 `authorization_origin_mismatch` 不再用于授权 URL 校验；测试和文档改用 `authorization_url_invalid`。
- 其他 URL 校验（例如最终回填 URL）不在本次变更范围内。
- 无痕权限关闭、页面脚本注入失败、页面不稳定等错误继续使用现有错误码。

## 测试设计

先增加失败测试，再修改生产代码：

1. Manifest 精确包含 `https://*/*`，且不再包含 `auth-target.local`。
2. 接受来自不同 HTTPS 主机、不同路径、查询参数和片段的授权链接。
3. 拒绝 HTTP、`file:`、`data:`、`javascript:`、无效 URL 和带用户名或密码的 URL。
4. 工作流可以使用母页生成的任意 HTTPS origin 创建无痕窗口。
5. 公开状态、会话状态和错误信息仍不泄露授权 URL。
6. 完整扩展测试、Native Host 测试和安装验证继续通过。

## 文档与交付

- 中文 README 删除“替换 `auth-target.local`”步骤。
- 权限说明明确展示 `https://*/*` 的作用及风险边界。
- 后续打包产物必须重新生成，确保 Manifest 与源码一致。

