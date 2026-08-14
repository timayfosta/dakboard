#!/usr/bin/env bash
# Same as INSTALL-PI.sh — run with sudo from the repo.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")/../.." && pwd)/INSTALL-PI.sh"
