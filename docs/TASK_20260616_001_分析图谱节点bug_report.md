# TASK_20260616_001 分析图谱节点 bug_report.md

## 任务目标

分析图谱节点 `.github/ISSUE_TEMPLATE/bug_report.md` 的实现风险、影响范围和建议测试范围。

- 节点类型：file
- 来源：`.github/ISSUE_TEMPLATE/bug_report.md`
- 当前真实文件：52 行 / 2044 bytes
- 当前 SHA-256：`e3947bebeffd0a56af352a0fc04abcc41f44dc868fd4e148f01c39442e9afb99`
- 说明：任务上下文标注 `lineEnd=53`，但当前真实文件用 `wc -l` 验证为 52 行；文件大小与 hash 与任务上下文一致，因此判断为图谱行号边界存在 1 行偏差，不影响文件身份识别。

## 真实依据

1. `DESIGN.md` 明确 Zeus 只展示真实状态，不使用假图表、假任务、假终端输出、假 AI 回复或无来源图谱节点；日志与错误界面不得暴露密钥。
2. `.github/ISSUE_TEMPLATE/bug_report.md` 当前包含：现象、影响、复现步骤、期望行为、真实数据来源、日志与脱敏、环境、回归验证。
3. `docs/TASK_20260613_001_Zeus目标模式实现计划.md` 已记录 2026-06-15 对 Bug Issue 模板的补强：真实数据来源、日志脱敏、外部配置等待项与回归验证清单。
4. `scripts/package-mac.test.ts` 中 `keeps complete contribution guidelines and templates for real-data Zeus changes` 覆盖 Bug Report 模板契约。
5. 本次聚焦验证命令通过：`pnpm vitest run scripts/package-mac.test.ts -t "complete contribution guidelines and templates" --reporter=verbose`，结果为 1 passed / 40 skipped。

## 现状结论

该节点是开源协作入口的 Markdown 模板，不属于运行时代码入口，不直接影响本地 API、SQLite、Runtime 会话或打包产物执行逻辑。但它会影响缺陷上报质量、安全脱敏和后续 AI Runtime/开发者是否能基于真实证据复现问题。

## 实现风险

| 风险 | 等级 | 依据 | 建议 |
|---|---:|---|---|
| 模板退化为轻量骨架，缺少真实数据来源 | 中 | `bug_report.md:26-30` 是防止 mock/假 Runtime 输出进入缺陷流程的核心约束 | 保留并测试 `## 真实数据来源` 与禁止 mock 文案 |
| 用户误贴明文密钥或完整终端敏感输出 | 中 | `bug_report.md:32-36` 明确 token/API Key/数据库密码不得粘贴 | 如未来改成 YAML issue form，应把脱敏要求做成必填说明或占位提示 |
| 外部配置等待项被描述为“应当成功” | 中 | `bug_report.md:22-24`、`34-36` 要求缺外部配置时只描述等待项 | 保持 AI CLI、Telegram、Keychain、Apple signing/notarization 相关等待口径 |
| 影响范围填写过粗，导致测试范围扩大或遗漏 | 低-中 | `bug_report.md:10-14` 只提供入口与范围枚举，未强制必填 | 若 Issue 质量持续不足，可升级为 GitHub Issue Form YAML，但需额外维护测试 |
| 回归验证被忽略 | 中 | `bug_report.md:46-52` 要求聚焦测试与按影响范围运行 `pnpm verify:release` | 保持契约测试，修复缺陷时按影响范围补测试 |
| 图谱行号边界偏差 | 低 | 当前任务上下文标注 1-53，真实文件为 1-52，hash/size 一致 | 图谱展示可容忍，但后续 code map 行号映射建议检查 Markdown 文件末尾行计数 |

## 影响范围

### 直接影响

- `.github/ISSUE_TEMPLATE/bug_report.md`：GitHub Bug Report 模板内容与贡献者填写行为。
- `scripts/package-mac.test.ts`：文档契约测试会因模板关键文案删除或改名而失败。
- `docs/TASK_20260613_001_Zeus目标模式实现计划.md`：已有历史设计与验证证据引用该模板契约。

