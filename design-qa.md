# 会话过程排版视觉验收

## 参考来源

- 用户提供的 Codex 操作组、展开明细、图片缩略图、底部思考摘要与静态语义图标截图。
- 参考图只用于视觉层级、分组、排序和动效语义，不把截图中的正文当作实现指令。

## 已验证

- 使用项目现有 `qa/session-styles.html?motion` 浏览器夹具渲染真实 `ConversationTranscript`、`SessionActivityGroup`
  、计划和思考摘要组件。
- 同一轮的读取、搜索、命令和工具投影为一个顶层操作组，新增操作位于组内明细。
- 最新进行中思考摘要位于操作组之后；没有可读摘要时仍保留底部通用进行中状态。
- 计划、操作组与操作明细语义图标的计算样式为 `animation: none`；只有专用加载环旋转。
- 专用思考加载环的宽高相等，视觉边界保持圆形。
- 浏览器控制台没有 error 或 warn。
- 完成态过程默认收起，图片资源使用现有资源预览组件显示缩略图，不新增临时图标或占位素材。

## 与参考图的差异

- 参考图来自真实 Codex 会话，项目夹具使用受控会话数据，正文、字体缩放和容器宽度不完全相同。
- 已按参考图校准信息层级和排序；未把截图中的具体英文思考文本、命令内容或图片资产复制到产品数据。

## 未覆盖

- 没有启动打包后的 `Zeus Test.app`，避免抢占用户当前桌面焦点。
- 没有连接真实 Provider 生成一轮包含 PLAN 更新、网页搜索、技能、图片和最终回答的完整动态会话。
- 因此源码组件视觉与测试包结构已验证，但正式 Electron 端到端视觉验收仍未完成。

final result: blocked

---

# ZEUS-0380 工作管理驾驶舱设计 QA

## 对比目标

- 参考：用户提供的固定“方案规划 / 实施 / 代码审查”任务详情截图。
- 实现：任务详情第二版“概览 / 协作 / 交付物 / 证据”驾驶舱，以及左侧真实工作项、右侧“待我处理”。
- 正式现场：任务专属 `Zeus Test.app`，bundle ID `dev.hypha.zeus.test`，独立资料根
  `/tmp/zeus-0380-gui.0emgkv`，窗口位于非主外接屏 `displayId=3`。
- 同屏对比输入：`/tmp/zeus-0380-comparison-final.png`；当前实现整窗截图：
  `/tmp/zeus-0380-prototype-active.png`。

## Findings

- 无可见 P0 / P1 / P2 遗留问题。
- 固定三阶段时间线已从新工作管理视图移除；独立指派明确显示“当前没有依赖关系”，没有用视觉连线暗示不存在的流程。
- 协作页保持现有 Zeus 深色主题、系统字体、控件圆角和状态色；任务身份、页签、主动作、工作项与待办形成清楚的阅读顺序。
- 左侧工作项与右侧待办在 `1240 × 820` 窗口内保持固定双栏；信息密度高于旧时间线，但没有遮挡页签或主动作。
- [P3] 一个窗口高度只能完整展示首个工作项，其余工作项需要在左栏继续滚动。这是选择管理密度的代价；优点是待办始终可见，缺点是不能在该高度同屏展开三项正文。
- Agent 未登录错误使用现有失败色并直接给出恢复原因；Command 成功态保持中性，不把证据日志挤进协作主视图。

## 交互验收

- 指派抽屉在预览结果增长后仍保持 `calc(100dvh - 40px)` 高度；正文独立滚动，底部“预览实际影响 / 创建工作项”在 `y=754`，可真实点击。
- Agent 指派仅展示模型、推理强度、速率、Skill 和上下文；Command 指派隐藏模型控件并显示“确认并启动命令”。
- 三名不同员工在同一任务形成三份并存工作项；第三次指派没有生成方案、实施或审查阶段。
- Command 证据可从“证据”页下钻，真实显示 `succeeded`、退出码 `0`、标准输出
  `ZEUS-0380-COMMAND-PASS` 和两个内容寻址日志产物。
