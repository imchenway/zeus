# Zeus 与 Codex App 会话运行时一致性设计

> 状态：PLAN / 设计已完成，尚未获准进入 develop。本文不代表源码、构建、依赖或用户数据已经修改。

## 1. 目标与结论

Zeus 的会话运行时和持久化语义与当前 Codex App 保持一致：Electron 只负责产品交互和 Zeus 业务映射；随应用分发的固定版本 Rust `codex app-server` 负责 thread / turn / item 生命周期、rollout、metadata、状态索引、导入账本和崩溃恢复。

旧 Zeus 会话不再在对话正文上方展示“新建 / 续接 / 引用”模式选择器。交互按 Codex App 分成三条明确路径：

1. 已有原生 `threadId`：打开会话后直接发送，使用 `thread/resume` + `turn/start`。
2. 新建会话：在新建入口输入并发送，使用 `thread/start` + `turn/start`。
3. 只有 legacy 消息、没有 `threadId`：在 onboarding 或设置中显式执行一次“导入旧 Zeus 聊天”；导入成功后获得新的原生 `threadId`，随后与普通会话完全相同。

不采用启动时自动迁移、第一次发送时懒迁移、`additionalContext` 重放历史、Zeus 手写 rollout JSONL 或依赖系统安装 Codex CLI。

## 2. 依据与版本边界

### 2.1 当前 Codex App 现场

- 安装包：`/Applications/Codex.app`，应用构建号 `5263`，包版本 `26.707.71524`。
- 内置二进制：`/Applications/Codex.app/Contents/Resources/codex`，`codex-cli 0.144.2`，arm64。
- App 启动的真实进程参数包含：`codex -c features.code_mode_host=true app-server --analytics-default-enabled`。
- App 自带二进制，不依赖 Homebrew 或用户 PATH 中的 `codex`。

### 2.2 0.144.2 协议证据

使用内置二进制执行：

```bash
/Applications/Codex.app/Contents/Resources/codex app-server generate-ts --out /tmp/codex-0.144.2-schema
```

生成的协议包含：

- 请求：`externalAgentConfig/detect`、`externalAgentConfig/import`、`externalAgentConfig/import/readHistories`；
- 通知：`externalAgentConfig/import/progress`、`externalAgentConfig/import/completed`；
- 会话输入：`SessionMigration = { path, cwd, title }`；
- 启动返回：`{ importId }`；
- 成功结果：会话项的 `target` 是新建的原生 `threadId`；
- 失败结果：包含 `errorType`、`failureStage`、`message`、`cwd` 和 `source`。

### 2.3 Codex App 可见行为

对当前 App bundle 的只读检查确认：

1. onboarding 与 Settings 提供独立的 “Import from other AI apps” 入口；
2. 用户显式选择 “Chat sessions”，说明为最近 30 天聊天；
3. App 调用 `externalAgentConfig/import`，取得 `importId`；
4. 选择会话导入时，App 等待匹配 `importId` 的 completed 通知，超时为 120 秒；
5. 成功后刷新 recent conversations；
6. 导入后的会话不再显示额外模式选择器，直接按普通原生 thread 打开和发送。

这证明导入不是启动时自动执行，也不是在旧会话首次发送时触发。

### 2.4 Rust 内部实现边界

