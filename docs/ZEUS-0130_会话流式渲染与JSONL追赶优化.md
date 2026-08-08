# ZEUS-0130 会话流式渲染与 JSONL 追赶优化

## 任务信息

- 任务标题：看起来依旧卡的很
- 任务类型：优化
- 日期：2026-08-08

## 用户现场与目标

- JSONL 已经输出完整答案，Zeus 会话框仍长时间没有内容。
- 页面看起来像按字符逐个重排，长答案、表格和代码块尤其明显。
- 目标是让上游真实内容尽快被看见，同时避免用逐字符刷新拖垮服务端、WebSocket 和 Markdown 渲染器。
- 完成态必须使用完整累计文本，不得为了视觉效果伪造或重新排序 provider 内容。

## 调研结论

公开的 Codex app-server 协议把一个 item 建模为 `started -> 多个 delta -> completed`。客户端应把同一 item 的 delta 拼接为当前文本，reasoning summary 与最终 item 分开处理，完成事件作为权威收口。

官方 Codex 项目关于桌面 renderer 事件风暴的 issue 进一步给出了可执行边界：只合并同一 thread、turn、item 的相邻增量；在 item 完成或其他非 delta 事件前强制冲刷；身份变化时冲刷；慢速稀疏流不能被无限等待。这个实现方式比“把文字按固定速度打出来”更接近可观察的 Codex 交互行为。

没有把 Codex 桌面私有实现当作可复制源码，也没有复制其私有资源。仓库内只采用公开协议可以证明的事件生命周期和合并边界。

## 根因判断

问题不是单纯的 CSS 动效。

1. provider 的 `item/agentMessage/delta` 和 `item/plan/delta` 会按很小的片段进入协调器。
2. 协调器原来对每个可读文本增量都做一次 item 数据库追加、读取和广播，并在同一条 provider 事件链上串行执行。
3. Local Server 原来把每个 `conversation.item.updated` 立即转成 WebSocket 事件。
4. Renderer 原来每收到一次 delta 都更新会话状态，并可能重新解析整段增长中的 Markdown；历史 item 也会跟着父列表重渲染。

因此即使 JSONL 文件已经有答案，服务端事件链和 Renderer 仍可能在追赶旧的字符级任务。

## 已实施方案

### 1. Provider 事件链合并

文件：`packages/local-server/src/codexNativeConversationCoordinator.ts`

- 仅对同一 `generation/thread/turn/item/method` 的可读文本 delta 建立 40ms 合并窗口。
- 合并时只把原始 delta 拼成一次内容更新；数据库 item 只做一次追加和读取。
- 合并后的累计状态使用最后一个 provider 事件的身份、序号和时间。
- 所有原始 provider 事件仍逐条写入 receipt，重连去重事实不被合并破坏。
- 遇到完成、请求、turn 等非文本增量时，先冲刷待处理批次，再处理边界事件。
- handoff 和最终关闭前冲刷定时器，避免尾部事件停留在内存中。

优点：直接减少最重的数据库 item 更新和协调器串行积压。

代价：正常流式文本最多增加约 40ms 的展示等待；如果 provider 事件本身是无效或缺少 item 身份，则不合并并保持原有处理路径。

### 2. Local Server WebSocket 合并

文件：`packages/local-server/src/index.ts`

- 对映射为 `conversation.item.delta` 的同一会话项只保留最新累计 payload。
- 使用 Map 的“删除后再写入”维持跨 item 的最后到达顺序，避免省略中间序号后发生旧序号覆盖。
- item completed、turn 边界、请求和其他非 delta 事件会先冲刷待发事件。
- Local Server 关闭前强制冲刷。

优点：减少服务端到 Renderer 的 WebSocket 消息和 JSON 解析次数。

代价：事件 id 在 flush 时生成，且没有为被合并的中间 delta 建立新的 replay 记录；客户端恢复仍以权威 snapshot 和 provider receipt 为准，而不是依赖 WebSocket 事件重放。

