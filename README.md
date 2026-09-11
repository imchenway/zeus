# Zeus

Zeus 是一款 AI 研发工作台，将项目与任务管理、Coding Agent 会话、代码理解、Git 变更审查和自动化协作整合在同一个工作空间中。

## 功能

- 管理项目、任务和 Coding Agent 会话。
- 在创建任务中粘贴 GitHub Issue、Jira 工作项或禅道详情链接，读取标题和正文后确认创建；受限内容通过 Zeus 登录，GitHub 与 Jira 附件保留为来源链接。
- 浏览和编辑项目源码，搜索文件与代码内容。
- 接入 Codex、Claude、Gemini 等 Coding Agent，并保存执行日志。
- 查看 Git 状态与 Diff，重要写操作保留确认步骤。
- 可选接入 Telegram，接收通知和执行受控命令。
- 内置微信开发版上传、二维码预览、手机自动预览和真机调试，在项目命令中运行；无需复制脚本或额外安装 Node.js。

微信命令需要安装并登录[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)、开启服务端口，并具有对应小程序的开发权限。默认使用当前项目；框架项目请填写构建后包含 `project.config.json` 的小程序目录，Zeus 不替项目猜测或执行构建。上传时填写版本号；预览二维码和返回信息保留在执行产物中。新安装自动提供四条全局命令，升级保留已有同名或同别名命令；用户修改、停用或删除后不会在下次启动被重置。

AI 访问网站和执行浏览器操作无需 Zeus 逐次确认，包括点击、按键、剪贴板与高级页面操作。网站自身的设备权限、登录输入与本机文件选择仍按各自流程处理。

会话权限菜单提供“只读”“自动”“替我批准”和“完全访问”，每项下方说明权限范围。“自动”允许工作区内修改，需审批的操作交给用户；“替我批准”保留工作区限制，由 Codex 自动审核审批请求，有风险时仍可能询问或拒绝，不等于完全访问。此选项仅支持具备自动审核能力的 Codex，其他引擎不可选择。

任务仍有关联的未归档会话时，代码合入后会保留工作目录，可继续对话；需要释放空间时可显式回收，或随任务完成、取消清理。恢复已交付任务时，失去 Git 登记的残留目录会先整体保留，再按任务分支重建；原目录的保留位置记在任务动态中，残留内容不会自动混入重建代码。

## 安装

当前 Homebrew 安装包支持 Apple Silicon Mac，要求 macOS 13 或更高版本。

```bash
brew install --cask imchenway/tap/zeus
```

安装完成后，可从“应用程序”打开 Zeus。升级使用：

```bash
brew upgrade --cask imchenway/tap/zeus
```

彻底卸载 Zeus（包括 Homebrew Cask 已登记的本地配置）使用：

```bash
brew uninstall --cask --zap imchenway/tap/zeus
```

如需保留本地项目、会话和配置，请去掉 `--zap`，使用 `brew uninstall --cask imchenway/tap/zeus`。

