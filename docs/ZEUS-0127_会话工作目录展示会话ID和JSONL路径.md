# ZEUS-0127 会话工作目录展示会话 ID 和 JSONL 路径

## 任务目标

会话页已经在运行时摘要下方常驻展示当前目录和当前分支。本任务在同一区域继续展示原生会话 ID 与对应的 JSONL 文件路径，方便用户核对 Zeus 会话、Codex 原生线程和磁盘记录是否一致。

## 现状与根因

- 会话快照已经声明 `nativeSession.id / path`，数据库也已有 `provider_thread_path / native_session_path` 字段。
- Codex `thread/start`、`thread/resume` 和 `thread/read` 返回的线程对象包含 `id` 与可选 `path`。
- 当前 Codex 协调器只持久化线程 ID，没有把返回的 `path` 写入已有路径字段。因此前端即使增加文案，也只能看到 ID，无法可靠展示 JSONL 路径。
- 路径不能由 Renderer 根据日期和 ID 拼接：Codex 数据目录、日期目录和文件命名都可能变化，前端推导会制造错误事实。

## 领域与展示规则

1. 会话 ID 使用会话持久化的 `nativeSession.id`；Codex 会话当前映射到真实 provider thread ID，不使用 Zeus 自己的 conversation ID 冒充。
2. JSONL 文件路径只使用 Codex 线程响应中的真实 `path`，由 Local Server 持久化到 `provider_thread_path` 和 `native_session_path`。
3. 执行宿主恢复历史 Codex 会话时会调用 `thread/resume`，若返回真实路径则旁路回填，不修改会话业务更新时间和阶段更新时间。
4. Codex 没有返回路径时显示“不可用”，不扫描用户目录、不拼接候选路径，也不把缺失路径伪装成已确认文件。
5. 会话 ID 与 JSONL 路径和当前目录、当前分支位于同一运行时摘要；长值视觉省略，完整值保留在原生提示文本中。
6. 项目会话和任务会话使用同一规则；只读旧会话或尚未绑定原生线程的会话不展示伪造身份。

## 修改范围

- `packages/ai-runtime/src/codexAppServerManager.ts`：明确 Codex 线程快照的可选 `path` 字段。
- `packages/storage/src/index.ts`：增加只更新 provider/native 会话路径、不推进业务时间的精确持久化方法。
- `packages/local-server/src/codexNativeConversationCoordinator.ts`：在线程创建和宿主恢复时持久化 Codex 返回的真实 JSONL 路径。
- `apps/desktop/src/renderer/session/SessionWorkspace.tsx`：在当前目录区域增加会话 ID 和 JSONL 文件路径，并补齐中英文文案。
- `apps/desktop/src/renderer/session/session.css`：把现场信息统一为可省略的双列行，兼顾长路径和窄窗口。
- `apps/desktop/src/renderer/App.tsx`：会话快照刷新后同步更新列表项的原生会话身份。
- `DESIGN.md`：固化本任务的事实源、缺失降级和展示位置。

## 优缺点

优点：

- 用户无需打开数据库或搜索 `~/.codex/sessions`，即可直接核对会话身份和原始记录。
- 新会话创建时立即保存真实路径，历史会话在执行宿主恢复时自动补齐。
- 路径回填不改变会话业务更新时间，避免会话列表因技术元数据修复而错误排序。

代价：

- 路径是否可见依赖 Codex 当前协议返回；协议不返回或会话未落盘时只能显示“不可用”。
- 运行时摘要增加一行技术信息，小窗口中会出现省略，需要悬停查看完整值。

## 验证方式

- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- 使用隔离的本地运行环境打开已绑定 Codex 的会话，确认当前目录区域同时显示当前目录、当前分支、会话 ID 和 JSONL 文件路径。
- 核对页面显示的 ID 与 JSONL 文件名及首行 `session_meta` 身份一致。
- 检查窄窗口下无横向溢出，完整值可通过提示文本读取。

## 验证记录

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。首次执行因当前 worktree 缺少 `node_modules` 报 `tsc: command not found`；随后使用 `pnpm install --frozen-lockfile` 恢复锁定依赖，未修改锁文件，重跑通过。
- `pnpm build`：通过，桌面 Renderer、Preload、Main 与相关 packages 均成功构建。
- `pnpm package:mac`：通过，仅生成 `dist/test/mac-arm64/Zeus Test.app` 与 `Zeus-Test-0.2.12-arm64.dmg`；bundle ID 为 `dev.hypha.zeus.test`，`codesign --verify --deep --strict` 通过，未生成或启动生产身份 `Zeus.app`。
- 临时数据库集成核对：创建已绑定 provider thread 的会话后写入 JSONL 路径，确认 `providerThreadPath` 与 `nativeSessionPath` 同步为真实路径，且 `updatedAt`、`stageUpdatedAt` 均未变化。
- 构建产物核对：Renderer 产物包含“会话 ID”“JSONL 文件”、`nativeSession` 数据读取以及 `session-runtime-native-context` 双列结构。
- 本地 Vite 页面 `http://127.0.0.1:4179/` 返回 `200`，标题为 `Zeus`；验证结束后已停止服务。
- Zeus 内置浏览器的打开页面与读取标签两次调用都持续无返回，已中止挂起调用。遵循浏览器约束，本轮没有改用外部 Playwright，因此真实 DOM、截图、窄窗口和悬停提示仍待 Zeus 浏览器恢复后补验；不能把构建成功表述为这些视觉项已通过。
