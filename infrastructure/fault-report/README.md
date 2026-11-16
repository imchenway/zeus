# Zeus 故障上报

客户端点击上报后先保存本机脱敏副本，再 POST 到 `https://zeus-report.hyphatech.cn/reports`。FC 把诊断保存到私有 OSS，并将报告 ID 放入 FC 原生异步队列。客户端收到回执后显示“已上报”，GitHub App 在云端创建 Issue；失败时可重试上报。用户无需授权或手动检查建单进度。

## 已部署资源

- 地域：杭州。FC：`zeus-fault-reports`，Node.js 20，512 MB，60 秒，单实例并发 1，函数实例配额 2，无常驻实例。
- 异步任务：最多重试 3 次，事件有效期 24 小时；维护者可在 FC 的任务页查看执行结果，重试耗尽时根据失败任务和报告 ID 排查处理。
- OSS：`imchenway-zeus-diagnostics`，私有、阻止公共访问；`reports/` 保存追加式诊断和回执，`limits/` 保存匿名限流计数。当前没有自动删除规则。
- RAM：`zeus-fault-report-writer` 只读写上述两个前缀，并只允许调用本函数。
- GitHub App：`zeus-fault-reports-imchenway`，App ID `5779014`，安装 ID `182446950`，仅安装到 `imchenway/zeus`，权限为 Issues 写入和 Metadata 读取。
- FC 环境变量：`GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`；私钥不得进入客户端、仓库或日志。OSS 使用运行角色的临时凭据。
- 域名强制 HTTPS，最低 TLS 1.2。免费证书 `cert-yay0c` 在 2027 年 2 月到期，须在到期前重新签发并更新 FC 绑定。

## 接口与数据

- `GET /health`：服务存活。
- `POST /reports`：最大 128 KiB；报告 ID 为 UUID。新报告每 IP 每小时最多 5 次，全局每天最多 500 次。重复提交使用相同 ID。
- `GET /reports/<ID>`：仅返回 `received` 或 `submitted` 和 Issue 链接，不返回诊断。
- 诊断包含错误原文与原因链、请求 trace ID、HTTP 状态、操作、环境和故障前后五分钟内最多 60 条关联宿主事件，事件保留白名单内的具体诊断内容。另采集与 trace ID 匹配的服务端请求记录、最多 50 条关联 Runtime 系统日志，以及上报时刻的会话、运行分段、轮次错误和进程状态。没有对话正文、工作区文件、命令正文、stdout、stderr、截图或附件。
- 公开 Issue 包含固定错误说明、操作类别、Zeus 调用位置、事件摘要、构建 SHA-256 和私有诊断入口。错误原文及日志详情只保存在私有包。
- Issue 创建结果未知时只查询原 Issue，避免重复建单；GitHub 搜索索引未更新时保留待确认状态。

## 构建与更新

在仓库根目录执行 `node infrastructure/fault-report/build.mjs`，将产物 `dist/index.mjs` 放到 ZIP 根目录，通过 FC 上传代码；入口为 `index.handler`。构建复用仓库锁定的 esbuild，不新增依赖。更新代码时保留运行角色、环境变量、HTTPS 路由、异步配置和实例配额。

回退时恢复上一个 FC 代码包；本机报告和 OSS 追加日志无需迁移。现有下载桶及 CDN 配置不依赖本服务。

## 从一条 Issue 读取现场

1. 打开 Issue 的“读取私有诊断包”链接，使用已有阿里云维护者登录。链接按完整对象键定位单个报告，不包含临时签名或公开下载凭据。
2. 点击对象“详情”中的“下载”，读取 JSONL 首行的 `packet`；后续行是上报状态变更。先核对 `packet.reportId` 与 Issue 报告 ID。
3. 查看 `stack` 中的错误原因链和 `context.traceId`，与 `events[].details` 中的日志内容关联。`diagnostics.snapshots` 保存白名单投影后的会话和进程状态，`diagnostics.logs` 保存系统诊断日志。
4. 先读 `diagnostics.notes`。宿主不可用、无关联会话、日志截断和读取失败都会明确记录；不能用缺失证据推定根因。快照是上报时刻的状态，不保证等同于故障发生瞬间。
5. `diagnostics.build.sha256` 是安装包 ASAR 的原始 SHA-256，可与候选客户端产物核对；开发服务器模式会明确提示指纹未覆盖 Renderer 源码。

维护者必须有该桶 `reports/*` 的只读权限；普通用户无需授权。匿名 `/reports/<ID>` 仍只返回回执，不提供诊断下载。旧报告无法补回当时没有采集的日志。
