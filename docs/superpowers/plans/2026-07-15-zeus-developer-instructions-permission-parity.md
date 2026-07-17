# Zeus developer 指令与 Codex App 权限生命周期对齐实施计划

> **执行约束：** 实施时使用 `superpowers:test-driven-development`，在当前工作区内逐步执行；未经用户明确要求，不派发 subagent，不执行 git commit、push、merge、revert 等历史或远端动作。

**Goal:** 删除 Zeus 线程级 developer 指令对可变权限状态的重复表达，让当前权限只由 Codex permission profile、sandbox 与 approval 维护，同时保留稳定的任务级限制。

**Architecture:** `thread/start.developerInstructions` 只承载线程生命周期内不变化的 Zeus 任务约束；`thread/start` 与每次 `turn/start` 继续从会话 `permissionMode` 映射结构化权限。Codex Core 负责根据前后 permission profile 生成模型可见的权限 developer 更新，与当前 Codex App `26.707.71524` / CLI `0.144.2` 保持相同的状态所有权和更新语义。

**Tech Stack:** TypeScript、Vitest、Codex app-server JSON-RPC、pnpm workspace。

---

## 状态与依据

- 阶段：VERIFIED；源码、TDD、独立 review、完整包测试、正式构建、macOS 打包、真实运行时与文档视觉复核均已通过。
- 主任务文档：`docs/TASK_20260715_006_Zeus高优先级developer指令注入机制.html`。
- 故障现场：`docs/TASK_20260715_005_Zeus完全访问仍残留只读developer指令故障排查.html`。
- Zeus 根因锚点：`packages/local-server/src/codexNativeConversationCoordinator.ts:477-520, 1802-1807, 1841-1852`。
- Codex 参照锚点：`.tmp/openai-codex-patch-verify/codex-rs/core/src/session/mod.rs:3232-3268` 与 `.tmp/openai-codex-patch-verify/codex-rs/core/src/context_manager/updates.rs:22-62, 240-267`。
- 运行现场：rollout `019f64b6-46a7-7f33-9626-be5b7f12b290` 同时存在 Zeus 旧只读 developer 文本和 Core 新 `danger-full-access / never` 权限更新。
- 基线测试：`pnpm exec vitest run packages/local-server/test/codex-native-conversation-coordinator.test.ts`，49/49 通过；现有测试尚未覆盖“developerInstructions 不得包含可变权限状态”。

## 已确认语义

### 稳定任务约束：继续放入 developerInstructions

- `allowTests === false`：保留“不得运行会修改项目状态的测试”。
- `allowGitCommit === false`：保留禁止 Git 历史修改的说明。
- 这些值在会话创建时随首个 submission 固化，现有会话不会因后续任务编辑而静默改变。

### 可变执行能力：不得放入 developerInstructions

- `permissionMode` 的 `read-only | auto | full-access` 文案。
- “仅允许在项目根目录内工作”这类会与 `full-access` 无沙箱语义冲突的文本限制。
- “允许运行项目验证”这类正向能力声明；允许做什么应由当前结构化权限决定。

### 权限唯一事实源

- `read-only`：read-only sandbox、`on-request`、user reviewer。
- `auto`：workspace-write sandbox、项目根 writable root、`on-request`、user reviewer。
- `full-access`：danger-full-access sandbox、`never`、user reviewer。
- Codex Core 根据 profile / approval 的变化生成新的权限 developer 更新，Zeus 不再维护第二份权限文案。

## 方案比较

1. **稳定说明与可变权限分离（采用）**：只修改 helper 与回归测试，不改变 JSON-RPC、数据库或线程生命周期；与 Codex App 的单一权限事实源一致。
2. **权限切换时重建或 fork thread（不采用）**：能绕过旧文字，但会改变 threadId、连续对话和恢复语义，不是 Codex App 的正常权限切换方式。
3. **每轮追加 Zeus 自定义“撤销旧权限”文字（不采用）**：继续制造第二个权限状态源，而且 `turn/start` 没有普通 developerInstructions 覆盖字段，仍会留下同角色冲突。

