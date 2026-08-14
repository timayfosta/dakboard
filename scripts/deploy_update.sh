#!/usr/bin/env bash
# Pull latest code and restart Family Board (Pi / manual / CI)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash scripts/git_sync.sh

# Fix systemd paths if the repo moved (e.g. ~/family-board → ~/family-board-src)
if [[ -f /etc/systemd/system/family-board-api.service ]]; then
  CURRENT="$(grep -m1 '^WorkingDirectory=' /etc/systemd/system/family-board-api.service | cut -d= -f2- || true)"
  if [[ -n "${CURRENT}" && "${CURRENT}" != "${ROOT}" ]]; then
    echo "Systemd path mismatch (${CURRENT} vs ${ROOT}) — repairing…"
    sudo bash scripts/pi/repair-kiosk.sh
  fi
fi

if systemctl is-active --quiet family-board-api 2>/dev/null; then
  echo "Restarting family-board-api…"
  sudo systemctl restart family-board-api
  if systemctl is-enabled --quiet family-board-kiosk 2>/dev/null; then
    echo "Restarting family-board-kiosk…"
    sudo systemctl restart family-board-kiosk || true
  fi
elif [[ -f scripts/restart_server.py ]]; then
  echo "Restarting via restart_server.py…"
  python3 scripts/restart_server.py --delayed &
else
  echo "No systemd service — restart server manually."
fi

echo "Deploy complete."
