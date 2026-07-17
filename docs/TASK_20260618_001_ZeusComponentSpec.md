# TASK_20260618_001  Zeus Component Spec

## 1. 目标与边界

本规范把用户提供的 Telegram macOS 截图中的高密度列表、对话阅读、输入 dock、inline keyboard 与轻量工具栏手感，迁移为 Zeus 自己的 macOS 产品组件语言；同时沿用用户最新要求的 Apple 风格：大面积中性白灰、低噪音系统控件、少量蓝色强调、扁平简约、无卡片堆叠。

边界：

- 这是 clean-room 组件规范，只描述可复用的布局密度、状态层级、动效手感与交互节奏。
- 不复制 Telegram 源码，不使用 Telegram 名称、logo、纸飞机图标或品牌资产。
- 不照抄 Telegram 蓝色品牌，而是映射为 Zeus 的 OKLCH token。
- 不新增假功能，不展示假项目、假任务、假会话、假图谱、假 Git diff 或假 Telegram 消息。
- 不改源码；本文件用于后续实现时锁定 DOM、CSS token、交互、响应式和验收口径。
- Apple 风格参考以 Apple 支持社区页面为视觉校准：白灰底色、克制分隔、少量系统蓝、内容优先、控件不抢戏。

## 2. Telegram 截图组件拆解

> 当前参考图文件尺寸为 2304 × 2530。以下尺寸为肉眼估算，后续实现时需要用截图叠层对照微调，允许 ±2 到 ±6px 的误差；若运行环境按 Retina 缩放展示，应以截图叠层后的 CSS px 为准。

### 2.1 左侧 source-list 侧栏

- 视觉构成：固定宽度浅色侧栏，顶部窗口交通灯与标题区，下方搜索框、分类 tab、归档入口、会话列表，底部四个低噪音图标入口。
- 尺寸与间距：侧栏宽约 780px 中的 390px 左栏；Zeus 建议桌面侧栏 276 到 320px，项目/会话密集列表区行距稳定；左右内边距 16 到 22px。
- 状态：
  - default：透明或轻微中性灰底，只有文字、头像、时间戳和分隔线。
  - hover：行背景提升到 `source-list.hover`，不出现厚边框。
  - selected：整行蓝色或低饱和选中底，Zeus 默认用中性灰选中，主操作才用蓝。
  - focus：2px 柔和 focus ring，不能刺眼。
  - disabled：降低 opacity，不移除布局位置。
  - loading：行内右侧小 spinner，不整屏遮挡。
  - empty：列表区显示一行说明和一个主动作，不出现大卡片。
  - error：行内错误状态或顶部窄条，不弹大模态。
- 动效：hover/selected 150 到 180ms；项目展开用 opacity + transform，避免直接动画 width/height。
- Zeus 适用：项目列表、任务列表、会话列表、图谱搜索结果、Git 文件列表。

### 2.2 搜索框

- 视觉构成：圆角胶囊输入框，浅灰底，无厚边框，左侧搜索图标，占位文字灰度轻。
- 尺寸与间距：高度 36 到 40px；圆角 14 到 18px；左右 padding 12 到 16px；侧栏内上下间距 10 到 14px。
- 状态：default 低对比背景；focus 出现细 focus ring 和更高背景亮度；输入中右侧可显示清除按钮；disabled 使用低透明度；error 只在下方显示短句。
- 动效：focus ring 120 到 160ms，opacity/box-shadow 过渡。
- Zeus 适用：全局搜索、项目搜索、任务筛选、会话搜索、图谱节点搜索。

### 2.3 归档入口

- 视觉构成：独立浅灰圆角行，左侧归档图标，文字居中偏左，右侧无强按钮。
- 尺寸与间距：高度 38 到 42px；圆角 10 到 14px；与上方 tab 间距 8 到 12px。
- 状态：hover 背景微加深；selected 可显示中性灰选中；empty 时隐藏计数。
- Zeus 适用：归档任务、归档会话、隐藏项目、归档图谱问答历史。

### 2.4 会话行

- 视觉构成：左侧圆形身份头像，中间两行文本，右侧时间/状态；底部 1px 中性分隔线。
- 尺寸与间距：行高 72 到 86px；头像 48 到 56px；文字区左间距 12 到 14px；右侧 meta 宽 44 到 64px。
- 状态：selected 使用整行填充；hover 轻灰；unread 可加粗 primary；loading 在 meta 区显示小进度；error 在 secondary 前加小语义图标。
- Zeus 适用：会话列表、任务事件列表、Runtime 会话列表、Telegram 远程回执列表。

