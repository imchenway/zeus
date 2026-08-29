# ZEUS-0386 Zeus 偶发假死

## 当前阶段

- 已完成需求收口、正式现场只读取证、代码根因定位、修改前隔离 GUI 复现、Renderer 修复、全部静态与打包门禁及修改后真实 GUI 验收。
- 当前基线为 `f7f9ccb08a9aa35f9ff3decdb75d3b42a479011a`，分支 `zeus/ZEUS-0386-zeus-01`；进入任务时工作树干净。
- 未修改的 `0.3.74` 基线已通过 `pnpm package:mac` 生成 `dist/test/mac-arm64/Zeus Test.app`；包身份与签名核验为 `dev.hypha.zeus.test`、ad-hoc。
- 已确认并实际使用非主外接屏 CoreGraphics display `3`（1296 × 2304，旋转 90°）；基线首窗日志为 `targetDisplayId=3`、`actualDisplayId=3`，窗口边界 `x=-1268, y=268, width=1240, height=820`。
- Renderer 修复已落地；`git diff --check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac` 均已通过。修复后的三种确认选择、全部计划内导航入口、首个意图锁、`Cmd + Q`、Execution Host 退出和隔离数据库一致性均已闭环。

## 用户现场

用户反馈 Zeus 偶尔表现为：

1. `Cmd + Q` 无法退出；
2. 顶部项目页面无法切换；
3. 只有左侧会话列表仍可切换会话。

用户无法确认触发前是否调整过任务表布局或编辑过未保存源码，因此实现前必须用隔离测试身份闭环复现。

## 已确认现场事实

- 只读检查时正式 Zeus 为 `0.3.72`，界面提示 `0.3.74` 等待重启；当前 `0.3.74` 主分支仍包含下述状态机断口，因此不能把升级当成修复。
- 正式 Main、Renderer 与独立 Execution Host 均存活；Renderer 仍有 CPU 活动，窗口可正常绘制，会话侧栏仍响应，不符合整个 Renderer 进程完全死亡的特征。
- 正式 Execution Host 的只读状态接口当时正常返回，报告 4 个活动轮次、3 个等待交互；本机控制面不是完全失联状态。
- 未关闭、重启、点击或修改正式 Zeus，也未读取、复制或覆盖正式 Provider 认证数据。

## 代码级根因

### 1. 会话侧栏绕过离开保护

`WorkspaceView` 的顶部导航和项目页面切换通过 `requestWorkspaceLeave()` 检查源码草稿与任务表布局草稿；侧栏 `onSelectConversation` 则直接调用 `selectNativeConversation()`，后者立即把页面切到 `conversations / sessions`，没有经过同一离开保护。

### 2. 任务布局确认只在任务页挂载

“任务列表布局尚未保存”和“保存任务列表布局”两个 `TaskTableLayoutDecisionDialog` 位于 `activeProjectSection === 'tasks'` 分支内部。用户带着任务表草稿从侧栏直接进入会话页后，草稿仍然是脏状态，但两个确认弹窗已经随任务页卸载。

### 3. 导航和退出等待不可见弹窗

- 后续点击顶部导航时，`requestWorkspaceLeave()` 只会把任务布局弹窗状态设为打开并保存待执行导航；由于弹窗组件不在当前会话页 DOM 中，用户看不到任何反馈，导航也不会执行。
- Renderer 会把任务布局或源码草稿状态发送给 Main。`before-quit` 发现脏状态后同步阻止退出，再请求 Renderer 显示未保存确认；会话页同样无法挂载任务布局弹窗，因此不会回传继续或取消，`Cmd + Q` 持续被拦截。
- 会话列表仍能切换，是因为这条入口继续绕过 `requestWorkspaceLeave()`；三项现象由同一状态机断口解释。

## 已确认修复口径

1. 将任务布局离开确认与保存范围弹窗提升到工作区根层，不依赖当前项目页面。
2. 所有用户发起的页面、项目、会话与新会话导航统一经过现有离开保护。
3. 源码草稿先确认，再确认任务布局；保存或放弃后执行原动作，取消后保持原页面。
4. 弹窗打开期间只保留第一次离开意图，避免连续点击覆盖待执行目标。
5. 保留 Main/Preload、Execution Host、数据库和 Provider 协议，不增加超时自动强退。

