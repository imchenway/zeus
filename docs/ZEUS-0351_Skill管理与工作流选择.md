# ZEUS-0351 Skill 管理与工作流选择

## 需求事实

- 在主侧边栏“新对话”和“搜索”下面增加 `Skill 管理` 入口。
- 提供 Skill 管理界面，展示 Zeus 当前实际可发现的 Skill。
- 用户可以自定义安装任意符合 Skill 目录规范的内容。
- 任务推送、代码审查、代码冲突处理三个入口都可以直接选择一个 Skill 使用。
- Zeus 安装的 Skill 必须天然支持所有已接入模型；App Server、Pi 及后续 Runtime 的协议差异由 Zeus 内部吸收，用户侧不出现“受限”或“不兼容”路径。

## 领域边界

- `Skill` 是包含必需 `SKILL.md`、可选 `scripts/`、`references/`、`assets/` 等资源的目录；`SKILL.md` 必须提供 `name` 和 `description`。
- `已安装 Skill` 只表示当前 Zeus Skill Profile 可以发现它，不表示已经启用或执行；Skill 不属于某个 Provider。
- `工作流 Skill 选择` 是某次首发的显式调用参数。选择后由本机执行核心冻结 Skill 身份，再由目标 Runtime Adapter 生成原生投影；不得只在 Renderer 保存一个展示标签或因模型变化清空选择。
- 未选择 Skill 时不注入显式调用，仍保留 Provider 自己的隐式匹配能力。
- Codex App Server 使用 `{ type: "skill", name, path }` 结构化条目；Pi 使用同一个 Skill 文件与资源目录生成原生 ResourceLoader 条目并显式加载完整 `SKILL.md`。两者是同一 Skill 的运行时投影。

## 产品决策

### Skill 来源

管理页按 Zeus Skill Catalog 返回的范围统一展示四类来源：

1. Zeus Skill Root 下的个人 Skill；首阶段复用 Zeus 专属 `$CODEX_HOME/skills`，不读取普通用户的其他 Codex Profile；
2. 当前项目目录可发现的仓库 Skill；
3. Codex 随附的系统 Skill；
4. 管理员配置的 Skill。

Plugin 提供的 Skill 只要进入 Zeus 发现范围，也会按其真实 scope 展示，不额外伪造来源。优点：安装一次即可由全部 Runtime 消费，选择器与真实执行范围一致。缺点：项目、系统、管理员及 Plugin 管理的 Skill 生命周期不属于 Zeus 用户安装目录，Zeus 只能展示和选择，不能在这里删除。

### 自定义安装

首版支持两种输入：

- 本地目录：用户选择一个包含 `SKILL.md` 的目录；
- Git 仓库：用户填写仓库 URL，可附带 ref 和仓库内子目录。

安装目标固定为 Zeus Skill Root 的直接子目录，不写普通用户的其他 Agent 目录。安装前校验 frontmatter、节点数、总大小、路径边界和符号链接；目标已存在或调用名冲突时拒绝，不静默覆盖。Git 拉取关闭交互式凭据提示并设置超时，私有仓库可使用本机已有凭据，失败时如实返回。

优点：同时覆盖本地自建、公开仓库和已有凭据可访问的私有仓库。缺点：不直接接受任意 HTTP 压缩包，避免把下载、解压路径穿越和来源身份混成一个不可审计入口；用户仍可先下载到本地再安装。

Skill 可以携带脚本，安装只复制并校验，不执行任何 Skill 内容。管理页必须明确提示：真正选择运行后，Provider 可能按 Skill 指令执行脚本，应只安装可信来源。

### 删除与替换

- 只有 Zeus Skill Root 下非系统的直接子目录可由管理页删除。
- 删除必须二次确认，并在服务端按 Skill 身份重新解析目标，禁止由 Renderer 直接提交任意文件路径。
- 首版不提供静默覆盖式更新；替换需要显式删除后重装。

优点：文件副作用可审计，避免更新过程覆盖用户本地修改。缺点：升级步骤比“一键覆盖”多一次确认。

### 三个工作流

- 任务推送：在模型、速度、工作模式、权限配置区加入 Skill 选择；选择随待创建会话信封持久化，后台重试仍保持同一选择。
- 代码审查：在只读审查配置中加入 Skill 选择，服务端仍强制只读权限和完整代码变化审查范围。
- 代码冲突：在 AI 冲突处理确认中加入 Skill 选择；准备队列、应用重启恢复和冲突开发线重建都保留该选择。
- 管理页可为三类工作流保存本机默认 Skill；单次弹窗可以覆盖默认值，但不会反向篡改全局默认。