### 2.5 选中态

- 视觉构成：整行圆角或满宽选中，不使用卡片阴影。Telegram 截图里选中会话为蓝底白字；Zeus 默认项目/任务列表采用中性灰选中，危险/主路径按钮才使用系统蓝。
- 尺寸与间距：行内保留 8 到 12px 内边距，圆角 10 到 14px。
- 状态：selected + focus 不能叠成重边框，只保留一层可见焦点。
- Zeus 适用：当前项目、当前任务、当前会话、当前图谱视图。

### 2.6 圆形身份头像

- 视觉构成：圆形色块、字母或语义图标、可选状态点；不使用 Telegram 资产。
- 尺寸：侧栏 32 到 48px；会话列表 48 到 56px；顶部对象栏 34 到 44px。
- 状态：online/active 用小绿点；warning/error 用低饱和语义点；loading 用轻量环形进度。
- Zeus 适用：项目、Bot、任务、会话、Runtime、Git 变更来源。

### 2.7 顶部对象栏

- 视觉构成：右侧主内容顶部横条，左侧对象头像与标题/副标题，右侧搜索、更多、状态按钮。没有重复页面大标题。
- 尺寸：高度 54 到 66px；左右 padding 18 到 28px；右侧按钮 32 到 40px。
- 状态：scroll 后可轻微保留背景；对象未选择时显示空态对象栏；loading 只影响状态副标题。
- Zeus 适用：当前项目、当前任务、当前会话、当前图谱视图、Git diff 审查对象。

### 2.8 消息阅读区

- 视觉构成：大面积白灰底，消息按时间纵向流动；长文本最大行宽受控；系统消息、用户消息、AI 回复有轻微角色差异但不做重卡片。
- 尺寸：正文行宽 68 到 78ch；段间距 10 到 16px；消息组间距 18 到 28px。
- 状态：streaming 显示行内光标或小状态；error 显示可重试行；empty 显示起始说明和输入 dock。
- Zeus 适用：AI 会话、任务结果、Telegram 回执、Runtime 摘要、图谱问答回答。

### 2.9 消息时间戳

- 视觉构成：靠右灰色小字，不抢正文。
- 尺寸：11 到 12px；与正文同行或消息组右上角。
- 状态：失败时可替换为错误状态词；pending 时显示发送中。
- Zeus 适用：会话消息、任务事件、Git 确认记录、Telegram update。

### 2.10 Bot inline keyboard / decision rail

- 视觉构成：灰色低饱和按钮网格，按钮之间 1px 分隔，整组圆角；按钮文字居中。
- 尺寸：高度 40 到 46px；2 列或 3 列；容器圆角 10 到 14px；分隔线 1px。
- 状态：hover 背景略亮；active 按下内陷；disabled 灰化并显示原因；loading 按钮内 spinner。
- Zeus 适用：Plan 决策、高风险确认、任务建议、Git 确认、Telegram 远程命令确认。

### 2.11 composer 输入区

- 视觉构成：底部固定输入区，左侧命令/菜单按钮，中间圆角输入框，右侧附件/工具/发送或停止按钮，下方可附属模式 rail。
- 尺寸：输入 dock 总高 56 到 72px；输入框高度 40 到 48px，支持多行最大 140 到 180px；工具按钮 36 到 44px。
- 状态：focus ring 柔和；disabled 显示短原因；sending 切换为停止；error 不清空用户输入。
- Zeus 适用：会话输入、图谱问答、任务输入、Runtime 命令建议。

### 2.12 底部模式 rail

- 视觉构成：composer 下方或附属区域的窄条，用分段显示当前模式，如命令、Plan、项目上下文。
- 尺寸：高度 30 到 38px；圆角 12 到 18px；分隔 1px。
- 状态：active 轻底色；off 降噪灰色；warning 用低饱和黄，不大面积着色。
- Zeus 适用：PLAN 模式、运行目标、项目上下文、远程控制状态。

### 2.13 更多菜单、搜索、附件、语音、表情等工具按钮

- 视觉构成：圆形或胶囊轻按钮，图标线性，默认不填充；更多菜单为轻量 popover。
- 尺寸：按钮 32 到 40px；popover 宽 180 到 260px；菜单项高 30 到 36px。
- 状态：hover 轻灰；active 有按下反馈；危险项只用低饱和红文字，不做大红背景。
- Zeus 适用：项目更多、任务更多、会话更多、Git 文件操作、图谱节点菜单。

