#!/usr/bin/env bash
# Update an existing ASPECTenant installation by building the images from source, for when
# the published images are not available yet (for example while GitHub Actions is down).
# Prefer install.sh option 2, which uses the published images.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ASPEC-RACING-PTY-LTD/ASPTenant/main/update-from-source.sh)"
#
# Run it from the directory that holds the installation, like install.sh (/root finds
# /root/aspectenant). Optional: ASPECTENANT_DIR (installation directory), ASPECTENANT_REF
# (branch, tag or commit; default main), ASPECTENANT_MODE=source (skip the menu and prompts).
#
# Steps: download the source into a /tmp folder, build the api and web images, refresh
# compose.yml in the installation, recreate the containers and wait until they are healthy.
# On success the /tmp folder and the previous images are removed. If the new version does not
# start, the previous images and compose.yml are put back and the /tmp folder is kept.
#
# The images are tagged with the names the installation already uses (…:latest), so .env is
# not changed and the next normal update from the Updates page or install.sh replaces them.
set -euo pipefail

REPO="ASPEC-RACING-PTY-LTD/ASPTenant"
REF="${ASPECTENANT_REF:-main}"
PROJECT=aspectenant
API_IMAGE="ghcr.io/aspec-racing-pty-ltd/aspectenant-api:latest"
WEB_IMAGE="ghcr.io/aspec-racing-pty-ltd/aspectenant-web:latest"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo)."
command -v docker >/dev/null 2>&1 || die "Docker is required."
docker compose version >/dev/null 2>&1 || die "Docker Compose is required."
command -v curl >/dev/null 2>&1 || die "curl is required."
command -v tar >/dev/null 2>&1 || die "tar is required."

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

# Same location rules as install.sh: next to where the script is run (/root -> /root/aspectenant).
HERE="$(pwd)"
[[ "${HERE}" == "/" ]] && HERE=/opt
if [[ -n "${ASPECTENANT_DIR:-}" ]]; then
  PREFIX="${ASPECTENANT_DIR}"
elif [[ "$(basename "${HERE}")" == "${PROJECT}" ]]; then
  PREFIX="${HERE}"
else
  PREFIX="${HERE}/${PROJECT}"
fi

# Not found there: ask the running containers where they were started from.
if [[ ! -f "${PREFIX}/.env" || ! -f "${PREFIX}/compose.yml" ]]; then
  found="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{ index .Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null | head -n1 || true)"
  if [[ -n "${found}" && -f "${found}/.env" && -f "${found}/compose.yml" ]]; then
    say "No installation in ${PREFIX}; using the running installation in ${found}."
    PREFIX="${found}"
  fi
fi
[[ -f "${PREFIX}/.env" && -f "${PREFIX}/compose.yml" ]] ||
  die "No installation in ${PREFIX}. Run this from the directory that holds it, or set ASPECTENANT_DIR."

MODE="${ASPECTENANT_MODE:-}"
if [[ -z "${MODE}" ]]; then
  say "ASPECTenant source updater (${PREFIX})"
  say "  1) Update using Source (Not Recommended)"
  case "$(ask "Choose 1 (anything else cancels): ")" in
    1) MODE=source ;;
    *) die "Cancelled." ;;
  esac
  say ""
  say "This builds ${REF} from github.com/${REPO} on this machine and replaces the running"
  say "api and web containers. Data is kept. A backup from the Backups page first is wise."
  [[ "$(ask "Type UPDATE to continue: ")" == "UPDATE" ]] || die "Cancelled."
fi
[[ "${MODE}" == "source" ]] || die "Unknown mode ${MODE}."

WORK="$(mktemp -d /tmp/aspectenant-source.XXXXXX)"
STAMP="$(date +%Y%m%d%H%M%S)"
API_BUILD="aspectenant-api:source-${STAMP}"
WEB_BUILD="aspectenant-web:source-${STAMP}"
API_PREVIOUS="aspectenant-api:before-source-${STAMP}"
WEB_PREVIOUS="aspectenant-web:before-source-${STAMP}"
SWAPPED=0

