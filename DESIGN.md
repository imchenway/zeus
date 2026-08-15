# Zeus Design Context

## 设计基调

Zeus 是生产力工具，不是营销页面。界面采用克制、清晰、可信的 macOS 产品 UI：左侧导航、顶部状态区、主工作区、右侧上下文信息按需出现。

## 物理场景

资深开发者在夜间或白天的 MacBook/外接屏上长时间使用 Zeus 理解项目与调度任务，界面需要低疲劳、高可读、信息密度适中。

## 信息架构

- 主导航覆盖 Dashboard、Projects、Tasks、Code Map、Sessions、Git Changes、Telegram、Settings。
- Dashboard 展示真实项目、最近任务、最近会话、最近变更、代码地图状态、接口/表/模块/风险/执行统计；没有真实数据时显示空态，不显示演示项目。
- Projects / Project Detail 以真实本地目录、Git root、项目配置、扫描状态和图谱状态为中心，不把不存在的路径写成已连接。
- Tasks / Task Detail 以任务管理状态、任务要求、关联会话索引和事件时间线为中心；执行控制留在会话中，不展示任务级 Runtime 控件或假执行进度。
- 项目“代码”默认进入源码工作台；图谱与命令作为代码工作区右上角的完整页面模式。图谱仍只展示真实扫描结果，每个节点和边都必须可追溯来源。
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
- Zeus 专属 Codex 的可执行文件和 `CODEX_HOME` 必须作为同一运行身份传递给每个 app-server 世代；只选择专属二进制但回退默认用户目录会造成身份、历史线程和远程接管串用，必须明确阻断。
- Git 写操作、Generic shell、删除文件、项目外路径访问、远程触发 Runtime 必须保留二次确认和审计记录。
- 日志导出、Telegram `/logs --full`、patch export、Mermaid export 都必须脱敏或只写入本机文件，不把长敏感正文发到远端。

## 最小可接受降级

- 没有真实来源时展示空态、未配置态或等待项。
- AI CLI 不可用时展示安装/登录/版本检测状态，不生成假 AI 回复。
- Telegram 未配置时展示未启用，不生成假 Telegram 消息。
- Postgres/MySQL driver 未批准时拒绝明文密码 URI，并说明等待依赖；不伪造外部数据库扫描成功。
- Apple signing / notarization 未配置时只声明 unsigned DMG，不把产物伪装成已签名正式发布。
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
  button:
    purpose: "文字按钮统一使用类型化原语表达主操作、次操作和危险操作，不借用其他页面样式。"
    tokens: ["--zeus-control-bg", "--zeus-control-border", "--zeus-control-focus", "--zeus-control-danger-bg", "--zeus-control-danger-line", "--zeus-control-danger-text"]
    variants: ["primary", "secondary", "danger"]
    sizes: ["compact", "regular"]
    states: ["default", "hover", "active", "focus-visible", "disabled", "loading"]
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
    purpose: "代码页图谱模式的主角，承载真实系统架构图、接口时序图、模块流程图和方法逻辑图。"
    tokens: ["--zeus-graph-canvas-bg", "--zeus-graph-canvas-line", "--zeus-graph-canvas-source-bg", "--zeus-graph-canvas-source-text"]
    layout: "画布优先，检查器独立滚动；大图谱允许画布内部滚动，不压扁节点。"
    states: ["empty", "scanning", "completed", "stale", "failed", "oversized", "project-mismatch-blocked"]
  popover:
    purpose: "项目更多菜单、图谱节点菜单、轻量设置菜单。"
    tokens: ["--zeus-popover-bg", "--zeus-popover-line", "--zeus-popover-radius", "--zeus-popover-item-hover-bg"]
    interaction: "Escape 关闭，外部点击关闭，动作执行后关闭，焦点返回触发器；方向键在菜单项间移动。项目更多菜单提升到应用壳层，位于触发按钮右侧并顶部对齐，间隔 6px。"
    layout: "项目更多菜单使用 208px 宽、12px 圆角、6px 内边距和 32px 图标行；菜单项按置顶、Finder 定位、重命名、移除排列，hover 与 focus-visible 共用中性低对比底色。"
    states: ["closed", "open", "hover", "keyboard-navigation", "disabled-item", "danger-confirmation"]
  modal:
    purpose: "创建任务、推送模型、布局确认和重命名等阻断式表单弹窗。"
    tokens: ["--zeus-overlay-backdrop-bg", "--zeus-overlay-backdrop-filter", "--zeus-solid-surface-bg"]
    interaction: "portal 根层透明；统一 backdrop 负责遮罩、虚化与空白关闭；Escape 关闭并恢复焦点。"
    states: ["closed", "open", "submitting", "error"]
  drawer:
    purpose: "项目设置、图谱详情、任务详情和安全确认的二级信息层。"
    tokens: ["--zeus-overlay-backdrop-bg", "--zeus-overlay-backdrop-filter", "--zeus-drawer-surface-bg", "--zeus-drawer-line", "--zeus-drawer-section-bg", "--zeus-drawer-action-bg"]
    interaction: "打开时 autofocus，Escape 关闭，关闭后恢复焦点；不作为主路径首选。标题和内容共用单一纯色表面，不用灰度标题条或装饰横线分割。"
    states: ["closed", "opening", "open", "closing", "error"]
  solid-form-surface:
    purpose: "重命名、创建任务、推送模型等表单型弹窗，以及设置页和项目设置抽屉。"
    tokens: ["--zeus-solid-surface-bg", "--zeus-solid-surface-edge", "--zeus-solid-surface-section-gap", "--zeus-form-action-height", "--zeus-form-action-font-size", "--zeus-form-action-padding-inline"]
    layout: "标题、正文、动作区使用同一底色；桌面弹窗水平边距 20px，靠留白与文字层级分组。输入、选择、危险确认和焦点环保留功能轮廓。表单底部保存、创建和取消动作统一为 32px 高、13px 字号与 14px 水平内边距；右上角关闭按钮维持紧凑尺寸。"
    states: ["default", "focused", "submitting", "error", "danger-confirmation"]
content:
  languages: ["zh-CN", "en"]
  rules:
    - "控件标签、按钮、空态、错误和状态说明必须按当前语言展示。"
    - "真实 adapter id、model id、命令、路径、日志、枚举原值和用户输入保持事实，不硬翻译。"
    - "错误文案写清发生了什么、影响范围和下一步，不暴露密钥、完整 token 或无关堆栈。"
    - "空态说明这里会出现什么、为什么重要，以及第一步动作。"
    - "任务说明、用户消息、智能体正文和思考摘要属于保真正文：保留原始空格、Tab、换行和连续空行，超宽长行允许视觉软换行；Markdown 段落、列表、引用和表格节点之间的结构空白不属于原文，不得显示为额外空行；标题、按钮和表格摘要继续使用紧凑布局。"
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
- 任务页、代码页、设置页和会话页可以共享控件语言，但不能共享错误的信息架构：任务页以任务列表为主角，代码页默认以目录树和源码编辑器为主角，图谱与命令在代码页内整页切换，设置页以偏好设置分组为主角，会话页才允许会话列表加详情。
- 外部设计系统只能作为结构与表达方式参考，不能把其品牌资源、品牌色、字体或 token 名称复制到 Zeus。

## 交互原语执行契约

- `Button`、`Select`、`ModalPortal`、`Drawer`、`SourceListRow` 是五类独立原语，不合并为万能组件。
- 原语组件统一拥有 DOM 结构、键盘语义、hover、focus、selected、disabled、动效和 reduced-motion；业务页面只提供内容并选择显式变体。
- `Button` 使用 `primary / secondary / danger` 语义变体和 `compact / regular` 尺寸；三种变体统一高度、字号、圆角、内边距、可见边框、焦点环、禁用和忙碌状态。危险按钮必须使用危险色边框与危险色焦点环，深色模式不得退回普通按钮的浅色描边。业务页面不得借用其他页面按钮 class，也不得为单个弹窗重写危险按钮皮肤。
- `Select` 的尺寸使用 `compact / regular / roomy` 组件属性，不通过父页面选择器推断。
- `Select` 展开层必须通过 portal 提升到应用壳层，并按触发器的视口坐标固定定位；浮层首次可见时就必须达到最终宽度，至少与触发器等宽，并按本次打开时的完整选项内容自适应宽度，禁止先窄后宽或延迟横向跳动。宽度测量必须先进入不可见的内部测量态，解除选项行百分比宽度、文字裁切和网格弹性列的约束，再恢复正常布局并应用最终宽度；最大不超过视口安全边界，触发器和业务布局不得随浮层变宽。下方能完整容纳菜单时向下展开，否则向上完整展开，不比较两侧剩余空间，不因视口高度额外压缩菜单；展开层不得留在表单、抽屉或其他滚动容器中扩大 `scrollHeight`，展开前后业务布局尺寸必须保持不变；达到视口宽度上限时只允许选项文字省略，不允许换行或横向滚动。
- `ModalPortal` 是所有阻断式表单弹窗的唯一 body portal 壳层。portal 根层必须保持透明，只有 `backdrop` 可以绘制 `--zeus-overlay-backdrop-bg` 与 `--zeus-overlay-backdrop-filter`；禁止把主题画布色刷到覆盖全窗口的 portal 根层。弹窗 footer 的确认、取消与危险动作必须复用全局 `Button` 尺寸。
- `Drawer` 的形态使用 `floating / sheet`，所有生产抽屉统一使用 `dimmed` 遮罩并消费与 `ModalPortal` 相同的遮罩与虚化 token；禁止任务详情、项目配置或其他业务抽屉恢复透明遮罩。允许的组合由 TypeScript 属性约束，不通过业务 class 名或 `:has()` 推断。
- `SourceListRow` 共享 `--zeus-source-list-hover`、`--zeus-source-list-selected` 和圆角 token，但必须显式选择表面范围：`content` 只包裹身份内容，`fill` 覆盖整行导航目标；项目根行和项目内页面入口使用 `fill`，使项目根行的统一圆角表面包含右侧操作槽。项目根行使用 `--zeus-source-list-root-row-radius: 10px` 与 `30px` 总高，紧凑子行使用 `--zeus-source-list-row-radius: 8px` 与 `26px` 总高。
- `SourceListRow` 外层统一使用 `border-box`，最小高度必须包含自身边框；任务、代码、会话等页面作用域可以切换颜色 token，但不得通过通配盒模型、字体或控件尺寸规则改变全局 source-list 的行高与分组间距。
- 项目根行在类型层禁止 `selected`，只允许 hover、focus、expanded 和 collapsed；selected / current 只用于任务、代码、会话等 nested 导航。所有行的 hover 只使用 `--zeus-source-list-hover`，selected 行悬停时保持 `--zeus-source-list-selected`，不再混合第二种颜色；项目设置与更多图标不叠加独立 hover 底色，只保留独立焦点环。
- `SourceListRow fill` 的可见背景只能由外层行绘制一次，内部主按钮在 hover / active / focus-visible 时保持透明，禁止出现“灰底叠白”。项目设置与更多默认同时隐藏，只在父行 hover、focus-within 或更多菜单打开时出现；图标按钮使用不小于 `26px` 的透明圆形命中区，鼠标悬停以图标变深和轻微缩放反馈，按下时轻微收缩，不绘制独立表面，键盘焦点才显示圆形焦点环。
- 项目更多菜单不得留在侧栏纵向滚动容器的裁剪上下文中；菜单提升到应用壳层后使用触发按钮的视口坐标固定定位，左边缘位于“更多”按钮右侧 `6px`，顶部与按钮顶部对齐。窗口尺寸或项目列表滚动变化时同步锚点坐标，外部点击与 Escape 仍关闭菜单。菜单使用 `208px` 宽、`12px` 圆角、`6px` 内边距、`32px` 图标行与中性 hover；项目移除入口保持中性，只有二次确认进入危险色。
- 项目重命名只更新 Zeus 项目显示名称，不提交或推断新的本地路径；项目存储只在请求显式携带且真实改变 `localPath` 时执行路径唯一性校验，未改变路径的元数据更新不得被历史重复路径阻断。“在 Finder 中显示”由受信 Electron 窗口经 preload IPC 请求 Main 进程，Main 必须复验绝对路径、目录存在性和发送窗口后再调用系统 Finder。
- 表单型弹窗、全局设置与项目设置抽屉共享单一纯色表面 token；header / body / footer 和抽屉 chrome / content 不允许再用不同灰度背景或装饰横线分层。任务详情等局部事实区与底部动作区只能使用 `--zeus-drawer-section-bg`、`--zeus-drawer-action-bg` 等明确语义表面，禁止把透明色与页面底色混合出偏色块。组件间以 `20px` 外边距、标题层级和内容间距建立结构；输入框、下拉、列表、表格、焦点、错误和危险确认的功能边界不在移除范围内。
- 创建任务弹窗只保留字段标签、必要占位、错误和附件操作，不重复解释标题、当前项目或 Runtime 状态；优先级使用 P0 至 P4 的 `ZeusSelect`，默认 P3，P0 只表达处理顺序，不触发执行。
- 应用内 `button / input / select / textarea` 统一使用 `border-box`，全宽输入、选择和文本域的声明宽度必须包含自身 padding 与 border；页面不得用 `content-box` 让控件越过父容器右侧留白。
- `WorkspaceDrawer` 的内容滚动层及其直接业务内容统一使用 `border-box`；内容层声明 `inline-size: 100%` 时，项目设置等页面添加的左右 padding 必须包含在该宽度内，禁止依赖 `overflow-x: hidden` 裁掉超宽内容并伪装成“没有溢出”。
- 表单底部的保存、创建和取消动作统一复用 `32px` 高、`13px` 字号和 `14px` 水平内边距；只放大主要文字动作，不连带放大右上角关闭按钮或改变表单字段密度。
- `WorkspaceDrawer` 统一拥有进入、退出、遮罩、可用宽度和卸载时机：关闭命中层覆盖整个窗口，面板自身阻止关闭事件；正常模式使用可感知的右侧空间位移与 expo 风格 ease-out，关闭由 `animationend` 驱动并保留超时兜底；系统减少动态效果时只允许短透明度过渡。
- 抽屉宽度由 `standard / wide` 和剩余工作区共同计算；外层内容区只允许纵向滚动，横向数据或代码必须在业务内容内部自行提供局部滚动，不得让抽屉壳层出现横向滚动条。
- 新增或修改页面、弹窗、抽屉、菜单和表单时，交付前必须同时检查 `light / dark / system` 三种主题传播、至少一个窄窗口断点、键盘焦点与 reduced-motion。大面积背景、边框、文本和状态不得硬编码纯白、纯黑或只适用于单一主题的色值；body portal 必须在主题切换的当前帧消费同一语义 token，不得要求返回设置页后才刷新。
- 全局滚动条复用 `--zeus-scrollbar-thumb`、`--zeus-scrollbar-thumb-hover`、`--zeus-scrollbar-thumb-active`：轨道透明、默认低对比，交互时逐级增强；业务页面可以调整滚动条尺寸或隐藏特定导航滚动条，但不得重新硬编码颜色。
- 项目列表容器只允许纵向滚动；任务、代码、会话子导航使用缩进和选中态表达层级，不绘制贯穿式竖线。
- 任务页只保留一层两行主工具条；有数据时直接进入表头，不再增加“视图控制”或“默认视图”说明行，加载与错误反馈仍保留语义化状态。
- 任务页主工具条内部按两行组织：第一行左侧只保留不超过 `280px` 的居中占位搜索框，右侧放新任务，不再重复展示项目名、任务计数或全部状态摘要；紧邻列头的第二行左侧固定状态快捷筛选，右侧固定批量、列设置和更多视图动作，禁止再把这些动作混进列头或挤在同一侧。
- 任务页状态快捷筛选固定以“全部、未完成、待开始、开发中、测试中”的顺序呈现；“未完成”是排除任务管理状态 `completed` 与 `cancelled` 的派生视图，不得扩展任务状态枚举或读取 Runtime 状态。
- 状态筛选按项目保存在 App Shell 本机设置中；项目没有合法历史偏好时默认“未完成”，用户显式选择“全部”时必须保存空字符串并与“偏好缺失”区分。只有快捷按钮、清除筛选和查看全部状态等显式用户操作可以改写该偏好，创建任务、图谱转任务、新建对话与普通页面导航不得自动覆盖。
- 任务表数据列头的标题区用单击排序、超过拖动阈值的指针移动换位，右缘独立分隔线只调整列宽；键盘换位继续使用独立把手。排序必须有升序、降序、未排序文本或图标语义，不能只靠颜色。
- 任务表标题与数据必须各自保持稳定锚点：普通文本列标题和值严格左对齐，时间等数字扫描值严格右对齐，创建时间和更新时间的短标题在列内居中。拖动换位把手不得占用标题的流内宽度；普通文本列把操作区放在尾端，时间列把换位操作区放在首端；时间列排序指示使用独立对称布局槽，排序图标和控件显隐都不能推动标题或数据值各自的锚点。
- 任务表换位把手默认保持视觉隐藏，只在当前列头 hover、focus-within、键盘移动或实际拖动时出现；列宽分隔线则始终保持低对比可见，hover、focus 或拖动时增强。控件命中区与键盘可达性始终保留。未排序列不显示排序图标，列标题本身继续作为排序按钮并通过可访问名称表达“未排序”。
- 任务表列标题区可直接拖动换位，单击仍只触发排序；列右边界保留常驻低对比分隔线和独立缩放命中区，支持在内容可读下限到 `640px` 安全上限内连续调整。
- 指针拖动任务列时，表头与数据列保持原顺序，只在目标列边缘显示落点插入线；松手后表头与所有行数据一次性落到目标位置并写入布局草稿，取消拖动不改变顺序。拖动预览不得触发保存、项目覆盖或全局设置写入。
- 任务类型列使用只读彩色胶囊：需求使用低饱和蓝紫色，缺陷使用低饱和红色，优化使用低饱和绿色；完整文字始终保留，不伪装成可点击下拉框。
- 任务表列显隐、位置、像素宽度和当前排序状态统一形成布局草稿；草稿未保存时在原“更多”位置显示保存入口，离开任务页或退出应用必须允许保存并离开、放弃更改并离开或继续编辑。
- 任务表离开确认必须作为覆盖当前工作区的模态弹窗呈现，保留原任务页背景并阻止后台交互，不得用全屏实色 portal 伪装成独立页面。动作顺序使用“继续编辑、放弃更改并离开、保存并离开”；三个动作统一使用全局 `Button` 原语，放弃操作使用低饱和危险底色与清晰危险边框，保存保持唯一蓝色主按钮。
- 原语样式集中在 `apps/desktop/src/renderer/ui/primitives.css` 并最后加载；页面样式不得重新定义原语的核心状态。

## TASK_20260710_001 会话页任务级视觉例外（2026-07-13）

用户为“Zeus 会话页与真实 Codex native app-server 连续对话”明确选择逐项对齐当前 Codex App 的可见视觉，包括字体、颜色、图标、布局、状态和动效。该决策只在以下边界内覆盖本文件 `quality_gates.must_not` 与本节上一条的外部品牌限制：

- 仅适用于会话页根作用域 `.session-codex-parity-v1`，不扩散到任务页、代码页、设置页或 Zeus canonical token；
- 可以复现当前 Codex App 的可观察颜色值、系统字体栈、尺寸、间距、圆角、图标语义和动效节奏；任务级 CSS 变量使用 `--session-*` 语义命名，不引入或冒充 Codex 内部 token 名称；
- 不复制 Codex bundle 专有源码；未确认授权的品牌图片、字体文件和图标资产不进入仓库，图标使用仓库已有或系统等价资产复现可见语义；
- 仍必须满足真实数据、单一主路径、非卡片堆叠、键盘导航、可见焦点、非颜色状态表达、WCAG 2.2 AA 与 reduced-motion；
- 会话 composer 与完整 thread 内容列共享同一响应式最大宽度和水平 gutter；窗口、侧栏或工作区变化时同步收放，输入正文只驱动 textarea 纵向增长，达到上限后内部滚动；
- Electron 会话 composer 的 textarea 不绘制蓝色内框或聚焦边线，外层保持稳定的中性描边与轻阴影；内部按钮、菜单和强制颜色模式继续提供可见键盘焦点；
- 本例外的实现、视觉证据、当前 Codex App 版本和回滚边界统一记录在 `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`；
- composer 响应式对齐、内容增高和焦点线收敛的本次实现与验收记录在 `docs/TASK_20260725_002_Zeus会话输入框Codex自适应对齐.md`；

## TASK_20260730_001 会话过程态与底部交互坞契约

- Plan 和普通工作模式共用同一过程反馈规则：turn 开始及阻塞请求解决后，在首个新摘要、活动或回答出现前必须显示明确的思考状态；
- 每次 `turn/start` 必须显式请求 `summary: "auto"`，不能假设 app-server 会在省略参数时自动返回可读摘要；
- Renderer 只展示 app-server 的 readable reasoning summary，不把 raw reasoning content 当作过程文案；
- `turn/completed` 必须收敛当前轮次遗留的 `in_progress` 项；若遗留文本是后续完整项的严格前缀，则用结构化 `supersededBy` 标记抑制重复展示，否则保留文本并完成该项；
- 连续工作活动默认收起，运行时只露出最新一项；用户主动展开后才能查看完整命令、读取和输出历史；
- `request_user_input`、计划实施确认、命令、文件、权限和 MCP 请求统一占用 composer 所在的底部交互坞，同一时刻只显示队首请求；
- 交互坞不得进入 transcript 的滚动内容，不得与 composer 同时形成两个主操作区；长内容只能在交互坞内部滚动；
- 动态效果遵循系统减少动态效果设置，取消空间动画时仍必须保留可读状态变化；
- 完整证据、协议边界、取舍和验收记录见 `docs/TASK_20260730_001_Codex过程态与底部交互坞对齐.md`。

### 2026-08-05 输入框常驻修订

- 原生会话底部 composer 在连接、上一轮失败、底层线程不可续等状态下保持可见和可编辑；阻塞式普通用户询问出现时由专用交互坞暂时替换 composer，回答、跳过或关闭后恢复，避免两个输入区同时成为主操作。
- 用户发送消息只触发当前产品会话内的原生线程校准与续接；无法证明可以安全继续时保留输入并说明真实原因，不自动创建承接会话。
- “需要恢复”不再是用户可见的会话状态，也不能成为整会话写入门禁。Provider 接收结果不确定只作为对应消息的局部状态，禁止该消息自动重发，但不锁死其他会话操作。
- 新产品会话只能由用户通过明确的新建入口创建；普通 Enter、询问解析失败、连接失败和上一轮失败都不得静默改变会话身份。

优点：一次协议或发送异常不会废掉整段工作，会话身份与用户操作保持一致。代价：结果不确定的旧消息需要保留局部状态，不能为了自动恢复而冒险重发。

### ZEUS-0101 普通用户询问交互契约

- 选项行的编号、标题区、补充说明和反馈图标按行中线对齐；同一组选项共享补充说明起点，长说明在说明区域内自然换行。
- 自定义回答行整行可点击，首次点击直接启用并聚焦输入；提示文案使用 Zeus 作为用户正在操作的产品主体，不在界面中把交互对象切换为 Codex。
- 自定义回答中 Enter 提交当前询问答案，Shift+Enter 换行；输入法组合期间的 Enter 不提交。输入控件继续隔离数字和方向键，防止误选预设答案。
- 跳过、提交和上一个组成询问行尾操作区，始终与当前自定义回答、自由输入或最后一项可选答案同行，不再形成独立底部按钮行；操作区不压缩、不换行，也不使用绝对定位覆盖输入内容。
- 命令和文件权限请求使用同一行尾操作规则：命令预览或文件目标占据可伸缩内容区，拒绝、允许及授权范围菜单位于右侧；分裂授权按钮的文字段和箭头段必须等高，独立命中区均不小于 `28px`。
- Zeus 主窗口最小宽度为 `640px`，作为会话输入与行尾操作同时保持可用的产品下限；达到下限后不再继续压缩控件或引入组件内部横向滚动。
- 选项表面之间保留明确间距，hover、active、busy 和 focus-visible 都提供即时状态反馈。
- 提交、跳过和单选答案在等待本机服务回执前先进入本地忙碌状态，阻止重复点击并立即反馈；服务端协议、空答案跳过语义和执行轮次生命周期不变。
- 优点：普通用户询问出现时只有一个明确主输入，用户不会把普通消息误当成询问答案；代价：询问未处理前不能发送普通会话消息。
- 本修订覆盖“等待普通用户询问时 composer 无条件常驻”的旧规则；连接、失败、线程续接等其他状态仍保留普通会话输入框。