任务推送和代码审查在最终执行目录已经存在时，会按稳定 ID 在实际 Worktree 再解析一次。冲突处理的 Worktree 在用户确认后才创建，因此先冻结项目 Catalog 中已经选定的真实 Skill 身份，再随不可变准备信封恢复。优点：应用重启或准备重试不会静默换成另一个同名 Skill。缺点：仓库 Skill 若在随后创建的冲突分支里有另一个版本，本次仍使用确认时冻结的项目版本；需要改用新版本时应取消本次处理并重新选择。

## 实现方案

### 本机服务

- 新增 Zeus Skill Catalog 服务，扫描个人、项目、系统、管理员和 Plugin Skill，返回稳定 ID、调用名、描述、真实路径、来源和可删除状态。
- 新增读取、安装、删除 API。安装和删除通过公开命令边界记录命令身份、外部文件系统写入结果和不可变回执。
- 自定义安装使用临时目录完成复制和校验，最后原子移动到目标目录；失败时清理临时目录，不留下半安装状态。

### Renderer

- 新增 `#skills` 顶层路由和侧边栏入口；该页面不依赖当前项目。
- 新增 Skill 管理工作区：搜索、来源分组、工作流默认绑定、安装对话框、删除确认与错误恢复。
- 新增共用 Skill 选择器和本机默认偏好模块，供三个工作流复用。

### 真实运行

- 客户端只提交稳定 `skillId`；服务端在接纳时重新解析当前 Catalog，得到真实调用名。
- 服务端解析稳定 Skill 身份，不按 Agent 类型拒绝或降级选择。
- Codex 首条输入先放置原生结构化 Skill 条目；Pi 在 ResourceLoader 中挂载同一 Skill，并在首条模型输入前显式加载其完整说明。两条路径都保留原工作流文本、附件和 Skill 相对资源语义。
- 冲突准备重试从持久信封恢复 Skill 身份；模型切换和应用重启均不能丢失选择。

## 验收标准

