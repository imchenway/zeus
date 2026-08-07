# 会话失败原因与 DeepSeek 渠道能力续接

## 任务目标

1. 真实会话或执行轮次失败后，Zeus 会话页面必须展示可理解的失败原因，而不是只显示“本轮失败”。
2. 接续两份历史会话记录，继续确认 DeepSeek 官方直连与阿里云百炼托管渠道的思考深度和 Responses API 能力差异。

## 历史会话来源

- `/Users/david/.codex/sessions/2026/08/06/rollout-2026-08-06T10-57-59-019fd501-9896-7871-8f09-bc5da8b41e71.jsonl`
- `/Users/david/.codex/sessions/2026/08/06/rollout-2026-08-06T16-38-44-019fd639-90a8-7f83-8d0d-721e68dcbac0.jsonl`

历史会话已经确认：思考模式与思考深度是两个概念；支持思考深度时不显示 `off`；不支持或未验证时隐藏深度控件；系统旧默认允许精确迁移，用户手工能力配置不能被模板静默覆盖。模型能力由接入渠道、具体模型和协议端点共同决定，不能把 DeepSeek 官方直连结论直接套给百炼托管模型。

## 已确认的错误展示口径

真实会话或真实执行轮次已经建立后，失败必须保留在该会话时间线中，并使用“就地原因卡片 + 可展开脱敏技术详情”展示。

### 优点

- 用户不需要寻找 JSONL 或日志，就能知道鉴权、限流、网络、模型参数或运行内核失败的真实原因。
- 简短原因和恢复建议面向普通用户，技术详情仍可支持排障。
- 错误属于具体会话和具体轮次，不会污染其他会话。

### 代价

- 需要统一清洗不同供应商和运行内核的错误形状。
- 技术详情必须脱敏，不能直接输出密钥、完整本机路径或堆栈。
- 历史失败记录只有在数据库已经保存错误内容时才能直接回显；不能凭空补造缺失的供应商错误。

## 当前阶段

- 已读取两份历史会话并恢复已有决策。
- 已确认会话失败原因的产品展示口径。
- 已确认示例失败轮次的完整 401 原因仍保存在 `conversation_turns.error_json`；旧本地 API 没有把该字段投影到会话快照，页面因此只能显示“本轮失败”。
- DeepSeek `/models` 仍只返回模型 ID、对象类型和归属，不返回思考深度，官方模板必须补充已知能力。
- DeepSeek 官方直连当前只有 `deepseek-v4-flash` 支持 Responses API；Chat Completions 中 Flash 的真实深度为 `low / high / max`，Pro 当前为 `high / max`，默认都是 `high`。
- 历史会话中“百炼 Responses 暂不支持 DeepSeek V4-Flash”的结论已经过时。百炼当前已把 `deepseek-v4-flash` 和 `deepseek-v4-flash-0731` 加入 Responses 支持清单，但只限华北 2（北京）和新加坡。
- 百炼 Chat Completions 接受 `low / medium / high / xhigh / max`，但官方声明 `low / medium` 实际等同 `high`、`xhigh` 实际等同 `max`；能力档案应表达真实可区分档位，不能把等效别名伪装成更多深度。
- 已完成错误投影、失败原因卡片、模板能力迁移和首批内置供应商入口。

## 已完成实现

### 会话失败原因

- 会话快照现在包含按轮次投影的失败原因，区分认证、限流、网络、配置、权限和未知错误。
- 页面在失败轮次原位置显示原因卡片、恢复建议和可展开技术详情。
- API Key、Bearer 凭据、本机完整路径和堆栈不会进入页面；数据库继续保留原始错误供本机诊断。
- 没有可见消息条目的失败轮次也会单独显示原因卡片，不再因缺少助手回复而消失。

### 内置供应商与能力

- 首批内置入口为阿里云百炼、DeepSeek、Kimi、Z.AI / GLM；未知或私有渠道继续使用自定义供应商。
- 内置入口固定官方端点和模型目录，只展示 API Key、连接操作、候选模型和状态，不允许在内置入口手工改写地址或能力。
- DeepSeek 官方 V4-Flash 旧默认迁移为 `low / high / max`，V4-Pro 迁移为 `high / max`。
- 百炼托管的 DeepSeek V4-Flash / V4-Pro 只展示真实可区分的 `high / max`。
- 迁移只命中旧系统的精确默认值；用户已经修改过的能力配置保持原样。
- 未验证或不支持思考深度的模型返回空档位，会话输入框和任务推送弹窗直接隐藏深度控件。
- 图片能力为“未验证”时允许尝试；只有明确标记“不支持”时才关闭图片入口。调用失败不会自动永久修改能力状态。

## 真实失败记录结论

示例会话失败不是 DeepSeek 思考参数导致。真实原因是请求发往 `https://api.openai.com/v1/responses` 时没有 Bearer 或 Basic 认证头，供应商返回 `401 Unauthorized`。隔离 `Zeus Test.app` 的本地 API 已把它投影为：

- 分类：认证失败；
- 错误代码：`ZEUS_CODEX_TURN_FAILED`；
- 原始原因：保留 401、请求地址和请求标识，并完成凭据与本机信息脱敏。

## 验证结果

- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm package:mac`：通过，产物为 `dist/test/mac-arm64/Zeus Test.app`。
- Bundle ID：`dev.hypha.zeus.test`；`codesign --verify --deep --strict`：通过。
- 使用正式数据库的 SQLite 隔离副本启动测试包，`PRAGMA quick_check` 返回 `ok`；历史失败轮次通过测试包真实本地 API 返回认证失败和完整脱敏原因。
- 当前 Mac 锁屏，Computer Use 无法读取窗口，因此没有把 GUI 目视结果标记为通过。失败卡片的 JS 和 CSS 已进入打包 Renderer，仍需解锁后补一次真实窗口目视。
- 隔离验收数据和进程已清理；数据库副本已移入废纸篓，可恢复，正式 `~/.zeus/zeus.db` 与 `/Applications/Zeus.app` 未修改。

## 历史会话中仍未交付的范围

两份 JSONL 后半段还确认了“Pi 与 App Server 共用 Zeus 公共工具、标准 MCP、权限和审批”的平台级改造。当前 Pi 已有文件与命令工具，但浏览器、电脑控制、Zeus 统一 MCP 配置/导入和跨内核完整验收尚未实现。本任务不能把供应商和错误展示完成夸大成这部分也已完成。

## 官方资料

- DeepSeek 模型目录：<https://api-docs.deepseek.com/zh-cn/api/list-models/>
- DeepSeek Chat Completions：<https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/>
- DeepSeek Responses：<https://api-docs.deepseek.com/zh-cn/api/create-response/>
- 百炼 DeepSeek：<https://help.aliyun.com/zh/model-studio/deepseek-api>
- 百炼 OpenAI Responses 兼容：<https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api>
- Kimi Chat Completions：<https://platform.kimi.com/docs/api/chat>
- Z.AI HTTP API：<https://docs.z.ai/guides/develop/http/introduction>
