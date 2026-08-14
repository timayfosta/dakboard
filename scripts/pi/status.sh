#!/usr/bin/env bash
# Show whether Family Board API + kiosk are running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${FAMILY_BOARD_PORT:-8765}"

echo "=== Family Board status ==="
echo "App:  $ROOT"
echo "User: $(whoami)"
echo ""

if [[ -f /etc/systemd/system/family-board-api.service ]]; then
  echo "-- systemd API --"
  grep -E '^(WorkingDirectory|ExecStart|User)=' /etc/systemd/system/family-board-api.service || true
  echo "enabled: $(systemctl is-enabled family-board-api 2>/dev/null || echo missing)"
  echo "active:  $(systemctl is-active family-board-api 2>/dev/null || echo inactive)"
else
  echo "No /etc/systemd/system/family-board-api.service — run: sudo bash scripts/pi/install.sh"
fi
echo ""

if [[ -f /etc/systemd/system/family-board-kiosk.service ]]; then
  echo "-- systemd kiosk --"
  grep -E '^(WorkingDirectory|ExecStart|User)=' /etc/systemd/system/family-board-kiosk.service || true
  echo "enabled: $(systemctl is-enabled family-board-kiosk 2>/dev/null || echo missing)"
  echo "active:  $(systemctl is-active family-board-kiosk 2>/dev/null || echo inactive)"
else
  echo "No family-board-kiosk.service"
fi
echo ""

echo "-- health --"
if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" ; then
  echo
else
  echo "API not responding on :${PORT}"
  echo "journal:"
  journalctl -u family-board-api -n 15 --no-pager 2>/dev/null || true
fi
echo ""
echo "Chromium kiosk: $(pgrep -af 'chromium.*(FamilyBoardKiosk|kiosk=1)' | head -1 || echo not running)"
echo ""
echo "Start now:  bash $ROOT/scripts/pi/start-now.sh"
echo "Install:    sudo bash $ROOT/scripts/pi/install.sh"
