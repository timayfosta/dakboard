#!/usr/bin/env bash
# Expose admin at /phone/ for Cloudflare quick tunnels (they often block /admin/*).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -d admin ]]; then
  echo "Missing admin/ in $ROOT"
  exit 1
fi

ln -sfn admin phone
echo "OK: $ROOT/phone -> admin"
echo "Test: curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/phone/"
