# ZEUS-0395 Computer 与 Browser 原生能力

## 1. 目标、边界与冻结基线

本任务把 Computer Use 和 Browser 从“Zeus 导入并调用 Codex 私有插件运行时”迁移为 Zeus 自有能力。统一调用链为：

`Codex / Pi / DeepSeek → ZeusToolRegistry → ZeusToolBroker → ComputerHost / BrowserHost / ExternalBrowserHost → 目标 surface`

- Computer Use 冻结基线为 `1.0.1000901`，公开可观察操作共 11 个。
- Browser 冻结基线为 `26.825.32147`。Zeus 保留原有 17 个便捷工具，并增加 `catalog`、`invoke`、`release_handles` 三个高级入口。
- 实现只依据公开接口、系统公开 API 与可观察行为，不复制私有插件代码、资产、提示词或内部实现。
- 首期平台固定为 Apple Silicon macOS 13+。不包含 Intel、Windows、Linux、Edge 商店提交和后续插件版本兼容。
- 本任务不上传商店、不公开发布、不卸载插件、不安装生产应用，也不执行 Git commit、push、merge 或 revert。

## 2. Provider 无关工具层

### 2.1 注册、调用与审计

`packages/local-server/src/zeusToolRegistry.ts` 是唯一原生工具注册与 Broker 入口：

- Codex 动态工具和 Pi/DeepSeek 自定义工具由同一注册表生成，所有 Zeus Agent 获得相同 Schema。
- 每次调用必须携带 `conversationId`、Provider `threadId`、`turnId` 和 `callId`；缺失身份时以 `ZEUS_NATIVE_TOOL_IDENTITY_INVALID` 失败。
- Broker 统一处理 allowlist、冻结参数 Schema、surface 能力协商、120 秒默认超时、开始/完成/失败审计和结果类型记录。
- 读操作允许并发；会改变 UI、剪贴板或浏览器状态的操作按 Provider 工具执行语义串行化。
- Browser 高级调用只接受冻结目录中的方法路径；未注册路径返回 `ZEUS_BROWSER_METHOD_NOT_ALLOWLISTED`，参数不合约返回 `ZEUS_BROWSER_ARGUMENT_INVALID`。
- JavaScript、CDP 和其他开发者方法标为 `developer` 风险，必须通过独立高级审批；通用 `invoke` 不能绕过审批执行任意本地代码。

### 2.2 结果与生命周期

- 统一结果支持文本、图片和受控制品引用。
- 图片仅在当前 Provider 调用链传输。Computer 和 Browser 截图写入 Zeus 用户数据根中的受控制品目录，工具文本只记录引用，不长期写入大段 base64。
- Pi SDK 在当前工具回合接收真实图片；写入 Pi 持久 JSONL 前，只把图片块投影为“临时图片已释放、制品引用见文本”。
- Zeus 不依据模型声明预先隐藏或删减图片工具。Provider 不支持图片工具结果时，其真实错误必须完整返回，不能静默 OCR、丢图或声称模型已看见截图。
- Browser 句柄绑定 conversation、turn、call、surface、tab 和 `documentGeneration`。导航、标签关闭重建、跨轮次复用或身份不匹配都 fail-closed，并要求重新列出、claim 或获取快照。
- `release_handles` 可显式释放当前调用链中的远程句柄；过期句柄不会自动重定向到相似标签。

## 3. Zeus Computer Use

### 3.1 组件与系统 API

- Electron Main 的 `ComputerHost` 负责总开关、审批、按需启动、请求身份、制品、停止和 Helper 重连。
- `Zeus Computer Service.app` 是 Swift 辅助服务。正式 bundle ID 为 `dev.hypha.zeus.helper.computer`，Test bundle ID 为 `dev.hypha.zeus.test.helper.computer`。
- AX 树与语义操作使用 `AXUIElement`；窗口截图优先使用 ScreenCaptureKit，macOS 13 使用公开窗口截图兼容路径；键盘、滚动和拖拽使用投递到目标 PID 的 `CGEvent`。
- 坐标操作维护 Helper 会话内的虚拟指针，只向目标进程投递事件，不调用全局事件发布，也不移动用户物理鼠标。无法安全投递时返回能力错误。
- Helper 只枚举已运行的常规应用，不扫描、打开或后台启动目标应用；空闲后退出，崩溃后由下一次请求重新建立。