### ZEUS-0215 已回答询问的自定义回答契约

- 自定义回答结果是已回答询问中的真实选中项，不作为预设选项之外的普通附注展示。
- 自定义回答与预设答案共用绿色轻背景、绿色描边、勾选图标和“已选择”文字，同时保留“用户选择”标识区分答案来源。
- 敏感回答继续脱敏；纯自由输入、询问回答附件和 `request_user_input` 响应协议不因高亮调整而改变。
- 优点：两种回答方式的已选择语义一致，且不仅依赖颜色；代价：自定义回答使用完整选中行后会增加少量纵向高度。

### ZEUS-0253 询问选项与已回答资源契约

- 待回答选项必须区分推荐态、键盘当前项和真实选中态：推荐态只显示“推荐”标记，键盘当前项使用焦点描边，整行选中表面只表达用户已经选择的答案。
- 普通已回答选项的选择标记和“已选择”按整行高度居中；带资源的自定义回答使用独立顶部状态行，避免选择标记相对高图片居中后失去扫读位置。
- 自定义回答的图片、文件、文件夹和超长粘贴文本均属于回答本体，必须位于同一绿色选中框内并排在回答文字上方；不再作为选项列表后的孤立资源展示。
- 图片点击后使用原生模态层放大查看，并在关闭后把焦点还给触发按钮；其他资源继续经过现有受控桥接打开，不允许 Renderer 绕过可信资源边界直接访问任意本机路径。
- 敏感回答脱敏、纯自由输入语义和 `request_user_input` 响应协议保持不变。
- 优点：推荐、焦点和已选择不会互相冒充，回答资源归属完整且可操作；代价：资源较多时选中框会明显增高，并需要维护普通答案与资源型自定义答案两种内部排版。

### ZEUS-0215 会话标题任务状态修改契约

- 任务列表、任务详情和会话标题的状态入口共用项目任务状态配置、任务 `managementStatus` 事实和统一保存函数；会话标题不得另建状态枚举、颜色映射或写入协议。
- 会话标题下拉提供项目配置中的全部状态，包括承担完成和取消系统角色的状态；选择后继续执行统一的串行保存、版本冲突处理、忙碌保护及终态工作区清理确认。
- 单独修改任务状态不恢复、归档或停止会话，也不改变 Coding Agent 运行状态；“重新打开任务并继续”仍是恢复指定归档会话的独立动作。
- 下拉复用 `ZeusSelect` 的键盘操作、焦点反馈和浮层定位；长标题优先省略，状态控件保持完整可操作。
- 优点：三个入口行为一致，项目自定义状态只维护一套；代价：标题栏增加一个可聚焦控件，窄窗口中的标题可用宽度会略微减少。

### ZEUS-0169 普通用户询问协议兼容与失败收口契约

- `request_user_input` 的核心身份、问题集合和答案结构继续严格校验；Provider 新增且类型合法的可选元数据不得仅因字段集合变化而使整个询问失败。
- 当前 Provider 的可选 `isBlocking` 字段只表达询问阻塞提示，不改变 Zeus 的单一交互区规则；字段存在时必须是布尔值，未知字段仍保持失败关闭。
- 询问无法安全解析时，Zeus 必须结束当前异常轮次并显示局部失败原因；不得把会话、后续队列或输入区升级为“需要恢复”，也不得挂载新会话输入框。
- 待回答询问存在时只显示专用问题选项和自定义答案入口；普通会话输入框暂时隐藏，所有回答继续绑定原请求、原轮次和原会话。

优点：兼容协议的向后扩展，同时保留问题身份和答案校验；异常不会再拆分会话。代价：真正未知的询问结构仍需中断当前轮次，不能猜测字段含义或伪造答案。

### ZEUS-0266 普通用户询问答题快捷键契约

- 普通用户询问首次出现后保留一秒答案快捷键保护期；期间不允许任何键盘操作选择或提交预设答案，也不得在保护期结束后补发按键。
- 保护期结束后，只有无 `Command / Control / Option / Shift` 修饰的 `1`、`2`、`3` 可以直接提交对应预设答案；上下方向键只移动键盘当前项，Enter 只提交键盘当前项。
- 空格、字母、标点及其他非答题按键聚焦在答案按钮上时不得触发按钮；特别要覆盖原生按钮使用空格生成点击的默认行为。
- Tab 继续按文档顺序移动焦点；询问自由输入状态中的 Escape、空格和文字编辑保持既有语义，不受预设答案白名单限制。
- 鼠标点击是明确选择，从询问出现起立即生效，不等待键盘保护期；保护期不改变焦点样式、问题协议、答案内容或提交忙碌状态。
- 优点：普通输入过程中最常见的空格不会再误选首项，Enter 和数字键在异步切换瞬间也有一秒缓冲，同时保留完整键盘导航与立即鼠标选择。代价：固定一秒不能覆盖持续更久的输入，用户在一秒后输入 `1`、`2`、`3` 仍可能直接提交，且想立即键盘回答的用户需要短暂等待。

## ZEUS-000041 会话队列消息气泡契约

- 队列消息是 Zeus 已保存、模型尚未接收的用户输入；气泡出现不等于模型已经收到。
- 队列消息只在对话记录底部显示一次，不再同时出现在独立底部队列面板；它必须排在当前仍在生成的回答之后，禁止插入上一轮回答中间。
- 气泡常驻显示“排队中”；provider 确认接收后才移除该状态并转为普通用户消息。
- 编辑、删除、立即发送、上移和下移在气泡 hover 或 focus-within 时显示；键盘用户必须能完成全部操作，拖动不得成为唯一排序方式。
- 队列暂停或 provider 归档时继续使用同一气泡表达，并提供真实的继续或恢复动作，不允许为收敛视觉而丢失恢复能力。
- 队列状态变化必须由持久 submission 与 provider 轮次事实同步驱动；进入 provider 轮次后要立即广播队列变化，不能只靠下一次完整快照修正。

优点：同一内容只出现一次，时间顺序和 provider 事实一致，用户能清楚区分本机接收与模型接收。

代价：队列操作进入对话气泡，Renderer 必须协调临时气泡、实时队列快照和 provider 用户消息三种投影。

## TASK_20260730_003 应用菜单检查更新契约

- macOS 应用菜单的 `Check for Updates...` 和 `Command+U` 必须直接触发真实 Release manifest 检查，不能只跳转设置页；
- Main 只负责恢复窗口并发送受限单向事件，Renderer 继续复用现有 `/api/release/check-update`，禁止建立第二个更新事实源；
- 弹窗必须覆盖检查中、已是最新、发现更新和检查失败，并展示真实当前版本、最新版本与匹配产物；
- 未签名或未公证的产物只能提供“打开下载页 / 取消”，下载页必须经过 Main 的 HTTPS URL 复验；
- 只有 `automaticInstallEnabled=true` 且 `recommendedAction=download_and_install` 时才能显示下载并安装动作；后端拒绝时必须显示真实原因，不能把预留接口伪装成已开始升级；
- 检查开始前 Renderer 尚未完成 bootstrap 时，Main 必须按窗口保留一次待处理请求，并在该窗口就绪后投递；窗口关闭时清理；
- 弹窗复用 `ModalPortal`、`Button` 和 Zeus 主题 token，支持键盘焦点、窄窗口和 reduced-motion。

### 正式任务与项目对话的领域边界（2026-07-17）

- **正式任务**是 Zeus 的可调度工作对象：持久化于 `tasks`，具有任务编号、状态、权限初值和任务事件。任务分组旁的 `+` 创建 `owner.kind = task` 的会话，`conversations.task_id` 指向该任务。
- **项目对话**是用户在当前项目中直接发起的自由对话：不创建 `tasks`，不写 `task_events`，`owner.kind = project`，`conversations.task_id IS NULL`。用户的第一条消息只是会话输入，不是正式任务描述。
- 两类会话复用同一套持久 thread/turn、排队、审批、恢复、附件和幂等机制；所有者只决定归属、列表结构、首发接口与权限初值，不能把项目对话静默绑定到已有任务。
- 会话树把项目对话直接列在项目下，把任务会话列在对应任务分组下；禁止为项目对话伪造任务分组。即使项目没有正式任务，会话页仍显示底部 composer，并可创建与续接项目对话。
- “新对话”和 `Cmd+N` 面向当前项目创建项目对话；任务分组 `+` 继续创建任务会话。会话工作区的可访问名称与用户文案只表达产品语义，不暴露 app-server 等实现术语。
- 若本例外与本文件其他通用视觉条款冲突，在 `.session-codex-parity-v1` 内以本节为准；作用域外仍以 Zeus Design Contract v2 为准。

## ZEUS-000009 任务首发内容契约

- 正式任务首发的用户输入只包含任务标题、任务描述和任务附件，不拼接 AI Runtime 身份、项目名、项目路径、来源上下文、项目默认提示词或默认执行要求。
- 正文固定显示“任务标题”和“任务描述”；空描述显示“未提供”，不得因省略空值退化为只发送标题。
- 本次推送补充信息属于本次任务描述，合并进“任务描述”字段，不新增独立提示词章节。
- Codex 任务附件继续使用结构化附件 input，并显示独立附件卡片；正文不得复制附件路径、MIME、大小或 JSON。
- cwd、协作模式、权限、sandbox、审批、模型、推理强度和服务档位继续通过已有结构化协议传递，不作为用户消息正文。
- 非 Codex Adapter 没有真实附件协议时必须明确拒绝带附件任务，禁止静默丢失附件或用完整来源 JSON 冒充附件发送。
- 图谱问答不属于任务首发，继续使用带真实节点、边和源码引用的独立上下文组装。

优点：用户消息只表达用户确认的任务内容，附件和运行配置各走真实通道，界面预览与 provider 输入可以直接对账。

代价：项目默认任务提示不再影响正式任务首发；非 Codex Adapter 在补齐真实附件协议前无法执行带附件任务。

## ZEUS-0187 本次推送附件契约

- 用户在“推送到新会话”的补充信息区域粘贴的资源统一称为“本次推送附件”；它只归属于这次新会话首条输入，不写回任务附件，不改变任务更新时间，也不影响后续任务首发。
- 补充信息区域只增加粘贴入口，不增加附件选择按钮或拖放；粘贴语义复用会话输入资源，覆盖截图、图片、文件、文件夹和超长文本物化，普通文字仍进入文本框。
- 本次推送附件显示在补充信息文字框上方，使用完整待提交资源卡；图片可放大、文件和文件夹可受控打开、所有资源可移除，可恢复长文本可以恢复到当前补充信息光标位置。
- 补充文字可以为空；只有本次推送附件时仍允许提交，正文不得自动添加“见附件”等伪造说明。
- 登录、能力刷新、任务上下文重确认和提交失败必须保留本次推送附件；用户明确关闭弹窗后放弃，重新打开时不恢复长期隐藏草稿。
- 本次推送附件使用会话输入资源根或精确路径授权，不得为了复用任务附件校验而建立无任务归属的任务附件记录；Main 和 Local Server 都必须复验真实路径与授权。
- Renderer 请求只提交位置键、名称、类型、MIME、大小和路径身份；Local Server 必须重新确认数量、位置键唯一性、真实文件或目录、实际大小、可信根和图片签名，任一资源不可用时停止创建会话。
- 任务首发布局快照必须记录本次推送附件的有序元数据，并在弹窗预览、后台创建工作面、Provider 派发和已发用户消息中复用；授权令牌、绝对路径和可恢复长文本正文不得写入布局快照。
- 同一资源在任务字段与补充信息中代表两个用户明确位置，允许分别发送；任务首发输入合并必须按位置键保留，不能按物理路径去重后造成布局位置缺失。
- Codex 与 Pi 使用同一布局顺序；没有真实附件协议的 Adapter 必须明确拒绝，禁止静默丢弃或把路径、MIME、大小和 JSON 拼进补充正文。

优点：临时材料真实进入首条输入但不污染任务长期内容；弹窗、乐观工作面、历史消息与 Provider 输入可以按同一位置键对账；资源授权继续保持本机可信边界。

代价：共享布局、Renderer 草稿、Main 资源打开、Local Server 复验和多 Provider 投影必须同步修改；完整验收需要覆盖多种剪贴板来源、失败保留和真实首轮接收。

## TASK_20260728_001 任务详情关联会话与状态联动契约

- 任务列表“任务状态”和任务详情状态选择器共用 `managementStatus` 事实源；两个入口修改后必须同步刷新，不把 Runtime 生命周期状态伪装成用户可编辑的任务状态。
- 任务详情中的最近事件和事件列表只展示人类可读的标题与时间；事件类型编码只用于系统识别与审计，不作为页面文案展示。
- 任务详情不展示 AI CLI、Runtime 会话、运行命令或 Runtime 状态，也不提供“标记完成”“取消任务”等执行生命周期按钮。
- “已完成”和“已取消”是任务管理状态选项；修改任务管理状态不停止任何会话执行。执行轮次只允许在所属会话的输入区通过停止按钮中断。
- 一个任务可以关联多个会话。任务详情按创建时间从早到晚展示全部未归档关联会话，任务详情自身更新时间、会话最后更新时间和会话阶段更新时间都不参与该处排序；点击后进入会话页并打开所选会话，不在任务抽屉内复制完整对话界面。
- “推送到新会话”是任务详情唯一主操作；它先打开模型、推理强度、工作模式、权限和首条消息确认弹窗，确认后始终以 `mode: create` 创建新会话，不静默复用历史会话。
- 关联会话区域必须覆盖加载、空、失败和有数据状态；历史加载失败不得阻断用户推送到新会话。

## ZEUS-000013 任务内容即时编辑契约

- 任务详情不增加全局“编辑”和“保存”按钮。标题、说明和标签默认按可阅读文本展示，用户点击对应内容后才切换为原生输入控件；优先级与任务管理状态继续使用下拉框并在选择后直接保存。
- 标题失焦或按 Enter 时保存，Escape 放弃本次修改；说明失焦时保存，普通 Enter 只换行，Escape 放弃本次修改。输入期间不得按每次按键请求本机 API。
- 标题只包含空白时拒绝保存并保留编辑态；说明与标签允许清空。标签以逗号或回车分隔，保存前统一去除首尾空白、空值和重复值。
- 附件区域提供独立添加入口。新增附件后立即建立任务附件关联；移除后立即解除关联并提供短时撤销。解除关联不得删除 Zeus 托管文件，也不得破坏既有会话和历史事件对文件的引用。
- 成功编辑只改变任务内容和后续“推送到新会话”读取的任务快照，不重写既有会话消息或正在执行的上下文，不自动改变任务管理状态。已完成或已取消任务仍允许修正任务内容。
- 每个字段保存中必须在当前控件内显示轻量加载状态并阻止重复操作，不展示“正在保存”或“已保存”文字；成功后以字段最终值作为结果反馈。失败或冲突时保留用户输入、明确说明原因并提供重试或载入最新值入口，禁止静默恢复旧值或把本地草稿当成已生效内容。
- 任务更新必须携带用户开始编辑时读取的 `updatedAt`。版本不匹配时本机 API 返回明确冲突，界面保留本地内容，并让用户选择“保留本地内容重试”或“载入最新值”；禁止后写静默覆盖先写。
- 同一界面连续修改多个字段时必须按任务串行提交，并在每次成功后推进下一次请求使用的任务版本，避免本窗口自己的更新彼此制造伪冲突。
- 每次真实变更只记录字段名、标签或附件数量变化和更新时间，不在任务事件中复制完整说明正文或本机附件路径；无实际变化不得刷新 `updatedAt` 或新增事件。
- 任务管理状态切换到完成或取消时继续遵守既有任务 Git 工作区处置门禁；状态下拉是入口，不得绕过提交、推送、放弃或冲突处理流程。
- 输入控件必须覆盖键盘焦点、中文输入法、窄抽屉、保存中、错误和冲突状态；不得用 `contenteditable` 替代输入框和文本域，也不得仅用颜色表达保存结果。

## TASK_20260727_001 会话资源打开与轮次变更契约

本节适用于会话页文件引用、网站与附件资源卡、打开目标、轮次变更卡、Review、Undo 和 Reapply。完整证据、协议、安全设计和验收矩阵见
`docs/TASK_20260727_001_Codex会话资源打开能力完全对齐设计.md`。

### 资源语义

- 会话内容中的文件、网站、附件和轮次变更必须先归一化为带 `projectId / conversationId / turnId / sourceItemIds` 的类型化会话资源；Renderer 不得凭任意 `href` 或绝对路径直接获得本地打开权限。
- 普通 GitHub 等网页引用保持行内链接；只有 provider 明确声明的网站产物、模型生成预览或结构化资源才使用独立资源卡，禁止把每个 URL 都放大成卡片。
- 文件引用显示文件类型图标、basename 和可选 `(line N)` / `(lines N–M)`；完整项目相对路径进入 tooltip 与可访问描述，真实绝对路径不作为普通界面主文案。
- 文件打开必须保留行、列或行范围语义；`shell.openPath` 不支持精确位置时，不得把“已打开文件”描述成“已跳到对应行”。
- 网站和附件卡共用资源卡结构，但主操作、打开方式菜单和整行点击热区必须是独立语义控件，禁止嵌套按钮或用绝对定位点击层遮挡菜单。
- 资源卡必须受所属消息容器的内容宽度约束；长文件名或标题优先省略，不能把固定的“打开方式”动作推出用户消息气泡，也不能用裁切父气泡掩盖真实溢出。

### 打开目标

- 会话资源统一通过受信 `ConversationResourceRouter` 和 Main Resource Broker 打开；Main 必须复验发送窗口、资源归属、路径包含性、符号链接、文件存在性、URL scheme 和目标 handler。
- 网站资源支持 Zeus 内置浏览器、外部浏览器和复制链接；普通 URL 与本地 URL 分别保存默认打开偏好。
- 文件资源支持 Zeus 源码预览、可用编辑器、系统默认、Finder 和复制路径；一次性“打开方式”选择默认不改变长期偏好。
- 选择 Zeus 浏览器时必须使用资源所属 `conversationId` 打开标签，保留左侧会话记录与 composer，不创建第二个 Zeus 窗口。
- 自定义文件处理器使用结构化 argv，不通过 shell 字符串拼接路径、行号或用户输入。

### 会话上下文工作面

- browser、plan、source 和 turn diff 是同一个会话上下文工作面的互斥内容类型；同一时刻只能有一个右侧工作面，切换内容不销毁会话历史或 composer。
- 右侧内容共享分隔条、宽度、展开、恢复、关闭、焦点恢复、窄屏和 reduced-motion 规则；不得为 Review 或源码预览再叠加一套抽屉壳。
- `Cmd+W` 按活动层级关闭：右侧上下文工作面活动时关闭其当前标签；浏览器多标签只关闭当前标签，最后一个标签关闭后收起右侧工作面；源码预览、计划和轮次审查关闭当前唯一标签后收起。焦点不在右侧工作面时继续关闭 Zeus 当前窗口。
- Review 必须读取持久化的执行轮次变更集，不能调用当前项目或任务的全局 Git diff 冒充本轮结果。

### 轮次变更卡

- 只有真实存在文件变化时显示；卡片属于对应 assistant 轮次尾部，不降级为普通“工作活动”文本。
- 头部显示“已编辑文件 / 已编辑 N 个文件”、增删行统计、Review 和 Undo / Reapply；hover 或 focus 时提供“查看更改”反馈。
- 多文件默认显示前三个文件，剩余文件通过“再显示 N 个文件”展开；大文件和二进制文件必须显示真实降级说明。
- 后续工作区修改不得改变这张卡所表达的原轮次 diff；如果当前文件已经继续变化，卡片和 Review 必须提示，而不是把新修改混入旧轮次。

### Undo / Reapply

- Undo / Reapply 只对完整执行轮次变更集生效，不提供部分 hunk 操作；它们不执行 `git reset`、`git revert`、`git checkout`、commit、push 或其他 Git 历史动作。
- Undo 前必须确认当前文件匹配轮次 post-image；Reapply 前必须确认当前文件匹配 pre-image。任一文件不匹配时全部停止，不允许部分写入或强制覆盖。
- 文件写入必须先完成全量预检，再通过恢复 journal、临时文件和失败回滚执行；应用崩溃后必须恢复到可解释的 `applied` 或 `undone`，不能让 UI 成功状态与磁盘部分写入并存。
- 状态至少覆盖 `applied / undoing / undone / reapplying / conflicted / unavailable`；冲突时保留 Review、冲突文件和复制补丁，禁用危险写入。
- Undo 成功后按钮变为 Reapply；Reapply 成功后恢复 Undo。按钮点击本身是与当前 Codex 对齐的明确用户动作，不额外增加阻塞弹窗，但必须有忙碌、成功、失败、冲突和不可用反馈。

### 视觉与验收

