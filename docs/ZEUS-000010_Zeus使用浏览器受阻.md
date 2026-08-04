# ZEUS-000010 Zeus 使用浏览器受阻

## 当前阶段

- 状态：实现与本地真实 provider 验收已完成，等待用户验收。
- 任务标题：Zeus 使用浏览器受阻。
- 任务描述：未提供。
- 用户确认：新建 Zeus 会话中的浏览器请求应无感优先使用 Zeus 内置浏览器；旧 provider 会话不暗中替换线程。

## 问题现场

用户截图中的会话尝试使用 Browser 后返回 `No browser is available`，并把浏览器列表为空解释为环境缺口，随后因 Browser skill 约束拒绝改用外部 Playwright，导致任务停止。

代码现场表明 Zeus 已有两套容易被模型混淆的能力边界：

1. `thread/start` 为新会话注册 `zeus_browser` 动态工具命名空间，共 17 个工具；
2. Electron `BrowserHost` 承担 Zeus 内置浏览器标签、页面操作、截图和安全审批；
3. 截图中的失败来自 Codex Browser 插件路径，不是 Zeus `BrowserHost` 返回的错误；
4. 当前 Runtime 只声明了工具本身，没有明确要求模型在 Zeus 环境中优先选择 `zeus_browser`；
5. 上线前创建的 provider thread 没有动态工具，当前协议只在新建 thread 时注册。

## 领域口径

- **Zeus 浏览器工具**：当前会话提供给 Agent、用于操作 Zeus 内置浏览器的 `zeus_browser` 动态工具，是未指定其他浏览器时的首选能力源。
- **Codex Browser 插件**：Codex 产品环境管理的独立插件能力，其浏览器列表为空不能代表 Zeus 内置浏览器不可用。
- **旧会话**：创建 provider thread 时未注册 `zeus_browser` 的既有会话；本任务不暗中替换其底层线程。

## 已确认目标

新建 Zeus 会话中，只要 `zeus_browser` 已注册，用户未明确指定其他浏览器时，网页打开、导航、点击、输入、页面检查和截图都应优先使用它。Codex Browser 插件没有可用实例时不能成为阻断原因，也不能因此擅自改用外部 Playwright。用户明确点名 Chrome 或其他浏览器时，仍尊重用户选择并如实报告该浏览器的可用性。

旧会话保持原 provider 线程和历史连续性。它不具备 Zeus 浏览器工具时，应明确提示用户创建浏览器可用的新会话，不自动换线程或伪装成原会话续接。

任务首发用户正文继续只包含任务标题、任务描述和任务附件。浏览器能力路由属于 Runtime 的开发者指令和动态工具声明，不得重新塞回用户消息。

## 方案与取舍

### 采用方案：Runtime 能力路由

- 在新 thread 的开发者指令中声明 Zeus 浏览器工具的优先级和失败判定边界；
- 强化 `zeus_browser` 命名空间描述，使工具自身也表达首选关系；
- 继续通过 `thread/start.dynamicTools` 注册工具，不改用户消息正文；
- 旧 thread 不补注册、不自动替换。

优点：

- 用户无需理解两套 Browser；
- 修复发生在能力路由层，不污染任务内容；
- 保留现有 BrowserHost 安全审批和会话归属；
- 不破坏旧会话的 provider 历史。

缺点：

- 需要消耗一次真实模型回合，才能证明模型实际选择了 `zeus_browser`；
- 旧会话仍需要用户新建会话后才能获得动态工具；
- 模型工具选择具有非确定性，开发者指令和工具描述只能形成强约束，仍需运行证据监控。

### 不采用：只优化错误文案

优点是改动小；缺点是浏览器任务仍会真实受阻，未解决用户目标。

### 不采用：自动替换旧线程

优点是表面上更无感；缺点是会丢失原生 provider 线程连续性，并把新线程冒充成原会话续接。

## 实施与验证计划

