#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Zeus"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
LOG_FILE="$ROOT_DIR/.tmp/zeus-electron.log"
ELECTRON_BIN="$(node -p "require('electron')")"

pkill -f "$DESKTOP_DIR" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
pnpm --filter @zeus/desktop build

run_app() {
  mkdir -p "$(dirname "$LOG_FILE")"
  ZEUS_DESKTOP_DIR="$DESKTOP_DIR" ZEUS_PROJECT_ROOT="$ROOT_DIR" "$ELECTRON_BIN" "$DESKTOP_DIR" >"$LOG_FILE" 2>&1 &
}

case "$MODE" in
  run)
    run_app
    ;;
  --debug|debug)
    ZEUS_DESKTOP_DIR="$DESKTOP_DIR" ZEUS_PROJECT_ROOT="$ROOT_DIR" lldb -- "$ELECTRON_BIN" "$DESKTOP_DIR"
    ;;
  --logs|logs)
    run_app
    tail -f "$LOG_FILE"
    ;;
  --telemetry|telemetry)
    run_app
    /usr/bin/log stream --info --style compact --predicate "process CONTAINS \"$APP_NAME\""
    ;;
  --verify|verify)
    run_app
    sleep 2
    pgrep -f "$DESKTOP_DIR" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
