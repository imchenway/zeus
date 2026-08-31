# ZEUS-0400 新任务推送 Plugin Skill 失败

## 现象

- 任务「数字员工配置及交互方式」从任务详情页发起新任务推送后，停留在待开始状态，页面仅显示“当前操作未完成，请稍后重试”。
- 对应命令在 Provider 写入前失败，没有创建残留会话或工作区，可安全修复后重试。

## 现场证据

- 失败命令：`conversation.task.create`。
- 最终结果：`failed_before_write`，`provider_write_started_at` 为空。
- 原始错误：`ZEUS_SKILL_INPUT_INVALID`，提示“Skill ID 无效，请重新选择”。
- 统一 Skill 目录会返回 Plugin Skill，其稳定 ID 形如 `plugin:<plugin-id>:skill:<skill-id>`；当前项目目录中可见的 6 个 Ponytail Skill 均使用该格式。
- 新任务推送仍把选择值写入旧字段 `skillId`，服务端只接受 32 位十六进制仓库 Skill ID，因此合法 Plugin Skill 在创建会话前被拒绝。

## 根因与方案

根因是选择器与任务推送协议未同步：选择器已经统一展示仓库 Skill 和 Plugin Skill，而任务推送仍只实现旧式 `skillId`。

本次沿用现有新会话协议，不新增第二套 Plugin 机制：

1. 渲染层把 32 位仓库 Skill 继续发送为 `skillId`；把结构化 Plugin Skill 发送为 `pluginReferences: [{ kind: 'skill', id }]`。
2. 本地服务允许任务会话命令携带 `pluginReferences`，并使用现有 Plugin 服务校验、冻结引用。
3. 任务推送计划把已校验引用交给现有会话 Plugin Runtime，在 Provider 首次写入前完成绑定。
4. 任务推送默认值接受两类稳定 ID，避免用户选择 Plugin Skill 后重开弹窗又丢失选择；其他工作流保持原行为。

优点：复用通用会话已经验证的结构化引用、权限和版本冻结路径；旧仓库 Skill 完全兼容；失败仍发生在 Provider 写入前。缺点：本次只修复用户命中的“新任务推送”执行入口；代码审查与冲突处理虽然共用选择目录，但各自有独立的阶段/延迟派发语义，不能在未验证恢复边界时顺带扩展。

## 验证记录

- `pnpm exec prettier --check <本次文件>`：通过。
- `pnpm lint`：通过。
- `pnpm exec tsc -b apps/desktop`：通过。
- 一次性协议自检：32 位仓库 Skill 生成 `skillId`；现场 Ponytail Plugin Skill 生成 `pluginReferences[0] = { kind: 'skill', id }`，通过。
- `pnpm --filter @zeus/desktop build`：通过；仅有既有第三方 Rolldown 注解与分包体积警告。
- `pnpm typecheck`、`pnpm build` 和 `pnpm --filter @zeus/local-server build`：均被未修改文件 `packages/local-server/src/imTelegramService.ts:1219` 的既有 `TS2367` 阻断；本次涉及的文件没有新增类型错误。
- `pnpm package:mac` 与真实 GUI/Provider 推送未执行：打包会先执行已被上述基线错误阻断的根构建，不能把桌面端静态构建冒充为真实运行验收。

## 完成边界

- 已修复新任务推送选择 Plugin Skill 时的请求编码、命令白名单、服务端校验与会话 Runtime 绑定。
- 未修改失败命令、任务状态或正式用户数据；原命令发生在 Provider 写入前，升级到修复版本后应从任务详情重新发起推送。
- 未顺带扩展代码审查和冲突处理入口，避免在没有覆盖阶段继承与延迟派发恢复语义的情况下扩大改动。

## 本地合入记录

- 2026-08-31 将任务提交 `8922178f5140785789102c3fd481150dead4dffe` 定向合入本地 `main`，合并提交为 `8a0b4c7011809869b9db0da0976e2b8e9e637345`。
- 合入前已刷新 `origin/main`；`main` 当时领先 7 个提交，任务分支只领先 `main` 1 个提交。
- `git merge-tree --write-tree` 无冲突；合入后任务提交为 `main` 祖先、合并树与任务提交完全一致，未合并路径和 `MERGE_HEAD` 均为空。
- 当前 `main` 集成态的 `pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；构建仅有既有第三方 Rolldown 注解与分包体积警告。
- 合入过程保留了 `docs/ZEUS-0392_IM接入.md` 与 `packages/local-server/src/imTelegramService.ts` 的并发未提交改动；它们不属于 ZEUS-0400。
- 未执行 push、发布、打包或 GUI/Provider 验收。