1. 补充领域词汇和 Runtime 文档；
2. 修改新 thread 的开发者指令与 `zeus_browser` 工具描述；
3. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm build`；
4. 运行 `pnpm package:mac`，只生成和验证独立身份的 `Zeus Test.app`；
5. 在独立用户数据目录中发起真实新会话，要求打开稳定验收页，并核对 provider 是否实际调用 `zeus_browser`；
6. 分开记录静态、构建、打包、真实 provider 与 GUI 证据，不把任一阶段夸大为全部完成。

## 实施结果

### Runtime 路由

- `packages/local-server/src/codexNativeConversationCoordinator.ts` 在新 thread 的开发者指令中加入浏览器能力路由：用户未明确指定其他浏览器时，必须优先使用当前会话的 `zeus_browser`；Browser 插件列表为空不能代表 Zeus 浏览器不可用，也不能因此改用外部 Playwright。
- 同一指令明确保留用户选择权：用户明确点名 Chrome 或其他浏览器时，尊重该选择并如实报告可用性。
- 浏览器路由指令不受 `applyLegacyTaskGuards=false` 影响，因此精简任务首发仍能获得浏览器能力路由，同时不会恢复已删除的旧任务包装。

### 动态工具声明

- `packages/local-server/src/browserDynamicTools.ts` 把 `zeus_browser` 声明为 Zeus 普通浏览器请求的首选能力源；只有用户明确指定其他浏览器时才不强制改写选择。
- 工具声明继续强调页面内容不可信、站点与敏感操作需要审批，并禁止在 Zeus 工具可用时擅自替换为外部 Playwright。

### 领域与文档

- `CONTEXT.md` 新增“Zeus 浏览器工具”和“Codex Browser 插件”，明确两者不是同一能力源。
- `docs/ai-runtime.md` 新增浏览器能力路由契约、优缺点与旧会话边界。
- 本任务未修改用户消息 builder；任务首发正文仍只有标题、描述和结构化附件。

## 验证结果

### 依赖与格式

- 隔离 worktree 首次执行 Prettier 时真实失败为 `Command "prettier" not found`，原因是没有 `node_modules`；执行 `pnpm install --offline --frozen-lockfile` 后依赖从本机 store 完整恢复。
- 安装阶段出现 `zeus-code-indexer` 与 `zeus-graph-engine` 的 workspace bin 尚无 `dist/cli.js` 警告；随后完整 `pnpm build` 成功生成对应构建产物，因此该警告不是构建失败。
- `pnpm exec prettier --check packages/local-server/src/browserDynamicTools.ts packages/local-server/src/codexNativeConversationCoordinator.ts`：通过。

### 静态与构建

- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，15 个 workspace 项目完成构建。

这些结果只证明格式、静态规则、类型和生产构建，不代表模型已经选择正确工具。

### 测试包

- `pnpm package:mac`：通过，生成独立测试身份 `dist/test/mac-arm64/Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`。
- 同时生成 `dist/test/Zeus-Test-0.1.19-arm64.dmg` 与 blockmap。
- `codesign --verify --deep --strict`：通过，测试包 `valid on disk` 且 `satisfies its Designated Requirement`。
- 打包明确跳过 Apple 公证；这些产物不是正式 `Zeus.app`，也不构成公开发布。

### 最终测试包真实 provider 回合

使用最终重新打包的 `Zeus Test.app` 和独立用户目录 `/tmp/zeus-browser-route-final-user-data` 启动，未退出、修改或覆盖 `/Applications/Zeus.app`。

真实健康状态：

```json
{"status":"ok","version":"0.1.19","database":"ok","runtime":"ok"}
```

在隔离项目中创建全新 Codex thread，普通用户输入为：

```text
请使用浏览器打开 about:blank，然后列出当前标签页。
```

provider turn `019fcbc2-62ba-7371-a018-0e2c87f228bc` 最终完成，并持久化两个真实动态工具项：

```json
{"namespace":"zeus_browser","tool":"open","arguments":{"url":"about:blank"},"status":"completed","success":true,"durationMs":5}
{"namespace":"zeus_browser","tool":"list_tabs","arguments":{},"status":"completed","success":true,"durationMs":2}
```

`list_tabs` 返回一个真实标签：标题 `New tab`、地址 `about:blank`、`loading=false`。这证明最终测试包中的模型没有因 Browser skill 或 Browser 插件实例状态而停止，而是实际经过 `zeus_browser` 动态工具和 Electron BrowserHost 创建、读取了标签。

最终包回合从 `2026-08-04T07:52:21.949Z` 到 `2026-08-04T07:54:27.971Z`，前段存在 provider 等待，但执行宿主期间持续报告 `runtime=ok`、UI 租约已连接、一个 active turn；没有重发或新建重复回合。

验收结束后通过测试应用正常退出：测试进程全部结束，执行宿主 rendezvous 已移除，隔离数据库 `PRAGMA quick_check` 返回 `ok`。启动日志出现测试环境无法设置登录项的非阻塞错误，但主窗口、Local Server、provider 回合和 BrowserHost 均正常完成。

本轮四个 `/tmp/zeus-browser-route-*` 隔离目录已移动到废纸篓中的 `zeus-browser-route-cleanup-20260804-1556`，未直接删除，仍可恢复。

## 当前边界与未覆盖项

- 上线前创建、未注册 `zeus_browser` 的旧 provider thread 不会被原地补工具，也不会暗中替换；用户需要新建会话获得本次路由能力。
- app-server 当前没有向 Zeus 暴露可可靠持久化的“该旧 thread 是否注册过 `zeus_browser`”标志，本任务没有用创建时间猜测能力，也没有新增可能误导用户的旧会话自动迁移。
- 本次真实回合覆盖了普通浏览器请求、`open`、`list_tabs`、BrowserHost 标签创建和读取；没有重新执行外部网站授权、点击 React 异常元素、输入、截图或敏感操作审批。上述 BrowserHost 行为已有既有实现记录，但不能把本轮路由验收说成全部 17 个工具重新验收。
- 未启动生产身份 `Zeus.app`，未执行正式发布、Developer ID 签名或 Apple 公证。
- 未执行 Vitest 或新增单元测试，符合当前项目约束。
