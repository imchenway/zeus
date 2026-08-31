# ZEUS-0424 数字员工配置 Skill 报错

## 当前阶段

根因修复与静态验证已完成。当前分支为 `zeus/ZEUS-0424-skill-01`，开始处理时工作区干净；未执行 commit、push、merge 或 revert。真实 GUI、Plugin Runtime 和 Provider 回合尚未验收，不能由构建结果替代。

## 现象与现场事实

- 在数字员工配置中选择统一 Skill 目录里的 Plugin Skill 后，保存区域显示 `template.skillIds 长度必须在 1 到 32 之间。`。
- 数字员工模板、项目员工和单次运行都复用 `skillIds`；内置模板允许空数组，问题不是“必须至少选择一个 Skill”。
- 普通 Zeus Skill 的稳定 ID 是 32 位十六进制字符串；Plugin Skill 的稳定 ID 形如 `plugin:<plugin-id>:skill:<skill-id>`，天然超过 32 字符。
- `SkillMultiSelector` 已展示两类 Skill，但数字员工存储仍把每一项限制为 32 字符并只接受旧式 ID。
- 仅放宽保存校验仍不完整：新式工作项预览会继续调用普通 Skill 解析器，旧协作执行和 Telegram Agent Preset 也会继续把 Plugin Skill 写入旧 `skillId` 字段，最终在 Provider 写入前再次失败。

## 根因

统一 Skill 目录已经合并普通 Skill 与 Plugin Skill，但数字员工的能力契约和所有派发消费者没有同步升级：

1. 存储层只接受 32 位普通 Skill ID；
2. 工作项预览与资源快照只认识可复制的普通 Skill 目录；
3. 会话派发仍只发送单个 `skillId`，没有把 Plugin Skill 转成结构化 `pluginReferences`；
4. 代码审查型数字员工阶段尚未把内部结构化引用交给会话 Plugin Runtime。

这是同一身份协议漂移在不同调用方的表现，不应只改错误文案或 Renderer 表单。

## 实施决策

- 在共享包定义普通 Skill 与 Plugin Skill 的稳定身份判定和分流，存储、数字员工工作管理、旧协作执行、Telegram Preset 与既有任务推送复用同一规则。
- 存储仍保存稳定 ID 数组，不增加表字段或迁移；每项上限与 Plugin 引用现有 512 字符边界一致，并拒绝其他任意字符串。
- 新式工作项继续把普通 Skill 的文件和资源冻结为 Artifact；Plugin Skill 记录选择时的 Plugin revision，并在会话创建时通过现有 `pluginReferences` 交给 Plugin Runtime 冻结激活快照。
- Plugin revision 若在工作项创建后、会话派发前变化，则明确失败，不静默改用新版本；已经开始的会话继续使用既有会话激活快照。
- 旧协作执行和 Telegram Preset 保留最多一个普通 Skill 的旧协议，同时把所有已选 Plugin Skill 作为结构化引用传入；不改变现有普通 Skill 行为。
- 代码审查入口只在数字员工内部请求实际携带 `pluginReferences` 时启用该路径，不顺带开放尚未完成产品验收的手工代码审查 Plugin Skill 选择器。

## 取舍与优缺点

### 统一稳定身份契约

优点：选择器、持久化和派发不会再各自维护互相漂移的正则；后续入口可复用同一判定。缺点：共享包新增一个很小的 Skill 身份模块，涉及的编译边界比单点放宽字符串更广。

### 普通 Skill Artifact 与 Plugin 激活快照分开冻结

优点：复用两类能力各自已有的权威机制，Plugin 的 Hook、MCP、Connector 和 Skill 版本仍作为一个激活快照，不伪造为普通文件 Skill。缺点：Plugin 在工作项创建后、派发前发生版本变化时只能拒绝本次运行；若未来要跨版本重试同一运行，需要 Plugin Runtime 支持按历史 revision 建立新会话激活。

### 不新增存储迁移

优点：现有 `TEXT` JSON 列已经能保存两类稳定 ID，最小修改即可兼容旧数据。缺点：数据库列名仍是通用 `skill_ids_json`，无法仅靠列结构区分普通与 Plugin Skill，必须由共享身份契约解释。

## 验证边界

### 已验证

- 缺少 `node_modules` 后执行 `pnpm install --frozen-lockfile --offline`，仅复用本机缓存安装依赖，未改动 lockfile。
- 相关文件 `pnpm exec prettier --check` 通过。
- `pnpm typecheck` 通过；架构治理同时通过 126 张 Core 表、11 张可重建辅助表、owner、导入、端口与循环检查。
- `pnpm lint` 通过。
- `pnpm build` 通过。
- 一次性临时数据库自检通过，且临时目录已删除：
  - 空 `skillIds` 仍可保存；
  - 32 位普通 Skill ID 与 `plugin:plugin_sample:skill:ponytail` 可同时保存并原样读取；
  - 统一身份分流得到普通 `skillId` 和结构化 `{ kind: 'skill', id }` Plugin 引用；
  - 任意字符串 `not-a-skill` 仍以 `ZEUS_DIGITAL_EMPLOYEE_SKILL_INVALID` 拒绝。
- `git diff --check` 通过。

### 尚未验证

- 未生成或启动 `Zeus Test.app`，因此没有把静态检查或构建写成真实 GUI 保存验收。
- 未创建真实 Plugin Runtime 激活与 Provider 会话，因此 Plugin revision 冻结、会话派发和 Telegram 路径目前只有代码审计与编译证据。
