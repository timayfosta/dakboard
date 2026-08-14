#!/usr/bin/env bash
# Fix systemd paths + autostart after git reset, clone move, or deploy gone wrong.
# Does not reinstall apt packages — use install-kiosk.sh for a full setup.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/pi/repair-kiosk.sh"
  exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
HOME_DIR="$(eval echo "~${TARGET_USER}")"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ ! -f "${APP_DIR}/server.py" || ! -d "${APP_DIR}/shared" ]]; then
  echo "ERROR: ${APP_DIR} does not look like a Family Board checkout."
  exit 1
fi

echo "Repairing Family Board kiosk for user ${TARGET_USER}"
echo "App dir: ${APP_DIR}"

chmod +x "${APP_DIR}/scripts/pi/"*.sh "${APP_DIR}/scripts/git_sync.sh" 2>/dev/null || true
bash "${APP_DIR}/scripts/pi/link-phone-admin.sh" 2>/dev/null || true

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

bash "${APP_DIR}/scripts/pi/write-kiosk-service.sh" "${TARGET_USER}" "${APP_DIR}" "${HOME_DIR}"

mkdir -p "${HOME_DIR}/.config/autostart"
cat > "${HOME_DIR}/.config/autostart/family-board-rotate.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board Portrait Rotate
Exec=${APP_DIR}/scripts/pi/rotate-display.sh
X-GNOME-Autostart-enabled=true
EOF
cat > "${HOME_DIR}/.config/autostart/family-board-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board Kiosk
Exec=bash -lc 'sleep 8; exec ${APP_DIR}/scripts/pi/ensure-kiosk.sh'
X-GNOME-Autostart-enabled=true
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${HOME_DIR}/.config/autostart"

systemctl daemon-reload
systemctl enable family-board-api.service
systemctl enable family-board-kiosk.service
systemctl restart family-board-api.service

if bash "${APP_DIR}/scripts/pi/wait-for-api.sh" 60; then
  systemctl restart family-board-kiosk.service || true
else
  echo "Warning: API slow to start — kiosk will retry when desktop loads"
fi

echo ""
echo "Repair complete."
echo "  API:   $(systemctl is-enabled family-board-api) / $(systemctl is-active family-board-api)"
echo "  Kiosk: $(systemctl is-enabled family-board-kiosk) / $(systemctl is-active family-board-kiosk || echo inactive-until-desktop)"
echo "  Path:  ${APP_DIR}"
echo ""
echo "If kiosk still does not start on boot, enable desktop auto-login:"
echo "  sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
echo ""
echo "Then: sudo reboot"
