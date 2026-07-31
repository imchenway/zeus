# 发布工程

Zeus 发布工程必须基于真实构建、真实运行检查和真实产物。Apple signing / notarization 未配置时，可以公开交付
ad-hoc 签名的 unsigned DMG，但必须显式标注签名、公证和 Gatekeeper 限制，不得伪造 Apple 分发认证。

## 发布脚本

发布脚本覆盖 pnpm dev、pnpm verify:publish、pnpm package:mac、pnpm verify:release。

- `pnpm dev`：通过 `@zeus/desktop dev` 对齐 macOS Run 脚本。
- `pnpm verify:publish`：本地、普通 CI 与完整 Release 共用的发布前入口；检查本次变更文件格式、Git 空白错误、lint、typecheck 和 build。
- `pnpm package:mac`：生成 macOS App 与 DMG；无 Developer ID 证书时在打包阶段完成 ad-hoc 签名。
- `pnpm verify:release`：先复用 `verify:publish`，再执行 AI CLI adapter 探针和 macOS 打包，并生成内部 Homebrew Cask 与公开更新清单。

普通推送和 GitHub CI 都只需执行：

```bash
pnpm verify:publish
```

CI 通过 `ZEUS_VERIFY_BASE` 与 `ZEUS_VERIFY_HEAD` 传入本次推送或 PR 的提交范围；本地则自动合并未提交、已暂存、未跟踪和尚未推送的变更。Prettier 只检查该范围内的代码与配置文件，避免历史格式欠账让每次无关文档提交都固定失败。优点是本地与远端结果一致、执行入口简单；缺点是正式推送前会执行一次完整生产构建，耗时高于只跑 lint。依赖审计按需单独运行 `pnpm security:audit`，不放进普通推送或实用发布的自动门禁。

## 产物

公开 Release 只包含版本化 DMG 和更新 manifest；Zeus.app 与 Homebrew Cask 是本地或 CI 内部发布工件，不作为 Release 附件。

- 公开 DMG：`dist/Zeus-0.1.5-arm64.dmg`；
- 公开更新清单：`dist/zeus-release-manifest.json`，供应用内检查更新读取；
- 内部 App：`dist/mac-arm64/Zeus.app`；
- 内部 Homebrew Cask：`dist/homebrew/zeus.rb`，同步到 `imchenway/homebrew-tap`；
- 模板 Cask：`Casks/zeus.rb`。

## 发布门禁

普通发布前门禁必须覆盖变更文件格式、Git 空白错误、lint、typecheck 和 build。完整 macOS 发布门禁在此基础上继续覆盖
acceptance matrix、AI CLI adapter 探针、package:mac、包内 Electron 加载和包内 renderer/main 非 GUI 健康检查。

### 待发布稳定基线（0.1.5）

- 根包与桌面包版本已同步为 `0.1.5`；
- 本次修复界面租约过期或执行宿主退出后永久重试的问题：Main 会重新登记当前宿主，控制端点失效时通过安全 rendezvous 发现或启动唯一宿主，并向 Renderer 提供刷新后的 Local Server 地址；
- 本次修复历史 snapshot 尚未加载时被误报为空会话的问题：只有权威 snapshot 已成功加载且确实为空时才展示“发送第一条消息”，连接失败时明确展示历史暂不可用；
- 发布仍沿用 ad-hoc 实用发布，必须保持 manifest 的 `signed=false`、`notarized=false`，不描述为 Apple 已认证或应用内自动安装；
- `pnpm verify:release` 已通过：Prettier、Git 空白错误、lint、typecheck、build、12 个章节 139 项验收矩阵、AI CLI 探针、macOS arm64 打包、产物健康检查和严格 codesign 校验完整执行；
- DMG SHA256：`81a0906587fa2775d1a4964e4a86823577674d89e6780a171463f4b9bcb05b70`，大小为 `252261991` 字节，`hdiutil verify` 返回 `VALID`；
- manifest SHA256：`c976aa35984a0af9367d912294a1e4be349aaa300fc21369aeb58a78424384b3`，明确记录 `version=0.1.5`、`signed=false`、`notarized=false`；
- 只使用仓库 `dist/mac-arm64/Zeus.app` 真实启动，`/health` 返回 `version=0.1.5`、`database=ok`、`runtime=ok`；Fast 历史会话可见 369 个 item；
- 暂停 Main 20 秒后，同一宿主和租约重新附着；结束执行宿主后约 3.5 秒内只启动一个新宿主，历史继续可见，界面均未出现 `Failed to fetch` 或永久重连；
- 宿主替换后的首次外部 `sqlite3 quick_check` 恰逢数据库落盘窗口，返回一次 `database disk image is malformed`；随后连续 5 次 `quick_check` 与一次 `integrity_check` 均返回 `ok`，应用健康检查也为 `database=ok`。该瞬态外部读取事实保留在发布记录中，不描述为数据库从未出现并发读取窗口；
- 验收应用正常退出后 Main、执行宿主和 Codex runtime 均结束，rendezvous 已清理；
- 远端 CI、GitHub Release、公开资产和 Homebrew Tap 结果将在发布完成后写回，不复用 `0.1.4` 的远端验证数字。