- `Skill 管理` 位于侧边栏“新对话”和“搜索”下面，可进入独立管理页。
- 管理页展示真实 Skill 名称、描述、来源、路径、是否可删除，并支持搜索。
- 可以从本地目录和 Git 仓库子目录安装合法 Skill；非法结构、符号链接、超限内容、同名目标和调用名冲突均给出明确错误。
- 删除个人 Skill 有二次确认；系统和 Plugin Skill 不出现删除操作。
- 三个工作流都能选择“不使用 Skill”或一个真实 Skill；默认绑定和单次覆盖语义正确。
- 所有模型的三个工作流都允许选择同一 Skill，不因模型切换清空或禁用选择器。
- Codex 首条真实输入包含所选 `{ type: "skill", name, path }` 条目；Pi 的 ResourceLoader 包含同一 Skill，首条真实输入包含完整 Skill 调用内容，并可读取其相对资源。
- 冲突处理在后台准备或应用恢复后仍使用原 Skill。
- 通过 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`。
- 使用独立 `Zeus Test.app`（`dev.hypha.zeus.test`）和独立 `ZEUS_USER_DATA_DIR` 验收真实管理页、安装及三个选择入口；外接屏存在时窗口从首次创建起放在非主外接屏，否则如实保留 GUI 缺口。

## 阶段记录

### 2026-08-25 全模型支持需求变更

- 用户明确否决 Skill 能力预检、受限状态和 Pi 不兼容路径；当前硬目标改为 Zeus 安装的 Skill 对所有已接入模型完整可用。
- 领域所有权从“Provider 发现的 Skill”改为“Zeus Skill”；Codex App Server 与 Pi 只负责生成同一 Skill 的运行时投影。
- 原完成记录中的“Pi 不支持 Skill”只代表变更前现场，不再是当前验收结论；必须补齐 Pi 的真实 ResourceLoader、显式调用、资源读取与持久恢复链路后重新验收。

### 2026-08-25 全模型补齐实现

- 公共目录、Renderer 客户端和服务路由已经收口为 Zeus Skill，使用 `/api/skills`、`skill.install`、`skill.remove` 与 `zeus-skills` 身份；Codex 命名只保留在 App Server 适配器内部。
- Zeus Skill Catalog 直接扫描自己的安装根；Codex App Server 仅补充项目、系统和管理员来源。即使 App Server 暂不可用，已经安装的 Skill 仍能列出、解析并交给 Pi 使用。
- 删除 Provider `enabled` 对 Zeus 显式选择的禁用和拒绝语义。只要 Skill 进入 Zeus Catalog，三个工作流和所有模型都能选择它；Provider 元数据不再形成用户可见的兼容矩阵。
- Codex 投影继续使用 `{ type: "skill", name, path }`；Pi 投影把同一条目挂入原生 `ResourceLoader`，首发正文使用 `/skill:name` 触发 Pi 自身的完整 `SKILL.md` 展开，并把 Skill 根目录加入本轮受控资源范围。
- 首发提交、排队提交和冲突准备信封都持久化完整 Skill 身份；模型或 Provider 切换创建新 Runtime Segment 时，从会话历史提交恢复最近一次冻结的 Skill 并重新投影，避免只依赖上一 Provider 的上下文记忆。
- 优点：安装一次、选择一次，不需要按模型预检或维护两份 Skill；Runtime 切换仍保持同一身份、正文和相对资源语义。缺点：每个新增 Runtime Adapter 都必须实现自己的投影器；Pi 的资源授权会为所选 Skill 增加一个只读发现根，仍受原工作流权限模式约束。
- 服务探针确认 App Server 不可用时仍列出 7 个 Zeus Skill 并能解析 `domain-modeling`；Pi ResourceLoader 探针确认同一路径被挂载，Pi 原生展开生成 3234 字符的完整 `<skill>` 块、保留用户正文且不残留 `/skill:` 命令；会话恢复探针确认能从较早提交恢复 Skill。
- 最新代码已通过 `pnpm typecheck`、架构治理、`pnpm lint`、`git diff --check`、`pnpm build` 与 `pnpm package:mac`；全模型补齐后的隔离 GUI 验收见下方“全模型最新制品与 GUI 复验”。

### 2026-08-25 全模型最新制品与 GUI 复验

- 最新制品 `dist/test/mac-arm64/Zeus Test.app` 已确认 `CFBundleIdentifier=dev.hypha.zeus.test`、`CFBundleName=Zeus Test`、版本 `0.3.51`，`codesign --verify --deep --strict` 通过。
- 使用本任务独立资料根 `/private/tmp/zeus-0351-all-skills-gui.Ehs0fx` 启动最新制品；首窗日志为 `targetDisplayId=3`、`actualDisplayId=3`、`corrected=false`，边界 `x=-1268, y=268, 1240×820`，从创建起即在非主外接屏。日常 `/Applications/Zeus.app` 进程在验收期间保持运行，未关闭、复用或修改。
- 管理页实际展示 6 个系统 Skill；通过“本地目录”真实安装 `domain-modeling` 后，立即进入“个人安装”分组、展示真实 `SKILL.md` 路径和“移除”操作；接受二次确认后已成功移除。
- 安装对话框已收口为 `ZEUS SKILL`，不再显示 `CODEX SKILL`；Git 安装真实界面包含仓库地址、可选 ref 和可选 Skill 子目录，同时明示安装不执行脚本与可信来源提示。
- 在隔离资料根创建验收项目与任务，进入真实“推送到新会话”弹窗。弹窗先带入工作流默认 `review-agent`；模型从 Codex 切换为隔离的 Pi 验收模型后，Skill 仍为 `review-agent`，界面没有“不兼容”、“受限”、禁用或清空选择。未点击“创建新会话”，没有向 Provider 发送消息。
- Pi 验收模型仅使用不可达的假端点令 UI 出现 Pi 选项，未执行诊断或模型请求。验收后已先清空项目模型引用，再通过正常 Zeus API 删除假供应商及其假凭据；`/api/models/catalog` 和 `/api/model-connections` 最终均为空。
- 最新交互期间无应用控制台错误，页面 `scrollWidth=clientWidth=1240`、`scrollHeight=clientHeight=820`。验收结束后已关闭本任务 `Zeus Test.app`；独立资料根保留截图和日志作为可审计证据，不再含个人安装 Skill 或 Pi 验收供应商。
- Computer Use 因当前 Node REPL 缺少 `nodeRepl.createElicitation` 无法启动，内置 Browser 插件又因运行时禁止导入 `node:process` 无法接管；最终依据前端调试 Skill 的降级规则，使用 Playwright 连接同一个真实 Electron Renderer 执行点击、DOM 核对与截图，不是静态页面替代。

### 2026-08-25 需求与现场核对

- 当前代码只有整套 Codex 配置导入，会复制 `skills` 目录，但没有 Skill Catalog、单项安装删除或工作流选择参数。
- 三类会话已有 `task_push`、`code_review`、`conflict_resolution` 独立来源，适合在首发接纳边界携带 `skillId`。
- `task_push` 和 `code_review` 都由服务端生成最终提示词；`conflict_resolution` 在命名冲突开发线准备完成后再次生成提示词，因此必须把 Skill 身份放入可恢复准备信封。
- OpenAI Docs 当前规范确认 Skill 目录、显式 `$skill-name` 调用、自动发现和系统/用户/仓库来源；Zeus 继续使用自身隔离 `$CODEX_HOME/skills`，与现有配置导入和运行 Profile 保持一致。

### 2026-08-25 实现阶段

- Codex App Server 现场 schema 已确认 `skills/list` 原生目录接口，以及 `turn/start` 的 `{ type: "skill", name, path }` 结构化输入；Zeus 使用原生结构化条目，不退化为拼接 `$name` 文本。
- 已实现个人、项目、系统和管理员 scope 的目录展示，个人 Skill 的本地目录或 Git 安装、显式移除，以及侧边栏独立管理页。
- 已把稳定 `skillId` 接入任务推送、代码审查和代码冲突；服务端在真实执行目录重新解析 Skill，冲突准备队列和应用恢复会保留选择。
- 架构门禁、`pnpm typecheck` 与 `pnpm lint` 已通过。

### 2026-08-25 完成与验收阶段

#### 协议与服务证据

- 使用隔离 `CODEX_HOME` 对随包 Codex CLI `0.149.1` 做原生探针，`skills/list` 返回绝对 `SKILL.md` 路径、scope 和 enabled 状态；`turn/start` schema 接受 `{ type: "skill", name, path }` 结构化用户输入。
- 使用隔离 Profile 对 `domain-modeling` 完成服务级“本地安装 → Codex 原生发现 → 稳定 ID 解析 → 移除”闭环；安装没有执行 Skill 脚本。
- 任务推送和代码审查先在项目目录校验选择，再在最终执行 Worktree 按稳定 ID 复验；无效选择会在 Provider 派发前失败。冲突处理把所选 Skill 放入持久准备信封，后台准备与应用恢复不会丢失选择。

#### 静态、构建与制品

- `pnpm typecheck` 通过，包含架构治理门禁：88 张 Core 表和 11 张可重建辅助表的 owner、源码尺寸、导入、公开端口及包循环均符合策略。
- `pnpm lint`、`git diff --check`、`pnpm build`、`pnpm package:mac` 全部通过。
- 最新制品为 `dist/test/mac-arm64/Zeus Test.app`；`CFBundleIdentifier=dev.hypha.zeus.test`、`CFBundleName=Zeus Test`、版本 `0.3.51`，`codesign --verify --deep --strict` 通过。

#### 隔离真实 GUI

- 仅启动任务制品 `Zeus Test.app`，复用本任务专属 `/private/tmp/zeus-0351-gui.CgDeNY`，没有关闭、复用或修改用户日常 `/Applications/Zeus.app`；验收结束后资料根已可恢复地移入废纸篓 `/Users/david/.Trash/zeus-0351-gui.CgDeNY-20260825-0220`。
- 首窗按 `ZEUS_TEST_DISPLAY_ID=3` 创建在非主外接屏，运行日志为 `targetDisplayId=3`、`actualDisplayId=3`、`corrected=false`，窗口边界 `x=-1268, y=268, 1240×820`。
- 真实界面确认侧边栏顺序为“新对话 → 搜索 → Skill 管理”；管理页展示 6 个系统 Skill 和通过界面安装的 1 个个人 Skill，并能搜索、分组、显示真实路径和可移除状态。
- 真实界面确认本地目录与 Git 仓库安装表单；Git 表单包含仓库地址、ref 和 Skill 子目录，界面明确提示安装不执行脚本及运行可信边界。
- 管理页把推送任务默认值设为 `domain-modeling`、代码审查默认值设为 `review-agent`，刷新页面后仍保留；代码冲突默认选择器可见且当前为“不使用 Skill”。
- 真实“推送到新会话”弹窗自动带入 `domain-modeling`，本次可从 8 个选项中改为 `review-agent`；随后点击“取消”，没有触发“登录并继续”，没有向 Provider 发送消息。
- 在同一真实 Renderer 以 720×760 CSS viewport 复核响应式布局，`scrollWidth=clientWidth=720`，无页面级横向溢出；默认选择区由三列顺序收为单列。
- Execution Host 最终记录 `execution_host.ready`、`execution_host.ui_attached`、`execution_host.closing` 与 `execution_host.closed`，关闭原因为 `final_quit`；主进程退出码为 0。

#### 明确保留的现场缺口

- 代码审查的单次选择弹窗需要真实任务 Worktree 和来源会话；冲突处理弹窗需要真实 conflicted integration。为了不创建虚假 Provider 会话，也不通过分支、提交或人为冲突改写 Git 现场，本轮没有进入这两个特定弹窗。两条链路已完成 Renderer 接线、服务端 Agent/Skill 校验、持久信封和静态构建核验，但不能把它们报告成真实 GUI 已通过。
- Computer Use 的 macOS 可访问性桥在当前 Node REPL 缺少 `nodeRepl.createElicitation`，无法建立 Sky 连接；最终点击、DOM 状态与截图改由同一 `Zeus Test.app` 真实 Electron Renderer 的 CDP 通道完成。这是自动化控制方式降级，不是静态页面替代。
- 首次预验收启动曾遇到一次 Execution Host lease 竞争；未删除锁、未复用其他实例。在常规退出信号无法关闭残留进程后，只对已经核实属于本任务的精确 PID 做了强制终止，再以同一隔离资料根正常重启。最终最新制品启动、宿主接入和退出均正常。
