# Zeus 故障上报

客户端点击上报后先保存本机脱敏副本，再 POST 到 `https://zeus-report.hyphatech.cn/reports`。FC 把诊断保存到私有 OSS，并将报告 ID 放入 FC 原生异步队列。客户端收到回执后显示“已上报”，GitHub App 在云端创建 Issue；失败时可重试上报。用户无需授权或手动检查建单进度。

## 卡死与崩溃现场

- Main 启动独立 Node 守护进程，原生恢复窗口复用现有 macOS / Windows 窗口助手；故障 Renderer 和 Main 均不负责绘制恢复窗口。
- Main 与窗口每 2 秒探测一次。连续无响应阈值 15 秒，窗口首次就绪阈值 30 秒。Core 使用独立的 3 秒健康请求，连续失败 15 秒后保存故障。休眠唤醒重新计时；正常退出暂停窗口监控。
- 检测时冻结当前工作面、请求 trace、最后健康时刻、进程 CPU / 内存、配置白名单和最近 60 条操作。操作记录不包含正文、按键内容、接口参数、认证头或文件内容。
- 原生取证阶段最多等待 6 秒：macOS 保存两秒线程采样，Windows 使用系统 DbgHelp 保存线程栈转储；同时收集近期 Crashpad 转储及经投影的 Node 致命诊断。缺失、截断或超过预算都会记入 `diagnostics.notes`。
- Core 状态、关联日志和构建 SHA-256 的整个采集阶段最多等待 5 秒。报告完整写入临时文件后原子发布，未保存成功时不显示“已保存”。失败窗口允许重试保存或仅重启。
- “上报故障并重启”先提交已保存现场，网络阶段共用 15 秒期限。主包与所有清单附件均确认接收才记成功；失败留下待补报标记并继续重启。用户也能在上传中选择立即重启。
- 重启只结束本轮 Main 和已核验的同数据根、同世代 Core。旧进程退出后才启动同一可执行文件与原参数；不重新发送会话消息或业务操作。身份无法确认时停止恢复并显示错误。
- 正常退出与升级会等待守护完成落盘并关闭原生窗口，不能只关闭管道就替换仍被读取的程序文件。关闭故障提示后，同一持续故障不会反复弹窗；健康恢复后才重新监控下一次故障。
- 恢复后可补报原现场，补报不再重启应用。原始 `<ID>.json` 与附件保持不变；首次提交的 `<ID>.submission.json` 固定用户补充文字和实际提交内容，后续重试复用同一报告身份。
- 用户可以直接上报，也可以填写最多 4000 字符的复现步骤或脱敏最小示例；这是主动提供的文字，不自动读取故障窗口草稿。
- 转储和原生采样可能包含路径、线程内存及业务数据。它们先保存在本机，只有用户在独立窗口选择上报后才进入私有 OSS；不能将这些附件宣称为“不含业务数据”。
- 守护也被结束或整机掉电时，下次启动只补回最后持久记录；不能把它写成故障瞬间的完整现场。此链路不保证每次故障都可稳定复现。

以上是本轮源码实现。云端附件接口必须先升级；客户端在上传新现场前检查 `/health` 能力，防止旧服务静默丢弃新增字段。2026-11-17 本轮读取现网仅返回 `{"status":"ok"}`，尚未部署这次服务端改动。

## 已部署资源

- 地域：杭州。FC：`zeus-fault-reports`，Node.js 20，512 MB，60 秒，单实例并发 1，函数实例配额 2，无常驻实例。
- 异步任务：最多重试 3 次，事件有效期 24 小时；维护者可在 FC 的任务页查看执行结果，重试耗尽时根据失败任务和报告 ID 排查处理。
- OSS：`imchenway-zeus-diagnostics`，私有、阻止公共访问；`reports/` 保存追加式诊断和回执，`limits/` 保存匿名限流计数。当前没有自动删除规则。
- RAM：`zeus-fault-report-writer` 只读写上述两个前缀，并只允许调用本函数。
- GitHub App：`zeus-fault-reports-imchenway`，App ID `5779014`，安装 ID `182446950`，仅安装到 `imchenway/zeus`，权限为 Issues 写入和 Metadata 读取。
- FC 环境变量：`GITHUB_APP_ID`、`GITHUB_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`；私钥不得进入客户端、仓库或日志。OSS 使用运行角色的临时凭据。
- 域名强制 HTTPS，最低 TLS 1.2。免费证书 `cert-yay0c` 在 2027 年 2 月到期，须在到期前重新签发并更新 FC 绑定。

