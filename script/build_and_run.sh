#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$MODE" in
  run|--debug|debug|--logs|logs|--telemetry|telemetry) ;;
  *) echo "usage: $0 [run|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac

cd "$ROOT_DIR"
# 直接运行源码，不生成 .app 或 DMG，也不按目录模糊终止其他进程。
unset ZEUS_RELEASE_BUILD ZEUS_PACKAGE_VARIANT
if [[ "${ZEUS_DEV_SERVER_READY:-}" != "1" ]]; then
  exec node "$ROOT_DIR/apps/desktop/scripts/dev.mjs" "$MODE"
fi
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
ELECTRON_BIN="$(node -p "require('electron')")"
export ZEUS_USER_DATA_DIR="${ZEUS_USER_DATA_DIR:-$ROOT_DIR/.tmp/electron-development-data}"
export ZEUS_DESKTOP_DIR="$DESKTOP_DIR"
export ZEUS_PROJECT_ROOT="$ROOT_DIR"
mkdir -p "$ROOT_DIR/.tmp"
case "$MODE" in
  --debug|debug) exec lldb -- "$ELECTRON_BIN" "$DESKTOP_DIR" ;;
  --telemetry|telemetry)
    "$ELECTRON_BIN" "$DESKTOP_DIR" > "$ROOT_DIR/.tmp/zeus-development.log" 2>&1 &
    exec /usr/bin/log stream --info --style compact --predicate 'process == "Electron"'
    ;;
  --logs|logs) "$ELECTRON_BIN" "$DESKTOP_DIR" 2>&1 | tee "$ROOT_DIR/.tmp/zeus-development.log" ;;
  run) exec "$ELECTRON_BIN" "$DESKTOP_DIR" ;;
esac
