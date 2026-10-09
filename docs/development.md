# Development

## Prerequisites

- Node.js 22.13 or newer
- pnpm 10
- Docker, for the Compose stack or a local PostgreSQL

## Host-side API and UI

```sh
cp .env.example .env
docker compose up -d postgres db-roles
pnpm install
pnpm build:modules
pnpm --filter @aspectenant/api dev
pnpm --filter @aspectenant/web dev
```

The UI defaults to http://localhost:5173 and proxies `/api`, `/auth` and health paths to the API on port 3000.

Open `/setup` once and create the first account, then sign in. It becomes platform operator and owner of the first tenant. Create further tenants on the Tenants page.

Domain verification looks up public DNS from the API host. On a private machine, confirm a domain with the platform operator override (Confirm without DNS).

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

Row-level security exists only in PostgreSQL. To run the PostgreSQL suites, start the Compose database, create a test database owned by the application role and point the tests at it:

```sh
docker compose up -d postgres db-roles
docker compose exec postgres psql -U aspec -d aspec -c "CREATE DATABASE aspec_test OWNER aspectenant_app"
ASPECTENANT_TEST_DATABASE_URL=postgres://aspectenant_app:aspectenant@127.0.0.1:5432/aspec_test pnpm --filter @aspectenant/api test
```

That runs `test/postgres.test.ts`. Add `ASPECTENANT_TEST_ALL_POSTGRES=1` and `--no-file-parallelism` to run every API suite against PostgreSQL. The suites drop the tables the application role owns in that database.

If port 5432 is taken on your machine, set `ASPECTENANT_DB_PORT` before `docker compose up`.

Vendored module suites can be run with `pnpm test:modules`. They are the upstream tests and may skip service-backed cases unless `ASPEC_TEST_*` URLs are set.

## Configuration

`.env.example` lists only what is required to launch: `DATABASE_URL` and `PUBLIC_URL`. `DATABASE_URL` uses the non-superuser `aspectenant_app` role so row-level security applies during development too. The super administrator and organisation name are created on the first-run setup page. Optional overrides (`LOG_LEVEL`, `AUDIT_HMAC_KEY`, `TRUSTED_PROXIES`) have defaults and do not belong in a normal launch file.

Secret values also accept `NAME_FILE` (from `@aspec/config`) so Docker secrets can be mounted later without new variable names.
