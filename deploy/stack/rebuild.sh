#!/usr/bin/env bash
set -euo pipefail

# Unified stack rebuild:
# equivalent to down + up for app + LiveKit.
#
# Usage:
#   sudo bash deploy/stack/rebuild.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "$ROOT_DIR/deploy/stack/down.sh"
bash "$ROOT_DIR/deploy/stack/up.sh"
