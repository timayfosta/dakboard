#!/usr/bin/env bash
# Rotate the Pi desktop to match Family Board's portrait (9:16) layout.
# FAMILY_BOARD_ROTATE: left | right | normal | inverted
#   left  = 90° counter-clockwise (most common for a TV turned clockwise physically)
#   right = 90° clockwise
set -euo pipefail

ROTATE="${FAMILY_BOARD_ROTATE:-left}"
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

wait_for_x() {
  local i
  for i in $(seq 1 40); do
    if command -v xrandr >/dev/null 2>&1 && xrandr --query >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

rotate_x11() {
  wait_for_x || return 1
  local out
  out="$(xrandr --query 2>/dev/null | awk '/ connected/{print $1; exit}')"
  if [[ -z "${out}" ]]; then
    echo "rotate-display: no connected X11 output found" >&2
    return 1
  fi
  echo "rotate-display: xrandr ${out} -> ${ROTATE}"
  xrandr --output "${out}" --rotate "${ROTATE}"
}

rotate_wayland() {
  if ! command -v wlr-randr >/dev/null 2>&1; then
    return 1
  fi
  local out transform
  out="$(wlr-randr 2>/dev/null | awk '/^[^[:space:]]/{print $1; exit}')"
  case "${ROTATE}" in
    left) transform="90" ;;
    right) transform="270" ;;
    inverted) transform="180" ;;
    normal) transform="normal" ;;
    *) transform="90" ;;
  esac
  if [[ -z "${out}" ]]; then
    echo "rotate-display: no Wayland output found" >&2
    return 1
  fi
  echo "rotate-display: wlr-randr ${out} -> ${transform}"
  wlr-randr --output "${out}" --transform "${transform}"
}

# Prefer whichever session is actually running
if [[ -n "${WAYLAND_DISPLAY:-}" ]] || [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
  rotate_wayland || rotate_x11 || true
else
  rotate_x11 || rotate_wayland || true
fi

exit 0
