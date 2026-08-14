#!/usr/bin/env bash
# Re-enable Family Board API + kiosk + portrait rotate without a full reinstall
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with: sudo bash scripts/pi/repair-kiosk.sh"
  exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
HOME_DIR="$(eval echo "~${TARGET_USER}")"
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="${FAMILY_BOARD_APP_DIR:-$SRC_DIR}"

if [[ ! -f "${APP_DIR}/server.py" ]]; then
  echo "ERROR: server.py not found in ${APP_DIR}"
  exit 1
fi

chmod +x "${APP_DIR}/scripts/pi/"*.sh || true
bash "${APP_DIR}/scripts/pi/link-phone-admin.sh" || true

cat > /etc/systemd/system/family-board-api.service <<EOF
[Unit]
Description=Family Board local API server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/python3 ${APP_DIR}/server.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/family-board-kiosk.service <<EOF
[Unit]
Description=Family Board Chromium kiosk
After=network-online.target family-board-api.service graphical.target
Requires=family-board-api.service
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${HOME_DIR}/.Xauthority
Environment=FAMILY_BOARD_SKIP_SERVER=1
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/scripts/pi/start-kiosk.sh
Restart=on-failure
RestartSec=8

[Install]
WantedBy=graphical.target
EOF

mkdir -p "${HOME_DIR}/.config/autostart"
cat > "${HOME_DIR}/.config/autostart/family-board-rotate.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board Portrait Rotate
Exec=${APP_DIR}/scripts/pi/rotate-display.sh
X-GNOME-Autostart-enabled=true
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${HOME_DIR}/.config"

systemctl daemon-reload
systemctl enable family-board-api.service family-board-kiosk.service
systemctl restart family-board-api.service
sleep 1
systemctl restart family-board-kiosk.service || true

echo ""
echo "Repaired."
echo "  API:   $(systemctl is-enabled family-board-api) / $(systemctl is-active family-board-api)"
echo "  Kiosk: $(systemctl is-enabled family-board-kiosk) / $(systemctl is-active family-board-kiosk || echo inactive-until-desktop)"
echo "  App:   ${APP_DIR}"
echo ""
echo "If kiosk still does not start on boot:"
echo "  sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
echo "  sudo reboot"
echo ""
echo "If rotation is wrong, edit: ${APP_DIR}/scripts/pi/kiosk.env"
echo "  FAMILY_BOARD_ROTATE=left   (or right / normal)"
