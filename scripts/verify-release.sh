#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm verify:publish
pnpm verify:acceptance-matrix
node scripts/verify-ai-cli-adapters.mjs
release_output_dir="${ZEUS_RELEASE_OUTPUT_DIR:-dist}"
ZEUS_PACKAGE_OUTPUT_DIR="$release_output_dir" pnpm package:mac

version="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('package.json','utf8')).version)")"
arch="$(uname -m)"
case "$arch" in
  arm64)
    package_arch="arm64"
    app="$release_output_dir/mac-arm64/Zeus.app"
    ;;
  x86_64)
    package_arch="x64"
    app="$release_output_dir/mac/Zeus.app"
    ;;
  *) echo "Zeus verify-release: unsupported macOS arch $arch" >&2; exit 1 ;;
esac

dmg="$release_output_dir/Zeus-${version}-${package_arch}.dmg"
source_cask="Casks/zeus.rb"
generated_cask="$release_output_dir/homebrew/zeus.rb"
release_manifest="$release_output_dir/zeus-release-manifest.json"
source_repository="imchenway/zeus"
homebrew_tap="imchenway/tap"
node scripts/generate-homebrew-cask.mjs "$version" "$package_arch" "$dmg" "$generated_cask"

for required in "$dmg" "$app" "$source_cask" "$generated_cask"; do
  if [ ! -e "$required" ]; then
    echo "Zeus verify-release: missing required release artifact $required" >&2
    exit 1
  fi
done

app_executable="$app/Contents/MacOS/Zeus"
if [ ! -x "$app_executable" ]; then
  echo "Zeus verify-release: packaged app executable is missing or not executable: $app_executable" >&2
  exit 1
fi

signed="false"
notarized="false"
signature_details="$(/usr/bin/codesign -dv --verbose=4 "$app" 2>&1 || true)"
if printf '%s\n' "$signature_details" | grep -q 'Authority=Developer ID Application:'; then
  signed="true"
fi
if [ "$signed" = "true" ] && /usr/bin/xcrun stapler validate "$app" >/dev/null 2>&1; then
  notarized="true"
fi

if [ "${ZEUS_REQUIRE_DISTRIBUTABLE_RELEASE:-0}" = "1" ] && { [ "$signed" != "true" ] || [ "$notarized" != "true" ]; }; then
  echo 'Zeus verify-release: public Homebrew release requires a Developer ID signature and Apple notarization.' >&2
  exit 1
fi

ZEUS_RELEASE_OUTPUT_DIR="$release_output_dir" node scripts/generate-release-manifest.mjs "$version" "stable" "$source_repository" "$release_manifest" "$homebrew_tap" "$signed" "$notarized"
for required in "$release_manifest"; do
  if [ ! -e "$required" ]; then
    echo "Zeus verify-release: missing required release artifact $required" >&2
    exit 1
  fi
done

# 使用 Electron 的 Node 模式加载包内可执行文件，验证 macOS .app 物理产物不是空壳。
if ! ELECTRON_RUN_AS_NODE=1 "$app_executable" -e 'if (!process.versions.electron) process.exit(1); console.log(`electron=${process.versions.electron};node=${process.versions.node};arch=${process.arch}`);'; then
  echo 'Zeus verify-release: packaged app executable failed to load' >&2
  exit 1
fi

# 非 GUI 模式验证包内 Renderer、Main、Preload 结构，并确认没有夹带 Codex CLI。
# 真实本地服务启动、127.0.0.1 绑定和 /health 响应必须由正式 App 运行验收单独证明。
if ! ELECTRON_RUN_AS_NODE=1 "$app_executable" scripts/verify-packaged-app-health.mjs "$app"; then
  echo 'Zeus verify-release: packaged app content integrity check failed' >&2
  exit 1
fi

if ! grep -q 'app "Zeus.app"' "$source_cask" || ! grep -q 'app "Zeus.app"' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must install Zeus.app' >&2
  exit 1
fi

if ! grep -q 'uninstall quit: "dev.hypha.zeus"' "$source_cask" || ! grep -q 'uninstall quit: "dev.hypha.zeus"' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must quit the Zeus bundle during uninstall' >&2
  exit 1
fi

if ! grep -q "depends_on arch: :${package_arch/x64/x86_64}" "$source_cask" || ! grep -q "depends_on arch: :${package_arch/x64/x86_64}" "$generated_cask"; then
  echo "Zeus verify-release: Homebrew cask must declare the packaged architecture $package_arch" >&2
  exit 1
fi

if ! grep -q 'Application Support/Zeus' "$source_cask" || ! grep -q 'Application Support/Zeus' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must zap Zeus user data path' >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.homebrew?.tap !== process.argv[2]) process.exit(1);
  if (manifest.homebrew?.installCommand !== `brew install --cask ${process.argv[2]}/zeus`) process.exit(1);
  if (manifest.signed !== (process.argv[3] === "true")) process.exit(1);
  if (manifest.notarized !== (process.argv[4] === "true")) process.exit(1);
' "$release_manifest" "$homebrew_tap" "$signed" "$notarized"

if [ "$signed" != "true" ]; then
  echo 'Zeus verify-release: Developer ID signing is not configured; local ad-hoc DMG verified only, without Apple notarization.' >&2
fi
