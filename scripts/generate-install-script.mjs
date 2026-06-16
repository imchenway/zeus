#!/usr/bin/env node
/* global console, process */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const defaultRepository = 'imchenway/zeus';

function normalizeRepository(repository) {
  const trimmed = String(repository ?? '')
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '');
  return trimmed || defaultRepository;
}

export function renderInstallScript(input = {}) {
  const repository = normalizeRepository(input.repository);
  const channel = input.channel ?? 'stable';
  return `#!/usr/bin/env bash
set -euo pipefail

# Zeus 安装脚本：只从公开 GitHub Release 下载产物，并用 SHA256SUMS 校验。
REPOSITORY="${repository}"
ZEUS_CHANNEL="\${ZEUS_CHANNEL:-${channel}}"
ZEUS_INSTALL_DIR="\${ZEUS_INSTALL_DIR:-/Applications}"
ZEUS_NON_INTERACTIVE="\${ZEUS_NON_INTERACTIVE:-0}"
RELEASE_BASE_URL="https://github.com/${repository}/releases/latest/download"

case "$(uname -m)" in
  arm64) ZEUS_ARCH="arm64" ;;
  x86_64) ZEUS_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Zeus currently ships as a macOS desktop app." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SHA_FILE="$WORK_DIR/SHA256SUMS"
DMG_FILE="$WORK_DIR/Zeus.dmg"
curl -fsSL "$RELEASE_BASE_URL/SHA256SUMS" -o "$SHA_FILE"
curl -fsSL "$RELEASE_BASE_URL/Zeus-latest-$ZEUS_ARCH.dmg" -o "$DMG_FILE"

expected_sha="$(grep "Zeus-latest-$ZEUS_ARCH.dmg" "$SHA_FILE" | awk '{print $1}')"
actual_sha="$(shasum -a 256 "$DMG_FILE" | awk '{print $1}')"
if [ -z "$expected_sha" ] || [ "$expected_sha" != "$actual_sha" ]; then
  echo "Zeus installer checksum mismatch." >&2
  exit 1
fi

if [ "$ZEUS_NON_INTERACTIVE" != "1" ]; then
  echo "Installing Zeus to $ZEUS_INSTALL_DIR. Set ZEUS_NON_INTERACTIVE=1 to suppress this prompt."
fi

MOUNT_OUTPUT="$(hdiutil attach "$DMG_FILE" -nobrowse -readonly)"
VOLUME_PATH="$(printf '%s\n' "$MOUNT_OUTPUT" | awk '$0 ~ "/Volumes/" {print substr($0, index($0, "/Volumes/")); exit}')"
if [ -z "$VOLUME_PATH" ]; then
  echo "Zeus installer could not mount the DMG." >&2
  exit 1
fi
trap 'hdiutil detach "$VOLUME_PATH" >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"' EXIT
mkdir -p "$ZEUS_INSTALL_DIR"
rm -rf "$ZEUS_INSTALL_DIR/Zeus.app"
cp -R "$VOLUME_PATH/Zeus.app" "$ZEUS_INSTALL_DIR/Zeus.app"
echo "Zeus installed: $ZEUS_INSTALL_DIR/Zeus.app"
`;
}

export async function generateInstallScript({ repository = defaultRepository, channel = 'stable', outputPath }) {
  const content = renderInstallScript({ repository, channel });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
  await chmod(outputPath, 0o755);
  return { outputPath };
}

async function main() {
  const outputPath = process.argv[2] ?? join(rootDir, 'dist', 'install.sh');
  const repository = process.argv[3] ?? defaultRepository;
  const channel = process.argv[4] ?? 'stable';
  const result = await generateInstallScript({
    outputPath,
    repository,
    channel,
  });
  console.log(`Zeus install script generated: ${result.outputPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