## 接口与数据

- `GET /health`：服务存活及 `saved_scene`、`evidence_upload` 能力。
- `POST /reports`：最大 128 KiB；报告 ID 为 UUID。新报告每 IP 每小时最多 5 次，全局每天最多 500 次。重复提交使用相同 ID。
- `GET /reports/<ID>`：仅返回 `received` 或 `submitted` 和 Issue 链接，不返回诊断。
- `POST /reports/<ID>/evidence/<SHA256>`：只接收原报告清单中已声明的附件；正文是 `name`、`bytes`、`sha256`、`gzip`（base64 编码）。每个附件原始上限 16 MiB，gzip 上限 2 MiB，每份报告最多 8 个附件。接收端限制解压大小并核对原始字节 SHA-256，使用固定私有对象键保存 `.gz`，重试不能覆盖已有对象。
- 附件返回 `{reportId, sha256}` 才算确认；400 表示数据或摘要不匹配，404 表示未声明附件，413 表示超过大小限制，503 表示存储或服务异常。摘要接收和附件接收是不同事实，不能混写成功状态。
- 普通错误报告包含错误原文与原因链、请求 trace ID、HTTP 状态、操作、环境和故障前后五分钟内最多 60 条关联宿主事件。另采集同一 trace 的服务端请求、最多 50 条 Runtime 系统日志，以及上报时刻的会话、运行分段、轮次错误和进程状态。此基础采集不读取对话正文、工作区文件、命令正文、stdout、stderr 或截图；卡死和崩溃的原生附件按上文单独处理。
- 公开 Issue 包含固定错误说明、操作类别、Zeus 调用位置、事件摘要、构建 SHA-256 和私有诊断入口。错误原文及日志详情只保存在私有包。
- 新现场另包含 `diagnostics.scene` 和可选的 `diagnostics.reproduction`。原生附件不受主 JSON 的 128 KiB 上限限制，单独受上述附件预算限制；公开 Issue 只提供需要维护者权限的私有附件入口。
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
6. 原生附件位于 `reports/<ID>/evidence/<SHA256>.gz`，下载后解压并核对原始 SHA-256。清单存在不等于附件已上传；主包创建 Issue 可以早于附件接收。
7. 对卡死报告先比较 `diagnostics.scene.detectedAt`、各进程 `lastHeartbeatAt`、操作轨迹和线程采样；对崩溃报告读取 minidump / Node 诊断，并使用同版本、同系统和架构的 Electron 调试符号。转储缺失不能反推没有崩溃。
8. Renderer 构建生成隐藏 source map，主进程沿用现有 TypeScript source map。macOS／Windows 打包完成后，自动将运行脚本、原始 `.map`、包内已有的 `zeus-source.tar.gz` 和 `manifest.json` 保存到安装包旁的 `symbols/<ASAR-SHA256>-<构建后缀>/`。清单记录平台、架构、应用／Electron 版本、脚本与 map 哈希、ASAR 指纹及最终 DMG／EXE 指纹；只生成 `.app` 时安装器列表为空。脚本必须与 ASAR 内实际内容逐字节一致；缺少主进程／preload／工作区包的 map、Renderer 完全没有 map、map 无效或归档失败都会阻止打包成功。Vite／Rolldown 没有为部分生成助手提供 map，这类 Renderer 脚本仍保存原文和指纹，并以空映射字段及 `sourceMapNote` 明确记录，不能当作有源码映射。现有安装包仍排除 `.map`，归档不写入应用，不被旧安装包清理逻辑删除。
9. AI 或维护者按报告的 `diagnostics.build.sha256` 查找对应目录，先核对清单中的脚本与 map 哈希，再读取 source map；TypeScript map 不含原文时，从同目录源码包读取对应源文件。归档包含源码，本地保存在构建输出目录；CI 将 `dist/symbols/` 加入现有 macOS／Windows 构建附件，macOS 上传重试也保留该目录。附件沿用仓库保留期，期满后无法再从该附件取回，不能视为永久存储。公开 Release 仍只上传指定的安装器和发布清单，不上传定位目录。Electron 原生调试符号仍须按清单中的 Electron 版本、系统和架构另行取得，不能使用其他构建的文件还原位置。

维护者必须有该桶 `reports/*` 的只读权限；普通用户无需授权。匿名 `/reports/<ID>` 仍只返回回执，不提供诊断下载。旧报告无法补回当时没有采集的日志。
