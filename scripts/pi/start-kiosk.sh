#!/usr/bin/env bash
# Chromium kiosk for Family Board — API is started by systemd (family-board-api.service)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${FAMILY_BOARD_URL:-http://127.0.0.1:8765/screens/calendar.html?kiosk=1}"
PORT="${FAMILY_BOARD_PORT:-8765}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
SKIP_SERVER="${FAMILY_BOARD_SKIP_SERVER:-1}"

cd "$ROOT"

BROWSER=""
for candidate in chromium chromium-browser google-chrome; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BROWSER="$candidate"
    break
  fi
done

if [[ -z "$BROWSER" ]]; then
  echo "No Chromium/Chrome found. Install: sudo apt install chromium"
  exit 1
fi

wait_for_api() {
  local tries="${1:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_local_server() {
  if wait_for_api 2; then
    echo "API already running on port ${PORT}"
    return 0
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi

  python3 "$ROOT/server.py" >/tmp/family-board-server.log 2>&1 &
  echo "$!" > /tmp/family-board-server.pid
  wait_for_api 30
}

if [[ "$SKIP_SERVER" == "1" ]]; then
  echo "Waiting for Family Board API (${HEALTH_URL})…"
  if ! wait_for_api 90; then
    echo "Family Board API did not start. Check: systemctl status family-board-api"
    exit 1
  fi
else
  echo "Manual mode — starting API if needed…"
  start_local_server
fi

export DISPLAY="${DISPLAY:-:0}"
xset s off >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true

exec "$BROWSER" \
  --kiosk \
  --app="$URL" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --disable-translate \
  --disable-features=TranslateUI \
  --no-first-run \
  --fast \
  --fast-start \
  --disable-pinch \
  --overscroll-history-navigation=0
