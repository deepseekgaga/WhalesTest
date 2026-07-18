# 授权滑块靶场测试钩子运行器设计

## 1. 目标

为完全授权的本地滑块 CAPTCHA 靶场提供一个可直接运行的 Python/Playwright 测试脚本，用于触发靶场显式提供的实验测试钩子，并验证滑块通过后的页面流程。

该运行器不生成、学习或回放真人化拖动轨迹，不识别滑块缺口，不计算拖动距离，也不包含针对商业验证码或反自动化检测的规避逻辑。

## 2. 固定安全边界

- 只允许 `http://test-target.local`，拒绝 HTTPS、其他主机、IP 地址、用户信息和非默认端口。
- 测试钩子固定为同源路径 `/__lab__/slider/approve`。
- 测试令牌只从环境变量 `SLIDER_LAB_TEST_TOKEN` 读取，不接受命令行明文令牌。
- 测试钩子调用使用页面同源 `fetch` 和当前浏览器会话 Cookie。
- 不记录令牌、Cookie、账号、密码或验证码。
- 脚本顶部保留声明：`仅供授权测试与学术研究使用，禁止用于任何未授权系统`。
- 最多尝试 3 次；失败时保存页面截图和非敏感错误码。

## 3. 方案选择

采用“同源服务器测试钩子”方案：Playwright 打开授权页面后，调用靶场测试模式下才存在的 `/__lab__/slider/approve`。Flask 端验证实验令牌后，在当前会话中写入 `slider_verified=true`。脚本随后刷新页面并检测 `.captcha-success` 或滑块按钮消失。

未采用以下方案：

- 浏览器全局 JavaScript 钩子：容易被普通页面脚本误用，服务端会话状态也不一定同步。
- 直接修改 Cookie 或本地存储：与真实服务器校验流程脱节，不能验证验证码通过后的会话边界。
- 真人化鼠标轨迹：属于人机验证规避，不在本项目范围内。

## 4. 文件与接口

新增：

- `tools/authorized_slider_lab.py`：命令行入口和 Playwright 流程。
- `tests/test_authorized_slider_lab.py`：目标 URL、配置、重试、成功检测和截图命名测试。

运行器公开以下可测试单元：

- `validate_target(url)`：验证固定域名、协议、端口和 URL 凭据。
- `RunnerConfig`：保存 URL、成功选择器、滑块选择器、尝试次数和截图目录。
- `SliderLabRunner.run()`：启动浏览器并运行最多三次测试。
- `SliderLabRunner.run_page(page)`：使用已创建页面运行测试，便于单元测试注入假的页面对象。

默认配置：

- URL：`http://test-target.local/slider-captcha`
- 成功选择器：`.captcha-success`
- 滑块选择器：`#slider-handle`
- 最大尝试次数：3
- 页面等待：`networkidle`
- 成功元素等待：5 秒
- 截图目录：`artifacts/slider-lab`

## 5. 数据流

1. 解析命令行参数并验证 URL。
2. 从 `SLIDER_LAB_TEST_TOKEN` 读取非空测试令牌。
3. 启动 Chromium 并打开授权页面。
4. 通过页面同源 `fetch` 调用测试钩子，只把令牌放入 `X-Lab-Test-Token` 请求头。
5. 钩子成功后刷新页面。
6. 优先检查 `.captcha-success` 是否可见；也允许 `#slider-handle` 已从页面消失作为成功结果。
7. 失败时记录固定错误码并截图；未达到三次上限时重新加载后重试。
8. 始终关闭浏览器上下文和浏览器。

## 6. 错误处理

固定错误类别包括：

- `target_not_allowed`
- `test_token_missing`
- `test_hook_rejected`
- `success_state_missing`
- `playwright_not_installed`
- `browser_error`

输出中不包含测试令牌或服务器响应正文。截图文件名只包含尝试序号和 UTC 时间戳。

## 7. Flask 靶场契约

Flask 测试接口必须满足：

- 只有 `SLIDER_LAB_TEST_MODE=true` 时注册或响应。
- 令牌来自服务器环境变量，并使用常量时间比较。
- 非测试模式返回 404，错误令牌返回 403。
- 只修改当前实验会话的验证状态。
- 不接受客户端提供的“通过分数”、位移或轨迹。

Flask 示例只写入中文文档，不作为扩展或 Native Host 的生产依赖。

## 8. 测试与验收

测试必须覆盖：

- 只接受精确授权域名。
- 拒绝其他域名、HTTPS、显式端口、URL 凭据和伪造子域名。
- 缺少令牌时不启动浏览器。
- 钩子成功且成功元素可见时立即结束。
- 成功元素不存在但滑块消失时视为成功。
- 钩子拒绝、页面未出现成功状态时重试，最多三次。
- 每次失败保存截图，截图不包含令牌。
- Playwright 未安装时给出明确安装命令。

验收命令：

```powershell
python -m unittest tests.test_authorized_slider_lab -v
python -m unittest discover -s tests -v
python tools/authorized_slider_lab.py --help
git diff --check
```

真实 Chrome/Flask 联调需要用户在本地靶场启用测试模式并设置同一个实验令牌；自动测试不访问网络。
