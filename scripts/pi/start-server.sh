#!/usr/bin/env bash
# Start Family Board API standalone on Raspberry Pi / Linux
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PORT="${FAMILY_BOARD_PORT:-8765}"

if [[ ! -f "$ROOT/server.py" ]]; then
  echo "ERROR: server.py not found in $ROOT"
  exit 1
fi

if [[ ! -d "$ROOT/shared" ]]; then
  echo "ERROR: shared/ folder missing in $ROOT — incomplete copy/checkout"
  exit 1
fi

mkdir -p "$ROOT/data/photos"

# Stop systemd unit if it holds the port
if systemctl is-active --quiet family-board-api 2>/dev/null; then
  echo "Stopping family-board-api.service so we can run standalone…"
  sudo systemctl stop family-board-api || true
fi

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.5
fi

echo "Starting Family Board from: $ROOT"
echo "Python: $(command -v python3) ($(python3 --version 2>&1))"
exec python3 -u "$ROOT/server.py"
