# ZEUS-0264 模型供应商需要支持 IP 接入

## 当前状态

已完成需求澄清、代码实现、静态门禁、服务层实测、独立打包和隔离 GUI 验收。

## 原始需求

模型供应商需要支持通过 IP 地址接入。现有界面会拒绝非本机 HTTP 地址，并提示“远程模型服务必须使用 HTTPS；HTTP 只允许本机地址”。

## 已核对事实

- 当前 `https://<IP>` 已经可以保存，真实阻断点是模型连接地址校验拒绝 `http://<非回环地址>`。
- 地址校验集中在 `packages/ai-runtime/src/modelConnectionCatalog.ts`，创建和更新连接都会经过该校验。
- 模型目录刷新、连接诊断和 Pi 运行时都复用已保存的连接地址，不存在第二套供应商地址白名单。
- API Key 只保存到 macOS 钥匙串，但使用 HTTP 调用模型服务时，网络传输中的凭据、请求正文和模型回复仍是明文。

## 已确认范围

“IP 接入”在本任务中统一定义为“允许明文 HTTP 模型端点”，范围不只限 IP：

- IPv4、IPv6 和域名都允许使用 `http://`。
- 所有合法主机继续允许使用 `https://`。
- 其他协议继续拒绝。
- 地址中账号、密码、查询参数和片段继续拒绝。
- 新建 HTTP 连接，或把现有连接改到新的 HTTP 地址时，保存前必须明确提示 API Key、请求和回复可能被窃听或篡改。
- 用户确认后才允许保存；同一已保存 HTTP 地址的普通编辑和后续调用不反复确认。
- 服务端必须校验本次请求携带了明确确认，不能只依赖 Renderer 弹窗。

## 方案取舍

优点：可以接入局域网、自建网关、公网 IP 以及只提供 HTTP 的兼容服务，不再要求用户额外部署证书或反向代理。

缺点：公网或不可信网络中的明文 HTTP 无法保护 API Key、对话内容和模型回复，Zeus 只能明确告知风险，不能补偿传输安全。允许域名 HTTP 的范围也明显大于原始“IP 接入”表述，因此代码和文案必须使用“明文 HTTP 模型端点”这一准确术语。

## 实现计划

1. 地址校验允许 `http:` 和 `https:`，继续保留 URL 结构限制。
2. 模型连接保存请求增加一次性的不安全传输确认字段。
3. 服务端在新建 HTTP 连接或 HTTP 地址发生变化时强制校验该确认字段。
4. 设置页使用统一模态原语展示中英文风险说明，确认后重放同一份保存输入。
5. 执行格式检查、`pnpm lint`、`pnpm typecheck` 和 `pnpm build`，记录真实结果。

## 实现结果

### 地址协议

模型连接地址现在接受 `http:` 和 `https:`，继续拒绝其他协议、账号密码、查询参数和片段。该规则仍集中在模型连接归一化层，创建、更新、持久配置恢复、模型目录和 Pi 运行时使用同一份连接事实。

### 服务端确认门禁

模型连接保存请求增加一次性的 `allowInsecureHttp` 确认字段。服务端会先完成地址归一化，再判断是否为新建 HTTP 连接或改到新的 HTTP 地址；缺少确认时返回 `ZEUS_MODEL_CONNECTION_INSECURE_HTTP_CONFIRMATION_REQUIRED`，且不会保存连接或 API Key。

同一已保存 HTTP 地址的普通编辑、模型目录刷新和内部持久化不重复要求确认。创建与更新审计会记录实际传输协议及本次是否确认明文 HTTP，但不记录 API Key。

### 设置页交互

设置页在保存新的 HTTP 地址前使用统一 `ModalPortal` 展示“确认使用明文 HTTP”：

- 明确说明 API Key、请求内容和模型回复可能被读取或篡改。
- “取消”关闭弹窗并保留连接名称、服务地址和其他草稿。
- “仍然保存”使用危险操作语义，并只为本次保存携带确认字段。
- 已保存地址不变时直接保存；改到另一个 HTTP IP 或域名时重新确认。
- 弹窗覆盖焦点限制、关闭后焦点恢复、键盘操作、窄窗口和减少动态效果。

## 验证记录

### 静态与构建

- `pnpm install --frozen-lockfile --offline`：通过，只使用本机缓存恢复依赖，锁文件未变化。
- 改动代码文件 Prettier 格式化：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过，15 个工作区项目和桌面 Renderer、Main、preload 完成构建；只有既有的大分块提示。
- `pnpm package:mac`：通过，生成 `dist/test/mac-arm64/Zeus Test.app`、测试 DMG 和 blockmap。
- 测试包身份：`CFBundleDisplayName=Zeus Test`，`CFBundleIdentifier=dev.hypha.zeus.test`；严格签名校验通过，`dist` 中没有生成生产身份 `Zeus.app`。

### 服务层实测

使用构建后的真实模块执行无外部网络的保存链路检查：

- `http://192.168.1.8:8000/v1`、`http://model.example.test/v1` 和 `https://203.0.113.10/v1` 均正确归一化。
- 新建 HTTP 连接未确认时返回 `ZEUS_MODEL_CONNECTION_INSECURE_HTTP_CONFIRMATION_REQUIRED`。
- 确认后成功保存 `http://203.0.113.10:8080/v1`。
- 同一地址更新不重复阻断；改到另一个 HTTP 域名且未确认时再次返回专用拒绝码。
- `ftp://` 继续返回“服务地址只支持 HTTP 或 HTTPS”。

### 隔离 GUI

- 当前机器存在主屏 ID 3、内建屏 ID 1 和非主外接屏 ID 5。使用全新独立 `ZEUS_USER_DATA_DIR` 预置外接屏恢复状态，主进程首次显示日志为 `matchKind=exact-id`、`targetDisplayId=5`、`actualDisplayId=5`、`corrected=false`，窗口没有先落到主屏。
- Computer Use 读取的窗口标题为 `Zeus Test`，Renderer URL 来自本任务测试包内 `app.asar/dist/renderer/index.html`。
- 在隔离设置中填写 `http://203.0.113.10:8080/v1`，点击保存后真实出现“确认使用明文 HTTP”弹窗；默认焦点位于“取消”。
- 点击“取消”后连接名称和 HTTP 地址完整保留；再次打开并点击“仍然保存”后，连接列表出现该连接并显示“连接配置已保存”。
- 对同一地址再次保存未重复弹窗；把地址改为 `http://model.example.test/v1` 后再次出现风险确认。
- 验收未填写真实 API Key、未执行模型目录获取、诊断或外部模型请求。
- 本任务测试实例已正常退出；隔离数据已移到 `/Users/david/.Trash/zeus-0264-gui-20260813-1650`，可恢复。
