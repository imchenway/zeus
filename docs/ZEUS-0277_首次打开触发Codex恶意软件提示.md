# ZEUS-0277 首次打开触发 Codex 恶意软件提示

## 现象

首次打开 Zeus 后，macOS 拦截 `codex-aarch64-apple-darwin`，并显示“已阻止恶意软件并移到废纸篓”。

## 结论

这不是 Zeus 应用窗口本身再次被 Gatekeeper 拦截，而是 Zeus 首次启动 Local Server 时仍然会在后台主动启动外部 Codex CLI。

ZEUS-0276 只取消了 Dashboard、设置页和 Runtime 普通状态刷新中的版本探针，没有取消 Local Server 创建时的 Codex 官方用量后台刷新。后者会立即调用 `ensureReady()`，最终真实执行 `codex app-server --listen stdio://`。

因此，上一次修复只封住了“界面读状态”这条启动链，漏掉了“后台刷新用量”这条启动链。

## 触发链路

1. Electron Main 首次打开时启动 Local Server。
2. `packages/local-server/src/index.ts` 创建 `refreshOfficialUsageInBackground()`。
3. Local Server 不等用户选择 Codex，立即执行一次该刷新，并每 60 秒安排后续刷新。
4. 刷新先调用 `codexAppServerManager.ensureReady()`。
5. `packages/ai-runtime/src/codexAppServerManager.ts` 通过 `spawn(command, ['app-server', '--listen', 'stdio://'])` 真实启动 Codex。
6. 默认命令是 `codex`。Finder 启动的环境通过 `expandCliSearchPath()` 补齐 PATH，并把 `/opt/homebrew/bin` 放在 `~/.local/bin` 之前。
7. 当原始 PATH 没有提前包含 `~/.local/bin` 时，系统选中 Homebrew Cask 的旧 Codex，macOS 在它被执行时弹出安全拦截。

## 当前机器的只读证据

2026-08-15 核对到：

```text
/opt/homebrew/bin/codex
  -> /opt/homebrew/Caskroom/codex/0.145.0/codex-aarch64-apple-darwin
```

该真实文件：

- 仍然存在 `com.apple.quarantine`，来源记录为 `Homebrew Cask`；
- `codesign --verify --strict` 通过，签名结构没有损坏；
- 截图中的文件名与该 Homebrew 目标一致。

同时本机还有另一份 `~/.local/bin/codex`，它指向 `0.147.0-aarch64-apple-darwin`，当前没有 `com.apple.quarantine`。这证明问题不是“本机完全没有可用 Codex”，而是 Zeus 在未经用户选择时启动了 PATH 中先命中的隔离候选。

macOS 的“包含恶意软件”文案是当次系统安全裁决；以上证据能确认触发对象、隔离属性和启动路径，但不应被扩大表述为已完成独立恶意代码分析。

## 为什么 ZEUS-0276 没有生效

ZEUS-0276 的文档已经明确写下“Zeus 不得在启动时探测外部工具”，但当时的生产调用点复核只搜索了 `checkAiCliAdapter`，没有把 `ensureReady()` 视为更强的“真实执行外部 CLI”。

文档契约正确，但实现复核范围不完整。这不是缓存未刷新，也不是新包没有生效。

## 正确修复边界

### 推荐：Codex 未经用户显式使用前，只读取持久缓存用量

- Local Server 创建时不调用 `ensureReady()`；
- 状态栏和用量界面先展示上次持久缓存，没有缓存时明确显示“未连接”；
- 只有用户明确选择 Codex 创建会话、登录、手动检查或启用远程接管后，才启动 Codex 世代并刷新官方用量；
- 不自动删除 `com.apple.quarantine`，不替用户绕过 macOS 安全策略。

优点：真正满足 ZEUS-0276 的隐私契约，首次打开不再擅自启动 Codex，也不会因为另一份 PATH 候选而换个文件继续擅自执行。

缺点：用户首次真正使用 Codex 之前，官方用量只能显示历史缓存或未连接，不能伪装成实时数据。

### 不推荐：只在 PATH 发现时跳过带隔离属性的候选

优点：可以避开当前 Homebrew 旧文件，并继续自动刷新用量。

缺点：仍然会在用户未选择 Codex 时扫描并执行另一份外部 CLI，违反 ZEUS-0276 已确认的隐私边界；而且隔离属性不是 macOS 拒绝执行的唯一原因，这只是绕过当前现象，不是闭合根因。

## 实现结果

- Local Server 的 Codex 官方用量定时刷新会先检查现有运行时状态；Codex 未运行时直接跳过，不再调用 `ensureReady()`。
- Codex 已经因为用户真实操作进入 `ready` 后，后台刷新仍会复用该运行时，不影响正常会话期间的官方用量更新。
- `/api/codex/usage-summary` 与 `/api/codex/usage-analytics` 不再为被动展示用量调用 `ensureReady()`；运行时未启动时，现有用量服务会返回持久缓存或明确的不可用状态。
- 保留用户此前明确启用的远程接管恢复，以及已有 Codex 会话和旧线程迁移恢复。这些入口都有持久化业务前提，不是全新首次启动的无条件探测。
- 不扫描或替换 PATH 中的 Codex 候选，不删除 `com.apple.quarantine`，不绕过 macOS 安全裁决。

## 启动入口复核

全新数据库下，启动阶段其余可能调用 `ensureReady()` 的入口均不满足触发条件：

- 远程接管恢复要求用户此前已启用 `codex.remote_control.enabled`；
- 旧线程迁移要求存在可验证的旧 Codex runtime 记录；
- 原生会话恢复要求存在已绑定 Codex 会话或可恢复的活动提交；
- 账户登录、模型能力、会话创建和远程接管接口由后续用户操作触发。

因此，本次修复关闭的是首次打开时唯一无条件执行 Codex 的生产入口，同时没有取消已有任务所需的恢复能力。

## 验证记录

- 根因已通过当前源码、ZEUS-0276 提交差异和本机文件属性闭合。
- 变更文件 Prettier 格式化通过，`git diff --check` 通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；Vite 只有大分块体积提示，没有构建错误。
- 使用新鲜临时数据库启动真实 Local Server，并注入“任何 Codex spawn 都立即计数失败”的运行管理器；启动完成后等待后台刷新，最终 `codexSpawnCount=0`。
- 在另一份新鲜数据库上真实请求用量摘要和用量分析接口，两个接口均返回 HTTP 200，且最终 `codexSpawnCount=0`。
- `pnpm package:mac` 通过，只生成测试身份 `dist/test/mac-arm64/Zeus Test.app` 与 `dist/test/Zeus-Test-0.3.11-arm64.dmg`。
- 测试 App 的 bundle ID 为 `dev.hypha.zeus.test`，`codesign --verify --deep --strict`、包结构健康检查和 `hdiutil verify` 均通过。
- 已从最终 `app.asar` 读取打包后的 Local Server 文件，确认首次启动状态门禁和被动用量缓存逻辑都进入实际测试制品。
- 测试包使用 ad-hoc 签名且明确未公证；本轮没有生成或启动生产身份 `Zeus.app`。
- 本轮没有启动 GUI。隔离 Local Server 运行探针直接覆盖了本次无条件 Codex spawn 根因，但不能夸大为真实窗口首次打开交互验收。
- 不新增或恢复单元测试、组件测试、DOM/CSS 契约测试。
- 未执行 git commit、push、merge 或其他远程写入。
