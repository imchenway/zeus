---
name: Feature request
about: Propose a Zeus capability backed by real local data
---

## 业务目标

说明谁在什么场景需要这个能力，以及它如何帮助 Zeus 的本地优先 AI 研发工作台闭环。

## 用户流程

1. 用户从哪里进入。
2. 用户输入或选择什么真实本地资源。
3. Zeus 应展示或执行什么结果。

## 真实数据来源

请列出该需求依赖的真实来源，例如本地代码库、SQLite、Git diff、Runtime 会话、Keychain、Telegram update 或用户明确创建的记录。

> Zeus 不得使用 mock 数据、假项目、假任务、假终端输出、假 AI 回复或无来源图谱节点来满足需求。

## 安全与权限

- [ ] 不默认暴露公网。
- [ ] 高风险 shell / Git / 文件操作需要确认。
- [ ] 敏感字段需要脱敏或进入 Keychain。

## 验收标准

- [ ] 有可复现的主路径。
- [ ] 有空状态、失败态和权限不足态。
- [ ] 有聚焦测试或验收命令。
- [ ] 不引入无法验证的外部成功状态。

## 备选方案

说明是否考虑过更小、更安全或更贴近现有 Zeus 架构的方案。
