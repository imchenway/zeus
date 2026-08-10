# ZEUS-0084 Codex 用量、缓存与费用统计

## 任务信息

- 任务标题：个人 Token 用量以及剩余量这些信息在 Zeus 能做吗？
- 任务类型：需求
- 实施日期：2026-08-10
- 当前阶段：功能实现完成；真实 ChatGPT 登录账户与真实会话用量验收待用户完成官方认证。
- 实施边界：只实现 Codex，不修改 Git 历史或远端，不使用生产身份应用，不新增账户消费动作。

## 最终产品口径

1. 设置页新增独立“用量”分类，严格分为“Codex 账户总览”和“Zeus 内使用明细”。前者覆盖所有 Codex 客户端的官方账户数据，后者只覆盖 Zeus 功能启用后采集的逐轮数据，两者禁止相加。
2. 会话顶部不展示账户剩余额度。折叠摘要只展示会话累计 Token 和缓存 Token 命中率；展开后展示完整 Token 分类、上下文占用、估算 Credits、API 等价美元、费用覆盖率和价格来源日期。
3. 缓存 Token 命中率固定为“缓存读取 Token ÷ 输入 Token”。输入为零或字段缺失时显示“不可用”，缓存写入量单独展示。
4. 不展示可用重置次数，不提供使用重置、购买 Credits 或其他账户变更操作。
5. API Key 产生的数据只属于本机 Zeus 明细，不伪装成 ChatGPT 官方账户统计。
6. Credits 和 API 等价美元都属于估算，不称为实际账单，不换算人民币；官方账户总览没有模型维度，因此不估算全账户费用。

这套口径的优点是官方账户事实与 Zeus 本地归因不会互相污染，历史估算也不会随新价格漂移。缺点是本地详细统计只能从功能启用后开始，且未登记模型在 Zeus 更新价格目录前只有真实 Token、没有费用。

## 数据与协议实现

### Codex App Server

- 新增 `account/rateLimits/read` 与 `account/usage/read` 主动读取。
- `account/rateLimits/updated` 只作为稀疏更新信号，250 毫秒内合并重复通知并重新读取完整 usage 与 limits，不用稀疏包覆盖完整快照。
- `account/updated` 使账户缓存失效并重新读取。
- 完整解析并保留 `ThreadTokenUsage.total`、`last`、`modelContextWindow`，以及总量、输入、缓存读取、缓存写入、输出、推理输出 Token。
- 账户指纹使用“本机随机盐 + 规范化账户身份”的 SHA-256，只用于本机隔离；不向 Renderer 暴露邮箱，也不保存 Token、API Key 或认证响应。

### 永久用量账本

- 新表 `codex_usage_ledger` 不与项目或会话建立级联外键。
- 以 `provider_id + provider_thread_id + provider_turn_id` 唯一约束幂等更新；逐轮使用事件的 `last` 入账，会话快照使用 `total`。
- 每轮保存 Provider、账户作用域、项目、会话、thread、turn、模型、服务档位、完整 Token 分类、发生时间、价格目录日期、费率快照和估算结果。
- 不保存消息正文、Prompt、文件路径、邮箱、Token 或认证响应。
- 归档、恢复、删除会话或项目不会删除账本；引用对象不存在时聚合结果显示“已删除会话/项目”。
- 旧会话快照只迁移可证实的累计值，标记 `historyComplete: false`，不伪造缓存、逐轮或费用历史。

### 公开类型与只读接口

- 新增 `TokenUsageBreakdown`、`NativeTokenUsageSnapshot`、`CodexUsageSummarySnapshot`、`CodexUsageAnalyticsSnapshot`。
- `GET /api/codex/usage-summary`：顶部 Zeus 弹层摘要。
- `GET /api/codex/usage-analytics?range=7d|30d|90d|all&projectId=&model=`：设置页完整统计与筛选。
- 逐轮 Token、账户或限额变化会广播 `codex.usage.changed`；Renderer 按节流策略重新读取。
- 官方快照更新后立即持久化到数据库；离线时保留最后一次官方快照并标记过期和错误。API Key 登录显示“不支持官方账户统计”。

## 价格目录与费用规则

价格目录日期为 2026-08-10，来源为：

