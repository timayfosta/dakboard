#!/usr/bin/env bash
# Write family-board-kiosk.service (shared by install-kiosk.sh and repair-kiosk.sh)
set -euo pipefail

TARGET_USER="${1:?usage: write-kiosk-service.sh <user> <app_dir> <home_dir>}"
APP_DIR="${2:?}"
HOME_DIR="${3:?}"
USER_ID="$(id -u "${TARGET_USER}" 2>/dev/null || echo 1000)"

cat > /etc/systemd/system/family-board-kiosk.service <<EOF
[Unit]
Description=Family Board Chromium kiosk
After=family-board-api.service graphical.target
Wants=family-board-api.service graphical.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${HOME_DIR}/.Xauthority
Environment=XDG_RUNTIME_DIR=/run/user/${USER_ID}
Environment=FAMILY_BOARD_SKIP_SERVER=1
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/scripts/pi/start-kiosk.sh
KillMode=control-group
TimeoutStopSec=10
Restart=always
RestartSec=5
TimeoutStartSec=300

[Install]
WantedBy=graphical.target
EOF
sed -i 's/\r$//' /etc/systemd/system/family-board-kiosk.service