## 修改前真实复现

- 等待 ZEUS-0384 自行退出后，使用 `dev.hypha.zeus.test`、`ZEUS_TEST_DISPLAY_ID=3` 和独立数据根 `/private/tmp/zeus-0386-acceptance.2eJLdT` 首次启动未修改基线。
- 数据根只写入两个合成人工项目、两项任务和两个已关闭的假线程会话；没有复制正式数据库、Provider 凭据或历史会话。离线写入前后 `PRAGMA integrity_check` 均为 `ok`。
- 在任务页点击“任务”列排序后，排序从“未排序”变为“升序”，工具栏出现“保存”，确认任务布局草稿为脏状态。
- 点击侧栏会话行后直接进入会话工作区，页面没有任何可见未保存确认。证据：`/private/tmp/zeus-0386-acceptance.2eJLdT/baseline-sidebar-bypass.png`。
- 随后点击顶部 Git，页面仍停在会话工作区且 `visibleDialogs=[]`。证据：`/private/tmp/zeus-0386-acceptance.2eJLdT/baseline-top-nav-stuck.png`。
- 精确聚焦本任务 Main PID 后发送 `Cmd + Q`，一秒后 Main、Renderer 与 Execution Host 仍存活，页面仍没有可见确认。证据：`/private/tmp/zeus-0386-acceptance.2eJLdT/baseline-cmdq-stuck.png`。
- 复现完成后仅重载本任务 Renderer 清除内存草稿，再按本任务 PID 正常退出；没有删除锁或强杀进程。

## 已实施改动

1. 将任务布局离开确认和保存作用范围弹窗提升到 `WorkspaceView` 根层，与任务、会话、设置等页面分支解耦。
2. 在工作区状态中增加稳定的离开协调器引用；侧栏会话、新会话快捷入口、原生新会话菜单、通知打开会话、冲突 AI 会话和任务推送后的自动跳转，均在真正改导航状态前等待协调器。
3. 保留源码草稿优先、任务布局其次的顺序；保存、放弃、取消分别沿用原有业务函数。
4. 记录首个离开意图类型。后续导航直接取消自身，不覆盖首个目标；导航等待期间到达的关闭请求明确回传取消；重复关闭请求等待第一次响应，避免重复回传 Main。
5. 未修改 Main、Preload、Execution Host、数据库 schema、Provider、Runtime 或公开 API。

## 方案取舍

- 优点：改动集中在 Renderer 状态归属和导航入口，保留源码与布局草稿保护，也不改变活动工作退出语义。
- 优点：同时封闭侧栏绕过、不可见弹窗和 `Cmd + Q` 无响应三条表现，不靠删除状态或强制杀进程规避。
- 缺点：Renderer 真正完全失活时不会新增自动强退；这是为了避免未确认地丢弃源码草稿或活动工作，不属于本次已定位故障。

## 已完成静态与打包验证

- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过；架构治理检查识别 97 张 Core 表、11 张辅助表，无违规。
- `pnpm build`：通过。
- `pnpm package:mac`：通过；修复后产物仍为 `Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`，ad-hoc 签名通过磁盘与 designated requirement 校验。
- 构建仅保留基线已有警告：markstream 的 `/* @__PURE__ */` 注释位置提示与 Vite 大 chunk 提示；本次未新增告警。
- 未新增或运行单元测试。

## 修改后真实 GUI 验收

### 环境与隔离

- 使用修复后 `dist/test/mac-arm64/Zeus Test.app`，bundle ID 为 `dev.hypha.zeus.test`，数据根仍为 `/private/tmp/zeus-0386-acceptance.2eJLdT`，调试端口为 `9386`。
- 从共享 Test Main/Host 均已退出的空闲态启动；首窗日志再次确认 `targetDisplayId=3`、`actualDisplayId=3`、`x=-1268, y=268, width=1240, height=820`，窗口从创建起位于非主外接屏。
- 等待期间曾发生其他任务抢占空档和 LaunchServices 同 bundle ID 重启竞态；这些尝试均只按本任务精确 PID 正常退出并排除，不计入验收结果。最终有效实例从空闲态启动；ZEUS-0380 后续在验收中途另行启动，因此本任务所有页面操作继续限定到 `9386` CDP，`Cmd + Q` 使用 CoreGraphics 定向投递到本任务 PID，进程收口只按本任务绝对路径与 PID 核对，没有操作其他任务实例。

