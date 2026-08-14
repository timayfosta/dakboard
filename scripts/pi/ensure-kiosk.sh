#!/usr/bin/env bash
# Autostart fallback — launch kiosk once the desktop session is up.
# Skips if Chromium is already running (systemd may have started it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if pgrep -af "chromium.*FamilyBoardKiosk" >/dev/null 2>&1; then
  exit 0
fi
if pgrep -af "chromium.*family-board-kiosk" >/dev/null 2>&1; then
  exit 0
fi
if pgrep -af "chromium-browser.*FamilyBoardKiosk" >/dev/null 2>&1; then
  exit 0
fi

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export FAMILY_BOARD_SKIP_SERVER=1

# Rotate first (reads scripts/pi/kiosk.env)
if [[ -x "$ROOT/scripts/pi/rotate-display.sh" ]]; then
  FAMILY_BOARD_ROTATE_WAIT=20 bash "$ROOT/scripts/pi/rotate-display.sh" || true
fi

# Wait for API a bit — systemd api unit may still be starting
bash "$ROOT/scripts/pi/wait-for-api.sh" 90 || true

exec bash "$ROOT/scripts/pi/start-kiosk.sh"