- [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)
- [Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Codex Credits](https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits)
- [Codex Fast mode](https://learn.chatgpt.com/docs/agent-configuration/speed)

目录覆盖 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`。价格均按每 100 万 Token 保存，包含输入、缓存读取、官方明确时的缓存写入、输出、Fast 倍率和超过 272,000 输入 Token 的长上下文规则。

费用规则如下：

1. 多模型会话从逐轮账本汇总，不能用当前模型单价乘整个会话 Token。
2. 同一 turn 后续通知继续使用首次入账时保存的费率快照，升级 Zeus 后不按新价格重算历史。
3. 未登记模型、预览模型或官方未明确的价格组合保留真实 Token，费用显示“暂无官方价格”，并降低按可计费 Token 加权的费用覆盖率。
4. 推理输出是输出 Token 的分类展示，不在输出费用之外重复计费。
5. 缓存节省估算只比较缓存读取与普通输入的公开 API 单价。

## 界面实现

### 会话状态

- 折叠摘要：会话累计 Token、缓存 Token 命中率。
- 展开明细：模型、总量、输入、缓存读取、缓存写入、输出、推理输出、上下文占用、Credits、API 等价美元、缓存节省、费用覆盖率和价格来源。
- 不显示任何账户限额、剩余量或重置次数。
- 旧历史不完整时显示“该指标自用量采集启用后开始记录”。

### 设置页“用量”

- 官方区域显示计划、累计 Token、日峰值、最长运行时长、当前/最长连续天数、官方活动热力图和全部配额窗口。
- 本地区域默认 30 天，可切换 7/30/90 天/全部，并按项目、模型筛选。
- 本地指标包含会话数、轮次数、全部 Token 分类、缓存命中率、估算 Credits、估算美元、缓存节省和费用覆盖率。
- 展示本地活动热力图以及模型、项目、会话明细表；官方与本地使用“全部 Codex 客户端”“仅 Zeus”标识。

### 顶部 Zeus 弹层

- 56px 隐藏标题栏中央新增无拖拽命中区按钮。
- 展示计划、今日/近 7 日官方 Token、最紧迫配额剩余百分比与重置时间、本地近 7 日缓存命中率、Credits、美元和更新时间。
- 支持 Escape、外部点击关闭、焦点返回、键盘焦点样式和跳转完整统计。
- 覆盖加载、未登录、不支持、错误、离线旧数据、字段缺失与本地空态。
- 窄窗口复验发现设置导航与弹层层级相同会遮挡弹层，已把标题栏层提高到普通页面控件之上、真正模态层之下。

## 验证结果

### 静态、构建与打包

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm lint` | 通过 | ESLint 无错误。 |
| `pnpm typecheck` | 通过 | TypeScript project references 无错误。 |
| `pnpm build` | 通过 | 15 个工作区包和 Electron renderer/main/preload 构建完成。 |
| `pnpm package:mac` | 通过 | 只生成 `dist/test/mac-arm64/Zeus Test.app` 与测试 DMG。 |
| 包身份 | 通过 | `CFBundleIdentifier=dev.hypha.zeus.test`，显示名 `Zeus Test`。 |
| 签名与包健康 | 通过 | `codesign --verify --deep --strict` 通过；renderer 资源 36 个，main/preload/browser preload 完整。 |

### 一次性协议与账本冒烟

没有新增项目测试文件，使用临时数据库和进程内协议替身完成以下检查：

- 主动发出 `account/read`、`account/rateLimits/read`、`account/usage/read`，成功解析 2 个限额桶、`null` 累计指标和缺失每日桶。
- 连续 3 次稀疏限额通知只触发 1 次完整 usage 与 limits 重读。
- 同一 provider turn 重复通知只保留 1 条账；2 个真实唯一 turn 聚合为 2,100 Token，没有重复累计。
- 缓存读取 700 / 输入 1,400 得到 50% 加权命中率。
- 已登记模型与未知模型混用时费用覆盖率为 76.19%，未知模型没有借用相近价格。
- 标准、Fast、超过 272k 的长上下文及 Fast 长上下文价格分支分别命中对应费率。
- 切换账户后上一账户的本地 turn 数为 0；API Key 官方区域状态为“不支持”，不出现 ChatGPT 官方累计数据。
- 官方累计 123,456 Token 写入后关闭并重新打开数据库，离线读取仍保留该快照，标记 `stale=true` 并保留离线错误。
- 物理删除临时项目和会话后 2 条账本仍保留，分组标签变为“已删除项目/会话”。

### 隔离 Zeus Test.app GUI

- 启动方式明确移除自动化环境的 `ELECTRON_RUN_AS_NODE`，并设置 `ZEUS_USER_DATA_DIR=/private/tmp/zeus-0084-gui.DI1hPk`。
- 已确认 SQLite、Electron profile、Codex home 和 execution host 都落在该独立目录，没有复用正式 Zeus 数据。
- 标题栏 Zeus 按钮可点击；未登录弹层正确显示不可用状态、配置入口和完整统计入口。
- Escape 可关闭弹层，焦点返回 Zeus 按钮。
- “查看完整统计”可进入设置页并自动选中“用量”。
- 设置页官方区与“仅 Zeus”区分开显示；30 天可切换为 7 天并触发刷新。
- 浅色、深色、820px 窄窗口和系统 reduced motion 状态均完成真实 GUI 检查。
- 窄窗口遮挡问题修复后重新构建、重新打包，并在新包中复验通过。
- 运行中的两个只读 HTTP 接口均返回 200；未登录状态为 `signed_out`，本地 turn 为 0，价格目录日期正确。

内置浏览器的打开页与列出标签页调用均未返回，按前端验收约束没有改用外部 Playwright。上述 GUI 证据来自本任务路径的真实 Electron 测试包，不是浏览器预览。

## 剩余限制与后续验收

1. 独立 Codex home 是全新未登录状态。没有复制现有 Codex/ChatGPT 认证，因此尚未完成真实登录账户的累计 Token、每日桶、真实多限额窗口验收。
2. 因未完成官方登录，也尚未创建真实 Codex 会话，所以真实 `thread/tokenUsage/updated` 的缓存读写、模型切换和会话费用展示仍需登录后验收。
3. 登录动作会打开官方认证页并建立该独立 Codex home 的持续账户状态，需要用户亲自完成官方认证；不得用复制认证文件或正式 Zeus 数据替代。
4. 官方字段可能继续为 `null`，页面会显示不可用；这不是零值。
5. 测试包为临时 ad-hoc 签名且未公证，不代表正式发布候选验收。

## 交付状态

功能代码、文档、静态检查、构建、测试身份打包、协议/账本冒烟和未登录 GUI 验收已经完成。没有执行 commit、push、merge 或其他 Git 历史操作。
