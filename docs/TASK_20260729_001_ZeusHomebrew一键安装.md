# TASK_20260729_001 Zeus Homebrew 一键安装

## 任务目标

在 Zeus 尚未满足 Homebrew 官方仓库收录条件时，先通过项目自有 Tap 提供官方推荐形式的一条命令安装：

```bash
brew install --cask imchenway/tap/zeus
```

远期在 `homebrew/cask` 正式收录后，目标命令缩短为：

```bash
brew install --cask zeus
```

## 已确认决策

- Zeus 是预构建 macOS 图形应用，使用 Homebrew Cask，不改造成从源码构建的 Formula。
- 当前 Tap 采用 `imchenway/homebrew-tap`，用户侧使用 Homebrew 的 `imchenway/tap` 简写。
- 用户命令保留 `--cask`，优点是类型明确且符合官方文档；缺点是比自动推断形式稍长。
- 用户于 2026-07-29 明确把发布口径调整为“能运行、能发布即可”：允许公开发布如实标注的 ad-hoc 产物，Developer ID
  签名和 Apple 公证不再是当前阻塞项。
- 当前只发布真实构建所在架构；Cask 必须显式声明架构限制，不伪造另一架构可用。

## 实施前证据

- 当前公开仓库是 `imchenway/zeus`，但尚无正式 GitHub Release。
- 已按发布授权创建公开仓库 `imchenway/homebrew-tap`，默认分支为 `main`；当前只有初始化 README，尚未写入指向未发布
  Release 的 Cask。
- 本机没有 Developer ID 签名身份，也没有 Apple 公证与 Tap token 环境变量。
- 仓库已有 DMG/ZIP、Cask 生成器、SHA256SUMS、安装脚本和 Release workflow，但原 workflow 只创建草稿
  Release，且没有把生成的 Cask 同步到远端 Tap。
- 原 Cask 固定下载 Apple Silicon 产物，却没有声明架构限制；同时声明了源码中不存在的 LaunchAgent 清理。

## 本轮实现

- Cask 生成器根据真实产物输出 `:arm64` 或 `:x86_64` 限制，并只保留真实 bundle quit 与用户数据 zap。
- Cask 显式声明 macOS 平台；在临时 Tap 中通过 Homebrew 当前 style 规则。
- 更新清单把源码仓库与 Homebrew Tap 分开建模，安装与升级命令指向 `imchenway/tap/zeus`。
- macOS 打包在生成 DMG/ZIP 前完成签名：本地无证书时使用 ad-hoc，CI 有证书时使用 Developer ID；公证凭据完整时启用 notarization。
- Codex runtime 增加不受 Mach-O 重签名影响的代码内容摘要；electron-builder 重签嵌套 runtime 后，包内完整性门禁仍能验证真实代码内容。
- 公开发布默认允许真实验证过的 ad-hoc 产物；只有显式启用 `require_apple_distribution` 时，才要求最终 App 同时通过
  Developer ID 与 Apple 公证检查。
- 打包脚本会移除 GitHub Actions 注入的空 Apple secret，避免 electron-builder 把空 `CSC_LINK` 误判成证书路径。
- Release workflow 增加显式 `publish_release` 开关、tag/版本一致性检查、同版本 DMG 不可变检查和 Tap 自动同步。
- Release workflow 在干净 runner 上先构建固定版本 Codex runtime；本地没有 Electron 缓存时允许 electron-builder 下载固定版本，
  不再依赖开发机 `.tmp/`。
- 设计书前文变更造成第 25 章行号平移后，验收矩阵按相同条目文本机械同步行号并重新通过校验，未改写原有验收状态。
- README、发布文档与开发设计同步当前命令、真实等待项及安全边界。

## 优缺点

### 自有 Tap

- 优点：不受 Homebrew 官方影响力门槛限制；新用户只需一条命令；发布节奏由 Zeus 控制。
- 缺点：需要维护独立 Tap、跨仓 token 和每次 Release 的版本/SHA256 同步。

### 当前实用发布

- 优点：不依赖 Apple Developer Program 即可形成真实 Release、Tap 和 Homebrew 一键安装；发布链路已经完成运行验证。
- 缺点：当前仍是 ad-hoc 签名且未公证，其他 Mac 首次启动可能需要在 Finder 中右键“打开”，不能启用静默自动更新。

### 后续严格 Apple 分发

- 优点：首次启动不需要额外 Gatekeeper 确认，可为后续自动更新提供更完整的可信分发基础。
- 缺点：需要付费 Apple Developer 账号、证书和持续维护公证凭据；当前不作为发布阻塞项。

## 当前发布状态

1. 全量发布提交为 `8d139bb51b3c607b507435003c35573aa4f51168`，已推送到 `main`。
2. tag `v0.1.0` 已推送，GitHub Release 已公开：
   `https://github.com/imchenway/zeus/releases/tag/v0.1.0`。
3. `imchenway/homebrew-tap` 已写入 `Casks/zeus.rb`，对应提交为
   `67437061e7434d8c68410b11a9afb7e0aba69c59`。
4. Developer ID 与 Apple 公证凭据仍未配置，只影响首次启动体验和严格 Apple 分发。
5. `HOMEBREW_TAP_TOKEN` 仍可用于后续 Actions 自动同步；当前版本已在用户明确授权下通过 GitHub API 完成同步。

## 发布快照确认

