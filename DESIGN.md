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
