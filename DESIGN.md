# Zeus Design Context

## 设计基调

Zeus 是生产力工具，不是营销页面。界面采用克制、清晰、可信的 macOS 产品 UI：左侧导航、顶部状态区、主工作区、右侧上下文信息按需出现。

## 物理场景

资深开发者在夜间或白天的 MacBook/外接屏上长时间使用 Zeus 理解项目与调度任务，界面需要低疲劳、高可读、信息密度适中。

## 信息架构

- 主导航覆盖 Dashboard、Projects、Tasks、Code Map、Sessions、Git Changes、Telegram、Settings。
- Dashboard 展示真实项目、最近任务、最近会话、最近变更、代码地图状态、接口/表/模块/风险/执行统计；没有真实数据时显示空态，不显示演示项目。
- Projects / Project Detail 以真实本地目录、Git root、项目配置、扫描状态和图谱状态为中心，不把不存在的路径写成已连接。
- Tasks / Task Detail 以状态机、执行前检查、Runtime 会话、事件时间线、Git diff 和测试结果为中心，不展示假执行进度。
- Code Map 以真实扫描生成的系统架构图、表关系图、模块图、模块详情图、接口时序图、模块流程图、方法逻辑图为核心；每个节点和边都必须可追溯来源。
- Sessions、Git Changes、Telegram、Settings 都只展示真实会话、真实 diff、真实 Telegram update 或真实本机配置状态。

## 色彩策略

- 默认浅色，支持深色/浅色/跟随系统模式。
- 使用偏冷中性色，避免纯白和纯黑。
- 单一蓝紫强调色只用于主按钮、选中导航、关键状态。
- 错误、警告、成功保持语义色但降低饱和度。
- 不用大面积营销式渐变，不把控制台页面做成官网 hero。

## 组件规则

- 空状态要解释“这里会出现什么、为什么重要、下一步怎么做”。
- 卡片只用于分组，不做重复同款卡片网格。
- 控件必须具备 hover、focus、disabled、loading、empty、error 状态。
- 主操作必须可识别；危险操作必须有确认、影响说明和可审计结果。
- 表单失败时保留用户输入，提交中禁用重复点击。
- 表格、列表和图谱在窄屏下必须避免横向不可控溢出。

## 页面状态

所有主要页面都必须覆盖 loading、empty、error、permission denied、external wait 状态：

- loading：局部加载优先，不用整页遮罩掩盖已有真实数据。
- empty：说明为什么为空，以及下一步是选择本地仓库、扫描、创建任务、配置 token 还是调整筛选。
- error：说明影响范围和恢复方式；普通界面不暴露堆栈、密钥或完整终端输出。
- permission denied：说明需要本机路径权限、API token、Telegram 白名单或高风险确认。
- external wait：AI CLI、Telegram、Apple signing、notarization、Homebrew tap、外部数据库驱动等待用户配置时，只展示等待项，不伪造成功。

## 安全与敏感信息

- 不得展示明文 token、API Key、数据库密码、Bot Token 或完整密钥输出。
- Keychain、Telegram、AI CLI、数据库连接和发布凭据只展示配置状态、更新时间、风险提示和可执行的清理/重置操作。
- Git 写操作、Generic shell、删除文件、项目外路径访问、远程触发 Runtime 必须保留二次确认和审计记录。
- 日志导出、Telegram `/logs --full`、patch export、Mermaid export 都必须脱敏或只写入本机文件，不把长敏感正文发到远端。

## 最小可接受降级

- 没有真实来源时展示空态、未配置态或等待项。
- AI CLI 不可用时展示安装/登录/版本检测状态，不生成假 AI 回复。
- Telegram 未配置时展示未启用，不生成假 Telegram 消息。
- Postgres/MySQL driver 未批准时拒绝明文密码 URI，并说明等待依赖；不伪造外部数据库扫描成功。
- Apple signing / notarization 未配置时只声明 unsigned DMG/ZIP，不把产物伪装成已签名正式发布。
- 不使用假图表、假任务、假终端输出、假 AI 回复或无来源图谱节点。

