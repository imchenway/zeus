# TASK_20260827_003 Computer 与 Browser 工具运行时对齐修复

## 文档状态

- 任务类型：缺陷与运行时优化；
- 当前阶段：代码、隔离导入、Browser 运行时与 Test 包验证完成；Computer Use 真实窗口读取受 macOS 锁屏阻断；
- Git 边界：未经用户要求，不执行 commit、push、merge 或 revert。

## 用户反馈

Zeus 会话调用 Computer Use 失败，并在中断后缺少明确的完成表现。用户要求直接优化，同时检查 Browser Use
是否存在同类问题，且不要编写过度防御的代码。

## 现场根因

1. Zeus 使用独立 `CODEX_HOME`，配置导入会把来源目录中的所有路径机械改写到 Zeus 目录。
2. 导入范围没有包含 `computer-use/Codex Computer Use.app`，改写后的 `SKY_CUA_SERVICE_PATH` 和通知程序路径实际不存在。
3. Zeus 配置缺少 `NODE_REPL_TRUSTED_SERVICES`，因此 `@oai/sky` 无法连接受信服务。
4. Browser Use 同样受影响：来源配置中的 `browser-service.mjs` 路径被改写到 Zeus 插件缓存，但该缓存被统一排除；Zeus 现场的
   Browser/Chrome 缓存版本也落后于配置声明版本。
5. 配置中的 bundled marketplace 是来源侧生成目录，不属于 Zeus 运行必需文件；将其机械改写后反而会形成不存在的目录。

## 实施决策

1. 配置导入额外同步四个明确的工具运行时目录：
    - Computer Use 支撑 App；
    - Browser 插件缓存；
    - Chrome 插件缓存；
    - Computer Use 插件缓存。
2. 保持其他生成缓存继续排除，不复制整个插件市场或全部缓存。
3. 路径改写只作用于 `notify`、`CODEX_HOME`、`NODE_REPL_TRUSTED_CODE_PATHS`、`NODE_REPL_TRUSTED_SERVICES` 和
   `SKY_CUA_SERVICE_PATH`；不再改写 marketplace 来源和项目路径。
4. 沿用现有暂存、备份、原子替换和回滚流程，不另建兼容矩阵、后台守护或多层回退。
5. 会话列表把 `interrupted` 与用户主动暂停分开：中断使用警告圆形图标和“本轮已中断”标签；轮次耗时区分“处理中”“已处理”“处理已中断”和“处理失败”。

### 优缺点

- 优点：Computer Use 与 Browser/Chrome 使用同一次导入的匹配版本，目标路径真实存在；异常结束不再伪装成普通完成；改动集中在现有导入事务与既有状态投影内，没有新增常驻服务和复杂状态机。
- 缺点：工具运行时会让一次配置导入增加约百 MB 本地复制；后续 Codex 工具版本升级后仍需重新执行配置导入。这比自动跨目录借用来源缓存更可控。

## 验证口径

1. 在隔离目录执行真实配置导入，确认四个工具运行时目录进入目标目录。
2. 确认目标配置包含 `NODE_REPL_TRUSTED_SERVICES`，其中 Browser 服务路径和 Computer Use 支撑 App 路径均存在。
3. 确认 bundled marketplace 来源路径没有被错误改写。
4. 使用 Zeus 的原生 `node_repl` 通道分别验证 Browser runtime 初始化和 Computer Use 只读界面状态读取，不使用临时 MCP
   客户端冒充产品链路。
5. 构造完成、中断和失败轮次，确认耗时文案与侧边栏图标语义一致。
6. 执行 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 与 `git diff --check`。
7. 真实桌面验收只使用 `dev.hypha.zeus.test` 身份的 `Zeus Test.app` 和独立用户数据目录，不触碰正式
   `/Applications/Zeus.app`。

## 实施记录

- 2026-08-27：配置导入已纳入 Computer Use 支撑 App 与 Browser、Chrome、Computer Use 三个精确插件缓存目录；其他生成缓存仍保持排除。
- 2026-08-27：路径改写已收紧到五个运行时字段。隔离导入确认目标配置保留来源 bundled marketplace，
  `NODE_REPL_TRUSTED_SERVICES.browser`、`SKY_CUA_SERVICE_PATH` 和四个工具目录全部存在；复制后的 Computer Use App
  通过严格代码签名结构校验。
- 2026-08-27：使用隔离目标中的 Browser 客户端完成受信服务握手，默认选择内置浏览器，并成功创建和读取 `about:blank` 标签；因此
  Browser Use 的同源路径缺陷已修复并完成运行时验证。
- 2026-08-27：Computer Use 受信服务 `list_apps` 成功返回 39 个应用并识别 `Zeus Test`；进一步读取本任务 Test 窗口时，服务明确返回
  macOS 已锁定且无法自动解锁。本轮不把窗口树和点击记为通过。
- 2026-08-27：状态渲染探针确认运行、完成、中断和失败分别显示“处理中”“已处理”“处理已中断”和“处理失败”，中断侧边栏使用
  `is-interrupted` 与“本轮已中断”，不再复用暂停状态。
- 2026-08-27：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`git diff --check` 和最终 `pnpm package:mac` 通过；最终产物位于
  `/private/tmp/zeus-tool-runtime-final.M7IKMd`，仅包含 `dev.hypha.zeus.test` 身份的 `Zeus Test.app` 与测试 DMG。测试包为
  ad-hoc 签名且未公证，不是正式发布包。
