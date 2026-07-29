# 发布工程

Zeus 发布工程必须基于真实构建、真实运行检查和真实产物。没有 Apple Developer ID 或 notarization 凭据时，可以交付本地
ad-hoc 签名 DMG/ZIP，但必须显式标注，不得伪造正式签名、公证或远端发布成功。

## 发布脚本

发布脚本覆盖 pnpm dev、pnpm lint、pnpm typecheck、pnpm build、pnpm package:mac、pnpm verify:release。

- `pnpm dev`：通过 `@zeus/desktop dev` 对齐 macOS Run 脚本。
- `pnpm lint`：静态检查。
- `pnpm typecheck`：TypeScript build references 检查。
- `pnpm build`：workspace build 与 desktop build。
- `pnpm package:mac`：生成 macOS App、DMG 与 ZIP；无 Developer ID 证书时在打包阶段完成 ad-hoc 签名。
- `pnpm verify:release`：串联最终发布门禁并生成 Homebrew Cask、SHA256SUMS、安装脚本与更新清单。

## 产物

发布产物包括 Zeus.app、Zeus-0.1.0-arm64.dmg、Zeus-0.1.0-arm64.zip、dist/homebrew/zeus.rb、dist/SHA256SUMS、dist/install.sh、dist/zeus-release-manifest.json。

- App：`dist/mac-arm64/Zeus.app`。
- DMG：`dist/Zeus-0.1.0-arm64.dmg`。
- ZIP：`dist/Zeus-0.1.0-arm64.zip`。
- Homebrew cask：`dist/homebrew/zeus.rb`。
- 安装脚本：`dist/install.sh`，支持 `ZEUS_NON_INTERACTIVE`、`ZEUS_INSTALL_DIR`、`ZEUS_CHANNEL`。
- 更新清单：`dist/zeus-release-manifest.json`，供应用内检查更新读取。
- 校验文件：`dist/SHA256SUMS`。
- 模板 cask：`Casks/zeus.rb`。

## 发布门禁

发布门禁必须覆盖 acceptance matrix、lint、typecheck、AI CLI adapter 探针、build、package:mac、包内 Electron 加载、包内
renderer/main 非 GUI 健康检查。

当前最新基线：

- `pnpm verify:release`：通过；acceptance matrix、lint、typecheck、build、AI CLI 探针、打包和产物门禁完整执行。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm package:mac`：分别通过。
- AI CLI adapter 探针：`ai-cli-adapters=checked;codex=available@0.145.0;claude=available@2.1.198;gemini=available@0.32.1;authStatus=real-probe-or-unknown`。
- 包内 Electron 加载：以当前 `apps/desktop/electron-builder.yml` 的 Electron 版本为准。
- 包内 renderer/main/runtime 非 GUI 健康检查：`packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js;preload=dist/preload/index.cjs;browserPagePreload=dist/preload/browser-page.cjs;codex=0.145.0-alpha.30;arch=aarch64-apple-darwin`。
- 正式 App 真实启动：仅监听 `127.0.0.1`，`/health` 返回 `ok=true`、`status=ok`、`version=0.1.0`，随后正常退出。
- Homebrew cask sha256：`5ba434a0c71b4e8140eb065df6b16e839cf5f17b97c0a4adcbd7d6f07f3a52a9`。
- 临时 Tap 中 `brew info --cask`、`brew install --cask --dry-run` 与 `brew style`：通过；临时 Tap 已删除。

## 签名与 notarization

Apple signing / notarization 未配置时，只能声明未完成正式分发签名与公证，不伪造 notarization 成功。

- 本地没有证书时，electron-builder 在生成 DMG/ZIP 前对 App 执行 ad-hoc 签名，保证归档内外是同一签名阶段；这不等同于 Developer ID 签名。
- CI/release workflow 支持 `MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PASSWORD`、Apple ID，或
  `APPLE_API_KEY_P8` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` App Store Connect API Key 公证凭据，以及
  `HOMEBREW_TAP_TOKEN`。
- `publish_release=true` 时，发布门禁必须从最终 App 中确认 Developer ID 签名与 Apple 公证票据，否则在创建 Release 前失败。
- 签名和公证成功前，README、CHANGELOG、ROADMAP、实现报告、PR 模板都必须标注 ad-hoc / 未公证 / waiting。
- 不得把未签名产物描述为正式已签名发布。

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
- 远端 Homebrew Tap 发布需要用户提供只对 `imchenway/homebrew-tap` 有 Contents 写权限的 token；未提供时只生成本地 Cask。

## 外部等待项

- Apple Developer 证书、notarization 凭据、Homebrew tap token。
- GitHub Release 发布权限；`publish_release=false` 时只上传 Actions artifact，不创建 Release、不更新 Tap。
- `publish_release=true` 时，既有 tag 必须与 `package.json` 版本一致；workflow 先完成签名、公证与发布门禁，再创建非草稿
  GitHub Release，最后把 `dist/homebrew/zeus.rb` 同步为 Tap 仓库的 `Casks/zeus.rb`。
- 同名 Release 已存在时只允许 DMG SHA256 完全一致的幂等续跑，禁止用同一版本静默替换二进制。
- 应用内更新检查读取 GitHub Release manifest；签名和公证完成前只允许打开 GitHub Release 手动安装，不做静默替换。

## 禁止项

- 不伪造签名成功、公证成功、远端 Homebrew tap 发布成功或自动更新可用状态。
- 不用 `sha256 :no_check` 代替真实 DMG sha256。
- 不把旧 sha256、旧构建结果或旧运行结果写成最新发布证据。
- 不把构建产物修改当作源码交付。