### 历史稳定基线（0.1.4）

- 根包与桌面包版本已同步为 `0.1.4`；
- `pnpm verify:release`：通过；Prettier、Git 空白错误、lint、typecheck、build、12 个章节 139 项验收矩阵、
  AI CLI 探针、macOS arm64 打包、产物健康检查和严格 codesign 校验完整执行；
- DMG SHA256：`680d739c9f82fa4dfb2aced9dfb849eb6889a559f0c240a7a748b908cfa487d3`，大小为
  `252245255` 字节，`hdiutil verify` 返回 `VALID`；
- 只启动仓库 `dist/mac-arm64/Zeus.app` 并使用隔离用户数据验收；Main、独立执行宿主和内置 Codex runtime
  分别为真实独立进程，本地服务只监听 `127.0.0.1`，`/health` 返回 `version=0.1.4`、
  `database=ok`、`runtime=ok`，正常退出后宿主和 rendezvous 均完成清理；
- Electron Renderer 从包内 `file://` 入口完成渲染，无白屏或框架错误覆盖层，“设置”入口可以进入通用设置；
- 当前产物仍为 ad-hoc 签名且未公证，manifest 明确保存 `signed=false`、`notarized=false`，
  `spctl --assess` 返回 rejected；
- 发布提交 `31775ad56a9f3ff8caf6b774786f3681af756ff5` 通过 PR `#14` 的 CI
  `30618087770` 和 `main` 推送 CI `30618170282`；annotated tag `v0.1.4` 解引用后指向同一提交；
- GitHub Release：`https://github.com/imchenway/zeus/releases/tag/v0.1.4`，为非草稿、非预发布的 Latest Release；
- Release 公开下载区只包含 `Zeus-0.1.4-arm64.dmg` 与 `zeus-release-manifest.json`，GitHub 服务端返回的
  SHA256 分别为 `680d739c9f82fa4dfb2aced9dfb849eb6889a559f0c240a7a748b908cfa487d3` 和
  `7efe619b4e0141a463aca4e76eb53a51073a854a0ae25d6f21b786c7400e15eb`，与本地产物一致；
- GitHub Release notes 与 `docs/releases/v0.1.4.md` 完全一致，覆盖长任务升级保护、任务 Git 工作区与代码交付、
  代码图谱、测试版隔离、升级方式、系统要求、签名限制、已知边界和真实验证；
- Homebrew Tap：`imchenway/homebrew-tap` 的 `Casks/zeus.rb` 已发布，提交为
  `2774bca972fe3c3c53c0c8dd42596aa0d8ea784c`；远端文件摘要
  `abf10a6f00d75a62b5ef3cecc26e4925a42edb04e44b9a56a57c4a0a9698d1ab` 与本地生成 Cask 一致；
- 本次没有启动 Release workflow；按仓库允许的人工备用通道发布本地完整门禁通过的不可变制品并同步 Tap；
- 本轮没有执行 Homebrew 安装、升级或启动 `/Applications/Zeus.app`；发布后核对只读取远端资产、manifest 和 Tap。

### 历史稳定基线（0.1.3）

- 根包与桌面包版本已同步为 `0.1.3`；
- `pnpm verify:release`：通过；Prettier、Git 空白错误、lint、typecheck、build、12 个章节 139 项验收矩阵、
  AI CLI 探针、macOS arm64 打包、产物健康检查和严格 codesign 校验完整执行；
- DMG SHA256：`32491e85d57ba594bc36cac9295aecf41e47f1fa92ce5b93e29e375122f8a068`，大小为
  `252114101` 字节，`hdiutil verify` 返回 `VALID`；
