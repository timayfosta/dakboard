#!/usr/bin/env bash
# Write family-board-api.service (shared by install-kiosk.sh and repair-kiosk.sh)
set -euo pipefail

TARGET_USER="${1:?usage: write-api-service.sh <user> <app_dir>}"
APP_DIR="${2:?}"

cat > /etc/systemd/system/family-board-api.service <<EOF
[Unit]
Description=Family Board local API server
After=network.target
Wants=network.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/python3 -u ${APP_DIR}/server.py
Restart=always
RestartSec=3
StartLimitIntervalSec=0
Environment=PYTHONUNBUFFERED=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
