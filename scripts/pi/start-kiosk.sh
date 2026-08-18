#!/usr/bin/env bash
# Chromium kiosk for Family Board — fullscreen app window + portrait rotation
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Optional overrides: scripts/pi/kiosk.env
if [[ -f "$ROOT/scripts/pi/kiosk.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/scripts/pi/kiosk.env"
fi

PORT="${FAMILY_BOARD_PORT:-8765}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
SKIP_SERVER="${FAMILY_BOARD_SKIP_SERVER:-1}"
PROFILE_DIR="${FAMILY_BOARD_CHROMIUM_PROFILE:-$HOME/.config/family-board-kiosk}"
ROTATE="${FAMILY_BOARD_ROTATE:-right}"
MOUSE="${FAMILY_BOARD_MOUSE:-0}"

KIOSK_Q="kiosk=1"
if [[ "${MOUSE}" == "1" || "${MOUSE}" == "true" ]]; then
  KIOSK_Q="${KIOSK_Q}&mouse=1"
fi
URL="${FAMILY_BOARD_URL:-http://127.0.0.1:${PORT}/screens/calendar.html?${KIOSK_Q}}"

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export FAMILY_BOARD_ROTATE="${ROTATE}"

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

echo "Waiting for desktop session…"
if ! bash "$ROOT/scripts/pi/wait-for-display.sh"; then
  echo "Display not ready. Check desktop auto-login (raspi-config)." >&2
  exit 1
fi

wait_for_api() {
  local tries="${1:-40}"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_local_server() {
  if wait_for_api 5; then
    echo "API already running on port ${PORT}"
    return 0
  fi

  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi

  python3 "$ROOT/server.py" >/tmp/family-board-server.log 2>&1 &
  echo "$!" > /tmp/family-board-server.pid
  wait_for_api 50
}

# Display is ready — rotate for the TV, then again after HDMI settle
if [[ -x "$ROOT/scripts/pi/rotate-display.sh" ]]; then
  FAMILY_BOARD_ROTATE_WAIT=20 bash "$ROOT/scripts/pi/rotate-display.sh" || true
fi

if [[ "$SKIP_SERVER" == "1" ]]; then
  echo "Waiting for Family Board API (${HEALTH_URL})…"
  if ! bash "$ROOT/scripts/pi/wait-for-api.sh" 90; then
    echo "Family Board API did not start. Check: systemctl status family-board-api"
    exit 1
  fi
else
  echo "Manual mode — starting API if needed…"
  start_local_server
fi

xset s off >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true

# Mouse testing: don't hide cursor
if [[ "${MOUSE}" == "1" || "${MOUSE}" == "true" ]]; then
  pkill -x unclutter >/dev/null 2>&1 || true
else
  if command -v unclutter >/dev/null 2>&1; then
    pkill -x unclutter >/dev/null 2>&1 || true
    unclutter -idle 0.3 -root >/dev/null 2>&1 &
  fi
fi

mkdir -p "$PROFILE_DIR"

# Leftover Chromium after a pull/restart keeps SingletonLock, so the next
# launch often opens a normal window instead of kiosk.
cleanup_old_chromium() {
  pkill -f "user-data-dir=${PROFILE_DIR}" >/dev/null 2>&1 || true
  pkill -f "FamilyBoardKiosk" >/dev/null 2>&1 || true
  sleep 0.8
  rm -f \
    "$PROFILE_DIR/SingletonLock" \
    "$PROFILE_DIR/SingletonSocket" \
    "$PROFILE_DIR/SingletonCookie"
}
cleanup_old_chromium

# Systemd does not inherit the desktop session. On Pi OS Wayland (labwc),
# Chromium with only DISPLAY=:0 becomes an XWayland window with chrome.
UID_NUM="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${UID_NUM}}"
OZONE_ARGS=(--ozone-platform=x11)
if [[ -S "${XDG_RUNTIME_DIR}/wayland-0" ]]; then
  export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
  OZONE_ARGS=(--ozone-platform=wayland)
elif [[ -S "${XDG_RUNTIME_DIR}/wayland-1" ]]; then
  export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
  OZONE_ARGS=(--ozone-platform=wayland)
fi

# --kiosk is what actually stays fullscreen. --app alone often comes back
# as a decorated window after Chromium restores the last window size.
KIOSK_ARGS=(--app="$URL" --start-fullscreen --window-position=0,0)
if [[ "${MOUSE}" == "1" || "${MOUSE}" == "true" ]]; then
  KIOSK_ARGS+=(--start-maximized)
else
  KIOSK_ARGS+=(--kiosk)
fi

exec "$BROWSER" \
  --user-data-dir="$PROFILE_DIR" \
  --class=FamilyBoardKiosk \
  "${OZONE_ARGS[@]}" \
  "${KIOSK_ARGS[@]}" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --disable-features=TranslateUI,InfiniteSessionRestore,PasswordManagerOnboarding \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --disable-translate \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --fast \
  --fast-start \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --force-device-scale-factor=1
