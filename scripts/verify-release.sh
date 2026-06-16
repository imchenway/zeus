#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm verify:acceptance-matrix
pnpm lint
pnpm typecheck
pnpm test
pnpm test:real-scan
pnpm build
node scripts/verify-java-spring-fixture.mjs
node scripts/verify-ai-cli-adapters.mjs
pnpm package:mac

version="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('package.json','utf8')).version)")"
arch="$(uname -m)"
case "$arch" in
  arm64) package_arch="arm64" ;;
  x86_64) package_arch="x64" ;;
  *) echo "Zeus verify-release: unsupported macOS arch $arch" >&2; exit 1 ;;
esac

dmg="dist/Zeus-${version}-${package_arch}.dmg"
zip="dist/Zeus-${version}-${package_arch}.zip"
app="dist/mac-${package_arch}/Zeus.app"
source_cask="Casks/zeus.rb"
generated_cask="dist/homebrew/zeus.rb"
latest_dmg="dist/Zeus-latest-${package_arch}.dmg"
latest_zip="dist/Zeus-latest-${package_arch}.zip"
sha_sums="dist/SHA256SUMS"
release_manifest="dist/zeus-release-manifest.json"
install_script="dist/install.sh"
node scripts/generate-homebrew-cask.mjs "$version" "$package_arch" "$dmg" "$generated_cask"
cp "$dmg" "$latest_dmg"
cp "$zip" "$latest_zip"
(cd dist && shasum -a 256 \
  "Zeus-${version}-${package_arch}.dmg" \
  "Zeus-${version}-${package_arch}.zip" \
  "Zeus-latest-${package_arch}.dmg" \
  "Zeus-latest-${package_arch}.zip" > "SHA256SUMS")
node scripts/generate-release-manifest.mjs "$version" "stable" "imchenway/zeus" "$release_manifest"
node scripts/generate-install-script.mjs "$install_script" "imchenway/zeus" "stable"

for required in "$dmg" "$zip" "$app" "$source_cask" "$generated_cask" "$latest_dmg" "$latest_zip" "$sha_sums" "$release_manifest" "$install_script"; do
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

# 使用 Electron 的 Node 模式加载包内可执行文件，验证 macOS .app 物理产物不是空壳。
if ! ELECTRON_RUN_AS_NODE=1 "$app_executable" -e 'if (!process.versions.electron) process.exit(1); console.log(`electron=${process.versions.electron};node=${process.versions.node};arch=${process.arch}`);'; then
  echo 'Zeus verify-release: packaged app executable failed to load' >&2
  exit 1
fi

# 非 GUI 模式验证包内 Main 代码可启动本地 app-server，且 /health 只绑定 127.0.0.1。
if ! ELECTRON_RUN_AS_NODE=1 "$app_executable" scripts/verify-packaged-app-health.mjs "$app"; then
  echo 'Zeus verify-release: packaged app server health check failed' >&2
  exit 1
fi

if ! grep -q 'app "Zeus.app"' "$source_cask" || ! grep -q 'app "Zeus.app"' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must install Zeus.app' >&2
  exit 1
fi

if ! grep -q 'launchctl: "dev.hypha.zeus"' "$source_cask" || ! grep -q 'launchctl: "dev.hypha.zeus"' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must reserve launchctl cleanup' >&2
  exit 1
fi

if ! grep -q 'Application Support/Zeus' "$source_cask" || ! grep -q 'Application Support/Zeus' "$generated_cask"; then
  echo 'Zeus verify-release: Homebrew cask must zap Zeus user data path' >&2
  exit 1
fi

if [ -z "${CSC_LINK:-}" ]; then
  echo 'Zeus verify-release: Apple signing certificate is not configured; unsigned DMG/ZIP verified only.' >&2
fi