## 3. Zeus Component Spec

### 3.1 ZeusSourceList

用途：项目列表、任务列表、会话列表、图谱节点结果、Git 文件列表。

结构：四槽位。

1. `avatar/icon`：身份、类型或状态。
2. `primary text`：项目名、任务标题、会话名、文件名。
3. `secondary text`：路径、摘要、状态、最近消息。
4. `meta/action`：时间、计数、更多、设置、状态点。

规格：

- 默认行高：项目 38 到 44px；任务/会话 64 到 82px；Git 文件 34 到 42px。
- 文字：primary 13 到 15px，字重 500 到 650；secondary 12 到 13px，中性灰。
- 分隔：列表内使用 1px 中性线或留白，不使用卡片阴影。
- 选中态：中性浅灰整行选中；仅在需要表达强当前会话时允许系统蓝。
- 键盘：上下键移动，Enter 打开，Space 展开/收起，Esc 关闭更多菜单。
- 无障碍：`role="listbox"` 或 `navigation`；当前项 `aria-current="page"` 或 `aria-selected="true"`；更多按钮必须有 `aria-label`。

替换对象：旧项目卡片、任务卡片、会话卡片、Git 文件块、图谱节点卡片。

### 3.2 ZeusObjectToolbar

用途：当前项目、当前任务、当前会话、当前图谱视图、当前 Git diff 顶部对象栏。

结构：

- 左：AvatarToken + 对象名 + 状态副标题。
- 中：可选状态 pill 或路径 crumb。
- 右：搜索、刷新、更多、主动作。

规格：

- 高度 56 到 64px，固定在工作区顶部。
- 不重复页面大标题；如果侧栏/面包屑已经说明当前页，内容区直接进入对象状态与操作。
- hover/focus 只作用在按钮，不让整条 toolbar 发光。
- 对象切换动效：内容 opacity 120ms，toolbar 不横向漂移。

替换对象：页面级大标题、重复说明文案、顶部按钮堆。

### 3.3 ZeusMessageTranscript

用途：AI 会话、任务结果、Telegram 回执、Runtime 摘要、图谱问答。

规格：

- 阅读区最大正文宽度 72ch，宽屏居中或靠工作流主轴，不满屏铺开。
- 消息组内段落间距 10 到 14px，消息组间距 20 到 28px。
- 时间戳靠右小字，颜色 `message.meta`。
- 来源追溯用轻量 disclosure / inline source chips，不用厚卡片。
- 空态只说明下一步，不写“在这里查看 xxx”。
- 长代码/日志进入可滚动代码块，最大高度 280 到 420px。

状态：streaming、sent、failed、retrying、archived、external-wait、empty。

### 3.4 ZeusDecisionRail

用途：Plan 决策、高风险确认、任务建议、Git 确认、Telegram 远程命令确认。

规格：

- 2 列默认；短按钮可 3 列；小屏降为 1 列。
- 容器背景 `decision.rail.bg`，按钮之间 `decision.rail.separator` 1px。
- 按钮高 40 到 44px；文字 13px；图标可选 14 到 16px。
- 危险动作独立分区，文字低饱和红，不用大红底。
- loading 时只锁当前按钮，其他安全按钮可按业务规则决定是否禁用。

键盘：Tab 进入 rail；方向键在按钮间移动；Enter/Space 触发；Esc 取消或返回 composer。

### 3.5 ZeusComposerDock

用途：会话输入、图谱问答、任务输入、Runtime 指令建议。

结构：

- 左：命令按钮、上下文/附件按钮。
- 中：多行输入框。
- 右：工具按钮、发送/停止按钮。
- 下：ModeRail，可选显示 Plan、目标项目、远程状态。

规格：

- 固定在当前工作区底部，不遮挡 transcript；主内容底部 padding 至少等于 composer 高度 + 16px。
- 输入框高度 40 到 48px，最多增长到 160px；超过后内部滚动。
- Cmd+Enter 发送，Enter 换行或按当前模式配置；Esc 取消 composing 或关闭浮层。
- disabled 状态必须显示原因，例如 AI CLI 未配置、无当前项目、任务已归档。

### 3.6 ZeusModeRail

用途：当前模式、计划模式、运行目标、项目上下文、远程控制状态。

