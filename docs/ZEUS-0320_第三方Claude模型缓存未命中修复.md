# ZEUS-0320 第三方 Claude 模型缓存未命中修复

## 任务目标

修复通过第三方模型连接调用 Claude 时缓存始终没有命中的问题。用户给出的现场例子是 1XM.AI Claude 模型。

## 现状与根因

Zeus 当前把除 DeepSeek 官方 Responses 以外的所有第三方模型统一路由到 Pi 的 OpenAI Chat Completions 适配器：

- 模型连接只保留 `openai_completions` 与 `openai_responses` 两种协议；
- Pi 注册第三方连接时固定使用 `openai-completions`；
- Zeus 没有为第三方 Claude 请求发送 Anthropic Messages 的缓存断点；
- OpenAI 兼容用量解析只识别 OpenAI 风格的缓存字段，不能读取 Anthropic 原生的 `cache_creation_input_tokens` 与 `cache_read_input_tokens`。

1XM.AI 当前公开接入说明明确区分 Claude 与 GPT：Claude 模型推荐使用 `anthropic-messages`，GPT 模型使用 `openai-completions`。因此仅在 Zeus 的用量界面补字段不能修复问题；请求本身没有走能创建 Claude 缓存的协议，后续自然没有缓存可读。

## 修复决策

为每个第三方模型保留明确的请求协议，并在模型连接设置中允许选择：

- OpenAI Chat Completions：保留现有默认值，兼容既有连接；
- Anthropic Messages：交给 Pi 的原生 Anthropic 适配器发送缓存断点，并读取 Anthropic 缓存写入与缓存命中 Token；
- DeepSeek 官方 V4 Responses：继续由 Zeus 的既有证据路由决定，不允许界面把它改成第三方 Pi 协议。

不根据模型 ID 中是否包含 `claude` 自动切换协议，也不按 1XM 域名写死。模型名可能是供应商别名，同一个聚合连接也可能同时包含 Claude、GPT 与 Gemini；静默猜测协议会把其他模型请求发到错误端点。

## 方案取舍

优点：

- Claude 使用真实 Anthropic 缓存语义，请求和用量字段形成完整证据链；
- 同一聚合供应商内可以逐模型选择协议，不需要复制 API Key 或创建多套连接；
- 既有第三方模型继续默认走 OpenAI Chat Completions，不会因升级被静默改路由；
- 不依赖模型名称和供应商域名猜测能力。

缺点：

- 现有已经保存的 Claude 模型需要用户在连接设置中明确改为 Anthropic Messages；Zeus 不能在没有渠道证据时自动迁移；
- 第三方网关即使声称 Anthropic 兼容，也可能不支持缓存、工具或完整流式用量，最终仍以真实请求回执为准；
- 修改协议会改变执行快照的路由指纹，已排队提交不能静默沿用旧快照，需要按既有改路由语义重新派发。

## 安全与验证边界

- 不读取或展示用户 API Key；不调用用户已配置的真实第三方账号。
- 使用本机临时 HTTP 协议探针核对实际请求中的缓存断点，以及 Anthropic 流式响应到 Zeus 统一账本的缓存 Token 映射。
- 按项目规则执行格式检查、`pnpm lint`、`pnpm typecheck` 与 `pnpm build`；静态和本地探针成功不冒充真实 1XM 账号验收。

## 实施记录