### 3.2 11 个操作

| 操作 | 语义 |
| --- | --- |
| `list_apps` | 只列出当前已运行常规应用及是否可控 |
| `get_app_state` | 返回有界 AX 树、完整或增量状态、截图、窗口和快照代次 |
| `click` | 优先 AXPress，必要时使用目标进程内坐标事件，支持鼠标键和点击次数 |
| `drag` | 沿受限路径向目标 PID 投递拖拽事件 |
| `paste` | 临时写入文本、Markdown 或 HTML，完成后恢复用户全部剪贴板格式 |
| `perform_secondary_action` | 只执行最新 AX 树实际暴露的指定二级动作 |
| `press_key` | 向目标应用发送受控按键或组合键 |
| `scroll` | 对语义元素或目标进程内坐标滚动 |
| `select_text` | 按正文、前后缀和选择类型消歧后设置文本范围 |
| `set_value` | 通过 AX 设置普通控件值，安全字段拒绝 |
| `type_text` | 向目标应用输入 Unicode 文本，安全字段拒绝 |

`element_index` 只在对应 `snapshot_generation` 内有效。代次过期返回 `ZEUS_COMPUTER_ELEMENT_STALE`；目标退出、锁屏、TCC 拒绝和 Helper 不可用分别返回明确的原生能力错误。

### 3.3 安全与审批

- 用户在设置中全局启用 Computer Use 后，普通非敏感操作不再逐应用、逐会话确认；Accessibility 和 Screen Recording 仍由 macOS TCC 管理。
- 删除、支付、转账、发送消息、提交表单、账户或安全设置变更等操作仍逐次经过 Zeus 原生审批。
- 密码、Passcode、OTP、验证码、CVV/CVC、密钥、Secret 和 Token 等安全字段由 AX role/subrole、名称与描述联合识别；普通输入工具拒绝写入，凭据不得进入模型参数、日志和历史。
- 当前 Zeus 进程、审批窗口和同一实例不可控。只有另一独立身份、独立用户数据根的 `Zeus Test.app` 才可在显式 `ZEUS_COMPUTER_QA_MODE=1` 下作为 QA 目标。
- 设置页和会话工具区均提供“立即停止控制”；停止会终止 Helper、关闭待处理请求并使旧快照失效。

## 4. Zeus Browser 冻结契约

### 4.1 契约生成与 allowlist

- `packages/local-server/src/browserFrozenPublicSchemas.ts` 由公开 `api.json` 机械生成，只含方法参数结构和 surface 不支持元数据。
- 冻结输入 SHA-256：`4bfeb97e958025db37d52aea11b75bc70bca417b4995b0f711c0f07f3ddccb08`。
- 目录共 187 个可调用/可读取路径，其中 145 个来自冻结公开接口，42 个为同一冻结能力族的 capability、管理、对话框、Browser Auth、WebMCP、Page Assets、CDP 与文档入口。
- `Documentation.get` 在内置浏览器、Chrome 和 Edge 上均返回同一方法说明、参数 Schema 与 `unsupportedOn` 元数据。
- 只有冻结元数据声明等价 surface 不支持时才返回 `ZEUS_BROWSER_UNSUPPORTED_SURFACE`；实现缺失必须返回实现错误，不伪装成平台限制。

### 4.2 内置 Browser

`BrowserHost` 作为统一 `BrowserAutomationPort` 的内置适配器，覆盖：

- Browser、Profile、窗口、标签、标签组、书签、历史、审计和会话命名；
- 标签声明、导航、截图、可见性、视口、真实 JavaScript 对话框、人工接管与交付物；
- AX、DOM CUA、坐标 CUA、Playwright、Frame、Locator；
- 正文/HTML/链接/资源提取、页面资源制品、PDF/办公文档导出和 YouTube transcript；
- 文件选择、上传、下载、剪贴板；
- Browser Auth、Bot Detection、WebMCP、开发日志和 CDP。

新建、前进、后退、刷新和 `goto` 都等待真实 `loading=false` 或调用方指定目标内容就绪。标签创建本身不作为“可操作”证据。导航增加 `documentGeneration` 并失效旧 AX、DOM、Locator、对话框、文件选择器与标签 claim。