- 用户于 2026-07-29 明确选择“当前工作区全量发布”，不再把本轮限制为仅发布 Homebrew 相关改动。
- 发布快照包含当前工作区内全部产品代码、配置、发布工程、设计与任务文档。
- `.idea/` 属于本机 JetBrains IDE 状态，不属于产品源码或发布制品；为避免泄露个人工作区状态并保持克隆结果可复现，
  已加入仓库忽略规则，不纳入发布快照。
- 全量快照发布前已检查常见私钥、GitHub/OpenAI/AWS/Slack token 模式、合并冲突标记和异常大文件；未发现发布阻断。
- 全量发布的优点是源码 tag、CI 构建和当前已验证功能保持同一范围；缺点是本次版本包含多个并行功能切片，变更面明显大于
  单独发布 Homebrew 工程，因此必须重新执行完整发布门禁，不能复用旧构建结果直接宣称发布成功。

## 验收边界

- 本轮已验证源码、静态检查、构建、App/DMG/ZIP、Cask、ad-hoc 签名、公开 Release、远端 Tap 和本机真实 Homebrew 安装。
- 本轮没有在另一台全新 Mac 上验收 Gatekeeper 首次启动交互；只确认当前机器从公开 Release 下载后，普通 `open` 可启动。
- 不执行或恢复任何单元测试、组件测试、DOM/CSS 契约测试及 TDD 流程。

## 验证记录

### 已通过

- `pnpm lint`：退出码 0。
- `pnpm typecheck`：退出码 0。
- `pnpm build`：退出码 0；Renderer、Main、Preload 与各 workspace package 均完成构建，保留既有大 chunk warning。
- `pnpm package:mac`：退出码 0；生成新的 App、DMG 和 ZIP，并在归档生成前完成 ad-hoc hardened runtime 签名。
- `pnpm verify:release`：退出码 0；acceptance matrix、lint、typecheck、build、AI CLI 探针、打包与产物门禁完整执行。
- 变更文件级 Prettier 检查：通过。
- `node --check`、`bash -n`、`ruby -c`、`plutil -lint`：Cask/manifest/打包脚本、Release shell 与 entitlements
  语法通过。
- Cask 生成器基于全量发布快照重新构建的 DMG 得到真实 SHA256
  `5ba434a0c71b4e8140eb065df6b16e839cf5f17b97c0a4adcbd7d6f07f3a52a9`；更新清单得到
  `brew install --cask imchenway/tap/zeus`。
- 发布门禁中 acceptance matrix 之后的产物生成、Electron 加载、Renderer/Main/Preload、Codex runtime 完整性检查：通过。
- 本轮 DMG 的 `hdiutil verify`：通过；挂载 DMG 后对其中 Zeus.app 执行 `codesign --verify --deep --strict`：通过。
- 挂载 DMG 后运行包内健康检查：通过，Codex runtime 为 `0.145.0-alpha.30`、`aarch64-apple-darwin`。
- 全量发布快照重新构建后的正式 App 真实启动：通过；隔离用户数据目录下监听 `127.0.0.1:52236`，`/health`
  返回 `ok=true`、`status=ok`、
  `version=0.1.0`、`database=ok`、`runtime=ok`，验收后正常退出。
- 临时 Tap 中 `brew info --cask codex-zeus/check/zeus`、`brew install --cask --dry-run codex-zeus/check/zeus` 与
  `brew style codex-zeus/check/zeus`：通过；临时 Tap 随后已删除，Homebrew developer mode 已关闭。
- GitHub Release 已公开 6 个资产；GitHub 返回的 DMG SHA256 为
  `5ba434a0c71b4e8140eb065df6b16e839cf5f17b97c0a4adcbd7d6f07f3a52a9`，ZIP SHA256 为
  `c9a7a79506bdc182e49f9b12c2ab098f57bf766f5e94d1c43606d3cc120feec8`，均与本地一致。
- 远端 `Casks/zeus.rb` 与本地摘要均为
  `824664034cd75e230edc6734b536712c928d8ad78e0552f5078f34a23d67ac59`。
- `brew install --cask imchenway/tap/zeus`：退出码 0；真实下载公开 DMG、通过 SHA256 校验并安装到
  `/Applications/Zeus.app`。
- Homebrew 安装版真实启动：主进程 `/Applications/Zeus.app/Contents/MacOS/Zeus`、内置 runtime
  `/Applications/Zeus.app/Contents/Resources/codex/codex app-server` 均存在；`/health` 返回
  `ok=true`、`status=ok`、`version=0.1.0`、`database=ok`、`runtime=ok`。

### 已知限制

- 全仓 `pnpm format:check` 命中 80 个既有未格式化文件；本任务没有批量改写用户其他工作。
- 当前 App 仍是 ad-hoc 签名，manifest 明确记录 `signed=false`、`notarized=false`，`spctl --assess` 返回
  rejected；这与本机无 Developer ID/公证凭据的事实一致。
- 本机 Command Line Tools 低于 Homebrew 当前审计要求，`brew audit --cask --strict` 在进入完整审计前退出。
- GitHub Actions dry run `30421181556` 在打包阶段因空 `CSC_LINK` 被 electron-builder 误判为证书路径而失败；这次公开版本
  使用已经完整验证的本地产物直接发布，不依赖该失败 run。打包脚本已增加空 Apple secret 过滤，但未重新执行耗时的远端全量构建。
- 当前只发布 Apple Silicon 产物，Intel Mac 不在本次支持范围。
