#!/usr/bin/env bash
# Run the Cloudflare tunnel that matches the Zero Trust connector (token first).
set -euo pipefail

BIN=""
if command -v cloudflared >/dev/null 2>&1; then
  BIN="$(command -v cloudflared)"
elif [[ -x /usr/bin/cloudflared ]]; then
  BIN=/usr/bin/cloudflared
elif [[ -x /usr/local/bin/cloudflared ]]; then
  BIN=/usr/local/bin/cloudflared
else
  echo "cloudflared is not installed" >&2
  exit 1
fi

TOKEN=""
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  TOKEN="${TUNNEL_TOKEN}"
elif [[ -s /etc/cloudflared/env ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source /etc/cloudflared/env
  set +a
  TOKEN="${TUNNEL_TOKEN:-}"
fi
if [[ -z "${TOKEN}" && -s /etc/cloudflared/token ]]; then
  TOKEN="$(tr -d '\r\n' < /etc/cloudflared/token)"
fi

if [[ -n "${TOKEN}" ]]; then
  echo "Starting Cloudflare tunnel with Zero Trust token"
  exec "${BIN}" --no-autoupdate tunnel run --token "${TOKEN}"
fi

for cfg in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml \
  "${HOME}/.cloudflared/config.yml" "${HOME}/.cloudflared/config.yaml"; do
  if [[ -f "${cfg}" ]]; then
    echo "Starting Cloudflare tunnel with config ${cfg}"
    exec "${BIN}" --no-autoupdate tunnel --config "${cfg}" run
  fi
done

echo "No Cloudflare token or config found" >&2
exit 1
