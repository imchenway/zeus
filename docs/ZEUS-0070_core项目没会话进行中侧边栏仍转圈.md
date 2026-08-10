# ZEUS-0070 core 项目没会话进行中侧边栏仍转圈

## 当前阶段

已完成根因定位、源码修复、静态检查、测试身份打包和隔离真实界面验证。

## 任务目标

项目侧边栏的“会话”入口只在该项目确实存在排队、启动或模型执行中的会话时显示运行动效。历史会话全部空闲后必须停止转圈。

## 截图现象

- `tc-app-core` 项目当前没有进行中的会话，但“会话”入口仍显示蓝色转圈。
- 同一侧边栏中的 `Zeus` 项目也出现相同转圈，说明问题位于项目级会话状态聚合，不是当前项目页面的局部加载状态。

## 根因

- 项目级聚合原本同时读取 submission、provider 状态和 `conversations.status`。
- Codex 会话创建时把 `conversations.status` 写成 `starting`，但轮次完成时收敛的是 provider、submission 和 turn 运行事实；该产品对象状态不会按每一轮改为空闲。
- 聚合把长期保留的 `starting` 误当成当前运行事实，导致项目只要存在历史 Codex 会话就可能持续转圈。
- 会话列表本身主要依据 submission、turn、pending request 和 provider 状态投影，因此出现“列表没有进行中会话，项目侧边栏却转圈”的事实源分裂。

## 实现方案与取舍

- 侧边栏继续以排队、派发中或活动 submission，以及 `binding / active` provider 状态判定运行中。
- 待回复继续以 pending request 或 `waiting` provider 状态判定，并保持“待回复覆盖运行中”的既有优先级。
- Codex native 会话不再使用 `conversations.status === starting / running` 这个非权威兜底；旧 Runtime 会话仍保留该字段的真实进程阶段，不修改视觉样式，也不隐藏真实运行状态。

优点：侧边栏和会话列表重新使用同一组当前运行事实，历史会话不会制造永久转圈。

缺点：聚合依赖现有 submission 和 provider 生命周期正确收敛；如果未来增加新的运行内核或运行阶段，必须显式接入对应的权威运行事实，不能复用含义混杂的产品对象状态。

## 验收口径

- 项目只有空闲历史会话时，“会话”入口不显示转圈。
- 会话排队、派发或模型执行时显示转圈。
- 会话等待用户回答或审批时显示红点，并覆盖同项目其他运行态转圈。
- 会话完成后，实时事件把项目聚合状态收敛为空闲，无需进入或点击该会话。
- 不新增或恢复单元测试、组件测试、DOM/CSS 契约测试和 TDD 流程。
- 静态检查、构建、测试身份打包和真实界面验收分别记录，不互相替代。

## 验证记录

- `pnpm exec prettier --check packages/local-server/src/index.ts docs/ZEUS-0070_core项目没会话进行中侧边栏仍转圈.md`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，桌面端完成 1054 个模块转换。
- `pnpm package:mac`：通过，生成 `dist/test/mac-arm64/Zeus Test.app` 和 `dist/test/Zeus-Test-0.2.24-arm64.dmg`；App 的 bundle ID 为 `dev.hypha.zeus.test`，磁盘签名校验通过，测试包按配置未做公证。
- 隔离数据目录：`/tmp/zeus-0070-e2e.uod51K`，未读取或修改正式 Zeus 数据。隔离库写入一条 `status=starting`、无活动 submission、provider 非活动的历史 Codex 会话，数据库 `PRAGMA quick_check` 返回 `ok`。
- 本地服务验证：`/health` 返回 HTTP 200、数据库与 Runtime 均为 `ok`；`/api/dashboard` 对该项目返回 `conversationAttentionByProject=idle`。
- 真实界面验证：启动上述测试包后，项目侧边栏“会话”入口未显示转圈；点击“会话”后进入 `#project-sessions`，可访问性树中的入口只显示“会话 当前”，没有“会话正在运行”状态。隔离记录没有真实 provider 线程，宿主恢复时安全降级为“会话错误”，因此本轮不把它描述为真实 provider 恢复闭环。
- 本轮没有执行真实会话从排队、执行到完成的完整过渡；运行态和待回复态仍沿用既有 submission、provider 与 pending request 事实，本次没有修改这些生命周期或视觉规则。
- `git diff --check`：通过。