## 质量底线

- 页面必须一眼看出当前对象、状态和主操作。
- 信息层级、留白、表单、表格、图谱、终端日志和错误恢复路径必须清晰。
- 交互状态必须覆盖 hover、focus、disabled、loading、empty、error。
- 所有视觉元素都服务于真实研发工作流，不添加无意义装饰。
- 文案必须说明真实状态：已验证、未配置、等待外部凭据、缺依赖、失败、可重试或不可执行。

## Zeus Design Contract v2

> 这是一段面向 AI、设计检查和后续实现的机器可读契约。它只描述 Zeus 自己的产品 UI，不复制外部品牌资产、字体、品牌色或 token 命名。

```yaml
version: "zeus-design-contract-v2"
register: "product"
scene: "资深开发者在 MacBook 或外接屏上长时间理解真实本地仓库、调度 AI CLI、审查 Git diff 和恢复失败任务；界面需要像 macOS 工具一样低疲劳、可追溯、可信。"
strategy:
  theme: "light-first, system-aware"
  color: "restrained-cool-neutral"
  density: "macos-product"
  data_rule: "no-real-source-no-business-data"
  security_rule: "local-first, redact-secrets, confirm-dangerous-actions"
colors:
  surfaces:
    window: "oklch(99.2% 0.002 255)"
    sidebar: "oklch(96.4% 0.003 255)"
    workspace: "oklch(98.4% 0.002 255)"
    panel: "oklch(99.8% 0.001 255)"
    panel-muted: "oklch(98.4% 0.001 255)"
    canvas: "oklch(99.6% 0.001 255)"
  text:
    primary: "oklch(23% 0.003 255)"
    secondary: "oklch(48% 0.003 255)"
    subtle: "oklch(60% 0.002 255)"
    disabled: "oklch(58% 0.002 255)"
  lines:
    default: "oklch(89% 0.002 255)"
    soft: "oklch(93% 0.001 255)"
    separator: "oklch(90.6% 0.001 255)"
  accent:
    primary: "oklch(55% 0.155 252)"
    primary-soft: "oklch(94.5% 0.008 252)"
    focus-ring: "0 0 0 3px oklch(62% 0.16 252 / 0.16)"
  semantic:
    success-text: "oklch(52% 0.08 145)"
    warning-text: "oklch(52% 0.12 70)"
    danger-text: "oklch(42% 0.095 28)"
    danger-bg: "oklch(96.5% 0.024 28)"
    danger-line: "oklch(82.5% 0.05 28)"
typography:
  families:
    ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    mono: "'SFMono-Regular', 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace"
  scale:
    title: { size: "17px", weight: 650, lineHeight: "24px" }
    heading: { size: "15px", weight: 650, lineHeight: "22px" }
    body: { size: "13px", weight: 400, lineHeight: "19px" }
    label: { size: "12px", weight: 550, lineHeight: "16px" }
    metadata: { size: "11px", weight: 500, lineHeight: "14px" }
    code: { size: "12px", weight: 400, lineHeight: "18px" }
spacing:
  base: "4px"
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  section: "24px"
radius:
  control: "7px"
  row: "8px"
  popover: "10px"
  drawer: "14px"
  panel: "14px"
  pill: "9999px"
motion:
  easing: "cubic-bezier(0.22, 1, 0.36, 1)"
  state: "120ms"
  reveal: "160ms"
  drawer: "200ms"
  rule: "只表达状态变化；reduced-motion 下取消 transform、animation 和 will-change。"
components:
  source-list:
    purpose: "项目优先导航、项目展开、项目内任务/代码/会话入口、左下全局设置。"
    tokens: ["--zeus-source-list-bg", "--zeus-source-list-hover", "--zeus-source-list-selected", "--zeus-hidden-titlebar-safe-top"]
    layout: "左对齐行，避让 macOS 红绿灯；项目行 hover 才露出设置和更多操作。"
    states: ["default", "hover", "selected", "expanded", "collapsed", "keyboard-current", "disabled"]
  object-toolbar:
    purpose: "显示当前项目、任务、代码图谱或会话对象，以及当前对象的一组必要操作。"
    tokens: ["--zeus-toolbar-bg", "--zeus-toolbar-line", "--zeus-toolbar-action-bg", "--zeus-toolbar-action-line"]
    layout: "单行或紧凑双行；主对象在左，低频操作收进更多菜单。"
    states: ["default", "loading", "external-wait", "error", "permission-denied"]
  controls:
    purpose: "按钮、输入框、搜索、下拉、复选框、分段控件统一 macOS 产品控件语言。"
    tokens: ["--zeus-control-height", "--zeus-control-radius", "--zeus-control-bg", "--zeus-control-border", "--zeus-control-focus"]
    height: "28px default, 32px roomy, 36px high-emphasis"
    states: ["default", "hover", "focus-visible", "active", "disabled", "loading", "error"]
  composer:
    purpose: "新建会话、运行时输入、图谱问答输入和任务续写的底部输入区域。"
    tokens: ["--zeus-composer-bg", "--zeus-composer-input-bg", "--zeus-composer-focus-ring", "--zeus-conversation-compose-line"]
    layout: "输入为主，context、adapter、发送、停止等操作收进输入框内部或紧邻底部 rail。"
    states: ["empty", "focused", "composing", "sending", "disabled", "error"]
  decision-rail:
    purpose: "Git diff、任务、运行时和高风险动作的确认区。"
    tokens: ["--zeus-decision-rail-bg", "--zeus-decision-rail-separator", "--zeus-decision-button-hover", "--zeus-decision-button-active"]
    rule: "危险动作必须说明影响、需要二次确认并留下本机审计记录。"
    states: ["default", "pending-confirmation", "running", "success", "failed", "blocked"]
  mode-rail:
    purpose: "展示当前模式、计划状态、项目上下文、远程控制状态。"
    tokens: ["--zeus-mode-rail-bg", "--zeus-mode-rail-active"]
    layout: "低噪音灰底；active 只用轻底和字重，不使用大面积高饱和色。"
    states: ["default", "active", "truncated", "external-wait"]
  graph-canvas:
    purpose: "代码页主角，承载真实系统架构图、接口时序图、模块流程图和方法逻辑图。"
    tokens: ["--zeus-graph-canvas-bg", "--zeus-graph-canvas-line", "--zeus-graph-canvas-source-bg", "--zeus-graph-canvas-source-text"]
    layout: "画布优先，检查器独立滚动；大图谱允许画布内部滚动，不压扁节点。"
    states: ["empty", "scanning", "completed", "stale", "failed", "oversized", "project-mismatch-blocked"]
  popover:
    purpose: "项目更多菜单、图谱节点菜单、轻量设置菜单。"
    tokens: ["--zeus-popover-bg", "--zeus-popover-line", "--zeus-popover-radius", "--zeus-popover-item-hover-bg"]
    interaction: "Escape 关闭，外部点击关闭，动作执行后关闭，焦点返回触发器。"
    states: ["closed", "open", "keyboard-navigation", "disabled-item"]
  drawer:
    purpose: "项目设置、图谱详情、任务详情和安全确认的二级信息层。"
    tokens: ["--zeus-drawer-backdrop-bg", "--zeus-drawer-surface-bg", "--zeus-drawer-line", "--zeus-drawer-chrome-bg"]
    interaction: "打开时 autofocus，Escape 关闭，关闭后恢复焦点；不作为主路径首选。"
    states: ["closed", "opening", "open", "closing", "error"]
content:
  languages: ["zh-CN", "en"]
  rules:
    - "控件标签、按钮、空态、错误和状态说明必须按当前语言展示。"
    - "真实 adapter id、model id、命令、路径、日志、枚举原值和用户输入保持事实，不硬翻译。"
    - "错误文案写清发生了什么、影响范围和下一步，不暴露密钥、完整 token 或无关堆栈。"
    - "空态说明这里会出现什么、为什么重要，以及第一步动作。"
quality_gates:
  must_have_states: ["loading", "empty", "error", "permission-denied", "external-wait"]
  must_have_accessibility: ["focus-visible", "keyboard-navigation", "aria-current-or-selected", "reduced-motion"]
  must_not:
    - "纯黑或纯白作为大面积界面底色。"
    - "外部品牌字体、品牌色或品牌 token 命名进入 Zeus canonical token。"
    - "卡片堆叠、后台面板、重复大标题、松散胶囊按钮。"
    - "用 mock 数据、假任务、假图谱、假终端输出或假 AI 回复填充界面。"
    - "用 CSS 隐藏旧结构冒充信息架构完成。"
```

