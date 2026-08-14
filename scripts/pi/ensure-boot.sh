#!/usr/bin/env bash
# Enable Family Board API + kiosk + Cloudflare tunnel to start on every boot,
# then start them now. Safe to run from admin deploy (uses sudo -n).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  if [[ -x /usr/local/sbin/family-board-boot ]]; then
    exec sudo -n /usr/local/sbin/family-board-boot
  fi
  exec sudo -n /bin/bash "$0" "$@"
fi

TARGET_USER="${SUDO_USER:-}"
if [[ -z "${TARGET_USER}" || "${TARGET_USER}" == "root" ]]; then
  TARGET_USER="$(grep -m1 '^User=' /etc/systemd/system/family-board-api.service 2>/dev/null | cut -d= -f2- || true)"
fi
TARGET_USER="${TARGET_USER:-pi}"
HOME_DIR="$(eval echo "~${TARGET_USER}")"

echo "=== Family Board boot enable ==="
echo "App:  ${ROOT}"
echo "User: ${TARGET_USER}"

chmod +x "${ROOT}/scripts/pi/"*.sh "${ROOT}/scripts/git_sync.sh" 2>/dev/null || true

if [[ -x "${ROOT}/scripts/pi/write-api-service.sh" ]]; then
  bash "${ROOT}/scripts/pi/write-api-service.sh" "${TARGET_USER}" "${ROOT}"
fi
if [[ -x "${ROOT}/scripts/pi/write-kiosk-service.sh" ]]; then
  bash "${ROOT}/scripts/pi/write-kiosk-service.sh" "${TARGET_USER}" "${ROOT}" "${HOME_DIR}"
fi
if [[ -x "${ROOT}/scripts/pi/write-sudoers.sh" ]]; then
  bash "${ROOT}/scripts/pi/write-sudoers.sh" "${TARGET_USER}" "${ROOT}"
fi

write_tunnel_unit() {
  local cf_bin=""
  if command -v cloudflared >/dev/null 2>&1; then
    cf_bin="$(command -v cloudflared)"
  elif [[ -x /usr/bin/cloudflared ]]; then
    cf_bin=/usr/bin/cloudflared
  elif [[ -x /usr/local/bin/cloudflared ]]; then
    cf_bin=/usr/local/bin/cloudflared
  else
    echo "cloudflared is not installed — skip tunnel unit"
    return 1
  fi

  local config=""
  for candidate in \
    "${HOME_DIR}/.cloudflared/config.yml" \
    "${HOME_DIR}/.cloudflared/config.yaml" \
    /etc/cloudflared/config.yml \
    /etc/cloudflared/config.yaml
  do
    if [[ -f "${candidate}" ]]; then
      config="${candidate}"
      break
    fi
  done

  local token_file=""
  for candidate in /etc/cloudflared/token "${HOME_DIR}/.cloudflared/token"; do
    if [[ -s "${candidate}" ]]; then
      token_file="${candidate}"
      break
    fi
  done

  if [[ -n "${config}" ]]; then
    cat > /etc/systemd/system/family-board-tunnel.service <<EOF
[Unit]
Description=Family Board Cloudflare tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
ExecStart=${cf_bin} --no-autoupdate tunnel --config ${config} run
Restart=always
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
    echo "Wrote family-board-tunnel.service (config file)"
    return 0
  fi

  if [[ -n "${token_file}" ]]; then
    mkdir -p /etc/cloudflared
    umask 077
    {
      printf "TUNNEL_TOKEN="
      tr -d "\r\n" < "${token_file}"
      printf "\n"
    } >/etc/cloudflared/env
    chmod 600 /etc/cloudflared/env
    cat > /etc/systemd/system/family-board-tunnel.service <<EOF
[Unit]
Description=Family Board Cloudflare tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/cloudflared/env
ExecStart=${cf_bin} --no-autoupdate tunnel run
Restart=always
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
    echo "Wrote family-board-tunnel.service (token)"
    return 0
  fi

  echo "No Cloudflare config/token found — cannot create tunnel unit"
  return 1
}

enable_now() {
  local unit="$1"
  if ! systemctl list-unit-files "${unit}" >/dev/null 2>&1; then
    return 1
  fi
  systemctl enable "${unit}" >/dev/null 2>&1 || true
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
  systemctl restart "${unit}" >/dev/null 2>&1 || systemctl start "${unit}" >/dev/null 2>&1 || true
  echo "  ${unit}: $(systemctl is-enabled "${unit}" 2>/dev/null || echo disabled) / $(systemctl is-active "${unit}" 2>/dev/null || echo inactive)"
  return 0
}

systemctl daemon-reload

enable_now family-board-api.service || true
enable_now family-board-kiosk.service || true

if [[ -f /etc/systemd/system/cloudflared.service || -f /lib/systemd/system/cloudflared.service ]]; then
  enable_now cloudflared.service || true
elif write_tunnel_unit; then
  systemctl daemon-reload
  enable_now family-board-tunnel.service || true
else
  echo "  tunnel: not installed (1033 will continue until cloudflared is set up once)"
fi

echo "Boot enable done."