- 2026-08-17：完成现有模型连接、Pi SDK、统一逐请求用量和界面链路诊断；确认故障发生在请求协议层，不是单纯的缓存命中率显示问题。
- 2026-08-17：确认内置 Pi SDK 已支持 Anthropic Messages、自动缓存断点，以及缓存创建和缓存读取 Token 解析；Zeus 当前没有把该能力暴露给第三方模型连接。
- 2026-08-17：模型定义新增 `anthropic_messages` 协议；自定义供应商的每个模型可以在设置中选择 OpenAI Chat Completions 或 Anthropic Messages，既有模型继续默认使用原协议。
- 2026-08-17：Pi 运行内核按模型注册 `anthropic-messages`，保留同一连接内不同模型混用协议的能力；会话执行审计同步记录实际 Pi API 类型。
- 2026-08-17：Anthropic 模型会把连接地址末尾的 `/v1` 交给 SDK 前移除，因为 Anthropic SDK 会固定追加 `/v1/messages`；这可避免 1XM 常见配置形成错误的 `/v1/v1/messages`。
- 2026-08-17：不按 `claude` 模型名或 1XM 域名自动改路由，避免第三方别名、混合模型连接和重复请求带来的兼容与计费风险。
- 2026-08-17：模型连接新增、修改、删除、清除密钥或刷新目录后立即让 Pi 的模型运行时缓存失效；下一次请求会按新配置重建，已经使用过 Pi 的当前应用无需重启，也不会因保存设置提前读取全部密钥。
- 2026-08-17：每个自定义模型新增认证方式：协议默认、`Authorization: Bearer` 和 Anthropic `x-api-key`；非 Anthropic 模型不允许保留 `x-api-key` 配置。
- 2026-08-17：Pi 运行时改为注册混合 API 的原生供应商，同一连接只解析一份钥匙，再在模型 API 分发边界决定钥匙进入 Bearer 还是 `x-api-key`；Bearer 模式会清空 Anthropic SDK 的 `apiKey` 入口，不会同时夹带两种认证头。
- 2026-08-17：协议 URL 构建收口到 AI Runtime；支持用户填写 Base URL 或标准完整端点，能够将 `/v1/messages`、`/chat/completions` 和 `/responses` 还原为 SDK 需要的 Base URL，且只追加一次路径。
- 2026-08-17：显式认证方式进入不含密钥的凭据槽路由身份；排队后改变 Bearer/`x-api-key` 会暂停旧提交，不会静默改头发送。适配器审计证据同步记录实际 API、认证方式和最终端点，不记录密钥。

## 验证记录

- 本机临时 Anthropic SSE 端点：通过。实际请求路径为 `/v1/messages`，请求体包含 `cache_control: { type: "ephemeral" }`；仿真回执中的 `cache_read_input_tokens: 80` 和 `cache_creation_input_tokens: 120` 被 Pi 映射为 `cacheRead: 80` 和 `cacheWrite: 120`。
- 本机 Anthropic 双认证探针：通过。`x_api_key` 模型只发 `x-api-key: virtual-key`，Bearer 模型只发 `Authorization: Bearer virtual-key`；两者都没有夹带另一种认证头，都保留缓存断点和缓存用量映射。
- 本机混合协议回归探针：通过。OpenAI Chat Completions 模型仍请求 `/v1/chat/completions`，只使用 Bearer；Anthropic 与 OpenAI 的标准完整端点都能还原并重建为原路径。
- 探针只使用本地临时端点和虚拟密钥，未读取或调用用户的 1XM 配置。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；Vite 只报告仓库既有的大分块体积提醒，不影响构建完成。
- 本阶段协议探针未调用真实 1XM 账号；后续 UI 收口阶段已完成 `pnpm package:mac` 与隔离 GUI 验收，详见下文。静态、构建、本地协议探针和界面结果均不冒充第三方线上验收。

## 公开资料