规格：

- 高度 30 到 36px，附着在 composer 或工作区底部。
- 低噪音灰底，active 只加轻底和字重，不使用大面积蓝。
- 项目上下文改变时短暂 opacity 过渡，不让布局跳动。
- 小屏下保留最重要的 1 到 2 个模式，其余进更多菜单。

### 3.7 ZeusQuietMoreMenu

用途：低频操作收纳。

规格：

- 轻量 popover，宽 180 到 260px，圆角 12 到 16px，阴影克制。
- 菜单项高 32 到 38px，左图标 16px，右侧可有快捷键或状态。
- 分区用 1px 线或 8px 间距，不用大标题堆叠。
- 危险操作固定底部分区，点击后进入确认 rail 或确认抽屉。
- 打开/关闭动效：opacity + translateY 4px，120 到 160ms。

### 3.8 ZeusAvatarToken

用途：项目、Bot、任务、会话身份标识。

规格：

- 圆形或圆角方形 token，默认 32/40/48px 三档。
- 内容：首字母、目录图标、任务状态图标、Bot 状态图标。
- 状态点：右下角 8 到 10px，online/active/warning/error/loading。
- 色板：使用 Zeus avatar token，不使用 Telegram logo 或纸飞机。
- 无障碍：装饰头像 `aria-hidden="true"`；有状态意义时由相邻文本或 `aria-label` 描述。

## 4. 页面映射

### 4.1 项目侧栏

- 唯一核心目标：选择当前项目并进入项目内任务、代码、会话或项目设置。
- 首层展示：新对话、搜索、项目列表、当前项目展开的任务/代码/会话、底部全局设置。
- 二级收纳：项目删除、置顶、归档、路径重扫放入 QuietMoreMenu 或确认抽屉。
- 替换旧壳层：旧“项目/对话/设置”三入口、项目卡片、按钮堆。
- 禁止：把所有项目详情塞在侧栏；项目行不能变成大卡片。

### 4.2 项目任务页

- 唯一核心目标：管理当前项目的真实任务。
- 首层展示：任务 SourceList、筛选/排序、当前任务详情、状态主操作。
- 二级收纳：任务事件、归档、模板、Runtime 日志、Git 关联进入抽屉或对象详情。
- 替换对象：任务卡片网格、重复页面标题、松散操作按钮组。
- 禁止：任务页做成会话页；任务管理必须保留状态、筛选、详情和操作。

### 4.3 项目代码页

- 唯一核心目标：理解当前项目的代码库、图谱和影响范围。
- 首层展示：仓库状态、扫描/打开图谱、Git diff 入口、代码图谱舞台。
- 二级收纳：Mermaid、完整节点/边清单、问答历史、边详情、节点隐藏控制。
- 替换对象：旧 Code Map 功能平铺、图谱卡片堆、源码来源大段散落。
- 禁止：代码页把任务和会话混进首层；图谱抽屉内部不能继续乱堆。

### 4.4 项目会话页

- 唯一核心目标：推进当前项目的 AI 对话。
- 首层展示：左侧会话 SourceList，右侧 MessageTranscript，底部 ComposerDock。
- 二级收纳：Runtime、上下文、代码变更、模板、Telegram 回执。
- 替换对象：任务详情伪装成会话页、没有输入 dock 的消息列表。
- 禁止：会话页做成任务管理页；不能把所有上下文在首屏平铺。

### 4.5 图谱问答

- 唯一核心目标：基于真实图谱提问并追溯来源。
- 首层展示：问题输入、当前回答、来源、可继续追问。
- 二级收纳：历史搜索、归档问答、Mermaid 导出、节点/边完整清单。
- 替换对象：问答历史、节点列表、Mermaid 同屏纵向平铺。
- 禁止：无来源回答；无图谱时不能假装有答案。

### 4.6 Runtime 日志

- 唯一核心目标：查看和控制当前任务/会话关联 Runtime。
- 首层展示：运行状态、最近输出、停止/继续等安全操作。
- 二级收纳：完整日志、导出、环境检查、CLI 配置原因。
- 替换对象：终端日志大卡片、设置项混在日志首层。
- 禁止：外部 CLI 未配置时伪造运行成功。

### 4.7 Git 确认抽屉