也可以前往 [GitHub Releases](https://github.com/imchenway/zeus/releases) 下载安装包。

应用内更新会识别当前安装方式：Homebrew 管理的应用沿用 Homebrew 更新；手动从 DMG 安装的应用，在正式签名、公证、版本兼容和安装位置条件满足时，可下载后确认重启安装。自动安装条件不足时，仍可在更新弹窗点击“下载更新”，完成校验后点击“打开安装包”；结束工作并退出 Zeus，再将新版拖入“应用程序”完成替换。只有缺少匹配当前 Mac 的安装包时才引导前往发布页。临时签名的旧版需先手动安装一次正式签名版本，才能使用后续的直接自动安装。

正式发布使用已有的 `REQUIRE_APPLE_DISTRIBUTION=true` 检查证书和公证配置；没有凭据时保留手动升级入口。开发验证无需配置正式证书。

## 首次打开

当前公开版本尚未经过 Apple 公证。首次打开时，如果 macOS 提示无法验证 Zeus：

1. 关闭提示窗口。
2. 打开“系统设置”。
3. 进入“隐私与安全性”。
4. 在安全性区域找到 Zeus，点击“仍要打开”。
5. 根据系统提示再次确认打开。

即：**系统设置 → 隐私与安全性 → 仍要打开**。

如果没有看到“仍要打开”，请先再次尝试启动 Zeus，然后返回该页面。此操作只会为当前 Mac 添加一次例外，具体说明见
[Apple 官方帮助](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)。

未配置 Apple Developer 凭据时，公开包仍采用 ad-hoc 签名且不做公证；发布清单会如实标记该状态。生产 ad-hoc 包包含稳定的代码
requirement，用于减少升级后因代码身份变化而重复询问“文稿”“下载”等隐私权限。用户主动选择项目、附件或导出位置时，macOS 仍可能
按真实目录访问边界请求授权。配置 Developer ID 与公证凭据后，仍可显式启用严格 Apple 分发。

版本更新内容见 [GitHub Releases](https://github.com/imchenway/zeus/releases)。

网络代理位于“设置 → 通用”，可选择不使用代理、跟随系统与启动环境或手动配置。手动模式分别填写 HTTP/HTTPS 协议、主机名、端口号（1–65535）及绕过列表；已有代理地址会自动拆分回填。保存后等待任务结束，完全退出并重新打开 Zeus 生效；仅关闭窗口或保留后台任务不会切换代理。“检查连接”用当前表单分别检查内置浏览器和模型宿主网络，不切换运行中代理；收到网站响应不表示模型认证成功。默认模式保留系统与启动环境；手动模式不支持 SOCKS 或账号密码，本机回环请求始终直连。

在 Zeus 内使用 Codex 订阅登录后，会等待本次模型目录同步完成；同步失败会单独提示原因。日常运行每五分钟检查模型目录，账号变化会提前检查。在所使用的 Codex 运行组件仍与官方服务兼容时，账号已开放的新模型会随目录更新进入可选列表，无需反复登录。Zeus 当前仍通过本机 Codex 运行组件调用模型；目录自动更新不代表任意旧版 CLI 都支持未来的新模型。自动更新保留现有模型选择，实际可用范围以官方对该账号开放的目录为准。

## 开发与验证

使用 Node.js 24–25 和 pnpm 10，首次运行 `pnpm install --frozen-lockfile`。

- `pnpm dev`：首次构建运行依赖后启动 Electron + Vite；React/CSS 修改热更新，不生成安装包。主进程、preload 和共享后端包修改后需重启命令。退出开发窗口或按 Ctrl+C 会关闭本次开发服务，不影响已安装应用。
- 开发配置读取根目录 `.env`、`.env.development`，系统环境变量优先；`ZEUS_DEV_MODE=test pnpm dev` 读取 `.env`、`.env.test`。数据默认隔离到 `.tmp/electron-development-data` 或 `.tmp/electron-test-data`，可通过 `ZEUS_USER_DATA_DIR` 指定兼容的开发数据目录。不要指向正式数据目录。修改环境文件后重启开发命令；只有 `VITE_` 前缀变量可供前端读取，勿放入密钥。
- `pnpm build`、`pnpm verify:publish` 和所有打包、签名、发布入口保持原有行为，不启动开发服务、不读取上述开发入口配置。
- `pnpm verify:publish`：本地与 CI 共用的检查入口，执行冲突、格式、Lint、架构边界、类型和构建检查，不发布。
- `pnpm package:mac`：默认只生成独立身份 `Zeus Test.app`，输出到 `dist/test/mac-arm64/`（Intel 为 `dist/test/mac/`）；运行验收使用独立用户数据目录。
- `pnpm package:mac:release`：生成正式 DMG；仅在明确需要安装包或发布时执行。
- `pnpm package:clean`：预览 `dist`、`dist/test` 中的旧安装包；加 `--apply` 执行清理。沿用 `ZEUS_PACKAGE_OUTPUT_DIR` 可指定单个输出目录。
- `pnpm verify:release`：正式发布候选的检查、打包和产物校验；不自动安装或发布。

打包与产物校验成功后，自动清理当前输出目录中同一身份、架构的旧安装包；每种身份、架构保留最新实际版本的 DMG、ZIP 及配套文件。
清理只处理符合 Zeus 命名规则的普通文件，保留 App、其他文件和目录。优点是避免历次安装包无限累积；需要长期留存旧包时，请先移出构建输出目录。

日常改动按影响范围执行检查；行为变化补充真实运行证据。既有专项探针按需使用，不默认全量运行。
测试包必须来自当前任务的正常构建，不能用改名、重签的系统程序或篡改版本的应用样本替代。
启动本任务的测试包后，可执行 `node scripts/verify-packaged-app-health.mjs "<Zeus Test.app绝对路径>" --runtime-root "<本次ZEUS_USER_DATA_DIR>" --runtime-pid <本次主界面进程号>`，检查真实应用进程、宿主身份及持续推进的连接心跳。
该命令只读取已运行的测试实例，不启动或重试；未传运行参数时只检查包结构。更新验收应分别核对新版启动及失败回退后的真实连接，不能将模拟响应视为成功。存在外接屏时，使用 `ZEUS_TEST_DISPLAY_ID` 将测试窗口从首次创建起放在非主外接屏。
开启 Computer Use 后可控制另一个独立的 Zeus Test 实例，无需额外 QA 模式；当前宿主、控制服务和正式 Zeus 实例仍禁止控制，敏感操作仍需用户确认。多个 Test 同时运行时使用应用绝对路径指定目标。

Computer Use 的动作和观察可通过 `wait_for` 在同次调用中确认控件出现、消失或文本值变化，并返回可继续操作的新快照。条件未满足时只报告超时，不重放动作；确认范围仅为可访问的界面状态。默认返回紧凑控件或较小的差异，首次未缓存观察附带截图，后续确认按需使用 `include_screenshot`；需要全部控件属性时使用 `full_output`。优点是减少额外等待与模型往返；复杂界面可能需要补充完整观察，实际性能需以相同流程复测。
发布正文由发布准备流程写入 `releases/v<版本>.md`。任务记录与验收证据统一保留在本地 `docs/`，整个目录已加入 Git 忽略规则，不随源码提交。旧记录可从 Git 历史查阅，不维护新旧两套发布文档路径。
