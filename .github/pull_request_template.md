## 变更摘要

请说明本次改动覆盖的设计书章节、用户场景和主要行为变化。

## 真实数据来源

- [ ] 本次改动使用真实本地来源：代码库、SQLite、Git diff、Runtime 会话、Keychain、Telegram update 或用户明确创建的记录。
- [ ] 不得使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点。
- [ ] 若数据缺失，界面/API 展示空态、未配置态或等待项，不伪造成功状态。

## 安全与权限

- [ ] 本地服务不暴露公网，API token / Bot Token / API Key / 数据库密码不明文回显。
- [ ] Shell、Git 写操作、删除文件、远程触发 Runtime 等高风险操作保留二次确认。
- [ ] Apple signing / notarization、Telegram Bot Token、AI CLI 登录、Homebrew tap token 等外部配置等待项必须如实标注。

## 验证命令

- [ ] pnpm lint
- [ ] pnpm typecheck
- [ ] pnpm build
- [ ] pnpm package:mac
- [ ] pnpm verify:release

## 发布与文档

- [ ] README / docs / CHANGELOG / 实现报告已同步真实构建、运行、打包和 sha256 证据。
- [ ] unsigned DMG/ZIP、签名等待、公证等待等状态未被伪造成已完成。
- [ ] Homebrew cask、GitHub Release workflow、Issue/PR 模板仍与设计书一致。

## 回滚方式

说明如何回滚本次改动，以及回滚后会重新暴露哪些设计书缺口或风险。