- 只启动仓库发布 worktree 生成的 `dist/mac-arm64/Zeus.app`；本地服务只监听 `127.0.0.1`，
  `/health` 返回 `ok=true`、`version=0.1.3`、`database=ok`、`runtime=ok`，随后正常退出；
- 当前产物仍为 ad-hoc 签名且未公证，manifest 明确保存 `signed=false`、`notarized=false`；
- 任务提交 `a7e47f7347214d20dd87dad78afbcc0d5b1fe769` 通过 merge commit `9b3f17e` 合入，
  发布提交为 `052538940e549dd5b2557b05fb0bc5509babdf03`；
- 远端 CI `30615685576` 对发布提交验证通过；annotated tag `v0.1.3` 解引用后指向同一提交；
- GitHub Release：`https://github.com/imchenway/zeus/releases/tag/v0.1.3`，为非草稿、非预发布的 Latest Release；
- Release 公开下载区只包含 `Zeus-0.1.3-arm64.dmg` 与 `zeus-release-manifest.json`，GitHub 服务端返回的
  SHA256 分别为 `32491e85d57ba594bc36cac9295aecf41e47f1fa92ce5b93e29e375122f8a068` 和
  `037f09b8215f1d622bbc81616e7efa02c07b0eb52483ed00f7550a7848f9fcdd`，与本地产物一致；
- GitHub Release notes 与 `docs/releases/v0.1.3.md` 完全一致，覆盖用户向更新内容、升级方式、系统要求、
  签名限制、真实运行验证和 DMG 摘要；
- Homebrew Tap：`imchenway/homebrew-tap` 的 `Casks/zeus.rb` 已发布，提交为
  `9ce90f56ced4d8af88e4be84389053c427e06370`；远端文件摘要
  `33948ce8883112379d8b7fe9339eb6ca5782b1d0ad2c8666a4b1edcf220da258` 与本地生成 Cask 一致；
- 本次没有启动 Release workflow；按仓库允许的人工备用通道发布本地完整门禁通过的不可变制品并同步 Tap；
- 本轮没有执行 Homebrew 安装、升级或启动 `/Applications/Zeus.app`；发布后核对只读取远端资产、manifest 和 Tap。

### 历史稳定基线（0.1.2）

- 根包与桌面包版本已同步为 `0.1.2`；
- `pnpm verify:release`：通过；Prettier、lint、typecheck、build、12 个章节 139 项验收矩阵、
  AI CLI 探针、macOS arm64 打包、产物健康检查和严格 codesign 校验完整执行；
- DMG SHA256：`23187b7fa1842e23b009606dc9415ee3fc004ccd9d01fa27d53db347b8b2b740`；
- 仓库 `dist/mac-arm64/Zeus.app` 中的应用菜单 `Check for Updates...` 与 `Command+U`
  均真实触发检查弹窗；
- `/Applications/Zeus.app` 不作为开发验收载体，已恢复为验收前原始副本；
- 当前产物仍为 ad-hoc 签名且未公证，manifest 明确保存 `signed=false`、`notarized=false`；
- 发布源码经 PR `#12` 的远端 CI `30528247790` 验证通过后合并到 `main`，合并提交为
  `7a6434e2cfbd967329d3eb2d04982c5ea2e160be`，标签为 `v0.1.2`；
- GitHub Release：`https://github.com/imchenway/zeus/releases/tag/v0.1.2`，公开下载区只保留 DMG 和 manifest；
  GitHub 服务端返回的 DMG 与 manifest 摘要与本地产物一致；
- GitHub Release notes 已补充面向用户的完整更新日志，明确列出过程反馈与对话体验、统一底部交互坞、
  检查更新、升级方式、系统要求、签名限制和制品摘要；
- Homebrew Tap：`imchenway/homebrew-tap` 的 `Casks/zeus.rb` 已发布，提交为
  `53153209c7136461c98b6ba863677bd99dcc822c`，远端文件摘要
  `7f76a24aad24d431bda0fcfee7977889b279b30ec67faed39547735d1d58e189` 与本地 Cask 一致；
- GitHub Release workflow `30528362786` 因未配置 `HOMEBREW_TAP_TOKEN` 在构建前失败；本次按仓库允许的
  人工备用通道发布本地完整门禁通过的不可变制品，不把该 Actions 运行记录为远端打包通过；
