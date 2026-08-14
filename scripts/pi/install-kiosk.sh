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
chmod +x "${APP_DIR}/scripts/pi/"*.sh "${APP_DIR}/scripts/git_sync.sh" 2>/dev/null || true
bash "${APP_DIR}/scripts/pi/link-phone-admin.sh"

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
cat > "${HOME_DIR}/.config/autostart/unclutter.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Unclutter
Exec=unclutter -idle 0.5 -root
X-GNOME-Autostart-enabled=true
EOF
cat > "${HOME_DIR}/.config/autostart/family-board-rotate.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board Portrait Rotate
Exec=${APP_DIR}/scripts/pi/rotate-display.sh
X-GNOME-Autostart-enabled=true
EOF
chown -R "${TARGET_USER}:${TARGET_USER}" "${HOME_DIR}/.config"

systemctl daemon-reload
systemctl enable family-board-api.service
systemctl enable family-board-kiosk.service
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
echo ""
echo "REQUIRED for kiosk on boot: Desktop auto-login"
echo "  sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
echo ""
echo "Portrait TV rotation: edit ${APP_DIR}/scripts/pi/kiosk.env"
echo "  FAMILY_BOARD_ROTATE=left   (or right / normal)"
echo ""
echo "Then reboot:  sudo reboot"
echo ""
echo "If secrets are missing, copy shared/secrets.local.js into ${APP_DIR}/shared/"
