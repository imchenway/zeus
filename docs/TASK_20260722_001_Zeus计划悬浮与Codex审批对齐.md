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

- 本次启动返修只重新验证应用启动与基础主窗口；未逐项重做计划悬浮和文件审批交互验收，不把本轮启动成功扩大成上述交互已重新验收。

## 2026-07-23 启动失败返修

### 现场结论

- 用户打开 `dist/mac-arm64/Zeus.app` 后只看到“Zeus 无法启动，请重新打开应用”。该文案来自 Main 进程的不可恢复启动失败兜底，不是 macOS Gatekeeper 提示。
- 应用包架构为 arm64，和当前机器一致；`codesign --verify --deep --strict` 通过。直接根因是包内 runtime 已为 `0.145.0-alpha.30 / 3b61fac...`，但启动校验仍硬编码要求 `0.144.2 / a6645b6...`，因此抛出 `ZEUS_CODEX_RUNTIME_VERSION_MISMATCH` 后主动退出。

### 修复边界

- 保留 fail-closed 启动完整性校验，不通过关闭 Codex Native 或跳过版本校验来掩盖问题。
- 以 `third_party/openai-codex/runtime.lock.json` 作为版本、commit、架构和补丁清单的唯一版本事实；打包时将该 lock 随 runtime 一起封入应用包。
- 旧会话导入产生的 provider 版本元数据改用当前已校验 runtime 的真实版本，不再写死 `0.144.2`。
- 包内健康检查必须覆盖 runtime lock、manifest、二进制 SHA-256 与可执行权限，使版本漂移在打包阶段失败，而不是等用户启动后才暴露。

### 验证状态

- `pnpm lint`：exit 0。
- `pnpm typecheck`：exit 0。
- `pnpm build`：exit 0；现有 Renderer chunk size 提示仍为非阻断 warning。
- `pnpm package:mac`：exit 0；重新生成 `dist/mac-arm64/Zeus.app`、DMG 与 ZIP，应用包通过 ad-hoc `codesign --verify --deep --strict`。本结果不等同于 Developer ID 签名或 notarization 完成。
- `node scripts/verify-packaged-app-health.mjs dist/mac-arm64/Zeus.app`：通过，输出 `codex=0.145.0-alpha.30;arch=aarch64-apple-darwin`。
- 包内 `codex --version`：`codex-cli 0.145.0-alpha.30`；二进制 SHA-256 与 manifest 的 `784c251f...6084` 一致。
- 真实启动：从 `/Users/david/hypha/zeus/dist/mac-arm64/Zeus.app` 拉起 PID `24312`；可访问性树确认标题为“Zeus”的标准窗口已加载包内 `app.asar/dist/renderer/index.html`，项目导航、会话列表和输入框均出现，原通用启动失败弹窗未复现。