- 会话页继续受 `.session-codex-parity-v1` 视觉例外约束，以当前 Codex `26.721.41059 (5848)`、用户截图和正式包同状态并排比较为最终视觉依据；设计阶段不得用猜测像素固化未经测量的值。
- 文件引用、资源卡、变更卡、打开方式菜单和 Review 必须覆盖浅色、深色、长路径、窄窗口、键盘、VoiceOver、high contrast 和 reduced-motion。
- 完成判定必须包含 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`、正式包健康与签名检查，以及单一正式 Zeus 实例中的真实文件、网页、Review、Undo、Reapply 往返；静态检查或 mock 页面不能替代运行验收。

## TASK_20260728_003 命令中心设计契约

### 产品与数据边界

- Zeus 命令中心只提供通用命令定义、确认、执行、历史、日志、产物和 Telegram 入口；Git 批处理、微信开发者工具与 `agents-sync` 始终是用户脚本，产品默认和数据库迁移不得注入任何命令。
- `command_definitions` 保存全局或项目命令及其完整执行契约，`command_aliases` 单独维护查询标识，`command_runs` 保存命令快照并关联 Runtime session，`command_artifacts` 只登记执行产物目录中的真实文件。
- 全局名称或别名与任意项目命令冲突；项目命令与全局及同项目命令冲突，不同项目之间允许同名。删除命令采用软删除，执行历史继续依赖快照审计。
- 数据导出 schema v2 包含命令定义，但不包含脚本文件、确认、执行、日志或产物；schema v1 继续可导入。所有导入命令强制停用并关闭 Telegram 权限。

### 执行与安全

- 全局命令与项目命令都在本次用户选择项目的真实 `localPath` 中运行；禁止回退到 Zeus 应用源码根。Generic Shell 使用同一项目根判断。
- 项目必须显式开启 `allowShell`；声明 `gitWrite` 的命令还必须显式开启 `allowGitWrite`。命令创建、导入或展示不得自动修改项目权限；用户点击运行而权限不足时，桌面端必须先用独立弹窗说明持久化影响，只有用户点击“开启并继续”才保存本命令所需权限，随后进入本次运行确认且不得自动执行。
- 每次执行先创建一次性确认。确认绑定命令 revision、项目 ID、真实 cwd 和完整参数摘要；命令更新或删除、项目目录或参数变化、确认过期以及应用重启都会拒绝执行。
- 普通命令和高风险命令都必须逐次明确确认；`gitWrite`、`outsideProjectWrite` 或 `externalServiceWrite` 任一为真时，确认弹窗使用高风险摘要和危险操作语义，但桌面端与 Telegram 均不得要求额外输入确认短语。拒绝仍形成可审计的执行记录。
- 参数只允许声明式字符串、数字和布尔环境变量，禁止 `ZEUS_*` 键。敏感值不进入 `command_runs.parameter_snapshot_json`、Runtime 持久日志或审计 payload，并在日志回调进入持久层前按精确值脱敏。
- Zeus 注入 `ZEUS_PROJECT_ROOT`、`ZEUS_COMMAND_SCRIPTS_DIR`、`ZEUS_COMMAND_RUN_DIR`、`ZEUS_COMMAND_ID` 与 `ZEUS_COMMAND_RUN_ID`；用户脚本根和执行产物根由 Electron 实际 `userData` 运行时解析，产品代码不硬编码用户目录。
- 超时先向独立 Runtime 进程组发送 `SIGTERM`，三秒后仍未退出则发送 `SIGKILL`；应用关闭时不得清掉强杀定时器后留下孤儿进程。成功、失败、超时、取消与拒绝保持不同终态。
- `ZEUS_ARTIFACT_FILE=<path>` 只接受本次 `command-runs/<runId>` 物理目录内的真实普通文件；读取和 Telegram 回传前再次执行真实路径与文件类型复验。

### 桌面端与 Telegram

- 项目命令入口位于代码工作区右上角，切换后使用完整主工作区合并展示全局与当前项目命令；全局行只读，项目行可维护。页面以命令列表为主路径，定义维护、权限开启和运行确认使用居中 ModalPortal 弹窗；公共执行历史不得继续占用页面底部，每行使用独立历史按钮打开“当前命令 + 当前项目”的居中历史弹窗，保留记录列表、运行详情、实时日志、停止与产物，确认运行后自动打开并选中新记录。全局设置页不汇总跨项目历史，不使用侧边抽屉。
- 全局设置“命令”分类维护全局命令；定义表单必须覆盖别名、说明、超时、启停、Telegram、三类风险及声明式参数，不为 Git 或微信增加专用字段。
- 运行确认弹窗在确认前同时展示命令文本、项目目录、参数、超时和风险；执行后自动进入对应命令的历史弹窗，展示持久状态、Runtime 终端日志和产物，图片产物可以按受控内容 API 预览。
- 项目配置中的 Shell 与 Git 写入使用紧凑原生复选框；事件值必须在状态更新前同步读取，禁止在函数式状态更新器中继续访问 React 事件对象，避免交互触发渲染崩溃。
- Telegram `/commands [项目]` 先选择项目，再展示全局与项目命令合并菜单；只显示命令自身 Telegram 开关已开启的项。定义维护仍只在桌面端完成。
- Telegram 执行复用本地命令 API 的权限、确认、风险和 Runtime 路径，不另写旁路执行器，也不使用高风险确认短语；按钮回调严格限制在 Bot API 的 64 字节内，状态优先编辑原消息，终态回传已复验产物。

## TASK_20260731_001 任务 Git 工作区、提交与代码交付契约

### 任务开发线

- Zeus 任务编码统一使用 `ZEUS-0001` 起步的项目内递增形式；数字部分最少四位，不足时左侧补零，序号超过四位后按实际位数显示。旧的 `ZEU-000001` 和六位 `ZEUS-000001` 按原任务序号迁移，不改变项目内顺序；已经存在的 Git 分支、worktree 目录、提交说明和历史文档引用保持原样。
- 任务推送到模型前必须选择“创建新的任务分支”或“使用该任务已有分支”。新分支统一使用 `zeus/` 前缀，并通过 `git check-ref-format --branch` 校验；前缀后的名称不得再套用 ASCII 字符白名单。
- 来源分支必须是主仓库中的真实本地命名分支，其合法性由 `git check-ref-format --branch` 与本地 `refs/heads` 存在性共同判定，不能用 ASCII 字符白名单拒绝 Git 合法名称；任务工作区必须绑定一个真实远端，优先使用 `origin`，否则使用仓库首个远端。
- 任务开发分支与会话不是一对一关系。一个任务开发分支可以被多个新会话依次复用，但同一 worktree 同时只允许一个可写 Codex turn。
- 主工作区保持用户当前分支，不因任务推送而切换。任务会话的 `cwd` 指向独立 worktree；该身份同时写入任务工作区记录、会话记录和持久 submission context，应用重启后仍从同一目录恢复。
- 会话页在 Runtime 用量摘要下一行常驻显示会话持久 `cwd` 与该目录实时读取的 Git 分支；任务会话缺少持久 `cwd` 和工作区证据时显示“不可用”，不得用项目主路径、任务分支记录或提示词中的路径替代真实执行现场。
- worktree 默认位于仓库同级的 `.zeus-worktrees/<project>/<task-code>/<workspace-id>`。同一分支若已有已注册 worktree 必须复用，不得再创建第二个写工作区。
- 同一任务第一次创建分支时记录来源分支和精确来源提交；后续新开发线继续使用这组基线。主工作区未提交变更不进入任务分支，界面必须明确提示。

### 任务终态与 worktree 回收

- 会话结束不回收 worktree；worktree 生命周期跟随 Zeus 任务。
- 任务切换到“已完成”或“已取消”前，必须逐一处置所有任务开发分支。仍有活动会话时先停止活动 turn 和排队提交。
- 保留分支时，用户在 IDEA 风格提交窗口中选择文件、审查差异、填写提交说明并提交。任务完成入口以“提交并推送”为主操作。
- 有代码变化的分支只有在远端分支提交与本地 HEAD 精确一致后才能回收 worktree；没有代码变化的分支可以在干净且 HEAD 等于来源提交时直接回收，不创建空提交。
- 放弃分支必须输入完整分支名确认，只删除任务 worktree 和本地分支，不自动删除远端分支。
- 任一分支处置失败时任务管理状态保持原值；不得先标记完成再后台清理。

### 提交审查

- `Cmd+K` 在当前任务会话存在任务工作区时打开完整提交窗口。窗口包含任务分支列表、可勾选变更树、逐文件双栏差异、真实 Git 上游信息、提交说明和提交操作。
- 勾选路径在提交动作发生时通过受控 `git add -A -- <paths>` 写入 index；提交前拒绝未解决冲突，活动会话只展示风险提示，不再阻止提交。
- 普通入口提供独立的“提交”和“推送”；代码交付入口允许按需重复提交和推送，任务分支推送是协作与备份动作，不是合入前置条件。
- 右侧提交检查区只展示项目真实配置的检查。没有配置时明确显示“未配置”，不得伪造 IDEA 检查项。

### 代码交付入口与任务状态

- 代码交付入口由任务开发线是否存在决定，不受任务管理状态限制；“待办”“开发中”“测试中”“已完成”等状态都不能隐藏提交、推送、校验、回收或合入所需入口。
- `ready / failed` 分支在代码交付中显示真实分支名和“审查并准备交付”，复用完整提交审查流程处理活动会话提示、变更选择、提交、推送、远端校验和 worktree 回收，完成后返回同一代码交付上下文。
- `reclaimed` 分支显示合入目标与方式；`merged` 分支显示已交付状态，并允许在不同目标分支存在时继续形成独立交付记录；`discarded` 分支保留只读事实，不提供合入动作。
- 内部 TaskWorkspace ID 只用于 API 和持久关联，不得作为“任务分支”标签、空选项兜底或用户错误提示展示。
- 服务端只以真实 Git 状态、目标分支并发变化、远端一致性和嵌套 worktree 顺序执行必要保护；活动会话和任务分支是否已推送不属于 Git 操作闸门。界面仍须把真实错误本地化展示，不能静默忽略失败。

优点：用户可以在任意任务阶段完成代码处置，手工提交或推送后的分支也有明确恢复路径，任务管理状态保持纯粹的进度语义。

代价：代码交付入口需要编排提交审查和合入两个弹窗，并在返回时重新读取真实工作区状态；活动会话继续写入时，提交后的内容可能需要再次提交，回收或丢弃前必须明确提示工作区风险。

### 显式代码交付与冲突

- 任务完成不自动合入来源分支。任务详情展示轻量代码交付状态，并由用户显式打开“代码交付”。
- 默认使用 merge 保留任务提交历史，也允许用户选择 squash。已推送的任务分支不提供隐式 rebase 或历史重写。
- 简单合入在隔离 integration worktree 中准备候选结果；无冲突时重新校验主工作区仍位于目标分支、HEAD 未变化且工作区干净，再快进、推送并校验远端。
- 目标可选择记录的来源分支或主工作区当前分支。只有合入记录的来源分支才标记“已交付到来源”；合入其他分支只记录该次目标。
- 冲突保留隔离 integration worktree 和持久 integration 记录，应用重启后可以继续。三方编辑器左侧是目标分支，中央是可编辑结果，右侧是任务分支。
- 用户可以采用来源、采用任务、两者都采用或手工编辑结果。“AI 处理”必须由用户显式触发；点击后把当前草稿写入隔离 integration worktree，立即打开专用可写会话，由 AI 解决并暂存全部冲突。轮次结束后 Zeus 复验任务与目标 HEAD，在安全时生成合入提交并只同步本地目标分支；不自动推送，是否推送继续由用户单独决定。
- 冲突未全部解决、主工作区状态变化或远端校验失败时禁止推送并保留可恢复现场。

完整实现范围、取舍、接口和验证记录见 `docs/TASK_20260731_001_Zeus任务Git工作区提交合入与冲突处理.md`。

## ZEUS-0107 任务提交说明建议值契约

- 任务代码提交的默认说明根据任务类型生成：需求使用 `feat`，缺陷使用 `fix`，优化使用 `perf`。
- 默认格式固定为 `前缀: 任务编码 任务标题`；提交审查与代码交付中的任务代码提交入口必须使用同一规则。
- 默认说明是可编辑建议值，用户可以在提交前修改；服务端仅在请求未提供有效说明时使用同一建议值兜底。
- 代码交付合入提交继续表达合入动作，不套用任务类型前缀，避免把任务内容与分支合入语义混为一谈。

优点：提交历史能直接按工作目标检索，多个入口和服务端兜底保持一致。

代价：优化任务固定使用 `perf`，即使个别优化实际属于代码整理，也不会自动改成 `refactor`。

## TASK_20260731_003 长任务无损升级执行宿主契约

- Electron Main 只拥有窗口、菜单、BrowserHost 和界面租约；Local Server、SQLite、Coordinator 与 app-server 由独立执行宿主持有。
- 执行宿主是业务数据库唯一写入者。新界面必须先发现并连接现有宿主，禁止连接失败后直接创建第二写入者。
- 宿主 rendezvous 只允许当前本机用户读取，文件权限固定为 `0600`，端点只能监听 `127.0.0.1`，控制请求必须携带随机凭据。
- 界面租约失效不等于最终退出。有活跃轮次、等待交互、命令或 Runtime 时宿主继续运行；无活跃工作并经过空闲宽限后才可自行回收。
- 普通退出存在活跃工作时必须提供“退出界面，任务继续运行”“停止任务并退出”“取消”；状态无法确认时优先保护执行。
- BrowserHost 通过可重连本机桥提供能力。界面离线期间等待新租约，不立即把工具调用标记为永久失败，也不自动重放可能产生副作用的动作。
- Codex CLI 完全依赖用户本机安装。Zeus 优先使用用户显式配置的绝对路径，否则从当前 PATH、常见本机目录和登录 Shell
  发现真实可执行文件；不复制、不缓存、不随包分发，也不保留内置回退。新 Codex 进程世代只接收新线程和空闲线程，活动线程与待交互请求固定在原世代自然排空。
- 协调器以“generation 是否仍存活”判断请求权威，不以“是否最新”判断；任何旧 submission 都不得跨世代自动重发。
- 更新弹窗必须展示宿主模式、真实活跃工作数量、运行时世代总数和排空世代数。packaged App 只能通过 Main 的受限 IPC 下载和安装；浏览器/开发环境的 Local Server 安装入口保持 fail-closed。
- Release manifest 必须包含执行宿主协议版本。自动安装只接受签名、公证、协议兼容且摘要完整的产物；生产下载地址只能来自受信任 GitHub Release 域名。
- 安装辅助进程必须先完成就绪握手，再允许旧 Main 以 `upgrade_handoff` 退出；它只替换 App bundle，不终止执行宿主，不迁移或重放已有执行轮次。
- 普通会话草稿沿用本机恢复机制；敏感请求回答不得持久化，Renderer 必须把“存在敏感草稿”作为仅含 request ID 的窗口级门禁上报 Main，存在时拒绝安装。
- 新 App 启动后必须以预期应用版本重新连接原宿主才算安装完成；启动或回连失败时先终止失败的新版 Main，再回滚 App 并自动重开旧界面。只有不同于失败新版租约的旧版 UI 租约重新连接宿主后，才能写入 `rolled_back`。
- 旧宿主自身版本与已接管 UI 版本必须分开记录；Release 更新判断使用当前 UI 租约版本，不能继续从旧 App 包推断当前版本。
- 旧执行宿主可能仍从旧 App 备份运行，因此备份在宿主存活期间保留；最终退出关闭宿主后，Main 只清理名称带受控事务 UUID 的旧 App 备份。
- 计划内升级主链路的实现完成不等于正式分发验收完成。没有真实 Developer ID、公证产物以及 Codex/BrowserHost 全场景证据时，必须继续明确这些验证缺口。

完整设计、实现证据、未完成边界和验收记录见 `docs/TASK_20260731_003_Zeus长任务无损升级设计.md`。

## TASK_20260803_005 多运行内核公共框架界面契约

- Codex 与 Pi 是两套明确区分的 Agent；未来通过 Pi 使用 Kimi 时必须显示为“Pi Agent · Kimi”，不得用模型品牌冒充原生 Agent
  身份。
- Agent、模型供应源和具体模型是三个独立字段。现有 `provider` 只作为兼容数据，新增界面不得继续从一个字段推断三层身份。
- Agent 能力区分 `supported / unsupported / unverified`；只有真实版本和真实运行证据才能进入 `supported`
  ，模型名称、公开文档和静态代码不能替代证据。
- 普通 Agent 目录只展示明确允许用户看到且状态为 `verified` 的 Agent。`framework_only` 的 Pi 默认隐藏，不显示“即将推出”、灰色模型选项或不可执行入口。
- 当前任务推送、新对话和会话续接的用户路径保持 Codex 行为；公共框架改造不得改变 Codex 的模型、服务档位、权限、协作模式、排队、审批和恢复语义。
- Codex 专有控件只依据当前会话能力证据显示；Pi 后续没有完成同名能力验收时直接隐藏或说明真实边界，不能用禁用占位制造一致性。
- 已有会话根据持久 Agent 身份路由，界面选择模型不能在同一个原生会话中静默切换 Agent。跨 Agent 必须创建新产品会话并明确来源。
- 普通错误文案使用 Agent 和模型供应源的产品名称，不向用户暴露 RPC、JSONL、generation 或内部适配器类名；诊断区可以在脱敏后显示这些技术事实。
- Pi 真实模型开放前，普通设置、任务推送弹窗、新对话输入区和模型选择器不得出现 Grok、Kimi、DeepSeek 或 GLM 的假目录。

优点：用户始终能理解真实执行方式，公共会话界面不会掩盖 Agent 差异，也不会提前制造多模型已支持的错觉。

代价：能力可见性必须由统一目录和证据快照驱动；同一个模型未来存在 Pi 与原生两种接入时，界面需要同时表达 Agent 和模型来源。

完整开发设计见 `docs/TASK_20260803_005_Zeus多运行内核公共框架开发设计.md`。
# Zeus Design Context

## 设计基调

Zeus 是生产力工具，不是营销页面。界面采用克制、清晰、可信的 macOS 产品 UI：左侧导航、顶部状态区、主工作区、右侧上下文信息按需出现。

## 物理场景

资深开发者在夜间或白天的 MacBook/外接屏上长时间使用 Zeus 理解项目与调度任务，界面需要低疲劳、高可读、信息密度适中。

## 信息架构

- 主导航覆盖 Dashboard、Projects、Tasks、Code Map、Sessions、Git Changes、Telegram、Settings。
- Dashboard 展示真实项目、最近任务、最近会话、最近变更、代码地图状态、接口/表/模块/风险/执行统计；没有真实数据时显示空态，不显示演示项目。
- Projects / Project Detail 以真实本地目录、Git root、项目配置、扫描状态和图谱状态为中心，不把不存在的路径写成已连接。
- Tasks / Task Detail 以任务管理状态、任务要求、关联会话索引和事件时间线为中心；执行控制留在会话中，不展示任务级 Runtime 控件或假执行进度。
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
- Apple signing / notarization 未配置时只声明 unsigned DMG，不把产物伪装成已签名正式发布。
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
  button:
    purpose: "文字按钮统一使用类型化原语表达主操作、次操作和危险操作，不借用其他页面样式。"
    tokens: ["--zeus-control-bg", "--zeus-control-border", "--zeus-control-focus", "--zeus-control-danger-bg", "--zeus-control-danger-line", "--zeus-control-danger-text"]
    variants: ["primary", "secondary", "danger"]
    sizes: ["compact", "regular"]
    states: ["default", "hover", "active", "focus-visible", "disabled", "loading"]
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
    purpose: "代码页图谱模式的主角，承载真实系统架构图、接口时序图、模块流程图和方法逻辑图。"
    tokens: ["--zeus-graph-canvas-bg", "--zeus-graph-canvas-line", "--zeus-graph-canvas-source-bg", "--zeus-graph-canvas-source-text"]
    layout: "画布优先，检查器独立滚动；大图谱允许画布内部滚动，不压扁节点。"
    states: ["empty", "scanning", "completed", "stale", "failed", "oversized", "project-mismatch-blocked"]
  popover:
    purpose: "项目更多菜单、图谱节点菜单、轻量设置菜单。"
    tokens: ["--zeus-popover-bg", "--zeus-popover-line", "--zeus-popover-radius", "--zeus-popover-item-hover-bg"]
    interaction: "Escape 关闭，外部点击关闭，动作执行后关闭，焦点返回触发器；方向键在菜单项间移动。项目更多菜单提升到应用壳层，位于触发按钮右侧并顶部对齐，间隔 6px。"
    layout: "项目更多菜单使用 208px 宽、12px 圆角、6px 内边距和 32px 图标行；菜单项按置顶、Finder 定位、重命名、移除排列，hover 与 focus-visible 共用中性低对比底色。"
    states: ["closed", "open", "hover", "keyboard-navigation", "disabled-item", "danger-confirmation"]
  modal:
    purpose: "创建任务、推送模型、布局确认和重命名等阻断式表单弹窗。"
    tokens: ["--zeus-overlay-backdrop-bg", "--zeus-overlay-backdrop-filter", "--zeus-solid-surface-bg"]
    interaction: "portal 根层透明；统一 backdrop 负责遮罩、虚化与空白关闭；Escape 关闭并恢复焦点。"
    states: ["closed", "open", "submitting", "error"]
  drawer:
    purpose: "项目设置、图谱详情、任务详情和安全确认的二级信息层。"
    tokens: ["--zeus-overlay-backdrop-bg", "--zeus-overlay-backdrop-filter", "--zeus-drawer-surface-bg", "--zeus-drawer-line", "--zeus-drawer-section-bg", "--zeus-drawer-action-bg"]
    interaction: "打开时 autofocus，Escape 关闭，关闭后恢复焦点；不作为主路径首选。标题和内容共用单一纯色表面，不用灰度标题条或装饰横线分割。"
    states: ["closed", "opening", "open", "closing", "error"]
  solid-form-surface:
    purpose: "重命名、创建任务、推送模型等表单型弹窗，以及设置页和项目设置抽屉。"
    tokens: ["--zeus-solid-surface-bg", "--zeus-solid-surface-edge", "--zeus-solid-surface-section-gap", "--zeus-form-action-height", "--zeus-form-action-font-size", "--zeus-form-action-padding-inline"]
    layout: "标题、正文、动作区使用同一底色；桌面弹窗水平边距 20px，靠留白与文字层级分组。输入、选择、危险确认和焦点环保留功能轮廓。表单底部保存、创建和取消动作统一为 32px 高、13px 字号与 14px 水平内边距；右上角关闭按钮维持紧凑尺寸。"
    states: ["default", "focused", "submitting", "error", "danger-confirmation"]
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
- 任务页、代码页、设置页和会话页可以共享控件语言，但不能共享错误的信息架构：任务页以任务列表为主角，代码页默认以目录树和源码编辑器为主角，图谱与命令在代码页内整页切换，设置页以偏好设置分组为主角，会话页才允许会话列表加详情。
- 外部设计系统只能作为结构与表达方式参考，不能把其品牌资源、品牌色、字体或 token 名称复制到 Zeus。

## 交互原语执行契约

- `Button`、`Select`、`ModalPortal`、`Drawer`、`SourceListRow` 是五类独立原语，不合并为万能组件。
- 原语组件统一拥有 DOM 结构、键盘语义、hover、focus、selected、disabled、动效和 reduced-motion；业务页面只提供内容并选择显式变体。
- `Button` 使用 `primary / secondary / danger` 语义变体和 `compact / regular` 尺寸；三种变体统一高度、字号、圆角、内边距、可见边框、焦点环、禁用和忙碌状态。危险按钮必须使用危险色边框与危险色焦点环，深色模式不得退回普通按钮的浅色描边。业务页面不得借用其他页面按钮 class，也不得为单个弹窗重写危险按钮皮肤。
- `Select` 的尺寸使用 `compact / regular / roomy` 组件属性，不通过父页面选择器推断。
- `Select` 展开层必须通过 portal 提升到应用壳层，并按触发器的视口坐标固定定位；浮层首次可见时就必须达到最终宽度，至少与触发器等宽，并按本次打开时的完整选项内容自适应宽度，禁止先窄后宽或延迟横向跳动。宽度测量必须先进入不可见的内部测量态，解除选项行百分比宽度、文字裁切和网格弹性列的约束，再恢复正常布局并应用最终宽度；最大不超过视口安全边界，触发器和业务布局不得随浮层变宽。下方能完整容纳菜单时向下展开，否则向上完整展开，不比较两侧剩余空间，不因视口高度额外压缩菜单；展开层不得留在表单、抽屉或其他滚动容器中扩大 `scrollHeight`，展开前后业务布局尺寸必须保持不变；达到视口宽度上限时只允许选项文字省略，不允许换行或横向滚动。
- `ModalPortal` 是所有阻断式表单弹窗的唯一 body portal 壳层。portal 根层必须保持透明，只有 `backdrop` 可以绘制 `--zeus-overlay-backdrop-bg` 与 `--zeus-overlay-backdrop-filter`；禁止把主题画布色刷到覆盖全窗口的 portal 根层。弹窗 footer 的确认、取消与危险动作必须复用全局 `Button` 尺寸。
- `Drawer` 的形态使用 `floating / sheet`，所有生产抽屉统一使用 `dimmed` 遮罩并消费与 `ModalPortal` 相同的遮罩与虚化 token；禁止任务详情、项目配置或其他业务抽屉恢复透明遮罩。允许的组合由 TypeScript 属性约束，不通过业务 class 名或 `:has()` 推断。
- `SourceListRow` 共享 `--zeus-source-list-hover`、`--zeus-source-list-selected` 和圆角 token，但必须显式选择表面范围：`content` 只包裹身份内容，`fill` 覆盖整行导航目标；项目根行和项目内页面入口使用 `fill`，使项目根行的统一圆角表面包含右侧操作槽。项目根行使用 `--zeus-source-list-root-row-radius: 10px` 与 `30px` 总高，紧凑子行使用 `--zeus-source-list-row-radius: 8px` 与 `26px` 总高。
- `SourceListRow` 外层统一使用 `border-box`，最小高度必须包含自身边框；任务、代码、会话等页面作用域可以切换颜色 token，但不得通过通配盒模型、字体或控件尺寸规则改变全局 source-list 的行高与分组间距。
- 项目根行在类型层禁止 `selected`，只允许 hover、focus、expanded 和 collapsed；selected / current 只用于任务、代码、会话等 nested 导航。所有行的 hover 只使用 `--zeus-source-list-hover`，selected 行悬停时保持 `--zeus-source-list-selected`，不再混合第二种颜色；项目设置与更多图标不叠加独立 hover 底色，只保留独立焦点环。
- `SourceListRow fill` 的可见背景只能由外层行绘制一次，内部主按钮在 hover / active / focus-visible 时保持透明，禁止出现“灰底叠白”。项目设置与更多默认同时隐藏，只在父行 hover、focus-within 或更多菜单打开时出现；图标按钮使用不小于 `26px` 的透明圆形命中区，鼠标悬停以图标变深和轻微缩放反馈，按下时轻微收缩，不绘制独立表面，键盘焦点才显示圆形焦点环。
- 项目更多菜单不得留在侧栏纵向滚动容器的裁剪上下文中；菜单提升到应用壳层后使用触发按钮的视口坐标固定定位，左边缘位于“更多”按钮右侧 `6px`，顶部与按钮顶部对齐。窗口尺寸或项目列表滚动变化时同步锚点坐标，外部点击与 Escape 仍关闭菜单。菜单使用 `208px` 宽、`12px` 圆角、`6px` 内边距、`32px` 图标行与中性 hover；项目移除入口保持中性，只有二次确认进入危险色。
- 项目重命名只更新 Zeus 项目显示名称，不提交或推断新的本地路径；项目存储只在请求显式携带且真实改变 `localPath` 时执行路径唯一性校验，未改变路径的元数据更新不得被历史重复路径阻断。“在 Finder 中显示”由受信 Electron 窗口经 preload IPC 请求 Main 进程，Main 必须复验绝对路径、目录存在性和发送窗口后再调用系统 Finder。
- 表单型弹窗、全局设置与项目设置抽屉共享单一纯色表面 token；header / body / footer 和抽屉 chrome / content 不允许再用不同灰度背景或装饰横线分层。任务详情等局部事实区与底部动作区只能使用 `--zeus-drawer-section-bg`、`--zeus-drawer-action-bg` 等明确语义表面，禁止把透明色与页面底色混合出偏色块。组件间以 `20px` 外边距、标题层级和内容间距建立结构；输入框、下拉、列表、表格、焦点、错误和危险确认的功能边界不在移除范围内。
- 创建任务弹窗只保留字段标签、必要占位、错误和附件操作，不重复解释标题、当前项目或 Runtime 状态；优先级使用 P0 至 P4 的 `ZeusSelect`，默认 P3，P0 只表达处理顺序，不触发执行。
- 应用内 `button / input / select / textarea` 统一使用 `border-box`，全宽输入、选择和文本域的声明宽度必须包含自身 padding 与 border；页面不得用 `content-box` 让控件越过父容器右侧留白。
- `WorkspaceDrawer` 的内容滚动层及其直接业务内容统一使用 `border-box`；内容层声明 `inline-size: 100%` 时，项目设置等页面添加的左右 padding 必须包含在该宽度内，禁止依赖 `overflow-x: hidden` 裁掉超宽内容并伪装成“没有溢出”。
- 表单底部的保存、创建和取消动作统一复用 `32px` 高、`13px` 字号和 `14px` 水平内边距；只放大主要文字动作，不连带放大右上角关闭按钮或改变表单字段密度。
- `WorkspaceDrawer` 统一拥有进入、退出、遮罩、可用宽度和卸载时机：关闭命中层覆盖整个窗口，面板自身阻止关闭事件；正常模式使用可感知的右侧空间位移与 expo 风格 ease-out，关闭由 `animationend` 驱动并保留超时兜底；系统减少动态效果时只允许短透明度过渡。
- 抽屉宽度由 `standard / wide` 和剩余工作区共同计算；外层内容区只允许纵向滚动，横向数据或代码必须在业务内容内部自行提供局部滚动，不得让抽屉壳层出现横向滚动条。
- 新增或修改页面、弹窗、抽屉、菜单和表单时，交付前必须同时检查 `light / dark / system` 三种主题传播、至少一个窄窗口断点、键盘焦点与 reduced-motion。大面积背景、边框、文本和状态不得硬编码纯白、纯黑或只适用于单一主题的色值；body portal 必须在主题切换的当前帧消费同一语义 token，不得要求返回设置页后才刷新。
- 全局滚动条复用 `--zeus-scrollbar-thumb`、`--zeus-scrollbar-thumb-hover`、`--zeus-scrollbar-thumb-active`：轨道透明、默认低对比，交互时逐级增强；业务页面可以调整滚动条尺寸或隐藏特定导航滚动条，但不得重新硬编码颜色。
- 项目列表容器只允许纵向滚动；任务、代码、会话子导航使用缩进和选中态表达层级，不绘制贯穿式竖线。
- 任务页只保留一层两行主工具条；有数据时直接进入表头，不再增加“视图控制”或“默认视图”说明行，加载与错误反馈仍保留语义化状态。
- 任务页主工具条内部按两行组织：第一行左侧只保留不超过 `280px` 的居中占位搜索框，右侧放新任务，不再重复展示项目名、任务计数或全部状态摘要；紧邻列头的第二行左侧固定状态快捷筛选，右侧固定批量、列设置和更多视图动作，禁止再把这些动作混进列头或挤在同一侧。
- 任务页状态快捷筛选固定以“全部、未完成、待开始、开发中、测试中”的顺序呈现；“未完成”是排除任务管理状态 `completed` 与 `cancelled` 的派生视图，不得扩展任务状态枚举或读取 Runtime 状态。
- 状态筛选按项目保存在 App Shell 本机设置中；项目没有合法历史偏好时默认“未完成”，用户显式选择“全部”时必须保存空字符串并与“偏好缺失”区分。只有快捷按钮、清除筛选和查看全部状态等显式用户操作可以改写该偏好，创建任务、图谱转任务、新建对话与普通页面导航不得自动覆盖。
- 任务表数据列头分别提供排序按钮、拖动换位把手和右缘列宽把手；三者命中区和键盘动作独立，禁止用整列头同时猜测点击、拖动与缩放意图。排序必须有升序、降序、未排序文本或图标语义，不能只靠颜色。
- 任务表标题与数据必须各自保持稳定锚点：普通文本列标题和值严格左对齐，时间等数字扫描值严格右对齐，创建时间和更新时间的短标题在列内居中。拖动换位把手不得占用标题的流内宽度；普通文本列把操作区放在尾端，时间列把换位操作区放在首端；时间列排序指示使用独立对称布局槽，排序图标和控件显隐都不能推动标题或数据值各自的锚点。
- 任务表换位把手和列宽把手默认保持视觉隐藏，只在当前列头 hover、focus-within、键盘移动或实际拖动时出现；控件命中区与键盘可达性始终保留。未排序列不显示排序图标，列标题本身继续作为排序按钮并通过可访问名称表达“未排序”。
- 指针拖动任务列时，表头与数据列保持原顺序，只在目标列边缘显示落点插入线；松手后表头与所有行数据一次性落到目标位置并写入布局草稿，取消拖动不改变顺序。拖动预览不得触发保存、项目覆盖或全局设置写入。
- 任务表列显隐、位置、像素宽度和当前排序状态统一形成布局草稿；草稿未保存时在原“更多”位置显示保存入口，离开任务页或退出应用必须允许保存并离开、放弃更改并离开或继续编辑。
- 任务表离开确认必须作为覆盖当前工作区的模态弹窗呈现，保留原任务页背景并阻止后台交互，不得用全屏实色 portal 伪装成独立页面。动作顺序使用“继续编辑、放弃更改并离开、保存并离开”；三个动作统一使用全局 `Button` 原语，放弃操作使用低饱和危险底色与清晰危险边框，保存保持唯一蓝色主按钮。
- 原语样式集中在 `apps/desktop/src/renderer/ui/primitives.css` 并最后加载；页面样式不得重新定义原语的核心状态。

## TASK_20260710_001 会话页任务级视觉例外（2026-07-13）

用户为“Zeus 会话页与真实 Codex native app-server 连续对话”明确选择逐项对齐当前 Codex App 的可见视觉，包括字体、颜色、图标、布局、状态和动效。该决策只在以下边界内覆盖本文件 `quality_gates.must_not` 与本节上一条的外部品牌限制：

- 仅适用于会话页根作用域 `.session-codex-parity-v1`，不扩散到任务页、代码页、设置页或 Zeus canonical token；
- 可以复现当前 Codex App 的可观察颜色值、系统字体栈、尺寸、间距、圆角、图标语义和动效节奏；任务级 CSS 变量使用 `--session-*` 语义命名，不引入或冒充 Codex 内部 token 名称；
- 不复制 Codex bundle 专有源码；未确认授权的品牌图片、字体文件和图标资产不进入仓库，图标使用仓库已有或系统等价资产复现可见语义；
- 仍必须满足真实数据、单一主路径、非卡片堆叠、键盘导航、可见焦点、非颜色状态表达、WCAG 2.2 AA 与 reduced-motion；
- 会话 composer 与完整 thread 内容列共享同一响应式最大宽度和水平 gutter；窗口、侧栏或工作区变化时同步收放，输入正文只驱动 textarea 纵向增长，达到上限后内部滚动；
- Electron 会话 composer 的 textarea 不绘制蓝色内框或聚焦边线，外层保持稳定的中性描边与轻阴影；内部按钮、菜单和强制颜色模式继续提供可见键盘焦点；
- 本例外的实现、视觉证据、当前 Codex App 版本和回滚边界统一记录在 `docs/TASK_20260710_001_Zeus任务创建推送与AppServer连续对话全场景盘点.md`；
- composer 响应式对齐、内容增高和焦点线收敛的本次实现与验收记录在 `docs/TASK_20260725_002_Zeus会话输入框Codex自适应对齐.md`；

## TASK_20260730_001 会话过程态与底部交互坞契约

- Plan 和普通工作模式共用同一过程反馈规则：turn 开始及阻塞请求解决后，在首个新摘要、活动或回答出现前必须显示明确的思考状态；
- 每次 `turn/start` 必须显式请求 `summary: "auto"`，不能假设 app-server 会在省略参数时自动返回可读摘要；
- Renderer 只展示 app-server 的 readable reasoning summary，不把 raw reasoning content 当作过程文案；
- `turn/completed` 必须收敛当前轮次遗留的 `in_progress` 项；若遗留文本是后续完整项的严格前缀，则用结构化 `supersededBy` 标记抑制重复展示，否则保留文本并完成该项；
- 连续工作活动默认收起，运行时只露出最新一项；用户主动展开后才能查看完整命令、读取和输出历史；
- `request_user_input`、计划实施确认、命令、文件、权限和 MCP 请求统一占用 composer 所在的底部交互坞，同一时刻只显示队首请求；
- 交互坞不得进入 transcript 的滚动内容，不得与 composer 同时形成两个主操作区；长内容只能在交互坞内部滚动；
- 动态效果遵循系统减少动态效果设置，取消空间动画时仍必须保留可读状态变化；
- 完整证据、协议边界、取舍和验收记录见 `docs/TASK_20260730_001_Codex过程态与底部交互坞对齐.md`。

## TASK_20260730_003 应用菜单检查更新契约

- macOS 应用菜单的 `Check for Updates...` 和 `Command+U` 必须直接触发真实 Release manifest 检查，不能只跳转设置页；
- Main 只负责恢复窗口并发送受限单向事件，Renderer 继续复用现有 `/api/release/check-update`，禁止建立第二个更新事实源；
- 弹窗必须覆盖检查中、已是最新、发现更新和检查失败，并展示真实当前版本、最新版本与匹配产物；
- 未签名或未公证的产物只能提供“打开下载页 / 取消”，下载页必须经过 Main 的 HTTPS URL 复验；
- 只有 `automaticInstallEnabled=true` 且 `recommendedAction=download_and_install` 时才能显示下载并安装动作；后端拒绝时必须显示真实原因，不能把预留接口伪装成已开始升级；
- 检查开始前 Renderer 尚未完成 bootstrap 时，Main 必须按窗口保留一次待处理请求，并在该窗口就绪后投递；窗口关闭时清理；
- 弹窗复用 `ModalPortal`、`Button` 和 Zeus 主题 token，支持键盘焦点、窄窗口和 reduced-motion。

### 正式任务与项目对话的领域边界（2026-07-17）

- **正式任务**是 Zeus 的可调度工作对象：持久化于 `tasks`，具有任务编号、状态、权限初值和任务事件。任务分组旁的 `+` 创建 `owner.kind = task` 的会话，`conversations.task_id` 指向该任务。
- **项目对话**是用户在当前项目中直接发起的自由对话：不创建 `tasks`，不写 `task_events`，`owner.kind = project`，`conversations.task_id IS NULL`。用户的第一条消息只是会话输入，不是正式任务描述。
- 两类会话复用同一套持久 thread/turn、排队、审批、恢复、附件和幂等机制；所有者只决定归属、列表结构、首发接口与权限初值，不能把项目对话静默绑定到已有任务。
- 会话树把项目对话直接列在项目下，把任务会话列在对应任务分组下；禁止为项目对话伪造任务分组。即使项目没有正式任务，会话页仍显示底部 composer，并可创建与续接项目对话。
- “新对话”和 `Cmd+N` 面向当前项目创建项目对话；任务分组 `+` 继续创建任务会话。会话工作区的可访问名称与用户文案只表达产品语义，不暴露 app-server 等实现术语。
- 若本例外与本文件其他通用视觉条款冲突，在 `.session-codex-parity-v1` 内以本节为准；作用域外仍以 Zeus Design Contract v2 为准。

## ZEUS-000009 任务首发内容契约

- 正式任务首发的用户输入只包含任务标题、任务描述和任务附件，不拼接 AI Runtime 身份、项目名、项目路径、来源上下文、项目默认提示词或默认执行要求。
- 正文固定显示“任务标题”和“任务描述”；空描述显示“未提供”，不得因省略空值退化为只发送标题。
- 本次推送补充信息属于本次任务描述，合并进“任务描述”字段，不新增独立提示词章节。
- Codex 任务附件继续使用结构化附件 input，并显示独立附件卡片；正文不得复制附件路径、MIME、大小或 JSON。
- cwd、协作模式、权限、sandbox、审批、模型、推理强度和服务档位继续通过已有结构化协议传递，不作为用户消息正文。
- 非 Codex Adapter 没有真实附件协议时必须明确拒绝带附件任务，禁止静默丢失附件或用完整来源 JSON 冒充附件发送。
- 图谱问答不属于任务首发，继续使用带真实节点、边和源码引用的独立上下文组装。

优点：用户消息只表达用户确认的任务内容，附件和运行配置各走真实通道，界面预览与 provider 输入可以直接对账。

代价：项目默认任务提示不再影响正式任务首发；非 Codex Adapter 在补齐真实附件协议前无法执行带附件任务。

## TASK_20260728_001 任务详情关联会话与状态联动契约

- 任务列表“任务状态”和任务详情状态选择器共用 `managementStatus` 事实源；两个入口修改后必须同步刷新，不把 Runtime 生命周期状态伪装成用户可编辑的任务状态。
- 任务详情不展示 AI CLI、Runtime 会话、运行命令或 Runtime 状态，也不提供“标记完成”“取消任务”等执行生命周期按钮。
- “已完成”和“已取消”是任务管理状态选项；修改任务管理状态不停止任何会话执行。执行轮次只允许在所属会话的输入区通过停止按钮中断。
- 一个任务可以关联多个会话。任务详情按创建时间从早到晚展示全部未归档关联会话，任务详情自身更新时间、会话最后更新时间和会话阶段更新时间都不参与该处排序；点击后进入会话页并打开所选会话，不在任务抽屉内复制完整对话界面。
- “推送到新会话”是任务详情唯一主操作；它先打开模型、推理强度、工作模式、权限和首条消息确认弹窗，确认后始终以 `mode: create` 创建新会话，不静默复用历史会话。
- 关联会话区域必须覆盖加载、空、失败和有数据状态；历史加载失败不得阻断用户推送到新会话。

## ZEUS-000013 任务内容即时编辑契约

- 任务详情不增加全局“编辑”和“保存”按钮。标题、说明和标签默认按可阅读文本展示，用户点击对应内容后才切换为原生输入控件；优先级与任务管理状态继续使用下拉框并在选择后直接保存。
- 标题失焦或按 Enter 时保存，Escape 放弃本次修改；说明失焦时保存，普通 Enter 只换行，Escape 放弃本次修改。输入期间不得按每次按键请求本机 API。
- 标题只包含空白时拒绝保存并保留编辑态；说明与标签允许清空。标签以逗号或回车分隔，保存前统一去除首尾空白、空值和重复值。
- 附件区域提供独立添加入口。新增附件后立即建立任务附件关联；移除后立即解除关联并提供短时撤销。解除关联不得删除 Zeus 托管文件，也不得破坏既有会话和历史事件对文件的引用。
- 成功编辑只改变任务内容和后续“推送到新会话”读取的任务快照，不重写既有会话消息或正在执行的上下文，不自动改变任务管理状态。已完成或已取消任务仍允许修正任务内容。
- 每个字段必须显示保存中、已保存、失败或冲突的真实状态。失败时保留用户输入和重试入口，禁止静默恢复旧值或把本地草稿显示成已保存内容。
- 任务更新必须携带用户开始编辑时读取的 `updatedAt`。版本不匹配时本机 API 返回明确冲突，界面保留本地内容，并让用户选择“保留本地内容重试”或“载入最新值”；禁止后写静默覆盖先写。
- 同一界面连续修改多个字段时必须按任务串行提交，并在每次成功后推进下一次请求使用的任务版本，避免本窗口自己的更新彼此制造伪冲突。
- 每次真实变更只记录字段名、标签或附件数量变化和更新时间，不在任务事件中复制完整说明正文或本机附件路径；无实际变化不得刷新 `updatedAt` 或新增事件。
- 任务管理状态切换到完成或取消时继续遵守既有任务 Git 工作区处置门禁；状态下拉是入口，不得绕过提交、推送、放弃或冲突处理流程。
- 输入控件必须覆盖键盘焦点、中文输入法、窄抽屉、保存中、错误和冲突状态；不得用 `contenteditable` 替代输入框和文本域，也不得仅用颜色表达保存结果。

## TASK_20260727_001 会话资源打开与轮次变更契约

本节适用于会话页文件引用、网站与附件资源卡、打开目标、轮次变更卡、Review、Undo 和 Reapply。完整证据、协议、安全设计和验收矩阵见
`docs/TASK_20260727_001_Codex会话资源打开能力完全对齐设计.md`。

### 资源语义

- 会话内容中的文件、网站、附件和轮次变更必须先归一化为带 `projectId / conversationId / turnId / sourceItemIds` 的类型化会话资源；Renderer 不得凭任意 `href` 或绝对路径直接获得本地打开权限。
- 普通 GitHub 等网页引用保持行内链接；只有 provider 明确声明的网站产物、模型生成预览或结构化资源才使用独立资源卡，禁止把每个 URL 都放大成卡片。
- 文件引用显示文件类型图标、basename 和可选 `(line N)` / `(lines N–M)`；完整项目相对路径进入 tooltip 与可访问描述，真实绝对路径不作为普通界面主文案。
- 文件打开必须保留行、列或行范围语义；`shell.openPath` 不支持精确位置时，不得把“已打开文件”描述成“已跳到对应行”。
- 网站和附件卡共用资源卡结构，但主操作、打开方式菜单和整行点击热区必须是独立语义控件，禁止嵌套按钮或用绝对定位点击层遮挡菜单。
- 资源卡必须受所属消息容器的内容宽度约束；长文件名或标题优先省略，不能把固定的“打开方式”动作推出用户消息气泡，也不能用裁切父气泡掩盖真实溢出。

### 打开目标

- 会话资源统一通过受信 `ConversationResourceRouter` 和 Main Resource Broker 打开；Main 必须复验发送窗口、资源归属、路径包含性、符号链接、文件存在性、URL scheme 和目标 handler。
- 网站资源支持 Zeus 内置浏览器、外部浏览器和复制链接；普通 URL 与本地 URL 分别保存默认打开偏好。
- 文件资源支持 Zeus 源码预览、可用编辑器、系统默认、Finder 和复制路径；一次性“打开方式”选择默认不改变长期偏好。
- 选择 Zeus 浏览器时必须使用资源所属 `conversationId` 打开标签，保留左侧会话记录与 composer，不创建第二个 Zeus 窗口。
- 自定义文件处理器使用结构化 argv，不通过 shell 字符串拼接路径、行号或用户输入。

### 会话上下文工作面

- browser、plan、source 和 turn diff 是同一个会话上下文工作面的互斥内容类型；同一时刻只能有一个右侧工作面，切换内容不销毁会话历史或 composer。
- 右侧内容共享分隔条、宽度、展开、恢复、关闭、焦点恢复、窄屏和 reduced-motion 规则；不得为 Review 或源码预览再叠加一套抽屉壳。
- Review 必须读取持久化的执行轮次变更集，不能调用当前项目或任务的全局 Git diff 冒充本轮结果。

### 轮次变更卡

- 只有真实存在文件变化时显示；卡片属于对应 assistant 轮次尾部，不降级为普通“工作活动”文本。
- 头部显示“已编辑文件 / 已编辑 N 个文件”、增删行统计、Review 和 Undo / Reapply；hover 或 focus 时提供“查看更改”反馈。
- 多文件默认显示前三个文件，剩余文件通过“再显示 N 个文件”展开；大文件和二进制文件必须显示真实降级说明。
- 后续工作区修改不得改变这张卡所表达的原轮次 diff；如果当前文件已经继续变化，卡片和 Review 必须提示，而不是把新修改混入旧轮次。

### Undo / Reapply

- Undo / Reapply 只对完整执行轮次变更集生效，不提供部分 hunk 操作；它们不执行 `git reset`、`git revert`、`git checkout`、commit、push 或其他 Git 历史动作。
- Undo 前必须确认当前文件匹配轮次 post-image；Reapply 前必须确认当前文件匹配 pre-image。任一文件不匹配时全部停止，不允许部分写入或强制覆盖。
- 文件写入必须先完成全量预检，再通过恢复 journal、临时文件和失败回滚执行；应用崩溃后必须恢复到可解释的 `applied` 或 `undone`，不能让 UI 成功状态与磁盘部分写入并存。
- 状态至少覆盖 `applied / undoing / undone / reapplying / conflicted / unavailable`；冲突时保留 Review、冲突文件和复制补丁，禁用危险写入。
- Undo 成功后按钮变为 Reapply；Reapply 成功后恢复 Undo。按钮点击本身是与当前 Codex 对齐的明确用户动作，不额外增加阻塞弹窗，但必须有忙碌、成功、失败、冲突和不可用反馈。

### 视觉与验收

- 会话页继续受 `.session-codex-parity-v1` 视觉例外约束，以当前 Codex `26.721.41059 (5848)`、用户截图和正式包同状态并排比较为最终视觉依据；设计阶段不得用猜测像素固化未经测量的值。
- 文件引用、资源卡、变更卡、打开方式菜单和 Review 必须覆盖浅色、深色、长路径、窄窗口、键盘、VoiceOver、high contrast 和 reduced-motion。
- 完成判定必须包含 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`、正式包健康与签名检查，以及单一正式 Zeus 实例中的真实文件、网页、Review、Undo、Reapply 往返；静态检查或 mock 页面不能替代运行验收。

