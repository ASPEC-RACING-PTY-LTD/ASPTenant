# API

## createApiKeys(options)

Methods: create, get, getByPublicId, list, expiringWithin, update, rotate, revoke, verify, service-account CRUD, shutdown.

## Key format

`<prefix><publicId>_<secret><checksum>` (default prefix `ak_live_`). Secret scanning regex: `API_KEY_SCAN_REGEX`.

## Stores

`@aspec/api-keys/memory`: createMemoryStore
`@aspec/api-keys/sql`: createSqlStore, migrate, migrations

## Adapters

`./express`, `./fastify`, `./hono`, `./fetch`

## Errors

ApiKeysError with codes such as API_KEYS_UNAUTHORIZED, API_KEYS_SCOPE_DENIED, API_KEYS_ESCALATION, API_KEYS_NOT_FOUND.
