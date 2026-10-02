#!/usr/bin/env bash
# Install, upgrade or reinstall ASPECTenant from published images.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
# Nothing to configure: free ports are detected, secrets are generated, and the
# public URL and everything else are set in the panel. Re-running upgrades in place.
#
# Optional: ASPECTENANT_DIR (default /opt/aspectenant), ASPECTENANT_PORT (preferred panel
# port), ASPECTENANT_BIND (default 127.0.0.1), ASPECTENANT_MODE=upgrade|fresh (skip the prompt).
set -euo pipefail

REPO_RAW="${ASPECTENANT_RAW:-https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main}"
PROJECT=aspectenant

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo)."
command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Engine, then re-run."
docker compose version >/dev/null 2>&1 || die "Docker Compose is required. Install the Compose plugin, then re-run."

# Find an existing installation (this directory, or wherever Compose last ran the project).
PREFIX="${ASPECTENANT_DIR:-}"
if [[ -z "${PREFIX}" ]]; then
  PREFIX="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n1 || true)"
  [[ -n "${PREFIX}" && -d "${PREFIX}" ]] || PREFIX=/opt/aspectenant
fi
EXISTING=0
if [[ -f "${PREFIX}/.env" ]] || docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" | grep -q .; then
  EXISTING=1
fi

MODE="${ASPECTENANT_MODE:-}"
if [[ "${EXISTING}" -eq 1 && -z "${MODE}" ]]; then
  say "Existing ASPECTenant installation found in ${PREFIX}."
  if [[ -t 0 ]]; then
    say "  1) Upgrade / repair (keep all data)  [default]"
    say "  2) Fresh reinstall (DELETE all data, mail and settings)"
    read -r -p "Choose 1 or 2: " choice
    if [[ "${choice}" == "2" ]]; then
      read -r -p "Type DELETE to erase everything: " confirm
      [[ "${confirm}" == "DELETE" ]] || die "Cancelled."
      MODE=fresh
    else
      MODE=upgrade
    fi
  else
    MODE=upgrade
  fi
fi
MODE="${MODE:-upgrade}"

mkdir -p "${PREFIX}"
cd "${PREFIX}"

# Stop our own containers first so their ports count as free.
if [[ "${EXISTING}" -eq 1 ]]; then
  if [[ "${MODE}" == "fresh" ]]; then
    say "Removing the existing installation and its data..."
    docker compose -p "${PROJECT}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    rm -f .env compose.yml
  else
    say "Stopping the existing installation (data is kept)..."
    docker compose -p "${PROJECT}" down --remove-orphans >/dev/null 2>&1 || true
  fi
fi

curl -fsSL "${REPO_RAW}/deploy/compose.release.yml" -o compose.yml.new
mv compose.yml.new compose.yml

port_in_use() {
  local port="$1" hex files=()
  hex="$(printf '%04X' "${port}")"
  for f in /proc/net/tcp /proc/net/tcp6; do [[ -r "${f}" ]] && files+=("${f}"); done
  # Listening sockets (state 0A) from the kernel; works without ss or netstat.
  if [[ ${#files[@]} -gt 0 ]] && awk -v p="${hex}" \
    '$4 == "0A" { split($2, a, ":"); if (a[2] == p) found = 1 } END { exit !found }' "${files[@]}"; then
    return 0
  fi
  if command -v ss >/dev/null 2>&1 && ss -Hltn "sport = :${port}" 2>/dev/null | grep -q .; then
    return 0
  fi
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -Eq ":${port}->" && return 0
  return 1
}

free_port() {
  local port="$1" limit=$(( $1 + 200 ))
  while [[ "${port}" -lt "${limit}" ]]; do
    if ! port_in_use "${port}"; then echo "${port}"; return 0; fi
    port=$(( port + 1 ))
  done
  return 1
}

env_get() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
env_set() {
  if grep -qE "^$1=" .env 2>/dev/null; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

random() {
  openssl rand -hex "$1" 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c "$(( $1 * 2 ))"
}

if [[ ! -f .env ]]; then
  # Generated values only. Do not edit; configure everything else in the panel.
  {
    echo "POSTGRES_PASSWORD=$(random 24)"
    echo "AUDIT_HMAC_KEY=$(random 32)"
  } > .env
  chmod 600 .env
fi
env_set INSTALL_DIR "${PREFIX}"
OLD_URL="$(env_get PUBLIC_URL)"
sed -i '/^PUBLIC_URL=/d' .env
[[ -n "${ASPECTENANT_BIND:-}" ]] && env_set ASPECTENANT_BIND "${ASPECTENANT_BIND}"

# Panel port: keep the saved one if still free, otherwise the first free one from 8080.
want="${ASPECTENANT_PORT:-$(env_get ASPECTENANT_PORT)}"
want="${want:-8080}"
PANEL_PORT="$(free_port "${want}")" || die "No free port found near ${want}."
[[ "${PANEL_PORT}" != "${want}" ]] && say "Port ${want} is in use; the panel will use ${PANEL_PORT}."
env_set ASPECTENANT_PORT "${PANEL_PORT}"

# Mail app ports should be the standard ones; move them only if something else owns them.
MAIL_PORTS=()
for spec in IMAPS:993:1993 SMTPS:465:1465 SUBMISSION:587:1587; do
  IFS=: read -r name standard alternative <<<"${spec}"
  saved="$(env_get "ASPECTENANT_${name}_PORT")"
  candidate="${saved:-${standard}}"
  if port_in_use "${candidate}"; then
    if [[ "${candidate}" != "${standard}" ]] && ! port_in_use "${standard}"; then
      candidate="${standard}"
    else
      candidate="$(free_port "${alternative}")" || die "No free port for ${name}."
      say "Port ${standard} (${name}) is in use; mail apps will use ${candidate} instead."
    fi
  fi
  env_set "ASPECTENANT_${name}_PORT" "${candidate}"
  MAIL_PORTS+=("${candidate}")
done
env_set ASPECTENANT_MAIL_PORTS "$(IFS=,; echo "${MAIL_PORTS[*]}")"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

docker compose -p "${PROJECT}" pull
docker compose -p "${PROJECT}" up -d --remove-orphans

say "Waiting for ASPECTenant to start..."
CODE=""
for _ in $(seq 1 60); do
  CODE="$(docker compose -p "${PROJECT}" logs api 2>/dev/null | grep -o 'Setup code: [A-F0-9-]*' | tail -1 | cut -d' ' -f3 || true)"
  if [[ -n "${CODE}" ]] || docker compose -p "${PROJECT}" logs api 2>/dev/null | grep -q 'control plane listening'; then
    break
  fi
  sleep 3
done

LOCAL="http://${ASPECTENANT_BIND:-127.0.0.1}:${PANEL_PORT}"
say ""
say "ASPECTenant is running in ${PREFIX} (${MODE})."
say "Panel:     ${LOCAL}  (point your Cloudflare Tunnel hostname at this)"
say "Mail apps: IMAP ${MAIL_PORTS[0]}, SMTP ${MAIL_PORTS[1]} and ${MAIL_PORTS[2]} (forward these on your router)"
if [[ -n "${CODE}" ]]; then
  say ""
  say "Open /setup and enter this setup code: ${CODE}"
  say "(It changes if the API restarts: cd ${PREFIX} && docker compose logs api | grep 'Setup code')"
fi
if [[ -n "${OLD_URL}" ]]; then
  say "Note: set your public URL (${OLD_URL}) on the Settings page; it no longer lives in .env."
fi
