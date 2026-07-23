# TASK_20260722_001 Zeus 计划悬浮与 Codex 审批对齐

## 目标

- 将计划进度固定在输入框上方，鼠标悬停或键盘聚焦时向上展开完整步骤。
- 计划流式更新时不因消息分组重建而自动关闭。
- 文件审批按当前 Codex App 的交互呈现“拒绝 + 允许一次/允许所有编辑”分裂按钮。
- 将内置 Codex runtime 升级到 `rust-v0.145.0-alpha.30`，保留 Zeus 旧会话导入来源。

## 领域边界

- “允许一次”对应 app-server 文件审批决策 `accept`。
- “允许所有编辑”对应 `acceptForSession`；当前上游实现按本会话已审批文件记忆，新文件仍可能再次申请，不等于项目级永久授权。
- `grantRoot` 非空时继续拒绝所有文件允许决策；文件目标仍必须可审计、位于项目内且不能通过符号链接逃逸。
- “自动”模式是 `workspaceWrite + on-request`，普通项目内编辑通常不弹文件审批；高风险命令、网络或越界访问仍可能申请审批。

## 真实依据

- 用户提供的 Codex App 计划截图显示：紧凑状态条固定在输入框上方，完整计划在悬停时向上浮出。
- `rust-v0.145.0-alpha.30` 文件响应枚举仍为 `accept | acceptForSession | decline | cancel`。
- 上游 `ApprovedForSession` 以已审批文件集合为缓存边界，因此 UI 使用 Codex 文案，但在菜单内保留真实范围说明。
- 上游外部代理迁移服务已移动到 `codex-rs/external-agent-migration/src/service.rs`；Zeus 补丁必须同时覆盖 `new` 和
  `with_migration_source`。

## 修改记录

- 计划进度从 transcript 行中移到 workspace 与 composer 之间，避免活动分组 key 变化导致组件重挂载。
- 计划面板支持 hover、focus、click、Escape，浮层固定向上展开。
- 文件审批允许 canonical 请求推导 `acceptForSession`，Renderer 使用分裂按钮，local-server 保留目标与范围安全校验后透传。
- runtime 锁定更新为上游 tag object、commit、归档哈希和规范化 Cargo.lock 哈希；Zeus 补丁重放到新的迁移 crate。

## 验证

- 前端计划与审批聚焦测试。
- local-server coordinator 与 API 文件审批测试。
- runtime lock、补丁 dry-run、构建与版本探针。
- 全仓 lint、typecheck、format check、test、diff check。
- 重新打包并启动 `dist/mac-arm64/Zeus.app`，完成真实窗口交互与截图设计验收。

## 未验证项

- 在最终打包与真实窗口验收完成前，不声明视觉对齐或 runtime 运行闭环已经通过。