- 唯一核心目标：让用户安全确认 Git 相关高风险动作。
- 首层展示：变更摘要、风险说明、DecisionRail。
- 二级收纳：完整 diff、文件级详情、历史确认记录。
- 替换对象：大红危险卡片、堆叠确认按钮。
- 禁止：默认执行写操作；必须保留二次确认和审计结果。

### 4.8 Telegram 设置与远程回执

- 唯一核心目标：配置远程控制并查看真实回执。
- 首层展示：启用状态、Token/whitelist 配置状态、最近 update。
- 二级收纳：长日志、敏感信息重置、轮询细节。
- 替换对象：全局设置中混入大量运行日志。
- 禁止：显示明文 bot token；未配置时不能展示假消息。

### 4.9 全局设置页

- 唯一核心目标：修改应用级配置。
- 首层展示：设置分类 SourceList + 当前分类 rows。
- 二级收纳：高级项、危险缓存清理、发布凭据、外部依赖等待项。
- 替换对象：首页设置卡片、Runtime 页中的设置平铺。
- 禁止：项目级配置混入全局设置；危险项无确认。

## 5. 设计 token

所有颜色使用 OKLCH，避免 `#000`、`#fff` 与 `rgba()`。命名为语义 token，不绑定 Telegram 品牌。

```css
:root {
  --zeus-surface-window: oklch(99.2% 0.002 255);
  --zeus-surface-sidebar: oklch(96.4% 0.003 255);
  --zeus-surface-workspace: oklch(98.4% 0.002 255);
  --zeus-line-subtle: oklch(88.5% 0.004 255);

  --zeus-source-list-bg: transparent;
  --zeus-source-list-hover: oklch(94.8% 0.003 255);
  --zeus-source-list-selected: oklch(91.8% 0.004 255);
  --zeus-source-list-selected-strong: oklch(62% 0.15 252);
  --zeus-sidebar-separator: oklch(87% 0.004 255);

  --zeus-avatar-green: oklch(72% 0.15 145);
  --zeus-avatar-blue: oklch(66% 0.14 252);
  --zeus-avatar-violet: oklch(67% 0.13 292);
  --zeus-avatar-orange: oklch(76% 0.14 55);
  --zeus-avatar-red: oklch(66% 0.16 25);
  --zeus-avatar-cyan: oklch(74% 0.12 195);

  --zeus-toolbar-bg: oklch(98.8% 0.002 255);
  --zeus-toolbar-line: oklch(88.8% 0.004 255);

  --zeus-message-text: oklch(23% 0.006 255);
  --zeus-message-meta: oklch(60% 0.004 255);
  --zeus-message-source-bg: oklch(95.2% 0.003 255);

  --zeus-decision-rail-bg: oklch(91.5% 0.004 255);
  --zeus-decision-rail-separator: oklch(82% 0.005 255);
  --zeus-decision-button-hover: oklch(94.5% 0.003 255);
  --zeus-decision-button-active: oklch(88.5% 0.005 255);

  --zeus-composer-bg: oklch(98.8% 0.002 255);
  --zeus-composer-input-bg: oklch(96% 0.003 255);
  --zeus-composer-focus-ring: oklch(70% 0.11 252);

  --zeus-mode-rail-bg: oklch(92.5% 0.004 255);
  --zeus-mode-rail-active: oklch(88.8% 0.006 255);

  --zeus-popover-bg: oklch(98.6% 0.002 255);
  --zeus-popover-shadow: 0 18px 44px color-mix(in oklch, oklch(40% 0.006 255) 16%, transparent);
  --zeus-danger-text: oklch(54% 0.14 25);
  --zeus-accent-blue: oklch(61% 0.15 252);
}
```

## 6. 交互与动效规范

- 侧栏行 hover 到 selected：150 到 180ms，`background-color`、`color`、`opacity`，不做弹跳。
- 项目展开/收起：160 到 220ms，优先 `opacity + transform + clip-path`；如必须改变高度，只在小范围内使用并避免影响右侧布局。
- 更多菜单弹出：120 到 160ms，`opacity + translateY(4px)`；点击外部、Esc、选择菜单项后关闭。
- composer focus：120 到 160ms，focus ring 与输入框背景过渡；不移动 dock。
- inline keyboard 按下：80 到 120ms，按钮背景变深并轻微 `translateY(1px)`。
- drawer/inspector 进入退出：180 到 240ms，`opacity + translateX(12px)` 或 `translateY(10px)`；不动画全局布局宽度。
- reduced motion：`prefers-reduced-motion: reduce` 时禁用 transform，保留 opacity 80 到 120ms 或直接切换。

