# Zeus Codex Command Path Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 native 会话在缺省模型查询与 thread 启动时始终使用同一个已校验、随包分发的 Codex runtime identity。

**Architecture:** `createLocalServer()` 已把 `codexRuntimeCommandPath` 与 `codexExternalAgentHome` 固化为 native coordinator、legacy migration 和 import service 的 runtime 权威身份。本次只让 `resolveCodexModel()` 复用这两个值，不修改 manager 的运行期身份不可变约束，也不恢复旧 `runtimeSettings.adapterCliPaths.codex` 对 native app-server 的控制权。

**Tech Stack:** TypeScript、Fastify inject、Vitest、Electron macOS packaging。

## Global Constraints

- native app-server 只能使用 Electron Main 校验后的 pinned Codex `0.144.2` runtime。
- 不新增依赖、不修改 DB schema、不迁移用户配置、不改变 UI 结构。
- 保留 `ZEUS_CODEX_COMMAND_PATH_CHANGED` fail-closed 约束。
- 不执行 git commit、push、merge 或其他历史/远端动作。
- 源码修改后必须退出 Zeus、执行正式 `pnpm package:mac`、重启正式 App 并做真实 GUI 验收。

---

### Task 1: 统一新建 native 会话的 Codex runtime 路径

**Files:**
- Modify: `packages/local-server/src/index.ts:9059-9068`
- Test: `packages/local-server/test/codex-native-conversation-api.test.ts`
- Modify: `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`
- Modify: `docs/TASK_20260715_002_CodexManager命令路径漂移故障排查.html`

**Interfaces:**
- Consumes: `CreateLocalServerOptions.codexRuntimeCommandPath?: string`，已归一为局部常量 `codexRuntimeCommandPath: string`。
- Produces: `resolveCodexModel(project)` 的所有 `CodexAppServerManager.ensureReady()` 调用均使用 `codexRuntimeCommandPath`。

- [x] **Step 1: 写失败回归测试**

在 REST API 测试中用显式 bundled path 与 legacy import root 创建 local-server，保持 project/global model 与 CLI path 都为空，POST `mode=create`，断言所有 `manager.readinessInputs` 的 commandPath 与 externalAgentHome 均等于冻结值。

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts -t "uses the bundled native runtime identity while resolving the default model" --reporter=verbose
```

Expected: FAIL；现有实现记录到 `commandPath === "codex"`，证明测试命中现场路径漂移。

- [x] **Step 3: 最小实现**

把：

```ts
codexAppServerManager.ensureReady({ commandPath: runtimeSettings.adapterCliPaths.codex ?? 'codex' })
```

改为：

```ts
codexAppServerManager.ensureReady({ commandPath: codexRuntimeCommandPath, ...(codexExternalAgentHome ? { externalAgentHome: codexExternalAgentHome } : {}) })
```

- [x] **Step 4: 运行聚焦测试并确认 GREEN**

Run:

```bash
pnpm vitest run packages/local-server/test/codex-native-conversation-api.test.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts packages/ai-runtime/test/codex-app-server-manager.test.ts --reporter=basic
```

Expected: 三个文件全部通过，无 unhandled error。

- [x] **Step 5: 执行全仓静态与自动化门禁**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test
git diff --check
```

Expected: 全部 exit 0；任何失败必须回到根因而不是忽略。

- [x] **Step 6: 正式打包与真实应用验收**

优雅退出正在运行的 Zeus，执行：

```bash
pnpm build
pnpm package:mac
```

随后验证 codesign、bundle health、包内 runtime 版本，重启 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app`，在 `tc-app-core` 的新建会话页面发送一条消息，确认不再出现 `ZEUS_CODEX_COMMAND_PATH_CHANGED`，且 native thread/turn 开始。

- [x] **Step 7: 更新故障图与主任务验收记录**

把实现文件、RED/GREEN、全仓门禁、正式包与 GUI 证据写入两个任务文档；若 GUI 因锁屏或 provider 外部状态无法完成，只能标记部分验证。

## Self-review

- 需求覆盖：根因 R1、推荐方案 A、AC1-AC3、打包与真实 GUI 门禁均有对应步骤。
- 占位符检查：无 TBD/TODO/“稍后实现”等占位内容。
- 类型一致性：只复用已存在的 `codexRuntimeCommandPath: string`，不新增接口或测试专用生产代码。
