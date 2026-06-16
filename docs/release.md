# 发布工程

Zeus 发布工程必须基于真实构建、真实测试、真实扫描和真实产物。没有 Apple 签名或 notarization 凭据时，可以交付 unsigned DMG/ZIP，但必须显式标注，不得伪造签名、公证或远端发布成功。

## 发布脚本

发布脚本覆盖 pnpm dev、pnpm lint、pnpm typecheck、pnpm test、pnpm test:real-scan、pnpm build、pnpm package:mac、pnpm verify:release。

- `pnpm dev`：通过 `@zeus/desktop dev` 对齐 macOS Run 脚本。
- `pnpm lint`：静态检查。
- `pnpm typecheck`：TypeScript build references 检查。
- `pnpm test`：Vitest 全量单元/集成测试。
- `pnpm test:real-scan`：扫描当前 checkout 的真实仓库，不依赖维护者本机绝对路径。
- `pnpm build`：workspace build 与 desktop build。
- `pnpm package:mac`：生成 macOS App、DMG、ZIP 与 Homebrew cask。
- `pnpm verify:release`：串联最终发布门禁。

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

发布门禁必须覆盖 acceptance matrix、lint、typecheck、64 test files / 575 tests、真实扫描 174 files / 17036 nodes / 32848 edges / 7 views、Java/Spring/MyBatis fixture、AI CLI adapter 探针、build、package:mac、包内 Electron 加载、包内 renderer/main 非 GUI 健康检查。

当前最新基线：

- `pnpm verify:release`：通过。
- 测试：64 test files / 575 tests passed。
- 真实扫描：174 files / 17036 nodes / 32848 edges / 7 views。
- Java/Spring/MyBatis fixture：`java-spring-fixture=verified;files=6;symbols=42`。
- AI CLI adapter 探针：`ai-cli-adapters=checked;codex=available@0.140.0;claude=available@2.1.177;gemini=available@0.32.1;authStatus=real-probe-or-unknown`。
- 包内 Electron 加载：以当前 `apps/desktop/electron-builder.yml` 的 Electron 版本为准。
- 包内 renderer/main 非 GUI 健康检查：`packaged-health=Zeus;rendererAssets=2;main=dist/main/main.js`。
- Homebrew cask sha256：`708268e52ed23d143954d185f1d9028e98e5e85cbfaca6246812742b81751e0e`。

## 签名与 notarization

Apple signing / notarization 未配置时，只能声明 unsigned DMG/ZIP，不伪造 notarization 成功。

- 本地没有证书时 unsigned build 必须成功。
- CI/release workflow 保留 `MACOS_CERTIFICATE`、`MACOS_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`、`HOMEBREW_TAP_TOKEN` 等等待项。
- 签名和公证成功前，README、CHANGELOG、ROADMAP、实现报告、PR 模板都必须标注 unsigned / waiting。
- 不得把未签名产物描述为正式已签名发布。

## Homebrew cask

sha256 由 release 脚本从真实 DMG 计算，不允许 sha256 :no_check。

- cask 名称为 Zeus。
- URL 指向 GitHub Release 版本产物。
- `app "Zeus.app"` 安装到 `/Applications/Zeus.app`。
- uninstall 清理 launch agents 预留。
- zap 清理 `~/Library/Application Support/Zeus` 需要用户确认。
- 远端 Homebrew tap 发布需要用户提供 token；未提供时只生成本地 cask。

## 外部等待项

- Apple Developer 证书、notarization 凭据、Homebrew tap token。
- GitHub Release 发布权限；`workflow_dispatch.inputs.tag` 为空时只上传 artifact，不创建 Release。
- 输入已有 tag 后，workflow 使用 `gh release create` 创建 draft GitHub Release，并上传 DMG、ZIP 与 `dist/homebrew/zeus.rb`。
- 应用内更新检查读取 GitHub Release manifest；签名和公证完成前只允许打开 GitHub Release 手动安装，不做静默替换。

## 禁止项

- 不伪造签名成功、公证成功、远端 Homebrew tap 发布成功或自动更新可用状态。
- 不用 `sha256 :no_check` 代替真实 DMG sha256。
- 不把旧 sha256、旧测试数或旧扫描数写成最新发布证据。
- 不把构建产物修改当作源码交付。
