#!/usr/bin/env bash
# Write family-board-kiosk.service (shared by install-kiosk.sh and repair-kiosk.sh)
set -euo pipefail

TARGET_USER="${1:?usage: write-kiosk-service.sh <user> <app_dir> <home_dir>}"
APP_DIR="${2:?}"
HOME_DIR="${3:?}"

cat > /etc/systemd/system/family-board-kiosk.service <<EOF
[Unit]
Description=Family Board Chromium kiosk
After=network-online.target family-board-api.service graphical.target
Wants=family-board-api.service network-online.target graphical.target

[Service]
Type=simple
User=${TARGET_USER}
Environment=DISPLAY=:0
Environment=XAUTHORITY=${HOME_DIR}/.Xauthority
Environment=FAMILY_BOARD_SKIP_SERVER=1
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/scripts/pi/start-kiosk.sh
Restart=on-failure
RestartSec=12
StartLimitIntervalSec=0
TimeoutStartSec=300

[Install]
WantedBy=graphical.target
EOF
