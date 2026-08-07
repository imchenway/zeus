# Zeus 新会话 Codex 登录门禁

## 问题现象

用户在“推送到新会话”确认后进入会话页，首轮没有产生智能体回复，页面直接显示“本轮失败”。

对应会话文件为：

`/Users/david/.zeus/agent-runtimes/codex/sessions/2026/08/06/rollout-2026-08-06T18-30-55-019fd6a0-45f3-7480-9163-c97358352f62.jsonl`

## 真实证据

- 会话文件记录的运行内核是 Codex，模型供应源是 OpenAI，实际模型为 `gpt-5.6-sol`，不是 DeepSeek。
- 工作目录、项目 `AGENTS.md` 和运行权限已经进入会话上下文，说明项目现场加载不是本次失败原因。
- 首轮已取得真实执行轮次 ID `019fd6a0-4789-7e91-8084-65e033365de7`。
- OpenAI 请求返回 `401 Unauthorized: Missing bearer or basic authentication in header`。
- 使用 Zeus 专属 `CODEX_HOME=/Users/david/.zeus/agent-runtimes/codex` 执行 `codex login status`，结果为 `Not logged in`。

因此，本次不是“会话文件损坏”或“会话没有创建”，而是“真实会话与首轮已经建立，首轮因 Zeus 专属 Codex 未登录而失败”。

## 已确认产品边界

1. 保留现有账号隔离：Zeus 专属 Codex 登录不自动复制或复用 Codex App 登录。
2. 选择需要 OpenAI 认证的 Codex 模型时，创建前必须检查账号状态；未登录时不得创建必然失败的会话。
3. 未登录时在当前推送弹窗内启动 Codex App Server 官方 ChatGPT 浏览器登录，登录完成后保留用户已经选择的模型、工作区、权限和补充信息，并自动继续原创建流程。
4. 登录可能在预检后失效。真实执行轮次已经存在时，失败会话继续保留并允许登录后重试；没有真实执行轮次时，不进入会话列表。
5. Pi 与自定义模型连接继续使用各自凭据边界；Codex 登录门禁不能阻断已就绪的 Pi 模型。

## 方案优缺点

### 优点

- 用户在创建前就能看懂账号是否可用，不再进入一条注定失败的会话。
- 登录由 Codex App Server 管理，Zeus 不读取、复制或记录明文凭据。
- 登录成功后继续原操作，避免用户退出弹窗、进入设置再重新填写。
- 真实失败轮次继续保留，用户输入、错误证据和恢复路径不会丢失。

### 代价

- 推送弹窗需要新增登录中、登录完成、取消、超时和失败状态。
- 本机浏览器登录完成前，创建动作必须保持等待，且不能重复发起登录或创建。
- 账号状态属于运行内核实时事实，不能只靠 Renderer 本地缓存；服务端仍需在真正创建前复验。

## 实现设计

1. `CodexAppServerManager` 接入官方 `account/read`、`account/login/start` 与 `account/login/cancel`。
2. 会话能力接口返回当前 Codex 账号是否需要登录、是否已就绪和当前认证方式，不返回凭据正文。
3. 本机 API 提供读取账号、启动 ChatGPT 登录和取消登录的受控入口；登录地址仍由 Electron Main 复验 HTTPS 后交给系统浏览器。
4. 推送弹窗只在当前选择的是 Codex 模型且账号未就绪时显示登录门禁；选择已就绪 Pi 模型时不受影响。
5. 服务端在创建任何 Codex 产品会话前再次读取账号状态，未就绪时返回稳定的 `ZEUS_CODEX_LOGIN_REQUIRED`
   ，并且发生在创建产品会话、任务工作区和首轮提交之前。
6. 登录完成后重新读取权威账号状态，再自动执行原推送请求；登录取消或失败时保留弹窗和用户填写内容。

## 验收口径

- 未登录且选择 Codex 模型时，弹窗明确显示 Zeus 专属 Codex 未登录，主操作为“登录并继续”。
- 点击后打开真实 ChatGPT 登录页；取消、关闭或登录失败不创建会话和任务工作区。
- 登录完成后自动继续创建，首条消息进入真实执行轮次。
- 未登录但选择已就绪 Pi 模型时，可以正常创建，不被 Codex 门禁误伤。
- 绕过界面直接调用创建接口时，服务端仍拒绝未登录 Codex 创建，并返回稳定错误。
- 登录在首轮建立后失效时，真实失败会话保留，用户可登录后在原会话重试。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 分阶段通过；最终只能启动独立身份的 `Zeus Test.app`
  做真实交互验收。

## 当前状态

- 已完成截图、正式数据库、会话 JSONL、Zeus 专属 Codex 登录状态与官方 App Server 账号协议取证。
- 已完成产品边界确认。
- 已接入 `account/read`、ChatGPT 浏览器登录启动与取消，并对返回账号状态和 HTTPS 登录地址做结构校验。
- 推送弹窗已增加“登录并继续”、等待登录、取消、超时和失败恢复状态；登录成功后使用提交前保存的原配置自动继续。
- 服务端已在任务工作区、产品会话和真实首轮创建前强制刷新账号状态；未登录返回 `ZEUS_CODEX_LOGIN_REQUIRED`，Pi 模型不经过该门禁。
- 已使用 Zeus 隔离 `CODEX_HOME` 真实验证：账号读取结果为 `requiresOpenaiAuth=true`、`signedIn=false`；浏览器登录能够取得
  HTTPS 地址并成功取消，未改写登录状态。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 已通过。
- 测试包为 `dist/test/mac-arm64/Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`，`codesign --verify --deep --strict`
  已通过。
- GUI 目视验收尚未完成：执行时 macOS 处于锁屏状态，自动化没有启动或操作测试包；不能把包体与构建通过表述为真实界面通过。
