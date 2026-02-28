#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   sudo JITSI_DOMAIN=meet.example.com SERVER_IP=1.2.3.4 bash deploy/jitsi/bootstrap.sh
#
# Notes:
# - Runs Jitsi on the same host with Docker.
# - Exposes Jitsi web on localhost:8000 (for reverse proxy) and media on UDP 10000.
# - TLS is expected to be terminated by Nginx/Caddy on the host.

JITSI_DOMAIN="${JITSI_DOMAIN:-meet.example.com}"
SERVER_IP="${SERVER_IP:-}"
JITSI_DIR="${JITSI_DIR:-/opt/jitsi-docker}"

if [[ -z "$SERVER_IP" ]]; then
  echo "ERROR: SERVER_IP is required (public IPv4 used by Jitsi Videobridge)."
  echo "Example: sudo JITSI_DOMAIN=meet.example.com SERVER_IP=203.0.113.10 bash deploy/jitsi/bootstrap.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin not found."
  exit 1
fi

if [[ ! -d "$JITSI_DIR/.git" ]]; then
  echo "Cloning official docker-jitsi-meet to $JITSI_DIR ..."
  git clone https://github.com/jitsi/docker-jitsi-meet "$JITSI_DIR"
fi

cd "$JITSI_DIR"

if [[ ! -f ".env" ]]; then
  cp env.example .env
fi

# Generate random internal passwords once.
if ! grep -q '^JICOFO_COMPONENT_SECRET=.*[^[:space:]]' .env || grep -q '^JICOFO_COMPONENT_SECRET=$' .env; then
  ./gen-passwords.sh
fi

set_kv() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s#^${key}=.*#${key}=${value}#g" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

set_kv PUBLIC_URL "https://${JITSI_DOMAIN}"
set_kv ENABLE_LETSENCRYPT "0"
set_kv ENABLE_HTTP_REDIRECT "0"
set_kv DISABLE_HTTPS "1"
set_kv HTTP_PORT "8000"
set_kv HTTPS_PORT "8443"
set_kv TZ "Europe/Athens"
set_kv ENABLE_AUTH "0"
set_kv ENABLE_GUESTS "1"
set_kv JVB_ADVERTISE_IPS "${SERVER_IP}"
set_kv JVB_PORT "10000"

mkdir -p \
  ~/.jitsi-meet-cfg/web \
  ~/.jitsi-meet-cfg/prosody/config \
  ~/.jitsi-meet-cfg/prosody/prosody-plugins-custom \
  ~/.jitsi-meet-cfg/jicofo \
  ~/.jitsi-meet-cfg/jvb \
  ~/.jitsi-meet-cfg/jigasi \
  ~/.jitsi-meet-cfg/jibri

docker compose up -d

echo
echo "Jitsi is up."
echo "- Domain: https://${JITSI_DOMAIN}"
echo "- Local web target for reverse proxy: http://127.0.0.1:8000"
echo "- Media UDP port (must be open): 10000/udp"
