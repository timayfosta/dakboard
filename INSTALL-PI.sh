#!/usr/bin/env bash
# One-command Raspberry Pi install (API + kiosk on boot + desktop Start button).
#
#   cd ~/family-board-src
#   sudo bash INSTALL-PI.sh
#
# After install, reboot once. If it does not come up:
#   bash scripts/pi/start-now.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
exec bash "$ROOT/scripts/pi/install-kiosk.sh"
