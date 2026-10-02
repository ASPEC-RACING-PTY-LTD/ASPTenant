# Migration

## Tables (default prefix `auth_`)

- `auth_accounts`
- `auth_sessions`
- `auth_refresh_tokens`
- `auth_one_time_tokens`
- `auth_recovery_codes`
- `auth_identities`
- `auth_webauthn_credentials`
- `auth_schema_migrations`

## Apply migrations

```ts
import { migrate, createMigrations, tableNames } from '@aspec/auth/sql';

await migrate(client); // default prefix auth_
await migrate(client, { tablePrefix: 'myauth_' });
```

Migrations are idempotent. On PostgreSQL a transaction-scoped advisory lock serialises concurrent runs. Dialects: `postgres` and `sqlite`.

## Upgrades

Version 1.0.0 is the initial schema (`0001_initial`). Future releases will add numbered migration IDs without rewriting earlier SQL.