## 文件边界

- 修改：`packages/local-server/test/codex-native-conversation-coordinator.test.ts`
  - 新增 developerInstructions 权限生命周期回归测试。
  - 复用现有 FakeCodexManager，不新增测试基础设施。
- 修改：`packages/local-server/src/codexNativeConversationCoordinator.ts`
  - 收敛 `developerInstructionsFor`，只输出稳定的负向任务约束。
- 更新：`docs/TASK_20260715_006_Zeus高优先级developer指令注入机制.html`
  - 实施后补充实际 diff、验证证据、旧线程兼容边界和回滚结果。
- 不修改：`packages/ai-runtime/src/codexAppServerManager.ts`
  - 当前 `thread/start` / `turn/start` 的结构化权限字段已与 Codex App 对齐，不是根因。
- 不修改数据库、API、依赖、构建配置或锁文件。

### Task 1：先建立失败的回归测试

**Files:**

- Modify: `packages/local-server/test/codex-native-conversation-coordinator.test.ts`

- [x] **Step 1：新增“权限状态不进入线程 developerInstructions”测试**

在现有 `maps full-access to the Codex App danger-full-access profile...` 附近加入：

```ts
it('keeps mutable permission state out of thread developer instructions', async () => {
  const readOnlyFixture = await createFixture();
  await readOnlyFixture.coordinator.startTaskConversation(
    startInput(readOnlyFixture, { allowCodeChanges: false, permissionMode: 'read-only' }),
  );
  const fullAccessFixture = await createFixture();
  await fullAccessFixture.coordinator.startTaskConversation(
    startInput(fullAccessFixture, { permissionMode: 'full-access' }),
  );

  const readOnlyInstructions = readOnlyFixture.manager.threadStarts[0]?.developerInstructions;
  const fullAccessInstructions = fullAccessFixture.manager.threadStarts[0]?.developerInstructions;
  expect(readOnlyInstructions).toBe(fullAccessInstructions);
  for (const instructions of [readOnlyInstructions, fullAccessInstructions]) {
    expect(instructions).not.toMatch(/当前为(?:只读|自动|完全访问)模式/);
    expect(instructions).not.toContain('仅允许在项目根目录内工作');
    expect(instructions).not.toContain('允许运行项目验证');
    expect(instructions).toContain('不得执行 git commit');
  }
});
```

- [x] **Step 2：新增“稳定任务约束不随权限模式消失”测试**

```ts
it('keeps stable task restrictions independent of the permission profile', async () => {
  const fixture = await createFixture();
  await fixture.coordinator.startTaskConversation(
    startInput(fixture, { allowTests: false, allowGitCommit: false, permissionMode: 'full-access' }),
  );

  expect(fixture.manager.threadStarts[0]?.developerInstructions).toContain('不得运行会修改项目状态的测试。');
  expect(fixture.manager.threadStarts[0]?.developerInstructions).toContain('不得执行 git commit');
});
```

- [x] **Step 3：运行测试并确认红灯来自旧权限文案**

Run:

```bash
pnpm exec vitest run packages/local-server/test/codex-native-conversation-coordinator.test.ts -t 'developer instructions|stable task restrictions'
```

Expected: FAIL；第一项因只读/完全访问文字和不同项目根路径不相等而失败，第二项因 full-access 当前错误输出“允许运行项目验证”而失败。

### Task 2：实施最小单一事实源修复

**Files:**

- Modify: `packages/local-server/src/codexNativeConversationCoordinator.ts:1841-1852`

- [x] **Step 1：只保留稳定的负向任务约束**

将 helper 收敛为：

```ts
function developerInstructionsFor(context: ConversationDispatchContext): string {
  const instructions: string[] = [];
  if (!context.allowTests) instructions.push('不得运行会修改项目状态的测试。');
  if (!context.allowGitCommit) instructions.push('不得执行 git commit、push、merge、rebase、reset、revert、stash、checkout -b 或其他 Git 历史修改动作。');
  return instructions.join('\n');
}
```

