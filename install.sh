#!/usr/bin/env bash
# Install, upgrade or reinstall ASPECTenant from published images.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/install.sh)"
#
# Asks for the public URL on install; free ports are detected and secrets generated.
# Everything else is set in the panel. Choose 2 on later runs to upgrade in place.
#
# Installs into ./aspectenant under the directory you run it from (for example
# /root/aspectenant). Optional: ASPECTENANT_DIR, ASPECTENANT_PORT (preferred panel port),
# ASPECTENANT_BIND (default 127.0.0.1), ASPECTENANT_MODE=install|upgrade|uninstall (skip the menu).
set -euo pipefail

REPO_RAW="${ASPECTENANT_RAW:-https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main}"
PROJECT=aspectenant

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo)."
command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Engine, then re-run."
docker compose version >/dev/null 2>&1 || die "Docker Compose is required. Install the Compose plugin, then re-run."

# Prompts read from the terminal directly so they work under "bash -c" and pipes.
ask() {
  local prompt="$1" answer=""
  if [[ -r /dev/tty ]]; then
    read -r -p "${prompt}" answer </dev/tty || true
  elif [[ -t 0 ]]; then
    read -r -p "${prompt}" answer || true
  fi
  echo "${answer}"
}

wipe() {
  docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=${PROJECT}" | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -f "${PREFIX}/.env" "${PREFIX}/compose.yml"
}

# Install next to where the script is run (/root -> /root/aspectenant).
HERE="$(pwd)"
[[ "${HERE}" == "/" ]] && HERE=/opt
if [[ -n "${ASPECTENANT_DIR:-}" ]]; then
  PREFIX="${ASPECTENANT_DIR}"
elif [[ "$(basename "${HERE}")" == "${PROJECT}" ]]; then
  PREFIX="${HERE}"
else
  PREFIX="${HERE}/${PROJECT}"
fi

MODE="${ASPECTENANT_MODE:-}"
if [[ -z "${MODE}" ]]; then
  say "ASPECTenant installer (${PREFIX})"
  say "  1) Install (replaces any existing installation)"
  say "  2) Upgrade / repair (keep all data)"
  say "  3) Uninstall (delete everything)"
  case "$(ask "Choose 1, 2 or 3 [1]: ")" in
    "" | 1) MODE=install ;;
    2) MODE=upgrade ;;
    3) MODE=uninstall ;;
    *) die "Unknown choice." ;;
  esac
fi

case "${MODE}" in
  install)
    url="$(ask "Public URL people will open (for example https://mail.example.com): ")"
    PUBLIC_URL="${url:-${PUBLIC_URL:-}}"
    PUBLIC_URL="${PUBLIC_URL%/}"
    if [[ -n "${PUBLIC_URL}" && ! "${PUBLIC_URL}" =~ ^https?://[^/[:space:]]+$ ]]; then
      die "Enter the URL like https://mail.example.com"
    fi
    say "Installing into ${PREFIX} (any existing ASPECTenant installation is replaced)..."
    wipe
    ;;
  upgrade)
    [[ -f "${PREFIX}/.env" ]] || die "No installation in ${PREFIX}. Choose 1 to install."
    say "Upgrading ${PREFIX} (data is kept)..."
    (cd "${PREFIX}" && docker compose -p "${PROJECT}" down --remove-orphans >/dev/null 2>&1) || true
    ;;
  uninstall)
    [[ "$(ask "This deletes all ASPECTenant data, mail and settings. Type DELETE to continue: ")" == "DELETE" ]] ||
      die "Cancelled."
    wipe
    say "ASPECTenant has been removed."
    exit 0
    ;;
  *) die "Unknown mode ${MODE}." ;;
esac

mkdir -p "${PREFIX}"
cd "${PREFIX}"

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
if [[ "${MODE}" == "install" ]]; then
  env_set PUBLIC_URL "${PUBLIC_URL:-http://localhost:${PANEL_PORT}}"
elif [[ -z "$(env_get PUBLIC_URL)" ]]; then
  env_set PUBLIC_URL "http://localhost:${PANEL_PORT}"
fi
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
say "Public URL: $(env_get PUBLIC_URL) (change it later on the Settings page)"
