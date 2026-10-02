# Development

## Prerequisites

- Node.js 22.13 or newer
- pnpm 10
- Docker, for the Compose stack or a local PostgreSQL

## Host-side API and UI

```sh
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm build:modules
pnpm --filter @aspectenant/api dev
pnpm --filter @aspectenant/web dev
```

The UI defaults to http://localhost:5173 and proxies `/api`, `/auth` and health paths to the API on port 3000.

Open `/setup` once and create the super administrator, then sign in.

## Docker stack

```sh
cp .env.example .env
docker compose up --build
```

The admin UI is published on http://localhost:8080. The API is reached through nginx at the same origin.

The Compose PostgreSQL password `aspec` is a local development default. Do not use it on a network-exposed host.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm exec biome check apps docs
```

API tests use an in-memory SQLite database. They do not require Docker.

Vendored module suites can be run with `pnpm test:modules`. They are the upstream tests and may skip service-backed cases unless `ASPEC_TEST_*` URLs are set.

## Configuration

`.env.example` lists only what is required to launch: `DATABASE_URL` and `PUBLIC_URL`. The super administrator and organisation name are created on the first-run setup page. Optional overrides (`LOG_LEVEL`, `AUDIT_HMAC_KEY`, `TRUSTED_PROXIES`) have defaults and do not belong in a normal launch file.

Secret values also accept `NAME_FILE` (from `@aspec/config`) so Docker secrets can be mounted later without new variable names.
