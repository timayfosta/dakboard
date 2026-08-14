#!/usr/bin/env bash
# Wait until the Pi desktop session is usable (X11 or Wayland).
set -euo pipefail

MAX="${FAMILY_BOARD_DISPLAY_WAIT:-120}"
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

for i in $(seq 1 "$MAX"); do
  if [[ -n "${WAYLAND_DISPLAY:-}" ]] || [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    if command -v wlr-randr >/dev/null 2>&1 && wlr-randr 2>/dev/null | grep -q .; then
      echo "wait-for-display: Wayland ready (${WAYLAND_DISPLAY:-unknown})"
      exit 0
    fi
  fi

  if [[ -f "${XAUTHORITY}" ]] && command -v xset >/dev/null 2>&1 && xset q >/dev/null 2>&1; then
    echo "wait-for-display: X11 ready (${DISPLAY})"
    exit 0
  fi

  if [[ $((i % 10)) -eq 0 ]]; then
    echo "wait-for-display: still waiting (${i}/${MAX}s)…" >&2
  fi
  sleep 1
done

echo "wait-for-display: no display after ${MAX}s (DISPLAY=${DISPLAY}, XAUTHORITY=${XAUTHORITY})" >&2
exit 1
