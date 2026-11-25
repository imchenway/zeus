# Zeus 故障 Issue 诊断

- 用户贴出 `imchenway/zeus` 的 Issue 链接，或要求读取该仓库的 Issue 时，先读取 Issue 正文。
- 若正文包含 Zeus 故障报告 ID 和对应的私有 OSS 原包链接，直接执行 `node scripts/read-fault-report.mjs <Issue URL 或编号>`。该命令验证 Issue 来源及对象身份，通过诊断只读角色取回原始 JSONL。无需另行请求阿里云网页登录。
- 读取命令返回的本地 JSONL，核对报告 ID，先看采集限制，再解释原包能证实的故障。命令失败时报告实际失败阶段。只在当前任务内使用私有内容，公开评论和日志只放可公开的摘要。

## Zeus 模型与运行时接入

- 新增模型、供应商或运行时，或变更其账号、协议和会话能力时，按[模型与运行时接入标准](CONTRIBUTING.md#模型与运行时接入标准)确定复用范围、验收项和交付证据。
