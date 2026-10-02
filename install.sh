#!/usr/bin/env bash
# Install or upgrade ASPECTenant from published images.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
# Unattended:
#   sudo env PUBLIC_URL=https://mail.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
# Optional: ASPECTENANT_DIR (default /opt/aspectenant), ASPECTENANT_BIND (default
# 127.0.0.1, for a local cloudflared), ASPECTENANT_PORT (default 8080).
# Re-running is safe: it refreshes compose.yml, keeps .env and the database.
set -euo pipefail

REPO_RAW="${ASPECTENANT_RAW:-https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main}"
PREFIX="${ASPECTENANT_DIR:-/opt/aspectenant}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine, then re-run." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required. Install the Compose plugin, then re-run." >&2
  exit 1
fi

mkdir -p "${PREFIX}"
cd "${PREFIX}"

curl -fsSL "${REPO_RAW}/deploy/compose.release.yml" -o compose.yml.new
mv compose.yml.new compose.yml

random() {
  openssl rand -hex "$1" 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c "$(($1 * 2))"
}

if [[ ! -f .env ]]; then
  if [[ -z "${PUBLIC_URL:-}" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Public URL people will open (for example https://mail.example.com): " PUBLIC_URL
    else
      PUBLIC_URL="http://localhost:8080"
    fi
  fi
  {
    echo "PUBLIC_URL=${PUBLIC_URL%/}"
    echo "POSTGRES_PASSWORD=$(random 24)"
    echo "AUDIT_HMAC_KEY=$(random 32)"
    echo "INSTALL_DIR=${PREFIX}"
    if [[ -n "${ASPECTENANT_BIND:-}" ]]; then echo "ASPECTENANT_BIND=${ASPECTENANT_BIND}"; fi
    if [[ -n "${ASPECTENANT_PORT:-}" ]]; then echo "ASPECTENANT_PORT=${ASPECTENANT_PORT}"; fi
  } > .env
  chmod 600 .env
elif ! grep -q '^INSTALL_DIR=' .env; then
  echo "INSTALL_DIR=${PREFIX}" >> .env
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

docker compose pull
docker compose up -d --remove-orphans

echo "Waiting for ASPECTenant to start..."
CODE=""
for _ in $(seq 1 60); do
  CODE="$(docker compose logs api 2>/dev/null | grep -o 'Setup code: [A-F0-9-]*' | tail -1 | cut -d' ' -f3 || true)"
  if [[ -n "${CODE}" ]] || docker compose logs api 2>/dev/null | grep -q 'control plane listening'; then
    break
  fi
  sleep 3
done

echo
echo "ASPECTenant is running in ${PREFIX}"
echo "Panel: ${PUBLIC_URL} (local: http://${ASPECTENANT_BIND:-127.0.0.1}:${ASPECTENANT_PORT:-8080})"
if [[ -n "${CODE}" ]]; then
  echo
  echo "Open ${PUBLIC_URL}/setup and enter this setup code: ${CODE}"
  echo "(It changes if the API restarts: docker compose logs api | grep 'Setup code')"
fi
