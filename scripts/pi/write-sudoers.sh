#!/usr/bin/env bash
# Allow the kiosk user to enable/start boot services from admin deploy (no password).
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "write-sudoers.sh must run as root"
  exit 1
fi

TARGET_USER="${1:?usage: write-sudoers.sh <user> <app_dir>}"
APP_DIR="${2:?}"
WRAPPER=/usr/local/sbin/family-board-boot

cat > "${WRAPPER}" <<EOF
#!/bin/bash
exec /bin/bash ${APP_DIR}/scripts/pi/ensure-boot.sh
EOF
chmod 755 "${WRAPPER}"

cat > /etc/sudoers.d/family-board <<EOF
${TARGET_USER} ALL=(root) NOPASSWD: ${WRAPPER}
EOF
chmod 440 /etc/sudoers.d/family-board

if command -v visudo >/dev/null 2>&1; then
  visudo -cf /etc/sudoers.d/family-board >/dev/null
fi

echo "Sudoers: ${TARGET_USER} may run ${WRAPPER} without a password"
