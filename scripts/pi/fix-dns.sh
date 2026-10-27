#!/usr/bin/env bash
# Repair DNS when the Pi can reach the LAN but cannot resolve github.com (breaks git fetch).
# Safe to run repeatedly. Prefer calling via ensure-boot (already root) or:
#   sudo bash scripts/pi/fix-dns.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${ROOT}/data/dns-fix.log"
mkdir -p "${ROOT}/data" || true

log() {
  echo "$1"
  echo "$1" >>"${LOG}" 2>/dev/null || true
}

log ""
log "=== Family Board DNS fix $(date -Is 2>/dev/null || date) ==="

resolve_ok() {
  getent hosts github.com >/dev/null 2>&1
}

pin_hosts() {
  local ip="$1"
  [[ -n "${ip}" ]] || return 1
  log "Pinning github.com -> ${ip} in /etc/hosts"
  local tmp
  tmp="$(mktemp)" || return 1
  if [[ -f /etc/hosts ]]; then
    grep -vE '[[:space:]]github\.com([[:space:]]|$)' /etc/hosts >"${tmp}" || true
  fi
  printf '%s github.com\n' "${ip}" >>"${tmp}"
  mv "${tmp}" /etc/hosts || return 1
}

if resolve_ok; then
  log "github.com already resolves: $(getent hosts github.com | awk '{print $1, $2; exit}')"
  exit 0
fi

log "github.com does not resolve — applying public DNS (1.1.1.1 / 8.8.8.8)"

if command -v nmcli >/dev/null 2>&1; then
  CON="$(
    nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active 2>/dev/null \
      | awk -F: '$4 == "activated" && ($2 ~ /wireless|ethernet|wifi|802-11|802-3/) { print $1; exit }'
  )"
  if [[ -z "${CON}" ]]; then
    CON="$(nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2 ~ /wireless|wifi|802-11/ { print $1; exit }')"
  fi
  if [[ -n "${CON}" ]]; then
    log "NetworkManager connection: ${CON}"
    nmcli connection modify "${CON}" ipv4.ignore-auto-dns yes || true
    nmcli connection modify "${CON}" ipv4.dns "1.1.1.1 8.8.8.8" || true
    nmcli connection modify "${CON}" ipv6.ignore-auto-dns yes || true
    nmcli connection modify "${CON}" ipv6.dns "2606:4700:4700::1111 2001:4860:4860::8888" || true
    nmcli connection up "${CON}" >/dev/null 2>&1 || true
  else
    log "No NetworkManager Wi‑Fi/Ethernet connection found"
  fi
fi

if command -v resolvectl >/dev/null 2>&1; then
  IFACE="$(ip route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") { print $(i+1); exit }}')"
  if [[ -n "${IFACE}" ]]; then
    log "resolvectl interface: ${IFACE}"
    resolvectl dns "${IFACE}" 1.1.1.1 8.8.8.8 >/dev/null 2>&1 || true
    resolvectl domain "${IFACE}" '~.' >/dev/null 2>&1 || true
  fi
  resolvectl flush-caches >/dev/null 2>&1 || true
fi

if [[ -f /etc/resolv.conf && ! -L /etc/resolv.conf ]]; then
  if ! grep -qE 'nameserver[[:space:]]+(1\.1\.1\.1|8\.8\.8\.8)' /etc/resolv.conf; then
    log "Updating /etc/resolv.conf"
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >/etc/resolv.conf || true
  fi
elif [[ -L /etc/resolv.conf ]]; then
  log "/etc/resolv.conf is a symlink (systemd-resolved); left unchanged"
fi

sleep 1
if resolve_ok; then
  log "OK after DNS change: $(getent hosts github.com | awk '{print $1, $2; exit}')"
  exit 0
fi

if command -v python3 >/dev/null 2>&1; then
  IP="$(
    python3 - <<'PY'
import json, urllib.request
req = urllib.request.Request(
    "https://1.1.1.1/dns-query?name=github.com&type=A",
    headers={"Accept": "application/dns-json"},
)
try:
    data = json.load(urllib.request.urlopen(req, timeout=8))
except Exception:
    raise SystemExit(0)
for ans in data.get("Answer") or []:
    if ans.get("type") == 1 and ans.get("data"):
        print(ans["data"])
        break
PY
  )"
  if [[ -n "${IP}" ]]; then
    pin_hosts "${IP}" || true
  else
    log "DoH lookup for github.com returned no A record"
  fi
fi

sleep 1
if resolve_ok; then
  log "OK after DoH pin: $(getent hosts github.com | awk '{print $1, $2; exit}')"
  exit 0
fi

log "DoH/DNS still failed — pinning known GitHub IPs"
for IP in 140.82.112.4 140.82.113.4 140.82.114.4 140.82.116.4; do
  pin_hosts "${IP}" || true
  sleep 0.2
  if resolve_ok; then
    log "OK after hardcoded pin: $(getent hosts github.com | awk '{print $1, $2; exit}')"
    exit 0
  fi
done

log "DNS still cannot resolve github.com"
ping -c 1 -W 3 1.1.1.1 >/dev/null 2>&1 && log "  1.1.1.1 reachable" || log "  1.1.1.1 NOT reachable"
ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1 && log "  8.8.8.8 reachable" || log "  8.8.8.8 NOT reachable"
log "On the Pi desktop: Settings → Network → Wi‑Fi → IPv4 → DNS 1.1.1.1 and 8.8.8.8"
exit 1