- [x] **Step 2：运行新增测试并确认绿灯**

Run:

```bash
pnpm exec vitest run packages/local-server/test/codex-native-conversation-coordinator.test.ts -t 'developer instructions|stable task restrictions'
```

Expected: 2 tests passed。

- [x] **Step 3：运行完整 coordinator 测试文件**

Run:

```bash
pnpm exec vitest run packages/local-server/test/codex-native-conversation-coordinator.test.ts
```

Expected: 基线 49 项加参数化矩阵 4 项，共 53 项通过，0 项失败。

### Task 3：验证协议边界与反向搜索旧模式

**Files:**

- Verify: `packages/local-server/src/codexNativeConversationCoordinator.ts`
- Verify: `packages/ai-runtime/src/codexAppServerManager.ts`

- [x] **Step 1：确认旧权限文字已从运行源码消失**

Run:

```bash
rg -n '当前为只读模式|当前为自动模式|当前为完全访问模式|仅允许在项目根目录内工作|允许运行项目验证' packages/local-server/src/codexNativeConversationCoordinator.ts
```

Expected: 无输出，退出码 1。

- [x] **Step 2：确认稳定限制与结构化权限仍在**

Run:

```bash
rg -n '不得运行会修改项目状态的测试|不得执行 git commit|providerPermissionProfile|sandboxPolicy|approvalPolicy' packages/local-server/src/codexNativeConversationCoordinator.ts
```

Expected: 命中稳定任务限制、三种 profile 映射以及 `turn/start` 权限字段。

- [x] **Step 3：类型、lint 与包构建验证**

Run:

```bash
pnpm exec eslint packages/local-server/src/codexNativeConversationCoordinator.ts packages/local-server/test/codex-native-conversation-coordinator.test.ts
```

Expected: 退出码 0。

Run:

```bash
pnpm --filter @zeus/local-server build
```

Expected: TypeScript 编译退出码 0。

Run:

```bash
pnpm typecheck
```

Expected: workspace 类型检查退出码 0；若被工作区既有未提交改动阻塞，必须列出与本次两文件无关的实际错误，不能宣称本项通过。

### Task 4：真实运行时验收与文档收口

**Files:**

- Update: `docs/TASK_20260715_006_Zeus高优先级developer指令注入机制.html`

- [x] **Step 1：构建并打包正式 App**

Run:

```bash
pnpm build
```

Expected: 退出码 0。

Run:

```bash
pnpm package:mac
```

Expected: 生成 `dist/mac-arm64/Zeus.app`，退出码 0。

- [x] **Step 2：只用新建 thread 做真实权限切换验收**

1. 新建 `read-only` 会话并发送一轮。
2. 等待 turn 完成后切换为 `full-access`，在同一 thread 发送下一轮。
3. 检查新 rollout：Zeus app-level developer 内容不含项目根硬限制、权限模式或“允许运行”文案；Core 权限 developer 段先后反映真实 profile；后续 `turn_context` 为 `danger-full-access / never`。
4. 确认 threadId 未变化，证明没有通过重建 thread 掩盖问题。

- [x] **Step 3：回到原始需求逐项验收**

- 新 thread 不再残留 Zeus 静态只读 developer 文案。
- 三种模式仍分别映射到 Codex App 对应的 sandbox / approval。
- 权限切换不 fork、不重建、不丢历史。
- `allowTests=false` 与 `allowGitCommit=false` 的稳定任务限制仍存在。
- 没有修改数据库、API、依赖、锁文件或构建配置。

- [x] **Step 4：按规约完成 review 与 verification**

使用 `superpowers:requesting-code-review` 审查本计划、两文件 diff、红绿测试与运行时证据；reviewer 必须读取并遵守用户提供的 AGENTS 规约与根目录 `DESIGN.md`。随后使用 `superpowers:verification-before-completion` 重新执行关键验证，最后回写主任务文档。

## 兼容影响