## Zeus Design Contract v2 使用规则

- 设计与实现必须先判断页面唯一核心目标，避免把功能清单平铺成后台面板。
- 后续 UI 代码优先引用 `--zeus-*` 语义 token；若需要新增 token，必须先说明它服务的组件语义和状态。
- 任务页、代码页、设置页和会话页可以共享控件语言，但不能共享错误的信息架构：任务页以任务列表为主角，代码页以图谱画布为主角，设置页以偏好设置分组为主角，会话页才允许会话列表加详情。
- 外部设计系统只能作为结构与表达方式参考，不能把其品牌资源、品牌色、字体或 token 名称复制到 Zeus。

## TASK_20260710_001 会话页任务级视觉例外（2026-07-13）

用户为“Zeus 会话页与真实 Codex native app-server 连续对话”明确选择逐项对齐当前 Codex App 的可见视觉，包括字体、颜色、图标、布局、状态和动效。该决策只在以下边界内覆盖本文件 `quality_gates.must_not` 与本节上一条的外部品牌限制：

- 仅适用于会话页根作用域 `.session-codex-parity-v1`，不扩散到任务页、代码页、设置页或 Zeus canonical token；
- 可以复现当前 Codex App 的可观察颜色值、系统字体栈、尺寸、间距、圆角、图标语义和动效节奏；任务级 CSS 变量使用 `--session-*` 语义命名，不引入或冒充 Codex 内部 token 名称；
- 不复制 Codex bundle 专有源码；未确认授权的品牌图片、字体文件和图标资产不进入仓库，图标使用仓库已有或系统等价资产复现可见语义；
- 仍必须满足真实数据、单一主路径、非卡片堆叠、键盘导航、可见焦点、非颜色状态表达、WCAG 2.2 AA 与 reduced-motion；
- 本例外的实现、视觉证据、当前 Codex App 版本和回滚边界统一记录在 `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`；

