#!/usr/bin/env bash
# Wait until Family Board API responds (used by kiosk service at boot)
set -euo pipefail

PORT="${FAMILY_BOARD_PORT:-8765}"
URL="http://127.0.0.1:${PORT}/api/health"
TRIES="${1:-90}"

for _ in $(seq 1 "$TRIES"); do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

echo "Family Board API not ready at ${URL} after ${TRIES}s" >&2
exit 1
