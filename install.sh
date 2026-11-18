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
# ASPECTENANT_BIND (default 127.0.0.1), ASPECTENANT_MODE=install|upgrade|uninstall|external|join|joininfo
# (skip the menu). Redundancy: docs/high-availability.md.
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
  say "  4) Move the database to an external PostgreSQL (Neon, RDS...) for redundancy"
  say "  5) Add this machine as a redundancy node"
  say "  6) Show the command that adds another redundancy node"
  case "$(ask "Choose 1 to 6 [1]: ")" in
    "" | 1) MODE=install ;;
    2) MODE=upgrade ;;
    3) MODE=uninstall ;;
    4) MODE=external ;;
    5) MODE=join ;;
    6) MODE=joininfo ;;
    *) die "Unknown choice." ;;
  esac
fi

env_file_get() { grep -E "^$1=" "${PREFIX}/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

# Runs a PostgreSQL client tool in a throwaway container (no client needed on the host).
pg_tool() { docker run --rm -i --network host postgres:17.6-alpine "$@"; }

check_external_url() {
  local url="$1"
  [[ "${url}" =~ ^postgres(ql)?://[^:/@]+:[^@]+@[^/]+/[^?]+ ]] ||
    die "Enter the URL like postgres://user:password@host/dbname?sslmode=require"
  [[ "${url}" == *"sslmode="* ]] || die "Add ?sslmode=require: the database is reached over the internet."
  if [[ "${url}" == *"-pooler."* ]]; then
    die "Use the direct connection string, not the pooled (-pooler) one: migrations need session locks."
  fi
  pg_tool psql "${url}" -tAc 'SELECT 1' >/dev/null 2>&1 || die "Cannot connect to that database."
}

ask_node() {
  local role="$1" name address detected
  name="$(ask "Name for this machine [$(hostname -s)]: ")"
  NODE_NAME="${name:-$(hostname -s)}"
  detected="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  address="$(ask "Public IP of this machine, for moving the mail hostname on failover [${detected:-none}]: ")"
  NODE_ADDRESS="${address:-${detected}}"
  NODE_ROLE="${role}"
}

case "${MODE}" in
  joininfo)
    [[ -f "${PREFIX}/.env" ]] || die "No installation in ${PREFIX}."
    db="$(env_file_get DATABASE_URL)"
    [[ -n "${db}" ]] || die "This installation uses its own bundled database. Choose 4 to move it to an external PostgreSQL first."
    code="$(printf '%s\n%s\n%s\n%s\n' "${db}" "$(env_file_get AUDIT_HMAC_KEY)" "$(env_file_get SECRET_KEY)" "$(env_file_get PUBLIC_URL)" | base64 | tr -d '\n')"
    say "Run this on the new machine (as root, in the folder that should hold the installation)."
    say "It contains the database password and encryption key: keep it private."
    say ""
    say "ASPECTENANT_MODE=join ASPECTENANT_JOIN='${code}' bash -c \"\$(curl -fsSL ${REPO_RAW}/install.sh)\""
    exit 0
    ;;
  external)
    [[ -f "${PREFIX}/.env" ]] || die "No installation in ${PREFIX}."
    [[ -z "$(env_file_get DATABASE_URL)" ]] || die "This installation already uses an external database."
    say "Create an empty PostgreSQL 17 database first (for Neon: a new project, default database)."
    say "Paste its owner connection string. It is used once to create the application role and"
    say "copy your data; the panel then connects as that role, so row-level security applies."
    admin="${ASPECTENANT_DB_ADMIN_URL:-$(ask "Owner connection string: ")}"
    check_external_url "${admin}"
    tables="$(pg_tool psql "${admin}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
    if [[ "${tables}" != "0" ]]; then
      [[ "$(ask "That database already has ${tables} tables. Type REPLACE to overwrite them: ")" == "REPLACE" ]] ||
        die "Cancelled. Use an empty database."
    fi
    cd "${PREFIX}"
    ask_node primary
    stamp="$(date +%Y%m%d%H%M%S)"
    dump="${PREFIX}/database-${stamp}.dump"
    say "Stopping the panel and copying the database (mail included, this can take a while)..."
    docker compose -p "${PROJECT}" stop api web updater >/dev/null 2>&1 || true
    # If the move stops part way, start the panel again on the bundled database.
    trap 'docker compose -p "${PROJECT}" start api web updater >/dev/null 2>&1 && say "The panel was started again on its own database."' EXIT
    # Messages moved to an R2 or S3 bucket still take space until the table is compacted.
    docker compose -p "${PROJECT}" exec -T postgres psql -U aspec -d aspec -qc 'VACUUM FULL aspectenant_messages' ||
      die "Could not compact the messages table. Nothing was changed."
    # Make sure the data fits (Neon reports its plan's size limit).
    need="$(docker compose -p "${PROJECT}" exec -T postgres psql -U aspec -d aspec -tAc "SELECT pg_database_size('aspec')" | tr -d '[:space:]')"
    limit_mb="$(pg_tool psql "${admin}" -tAc "SELECT current_setting('neon.max_cluster_size', true)" 2>/dev/null | tr -d '[:space:]' || true)"
    need_mb=$(( ${need:-0} / 1048576 + 1 ))
    say "Your database is ${need_mb} MB."
    if [[ "${limit_mb}" =~ ^[0-9]+$ && "${limit_mb}" -gt 0 && $(( need_mb * 12 / 10 )) -ge "${limit_mb}" ]]; then
      die "The external database allows ${limit_mb} MB, too little for ${need_mb} MB plus room to grow. Move messages to an R2 bucket first (System, Message storage) or choose a larger plan. Nothing was changed."
    fi
    docker compose -p "${PROJECT}" exec -T postgres pg_dump -U aspec -d aspec --no-owner --no-privileges -Fc >"${dump}" ||
      die "Could not copy the database. Nothing was changed."
    app_password="$(openssl rand -hex 24 2>/dev/null || tr -dc 'a-f0-9' </dev/urandom | head -c 48)"
    dbname="$(sed -E 's|^[^/]*//[^/]+/([^?]+).*|\1|' <<<"${admin}")"
    pg_tool psql "${admin}" -v ON_ERROR_STOP=1 <<SQL || die "Could not create the application role. Nothing was changed."
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aspectenant_app') THEN
    CREATE ROLE aspectenant_app LOGIN PASSWORD '${app_password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE aspectenant_app LOGIN PASSWORD '${app_password}' NOBYPASSRLS;
  END IF;
END \$\$;
GRANT aspectenant_app TO CURRENT_USER;
GRANT CONNECT ON DATABASE "${dbname}" TO aspectenant_app;
GRANT USAGE, CREATE ON SCHEMA public TO aspectenant_app;
SQL
    pg_tool pg_restore --no-owner --no-privileges --role=aspectenant_app --clean --if-exists \
      -d "${admin}" <"${dump}" ||
      say "pg_restore reported warnings; checking the copy..."
    # Row-level security hides every row unless the all-organisations scope is set.
    copied="$(pg_tool psql "${admin}" -qtA -c "SET app.tenant_id = '*'" -c 'SELECT count(*) FROM aspectenant_messages' 2>/dev/null | tr -d '[:space:]' || echo error)"
    local_count="$(docker compose -p "${PROJECT}" exec -T postgres psql -U aspec -d aspec -tAc 'SELECT count(*) FROM aspectenant_messages' | tr -d '[:space:]')"
    [[ "${copied}" == "${local_count}" ]] ||
      die "The copy does not match (${copied} of ${local_count} messages), so nothing was switched. The partial copy stays in the external database until the next attempt replaces it."
    trap - EXIT
    app_url="$(sed -E "s|^(postgres(ql)?://)[^@]+@|\\1aspectenant_app:${app_password}@|" <<<"${admin}")"
    {
      echo "DATABASE_URL=${app_url}"
      echo "NODE_ROLE=${NODE_ROLE}"
      echo "NODE_NAME=${NODE_NAME}"
      echo "NODE_ADDRESS=${NODE_ADDRESS}"
    } >>.env
    say "Copied ${copied} messages. Starting on the external database..."
    MODE=upgrade
    ;;
  join)
    join="${ASPECTENANT_JOIN:-$(ask "Join code (from option 6 on the first machine): ")}"
    decoded="$(base64 -d <<<"${join}" 2>/dev/null)" || die "That join code cannot be read."
    JOIN_DB="$(sed -n 1p <<<"${decoded}")"
    JOIN_AUDIT="$(sed -n 2p <<<"${decoded}")"
    JOIN_SECRET="$(sed -n 3p <<<"${decoded}")"
    JOIN_URL="$(sed -n 4p <<<"${decoded}")"
    [[ -n "${JOIN_DB}" && -n "${JOIN_AUDIT}" ]] || die "That join code is incomplete."
    check_external_url "${JOIN_DB}"
    if [[ -f "${PREFIX}/.env" ]]; then
      [[ "$(ask "${PREFIX} already has an installation. Type REPLACE to turn it into a node: ")" == "REPLACE" ]] ||
        die "Cancelled."
    fi
    ask_node secondary
    say "Joining as ${NODE_NAME} (secondary)..."
    wipe
    PUBLIC_URL="${JOIN_URL}"
    ;;
esac

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
  join) ;;
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
    echo "POSTGRES_APP_PASSWORD=$(random 24)"
    echo "AUDIT_HMAC_KEY=$(random 32)"
  } > .env
  chmod 600 .env
fi
if [[ "${MODE}" == "join" ]]; then
  # Every node shares the database and the key that decrypts the secrets stored in it.
  env_set DATABASE_URL "${JOIN_DB}"
  env_set AUDIT_HMAC_KEY "${JOIN_AUDIT}"
  [[ -n "${JOIN_SECRET}" ]] && env_set SECRET_KEY "${JOIN_SECRET}"
  env_set NODE_ROLE "${NODE_ROLE}"
  env_set NODE_NAME "${NODE_NAME}"
  env_set NODE_ADDRESS "${NODE_ADDRESS}"
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
if [[ "${MODE}" == "install" || "${MODE}" == "join" ]]; then
  env_set PUBLIC_URL "${PUBLIC_URL:-http://localhost:${PANEL_PORT}}"
elif [[ -z "$(env_get PUBLIC_URL)" ]]; then
  env_set PUBLIC_URL "http://localhost:${PANEL_PORT}"
fi
env_set ASPECTENANT_MAIL_PORTS "$(IFS=,; echo "${MAIL_PORTS[*]}")"

# Installations from before tenant isolation have no application database role password.
[[ -n "$(env_get POSTGRES_APP_PASSWORD)" ]] || env_set POSTGRES_APP_PASSWORD "$(random 24)"

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
