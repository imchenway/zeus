# Contributing to Zeus

Zeus 是用于统一管理项目、任务、Coding Agent 会话、代码理解、Git 变更和自动化协作的 AI 研发工作台。贡献必须服务真实代码、真实运行态和真实发布证据，不能用 demo 或假数据替代设计书目标。

## 真实数据原则

- 保持项目名称统一为 Zeus / zeus。
- 不得提交 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。
- 图谱节点和边必须能追溯到文件路径、代码行、SQL/DDL、数据库 introspection、Git 信息或用户明确创建的真实记录。
- 没有真实数据时展示空态、失败态、未配置态或外部配置等待项，不伪造成功状态。

## 开发流程

1. 先阅读 `docs/zeus_development_design.md` 和当前任务文档，确认本次改动覆盖的设计书章节。
2. 本项目不采用 TDD，也不新增或恢复单元测试；实现前先核清真实代码与运行边界。
3. 涉及 UI、API、存储、发布或安全契约时，同步更新 README / docs / CHANGELOG.md / 实现报告中对应证据。
4. PR 必须使用 `.github/pull_request_template.md`，说明真实数据来源、验证命令、外部配置等待项和回滚方式。

## 安全与外部配置等待项

- 本地服务不得暴露公网，API token、Bot Token、API Key、数据库密码和证书不得明文回显。
- Shell、Git 写操作、删除文件、远程 Runtime 等高风险操作必须保留二次确认和审计。
- Apple signing / notarization、Telegram Bot Token、AI CLI 登录、Homebrew tap token 等外部配置等待项必须如实标注，不能伪造成已完成。
- 新增依赖、Electron rebuild、构建链路、CI 或发布流程变化属于高风险改动，必须在 PR 中说明原因、影响和回滚方式。

## 验证要求

普通提交或推送前运行：

```bash
pnpm verify:publish
```

该命令与 GitHub CI 共用同一门禁，依次检查本次变更文件的格式、Git 空白错误、lint、类型和生产构建。Prettier 只检查本次变更的代码与配置，不会因历史格式欠账阻断无关提交。

正式 macOS 出包或发布前运行：

```bash
pnpm verify:release
```

`verify:release` 会先执行 `verify:publish`，再追加 AI CLI adapter 探针、`package:mac` 和真实产物检查。

依赖审计按需单独运行 `pnpm security:audit`，不放进每次普通推送和实用发布的自动门禁。

如果某项因缺少外部凭据无法完成，必须说明具体等待项；不能把未验证能力写成已完成。

## 文档与发布

- `CHANGELOG.md` 必须记录版本、真实运行边界、DMG/ZIP/App 产物、Homebrew sha256 和外部配置等待项。
- `docs/Zeus实现报告.md` 必须只包含当前真实验证过的命令和产物。
- README、Issue 模板、PR 模板、Roadmap 和 release 文档不得包含虚假截图、虚假数据或虚假示例结果。

## 回滚方式

每个 PR 都必须说明回滚方式，以及回滚后会重新暴露的设计书缺口、安全风险或发布风险。