- [1XM.AI OpenClaw 配置指南](https://1xm.ai/docs/tools/openclaw.html)：Claude 使用 `anthropic-messages`，示例连接地址以 `/v1` 结尾。
- [1XM.AI QClaw 配置指南](https://1xm.ai/docs/tools/qclaw.html)：Anthropic 协议地址不含 `/v1`；Zeus 因此在 Anthropic SDK 边界统一处理末尾 `/v1`，避免重复路径。
- [Claude Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：缓存断点、缓存创建/读取用量字段、最小可缓存长度和默认有效期说明。

## CC Switch 参考实现调研

### 核对范围

- 2026-08-17 只读核对 `farion1231/cc-switch` 仓库提交 `3d126f458a63c692b8434871a0868f1f7abf814f`；没有运行 CC Switch、导入 Zeus 凭据或调用真实模型。
- 重点阅读供应商数据模型、Claude 协议适配、本地路由、模型目录获取、缓存断点注入和用量解析实现。

### 最有价值的启发

CC Switch 把一次调用拆成了几个不同概念：

1. 客户端协议：Claude Code 或 Codex 原本会发什么格式。
2. 上游协议：真正发给中转站的是 Anthropic Messages、OpenAI Chat Completions 还是 OpenAI Responses。
3. 认证方式：密钥是放在 `x-api-key`、`Authorization: Bearer` 还是自定义请求头。
4. 端点规则：保存的是 Base URL 还是完整请求 URL，协议适配器应追加哪个路径。
5. 模型映射：外部模型 ID 如何对应主模型、快速模型或子任务模型。
6. 转换与用量：请求体、工具调用、思考内容、SSE 流式事件、停止原因和缓存 Token 都要按协议分别转换。

这验证了 Zeus 不应再把“供应商”、“模型”和“协议”混成一个判断。同一域名和 Base URL 只代表同一个入口，路径、请求体、请求头和回包格式才决定实际协议。

CC Switch 的本地路由还能做双向协议翻译：例如 Claude Code 仍发 Anthropic Messages，本地路由可以把它转成 OpenAI Responses 发给上游，再把回包转回 Claude Code 认识的格式。这说明协议的作用点在“客户端与上游之间的路由/适配层”，不在域名本身。

### 对 Zeus 可直接借鉴的部分

- 保留当前“每个模型明确选择协议”的方向。优点是一个 1XM 连接可以同时承载 GPT 和 Claude；缺点是模型多时会有重复配置，后续可用可复用的“协议路由配置”减少重复。
- 将认证方式从协议中独立出来。优点是可同时支持 Anthropic 官方的 `x-api-key` 和中转站常见的 Bearer；缺点是设置项会增加，需要给模板供应商提供可靠默认值。
- 增加明确的端点模式：Base URL 与完整端点 URL 分开，并由中央 URL 构建器追加 `/v1/messages`、`/chat/completions` 或 `/responses`。优点是能根治 `/v1/v1/messages`；缺点是需要兼容旧配置并处理少数非标准站点。
- 将连通性和健康状态细化到“连接 + 协议 + 模型”。优点是不会因 `/models` 可用就误判 Claude 缓存链路可用；缺点是探测次数和状态管理成本会增加。
- 缓存用量保留协议来源：Anthropic 读取 `cache_read_input_tokens`/`cache_creation_input_tokens`，OpenAI 读取其对应字段。优点是证据可审计；缺点是统一账本需同时保留标准化数值与原始字段。

### 不应直接照搬的部分

- CC Switch 的 `apiFormat` 主要是供应商级配置。它简单，但不能自然表达“同一供应商下 GPT 走 OpenAI、Claude 走 Anthropic”；Zeus 不应退回供应商级单协议。
- CC Switch 大量把各应用原生配置保存在通用 JSON 中。优点是扩展快；缺点是类型校验、迁移和界面一致性更难，Zeus 应继续使用明确类型。
- CC Switch 的完整协议翻译能力很强，但需要长期跟进工具调用、思考、图片/PDF、SSE 和用量语义。Pi 已能原生调用 Anthropic 时，Zeus 暂时没有必要先增加这层复杂性。
- 不借鉴按供应商名、域名或模型名关键字猜测能力的做法。别名和未来模型会让猜测失效，Zeus 应使用显式配置和真实探测证据。

### 后续优先级建议

1. 已完成：Anthropic 路由已覆盖协议默认、`x-api-key` 与 Bearer，并通过不夹带另一认证头的本地请求验证。
2. 已完成：Base URL/标准完整端点规则已收口到统一的协议 URL 构建层。
3. 近期：为模型连接增加协议级轻量探测与可审计错误，不再只用模型目录请求代表整条调用链路。
4. 中期：如果单个连接中的模型数量很多，再引入可复用的“协议路由配置”，让多个模型引用同一组协议、认证和端点规则。

### 当前执行结论

ZEUS-0320 先完成“Claude 原生缓存链路可用且可证明”的闭环，不在本任务中扩展为完整的跨协议翻译网关。收口条件为：

1. 模型绑定 Anthropic Messages 后，运行时确实走 `/v1/messages`，不回落到 OpenAI Chat Completions。
2. 补齐中转站认证方式，不把“Anthropic 协议”等同于“必须使用 `x-api-key`”。
3. Base URL 和完整请求路径只由一处构建，避免 `/v1/v1/messages`。
4. 本地探针证明请求含缓存断点，且缓存创建/读取 Token 能进入 Zeus 账本。
5. 真实 1XM 端到端验收必须由用户显式发起：对稳定的长前缀连续调用两次，首次观察缓存创建，第二次观察缓存读取；未经授权不使用用户凭据产生请求或费用。

在该闭环之后，再以独立任务引入“连接 → 协议路由 → 模型绑定”的可复用数据结构。这能避免为了修一个缓存问题同时改造全部 Provider 架构，降低已有 GPT、DeepSeek 和排队任务路由回归风险。

## 模型管理页面 UI 收口

### 现场问题

用户截图中的模型列表同时存在结构和颜色语义错误：

- 每个模型外层是一张大卡片，推理、工具调用和图片输入又各自套一张卡片，重复边框与留白导致纵向高度失控；
- 能力块把文字颜色变量 `--zeus-product-subtle` 错当成背景变量，形成大面积中灰底，文字对比度明显下降；
- 完整推理档位与三段能力依据默认全部铺开，真正需要操作的协议和认证反而缺少清晰层级；
- 供应商列表没有明确的选中态；滚动到长模型列表后，供应商导航会离开视口并留下空列。

### 设计决策

模型管理的核心目标是“快速确认当前模型走哪条协议，并能高密度扫读多个模型”。因此本次改为单层模型行：

- 首行只保留启用状态、模型 ID、当前协议与认证摘要，以及图标化移除入口；
- 自定义供应商的请求协议和认证方式使用两列真实 `ZeusSelect`，不把技术参数混入能力卡片；
- Claude 原生缓存链路使用一行短说明明确展示，OpenAI 兼容链路使用对应说明；
- 推理、工具调用和图片输入合并为一条三列能力栏，只展示默认档位和当前状态；
- 完整能力原因进入原生折叠区，默认不占用列表高度，但仍可通过键盘展开查看；
- 供应商列表改为单一列表表面，补齐 hover、选中态和键盘焦点；桌面端滚动时保持粘性，窄窗口恢复普通文档流；
- 长模型列表使用 `content-visibility: auto`，避免不可见模型持续参与昂贵绘制。

优点：协议与认证成为第一操作层级，单行高度从首轮实测的 259px 收敛到 210px，1240×820 窗口可以看到三个完整模型和第四个模型开头；浅色、深色与窄窗口保持同一信息结构。

缺点：完整能力依据不再默认展开，需要用户额外点击一次；桌面端供应商导航保持粘性后会持续占用 164px 左列，但能避免长列表滚动时失去当前供应商上下文。

### UI 验证记录

- 浏览器优先检查：Vite 页面能加载，但因缺少 Electron 本地桥接只显示“Zeus 启动失败”；该页面没有被用作桌面 GUI 证据。
- 最新 `pnpm package:mac`：通过，只生成 `dist/test/mac-arm64/Zeus Test.app`、测试 DMG 与 blockmap；包体磁盘签名结构校验通过，测试包仍为 ad-hoc 签名且未公证。
- 隔离运行：只启动当前 worktree 的 `Zeus Test.app`，使用 `/private/tmp/zeus-0320-gui.YfRuC9` 作为独立 `ZEUS_USER_DATA_DIR`；没有启动、关闭或修改正式 `Zeus.app`。
- 验收数据：在隔离目录创建一个无 API Key 的本机供应商和四个模型，只验证设置保存与界面投影；没有读取正式配置，没有发起模型目录或第三方推理请求。
- 真实 Renderer 交互：成功将前两个模型切换为 Anthropic Messages 并保存；协议下拉、供应商保存反馈和模型重新载入正常。
- 桌面浅色：1240×820 视口下每个模型行实测 210px，能力栏为三等列，模型行背景使用产品面板色，能力栏使用 `--zeus-product-panel-muted`，不再出现中灰底错误；供应商导航在滚动后保持 `position: sticky` 且顶部为 8px。
- 窄窗口：640×760 视口下页面 `scrollWidth` 与 `clientWidth` 均为 640px，模型行宽 576px，无水平溢出；协议与认证仍为两列，能力栏仍可完整扫读。
- 深色：模型行、能力栏、边框、主文字和辅助文字均消费深色主题语义变量，没有固定浅色背景或灰底黑字回归。
- 键盘与折叠：从模型复选框按 Tab 能进入移除按钮，`:focus-visible` 焦点环可见；能力依据可展开，模型行从 210px 增至 274px，并显示三项真实能力原因。
- 本机界面控制服务连续两次启动失败，因此没有把鼠标级 Computer Use 自动化表述为通过；上述 GUI 证据来自隔离测试包自身只读调试端口中的真实 Renderer DOM、计算样式与截图。
- `pnpm exec prettier --check apps/desktop/src/renderer/settings/ModelConnectionsSettingsPane.tsx apps/desktop/src/renderer/styles.css`：通过。
- `git diff --check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；最终 `pnpm package:mac` 内再次完成全仓构建，只有既有的大分块体积提醒。
