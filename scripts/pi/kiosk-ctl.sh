#!/usr/bin/env bash
# Start or stop the Family Board Chromium kiosk without touching the API.
# Usage: kiosk-ctl.sh start|stop|status
set -euo pipefail

ACTION="${1:-}"
UNIT=family-board-kiosk.service

if [[ "${EUID}" -ne 0 ]]; then
  if [[ -x /usr/local/sbin/family-board-kiosk ]]; then
    exec sudo -n /usr/local/sbin/family-board-kiosk "${ACTION}"
  fi
  exec sudo -n /bin/bash "$0" "$@"
fi

case "${ACTION}" in
  stop)
    systemctl stop "${UNIT}" || true
    # Belt-and-suspenders: quit leftover Chromium if the unit was already inactive.
    pkill -f 'chromium.*(family-board-kiosk|FamilyBoardKiosk|kiosk=1)' 2>/dev/null || true
    # Leave the unit enabled so the next reboot (or Start kiosk) still works.
    echo "kiosk stopped"
    systemctl is-active "${UNIT}" 2>/dev/null || echo "active=inactive"
    ;;
  start)
    systemctl start "${UNIT}"
    echo "kiosk started"
    systemctl is-active "${UNIT}" || true
    ;;
  status)
    echo "active=$(systemctl is-active "${UNIT}" 2>/dev/null || echo unknown)"
    echo "enabled=$(systemctl is-enabled "${UNIT}" 2>/dev/null || echo unknown)"
    ;;
  *)
    echo "usage: kiosk-ctl.sh start|stop|status" >&2
    exit 2
    ;;
esac