OpenAI 官方 release `rust-v0.144.2` 已确认指向 commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`；GitHub annotated tag object 为 `06eee5f70addf0b8cf331d5c6721f0414e7d2ae6`。该 release 只在 `rust-v0.144.1` 基础上回滚 Guardian prompting 并把 workspace version 更新为 0.144.2，因此会话导入实现与本轮已核对的 0.144.1 records parser → synthetic turns / `ResponseItem` → `ThreadStore` → rollout / metadata / ledger 边界一致。develop 必须固定到该完整 commit，禁止跟随 floating branch。

## 3. Zeus 当前实现与缺口

### 3.1 已有能力

- `packages/ai-runtime/src/codexAppServerManager.ts:223-235` 已以 stdio 启动 `codex app-server`。
- `packages/ai-runtime/src/codexAppServerManager.ts:515-599` 已实现 `thread/start`、`thread/resume`、`thread/read` 和 `turn/start`。
- `packages/local-server/src/index.ts:1075-1085` 已建立 native coordinator，但命令仍来自设置或 PATH 中的 `codex`。
- 3 条已找到真实 provider `threadId` 的历史已能直接 resume；它们不进入本次 legacy import。

### 3.2 必须替换的偏差

- 当前没有 `externalAgentConfig/*` 的类型、请求、通知和 import lifecycle。
- 没有随 Zeus 包分发并固定版本的 Rust app-server。
- `apps/desktop/electron-builder.yml:7-10` 只包含桌面产物和 assets，没有 Rust binary resource。
- `scripts/package-mac.mjs:146-157` 只构建 Electron 和打包，没有 Rust 构建/获取、校验、按架构装配或 packaged health gate。
- 当前“引用旧会话”通过 `additionalContext` 把历史塞入新 turn；这不是 durable import，必须退出最终路径。
- 当前两个无 `threadId` 的失败历史只能只读，尚不能导入为原生 thread。

## 4. 目标架构

```text
Zeus Settings / onboarding
  -> externalAgentConfig/detect(source = zeus-legacy)
  -> 用户显式选择 Chat sessions
  -> externalAgentConfig/import(migrationItems = SESSIONS)
  -> importId
  -> progress / completed(importId)
  -> Rust importer + ThreadStore
  -> success.target = native threadId
  -> Zeus 验证 thread/read
  -> 写回 legacy source -> native threadId 映射
  -> 刷新普通会话列表
  -> 后续发送使用 thread/resume + turn/start
```

### 4.1 Electron / TypeScript 所有权

Zeus Electron 层只拥有：

- 设置和 onboarding 的导入入口；
- legacy eligibility 查询与计数；
- 创建不可变、可审计的导入源快照；
- 通过 app-server RPC 发起 detect/import 并展示进度、失败和重试；
- 把导入结果的 `target threadId` 映射回 Zeus project / task / conversation；
- 导入成功后刷新会话列表；
- 失败时保留 legacy 记录只读可见。

Electron 不解析/拼装 Codex rollout，不维护第二套 thread 状态机，不直接修改 `~/.codex/sessions`。

### 4.2 Rust app-server 所有权

Rust 边界统一拥有：

- legacy records 解析和合法性校验；
- synthetic turn / item 转换；
- 新 `ThreadId` 分配；
- ThreadStore 写入、metadata/state 更新和导入账本；
- import progress/completed 事件；
- 幂等、取消、失败阶段和崩溃恢复；
- 导入后的普通 `thread/read` / `thread/resume` 语义。

### 4.3 Zeus 私有导入源

不向用户真实 `~/.claude` 写文件。固定版本 app-server 只增加 `ZEUS_CODEX_EXTERNAL_AGENT_HOME` 绝对路径覆盖，把官方 external-agent session importer 的来源根指向 Zeus Application Support 私有目录；records/export、ThreadStore、ledger 和 `externalAgentConfig/*` 协议均保持上游实现，不新增 `thread/import`，也不维护第二套自定义 JSONL parser。

Zeus 在该私有根的 `projects/<private-project-key>/*.jsonl` 生成 Claude-compatible、不可变 source snapshot：首行为 `custom-title`，其后仅写官方 importer 能识别的 user/assistant record，包含 canonical cwd、原始时间和 message content。Zeus SQLite 另行持有稳定 `sourceConversationId`、project/task 映射、canonical source path、SHA-256 和导入状态；这些映射信息不伪装进外部会话格式。

TypeScript 边界先验证允许的项目根、普通文件、canonical path、内容 SHA-256 和 cwd；Rust 边界再次要求 canonical source 位于私有根 `projects` 下，并由官方 parser/ledger 完成格式解析、线程生成与幂等记录。相对的 root override 会被 patched app-server fail-closed 到无效目录，绝不回退到真实用户目录。

## 5. 用户交互

### 5.1 设置 / onboarding 导入

- 仅当 detect 返回 eligible legacy sessions 时显示“导入旧 Zeus 聊天”。
- 展示可导入聊天数量、最近范围和数据去向；默认不静默执行。
- 用户点击导入后显示真实进度；重复点击被禁用。
- 成功后显示导入数量并刷新会话列表；入口可保留为“再次导入”，由账本保证幂等。
- 部分或全部失败时保留失败项、原因和重试动作；不得把失败项从 legacy 列表隐藏。

### 5.2 会话页

- 新建入口只有 composer；首次发送创建 thread。
- 原生历史入口直接显示 transcript 和 composer；发送即 resume。
- 尚未导入的 legacy 记录保持只读，并把“导入”动作链接到设置，而不是在正文插入模式单选项。
- 删除现有“新建会话 / 续接此会话 / 引用旧会话”选择面板及其状态机。

### 5.3 可访问性

- 设置导入行使用真实 button、progress/status live region 和可见 focus；
- 状态不能只靠颜色表达；
- 错误与重试关联到具体 import；
- reduced-motion 下不使用位移/循环动画；
- 会话列表维持 `listbox/option/aria-selected` 契约。

## 6. 数据、幂等与一致性

### 6.1 映射事实

为每次 legacy import 保存稳定映射：

- source conversation id；
- snapshot canonical path；
- snapshot SHA-256；
- app-server import id；
- imported native thread id；
- status、failure stage/message、created/updated timestamps；
- pinned app-server version/build id。

`source path + SHA-256 + sourceConversationId` 构成幂等事实。相同内容重复导入必须返回或识别同一成功结果；内容变化形成新 snapshot，但不得无提示覆盖旧映射。

### 6.2 成功提交顺序

1. 生成 source snapshot；
2. 发起 import 并等待 matching completed；
3. 取得 success.target；
4. 使用 `thread/read(includeTurns=true)` 验证 thread 可发现且内容可读；
5. 在 Zeus 数据库事务中保存映射并创建/绑定 native conversation；
6. 只有上述步骤全部成功才归档 legacy 来源；
7. 刷新普通会话列表。

任何一步失败都不得删除 snapshot、归档来源或伪造 native conversation。

### 6.3 并发与崩溃恢复

- 同一 source hash 同时只能有一个 in-flight import；
- App 重启后先调用 `import/readHistories` 和本地映射表收敛未决状态；
- completed 先到、本地写回后失败时，以 import history 的 success.target 重新执行 `thread/read` 和幂等绑定；
- 超过 120 秒只把 UI 标记为等待超时，不推断 Rust import 已失败；恢复时再次查询 history。

## 7. 随包分发与版本策略

### 7.1 分发原则

- Zeus 自带固定版本 app-server binary，不读取 `/Applications/Codex.app` 内部资源，也不依赖 Homebrew/PATH。
- arm64 和 x64 分别构建或获取，并通过 checksum、`--version` 和协议 schema fingerprint 验证。
- Electron main 只执行 app bundle `Resources` 中的 binary；设置中的系统 `codex` 路径不再影响 native conversation runtime。
- 开发模式可显式使用仓库构建产物，但必须显示版本来源，禁止静默 fallback 到任意 PATH binary。

### 7.2 构建与许可

该方案新增 Rust toolchain、上游源码/patch 管理、双架构产物、Apache-2.0 notice 和签名范围，属于高风险构建变更。develop 前计划必须锁定：

- 上游 commit 与 Zeus patch series；
- reproducible build 或受校验的 release artifact 来源；
- Cargo lock 与供应链审计；
- binary license/NOTICE；
- Electron `extraResources` 路径；
- macOS codesign/notarization 顺序；
- app-server protocol compatibility matrix。

## 8. 错误与安全策略

- detect 失败：设置显示不可用及本机恢复动作，不把数量写成 0。
- snapshot 校验失败：标记具体 source，不调用 Rust import。
- import item 失败：保留 legacy，只记录脱敏 failure stage/message。
- success.target 缺失或非法：整体 fail-closed。
- `thread/read` 失败：不绑定、不归档，等待恢复/重试。
- provider version/schema 不匹配：native runtime 不启动，禁止 fallback 到系统 CLI。
- binary 缺失或 checksum 不符：显示 packaged-runtime integrity error。
- 日志不写 prompt 正文、token、完整路径外的敏感配置；导出诊断必须脱敏。

## 9. 验收标准

### 9.1 协议与 Rust

- detect 能列出 eligible Zeus legacy sessions，且只访问专用 source 目录；
- import 返回 `importId`，progress/completed 可按 id 关联；
- success.target 是可 `thread/read`、可 `thread/resume` 的原生 thread；
- 重复导入相同 source/hash 不创建重复 thread；
- parser/export/ThreadStore 失败均返回稳定 failure stage；
- crash 后能从 import history 和 ledger 恢复。

### 9.2 Zeus 数据与 API

- 3 条已有 native thread 不被重复导入；
- 2 条无 thread legacy 在显式导入前保持只读；
- 成功导入后各形成一条 native conversation 并保存 source mapping；
- 任何部分失败都不归档对应 legacy source；
- 新建会话首发使用 `thread/start`，原生历史发送使用 `thread/resume`；
- 最终路径不发送 legacy `additionalContext`。

### 9.3 UI

- 设置/onboarding 有唯一显式 import 入口；
- 会话正文没有新建/续接/引用模式按钮；
- 导入成功后刷新列表，打开后可直接继续发送；
- loading、empty、error、partial failure、timeout、retry、disabled、keyboard 和 reduced-motion 均有验证。

### 9.4 打包与现场

- arm64/x64 包都含正确 binary，且不依赖系统 Codex 或 Codex App；
- packaged health 验证 binary version、checksum、schema fingerprint、启动握手和 `externalAgentConfig/*` capability；
- `codesign --verify --deep --strict` 通过；
- 在真实数据库副本上完成导入、重启、resume、失败恢复和幂等验证；
- 最后用真实打包 App 完成设置导入与会话续接 GUI 验收。

## 10. 回滚

- 运行时 kill switch 禁止新的 legacy import，但不影响已导入原生 thread 的正常 resume。
- 回滚 Electron 入口和 Zeus provider patch 时保留映射、snapshot 与 ThreadStore 数据，不删除 rollout。
- 恢复被归档的 legacy source；已导入 native conversation 保留并标记来源，避免数据丢失。
- 若新 binary 不可用，回退到上一个 Zeus 自带的已签名版本；不回退到用户 PATH 中未知版本。
- 数据迁移前必须备份 Zeus 数据库与导入源目录；回滚不执行 destructive delete。

## 11. 方案比较与已采用决策

| 方案 | 与 Codex App 一致 | 结论 |
| --- | --- | --- |
| 设置/onboarding 显式 import + `externalAgentConfig/*` + ThreadStore | 是 | 采用 |
| Zeus 启动时自动迁移 | 否，缺少显式 import 交互 | 拒绝 |
| 旧会话第一次发送时懒迁移 | 否，Codex App 不这样触发 | 拒绝 |
| `additionalContext` 重放历史 | 否，不产生 durable imported thread | 拒绝 |
| Zeus 手写 rollout JSONL | 否，绕过 ThreadStore/ledger | 禁止 |
| 运行时调用系统 Codex CLI | 否，Codex App 自带固定 binary | 拒绝 |

## 12. Readiness Gate

已明确：目标、真实 Codex App 交互、协议输入输出、Zeus 当前链路、职责边界、数据映射、幂等、失败恢复、安全、构建影响、验收和回滚。

进入 develop 前仍需完成但不需要用户选择的内部工作：

1. 取回并校验 pinned OpenAI commit `a6645b6b8a656360fa16fb7e1c6721d0697d3d6a`，记录 Zeus patch 与上游差异；
2. 将本文转换为逐文件、逐测试的 TDD implementation plan；
3. 明确 Rust fork/patch 的仓库布局、双架构构建和 license artifact；
4. 记录当前 dirty worktree 的受影响文件边界，避免覆盖用户修改。

完成实现计划后，唯一需要用户确认的是是否进入 develop，因为这会新增 Rust 构建依赖、修改 app package 并执行可回滚的数据迁移实现。

实现计划已写入 `docs/superpowers/plans/2026-07-14-zeus-codex-app-legacy-import-parity.md`。

`READINESS: READY FOR DEVELOP CONFIRMATION; DEVELOP NOT AUTHORIZED`
