#!/usr/bin/env bash
# Start Family Board local API + Chromium kiosk (DAKOS-style)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# First enabled screen in shared/screens.js; ?kiosk=1 enables swipe + auto-rotation
URL="${FAMILY_BOARD_URL:-http://127.0.0.1:8765/screens/calendar.html?kiosk=1}"
PORT="${FAMILY_BOARD_PORT:-8765}"

cd "$ROOT"

# Prefer chromium, then chromium-browser
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

# Stop leftover server on our port (best effort)
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
fi

python3 "$ROOT/server.py" >/tmp/family-board-server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > /tmp/family-board-server.pid

# Wait for server
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Disable screen blanking when possible
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
