#!/usr/bin/env bash
# Set portrait rotation and apply it now (no reboot required).
# Usage:
#   bash scripts/pi/set-rotate.sh right    # 90° clockwise — usual TV fix when image is upside-down
#   bash scripts/pi/set-rotate.sh left     # 90° counter-clockwise
#   bash scripts/pi/set-rotate.sh inverted # 180°
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "${1:-}" ]]; then
  echo "Usage: bash scripts/pi/set-rotate.sh right|left|inverted|normal" >&2
  exit 1
fi
DIR="$1"
case "${DIR}" in
  left|right|inverted|normal) ;;
  *)
    echo "Unknown rotation: ${DIR} (use left, right, inverted, or normal)" >&2
    exit 1
    ;;
esac

ENV_FILE="$ROOT/scripts/pi/kiosk.env"
if [[ -f "${ENV_FILE}" ]]; then
  if grep -q '^FAMILY_BOARD_ROTATE=' "${ENV_FILE}"; then
    sed -i "s/^FAMILY_BOARD_ROTATE=.*/FAMILY_BOARD_ROTATE=${DIR}/" "${ENV_FILE}"
  else
    echo "FAMILY_BOARD_ROTATE=${DIR}" >> "${ENV_FILE}"
  fi
else
  echo "FAMILY_BOARD_ROTATE=${DIR}" > "${ENV_FILE}"
fi

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export FAMILY_BOARD_ROTATE="${DIR}"
export FAMILY_BOARD_ROTATE_WAIT="${FAMILY_BOARD_ROTATE_WAIT:-20}"

echo "Rotation saved: FAMILY_BOARD_ROTATE=${DIR}"
bash "$ROOT/scripts/pi/rotate-display.sh"
echo "Applied. If the TV is still upside-down, run the opposite: bash scripts/pi/set-rotate.sh left"