## TASK_20260728_003 命令中心设计契约

### 产品与数据边界

- Zeus 命令中心只提供通用命令定义、确认、执行、历史、日志、产物和 Telegram 入口；Git 批处理、微信开发者工具与 `agents-sync` 始终是用户脚本，产品默认和数据库迁移不得注入任何命令。
- `command_definitions` 保存全局或项目命令及其完整执行契约，`command_aliases` 单独维护查询标识，`command_runs` 保存命令快照并关联 Runtime session，`command_artifacts` 只登记执行产物目录中的真实文件。
- 全局名称或别名与任意项目命令冲突；项目命令与全局及同项目命令冲突，不同项目之间允许同名。删除命令采用软删除，执行历史继续依赖快照审计。
- 数据导出 schema v2 包含命令定义，但不包含脚本文件、确认、执行、日志或产物；schema v1 继续可导入。所有导入命令强制停用并关闭 Telegram 权限。

### 执行与安全

- 全局命令与项目命令都在本次用户选择项目的真实 `localPath` 中运行；禁止回退到 Zeus 应用源码根。Generic Shell 使用同一项目根判断。
- 项目必须显式开启 `allowShell`；声明 `gitWrite` 的命令还必须显式开启 `allowGitWrite`。命令创建、导入或展示不得自动修改项目权限；用户点击运行而权限不足时，桌面端必须先用独立弹窗说明持久化影响，只有用户点击“开启并继续”才保存本命令所需权限，随后进入本次运行确认且不得自动执行。
- 每次执行先创建一次性确认。确认绑定命令 revision、项目 ID、真实 cwd 和完整参数摘要；命令更新或删除、项目目录或参数变化、确认过期以及应用重启都会拒绝执行。
- 普通命令和高风险命令都必须逐次明确确认；`gitWrite`、`outsideProjectWrite` 或 `externalServiceWrite` 任一为真时，确认弹窗使用高风险摘要和危险操作语义，但桌面端与 Telegram 均不得要求额外输入确认短语。拒绝仍形成可审计的执行记录。
- 参数只允许声明式字符串、数字和布尔环境变量，禁止 `ZEUS_*` 键。敏感值不进入 `command_runs.parameter_snapshot_json`、Runtime 持久日志或审计 payload，并在日志回调进入持久层前按精确值脱敏。
- Zeus 注入 `ZEUS_PROJECT_ROOT`、`ZEUS_COMMAND_SCRIPTS_DIR`、`ZEUS_COMMAND_RUN_DIR`、`ZEUS_COMMAND_ID` 与 `ZEUS_COMMAND_RUN_ID`；用户脚本根和执行产物根由 Electron 实际 `userData` 运行时解析，产品代码不硬编码用户目录。
- 超时先向独立 Runtime 进程组发送 `SIGTERM`，三秒后仍未退出则发送 `SIGKILL`；应用关闭时不得清掉强杀定时器后留下孤儿进程。成功、失败、超时、取消与拒绝保持不同终态。
- `ZEUS_ARTIFACT_FILE=<path>` 只接受本次 `command-runs/<runId>` 物理目录内的真实普通文件；读取和 Telegram 回传前再次执行真实路径与文件类型复验。