禁止：

- 不动画 width/height 造成主布局漂移。
- 不用 bounce、elastic。
- 不用大面积 blur glass 做默认背景。
- 不用卡片阴影表达每个列表项。

## 7. 可访问性与键盘

- ZeusSourceList：使用 `role="listbox"` 或 `navigation`，当前项用 `aria-current` 或 `aria-selected`。
- 对象栏按钮：所有图标按钮必须有 `aria-label`，例如“打开项目菜单”“进入项目设置”。
- 输入区：focus 顺序为命令按钮、上下文/附件、输入框、工具按钮、发送/停止、ModeRail 控件。
- 键盘行为：
  - Esc：关闭 popover/drawer；在 composer 中取消待发送状态。
  - Enter：列表项打开；DecisionRail 按钮触发。
  - Cmd+Enter：composer 发送。
  - 上下键：source-list 内移动；输入框内有多行文本时优先移动光标，空输入时可回到历史。
  - 左右键：二级菜单或 decision rail 同行移动。
- focus ring：使用低饱和系统蓝，2px，外扩 1 到 2px；必须在浅灰背景上可见。
- aria 状态：loading、disabled、external wait 要有文本原因；不能只靠颜色表达。

## 8. 验收标准

### 8.1 结构验收

- [ ] 不出现 card grid。
- [ ] 不出现松散按钮堆。
- [ ] 不出现重复页面大标题。
- [ ] 左侧项目、任务、会话列表均使用 source-list 行结构。
- [ ] 顶部对象栏只说明当前对象，不重复导航标题。
- [ ] composer 不遮挡主内容，主内容底部留出安全空间。
- [ ] decision rail 可键盘访问。
- [ ] 更多菜单只收纳低频操作，危险操作有确认。

### 8.2 响应式验收

- [ ] 小屏下 source-list 不把右侧工作区挤爆。
- [ ] 竖屏下会话页保持左列表 + 右详情，必要时左列表可收纳，但不能堆叠漂移。
- [ ] 全屏下正文行宽受控，不把长文本铺满整屏。
- [ ] 图谱、日志、代码块有内部滚动，不撑爆抽屉。
- [ ] drawer/inspector 进入退出不会改变主工作区宽度导致跳动。

### 8.3 视觉验收

- [ ] 大面积背景为 Apple 式中性白灰，不偏青，不营销渐变。
- [ ] 蓝色只用于主操作、链接或强选中，不大面积铺底。
- [ ] 危险操作不大红大紫，只用低饱和红文字和确认流程。
- [ ] Telegram 品牌资产未进入 Zeus。
- [ ] 没有复制 Telegram 源码。

### 8.4 真实能力验收

- [ ] 每个组件都映射到 Zeus 真实能力，不展示假数据。
- [ ] 无真实来源时显示空态、未配置、外部等待或失败恢复。
- [ ] AI CLI、Telegram、Apple signing 未配置时不伪造成功。
- [ ] 高风险 Git/Shell/删除操作保留确认与审计。
- [ ] 双语切换后，按钮、输入框、下拉框、aria-label 与当前语言一致。

## 9. 后续实现建议

1. 先锁定 token 与组件 DOM 契约测试：SourceList、ObjectToolbar、MessageTranscript、DecisionRail、ComposerDock、ModeRail、QuietMoreMenu、AvatarToken。
2. 再替换 source-list：项目侧栏、任务列表、会话列表、Git 文件列表先统一行结构和选中态。
3. 再替换 composer 与 decision rail：会话输入、图谱问答、任务输入、高风险确认统一底部 dock 和 inline keyboard。
4. 再替换 toolbar / mode rail / more menu：去掉重复标题、松散按钮堆和重弹窗。
5. 最后做响应式、可访问性、反向扫描和 package gate：覆盖全屏、竖屏、小屏；检查无 card grid、无 Telegram 资产、无硬编码颜色、无语言泄漏。

## 10. 实施边界、风险与回滚

### 10.1 受影响目录

后续按本规范落地时，应优先影响以下目录；若某端不受影响，也必须在实现任务文档里明确说明原因。

- `/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx`
  - 负责组件 DOM 契约：SourceList 四槽位、ObjectToolbar、MessageTranscript、DecisionRail、ComposerDock、ModeRail、QuietMoreMenu、AvatarToken。
  - 任务页与代码页不得新增内层左栏；只有会话页允许保留会话列表 + 会话详情双栏。