- **新 thread：** 使用修复后的稳定 developerInstructions，权限切换与 Codex App 一致。
- **已经持久化的旧 thread：** rollout 中的历史 developer 消息不会被源码修改自动删除；继续使用旧 thread 仍可能看到原冲突。
- **旧 thread 处理原则：** 不自动改写 rollout、不静默 fork、不更换 threadId。用户需要从修复后的版本新建会话；这是避免伪造历史并保持 Codex 原生 thread 语义的最小兼容边界。
- **full-access 语义：** 删除“仅允许在项目根目录内工作”的模型文字后，full-access 才真正对应 Codex App 的无文件系统沙箱；read-only 与 auto 仍由结构化 sandbox 强制限制。

## 风险与回滚

- 风险：full-access 下模型可按当前无沙箱能力访问项目外路径；这是与 Codex App 对齐后的预期，而不是权限扩大漏洞。用户与项目规约的其他稳定边界仍然有效。
- 风险：旧会话不会自动治愈，必须在交付说明中明确“新建会话生效”。
- 回滚：仅恢复 `developerInstructionsFor` 与对应测试；无数据库迁移、API 变化或持久化数据回滚。
- 失败关闭：任何红绿测试、类型检查、正式构建或新 rollout 验收未通过，都不得声明完成。

## DEVELOP 执行记录（2026-07-15）

- TDD 红灯：新增的 2 项定向测试均按预期失败；失败分别命中旧 permission mode / 项目根文字，以及 full-access 下错误的“允许运行项目验证”正向声明。
- 最小修复：`packages/local-server/src/codexNativeConversationCoordinator.ts:1841-1846` 的 helper 现在只生成 `allowTests=false` 与 `allowGitCommit=false` 对应的稳定负向限制；结构化权限映射仍位于 `:1802-1807`，每轮传递仍位于 `:508-520`。
- 自动化验证：首轮新增定向测试 2/2；独立 review 后补齐三种 permission mode × 稳定开关矩阵，定向测试 4/4、coordinator 测试 53/53，`@zeus/local-server` 包测试 23 个文件、312/312 项通过；目标文件 ESLint / Prettier、workspace typecheck、包构建与全 workspace build 均退出 0。
- 正式打包：首次执行因旧 Zeus App 正在运行而失败关闭；正常退出旧进程后重试成功，产物为 `dist/mac-arm64/Zeus.app`，代码签名深度严格校验通过。
- 真实运行时：从新打包 App 创建会话 `conversation_7f8616505e5413c6e38e4094`，同一 provider thread `019f65de-5178-7501-a08d-9ba002b568c5` 先以 `read-only / on-request` 完成首轮，再切换为 `danger-full-access / never` 完成第二轮；threadId 未变化。
- rollout 证据：`/Users/david/.codex/sessions/2026/07/15/rollout-2026-07-15T21-01-36-019f65de-5178-7501-a08d-9ba002b568c5.jsonl:3,8,17,20`。两次 App developer 段都不含 Zeus 旧权限文案；两次 `turn_context` 分别记录切换前后的结构化权限。
- 审计对象：Zeus 项目 `project_bNc-FlR9MhtV`，任务 `task_-iV4q5EOaavo`（标题：`developer 权限生命周期真实验收 1784120495460`）。该任务保留供用户复核，没有静默删除。
- 独立 review：初审仅发现测试未覆盖 `auto` 与稳定开关允许态的 Minor；补齐 12 个运行组合并复验 4/4 后，reviewer 确认 Critical / Important / Minor 均为 0，Ready to merge: Yes。
- 文档视觉复核：单文件 HTML 在 1440、768、375 三档视口完成截图检查；375 视口曾发现 Grid 最小内容宽度导致横向溢出，修复后 CDP 实测 `clientWidth=375`、`scrollWidth=375`、overflow 节点为 0。
- 工作区边界：当前真实 Git root 为 `/Users/david/hypha/zeus`，分支 `main`；工作区原有大量未提交改动，本次只触碰计划列出的两个 TypeScript 文件与两份任务文档，不执行 commit、push 或其他 Git 历史动作。