### 桌面端与 Telegram

- 项目命令入口位于代码工作区右上角，切换后使用完整主工作区合并展示全局与当前项目命令；全局行只读，项目行可维护。页面以命令列表为主路径，定义维护、权限开启和运行确认使用居中 ModalPortal 弹窗；公共执行历史不得继续占用页面底部，每行使用独立历史按钮打开“当前命令 + 当前项目”的居中历史弹窗，保留记录列表、运行详情、实时日志、停止与产物，确认运行后自动打开并选中新记录。全局设置页不汇总跨项目历史，不使用侧边抽屉。
- 全局设置“命令”分类维护全局命令；定义表单必须覆盖别名、说明、超时、启停、Telegram、三类风险及声明式参数，不为 Git 或微信增加专用字段。
- 运行确认弹窗在确认前同时展示命令文本、项目目录、参数、超时和风险；执行后自动进入对应命令的历史弹窗，展示持久状态、Runtime 终端日志和产物，图片产物可以按受控内容 API 预览。
- 项目配置中的 Shell 与 Git 写入使用紧凑原生复选框；事件值必须在状态更新前同步读取，禁止在函数式状态更新器中继续访问 React 事件对象，避免交互触发渲染崩溃。
- Telegram `/commands [项目]` 先选择项目，再展示全局与项目命令合并菜单；只显示命令自身 Telegram 开关已开启的项。定义维护仍只在桌面端完成。
- Telegram 执行复用本地命令 API 的权限、确认、风险和 Runtime 路径，不另写旁路执行器，也不使用高风险确认短语；按钮回调严格限制在 Bot API 的 64 字节内，状态优先编辑原消息，终态回传已复验产物。

## TASK_20260731_001 任务 Git 工作区、提交与代码交付契约

### 任务开发线

- Zeus 任务编码统一使用 `ZEUS-000001` 形式；旧的 `ZEU-000001` 按原任务序号迁移，不改变项目内顺序。
- 任务推送到模型前必须为本次推送逐仓选择来源分支并确认新的任务分支；不得提供或默认使用该任务已有分支。新分支统一使用 `zeus/` 前缀，并通过 `git check-ref-format --branch` 校验；前缀后的名称不得再套用 ASCII 字符白名单。
- 来源分支必须是主仓库中的真实本地命名分支，其合法性由 `git check-ref-format --branch` 与本地 `refs/heads` 存在性共同判定，不能用 ASCII 字符白名单拒绝 Git 合法名称；任务工作区必须绑定一个真实远端，优先使用 `origin`，否则使用仓库首个远端。
- 每次“推送到新会话”都创建独立任务开发线、独立任务分支和独立推送工作区；同一任务重复推送不读取或继承其他推送的分支内容，可以在隔离目录中并行执行。
- 主工作区保持用户当前分支，不因任务推送而切换。任务会话的 `cwd` 指向独立 worktree；该身份同时写入任务工作区记录、会话记录和持久 submission context，应用重启后仍从同一目录恢复。
- 会话页在 Runtime 用量摘要下一行常驻显示会话持久 `cwd` 与该目录实时读取的 Git 分支；任务会话缺少持久 `cwd` 和工作区证据时显示“不可用”，不得用项目主路径、任务分支记录或提示词中的路径替代真实执行现场。
- 新推送的 worktree 默认位于仓库同级的 `.zeus-worktrees/<project>/<push-id>/<task-code>`，其中推送标识负责隔离重复推送，任务编码必须是会话 cwd 的最后一级。旧格式 worktree 不迁移，继续由历史会话使用直至回收。
- 每次推送分别记录本次选择的来源分支和精确来源提交；后续推送不读取其他任务开发线的来源或分支内容。主工作区未提交变更是否带入必须按本次推送的明确规则展示，不能从其他推送继承。

### 任务终态与 worktree 回收

- 会话结束不回收 worktree；worktree 生命周期跟随 Zeus 任务。
- 任务切换到“已完成”或“已取消”前，必须逐一处置所有任务开发分支。仍有活动会话时先停止活动 turn 和排队提交。
- 保留分支时，用户在 IDEA 风格提交窗口中选择文件、审查差异、填写提交说明并提交。任务完成入口以“提交并推送”为主操作。
- 有代码变化的分支只有在远端分支提交与本地 HEAD 精确一致后才能回收 worktree；没有代码变化的分支可以在干净且 HEAD 等于来源提交时直接回收，不创建空提交。
- 放弃分支必须输入完整分支名确认，只删除任务 worktree 和本地分支，不自动删除远端分支。
- 任一分支处置失败时任务管理状态保持原值；不得先标记完成再后台清理。

### 提交审查

- `Cmd+K` 在当前任务会话存在任务工作区时打开完整提交窗口。窗口包含任务分支列表、可勾选变更树、逐文件双栏差异、真实 Git 上游信息、提交说明和提交操作。
- 勾选路径在提交动作发生时通过受控 `git add -A -- <paths>` 写入 index；提交前只拒绝未解决冲突等真实 Git
  风险，活动会话只展示信息，不进入提交或推送门禁。
- 代码交付和提交弹窗不得提供“停止活动会话”操作，避免停止请求占用 Git 操作忙碌态；停止会话只在会话自身入口处理。可能回收
  worktree 的合入操作仍保留风险确认。
- 普通入口提供“提交”和“提交并推送”；任务终态入口只在推送成功并校验远端后允许继续回收。
- 右侧提交检查区只展示项目真实配置的检查。没有配置时明确显示“未配置”，不得伪造 IDEA 检查项。

### 代码交付入口与任务状态

- 代码交付入口由任务开发线是否存在决定，不受任务管理状态限制；“待办”“开发中”“测试中”“已完成”等状态都不能隐藏提交、推送、校验、回收或合入所需入口。
- `ready / failed` 分支在代码交付中显示真实分支名和“审查并准备交付”，复用完整提交审查流程处理活动会话、变更选择、提交、推送、远端校验和 worktree 回收，完成后返回同一代码交付上下文。
- `reclaimed` 分支显示合入目标与方式；`merged` 分支显示已交付状态，并允许在不同目标分支存在时继续形成独立交付记录；`discarded` 分支保留只读事实，不提供合入动作。
- 内部 TaskWorkspace ID 只用于 API 和持久关联，不得作为“任务分支”标签、空选项兜底或用户错误提示展示。
- 服务端继续以真实分支生命周期执行最终门禁；界面门禁与服务端不一致时必须展示可操作的本地化原因，不能让用户点击一个注定返回英文 409 的主操作。

优点：用户可以在任意任务阶段完成代码处置，手工提交或推送后的分支也有明确恢复路径，任务管理状态保持纯粹的进度语义。

代价：代码交付入口需要编排提交审查和合入两个弹窗，并在返回时重新读取真实工作区状态；准备阶段仍然必须显式回收 worktree，不能为了“一键”静默删除可写目录。

### 显式代码交付与冲突

- 任务完成不自动合入来源分支。任务详情展示轻量代码交付状态，并由用户显式打开“代码交付”。
- 默认使用 merge 保留任务提交历史，也允许用户选择 squash。已推送的任务分支不提供隐式 rebase 或历史重写。
- 简单合入在隔离 integration worktree 中准备候选结果；无冲突时重新校验主工作区仍位于目标分支、HEAD 未变化且工作区干净，再快进、推送并校验远端。
- 目标可选择记录的来源分支或主工作区当前分支。只有合入记录的来源分支才标记“已交付到来源”；合入其他分支只记录该次目标。
- 冲突保留隔离 integration worktree 和持久 integration 记录，应用重启后可以继续。三方编辑器左侧是目标分支，中央是可编辑结果，右侧是任务分支。
- 用户可以采用来源、采用任务、两者都采用或手工编辑结果。“AI 处理”必须由用户显式触发；点击后把当前草稿写入隔离 integration worktree，立即打开专用可写会话，由 AI 解决并暂存全部冲突。轮次结束后 Zeus 复验任务与目标 HEAD，在安全时生成合入提交并只同步本地目标分支；不自动推送，是否推送继续由用户单独决定。
- 冲突未全部解决、主工作区状态变化或远端校验失败时禁止推送并保留可恢复现场。

完整实现范围、取舍、接口和验证记录见 `docs/TASK_20260731_001_Zeus任务Git工作区提交合入与冲突处理.md`。

## TASK_20260731_003 长任务无损升级执行宿主契约

- Electron Main 只拥有窗口、菜单、BrowserHost 和界面租约；Local Server、SQLite、Coordinator 与 app-server 由独立执行宿主持有。
- 执行宿主是业务数据库唯一写入者。新界面必须先发现并连接现有宿主，禁止连接失败后直接创建第二写入者。
- 宿主 rendezvous 只允许当前本机用户读取，文件权限固定为 `0600`，端点只能监听 `127.0.0.1`，控制请求必须携带随机凭据。
- 界面租约失效不等于最终退出。有活跃轮次、等待交互、命令或 Runtime 时宿主继续运行；无活跃工作并经过空闲宽限后才可自行回收。
- 普通退出存在活跃工作时必须提供“退出界面，任务继续运行”“停止任务并退出”“取消”；状态无法确认时优先保护执行。
- BrowserHost 通过可重连本机桥提供能力。界面离线期间等待新租约，不立即把工具调用标记为永久失败，也不自动重放可能产生副作用的动作。
- Codex CLI 完全依赖用户本机安装。Zeus 优先使用用户显式配置的绝对路径，否则从当前 PATH、常见本机目录和登录 Shell
  发现真实可执行文件；不复制、不缓存、不随包分发，也不保留内置回退。新 Codex 进程世代只接收新线程和空闲线程，活动线程与待交互请求固定在原世代自然排空。
- 协调器以“generation 是否仍存活”判断请求权威，不以“是否最新”判断；任何旧 submission 都不得跨世代自动重发。
- 更新弹窗必须展示宿主模式、真实活跃工作数量、运行时世代总数和排空世代数。packaged App 只能通过 Main 的受限 IPC 下载和安装；浏览器/开发环境的 Local Server 安装入口保持 fail-closed。
- Release manifest 必须包含执行宿主协议版本。自动安装只接受签名、公证、协议兼容且摘要完整的产物；生产下载地址只能来自受信任 GitHub Release 域名。
- 安装辅助进程必须先完成就绪握手，再允许旧 Main 以 `upgrade_handoff` 退出；它只替换 App bundle，不终止执行宿主，不迁移或重放已有执行轮次。
- 普通会话草稿沿用本机恢复机制；敏感请求回答不得持久化，Renderer 必须把“存在敏感草稿”作为仅含 request ID 的窗口级门禁上报 Main，存在时拒绝安装。
- 新 App 启动后必须以预期应用版本重新连接原宿主才算安装完成；启动或回连失败时先终止失败的新版 Main，再回滚 App 并自动重开旧界面。只有不同于失败新版租约的旧版 UI 租约重新连接宿主后，才能写入 `rolled_back`。
- 旧宿主自身版本与已接管 UI 版本必须分开记录；Release 更新判断使用当前 UI 租约版本，不能继续从旧 App 包推断当前版本。
- 旧执行宿主可能仍从旧 App 备份运行，因此备份在宿主存活期间保留；最终退出关闭宿主后，Main 只清理名称带受控事务 UUID 的旧 App 备份。
- 计划内升级主链路的实现完成不等于正式分发验收完成。没有真实 Developer ID、公证产物以及 Codex/BrowserHost 全场景证据时，必须继续明确这些验证缺口。

完整设计、实现证据、未完成边界和验收记录见 `docs/TASK_20260731_003_Zeus长任务无损升级设计.md`。

## TASK_20260803_005 多运行内核公共框架界面契约

- Codex 与 Pi 是两套明确区分的 Agent；未来通过 Pi 使用 Kimi 时必须显示为“Pi Agent · Kimi”，不得用模型品牌冒充原生 Agent
  身份。
- Agent、模型供应源和具体模型是三个独立字段。现有 `provider` 只作为兼容数据，新增界面不得继续从一个字段推断三层身份。
- Agent 能力区分 `supported / unsupported / unverified`；只有真实版本和真实运行证据才能进入 `supported`
  ，模型名称、公开文档和静态代码不能替代证据。
- 普通 Agent 目录只展示明确允许用户看到且状态为 `verified` 的 Agent。`framework_only` 的 Pi 默认隐藏，不显示“即将推出”、灰色模型选项或不可执行入口。
- 当前任务推送、新对话和会话续接的用户路径保持 Codex 行为；公共框架改造不得改变 Codex 的模型、服务档位、权限、协作模式、排队、审批和恢复语义。
- Codex 专有控件只依据当前会话能力证据显示；Pi 后续没有完成同名能力验收时直接隐藏或说明真实边界，不能用禁用占位制造一致性。
- 已有会话根据持久 Agent 身份路由，界面选择模型不能在同一个原生会话中静默切换 Agent。跨 Agent 必须创建新产品会话并明确来源。
- 普通错误文案使用 Agent 和模型供应源的产品名称，不向用户暴露 RPC、JSONL、generation 或内部适配器类名；诊断区可以在脱敏后显示这些技术事实。
- Pi 真实模型开放前，普通设置、任务推送弹窗、新对话输入区和模型选择器不得出现 Grok、Kimi、DeepSeek 或 GLM 的假目录。

优点：用户始终能理解真实执行方式，公共会话界面不会掩盖 Agent 差异，也不会提前制造多模型已支持的错觉。

代价：能力可见性必须由统一目录和证据快照驱动；同一个模型未来存在 Pi 与原生两种接入时，界面需要同时表达 Agent 和模型来源。

完整开发设计见 `docs/TASK_20260803_005_Zeus多运行内核公共框架开发设计.md`。

## ZEUS-000018 任务类型与类型专属内容契约

- 任务类型固定为 `requirement / defect / optimization`，界面分别显示“需求 / 缺陷 / 优化”；新建任务必须由用户明确选择，不设置界面默认值。
- 历史无类型任务和导入的旧任务统一归为需求。模板、图谱和 Runtime 等系统内部建任务入口显式创建需求任务，避免新增字段破坏既有入口。
- 需求只展示需求描述；缺陷按“现状、预期、复现步骤”展示；优化按“现状、预期”展示。标题和类型必填，类型专属字段允许为空。
- 类型和每类内容分别持久化。修改类型不清空其他类型内容；详情和创建界面只展示当前类型字段，切回后恢复此前填写内容。
- 正式任务首发正文只包含标题、当前类型和当前类型字段，隐藏的旧类型内容不得发送。附件继续通过结构化附件通道传递，不拼入正文。
- 任务类型不改变管理状态、运行状态、优先级、标签、附件、权限或执行方式；本功能不得把类型复用为标签、来源或状态。
- 任务列表默认显示可排序的类型列；本任务不增加类型工具条筛选。可选的“内容”列展示当前类型第一个非空内容，不展示隐藏字段。
- 类型及类型专属内容沿用任务内容编辑的版本冲突保护、真实保存反馈、事件记录和审计边界，不允许静默覆盖并发修改。

优点：任务信息按业务含义结构化，创建、详情、列表和智能体正文使用同一口径，切换类型不会丢失用户输入。

代价：数据库、导入导出、接口和界面都需要同步维护新增字段；未来增加类型时必须同时更新迁移、展示和首发正文契约。

完整实现范围与验证记录见 `docs/ZEUS-000018_任务需要有类型.md`。

## ZEUS-0078 会话后续消息等待契约

- 队列消息是尚未交给模型、等待下一轮执行的后续消息，不属于对话记录；界面不得再将它呈现为已发送的用户气泡。
- 后续消息列表紧邻输入区。存在待处理选择或审批时，待处理交互优先展示，列表明确说明完成上方操作后会自动发送。
- 列表级状态必须说明真实等待原因和后续动作：当前回复结束后自动发送、等待其他会话释放名额，或会话中断、连接和恢复原因；不得用孤立的“排队中”代替解释。
- 正常等待条件解除后沿用协调器顺序自动派发，不额外要求用户确认。中断、归档恢复和写入不确定等安全场景继续保持暂停或回到草稿确认。
- “引导”只在当前回复可接收补充时可用，表示把该消息补充给当前执行且不中断回复；不得继续使用容易被理解为开启新一轮的“立即发送”。
- 等待期间保留编辑、删除和键盘可操作的顺序调整。操作失败必须保留用户编辑内容，不能静默丢失。

优点：用户可以同时看懂等待原因、自动发送时机和可用操作，且不会把未发送内容误认成聊天历史。

代价：在服务端尚未提供并发等待细分原因前，界面只能统一说明“等待其他会话完成”，不能准确指出项目名额或全局名额。

完整口径、Codex App 对照和验证记录见 `docs/ZEUS-0078_没看懂这是在排什么队.md`。

## ZEUS-0102 引导消息生命周期契约

- Codex 引导采用“排队 → 引导中 → 已确认”三段生命周期。`turn/steer` 返回成功只代表 Provider 接受请求，submission 必须继续保持 `steer_now + dispatching`，不得提前写成 `resolved`。
- `conversation.submission.steering` 必须同时携带当前 submission 和最新队列快照。Renderer 在一次状态更新中移除后续消息并创建当前轮次内的用户消息投影，禁止出现列表和对话记录之间的空白窗口。
- 只有 Provider `userMessage.clientId` 与 submission 的 `clientUserMessageId` 精确相等时，服务端才把 submission 标记为 `resolved`，Renderer 才原位替换“引导中”投影。正文相同、轮次相同或当前 submission 都不能作为确认依据。
- 完整会话快照必须从持久化的 `steer_now + dispatching` submission 重建“引导中”用户消息；`paused + recovery_required` 重建为“引导结果待确认”。刷新、切换会话和应用重启不得让正文或附件消失。
- Provider 明确拒绝已结束轮次时，沿用后续消息规则重新排入下一轮；RPC 结果未知、终态轮次缺少精确用户消息或恢复无法确认时，保留同一 submission 并进入恢复保护，禁止自动重发。
- 待确认投影属于当前轮次但尚未成为普通历史消息，必须显示文字状态，不得只依赖颜色；待确认期间禁止编辑和重复引导，附件继续由同一 submission 提供。
- 该契约只收紧 Codex 引导语义，不改变普通排队和自动派发、Pi 消息协议、并发限制及用户问答协议。

优点：消息从用户点击开始持续可见，界面状态与 Provider 事实一致，精确身份关联可以避免重复消息和误确认。

代价：服务端、实时事件和 Renderer 必须共同维护三段生命周期，并为写入结果未知保留显式恢复状态。

根因、接口范围和验证记录见 `docs/ZEUS-0102_排队消息点击立即发送后不见了.md`。

## ZEUS-0103 任务详情粘贴附件契约

- 任务详情中的标题、类型专属内容和标签编辑框，与创建任务表单使用同一任务资源管线；普通文字保持文字粘贴，图片、文件、文件夹和超长文本自动转为任务附件。
- 粘贴生成的附件完成本机校验后立即关联当前任务，不等待文字字段失焦保存；当前文字草稿、选区和焦点保持不变。
- 附件关联成功后必须推进当前编辑控件使用的任务版本，文字随后保存时不得因本窗口刚完成的附件更新产生伪并发冲突。
- Finder 或 Paste.app 没有派发 DOM 粘贴事件时，继续使用 `Cmd/Ctrl + V` 原生剪贴板兜底；正常 DOM 粘贴到达后必须取消兜底，避免重复附件。
- 资源读取、物化或关联失败时保留当前文字草稿和剪贴板资源重试入口；不得把本机路径或二进制内容写进文字字段，也不得静默丢弃失败资源。
- 现有添加附件、附件预览、移除关联和撤销移除行为保持不变。

优点：任务创建与详情编辑使用一致的资源心智模型，附件不会因关闭抽屉而丢失，文字字段也不会产生本窗口自触发的版本冲突。

代价：粘贴附件后即使用户按 Escape 放弃文字修改，已经建立的附件关联仍然保留；资源采集期间需要协调输入焦点、任务版本和附件错误反馈。

## TASK_20260807_003 历史任务附件目录迁移契约

- 任务附件关联表达 Zeus 托管资源，不把创建附件时的数据目录绝对路径当作永久资源身份。
- Zeus 数据目录迁移后，只允许把历史 `task-attachments` 引用重定向到当前托管目录中同一时间戳与 UUID
  资源名、且类型、已保存大小与现存旧副本一致的资源；旧副本不存在时，至少校验当前受信目录、稳定资源名、类型和已保存大小。
- 自动修复只更新附件存储位置，不刷新任务业务更新时间、不新增任务事件，也不删除或改写旧数据目录。
- 当前托管目录没有可验证资源时继续阻断任务首发，并明确提示重新添加附件；禁止静默删除引用或无附件推送。

优点：历史任务在完整迁移数据目录后可以继续携带原附件推送，后续再次迁移目录也能自动恢复。

代价：首次启动需要校验历史托管资源；真正缺失或内容不一致的附件仍需用户重新添加，不能自动猜测替代文件。

## ZEUS-0079 会话列表排序契约

- 会话阶段更新时间是独立于会话内容更新时间的事实，只在会话阶段真正变化时推进。
- 左侧普通会话列表按阶段更新时间倒序；同一毫秒再按创建时间和会话 ID 倒序保持稳定。
- 新模型输出、打开或阅读会话、配置和 Token 同步都不得改变左侧列表顺序。
- 打开任务详情不更新任务时间、会话内容时间或会话阶段时间。
- 任务详情的关联会话按创建时间正序，表达任务发展时间线；已归档会话保持原排序。
- 历史会话优先从轮次、排队和交互请求还原阶段时间，无法还原时回退到创建时间，不沿用通用更新时间。

优点：列表突出真正需要用户关注的阶段变化，打开、阅读和后台同步不再造成假置顶。

代价：需要持久化和迁移新的阶段事实；同一批会话在左侧列表与任务详情中可能呈现不同顺序。

完整规则、实现范围与验证记录见 `docs/ZEUS-0079_会话列表排序规则优化.md`。