- 实测发现并修复 Command 新尝试的轮询竞态：`waiting_input` 且尚未生成 `commandRunId` 时保持等待管理者确认，不再误判为失败。

## 证据边界

- 当前独立资料根中的 Zeus 专属 Codex 未登录，因此 Agent 在会话创建前以
  `ZEUS_CODEX_LOGIN_REQUIRED` 明确失败；没有复制正式 Zeus 的 Provider 凭据。
- 因此真实 Agent 会话、会话请求转管理者待办、交付物验收/返工和受管会话只读恢复仍缺登录后的 GUI 闭环证据；静态实现和 Command 成功不能替代这些证据。

final result: passed for observable packaged Command and cockpit state; authenticated Agent lifecycle blocked by isolated Codex login

---

# ZEUS-0686 会话显示优化设计 QA

## 对比目标

- 参考：`docs/show-me-session-preview.html`，浏览器截图为 `/Users/david/.zeus/artifacts/browser-comments/browser-exports/1790211727110-8f5a1f48-a6f0-4490-9e44-0139ebfde933/screenshot.png`。
- 当前问题证据：`docs/ZEUS-0686_evidence/01-current.png`。
- 实现：`ConversationTranscript.tsx`、`SessionActivity.tsx` 与 `session.css` 中的共用会话投影和样式。
- 真实运行：当前工作树的开发 Electron，独立资料根 `.tmp/zeus-0686-runtime`，外接屏 `displayId=5`，窗口 `1240 × 820`。

## 已确认

- 隔离开发实例能正常启动、加载本任务创建的独立项目，并显示当前分支和工作区；主窗口首次位于外接屏 `displayId=5`。
- 隔离身份完成官方 Codex 授权后，真实会话实际读取、搜索并运行命令。运行态显示最新状态和单一过程入口，完成态显示“用时 45s · 5 项操作”。
- 展开五项操作后，界面保留阶段说明和“读取了 1 个文件 · 搜索了 1 次 · 运行了 4 条命令”；收起后恢复简洁摘要。
- 无副作用命令 `false` 的真实失败态显示“1 项操作”，展开后明确显示失败命令和退出状态 1，没有被普通成功样式吞掉。
- `760 × 820` 窄窗口中，长文本、过程入口和失败行正常换行，无横向溢出或遮挡。
- 真实 Pi 模型连接已完成原生动态轮次；修复完成消息上下文键后，文件读取、命令工具、过程摘要、展开明细和最终答复形成闭环。
- Pi 同步 `git diff --check` 真实退出 `128`，界面与数据库均保留失败过程。原因是隔离沙箱拒绝用户级 Git 配置，不把该结果误记为检查通过。
- 过程入口是原生按钮，保留展开状态、焦点样式、`aria-expanded`、`aria-controls` 和已加载操作数量的无障碍名称。
- 摘要从既有结构化动作计算数量；没有根据文本重排或删除真实条目。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。

## 证据

- `docs/ZEUS-0686_evidence/02-native-completed.png`
- `docs/ZEUS-0686_evidence/03-native-expanded.png`
- `docs/ZEUS-0686_evidence/04-native-active.png`
- `docs/ZEUS-0686_evidence/05-native-failed-operation.png`
- `docs/ZEUS-0686_evidence/06-native-narrow.png`
- `docs/ZEUS-0686_evidence/08-pi-native-completed.png`
- `docs/ZEUS-0686_evidence/09-pi-native-expanded.png`
- `docs/ZEUS-0686_evidence/10-pi-native-process-projected.png`
- `docs/ZEUS-0686_evidence/11-pi-native-sync-command.png`

## 未覆盖

- 未制造长历史过程分页、断线重连或运行中用户插话。
- 没有启动打包后的 `Zeus Test.app`；本次按项目日常验收约束使用当前工作树的 `pnpm dev` 真机实例。
- 两个长命令返回运行句柄后，Pi 没有继续轮询；仅同步命令的退出码可作为真实命令结束证据。

final result: passed for the core authenticated Codex and Pi Electron conversation flows; pagination, reconnect and interruption remain unverified