- 本轮没有执行 Homebrew 安装、升级或启动 `/Applications/Zeus.app`；发布后核对只读取远端资产、manifest 和 Tap。

### 历史稳定基线（0.1.1）

- `pnpm verify:release`：通过；Git 空白错误、变更文件 Prettier、lint、typecheck、build、12 个章节 139 项验收矩阵、
  AI CLI 探针、macOS arm64 打包和产物健康检查完整执行。
- App 签名完整性：`codesign --verify --deep --strict` 通过。
- DMG 完整性：`hdiutil verify` 通过。
- DMG SHA256：`80b84ad65743654bb0fb91cfd3dbcc3b9976ac64c516da16bae433e0e8a01545`。
- ZIP SHA256：`0008dee0aaf956c69f33416ca08ebfe8c20f78206c156c23fc25e7cef7469d10`。
- 包内 renderer/main/runtime 非 GUI 健康检查：
  `packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js;preload=dist/preload/index.cjs;browserPagePreload=dist/preload/browser-page.cjs;codex=0.145.0-alpha.30;arch=aarch64-apple-darwin`。
- GitHub Release：`https://github.com/imchenway/zeus/releases/tag/v0.1.1`，6 个资产均已上传；GitHub 服务端返回的
  DMG/ZIP SHA256 与本地产物一致。
- Homebrew Tap：`imchenway/homebrew-tap` 的 `Casks/zeus.rb` 已发布，提交为
  `dcceffbd32a42d7fa23e93261186da3549c37d0c`，远端内容摘要与本地 Cask 一致。
- `brew upgrade --cask imchenway/tap/zeus` 已从公开 Release 完整下载并校验 DMG，成功将本机
  `/Applications/Zeus.app` 从 `0.1.0` 升级到 `0.1.1`。
- Homebrew 安装版已真实启动，主进程和内置 Codex runtime 均来自 `/Applications/Zeus.app`；本地服务只监听
  `127.0.0.1`，`/health` 返回 `ok=true`、`status=ok`、`version=0.1.1`、`database=ok`、`runtime=ok`，
  随后正常退出。
- GitHub Actions 运行 `30440270579` 因未配置 `HOMEBREW_TAP_TOKEN` 在构建前失败；本次按人工备用通道使用本地
  完整门禁通过的不可变制品发布，不把该 Actions 运行记录为远端构建通过。

### 历史稳定基线（0.1.0）

- `pnpm verify:release`：通过；acceptance matrix、lint、typecheck、build、AI CLI 探针、打包和产物门禁完整执行。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`：分别通过。
- AI CLI adapter 探针：`ai-cli-adapters=checked;codex=available@0.145.0;claude=available@2.1.198;gemini=available@0.32.1;authStatus=real-probe-or-unknown`。
- 包内 Electron 加载：以当前 `apps/desktop/electron-builder.yml` 的 Electron 版本为准。
- 包内 renderer/main/runtime 非 GUI 健康检查：`packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js;preload=dist/preload/index.cjs;browserPagePreload=dist/preload/browser-page.cjs;codex=0.145.0-alpha.30;arch=aarch64-apple-darwin`。
- 正式 App 真实启动：仅监听 `127.0.0.1`，`/health` 返回 `ok=true`、`status=ok`、`version=0.1.0`，随后正常退出。
- Homebrew cask sha256：`5ba434a0c71b4e8140eb065df6b16e839cf5f17b97c0a4adcbd7d6f07f3a52a9`。
- 临时 Tap 中 `brew info --cask`、`brew install --cask --dry-run` 与 `brew style`：通过；临时 Tap 已删除。
- GitHub Release：`https://github.com/imchenway/zeus/releases/tag/v0.1.0`，6 个资产均已上传；GitHub 返回的 DMG/ZIP
  SHA256 与本地产物一致。
- Homebrew Tap：`imchenway/homebrew-tap` 的 `Casks/zeus.rb` 已发布，提交为
  `67437061e7434d8c68410b11a9afb7e0aba69c59`，远端内容摘要与本地 Cask 一致。
- 标准命令 `brew install --cask imchenway/tap/zeus` 已从公开 Release 完成真实下载、SHA256 校验和安装，
  `/Applications/Zeus.app` 的版本为 `0.1.0`。