## ZEUS-0127 会话原生身份与 JSONL 路径展示契约

- 会话页在当前目录和当前分支所在的运行时摘要中，同时展示原生会话 ID 与对应 JSONL 文件路径。
- 原生会话 ID 读取持久 `nativeSession.id`；Codex 会话映射到真实 provider thread ID，不得使用 Zeus conversation ID、Runtime session ID 或任务 ID 冒充。
- JSONL 路径只接受 Codex 线程响应返回的真实 `path`，由 Local Server 持久化；Renderer 不得按日期、ID 或用户目录自行拼接。
- 新会话在线程创建后保存路径，历史会话在执行宿主恢复线程时旁路回填；路径修复不得推进会话业务更新时间或阶段更新时间。
- provider 未返回路径、线程尚未落盘或会话没有原生身份时明确显示“不可用”或不展示该身份行，不扫描用户目录猜测候选文件。
- 当前目录、分支、会话 ID 和 JSONL 路径都使用等宽值、单行省略和完整提示文本；窄窗口不得因长路径产生横向溢出。

优点：用户可以直接对账 Zeus 会话、Codex 线程和磁盘原始记录，排查恢复与串会话问题时不再依赖手工搜索。

代价：运行时摘要增加一行技术信息；Codex 协议没有提供路径时，Zeus 无法保证文件位置，只能明确降级。

完整实现与验证记录见 `docs/ZEUS-0127_会话工作目录展示会话ID和JSONL路径.md`。

## ZEUS-0131 子任务首发上下文契约

- “父任务上下文”只在当前任务存在祖先时出现，按根任务到直接父任务排列，所有任务、会话和附件每次打开均默认不选。
- 选择父任务只带入任务编码、标题、当前类型和当前类型专属内容；内部会话和附件必须逐项选择，不允许联动全选。
- 会话只有在 app-server 明确返回路径且服务端确认它是当前真实存在的普通 JSONL 文件时可选；路径作为普通提示词文本发送，字段缺失时不得猜测。
- 父任务附件使用服务端生成的选择标识和既有结构化附件通道。服务端提交时重新校验托管资源重定位、可信根、真实路径、类型、大小和图片签名；Renderer 自报路径没有授权意义。
- 提交时重新校验祖先关系、任务与会话或附件的归属、重复项和选项快照。关系或资源已变化时不创建会话，刷新选项并保留仍有效的配置供用户再次确认。
- 当前任务附件始终按原规则发送；当前附件与父附件按服务端确认的真实路径去重。所选运行内核不支持结构化附件时禁用父附件选择并明确阻断已有附件，不得静默丢失。
- 界面预览和服务端首发正文必须使用同一纯格式化规则；没有父任务或没有选择父任务时，正文与既有任务首发完全一致。
- 父任务分组必须支持原生复选框键盘操作、可见焦点、不可用原因、窄窗口单列滚动以及浅色、深色、跟随系统和减少动态效果。

优点：用户可以精确携带解决子任务所需的背景，同时由服务端守住任务关系与本机资源边界。

代价：默认不选可能遗漏背景；选择会话会向运行内核暴露本机 JSONL 绝对路径；资源变化后必须重新确认。

本项属于可回退的首发内容和界面策略，不新增 ADR。完整实现与验证记录见 `docs/ZEUS-0131_子任务的推送.md`。

## ZEUS-0136 Git 本地工作流与远端同步解耦契约

- 打开任务推送、读取任务 Git 工作区和创建新会话不得自动执行远端刷新；远端刷新只能由用户点击仓库对应按钮触发。
- 来源分支按本地分支和各远端分组展示本机真实引用；未手动刷新时必须说明远端分支是本机已知快照，不能冒充服务器最新状态。
- 远端刷新失败只反馈当前仓库和本次动作，保留本地来源分支、当前选择、会话创建能力、本地差异和本地提交能力。
- 提交代码只创建本地提交；代码交付只合入任务开发线记录的来源分支，不要求任务分支预先推送，也不在合入动作中自动推送。
- 合入完成后的来源分支推送是独立可选操作。任务分支推送与来源分支推送复用非强制推送、非快进保护和远端 SHA 校验，但界面必须明确目标，禁止同一标签静默切换分支。
- 远端推送失败只显示本次错误，不把任务工作区持久状态改为失败，不阻断后续本地查看、提交、合入或会话创建。

优点：网络和凭据故障只降低远端同步能力，本地研发主路径保持可用；代价：用户必须主动刷新或推送，并理解本机快照与远端最新状态的区别。

## ZEUS-0143 任务 Git 弹窗上下文隔离契约

- 代码交付、提交和推送弹窗的瞬态状态必须绑定当前任务身份；弹窗关闭、任务切换或入口模式切换时，旧任务的工作区、文件、差异、合入记录、冲突、反馈和错误必须全部卸载。
- 新任务工作区加载完成前只展示加载状态，不得继续显示上一任务的真实业务数据，也不得使用新任务 ID 请求上一任务的工作区或合入记录。
- 服务端继续严格校验任务、项目、工作区和合入记录归属；界面串用旧状态不得通过放宽归属校验或吞掉错误处理。

优点：任务身份与 Git 操作对象始终一致，异步加载无法把旧任务现场带入新任务。代价：用户关闭弹窗后，尚未提交的文件选择和未保存界面草稿不会在下次打开时保留；持久 Git 与合入记录不受影响。

## ZEUS-0090 项目对话归档契约

- 项目对话与任务会话共享手动归档能力；`taskId` 只决定恢复后的列表归属，不得作为是否显示归档入口的条件。
- 两类会话统一保留运行状态门禁：正在响应、排队、等待批准或等待用户输入时不可归档，归档不隐式中断执行。
- Codex 原生线程已归档、Zeus 本地记录尚未归档时，用户归档操作跳过重复 Provider 请求并补齐本地状态，不得让该记录继续停留在普通列表。
- 设置中的已归档会话同时展示项目对话与任务会话；项目对话明确标记“项目对话”，恢复后回到原项目直属位置，任务会话恢复后回到原任务位置。
- 已归档列表继续排除临时会话；Provider 归档失败时不退化成仅隐藏 Zeus 记录。

优点：项目对话与任务会话使用一致的收纳心智，Zeus 与底层线程状态可以重新收敛。代价：设置页需要同时表达项目与任务两种归属，不能继续假设每条归档会话都有任务编码。

## ZEUS-0093 终态任务归档会话查看与重新打开契约

- 项目配置的完成和取消状态都属于任务终态；终态任务详情继续展示全部归档关联会话。普通会话树只展示未归档会话；从任务详情显式打开的当前归档会话只在会话工作区保留，不能被常规分组刷新抹掉，也不能重新混入普通会话树。
- 归档会话必须可以读取真实完整历史，但终态任务下隐藏 composer、队列与待交互区，并禁用消息编辑、重试和其他会话写入动作。
- 继续对话必须在同一动作中把任务改回项目默认状态并取消归档当前选中的会话；其他历史会话保持归档，不批量激活。
- 用户从状态下拉直接重新打开任务时，恢复最近一条归档会话；需要精确选择时先打开目标归档会话，再执行重新打开。
- 服务端拒绝终态任务直接创建或发送会话、单独恢复归档线程、运行或继续 Runtime；执行目录恢复也必须复验任务非终态。
- 重新打开必须复验任务版本、项目和会话归属。恢复失败或并发冲突时任务保持终态，并补偿归档已恢复会话和终态资源，禁止半成功。

优点：已完成任务的成果可追溯，继续工作又不会绕过任务生命周期；只恢复当前会话可以降低旧线程同时激活和并发写入风险。代价：状态下拉无法精确选择历史会话，只能恢复最近一条；精确恢复需要先进入目标会话。

完整实现范围、取舍与验证记录见 `docs/ZEUS-0093_已完成的任务查看详情.md`。

## ZEUS-0239 任务终态会话树即时收口契约

- 任务从非终态切换到项目配置的完成或取消状态时，该任务全部关联会话立即退出活跃会话树；任务详情继续展示真实归档历史，不把历史读取接口返回的归档会话混入导航列表。
- 本窗口发起终态切换时先乐观移除会话行；服务端拒绝、用户取消终态清理确认或版本冲突时，会话按真实排序位置恢复，并保留可读失败反馈。服务端确认后以任务终态和会话归档事实收口。
- 任务列表单项、批量操作、任务详情、会话标题及外部实时更新共用同一成员资格判断；不得依赖重新打开 Zeus 或点击会话触发刷新。
- 当前查看会话随任务进入终态时只从活跃会话树退出，主工作区保留真实历史并立即进入终态只读；当前查看对象与会话树成员资格是两个独立事实。
- 移除使用 160ms 淡出和高度收起，其他行平滑补位；多条关联会话同时退出，不逐条拖延。系统开启减少动态效果时直接更新列表，不执行位移或补间动画。

优点：终态反馈即时、所有状态入口一致，当前阅读不会被强制打断；代价：保存失败时会出现一次用于恢复真实事实的回弹，当前只读工作区也可能暂时没有左侧选中行。

完整范围、根因与验证记录见 `docs/ZEUS-0239_任务终态会话列表即时移除.md`。

## ZEUS-0157 Remote Control 独立安装契约

- 普通 Codex CLI 可执行不等于 Remote Control 守护进程可用；设置页必须分别展示两项真实状态。
- Zeus 远程宿主只使用当前 Zeus `CODEX_HOME/packages/standalone/current/codex` 的官方固定入口，不借用其他 `CODEX_HOME` 的守护进程，也不伪造软链接或复制独立版包。
- 固定入口缺失时，在用户点击启用前展示带当前 `CODEX_HOME` 和独立 `CODEX_INSTALL_DIR` 的官方安装命令，并提供显式复制操作；Zeus 不自动执行安装或登录。
- 缺失态禁用启用和配对，但保留刷新；安装完成后刷新必须重新读取磁盘事实，不要求用户修改普通 Codex CLI 路径。
- 远程启用后继续使用既有运行时世代排空：新会话和空闲会话进入远程宿主，活动轮次与待答请求固定在原宿主，禁止跨世代重放。

优点：官方守护进程布局、Zeus 数据隔离和恢复引导使用同一事实源，默认 `~/.codex` 安装不会再被误报为 Zeus 远程已就绪。

代价：用户需要为 Zeus 独立 Home 额外安装一份官方程序，并在终端完成明确操作；这是换取会话、认证、配置和插件隔离的成本。

完整根因、实现与验证记录见 `docs/ZEUS-0157_启用远程接管报错.md`。

## ZEUS-0158 推送任务来源分支批量选择契约

- Worktree 模式发现两个及以上 Git 仓库时，在逐仓来源配置顶部提供可搜索的批量来源分支选择；单仓项目不重复展示批量入口。
- 批量候选只包含全部仓库都唯一存在的来源身份。本地身份由分支名确定；远端身份由远端名和分支名共同确定，同名本地、`origin` 与其他远端不得静默合并。
- 批量应用只替换每个仓库的完整来源引用，保留新任务分支名和用户已经确认的未提交内容选择；应用后继续允许逐仓覆盖，并明确显示逐仓选择不一致。
- 没有共同来源时展示可读空态，不猜测默认分支、不提供部分覆盖，也不允许通过批量入口排除仓库。全部仓库参与和原子创建规则保持不变。
- 批量候选从当前本机能力派生，不单独持久化。逐仓远端刷新期间禁用批量入口，刷新完成后重新聚合；不得因此新增自动远端访问或放宽服务端完整引用复验。
- 批量下拉复用 `ZeusSelect` 的搜索、分组、键盘导航、可见焦点、portal 定位和焦点恢复能力，并覆盖中英文、窄窗口、主题和减少动态效果。

优点：多仓项目可以一次填充全部共同来源，同时保留逐仓真实引用和现有 Git 安全边界。

代价：远端名称不同或只存在于部分仓库的分支不会成为批量候选，用户仍需逐仓选择。

完整实施与验证记录见 `docs/ZEUS-0158_推送任务的分支选择.md`。

## ZEUS-0163 代码工作台设计契约

- 项目侧栏只提供“任务 / 代码 / 会话”。“命令”不再占用一级项目导航，旧 `#project-commands` 地址迁移到代码页命令模式。
- 代码页默认模式是源码。源码模式由可调宽、按需展开的目录树和多标签编辑器组成；底部状态栏必须来自真实文件编码、换行和光标状态。
- “源码 / 图谱 / 命令”在代码页顶部以低噪音模式控件呈现，三者切换完整主工作区。切换模式不得卸载源码草稿；进入图谱前不得主动扫描项目。
- 图谱中的源码定位优先进入内嵌编辑器，外部应用打开仅作为不可编辑文件和失败恢复的次级动作。
- 目录树桌面宽度默认为 260px，限制在 200–420px；窄窗口改为可收起覆盖层。文件结构操作不使用拖拽移动，删除必须明确说明进入 macOS 废纸篓。
- 编辑器提供行号、语法高亮、撤销重做、当前文件查找替换、跳转行、缩进和显式保存；不暗示具备语言服务器、智能补全、跳转定义或全仓正文索引。
- 未保存状态使用统一登记。离开代码页、切换项目和退出应用提供“保存全部 / 放弃 / 取消”；图谱与命令模式切换不触发提示。
- 每个项目最多持久化 20 个打开文件、当前标签、200 个展开目录和目录宽度，不持久化未保存正文。
- Renderer 只能提交项目 ID 和相对路径。Main 必须从本地服务取得权威项目根，拒绝绝对路径、空字节、`.git`、越界和真实路径逃逸。
- 符号链接可以显示、移动和移入废纸篓；指向项目外的链接禁止展开、读取和编辑。编辑仅支持不超过 2 MiB 的 UTF-8 文本。
- 保存使用 SHA-256 修订值防止覆盖外部修改，保留 BOM、换行和权限，并通过同目录临时文件、同步落盘和原子替换完成。结构写操作只审计动作、项目和相对路径，不记录源码正文。

## ZEUS-0091 会话行归档入口契约

- 项目对话与任务会话行不再通过“更多会话操作”菜单间接触发归档，行尾统一直接使用归档图标；`taskId` 只决定会话归属，不限制入口显示。
- 归档图标默认不可见，只在对应会话行 hover 或 focus-within 时显示；键盘用户仍能聚焦图标并看到明确焦点。
- 运行中、排队中、等待批准、等待用户输入和旧版只读会话继续不可归档；图标保留不可用语义和原因提示，不放宽服务端保护。
- 归档请求中以旋转状态替代归档图标并阻止重复触发；成功后会话仍按既有逻辑从普通列表移除，失败时保留原行与上层错误反馈。

优点：归档从两步操作变为一步，与 Codex App 的低噪音行尾操作心智一致。代价：悬停和键盘聚焦时会暂时占用 `26px` 行尾命中区，长标题会更早省略。

## ZEUS-0168 字段归属附件与任务首发布局契约

- 任务附件必须归属于需求描述、缺陷现状、缺陷预期、复现步骤、优化现状、优化预期或标签之一；标题不接受附件，也不保留通用附件区。
- 图片、文件、文件夹和超长粘贴文本使用相同归属、去重、移除和推送规则。字段内固定按“字段标题、附件、文字”展示，同一真实路径最后一次粘贴决定唯一字段归属。
- 历史无字段附件只按迁移时任务类型补全一次：需求进入描述，缺陷进入现状，优化进入现状；修复不推进任务业务更新时间。隐藏类型字段的文字和附件保留，但不展示、不首发。
- 任务首发冻结服务端权威布局，顺序为当前任务、根到直接父任务、关联任务；任务标题是首行原文，不加“任务标题”前缀。标签和标签附件属于布局正文。
- 父任务和关联任务、各自会话及附件每次默认不选，均由用户逐项勾选，不提供全选和选择记忆。祖先同时属于关联任务时只从父任务区出现；同一真实附件按首次位置发送一次。
- 会话上下文只发送服务端复验通过的绝对 JSONL 路径，不展开会话正文。当前任务或上下文、会话路径、附件在弹窗打开后变化时，提交必须阻断并刷新选项。
- 推送预览、持久提交、Provider 输入、乐观用户消息和重开后的用户消息共用同一布局快照。Codex 输入按布局交错文字和资源；Pi 受 SDK 的文字加图片数组协议限制，以字段位置标记和同序图片数组保留语义，不宣称实现字节级交错。

优点：附件从任务录入到模型输入和会话回看始终保留字段语义，父任务与关联任务背景由用户精确控制。

代价：取消文件选择和拖放备用入口后依赖系统剪贴板；历史附件的自动归属可能不符合原始意图；上下文变化会要求用户重新确认；Pi 原始协议仍存在已明示的表示差异。

完整决策、实现范围与验证记录见 `docs/ZEUS-0168_任务内插入图片位置.md`。

## ZEUS-0185 当前任务历史会话信息契约

- 任务首发能力快照必须列出当前任务正常关联的全部既有会话，与父任务、关联任务会话使用同一真实 JSONL 路径来源和可用性复验。
- 推送弹窗使用“当前任务历史会话信息”作为固定名称，只提供会话逐项选择；当前任务内容和字段附件继续自动进入，不增加“选择当前任务”开关、全选或选择记忆。
- 候选按创建时间从早到晚展示，包含已归档和仍在运行的会话；归档或运行状态不形成额外门禁。
- 所选会话 ID 必须在提交时重新按当前任务归属解析，真实 JSONL 路径写入当前任务区块的“当前任务历史会话信息”段，并把路径目录加入本轮只读资源根。
- 当前任务历史会话、父任务上下文和关联任务上下文使用同一任务上下文修订值；刷新后保留仍然有效的选择，不能把客户端路径直接当成权威事实。

优点：用户不再需要手工复制当前任务的既有会话路径，三类任务会话使用同一套选择和安全边界。

代价：选择多条会话会增加首发预览长度；运行中的 JSONL 仍可能继续追加内容，本能力冻结路径而不复制文件内容。

完整实现与验证记录见 `docs/ZEUS-0185_推送任务时选择当前任务历史会话JSONL.md`。

## ZEUS-0175 会话生命周期投影实时同步契约

- 同一会话在会话列表、任务表运行状态、会话抽屉和当前会话标题区的生命周期状态必须自动收敛，点击、选中或页面切换不得承担刷新职责。
- 正常连接时以 Local Server WebSocket 领域事件为快速路径；会话阶段已落盘后，对应的四处投影必须在一秒内一致更新。
- 全局事件订阅断开后必须自动重连；本机服务重启可能改变端口与凭据，重连前必须先刷新 Electron Main 提供的本机服务配置。
- 每次连接成功后立即读取当前项目完整会话快照，覆盖断线窗口期间可能遗漏的事件；校准失败时使用有上限的退避重试，正常连接期间不增加固定轮询。
- 任务表继续显示会话阶段更新时间最新的关联会话，不改为“任意一条活跃就覆盖”；运行状态不得改写任务管理状态。
- 断线或快照校准期间保留最后已知的会话状态，并使用统一轻量提示明确说明“正在同步会话状态”；不得把全局数据连接中断伪装成每条 Agent 会话的“正在连接”。

优点：正常链路保持低延迟，断线或本机服务重启后能自动收敛，同一会话不再由多份无边界缓存长期展示不同状态。

代价：断线恢复时会增加一次当前项目会话快照查询；连接异常期间界面会出现一条短暂的同步提示，但不会伪造会话生命周期状态。

## ZEUS-0177 任务首发即时工作面契约

- 用户确认任务推送后，Renderer 必须先以本地稳定身份建立普通会话列表行和完整会话工作面，再异步请求真实工作区、Provider thread 与首轮；首发消息直接按最终任务布局展示，不显示“发送中”或“已发送”。
- 工作面底部只显示“正在创建会话”。创建失败时保留首发内容、输入草稿、附件与后续消息，原地显示服务端可读失败原因和重试入口。
- 创建期间的输入框、附件、排队和立即引导能力保持可用。用户动作先进入本地调度队列，真实会话被服务端接受后再按原顺序和原交付意图提交；不得用禁用控件把内部创建时序转嫁给用户。
- 列表行和工作面使用稳定导航身份，真实 conversation ID 只用于服务端读写。后台接管不得改项目、导航区、选中项、URL、滚动位置或焦点；用户离开后完成创建也不得抢回页面。
- 首发请求和后续消息分别保留幂等身份。只有服务端返回与请求匹配的持久接受结果后才能清理本地信封；失败重试不得另造首发消息。

优点：用户点击后立即进入可工作的会话界面，慢操作被收进 Zeus 内部调度，同时保留服务端校验、幂等和失败恢复。

代价：Renderer 需要维护一段从本地稳定身份到真实会话身份的接管状态，并在接管前承担后续消息排序；应用进程被强制结束时，尚未被服务端接受的纯本地后续消息仍需要额外持久化能力才能跨重启恢复。

完整决策、实现与验证记录见 `docs/ZEUS-0177_任务首次推送即时进入会话.md`。
## ZEUS-0190 任务首发有效内容契约

本节覆盖 `ZEUS-0168 字段归属附件与任务首发布局契约` 中“标签和标签附件属于布局正文”的旧规则；字段归属和任务详情保留规则不变。

- 当前任务、父任务和关联任务的首发区块只发送任务标题、当前类型下有文字或附件的内容字段、用户明确选择的会话路径及补充信息；任务类型、标签和标签附件不进入首发。
- 完全没有文字和附件的内容字段整段省略，不显示字段标题，也不生成“未提供”等占位文案；只有附件而没有文字时仍保留字段标题并发送附件。
- 推送预览、Provider 实际输入、乐观用户消息、持久用户消息与重开历史继续共用同一份任务首发布局快照，禁止只在 Renderer 隐藏内容而继续向 Provider 发送。
- 任务类型继续决定当前有效内容字段，标签与标签附件继续保存在任务详情中；本契约不删除任务数据，也不改变任务创建、编辑、筛选、提交说明或附件归属规则。
- 推送预览和会话消息中的内容字段标题使用 `15px` 小节标题层级，不再使用 `11px` 元数据层级；正文、附件卡片、会话路径和其他界面密度保持既有规则。

优点：首条消息只保留解决任务真正需要的内容，空字段不制造噪音，用户看到的预览与模型输入可直接对账。

代价：模型不再直接看到任务分类和标签；如果这些管理信息确实影响工作，用户需要把相应要求写入有效内容字段或本次补充信息。

本项是可回退的首发内容与排版策略，不新增 ADR。完整实施与验证记录见 `docs/ZEUS-0190_推送任务提示词优化.md`。

## ZEUS-0209 任务首发标题与字段层级契约

本节覆盖 `ZEUS-0190 任务首发有效内容契约` 中内容字段标题使用 `15px` 小节标题层级的旧规则；有效字段范围和提示词内容顺序不变。

- 任务标题是任务区块唯一主标题，推送预览与已发送消息都使用 `17px / 650 / 24px` 的标题层级。
- “需求描述 / 现状 / 预期 / 复现步骤”等字段名称，以及会话信息和补充信息名称，统一使用 `13px / 550 / 19px` 的次级标签层级，并在名称末尾显示全角冒号。
- 字段名称、附件与正文组成一个隶属于任务标题的字段段落，整体相对任务标题缩进 `12px`；父任务和关联任务区块使用同一规则。
- Provider 纯文本继续在字段名称后保留全角冒号。当前构造器已经满足该格式，不为视觉修复增加重复符号或改变字段、附件和上下文顺序。
- 推送预览与已发送消息必须同步调整，不能只修弹窗或只修会话历史。

优点：任务标题、字段名称和字段内容形成稳定的三级阅读关系，字段归属更容易扫描，预览与会话消息保持一致。

代价：字段段落会占用 `12px` 横向空间；窄窗口和较长路径需要继续依靠现有软换行，不能用裁切隐藏溢出。

本项是可回退的视觉与提示词格式策略，不新增 ADR。完整实施与验证记录见 `docs/ZEUS-0209_推送任务提示词格式.md`。

## ZEUS-0192 代码交付原生窗口与审查优先级契约