Playwright Locator 支持组合、`has`/`hasNot` 嵌套 Locator、文本或正则描述符过滤、Frame、文件选择、下载和受审批的 evaluate。CUA 透传鼠标键、点击次数和修饰键。

### 4.3 Chrome 与 Edge

- `apps/desktop/browser-extension` 是一套 Manifest V3 TypeScript 子集源码，构建 Chrome 正式、Chrome Test 和 Edge Preview 三个包。
- `chrome.tabs` 只发现顶层标签最小元数据；操作前必须用最新结果精确 claim，并同时校验 browser ID、tab ID、标题、URL 和文档代次。
- content script 提供 DOM/页面桥；DevTools、截图、视口、对话框和文件选择器使用需要单独审批及可选权限的 `chrome.debugger`。
- 用户拒绝站点、书签、历史、下载、剪贴板或 debugger 权限时返回精确缺权错误，不切换到其他浏览器。
- Browser Auth 先校验 origin、字段和选项，凭据只在 Zeus 安全输入窗口进入内存，并作为一次性填充指令传给扩展；值不进入 Provider、审计或调试日志。

外部浏览器通过官方 Native Messaging 启动 Zeus 自有 host：

- 正式 host：`dev.hypha.zeus.browser_host`
- Test/Edge Preview host：`dev.hypha.zeus.test.browser_host`

Native Host 只读取权限严格为 `0600`、当前 uid 所有、非符号链接的短期 rendezvous；校验 Zeus PID 存活、surface、随机连接 ID、base64url 临时令牌和精确 `127.0.0.1` 临时端口。Zeus 重启会旋转令牌并移除旧 rendezvous。重复实例或陈旧扩展连接返回冲突，不接管相似标签。

生产 Chrome 包没有静态 `key`。由于本任务不上传 Chrome Web Store，生产扩展 ID 尚不存在，正式 Native Messaging manifest 会以 `store_id_pending` 拒绝安装，绝不写通配 `allowed_origins`。取得真实 ID 后必须通过签名发布配置精确绑定并另做公开上线验收。

## 5. 迁移与退场

- Codex 配置导入器不再导入 `browser`、`chrome`、`computer-use` 插件缓存，也不再重写相关 trusted service 和 service path。
- 新旧运行时迁移期间，写操作只走 Zeus 原生链路一次；不得向两个运行时同时点击、输入或提交。
- 设置页提供显式“归档旧运行时”和“恢复最近归档”。归档只移动以下 allowlist 目录并写入 `0600` manifest：
  - `computer-use/Codex Computer Use.app`
  - `plugins/cache/openai-bundled/browser`
  - `plugins/cache/openai-bundled/chrome`
  - `plugins/cache/openai-bundled/computer-use`
- 不自动清理，不卸载插件，不跟随符号链接。恢复时若原路径已有内容或备份不完整则 fail-closed，并回滚本次已移动条目。

## 6. 构建、签名与发布制品

- 日常构建和任务验收只允许生成 `Zeus Test.app`，主 bundle ID 为 `dev.hypha.zeus.test`。
- `Zeus Computer Service.app` 嵌套于 `Contents/Helpers`；Native Messaging Host 嵌套于应用资源并由安装 IPC 为当前 Test 数据根写精确 manifest。
- Chrome Web Store ZIP 同时附带权限理由、隐私说明、宣传图、图标源和审核清单；本任务不登录账号、不上传、不提交审核。
- Chrome Test 与 Edge Preview 使用不同固定开发 key，因而扩展身份不同；正式与 Test host manifest、rendezvous 和用户数据根不可共享。

## 7. 故障恢复

- Helper 崩溃或空闲退出：当前请求失败，下一次请求按需重启；旧元素代次不得复用。
- TCC 拒绝：设置页显示 macOS 授权状态，工具返回缺少 Accessibility 或 Screen Recording 的原生错误。
- 锁屏或目标退出：不尝试解锁、不重启目标应用，返回锁屏或应用未运行错误。
- 浏览器断连/重启：Native connection ID、标签 claim 和所有远程句柄失效，必须重新连接、列出、精确 claim。
- 多实例冲突：不覆盖活动连接，返回冲突；Test 与正式环境依靠 bundle、host、扩展 ID 和数据根隔离。
- 下载、上传、弹窗或认证等待超时：返回对应超时/陈旧错误，不把“事件监听已安装”当成成功。
- 立即停止：终止 Computer Helper 和外部浏览器 rendezvous，未完成调用失败；恢复必须由用户重新启用或重新连接。