### 正式任务与项目对话的领域边界（2026-07-17）

- **正式任务**是 Zeus 的可调度工作对象：持久化于 `tasks`，具有任务编号、状态、权限初值和任务事件。任务分组旁的 `+` 创建 `owner.kind = task` 的会话，`conversations.task_id` 指向该任务。
- **项目对话**是用户在当前项目中直接发起的自由对话：不创建 `tasks`，不写 `task_events`，`owner.kind = project`，`conversations.task_id IS NULL`。用户的第一条消息只是会话输入，不是正式任务描述。
- 两类会话复用同一套持久 thread/turn、排队、审批、恢复、附件和幂等机制；所有者只决定归属、列表结构、首发接口与权限初值，不能把项目对话静默绑定到已有任务。
- 会话树把项目对话直接列在项目下，把任务会话列在对应任务分组下；禁止为项目对话伪造任务分组。即使项目没有正式任务，会话页仍显示底部 composer，并可创建与续接项目对话。
- “新对话”和 `Cmd+N` 面向当前项目创建项目对话；任务分组 `+` 继续创建任务会话。会话工作区的可访问名称与用户文案只表达产品语义，不暴露 app-server 等实现术语。
- 若本例外与本文件其他通用视觉条款冲突，在 `.session-codex-parity-v1` 内以本节为准；作用域外仍以 Zeus Design Contract v2 为准。