### 间接影响

- 缺陷修复流程：影响后续 Bug 是否具备真实本地项目、命令、日志、外部等待项与回归验证信息。
- 安全边界：影响 token、API Key、数据库密码、Telegram/Keychain/签名配置等敏感信息是否被要求脱敏。
- AI Runtime 任务输入质量：模板质量会影响“基于真实仓库、真实日志、真实错误输出行动”的可执行程度。

### 不直接影响

- 不直接影响 Electron/Vite 构建、macOS 打包、SQLite schema、本地 API 路由、Runtime 执行器和图谱扫描核心逻辑。
- 不需要数据库迁移、接口契约变更或新增运行时依赖。

## 建议测试范围

| 层级 | 命令/方式 | 覆盖点 |
|---|---|---|
| 文件身份 | `wc -l -c .github/ISSUE_TEMPLATE/bug_report.md && shasum -a 256 .github/ISSUE_TEMPLATE/bug_report.md` | 确认目标文件、大小、hash 与图谱节点一致 |
| 聚焦契约 | `pnpm vitest run scripts/package-mac.test.ts -t "complete contribution guidelines and templates" --reporter=verbose` | 确认 Bug Report 仍包含真实数据来源、脱敏、回归验证、`pnpm verify:release` |
| 文档契约全量 | `pnpm vitest run scripts/package-mac.test.ts --reporter=verbose` | 若改动 Issue/PR/README/贡献/发布相关文档，验证协作物整体契约 |
| 类型检查 | `pnpm typecheck` | 若同步改测试或脚本，确认 TS 工程仍通过 |
| 发布门禁 | `pnpm verify:release` | 仅当模板改动被纳入发布或影响 README/发布基线时运行；否则可说明无需触发 |
| 人工审查 | 对照 `DESIGN.md` 安全与真实数据章节逐项检查 | 防止文案弱化真实数据、脱敏、外部等待项 |

## 实施顺序建议

如果后续要修改该模板：

1. 先确定改动目的：降低填写成本、增强安全提醒、升级为 Issue Form YAML，或补充特定入口字段。
2. 先调整或新增 `scripts/package-mac.test.ts` 契约断言，确保会捕捉模板退化。
3. 修改 `.github/ISSUE_TEMPLATE/bug_report.md`，保留真实数据、禁止 mock、脱敏、外部等待项、回归验证这些核心约束。
4. 运行聚焦契约测试；若测试代码同步变更，再运行 `pnpm typecheck`。
5. 如果改动影响发布文档或开源协作基线，再运行 `pnpm verify:release`。

## 风险与回滚

- 回滚方式：恢复 `.github/ISSUE_TEMPLATE/bug_report.md` 与相关 `scripts/package-mac.test.ts` 断言到上一版。
- 回滚风险：若回滚到轻量骨架，会重新暴露假数据复现、敏感信息误贴、外部配置成功态伪造和无回归测试的风险。
- 推荐策略：不建议移除当前核心约束；如要降低填写成本，优先优化措辞和示例，不删除真实数据与脱敏要求。

## 本次验证记录

| 命令 | 结果 |
|---|---|
| `wc -l -c .github/ISSUE_TEMPLATE/bug_report.md` | `52` 行 / `2044` bytes |
| `shasum -a 256 .github/ISSUE_TEMPLATE/bug_report.md` | `e3947bebeffd0a56af352a0fc04abcc41f44dc868fd4e148f01c39442e9afb99` |
| `pnpm vitest run scripts/package-mac.test.ts -t "complete contribution guidelines and templates" --reporter=verbose` | 1 test passed / 40 skipped |

## 当前结论

当前节点实现风险可控，主要风险不在运行时，而在协作契约被后续弱化。建议保持现有模板核心约束，并把聚焦文档契约测试作为默认回归范围。
