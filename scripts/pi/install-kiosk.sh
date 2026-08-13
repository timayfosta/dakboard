#!/usr/bin/env bash
# Install Family Board as a Raspberry Pi kiosk (similar idea to DAKOS)
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/pi/install-kiosk.sh"
  exit 1
fi

TARGET_USER="${SUDO_USER:-pi}"
HOME_DIR="$(eval echo "~${TARGET_USER}")"
APP_DIR="${HOME_DIR}/family-board"
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "Installing Family Board kiosk for user ${TARGET_USER}"
echo "App dir: ${APP_DIR}"

apt-get update
apt-get install -y python3 chromium unclutter curl

mkdir -p "${APP_DIR}"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.wrangler' \
  "${SRC_DIR}/" "${APP_DIR}/"

# Keep local secrets if already present on the Pi
chown -R "${TARGET_USER}:${TARGET_USER}" "${APP_DIR}"
chmod +x "${APP_DIR}/scripts/pi/start-kiosk.sh"
chmod +x "${APP_DIR}/scripts/pi/wait-for-api.sh"
chmod +x "${APP_DIR}/scripts/pi/link-phone-admin.sh"
bash "${APP_DIR}/scripts/pi/link-phone-admin.sh"

# Patch service user/paths if not "pi"
sed "s|/home/pi|${HOME_DIR}|g; s|User=pi|User=${TARGET_USER}|g" \
  "${APP_DIR}/scripts/pi/family-board-api.service" > /etc/systemd/system/family-board-api.service
sed "s|/home/pi|${HOME_DIR}|g; s|User=pi|User=${TARGET_USER}|g" \
  "${APP_DIR}/scripts/pi/family-board-kiosk.service" > /etc/systemd/system/family-board-kiosk.service

# Autohide mouse
mkdir -p "${HOME_DIR}/.config/autostart"
cat > "${HOME_DIR}/.config/autostart/unclutter.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Unclutter
Exec=unclutter -idle 0.5 -root
X-GNOME-Autostart-enabled=true
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${HOME_DIR}/.config"

systemctl daemon-reload
systemctl enable family-board-api.service
systemctl enable family-board-kiosk.service
systemctl restart family-board-api.service

# Wait for API before starting kiosk (avoids blank screen on first boot)
if bash "${APP_DIR}/scripts/pi/wait-for-api.sh" 30; then
  systemctl restart family-board-kiosk.service || true
else
  echo "Warning: API slow to start — kiosk will retry when desktop loads"
fi

echo ""
echo "Installed. Both services are enabled and will start on boot."
echo "  API (boot):   systemctl status family-board-api"
echo "  Kiosk (GUI):  systemctl status family-board-kiosk"
echo ""
echo "Remember to copy shared/secrets.local.js onto the Pi (gitignored)."
