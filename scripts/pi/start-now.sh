#!/usr/bin/env bash
# Start Family Board API + kiosk right now (SSH or Pi desktop).
# Does not require a reboot. Uses systemd when it works; otherwise starts Python directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
chmod +x "$ROOT/scripts/pi/"*.sh 2>/dev/null || true

PORT="${FAMILY_BOARD_PORT:-8765}"
HEALTH="http://127.0.0.1:${PORT}/api/health"
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export FAMILY_BOARD_SKIP_SERVER=1

echo "=== Family Board — start now ==="
echo "App: $ROOT"
echo "Display: $DISPLAY"

api_up() {
  curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1
}

start_api() {
  if api_up; then
    echo "API already running on port ${PORT}"
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files family-board-api.service >/dev/null 2>&1; then
    echo "Starting family-board-api via systemd…"
    sudo systemctl reset-failed family-board-api.service 2>/dev/null || true
    sudo systemctl enable family-board-api.service 2>/dev/null || true
    sudo systemctl start family-board-api.service 2>/dev/null || true
    if bash "$ROOT/scripts/pi/wait-for-api.sh" 25; then
      echo "API is up (systemd)."
      return 0
    fi
    echo "systemd API did not come up — starting Python directly."
    journalctl -u family-board-api -n 20 --no-pager 2>/dev/null || true
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    sleep 0.4
  fi
  mkdir -p "$ROOT/data/photos"
  nohup python3 -u "$ROOT/server.py" >/tmp/family-board-server.log 2>&1 &
  echo $! >/tmp/family-board-server.pid
  if bash "$ROOT/scripts/pi/wait-for-api.sh" 40; then
    echo "API is up (python)."
    return 0
  fi
  echo "API failed to start. Log:" >&2
  tail -n 30 /tmp/family-board-server.log >&2 || true
  return 1
}

start_api

if [[ -x "$ROOT/scripts/pi/rotate-display.sh" ]]; then
  echo "Rotating display…"
  FAMILY_BOARD_ROTATE_WAIT=20 bash "$ROOT/scripts/pi/rotate-display.sh" || true
fi

if pgrep -af "chromium.*(FamilyBoardKiosk|family-board-kiosk|kiosk=1)" >/dev/null 2>&1; then
  echo "Kiosk Chromium already running."
  echo "Done. Admin: http://127.0.0.1:${PORT}/admin/"
  exit 0
fi

echo "Opening kiosk…"
exec bash "$ROOT/scripts/pi/start-kiosk.sh"
