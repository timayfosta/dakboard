#!/usr/bin/env bash
# Pull latest code and restart Family Board (Pi / manual / CI)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d .git ]]; then
  echo "Not a git repo: ${ROOT}" >&2
  echo "On the Pi, clone with git instead of rsync-only install for auto-updates." >&2
  exit 1
fi

echo "Fetching latest…"
git fetch --prune origin

UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [[ -z "${UPSTREAM}" ]]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  UPSTREAM="origin/${BRANCH}"
fi

echo "Syncing to ${UPSTREAM} (local edits to tracked files will be discarded)…"
git reset --hard "${UPSTREAM}"

# Fix systemd paths if the repo moved (e.g. ~/family-board → ~/dakboard)
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
