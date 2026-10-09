#!/usr/bin/env bash
# Install ASPECTenant from published images.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
# Unattended:
#   sudo env PUBLIC_URL=https://tenant.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
set -euo pipefail

REPO_RAW="${ASPECTENANT_RAW:-https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main}"
API_IMAGE="${ASPECTENANT_API_IMAGE:-ghcr.io/aspec-racing-pty-ltd/aspectenant-api:latest}"
WEB_IMAGE="${ASPECTENANT_WEB_IMAGE:-ghcr.io/aspec-racing-pty-ltd/aspectenant-web:latest}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

if [[ "$(basename "$(pwd)")" == "aspectenant" ]]; then
  PREFIX="$(pwd)"
else
  PREFIX="$(pwd)/aspectenant"
fi

mkdir -p "${PREFIX}"
cd "${PREFIX}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine, then re-run." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required. Install the Compose plugin, then re-run." >&2
  exit 1
fi

if [[ ! -f compose.yml ]]; then
  curl -fsSL "${REPO_RAW}/deploy/compose.release.yml" -o compose.yml
fi

if [[ ! -f .env ]]; then
  if [[ -z "${PUBLIC_URL:-}" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Public URL (for example https://tenant.example.com): " PUBLIC_URL
    else
      PUBLIC_URL="http://127.0.0.1:8080"
    fi
  fi
  POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  POSTGRES_APP_PASSWORD="$(openssl rand -hex 24 2>/dev/null || tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  AUDIT_HMAC_KEY="$(openssl rand -hex 32 2>/dev/null || tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64)"
  cat > .env <<EOF
PUBLIC_URL=${PUBLIC_URL}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_APP_PASSWORD=${POSTGRES_APP_PASSWORD}
AUDIT_HMAC_KEY=${AUDIT_HMAC_KEY}
ASPECTENANT_PORT=${ASPECTENANT_PORT:-8080}
ASPECTENANT_API_IMAGE=${API_IMAGE}
ASPECTENANT_WEB_IMAGE=${WEB_IMAGE}
EOF
  chmod 600 .env
fi

# Installations from before tenant isolation have no application database role password.
if ! grep -q '^POSTGRES_APP_PASSWORD=' .env; then
  echo "POSTGRES_APP_PASSWORD=$(openssl rand -hex 24 2>/dev/null || tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)" >> .env
fi

# shellcheck disable=SC1091
set -a
. ./.env
set +a

docker compose pull
docker compose up -d

echo
echo "ASPECTenant is running."
echo "Open ${PUBLIC_URL}/setup and create the super administrator."
echo "Installation directory: ${PREFIX}"
