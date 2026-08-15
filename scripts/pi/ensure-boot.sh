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

cf_bin() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
  elif [[ -x /usr/bin/cloudflared ]]; then
    echo /usr/bin/cloudflared
  elif [[ -x /usr/local/bin/cloudflared ]]; then
    echo /usr/local/bin/cloudflared
  else
    return 1
  fi
}

unit_ok() {
  local file="$1"
  [[ -f "${file}" ]] || return 1
  systemd-analyze verify "${file}" >/dev/null 2>&1
}

extract_token() {
  local file="$1"
  local raw=""
  [[ -f "${file}" ]] || return 1
  raw="$(grep -oE -- '--token[= ][^[:space:]'\''\"]+' "${file}" 2>/dev/null | tail -1 | sed -E 's/--token[= ]//' || true)"
  if [[ -z "${raw}" ]]; then
    raw="$(grep -oE -- "TUNNEL_TOKEN=['\"]?[^[:space:]'\"]+" "${file}" 2>/dev/null | tail -1 | sed -E 's/TUNNEL_TOKEN=//' | tr -d "'\"" || true)"
  fi
  raw="$(printf '%s' "${raw}" | tr -d '\r\n')"
  [[ -n "${raw}" ]] || return 1
  printf '%s' "${raw}"
}

write_clean_tunnel() {
  local bin="$1"
  local config=""
  local token=""
  local src

  for src in \
    "${HOME_DIR}/.cloudflared/config.yml" \
    "${HOME_DIR}/.cloudflared/config.yaml" \
    /etc/cloudflared/config.yml \
    /etc/cloudflared/config.yaml
  do
    if [[ -f "${src}" ]]; then
      config="${src}"
      break
    fi
  done

  for src in /etc/cloudflared/token "${HOME_DIR}/.cloudflared/token"; do
    if [[ -s "${src}" ]]; then
      token="$(tr -d '\r\n' < "${src}")"
      break
    fi
  done

  if [[ -z "${token}" ]]; then
    token="$(extract_token /etc/systemd/system/cloudflared.service || true)"
  fi
  if [[ -z "${token}" ]]; then
    token="$(extract_token /etc/systemd/system/cloudflared.service.bad || true)"
  fi
  if [[ -z "${token}" ]]; then
    token="$(extract_token /etc/cloudflared/env || true)"
  fi
  if [[ -z "${token}" ]]; then
    token="$(extract_token /etc/default/cloudflared || true)"
  fi
  if [[ -z "${token}" ]]; then
    token="$(extract_token /lib/systemd/system/cloudflared.service || true)"
  fi

  mkdir -p /etc/cloudflared

  if [[ -n "${config}" ]]; then
    cat > /etc/systemd/system/family-board-tunnel.service <<EOF
[Unit]
Description=Family Board Cloudflare tunnel
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${TARGET_USER}
ExecStart=${bin} --no-autoupdate tunnel --config ${config} run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  elif [[ -n "${token}" ]]; then
    umask 077
    printf 'TUNNEL_TOKEN=%s\n' "${token}" >/etc/cloudflared/env
    chmod 600 /etc/cloudflared/env
    cat > /etc/systemd/system/family-board-tunnel.service <<EOF
[Unit]
Description=Family Board Cloudflare tunnel
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=/etc/cloudflared/env
ExecStart=${bin} --no-autoupdate tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  else
    echo "No Cloudflare config/token found — cannot create tunnel unit"
    return 1
  fi

  sed -i 's/\r$//' /etc/systemd/system/family-board-tunnel.service
  echo "Wrote clean family-board-tunnel.service"
  return 0
}

retire_broken_cloudflared() {
  local src=""
  if [[ -f /etc/systemd/system/cloudflared.service ]]; then
    src=/etc/systemd/system/cloudflared.service
  elif [[ -f /lib/systemd/system/cloudflared.service ]]; then
    src=/lib/systemd/system/cloudflared.service
  else
    return 1
  fi

  if unit_ok "${src}"; then
    return 1
  fi

  echo "Official cloudflared.service has a bad unit file — replacing it"
  systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
  if [[ "${src}" == /etc/systemd/system/cloudflared.service ]]; then
    mv -f "${src}" /etc/systemd/system/cloudflared.service.bad
  fi
  return 0
}

enable_now() {
  local unit="$1"
  if ! systemctl cat "${unit}" >/dev/null 2>&1; then
    echo "  ${unit}: not installed (skip)"
    return 1
  fi
  systemctl enable "${unit}" >/dev/null 2>&1 || true
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
  systemctl restart "${unit}" >/dev/null 2>&1 || systemctl start "${unit}" >/dev/null 2>&1 || true
  echo "  ${unit}: $(systemctl is-enabled "${unit}" 2>/dev/null || echo disabled) / $(systemctl is-active "${unit}" 2>/dev/null || echo inactive)"
}

systemctl daemon-reload

enable_now family-board-api.service
enable_now family-board-kiosk.service

BIN="$(cf_bin || true)"
if [[ -z "${BIN}" ]]; then
  echo "  tunnel: cloudflared is not installed"
else
  official=""
  if [[ -f /etc/systemd/system/cloudflared.service ]]; then
    official=/etc/systemd/system/cloudflared.service
  elif [[ -f /lib/systemd/system/cloudflared.service ]]; then
    official=/lib/systemd/system/cloudflared.service
  fi

  if [[ -n "${official}" ]] && unit_ok "${official}"; then
    enable_now cloudflared.service
    if ! systemctl is-active --quiet cloudflared.service; then
      echo "cloudflared.service did not stay running — using clean Family Board tunnel unit"
      write_clean_tunnel "${BIN}" || true
      systemctl daemon-reload
      enable_now family-board-tunnel.service
    fi
  else
    retire_broken_cloudflared || true
    if write_clean_tunnel "${BIN}"; then
      systemctl daemon-reload
      enable_now family-board-tunnel.service
    else
      echo "  tunnel: not configured (1033 will continue until a token/config exists)"
    fi
  fi
fi

echo "Boot enable done."