- Homebrew 安装版已真实启动，主进程和内置 Codex runtime 均来自 `/Applications/Zeus.app`；`/health` 返回
  `ok=true`、`status=ok`、`version=0.1.0`、`database=ok`、`runtime=ok`。

## 签名与 notarization

Apple signing / notarization 未配置时，允许进行明确标注的实用发布；这不等同于 Developer ID 正式签名或 Apple 公证。

- 本地没有证书时，electron-builder 在生成 DMG 前对 App 执行 ad-hoc 签名，保证归档内外是同一签名阶段；这不等同于 Developer ID 签名。
- CI/release workflow 支持 `MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PASSWORD`、Apple ID，或
  `APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` App Store Connect API Key 公证凭据，以及
  `HOMEBREW_TAP_TOKEN`。
- `publish_release=true` 默认允许发布真实验证过的 ad-hoc 产物；只有显式设置
  `require_apple_distribution=true` 时，才强制最终 App 同时具备 Developer ID 签名与 Apple 公证票据。
- GitHub Actions 注入空 Apple secret 时，打包脚本会移除空值，避免 electron-builder 把空 `CSC_LINK` 误判成证书路径。
- 当前公开版本的 manifest 明确记录 `signed=false`、`notarized=false`；`spctl --assess` 返回 rejected，但本机普通
  `open` 已成功启动。其他 Mac 仍可能需要在 Finder 中右键“打开”并确认系统提示。
- 不得把 ad-hoc 产物描述为已完成 Developer ID 签名或 Apple 公证。

当前方案优点是无需等待 Apple Developer 凭据即可稳定形成 Release、Tap 和一键安装链路；缺点是首次启动体验不如已公证应用，
也不能启用静默自动更新。Developer ID 签名和公证保留为后续增强。

## Homebrew cask

sha256 由 release 脚本从真实 DMG 计算，不允许 sha256 :no_check。

- cask 名称为 Zeus。
- URL 指向 GitHub Release 版本产物。
- 当前阶段 Tap 为 `imchenway/homebrew-tap`，用户命令为 `brew install --cask imchenway/tap/zeus`。
- Cask 必须显式声明只支持 macOS。
- 单架构 Cask 必须用 `depends_on arch:` 明确限制，不能让 Intel Mac 下载 Apple Silicon 产物或反向误装。
- `app "Zeus.app"` 安装到 `/Applications/Zeus.app`。
- uninstall 通过 bundle id 退出 Zeus；当前源码没有 LaunchAgent，不声明不存在的 launchctl 清理。
- zap 清理 `~/Library/Application Support/Zeus` 需要用户确认。
- Actions 自动同步远端 Tap 需要只对 `imchenway/homebrew-tap` 有 Contents 写权限的 token；明确授权的人工发布也可通过
  GitHub API 同步，不影响 Cask 生成和安装。

## 可选增强与自动化凭据

- Apple Developer 证书和 notarization 凭据只用于改善 Gatekeeper 体验及启用严格 Apple 分发，不阻塞实用发布。
- `HOMEBREW_TAP_TOKEN` 用于 Actions 自动同步 Tap；当前公开版本已在用户明确授权下完成 Release 与 Tap 人工发布。
- `publish_release=false` 时只上传 DMG 和 manifest 的 Actions artifact，不创建 Release、不更新 Tap。
- `publish_release=true` 时，既有 tag 必须与 `package.json` 版本一致；workflow 完成发布门禁后创建非草稿 GitHub Release，
  最后把 `dist/homebrew/zeus.rb` 同步为 Tap 仓库的 `Casks/zeus.rb`。
- 每个新版本必须在 `docs/releases/v<version>.md` 提供面向用户的 Release notes；文件缺失或为空时拒绝公开发布。
- 同名 Release 已存在时只允许 DMG SHA256 完全一致的幂等续跑，禁止用同一版本静默替换二进制。
- 应用内更新检查读取 GitHub Release manifest；签名和公证完成前只允许打开 GitHub Release 手动安装，不做静默替换。

## 禁止项

- 不伪造签名成功、公证成功、远端 Homebrew tap 发布成功或自动更新可用状态。
- 版本发布必须包含面向用户的升级内容、升级方式和已知限制；单句签名或门禁提示不能替代 Release notes。
- 不用 `sha256 :no_check` 代替真实 DMG sha256。
- 不把旧 sha256、旧构建结果或旧运行结果写成最新发布证据。
- 不把构建产物修改当作源码交付。