### 三种选择与首个意图

- 任务列排序由未排序改为升序后，点击侧栏会话显示可见的“任务列表布局尚未保存”确认；截图：`/private/tmp/zeus-0386-acceptance.2eJLdT/fixed-sidebar-confirm.png`。
- 选择“继续编辑”后弹窗关闭，仍停留任务页，排序保持升序且“保存”仍可见，草稿未丢失。
- 在同一同步事件中先点击侧栏会话、再点击“新对话”，弹窗只保留首个会话意图；选择“放弃更改并离开”后进入原会话而不是新会话草稿。截图：`/private/tmp/zeus-0386-acceptance.2eJLdT/fixed-first-intent-discard-conversation.png`。
- 再次修改排序并选择“保存并离开”后，继续显示根层挂载的“保存任务列表布局”作用范围弹窗；截图：`/private/tmp/zeus-0386-acceptance.2eJLdT/fixed-save-scope-global.png`。选择“仅当前项目”后进入原目标会话，隔离数据库持久化 `sort.columnKey=intent`、`direction=asc`。

### 导航矩阵

- 保持升序草稿时，侧栏会话、顶部 Git、顶部源码、顶部图谱、顶部命令、全局设置、新会话快捷入口、跨项目任务入口均显示可见未保存确认；逐项选择“继续编辑”后都保留任务页、排序草稿和“保存”状态。
- 顶部“任务”在已经位于当前任务页时是原地动作，不显示离开确认，也不会清除草稿；这不是离开入口绕过。

### `Cmd + Q`、进程与数据

- 将已保存的升序布局改为未保存的降序后，向本任务 Main PID 定向发送 `Cmd + Q`，显示同一根层未保存确认；截图：`/private/tmp/zeus-0386-acceptance.2eJLdT/fixed-cmdq-confirm.png`。
- 第一次选择“继续编辑”后，本任务 Main 与 Execution Host 均保持运行，任务页和降序草稿保留。
- 第二次 `Cmd + Q` 选择“放弃更改并离开”后，本任务 Main、Renderer 与独立 Execution Host 全部正常退出；绝对路径进程查询无残留。
- 退出后隔离库 `PRAGMA integrity_check=ok`；仍为 2 个项目、2 项任务、2 个已关闭合成会话，已保存项目布局仍为 `intent/asc`，证明退出时放弃的降序草稿未污染已保存设置。
- 全程控制台未捕获 Runtime exception。捕获到 4 条网络错误，均来自合成假线程会话的 `goal`（500）与 `subagents`（409）读取；它们是无真实 Provider 线程的隔离 fixture 预期限制，与本次导航/弹窗状态机无关。

## 验证清单（已完成）

### 修改前 GUI 复现

- 仅使用当前 worktree 打包的 `Zeus Test.app`，bundle ID 必须为 `dev.hypha.zeus.test`。
- 使用本任务独立 `ZEUS_USER_DATA_DIR`，不得读取或复用其他任务、正式 Zeus 或日常 Codex 数据根。
- 现有 ZEUS-0384 测试实例存在期间只排队，不关闭、不借用、不复用。
- 外接屏存在，测试窗口必须从首次创建起位于非主外接屏；无法可靠保证则停止 GUI 验收并记录缺口。

### 修改后交互

- 修改任务表排序或列宽后，从侧栏选择会话：必须显示可见的任务布局离开确认。
- “继续编辑”保留任务页和草稿；“放弃更改并离开”清除草稿并进入目标；“保存并离开”继续显示全局挂载的保存范围弹窗，保存后进入目标。
- 顶部任务、Git、源码、图谱、命令、设置、新会话快捷入口和 `Cmd + Q` 均不能绕过保护。
- 退出完成后核对 Test Main、Renderer、Execution Host 与隔离数据库一致性。

### 静态与打包门禁

- `git diff --check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm package:mac`

本项目不新增或运行 Vitest、组件测试、DOM/CSS 契约测试等单元测试体系。