## 8. 验证记录

### 8.1 已完成证据

- TypeScript project build：`pnpm exec tsc -b --force` 通过。
- `git diff --check`、`pnpm lint`、`pnpm build`、`pnpm package:mac` 均在最终源码状态通过；build 仅有既有第三方 PURE 注解和大 chunk 警告。
- Computer Helper 独立构建通过；直接协议探针确认 TCC 状态可读取、只列已运行应用、TextEdit AX 树/代次可返回、缺失应用不启动、自身控制拒绝、陈旧代次拒绝。
- 冻结目录探针确认总路径 187、公开 Schema 145，公开方法未从目录缺失。
- 最终 Test 包为 `dist/test/mac-arm64/Zeus Test.app`，DMG 为 `dist/test/Zeus-Test-0.3.75-arm64.dmg`。
- Test 包检查确认主 bundle ID `dev.hypha.zeus.test`、Helper bundle ID `dev.hypha.zeus.test.helper.computer`；`codesign --verify --deep --strict` 通过，主应用、Helper 和 Native Host 均满足 designated requirement。
- Native Host 位于 `Contents/Resources/app.asar.unpacked/dist/native/ZeusBrowserNativeHost`，为 arm64 Mach-O；运行时副本权限收紧为 `0700`，rendezvous 和 manifest 原子写入并收紧为 `0600`。
- 任务包为 ad-hoc Test 签名。当前 electron-builder 对嵌套 Swift Helper 继承了 Electron 的 JIT、unsigned executable memory 和 disable library validation entitlements；该结果已记录，正式签名发布前仍应拆分为 Helper 最小 entitlements 并重新执行签名验收。
- 三个扩展 ZIP 完整性通过，最终 SHA-256 分别为：Chrome Test `88a399426595773abd4e2b03f4eca8a33f730879481c97022191691f9f861b69`、Chrome Web Store `9acbdafeb40e8c007778576323c794a38e0e74718024d04497250d17c81a2d35`、Edge Preview `6eeffed8ab071cda0210dafda1d31f1f314d59a0814d8cb3e7f576fad5e31ee0`。
- Chrome 正式 manifest 无静态 key；Chrome Test 与 Edge Preview key 不同，计算所得 ID 分别精确匹配 `fdmpmokokhlhmcejkdblbhllckhdfiop` 与 `pcnleiehflciojdelkchdjjfefkjphef`。三者必需权限相同，可选权限为书签、历史、下载、剪贴板和 debugger，站点访问保持可选。
- ASAR 清单确认包含三套扩展目录、三个 ZIP、商店材料、Native Host、ComputerHost、ExternalBrowserHost 和冻结契约实现。
- 独立数据根启动曾确认主窗口首次创建在外接显示器 ID 3，`/health` 返回 200；未把静态或 HTTP 健康检查计作 GUI 功能验收。

### 8.2 尚未闭环的真实运行项

当前机器同时运行另一任务的相同 `dev.hypha.zeus.test` 身份。macOS AX 按 bundle ID 定位时命中了另一任务的 Test 实例，因此该截图与交互证据无效，已停止本任务自身实例且没有关闭、复用或操作其他任务实例。

因此以下验收不能声明通过：

- Computer 全部 11 操作的真实写操作、多窗口、多显示器缩放、锁屏、TCC 拒绝、Helper 崩溃重连和停止控制矩阵；
- 内置 Browser 冻结契约全部成功/错误路径的真实 GUI 逐组执行；
- Chrome Test 扩展与 Edge Preview 的真实安装、连接、权限拒绝、重启、断连、上传、下载、弹窗、认证和敏感提交；
- 真实 Codex、Pi/DeepSeek Provider 回合中的同一工具定义和不支持图片结果错误呈现；
- “不运行 Codex Computer Use/Browser 插件服务时四个 surface 仍独立工作”的最终公开运行证明。

这些是现场验收缺口，不等同于代码或构建失败。释放唯一 Test 身份验收窗口并提供对应 Provider 登录态后，必须使用新的独立 `ZEUS_USER_DATA_DIR` 重做上述矩阵；不得借用现有正式数据或其他任务实例。
