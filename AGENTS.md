# Zeus 项目代理约束

## TDD 与单元测试

- 本项目不采用 TDD，不执行 RED-GREEN-REFACTOR，不以“先写失败测试”作为实现前置条件。
- 本项目不创建、维护或恢复 Vitest 单元测试、组件测试、DOM/CSS 契约测试及现有 `test/`、`*.test.*` 测试体系。
- 后续任务不得默认新增测试文件、测试脚本、测试依赖或把测试重新加入 CI、发布门禁和完成条件。
- 历史任务文档中的 TDD 与测试记录仅代表当时事实，不是当前项目规则。
- 当前验证方式为 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 以及必要的真实运行检查；`pnpm package:mac`
  只生成独立身份的 `Zeus Test.app`。不得把静态检查或构建成功夸大为运行完成。
- 日常开发、任务 worktree、临时目录和真实运行验收只能生成或启动 `Zeus Test.app`，其 bundle ID 必须为 `dev.hypha.zeus.test`
  ，并使用独立用户数据目录。
- 生产身份 `Zeus.app` 只能由 `pnpm verify:release` 或正式发布编排显式生成；发布候选只做结构、签名、DMG 和清单校验，不得作为
  GUI 验收包启动。
- 除用户日常安装的正式应用外，不得生成、启动或向 macOS 登记其他生产身份 `Zeus.app`；不得用任务 worktree、仓库 `dist`
  或临时目录中的生产身份应用进行验证。

## 其他约束

- 文档、任务记录、设计说明和代码注释使用简体中文。
- 未经用户明确要求，不执行 git commit、push、merge、revert 等修改历史或远端动作。