- 代码交付使用任务级 macOS 原生子窗口壳承载现有交付内容；窗口不阻塞主窗口，每个任务最多存在一个实例，重复打开同一任务时聚焦既有窗口。
- 交付窗口首次打开约占当前显示器可用区域九成，允许缩放、最大化和全屏；后续窗口统一复用最近一次正常尺寸和位置，显示器变化或移除时必须把窗口完整纠正到当前可用区域。
- 主窗口当前选中会话的任务与工作区身份必须实时同步到全部交付窗口。交付窗口只在会话属于本任务时，把包含该工作区的任务开发线标记为“当前会话”；用户在交付窗口内切换选中项不得移动该标记。
- 分支名称必须在分支区域完整显示并可复制；超长名称允许软换行，不能再以省略号作为唯一展示方式。“当前会话”必须使用可读文字表达，不只依赖颜色。
- 交付窗口始终以“本机未提交”为差异范围；打开、切换开发线或真实 Git 状态刷新后都回到该范围。没有未提交文件时继续显示明确空态，并提供进入“已提交成果”的显式入口，不自动替用户切换。
- 主窗口和交付窗口允许并行操作。提交、合入、推送和冲突收尾后必须重新读取服务端真实 Git 状态，并通知主窗口刷新对应任务投影；任一窗口的本地缓存不得作为另一窗口的成功事实。
- 原生窗口只替换承载方式，不放宽任务、项目、工作区、合入记录、目标分支并发、远端非快进和 SHA 校验等既有服务端门禁。窗口关闭不得隐式执行提交、合入、推送或丢弃。

优点：代码审查获得独立、可调整和可记忆的工作空间，分支身份与当前会话可以直接对账，本机未提交变化成为稳定主路径。

代价：需要维护任务窗口实例、尺寸恢复、跨窗口会话上下文和真实状态刷新；多个任务交付窗口会增加 Renderer 内存占用，强制回到本机未提交也会打断用户对已提交成果的连续查看。

完整实施与验证记录见 `docs/ZEUS-0192_代码交付页优化.md`。

## ZEUS-0114 Codex 登录完成回交契约

- Zeus 只以 Codex app-server 返回的专属账号状态作为登录就绪事实；外部认证网页上的“打开 ChatGPT”或“打开 Codex”不是 Zeus 登录流程的必要步骤。
- 打开官方登录页前和等待登录期间，原工作面必须明确说明无需点击网页中的其他产品按钮；登录仍由官方网页和 Codex app-server 完成，Zeus 不代理凭据、不改写 OAuth 回调，也不关闭浏览器标签。
- 只有当前未取消、未超时且未被新请求替代的登录请求首次确认账号就绪时，才能激活发起请求的受信 Zeus 窗口。Renderer 不得指定或激活其他窗口。
- 回到 Zeus 后先展示“登录成功，正在继续”，再使用用户登录前已经确认的模型、工作区、权限和补充信息继续原操作，不增加二次确认。
- 窗口激活属于体验增强：激活失败需要留下本地错误记录，但不得把已经成功的账号认证改写为登录失败，也不得阻断原操作继续。
- 该回交逻辑是 Zeus 发起 Codex 浏览器登录的统一能力；本任务只接入当前真实存在的任务推送入口，后续入口应复用同一规则，不在此任务预造入口。

优点：保留官方认证安全边界，同时把产品反馈和工作现场恢复收回 Zeus，用户无需理解第三方完成页的错误跳转。

代价：官方成功页仍会留在系统浏览器中；应用自动回到前台会产生一次焦点切换，因此必须受当前请求身份和受信窗口边界约束。

完整取证、决策、实现与验证记录见 `docs/ZEUS-0114_未登录状态优化.md`。

## ZEUS-0194 AI 冲突处理新会话、权限与自动合入契约

- 用户每次点击“AI 处理”并确认权限后，Zeus 都创建新的产品会话、Provider 原生会话、首轮提交和独立隔离合入现场；不得返回、续接或改写旧冲突处理会话。
- 已有冲突处理会话处于排队、执行或等待状态时不阻止本次新建；不同会话不得共享文件、Git 索引或执行目录。
- 权限弹窗只提供“自动”和“完全访问”，默认选择自动。选中项使用紧凑单选列表、可见选中标记、轻量表面和细描边；完全访问的开始按钮在当前弹窗内使用危险操作语义，不再叠加第二层确认。
- 本次选择必须同时写入新会话权限、下一轮配置和首轮执行上下文；自动映射为隔离现场可写与按需审批，完全访问映射为完全访问与不逐次审批。弹窗值、会话界面、SQLite 和 Provider 首轮权限任一不一致都视为失败。
- AI 只修改并暂存其独占隔离现场，禁止执行提交、目标分支更新或远程推送。轮次完成后，Zeus 复验目标与任务基线、Git 未解决索引和隔离路径归属；无冲突时自动生成本地合入提交并安全同步目标分支。
- 首个通过复验并完成本地合入的会话更新主合入记录；其余并行会话不得覆盖已生效结果。它们停止后再安全回收独立隔离现场，会话历史继续保留。
- 代码交付页只显示当前主合入的真实状态，不暴露候选、晋升或过期等内部术语。会话启动、轮次完成、复验失败、本地合入完成和待同步都必须通过实时事件让已打开的原生交付窗口重读权威状态。
- 数据结构只允许增量增加会话与独立隔离现场的一一对应记录，不改写已有 `task_integrations` 历史；旧冲突处理会话继续可查看，但不得被新入口复用。

优点：每次权限选择、会话身份、文件现场和首轮执行严格对应；并行处理互不覆盖；隔离结果可以自动回到代码交付主流程。

代价：服务端需要持久管理多份隔离现场和逐会话收尾，磁盘占用与恢复复杂度上升；完整验收必须使用真实冲突、真实模型和独立测试数据对账四层权限与自动合入结果。

完整实施与验证记录见 `docs/ZEUS-0194_冲突处理弹窗与会话权限生效修复.md`。

### ZEUS-0268 专用会话首发输入透明契约

- 任务推送、代码审查、AI 冲突处理及后续新增的专用会话，首条可见用户消息必须与实际提交给模型的用户输入完整等价；不得用简短摘要、营销文案或另一套提示词覆盖。
- 完整等价不要求纯文本逐字排版。任务推送等场景可以继续使用字段、段落和附件组件，但所有实际发送的文字与附件信息都必须可见，顺序和归属不能改变语义。
- 专用会话启动计划只保存一份首发正文作为事实源；排队状态、Provider 回放、持久历史和应用重开都从该事实源投影，不能在不同阶段切换为不同正文。
- 询问回答、权限批准和实施计划等会话内控制动作不属于专用会话首发输入；它们可以继续把内部协议载荷投影为可读动作文字，但不得借此机制隐藏模型实际收到的普通用户输入。

优点：用户可以直接审计模型收到的真实任务，排队、回放和历史恢复也不会出现两套正文。

代价：代码审查和冲突处理的首条消息会明显变长；界面需要依靠正文排版与滚动承载真实信息，不能再通过省略内容换取首屏简短。

完整决策、实现与验证记录见 `docs/ZEUS-0268_专用会话提示词如实展示.md`。

### ZEUS-0247 冲突处理会话标题契约

- 新建冲突处理会话的持久标题与所有冲突处理会话的展示标题统一使用“冲突处理：当前任务名称”，不再把任务分支、来源分支或合入方向放进标题。
- 项目侧栏、会话页标题、项目搜索和归档会话列表必须复用同一展示规则；旧的“冲突处理：分支方向”和“本地合入：分支方向”记录也投影为当前任务名称，不批量改写历史数据。
- 任务名称修改后，冲突处理会话展示标题随当前任务名称更新；会话正文和代码交付上下文继续展示真实分支方向。
- 普通任务会话仍显示当前任务名称，项目普通会话继续显示自身标题。

优点：有限宽度下优先保留用户可识别的任务名称，新旧会话和各展示入口保持一致。

代价：用户不能再从侧栏标题直接读取分支方向，需要进入会话正文或代码交付页查看。

完整决策、实现与验证记录见 `docs/ZEUS-0247_冲突会话标题优化.md`。

## ZEUS-0220 会话消息交付反馈契约

- 普通会话、任务会话、代码审查会话和 AI 冲突处理会话共用同一消息级交付反馈；会话用途不得成为隐藏发送状态或错误的条件。
- 用户提交后，原消息立即以稳定 `clientUserMessageId` 留在时间线；尚未轮到处理时显示“排队中”，普通消息已开始提交但 Provider 尚未开轮时显示“正在启动处理”，引导当前轮次时显示“正在把消息交给当前回复”。面向用户的“发送中 / Sending”进行态不再使用。
- “正在连接”只用于会话创建、首次接管或网络恢复，不得描述已连接会话内的普通消息调度；Provider 轮次建立后由“正在思考”和真实过程内容接管。
- 执行轮次存续期间，当前没有进行中的摘要、回答或工作活动时，消息流最后一行始终显示“正在思考”；具体活动结束但轮次未结束时必须恢复该状态，不能因为本轮曾经出现过可见内容而形成空白。
- 服务端已经接受、但 Renderer 暂时无法读取持久记录时，原消息继续显示，并明确说明正在确认记录；不得冒充失败或自动重复发送。
- 权威快照无法证明 Provider 是否收到消息时，原消息显示“发送结果待确认”，保留可读原因并禁止自动重发，不能把整条会话升级为不可继续。
- 权威快照明确证明消息没有进入 submission、Provider 用户项或持久用户消息时，原消息显示“消息发送失败”和可读原因；原文字与附件同时回到当前会话输入区，并提供回到输入框的明确入口，用户可以修改后用同一安全身份重试，入口本身不得自动重发。
- 失败、结果待确认和持久记录确认中的反馈必须贴近对应用户消息展示；会话顶部状态只表达整条会话当前阶段，不能代替消息级结果。
- 冲突处理会话的隔离执行目录完成后的持续对话规则不在本契约内改变；当前只保证目录不可用等真实拒绝不会再表现为无反馈卡死。

优点：用户从提交开始始终能区分消息正在启动处理、Provider 正在思考、排队、结果不确定和明确失败，单条消息异常与长轮次活动间隙都不会再伪装成整条会话卡死。

代价：长轮次会持续保留一行低噪音存续状态；失败消息仍会与已恢复到输入区的同一内容同时可见，这是为了保留失败审计和可编辑恢复，Renderer 必须继续使用客户端消息身份避免后续重试产生错误替换。

原始消息级诊断见 `docs/ZEUS-0220_会话消息发送状态可见性.md`；存续状态修订、实施和验证记录见 `docs/ZEUS-0234_会话存续状态可见性.md`。

## ZEUS-0199 更新后精确重启目标契约

- 用户点击“立即重启”后，只允许启动本次更新已经复验成功的精确 App 路径和目标版本，不得再按 bundle ID 让 macOS 从同身份应用中自行选择。
- Homebrew 安装登记、目标 App 路径、bundle ID、短版本号和构建版本必须一致；任一事实不一致都视为更新未完成，不能退出当前应用后改开其他 Zeus。
- 原生更新辅助程序必须在旧主进程退出后再次复验同一更新重启目标，并通过精确 App URL 启动；等待旧进程超时或目标身份漂移时不得继续启动。
- “更新完成”只表示新版本已经安装并复验；“当前运行版本”必须以实际启动的应用身份为准，不能用安装记录替代。

优点：安装与重启共用同一目标事实，从根源上消除旧包、开发包或 LaunchServices 历史登记造成的错版启动。

代价：路径或版本异常时更新会明确失败，不再用同 bundle ID 的其他应用提高表面启动成功率。

完整证据、实现范围与验证记录见 `docs/ZEUS-0199_更新完成后启动错误版本.md`。

## ZEUS-0206 会话未读与专属关注状态契约

- 所有原生模型会话共用会话级未读事实，不以 Codex 成功完成事件作为唯一来源；模型产生用户可见的新回复、失败或中断结果、批准请求和用户询问时都必须形成关注状态，思考摘要、工具日志、流式增量和用量变化不单独触发普通未读。
- 会话行只显示当前最高优先级状态：待批准或需要回复优先于失败或已中断，失败或已中断优先于已完成，已完成优先于普通未读；正在执行且已有新进展时沿用正在响应状态。能够识别专属状态时不再叠加蓝点，只有无法细分时才显示普通未读蓝点。
- 待批准和需要回复是尚未处理的业务事实，用户看见后仍保留，直到批准、回答、跳过、取消或失效；普通未读、已完成、失败和已中断在完成真实已读确认后清除关注提示，正文中的真实结果继续保留。
- 只有 Zeus 存在前台活跃窗口、目标会话正文真实显示且最新关注内容进入可见区域时才能确认已读；会话 ID 仍被选中、应用在后台、窗口关闭、被其他应用遮挡、停留在其他页面或向上阅读历史都不得清除未读。
- 每条会话保留自身关注状态；项目“会话”入口按未读会话数聚合，并优先表达待批准或需要回复等专属状态。聚合数量按会话计，不按流式消息或消息条数计。
- 未读与专属关注状态是本机持久事实，跨应用重启、事件断线、项目切换和快照校准保留；实时事件只负责低延迟投影，重连读取旧状态不得重复触发系统通知。
- 桌面通知总开关继续生效。开启时，仅在没有任何 Zeus 窗口处于 macOS 前台焦点时发送系统通知；关闭窗口但后台驻留属于通知场景，用户明确退出 Zeus 后不承诺实时通知。任一 Zeus 窗口活跃时不弹系统通知，界面关注状态仍正常更新。
- 系统通知按同一轮关注状态的有意义变化去重：普通新回复通知一次，待批准、需要回复、失败和已中断使用专属通知；已为同一轮普通回复通知过时，成功完成不重复通知。点击通知只导航到受信项目和会话，最新关注内容真实可见后才确认已读，不自动批准、回答或重试。

优点：用户在任意页面、项目和模型之间都能可靠发现新回复，同时优先看到真正需要操作的状态；系统通知只在 Zeus 不活跃时补足可见性。

代价：需要维护可并发确认的阅读事实、跨模型事件归一、项目聚合、窗口焦点与正文可见性，并让系统通知携带受限导航身份；实现复杂度高于单一完成红点。

完整决策、实现与验证记录见 `docs/ZEUS-0206_会话未读与专属关注状态.md`。

## ZEUS-0223 冲突代码工作台与 AI 回交契约

- 本节覆盖 `ZEUS-0194 AI 冲突处理新会话、权限与自动合入契约` 中“权限选项使用轻量表面和细描边、完全访问开始按钮使用危险操作语义”的视觉规则；会话隔离、权限写入、复验和自动合入边界不变。
- 冲突处理使用代码优先的原生工具窗口：左侧是紧凑文件源列表，顶部是一条包含分支方向、冲突导航、视图切换和处理动作的工具栏，三列代码对照占据剩余主要空间；不得再用横向冲突卡片轨道挤压代码区。
- 权限确认继续使用紧凑居中弹窗。两个选项采用真实圆形单选点、单行影响说明和细分隔，整行可点击；未选中项不得绘制卡片表面，选中不得只依赖整行颜色。弹窗必须保留单选语义、键盘焦点限制、Escape 关闭和焦点恢复。
- 默认权限始终为“自动”，不从上一条普通会话或上一次冲突会话继承；本次选择仍必须写入新会话、下一轮配置和首轮执行上下文。
- Codex 冲突会话在稳定会话身份、首条消息、权限和提交记录持久接受后立即向界面返回排队状态，Provider 首轮由后台队列启动。主窗口打开对应会话后，独立交付窗口或当前合入面板立即关闭。
- Provider 启动、执行或复验失败留在已建立的会话中展示并恢复，不重新打开冲突窗口。独立 Git 合入现场准备失败发生在持久接受之前时，必须保留冲突窗口与未保存草稿并显示错误，不能伪造已进入会话。

优点：代码成为工作台视觉中心；用户确认权限后更快进入真实会话，后续状态与失败都围绕同一会话身份呈现。

代价：顶部工具栏承担更多横向信息，窄窗口需要优先折叠文件栏或低频动作；Git 隔离现场的前置准备仍可能短暂阻塞，只有持久事实成立后才能安全关闭窗口。

完整实施与验证记录见 `docs/ZEUS-0223_冲突页优化.md`。

## ZEUS-0236 新会话执行上下文契约

- 新建项目对话的输入框顶部直接展示项目与分支两个真实执行上下文；不展示没有第二种可选能力的“本地”按钮，也不把上下文藏在输入框外的准备步骤中。
- 项目选择使用 Zeus 项目身份，选择后立即同步当前项目导航，同时保留尚未发送的文字、附件与模型配置；最终创建的项目对话必须使用所选项目真实 `localPath`。
- 分支选择只展示项目根仓库的本地分支，支持搜索、当前分支勾选、其他 worktree 占用状态和创建并检出新分支；不自动访问远端，也不把缓存远端引用冒充为本地分支。
- 分支选择与新分支创建立即复用项目 Git 工作台的真实操作；失败时保留原分支与输入草稿，并在当前上下文菜单附近说明原因。非 Git 项目明确显示不可用，不伪造 `main`。
- 新会话执行上下文只属于尚未创建的项目对话；已有会话继续展示自身持久执行目录与实时 Git 分支，不增加可改变既有执行现场的重复选择器。

优点：用户在输入前即可确认项目、分支和最终会话使用同一真实现场，视觉与 Codex 新建会话参考一致。

代价：检出分支会改变项目主工作区，可能被未提交变化或其他 worktree 占用拒绝；项目切换需要同时维护导航一致性与未发送输入。

## ZEUS-0242 界面文字选择与命令日志复制契约

- Zeus 根界面、body portal 弹窗与原生子窗口统一使用“界面文字选择边界”：普通界面、弹窗 chrome、工具栏、字段标签和按钮默认不参与文字选择。
- 输入控件、`contenteditable`、会话正文、任务保真正文、代码、差异和终端日志必须显式恢复文字选择；不得通过改浅选区颜色掩盖跨容器整页选中。
- 从空白处按下或拖拽不得产生横跨弹窗、工作区或抽屉的选区；输入框内 `Cmd+A` 和真实内容区的鼠标选文继续使用平台原生行为。
- 终端日志是独立的选择边界；从日志正文向面板外拖动时，最终选区必须夹在本日志正文内，不能继续选中命令定义、运行状态或页面其他可选内容。
- 命令中心的终端面板右上角常驻“复制全部日志”紧凑按钮；按钮使用本次命令运行的持久 Runtime 身份重新读取日志，不从当前 DOM、可见行或 Renderer 展示分页反推完整内容。
- 复制文本使用与终端面板一致的可读投影：去除 ANSI 控制序列，保留独立回车覆盖和退格语义，不附加每块时间和 `stdout / stderr / system` 诊断前缀。
- 用户点击时形成运行日志快照；运行中后续输出不追加到已经写入剪贴板的内容。复制不改变每秒轮询、底部跟随、持久化和日志导出。
- 完整可读输出不超过 32 MiB 时才允许写入剪贴板；超出时不截断、不写入部分内容、不显示成功，必须原位提示用户导出完整日志。
- 复制按钮必须键盘可达、保留可见焦点、使用明确可访问名称，并在原位以文字与 `aria-live` 同步反馈复制中、已复制、过大和失败，不只依赖图标或颜色。

优点：应用层不再暴露网页式整页选中，真正需要复制的内容仍保留原生选文；日志按钮复制的是服务端复验后的本次运行完整事实，与当前展示预算解耦。

代价：所有需要手工选文的新内容组件都必须明确加入可选语义；读取完整日志会占用一次性 CPU 和内存，超大日志不能直接进入剪贴板。

本项是可回退的界面与读取策略，不新增 ADR。完整实施与验证记录见 `docs/ZEUS-0242_全选与终端日志复制优化.md`。

## 2026-08-13 ZEUS-0232 项目侧边栏会话列表

- 项目行不展示项目内会话的聚合红点、转圈或数量；项目折叠后不预览会话关注事实，具体运行状态只出现在单条会话上。
- 项目展开按钮固定在项目行最右侧，项目设置与更多操作位于展开按钮左侧；项目图标和名称占据左侧主内容，不因悬停操作改变展开按钮位置。
- 单会话状态复用任务表运行状态的文案、颜色、图标和胶囊结构。宽侧边栏显示完整紧凑胶囊；窄侧边栏隐藏文字但保留有颜色的图标胶囊和可访问名称；运行图标不得脱离胶囊单独出现。
- 会话列表运行态只由活动轮次、活动或排队提交、待处理请求与队列事实决定。Provider 生命周期字符串只能表达连接、失败、暂停等自身事实，不得在缺少执行事实时把会话长期投影为运行中。
- 实时事件负责即时刷新；连接成功时读取项目完整快照，连接保持期间每 10 秒静默校准一次当前项目，弥补偶发遗漏的终态事件。校准不得要求用户打开或重复点击会话。
- 会话仍按 `stageUpdatedAt` 倒序。只有真实阶段变化推进该时间；阅读、普通正文追加、配置变化与重复同阶段事件不改变排序。可见行位置变化使用 160ms 纵向过渡，进入或离开可见窗口使用轻微位移与淡入淡出，状态胶囊使用 120ms 颜色过渡；系统减少动态效果时取消位移和过渡。
- 每个项目默认显示 6 条会话，“展开更多”每次增加 10 条，全部可见后隐藏。搜索期间展示全部匹配会话并隐藏展开入口；清空搜索恢复此前上限。只有当前项目 ID 改变时清空所有项目的临时上限，同项目内页面切换与折叠不重置。
- 任务列表的“按任务状态分组”由 ZEUS-0246 负责，ZEUS-0232 不修改任务视图类型、默认值、偏好迁移、分组渲染或视图图标。

## ZEUS-0258 会话提交终态收敛契约

- “运行中”只表达当前仍有活动轮次或可执行工作；已绑定终态 Provider 轮次的提交不得仅因本地状态残留而继续显示运行中。
- 同一 Provider 轮次可以承载多条用户消息。轮次终止时，首提交身份和 Provider 用户消息客户端身份共同构成送达证据；所有证据精确匹配的提交必须一次收口，不只处理第一条。
- 终态轮次中无法证明送达的提交保留用户内容并进入需要恢复；不得静默删除、猜测成功或继续伪装普通运行中。
- 普通队列恢复不得自动重发已经绑定终态轮次但送达结果不确定的提交，避免在 Provider 已接收时产生重复用户消息。
- 执行宿主启动时，先用本地已持久的轮次终态和消息身份收口历史残留，再进行 Provider 联机恢复；不得因外部连接失败把已经精确证明送达的记录降级为未知。
- 会话侧边栏、任务表运行状态、当前会话标题、归档门禁和队列恢复必须消费同一收口结果；点击会话或定时权威快照不得在就绪与运行中之间反复摇摆。

优点：新旧数据回到同一提交事实，各界面和写入门禁不再各自猜测。代价：轮次收口必须遍历同一轮次的多条提交，并对无精确身份证据的历史记录保持失败关闭。

## ZEUS-0246 侧边栏会话组织契约

- 侧边栏中的项目始终是会话的最外层容器；“平铺”和“按任务状态分组”只改变项目内部的呈现方式，不改变会话、任务或项目归属。
- “任务状态”只指项目配置中的任务管理状态。分组顺序复用项目状态配置顺序，状态名称复用当前界面语言下的配置名称；没有会话的状态不显示。
- 没有关联任务的项目会话继续直接显示在项目下方，并位于状态分组之前；不得把它们塞入伪造的“无任务”状态。
- 状态组内的会话继续按会话阶段更新时间倒序排列。同一任务的多条会话保持独立，不增加任务层级；任务状态变化时，会话随权威任务状态移动到对应分组。
- “项目”标题右侧提供全局组织方式按钮，图标、提示文字和可访问名称都表达点击后的目标方式。没有历史设置时默认平铺，用户选择跨应用重启保留。
- 每个可见状态分组可以独立折叠。首次进入分组模式时全部展开，折叠偏好按项目和状态持久保存；被删除或当前不可见的历史状态键不影响其他分组。
- 搜索继续过滤会话；过滤后没有匹配会话的状态分组隐藏。状态分组标题只显示状态名称，不显示数量，避免搜索和实时移动时产生额外视觉噪声。