- `/Users/david/hypha/zeus/apps/desktop/src/renderer/styles.css`
  - 负责 token、密度、响应式、动效、focus ring、popover/drawer/composer 视觉。
  - 不允许继续用卡片阴影、营销渐变、大按钮堆来表达列表或操作。
- `/Users/david/hypha/zeus/apps/desktop/test/*.test.tsx`
  - 负责 DOM 契约、语言对齐、响应式、无旧类名回流、无卡片堆回流、抽屉动效与可访问性。
- `/Users/david/hypha/zeus/docs/TASK_20260617_002_Zeus项目优先侧栏与项目内工作区重构.md`
  - 每轮实现必须记录受影响目录、契约变更、测试矩阵、风险与回滚、验证记录。
- 不涉及数据库表结构：本规范是桌面 UI 组件规范，不新增后端表、字段或迁移；若后续实现发现需要持久化 UI 偏好，必须另开契约说明。
- 不涉及 Telegram 品牌资产：只能使用 Zeus 自有图标、字母 token、状态点和语义颜色。

### 10.2 契约变更

- 组件契约从“页面各自写样式”收敛为 8 个可复用产品组件：`ZeusSourceList / ZeusObjectToolbar / ZeusMessageTranscript / ZeusDecisionRail / ZeusComposerDock / ZeusModeRail / ZeusQuietMoreMenu / ZeusAvatarToken`。
- 视觉契约从“卡片式后台”收敛为 Apple/macOS 扁平产品壳层：低色度冷中性背景、细分隔线、紧凑行高、明确 focus、少量蓝色强调。
- 信息架构契约固定：
  - 任务页：任务列表是主角，任务详情和事件服务于任务管理，不加内层左栏。
  - 代码页：代码逻辑图/图谱舞台是主角，节点、边、Mermaid、问答历史进入工具面板或抽屉，不加内层左栏。
  - 会话页：唯一允许左会话列表 + 右对话详情。
- 语言契约固定：按钮、输入框、下拉框、aria-label、空态、错误态、抽屉 chrome 必须跟随 `appLanguage`；真实项目名、路径、分支名、日志、用户输入不翻译。

### 10.3 测试矩阵

后续实现每轮至少覆盖：

| 类别 | 必测内容 | 建议证据 |
| --- | --- | --- |
| DOM 契约 | 8 个 Zeus 组件的 class/role/aria 与四槽位结构 | React 静态渲染测试 |
| 反回流 | 无 card grid、无松散按钮堆、无重复页面大标题、无旧 `details/summary` | `rg` 反向扫描 + 单元测试 |
| 布局 | 任务/代码无内层左栏，会话保留左列表右详情 | `renderToStaticMarkup` 结构断言 |
| 响应式 | 1180/860/760 断点不漂移、不堆叠、不横向撑爆 | CSS 契约测试 + 电脑操作抽查 |
| 双语 | 中文/英文按钮、下拉值、抽屉 chrome、空态一致 | 双语渲染测试 |
| 可访问性 | focus ring、aria-label、aria-current、键盘行为 | 单元测试 + 手动键盘抽查 |
| 动效 | popover/drawer/composer 使用 opacity/transform，禁 width/height 大布局动画 | CSS 反向扫描 |
| 发布门禁 | 退出 Zeus 后 `pnpm package:mac` 成功 | 打包日志 |

### 10.4 风险与回滚

- 风险：一次性替换所有页面组件容易引发视觉和行为混乱。控制方式：按组件壳层逐项替换，但每一轮都必须服务完整目标，不能把切片冒充整体完成。
- 风险：过度模仿 Telegram 会误用品牌资产或品牌蓝。控制方式：只迁移布局密度和交互节奏，颜色、命名、图标全部用 Zeus token。
- 风险：过度追求紧凑可能损害可读性。控制方式：列表紧凑，但消息正文、日志和代码块必须保留可读行宽与滚动边界。
- 风险：响应式只靠 CSS 隐藏旧 DOM。控制方式：任务/代码页必须从 React 结构上移除内层左栏，不允许只 `display:none`。
- 回滚：每轮实现应能按组件壳层回滚；若某组件替换造成核心流程不可用，优先回滚该组件 DOM/CSS 和对应测试，保留已验证的 token 与语言 copy；不得用 mock 数据或卡片堆回滚为“看起来完整”。

