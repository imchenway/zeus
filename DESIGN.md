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
    purpose: "代码页主角，承载真实系统架构图、接口时序图、模块流程图和方法逻辑图。"
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
- 任务页、代码页、设置页和会话页可以共享控件语言，但不能共享错误的信息架构：任务页以任务列表为主角，代码页以图谱画布为主角，设置页以偏好设置分组为主角，会话页才允许会话列表加详情。
- 外部设计系统只能作为结构与表达方式参考，不能把其品牌资源、品牌色、字体或 token 名称复制到 Zeus。

## 交互原语执行契约

- `Button`、`Select`、`ModalPortal`、`Drawer`、`SourceListRow` 是五类独立原语，不合并为万能组件。
- 原语组件统一拥有 DOM 结构、键盘语义、hover、focus、selected、disabled、动效和 reduced-motion；业务页面只提供内容并选择显式变体。
- `Button` 使用 `primary / secondary / danger` 语义变体和 `compact / regular` 尺寸；三种变体统一高度、字号、圆角、内边距、可见边框、焦点环、禁用和忙碌状态。危险按钮必须使用危险色边框与危险色焦点环，深色模式不得退回普通按钮的浅色描边。业务页面不得借用其他页面按钮 class，也不得为单个弹窗重写危险按钮皮肤。
- `Select` 的尺寸使用 `compact / regular / roomy` 组件属性，不通过父页面选择器推断。
- `Select` 展开层必须通过 portal 提升到应用壳层，并按触发器的视口坐标固定定位；展开层不得留在表单、抽屉或其他滚动容器中扩大 `scrollHeight`，展开前后业务布局尺寸必须保持不变。
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
- 任务表数据列头分别提供排序按钮、拖动换位把手和右缘列宽把手；三者命中区和键盘动作独立，禁止用整列头同时猜测点击、拖动与缩放意图。排序必须有升序、降序、未排序文本或图标语义，不能只靠颜色。
- 任务表标题与数据必须共享列内容锚点：普通文本列严格左对齐，时间等数字扫描列严格右对齐。拖动换位把手不得占用标题的流内宽度；左对齐列把操作区放在尾端，右对齐列把操作区放在首端，排序图标和控件显隐都不能推动标题锚点。
- 任务表换位把手和列宽把手默认保持视觉隐藏，只在当前列头 hover、focus-within、键盘移动或实际拖动时出现；控件命中区与键盘可达性始终保留。未排序列不显示排序图标，列标题本身继续作为排序按钮并通过可访问名称表达“未排序”。
- 指针拖动任务列时，表头与数据列使用临时顺序实时重排，并在目标列边缘显示插入线；松手后才把顺序写入布局草稿，取消拖动恢复原顺序。拖动预览不得触发保存、项目覆盖或全局设置写入。
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

## TASK_20260728_001 任务详情关联会话与状态联动契约

- 任务列表“任务状态”和任务详情状态选择器共用 `managementStatus` 事实源；两个入口修改后必须同步刷新，不把 Runtime 生命周期状态伪装成用户可编辑的任务状态。
- 任务详情不展示 AI CLI、Runtime 会话、运行命令或 Runtime 状态，也不提供“标记完成”“取消任务”等执行生命周期按钮。
- “已完成”和“已取消”是任务管理状态选项；修改任务管理状态不停止任何会话执行。执行轮次只允许在所属会话的输入区通过停止按钮中断。
- 一个任务可以关联多个会话。任务详情按更新时间展示全部未归档关联会话，点击后进入会话页并打开所选会话，不在任务抽屉内复制完整对话界面。
- “推送到新会话”是任务详情唯一主操作；它先打开模型、推理强度、工作模式、权限和首条消息确认弹窗，确认后始终以 `mode: create` 创建新会话，不静默复用历史会话。
- 关联会话区域必须覆盖加载、空、失败和有数据状态；历史加载失败不得阻断用户推送到新会话。

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

- 项目侧栏“命令”页合并展示全局与当前项目命令；全局行只读，项目行可维护。页面以命令列表为主路径，定义维护、权限开启和运行确认使用居中 ModalPortal 弹窗，执行历史与详情继续内联展示，不使用侧边抽屉。
- 全局设置“命令”分类维护全局命令；定义表单必须覆盖别名、说明、超时、启停、Telegram、三类风险及声明式参数，不为 Git 或微信增加专用字段。
- 运行确认弹窗在确认前同时展示命令文本、项目目录、参数、超时和风险；执行后在页面内展示持久状态、Runtime 终端日志和产物，图片产物可以按受控内容 API 预览。
- 项目配置中的 Shell 与 Git 写入使用紧凑原生复选框；事件值必须在状态更新前同步读取，禁止在函数式状态更新器中继续访问 React 事件对象，避免交互触发渲染崩溃。
- Telegram `/commands [项目]` 先选择项目，再展示全局与项目命令合并菜单；只显示命令自身 Telegram 开关已开启的项。定义维护仍只在桌面端完成。
- Telegram 执行复用本地命令 API 的权限、确认、风险和 Runtime 路径，不另写旁路执行器，也不使用高风险确认短语；按钮回调严格限制在 Bot API 的 64 字节内，状态优先编辑原消息，终态回传已复验产物。