### 3. Renderer 合并与历史 item memo 化

文件：`apps/desktop/src/renderer/session/useSessionController.ts`、`apps/desktop/src/renderer/session/ThreadItemView.tsx`

- Renderer 再加一层 40ms 安全合并，防止其他事件来源或突发回放绕过 Local Server 合并。
- 同一 item 只保留最新累计 delta；完成态、请求态和 turn 边界先冲刷，再立即交给 reducer。
- 重连、定向 hydration 和销毁时处理待发队列，不把已收到内容静默丢掉。
- `ThreadItemView` 使用 memo，未变化的历史 item 不再随当前活动 item 的更新重复执行组件函数。

优点：即使服务端暂时仍有事件突发，React 更新频率也有明确上限；历史长会话的无效计算减少。

代价：短窗口内的增量不会逐字符显示；这正是本任务要消除的视觉卡顿，不改变最终文本。

### 4. Markdown 块级呈现与结构化骨架

文件：`apps/desktop/src/renderer/session/ThreadItemView.tsx`、`apps/desktop/src/renderer/session/session.css`

- 流式 Markdown 按空行、已闭合代码围栏等块边界拆分。
- 已经稳定的块保持独立组件和稳定 key，后续 delta 不重复解析历史块。
- 未闭合表格和代码块先显示轻量骨架，待结构闭合或 item 完成后一次性用完整 Markdown 呈现。
- 普通自然语言仍沿用已有的语义自适应追赶和未闭合链接保护。
- 系统减少动态效果时关闭骨架动画和块位移动效，但不关闭内容合并。

优点：表格、代码块不会随着每个字符反复重排；用户能立即看到“正在整理结构化内容”的明确反馈。

代价：结构尚未闭合时暂不展示不完整表格或代码块，避免先显示错误的列、边框和代码语义。

## 验收与边界

已完成验证：

- `pnpm install --frozen-lockfile`：通过；该 worktree 原先没有依赖，安装仅按锁文件恢复依赖。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm build`：通过，工作区包和桌面 Renderer 均完成构建。
- `pnpm package:mac`：通过，生成 `dist/test/mac-arm64/Zeus Test.app`、测试 DMG 和 blockmap。
- 测试包身份：`CFBundleIdentifier=dev.hypha.zeus.test`；`codesign --verify --deep --strict` 和 `hdiutil verify` 均通过。
- `node scripts/verify-packaged-app-health.mjs 'dist/test/mac-arm64/Zeus Test.app'`：通过，Renderer 34 个资源，Main、Preload、Browser Page Preload 和 Codex 入口齐全。
- 独立启动探针：通过。清除继承的 `ELECTRON_RUN_AS_NODE=1` 后，以独立 `ZEUS_USER_DATA_DIR` 启动测试包约 8 秒，日志确认 Main Window 创建；随后只结束本次探针进程。
- `git diff --check`：通过。

尚未宣称完成的验证：

- 尚未在 `Zeus Test.app` 中做真实 JSONL 长答案、表格和代码块往返。
- 尚未用真实模型测量 JSONL 时间戳到会话 DOM 的延迟。
- 尚未生成或启动生产身份 `Zeus.app`。

下一步真实验收必须使用独立用户数据目录和 bundle id 为 `dev.hypha.zeus.test` 的 `Zeus Test.app`，重点观察：

1. JSONL 已有完整答案时，会话是否在可感知时间内出现完整或批量内容。
2. 普通文本是否不再按字符增长。
3. 表格和代码块是否先有骨架、闭合后一次成块。
4. 完成事件是否始终覆盖最后的流式投影，且复制内容仍为完整正文。
5. 计划模式、请求卡和重连恢复是否仍遵循原有生命周期语义。

本任务没有新增或恢复单元测试体系，符合项目当前验证约束。
