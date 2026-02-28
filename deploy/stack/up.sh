#!/usr/bin/env bash
set -euo pipefail

# Unified stack up (same docker-compose):
# - App
# - LiveKit
#
# Usage:
#   sudo bash deploy/stack/up.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DOMAIN="${APP_DOMAIN:-english4sp.stinis.ddns.net}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found."
  exit 1
fi

echo "[stack-up] Building and starting app + LiveKit..."
cd "$ROOT_DIR"
docker compose up -d --build

echo
echo "[stack-up] Done."
echo "App expected at:   https://${APP_DOMAIN}"
echo "LiveKit WS:        wss://${APP_DOMAIN}/livekit"
echo "NOTE: Make sure Nginx + TLS are configured once."
