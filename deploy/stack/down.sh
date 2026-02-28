#!/usr/bin/env bash
set -euo pipefail

# Unified stack down:
# - App
# - LiveKit
#
# Usage:
#   sudo bash deploy/stack/down.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found."
  exit 1
fi

echo "[stack-down] Stopping app + LiveKit..."
cd "$ROOT_DIR"
docker compose down

echo "[stack-down] Done."