# Any failure before the swap leaves the installation untouched; after it, roll back.
rollback() {
  say ""
  say "The update did not complete. Restoring the previous version..."
  if docker image inspect "${API_PREVIOUS}" >/dev/null 2>&1; then
    docker tag "${API_PREVIOUS}" "${API_IMAGE}"
  fi
  if docker image inspect "${WEB_PREVIOUS}" >/dev/null 2>&1; then
    docker tag "${WEB_PREVIOUS}" "${WEB_IMAGE}"
  fi
  [[ -f "${WORK}/compose.yml.previous" ]] && cp "${WORK}/compose.yml.previous" "${PREFIX}/compose.yml"
  (cd "${PREFIX}" && docker compose -p "${PROJECT}" up -d --remove-orphans) || true
  say "Previous version restored. Build files are kept in ${WORK} for inspection."
}
on_exit() {
  local status=$?
  if [[ ${status} -ne 0 ]]; then
    if [[ ${SWAPPED} -eq 1 ]]; then
      rollback
    else
      say "Nothing was changed in ${PREFIX}. Build files are kept in ${WORK}."
    fi
    docker image rm "${API_BUILD}" "${WEB_BUILD}" >/dev/null 2>&1 || true
  fi
  exit "${status}"
}
trap on_exit EXIT

say "Downloading ${REF} into ${WORK}..."
mkdir -p "${WORK}/src"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${REF}" | tar -xz -C "${WORK}/src" --strip-components=1
SRC="${WORK}/src"
[[ -f "${SRC}/deploy/docker/api.Dockerfile" && -f "${SRC}/deploy/compose.release.yml" ]] ||
  die "The download does not look like the ASPECTenant source."

VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${SRC}/apps/api/package.json" | head -n1)"
[[ -n "${VERSION}" ]] || die "Could not read the version from apps/api/package.json."
say "Source version ${VERSION}."

say "Building the api image (this takes a few minutes)..."
docker build -f "${SRC}/deploy/docker/api.Dockerfile" --build-arg "APP_VERSION=${VERSION}" \
  -t "${API_BUILD}" "${SRC}"
say "Building the web image..."
docker build -f "${SRC}/deploy/docker/web.Dockerfile" -t "${WEB_BUILD}" "${SRC}"

# Both images built: keep the current ones for a rollback, then swap.
docker image inspect "${API_IMAGE}" >/dev/null 2>&1 && docker tag "${API_IMAGE}" "${API_PREVIOUS}"
docker image inspect "${WEB_IMAGE}" >/dev/null 2>&1 && docker tag "${WEB_IMAGE}" "${WEB_PREVIOUS}"
cp "${PREFIX}/compose.yml" "${WORK}/compose.yml.previous"
SWAPPED=1
docker tag "${API_BUILD}" "${API_IMAGE}"
docker tag "${WEB_BUILD}" "${WEB_IMAGE}"
cp "${SRC}/deploy/compose.release.yml" "${PREFIX}/compose.yml"

say "Recreating the containers in ${PREFIX}..."
cd "${PREFIX}"
docker compose -p "${PROJECT}" up -d --remove-orphans

say "Waiting for the api to report healthy..."
healthy=0
for _ in $(seq 1 60); do
  api_id="$(docker compose -p "${PROJECT}" ps -q api 2>/dev/null || true)"
  web_id="$(docker compose -p "${PROJECT}" ps -q web 2>/dev/null || true)"
  api_health="$( [[ -n "${api_id}" ]] && docker inspect -f '{{.State.Health.Status}}' "${api_id}" 2>/dev/null || echo none)"
  web_state="$( [[ -n "${web_id}" ]] && docker inspect -f '{{.State.Status}}' "${web_id}" 2>/dev/null || echo none)"
  if [[ "${api_health}" == "healthy" && "${web_state}" == "running" ]]; then
    healthy=1
    break
  fi
  sleep 5
done
if [[ ${healthy} -ne 1 ]]; then
  docker compose -p "${PROJECT}" logs --tail 40 api >&2 || true
  die "The api did not become healthy within 5 minutes."
fi
running="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${api_id}" |
  sed -n 's/^APP_VERSION=//p' | head -n1)"
[[ "${running}" == "${VERSION}" ]] || die "The api reports version ${running:-unknown}, expected ${VERSION}."

# Confirmed: clean up the build files, temporary tags and the previous images.
SWAPPED=0
docker image rm "${API_BUILD}" "${WEB_BUILD}" "${API_PREVIOUS}" "${WEB_PREVIOUS}" >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
cd /
rm -rf "${WORK}"

say ""
say "ASPECTenant ${VERSION} is running in ${PREFIX}, built from ${REF}."
say "The next update from the Updates page or install.sh returns to the published images."
