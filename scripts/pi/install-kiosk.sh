#!/usr/bin/env bash
# Install Family Board as a Raspberry Pi kiosk (API + Chromium on boot)
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/pi/install-kiosk.sh"
  exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
HOME_DIR="$(eval echo "~${TARGET_USER}")"
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Prefer installing in-place (keeps git). Override with:
#   FAMILY_BOARD_APP_DIR=/home/you/family-board sudo -E bash scripts/pi/install-kiosk.sh
# Or force a copy into ~/family-board:
#   FAMILY_BOARD_COPY=1 sudo -E bash scripts/pi/install-kiosk.sh
if [[ -n "${FAMILY_BOARD_APP_DIR:-}" ]]; then
  APP_DIR="${FAMILY_BOARD_APP_DIR}"
elif [[ "${FAMILY_BOARD_COPY:-0}" == "1" ]]; then
  APP_DIR="${HOME_DIR}/family-board"
else
  APP_DIR="${SRC_DIR}"
fi

echo "Installing Family Board kiosk for user ${TARGET_USER}"
echo "Source:  ${SRC_DIR}"
echo "App dir: ${APP_DIR}"

if [[ ! -f "${SRC_DIR}/server.py" || ! -d "${SRC_DIR}/shared" ]]; then
  echo "ERROR: ${SRC_DIR} does not look like a Family Board checkout (need server.py + shared/)."
  exit 1
fi

apt-get update
apt-get install -y python3 chromium unclutter curl psmisc
# Optional Wayland rotate helper (Bookworm); ignore if package missing
apt-get install -y wlr-randr 2>/dev/null || true

if [[ "${APP_DIR}" != "${SRC_DIR}" ]]; then
  echo "Copying files to ${APP_DIR}…"
  mkdir -p "${APP_DIR}"
  rsync -a \
    --exclude 'node_modules' \
    --exclude '.wrangler' \
    --exclude 'data/family.json' \
    --exclude 'data/photos' \
    --exclude 'shared/secrets.local.js' \
    --exclude 'scripts/pi/kiosk.env' \
    "${SRC_DIR}/" "${APP_DIR}/"
fi

mkdir -p "${APP_DIR}/data/photos"
if [[ ! -f "${APP_DIR}/scripts/pi/kiosk.env" ]]; then
  cp "${SRC_DIR}/scripts/pi/kiosk.env" "${APP_DIR}/scripts/pi/kiosk.env" 2>/dev/null || true
fi
chown -R "${TARGET_USER}:${TARGET_USER}" "${APP_DIR}"
chmod +x "${APP_DIR}/scripts/pi/"*.sh "${APP_DIR}/scripts/git_sync.sh" "${APP_DIR}/INSTALL-PI.sh" 2>/dev/null || true
bash "${APP_DIR}/scripts/pi/link-phone-admin.sh"

bash "${APP_DIR}/scripts/pi/write-api-service.sh" "${TARGET_USER}" "${APP_DIR}"
bash "${APP_DIR}/scripts/pi/write-kiosk-service.sh" "${TARGET_USER}" "${APP_DIR}" "${HOME_DIR}"
bash "${APP_DIR}/scripts/pi/write-desktop-launchers.sh" "${TARGET_USER}" "${APP_DIR}" "${HOME_DIR}"

systemctl daemon-reload
systemctl enable family-board-api.service
systemctl enable family-board-kiosk.service
systemctl reset-failed family-board-kiosk.service 2>/dev/null || true
systemctl restart family-board-api.service

if bash "${APP_DIR}/scripts/pi/wait-for-api.sh" 30; then
  systemctl restart family-board-kiosk.service || true
else
  echo "Warning: API slow to start — kiosk will retry when desktop loads"
fi

echo ""
echo "Installed. Both services are enabled and will start on boot."
echo "  API unit:   $(systemctl is-enabled family-board-api) / $(systemctl is-active family-board-api)"
echo "  Kiosk unit: $(systemctl is-enabled family-board-kiosk) / $(systemctl is-active family-board-kiosk || echo inactive-until-desktop)"
echo "  App path:   ${APP_DIR}"
echo "  Desktop:    ${HOME_DIR}/Desktop/Start-Family-Board.desktop"
echo ""
echo "If it does not auto-start after reboot, double-click Start Family Board"
echo "or run:  bash ${APP_DIR}/scripts/pi/start-now.sh"
echo ""
echo "REQUIRED for kiosk on boot: Desktop auto-login"
echo "  sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
echo ""
echo "Then reboot:  sudo reboot"
