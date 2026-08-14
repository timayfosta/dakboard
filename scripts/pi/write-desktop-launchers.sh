#!/usr/bin/env bash
# Desktop autostart + "Start Family Board" shortcut (install / repair).
set -euo pipefail

TARGET_USER="${1:?usage: write-desktop-launchers.sh <user> <app_dir> <home_dir>}"
APP_DIR="${2:?}"
HOME_DIR="${3:?}"

mkdir -p "${HOME_DIR}/.config/autostart" "${HOME_DIR}/Desktop"

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
Exec=bash -lc '${APP_DIR}/scripts/pi/rotate-display.sh; sleep 10; ${APP_DIR}/scripts/pi/rotate-display.sh'
X-GNOME-Autostart-enabled=true
EOF

# Fallback if systemd kiosk unit misses the desktop session
cat > "${HOME_DIR}/.config/autostart/family-board-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board Kiosk
Exec=bash -lc 'sleep 12; exec ${APP_DIR}/scripts/pi/ensure-kiosk.sh'
X-GNOME-Autostart-enabled=true
EOF

# Fallback if systemd API unit is missing or failed at boot
cat > "${HOME_DIR}/.config/autostart/family-board-api.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Family Board API
Exec=bash -lc 'curl -fsS --max-time 2 http://127.0.0.1:8765/api/health >/dev/null 2>&1 || python3 -u ${APP_DIR}/server.py'
X-GNOME-Autostart-enabled=true
EOF

cat > "${HOME_DIR}/Desktop/Start-Family-Board.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Start Family Board
Comment=Start the Family Board server and TV kiosk
Exec=bash -lc '${APP_DIR}/scripts/pi/start-now.sh; read -r -p "Press Enter to close…"'
Icon=display
Terminal=true
Categories=Utility;
StartupNotify=true
EOF
chmod +x "${HOME_DIR}/Desktop/Start-Family-Board.desktop"

chown -R "${TARGET_USER}:${TARGET_USER}" "${HOME_DIR}/.config/autostart" "${HOME_DIR}/Desktop/Start-Family-Board.desktop" 2>/dev/null || true
# Mark trusted on Raspberry Pi OS / GNOME so double-click works
if command -v gio >/dev/null 2>&1; then
  sudo -u "${TARGET_USER}" gio set "${HOME_DIR}/Desktop/Start-Family-Board.desktop" metadata::trusted true 2>/dev/null || true
fi