优点：保留原有平铺体验作为默认值，同时让会话较多的项目按真实工作阶段收纳；组织方式和折叠现场都能跨重启恢复。

代价：全局开关不能为不同项目选择不同组织方式；项目直属会话与状态分组并存时会形成两段列表，需要依靠轻量缩进维持层级辨识。

完整决策、实现和验证记录见 `docs/ZEUS-0246_侧边栏按任务状态分组.md`。

## ZEUS-0267 任务推送即时进入开发中契约

- 处于项目默认状态的任务确认“推送到新会话”后，任务从首个可见帧起直接使用项目推送后状态；默认配置对应“待开始 → 开发中”。
- Renderer 在插入首发会话行和工作面时使用同一任务状态投影，任务列表、任务详情、会话标题和侧边栏分组不得先显示旧状态再跨组跳动。
- Local Server 在同一任务推送请求中持久化状态、任务事件、审计和 `task.updated` 实时事实；不得恢复任务推送专用状态接口、后台同步重试或“状态未同步”会话警告。
- 推送时任务已处于测试、待验收、阻塞、完成、取消或项目自定义的其他状态时保持原值，不自动回退或重开。
- 状态进入项目推送后状态表达用户已经确认开始本次工作，不证明 Provider 会话或首轮已经成功；会话创建和执行结果继续由会话自身状态表达。
- 状态持久化前重新读取任务当前事实，只有仍处于项目默认状态时才迁移，不能覆盖推送准备期间发生的人工状态修改。

优点：会话第一次出现就在正确分组，任务阶段无需用户重复维护；状态写入复用现有推送链路，不再引入旧宿主缺少附属路由的兼容问题。

代价：任务可能已经进入开发中，而 Provider 随后创建失败；此时开发中表达已确认开工，会话错误单独表达执行失败，不做自动状态回滚。

当前实现、取舍和验证边界见 `docs/ZEUS-0267_任务推送即时进入开发中.md`；2026-08-14 的撤销记录保留在 `docs/TASK_20260814_001_移除任务推送状态同步校验.md` 作为历史背景。

## ZEUS-0248 冲突会话即时建立、动态追赶与重试身份契约

- 用户在冲突权限弹窗确认后，Zeus 必须先持久创建唯一的冲突处理业务操作、产品会话和首发消息，再立即返回稳定会话身份；主窗口随即进入该会话，交付窗口关闭，不能继续把 Git 现场准备耗时表现成权限弹窗卡死。
- 独立合入现场、执行目录与 Provider 原生会话在后台准备。准备中会话必须展示首发要求和真实准备状态；用户可以继续发送消息，所有消息以各自稳定身份进入当前会话队列，现场就绪前不得派发。
- 准备期间允许修改模型、权限和执行模式；修改同步到当前会话全部尚未派发的提交，已开始派发的提交不追改。界面展示、下一轮配置、持久提交和 Provider 实际配置必须一致。
- Codex 与 Pi 使用同一产品语义。Provider 尚未绑定不等于产品会话不存在；Pi SDK 打开失败也必须留在已经建立的当前会话中恢复。
- 来源分支和任务分支持续前进是并行交付的正常事实，不得作为阻止冲突处理的异常门禁。当前冲突处理业务操作自动读取两端最新提交，在同一会话内创建新的内部执行代次并重建隔离现场。
- 冲突指纹一致的已验证草稿和结果可以沿用；真实变化的冲突必须重新读取三方内容，只把仍需处理的变化继续交给 Agent。不得把旧草稿无条件套到新冲突，也不得把过期结果落到来源分支。
- 同一业务操作可以产生多个内部准备代次和 Provider turn，以保留真实审计；这些代次不得生成新的 Zeus 会话、用户首发消息或用户可见冲突处理操作。
- 每次准备落地前必须对最新来源提交与任务提交做最终校验；任一侧再次变化时继续在当前会话追赶，不把用户赶回冲突工作台，也不要求重新确认权限。
- 准备失败留在当前会话并提供“重试准备”。重试沿用当前业务操作、会话、首发消息、草稿、排队消息和用户配置；不得用新会话冒充重试。应用重启后按同一持久身份恢复。
- 全应用统一区分“重试”“再次执行”“重新读取”：重试复用尚未完成的业务身份；已终结操作的新一轮使用新运行身份并明确写为再次执行或重新扫描；纯事实刷新明确写为重新读取或重新检查。
- 新建任务、图谱节点转任务和模板转任务等创建入口必须在第一次提交前生成稳定创建意图；响应丢失后的重试返回同一任务，不得重复创建。消息内容、附件和配置完全未变时重试发送沿用原提交身份；用户修改后形成新的发送意图并保留旧失败记录。

优点：确认后立即进入真实工作面；并行交付导致的分支持续变化成为自动追赶输入；失败重试不会重复创建业务对象，历史和内部执行仍可审计。

代价：服务端需要持久准备态、后台恢复调度、队列冻结与释放、配置同步和内部执行代次；高频并行提交可能增加重建与模型执行次数，完成时间取决于能否取得一次可安全落地的最新快照。

本项改变持久恢复和全应用操作词汇，但不改变 AI 禁止直接更新来源分支和推送远端的安全边界。完整决策、实现与验证记录见 `docs/ZEUS-0248_冲突处理弹窗确认.md`。

## ZEUS-0257 侧边栏会话状态图标契约

- 本节只覆盖 ZEUS-0232 中“单会话状态必须复用任务表胶囊、运行图标不得脱离胶囊”的视觉规定；会话状态事实、优先级、排序、校准和动效边界保持不变。
- 项目侧边栏的有状态会话与无状态会话使用同一总行高。状态只占用固定 `18px` 图标槽，不得通过背景、描边、文字或额外内边距改变会话行高度。
- 运行、等待用户回复、等待授权、暂停、失败、完成和旧会话只读使用可区分的语义图标；普通未读继续使用圆点。颜色只辅助表达，不能成为唯一状态区别。
- 宽侧边栏与最窄侧边栏使用同一无底色图标形态，不在断点间切换为方形按钮或胶囊。完整状态文字保留在悬停提示和可访问名称中。
- 系统减少动态效果时停止运行图标旋转，但继续保留静态图形与状态语义。

优点：标题始终是会话行主内容，最窄宽度仍保留状态，且状态变化不会改变列表密度。

代价：宽侧边栏不再常驻显示状态文字，首次识别图标时需要悬停查看说明。

## ZEUS-0227 活动轮次输入区主操作契约

- 活动轮次期间，输入区没有非空文字、待提交附件或浏览器批注时，右下角主操作显示“停止”，用于中断当前执行。
- 活动轮次期间，只要存在非空文字、待提交附件或浏览器批注，右下角主操作立即切换为“发送”；点击与 Enter 使用同一队列提交语义，形成下一轮队列消息。
- 发送按钮和停止按钮不同时显示，避免一个输入区出现两个竞争主操作。存在草稿时仍保留连续两次 Escape 中断当前执行的键盘能力。
- 非活动轮次继续显示发送按钮；空内容时禁用，存在可提交内容时可用。只包含空白文字不构成可提交内容。
- 本项只调整主操作的可见语义，不改变队列、引导、停止、附件、浏览器批注或 Provider 派发协议。

优点：鼠标按钮与 Enter 表达同一动作，用户输入内容后能直接判断消息可以发送，不会被停止图标误导为输入区不可用。

代价：活动轮次存在草稿时，停止按钮不再直接可见；用户需要先清空草稿，或使用连续两次 Escape 中断当前执行。

本项是可回退的输入区主操作选择规则，不新增 ADR。完整实施与验证记录见 `docs/ZEUS-0227_会话进行中输入框有输入时显示发送按钮.md`。

## ZEUS-0297 计划实施确认与后续队列契约

- 成功 Plan 轮次形成待处理计划实施请求后，该请求成为当前会话下一步的决策门禁；在用户实施、修订或关闭前，普通后续消息不得自动启动新的 Provider 轮次。
- 用户选择实施时，控制动作固定以 Default 协作模式执行；选择修订时固定以 Plan 协作模式执行。模型、推理强度、服务档位和权限仍在真正派发前读取会话最新设置，普通排队消息继续完整遵守“统一使用最新配置”。
- 计划控制动作在尚未开始的队列中优先于普通后续消息；动作完成后再按原顺序继续普通队列，不删除或改写既有用户消息。
- 计划控制动作因全局容量等待时必须标识为“计划操作”，不得提供引导、编辑、删除或调整顺序的能力；普通消息不得越过它，服务端同时拒绝绕过界面的改写与重排。
- 用户关闭计划请求时不创建控制动作，并立即恢复普通队列排空。已经解决的请求不得被迟到的 pending 实时事件回退为可操作状态。
- 计划确认提交期间所有相关按钮必须立即进入忙碌禁用状态；一次用户决策只能形成一个持久计划动作和一个对应 submission。

优点：计划结果和用户决策保持原子顺序，一次确认不会被下一条 Plan 消息抢跑或再次变成规划；普通下一轮配置的既有灵活性继续保留。

代价：计划确认未处理期间，普通后续消息会等待用户明确决策；全局并发名额不可用时，计划动作仍可能等待容量，但其优先级和协作模式不再漂移。

完整现场、根因、取舍与验证记录见 `docs/ZEUS-0297_计划模式确认消息错误.md`。

## ZEUS-0273 冲突处理命名开发线与连续会话契约

- 用户每次点击“AI 处理”都创建新的命名冲突开发线和新的会话，不复用旧分支、旧 Worktree 或旧会话。
- 冲突分支从原任务开发线记录的来源分支最新本地提交创建，然后合入原任务分支。首次命名为“任务分支名-merge”，重名时依次追加 `-2`、`-3`。
- AI 会话只负责在冲突分支中处理并暂存全部冲突，不创建提交、不直接更新来源分支、不推送远端。AI 回合结束不触发自动合入、自动回收或会话封口。
- 冲突开发线作为任务工作区持久登记；会话的执行目录、代码变更和“代码交付”都绑定该工作区，因此首轮结束后仍能在原会话继续修改和再次交付。
- 用户发起代码交付时，先把最新来源分支和原任务分支合入当前冲突开发线。若产生新冲突，保留现场并回到原冲突会话；无新冲突时沿用现有代码交付流程提交并本地合入来源分支。
- 合并冲突尚有 `MERGE_HEAD` 时，代码交付的提交动作必须覆盖全部变更并创建完整合并提交；禁止按部分路径伪造合并完成。
- 代码交付完成后保留冲突分支和 Worktree，远端推送仍是独立用户动作。本契约取代 ZEUS-0248 中“每次执行代次重建 detached 隔离现场并在 AI 回合结束自动落地”的部分，保留即时建会话、持久接收和失败重试身份。

优点：冲突处理会话拥有真实、可见、可继续的 Git 开发线；代码交付与普通任务开发线使用同一入口，首轮结束后不会因隔离目录被回收而发送失败。

代价：本地会保留更多命名分支和 Worktree，需要用户后续显式管理；交付前追赶两条分支可能再次产生冲突，但冲突会保留在原会话而不会丢失上下文。

本项只调整可回退的本地工作流和持久工作区模型，不新增 ADR。实施记录见 `docs/ZEUS-0273_冲突处理会话连续对话.md`。

## ZEUS-0271 新用户任务首发接入引导契约

- Zeus 不在首次启动时强制登录或配置模型。用户第一次选择 Codex 执行“推送到新会话”时，在原推送弹窗内完成接入引导，并持续保留模型、工作区、权限、补充信息和附件。
- 没有配置第三方模型连接不等于没有可选模型。Codex App Server 已报告可用模型时，界面自动选择真实 Codex 模型；只有真实模型目录为空时才显示不可创建的错误，不把用户错误导向第三方模型设置。
- 当前选择需要 OpenAI 认证的 Codex 模型且 Zeus 专属 Codex 未登录时，主操作改为“登录并继续”。未登录不得提前创建产品会话、任务工作区或首轮提交。
- 用户首次选择“登录并继续”且本机真实存在可安全导入的 Codex App 配置时，只询问一次是否导入。没有可导入项时跳过询问；用户选择暂不导入后，后续重新登录不重复打扰，设置页仍保留主动导入入口。
- 配置导入只包含普通偏好、全局指令、规则、提示词、技能和用户插件；账号、密钥、`auth.json`、历史会话和运行缓存继续排除。界面必须在确认前展示允许导入与跳过项，不能用“导入 Codex”概括不同授权。
- 用户确认导入后，Zeus 完成既有的暂存、路径改写、备份、原子替换、审计与失败回滚，再激活新的当前 Codex 运行时世代。新的任务首发和空闲会话使用新配置；活动轮次与待处理交互固定在旧世代自然排空，禁止中断、迁移或重放。
- 新世代成功就绪后继续原 Codex 登录；登录完成后自动激活原 Zeus 窗口，短暂显示“登录成功，正在继续”，随后自动恢复原推送并创建会话，不增加第二次确认。
- 导入失败、世代激活失败、浏览器打开失败、登录取消或登录超时都保留原推送现场，不创建会话或工作区。失败必须区分“配置未导入”“配置已导入但新世代未就绪”和“账号未登录”，并给出对应重试动作。

优点：接入发生在用户意图最明确的任务首发现场；首个 Codex 会话即可使用用户已有配置；账号、配置和历史会话授权边界保持清楚；运行中工作不被热重载打断。

代价：任务首发需要增加一次性询问状态、导入预览、运行世代切换和失败恢复；配置导入成功但新世代激活失败时，必须保留可解释的待生效状态，不能回退为“导入成功即可立即使用”。

本项复用既有运行时世代与排空契约，不新增架构决策记录。现状证据、目标流程、实现结果和验证边界见 `docs/ZEUS-0271_新用户安装后的任务推送引导.md`。
## ZEUS-0280 外部模型单轮请求警告契约

- Pi 外部模型返回 HTTP 400、认证、限流、配额或其他模型请求错误时，只结束并记录当前轮次，原产品会话、Pi 原生会话和输入区继续可用。
- 界面使用低饱和警告信息说明本轮请求未完成、真实原因和恢复动作；不得显示“会话失败”、把会话状态改为失败、触发失败状态图标或禁止用户继续输入。
- 当前失败请求不得自动重放；用户修正模型、思考深度、API Key、配额或网络后，通过明确发送形成新的轮次，避免重复费用和工具副作用。
- 只有会话文件损坏、运行内核不可恢复、身份不一致或安全边界无法继续等会话级错误，才允许把整个会话置为失败并关闭发送能力。

优点：供应商的单次参数或服务错误不会中断用户上下文，用户可以在同一会话修正后继续。代价：持久层仍需保留失败轮次用于审计，同时把轮次结果、会话可用性和关注状态分开投影。

## ZEUS-0281 原生会话归档归属契约

- `codex_native` 只表示 Zeus 原生会话产品协议，不等于底层 Agent 一定是 Codex。归档、恢复、任务重开和回滚必须继续读取 `agentKind`，再交给 Codex 或 Pi 各自的协调器。
- Codex 归档必须调用真实 Provider `thread/archive`，恢复必须调用 `thread/unarchive`，并同步 Zeus 本地归档状态；所有 App Server 运行世代必须固定使用 Zeus 数据布局中的 `CODEX_HOME`。
- Pi SDK 当前没有 Provider 归档接口。Pi 归档由 Zeus 持久层持有，只卸载内存上下文，不删除原生 session 文件、消息或失败状态；恢复后沿原 session 路径续接。
- 任一 Agent 存在活动轮次、排队消息、派发中提交、待处理请求或工具审批时都禁止归档。不得用强制隐藏绕开活动工作，也不得因一次 Provider 查询失败删除会话。

优点：同一产品会话协议可以承载不同 Agent，同时保持各自真实的 Provider 能力；Codex 与 Pi 都能归档且不会串用协调器。

代价：归档实现不能只按 `transportKind` 写一条公共分支；新增 Agent 时必须显式补充归档能力和不能支持时的产品提示。

实现与验证记录见 `docs/ZEUS-0281_点击归档报错.md`。

## ZEUS-0283 全应用错误弹窗契约

- 运行、读取、保存、打开、连接和提交等操作失败时，业务页面、抽屉、设置面板、菜单栏窗口和独立 Git 窗口不得直接展示原始错误文本；统一上报到应用级错误弹窗。
- 错误弹窗使用全应用唯一的 `ModalPortal` 出口和排队机制。主信息只说明操作未完成；用户主动展开“查看详情”后，才显示发生时间、错误来源和脱敏后的原始信息。
- 详情进入界面前必须遮蔽常见 Bearer 凭据、OpenAI Key、API Key、Token、密码和 Secret；业务组件不得绕过统一出口直接把异常对象、堆栈或服务端原文插入普通界面。
- 同一失败值在未清空前只上报一次；连续失败按队列逐个处理，不能相互覆盖。弹窗支持 Escape、焦点接管、窄窗口、主题和减少动态效果。
- 表单必填、格式纠正、危险操作确认和权限缺失属于用户当前输入的就地反馈，继续靠近对应控件；会话历史失败、Git 冲突、只读和不可用等持久业务事实继续作为状态展示，但不得夹带瞬时异常原文。
- 关闭错误弹窗后，原工作面和可恢复动作必须保留。列表、连接和 Git 读取失败可以保留“重新读取”“重试”等中性恢复入口，不能只剩弹窗而失去下一步。

优点：全应用反馈一致，不再因错误横条挤压布局；默认信息易懂，技术详情按需可见；集中脱敏降低凭据泄漏风险。

代价：弹窗会打断当前操作；并发失败需要排队查看；若把字段校验也纳入弹窗，会造成频繁打断并失去输入定位，因此该类反馈明确保留就地展示。

本项是可回退的展示与错误出口统一，不新增领域对象或架构决策记录。实施和验证记录见 `docs/ZEUS-0283_全应用错误统一弹窗.md`。

## ZEUS-0285 会话输入框中文输入法契约

- 会话输入框必须把输入法组合文本与已经提交的会话草稿区分开。拼音尚未选词上屏时，组合文本只由当前 textarea 持有，不触发会话状态持久化或后台快照回写。
- `compositionend` 结束选词或输入框在组合期间失焦时，必须把 DOM 中最终文字一次性同步到会话草稿；普通键盘输入继续即时同步，窗口关闭后的已完成文字仍可恢复。
- 输入法组合期间的 Enter 不发送消息。除标准 `isComposing` 外，还要兼容 Chromium 在输入法收尾阶段使用的 `keyCode 229`，避免选词确认被解释为发送。
- 后台会话刷新、轮次状态变化和草稿存储不得替换正在组合的 DOM 值；组合结束后以 textarea 的最终值提交会话草稿，保持单一最终事实。

优点：macOS 中文输入法不再与高频会话状态刷新和同步存储竞争 textarea 的值，选词确认也不会误发送。

代价：未完成选词的半成品拼音不会即时写入跨窗口草稿；只有选词完成或输入框失焦后才进入持久状态。

本项是输入边界的可回退策略，不新增 ADR。实现和验证记录见 `docs/ZEUS-0285_会话输入框中文输入法偶发失效.md`。

## ZEUS-0294 会话下拉框统一契约

- 新会话项目、分支、模型和推理强度入口必须复用全局 `ZeusSelect` 的 portal、定位、宽度、搜索、键盘、焦点恢复和列表滚动能力；会话页不得再维护独立的绝对定位下拉壳层。
- 下拉浮层只有选项列表可以纵向滚动，popover 壳层与搜索行不得形成第二个纵向滚动容器；长列表始终只显示一条滑块。
- 会话页只允许调整触发器在输入工具栏中的紧凑布局，不得重写浮层、搜索框、选项行、焦点和滚动核心状态。
- 项目与分支浮层按触发器视口坐标固定定位；空间不足时沿用 `ZeusSelect` 的完整向上展开，不受会话输入区的裁剪、滚动或层叠上下文影响。
- 新建分支是分支选择后的独立表单操作，不把输入框、提交按钮或任意业务表单插入通用 listbox；创建、检出和错误处理继续使用真实 Git 能力。

优点：会话页与全应用使用同一交互事实，位置、搜索和滚动问题可以在原语层持续收敛。代价：项目选项回到标准单行密度，新建分支需要从下拉切换到独立小弹窗。

## ZEUS-0288 会话消息稳定身份、流式节奏与目标切换契约

- 用户提交后，原消息立即以稳定 `clientUserMessageId` 进入时间线。排队、冲突现场准备、派发、Provider 接管、完成、失败和结果待确认只更新同一视觉身份，不得让正文在输入区队列与时间线之间卸载、重建或跳位。
- 队列管理区继续提供编辑、删除、排序、引导、恢复和真实状态说明，但不得在默认态重复展示或替代时间线正文；展开后只允许显示单行管理摘要和附件数量，编辑态才显示完整输入。编辑只替换用户的 composer 文本，已经持久化的浏览器批注与结构化上下文 Provider 后缀必须原样保留；无法证明结构边界的旧记录和内部结构化提交必须拒绝纯文本编辑，不得展示成功后仍派发旧内容。
- 尚未确认进入会话记录的恢复输入必须先把正文、附件、浏览器批注和结构化上下文合并并持久化到输入区，再撤下时间线投影和服务端确认记录；只有删除返回已确认旧 submission 消失，或新权威快照确认其已删除或取消且没有 Provider 精确用户消息事实时，才能清除旧待发送身份并允许新身份重发。实时队列与完整快照入口必须共用该裁决，不得丢失输入或形成双执行。
- 消息经权威快照确认送达后，浏览器批注的本地 `sent` 标记进入独立持久补偿账本，不再占用发送 envelope 或阻塞后续队列；按真实标签分组幂等重放，已关闭标签按权威不存在收口。补偿完成前，同一批注 ID 不得被新的待发送或离线消息重复占用。恢复所需的大体积批注正文只允许出现在当前队列 DTO，不得永久复制到完整历史 submission 列表。
- 冷加载缺少 Provider user item 时，排队、派发、活动、失败、完成和已引导 submission 仍按同一客户端身份收敛；取消和删除明确退出，失败或需要用户处理的暂停态不得继续保留空白回复空间。
- 明确发送时，用户消息和新轮次回复空间在首次绘制前一起定位；同一消息后续收到 Provider 开轮事件时不得再次滚动。用户主动上滚后到达的远端轮次继续尊重静态阅读位置。
- 流式正文和思考摘要按帧级小批次连续投影；同帧增量允许合并，终态立即追平。不得为每个增量取消并重启淡入或位移动画；只对真实新增节点播放一次短入场，并在系统减少动态效果时停用。
- 思考摘要的视觉文字与读屏播报解耦。活动文字可以连续增长，读屏只播报有意义的状态变化，不逐增量重复整段摘要。
- 会话选择属于紧急身份更新。命中热缓存时立即显示目标真实正文并后台校准；未命中时立即显示目标标题、输入区和目标专属加载态。旧会话正文必须在同一次选择提交中退出，不得继续保留到目标快照就绪。
- 冷加载期间的新输入只归属目标会话，并按稳定身份安全等待目标快照；不得发送到已经退出画面的旧会话。身份切换不使用会保留旧界面的延迟提交。
- 本节覆盖 `ZEUS-0224` 中“首次读取目标时保留旧正文”的旧过渡口径，以及 `ZEUS-0078` 中“排队消息正文只在输入区附近显示”的旧视觉口径；跨项目原子导航、热缓存身份校验、队列操作和失败恢复规则不变。

优点：消息从发送到回复保持稳定位置，流式内容连续可读，会话选择与主区身份从第一帧一致；冷切换只挂载一个工作面，减少长正文 DOM、控制器订阅和绘制成本。

代价：冷缓存会短暂显示目标骨架；时间线会展示尚未进入 Provider 的排队消息，因此必须保留明确状态；极端超长历史仍可能需要后续可见区渲染优化。

完整诊断、实施结果与验证边界见 `docs/ZEUS-0288_会话消息创建与切换流式性能优化.md`。
