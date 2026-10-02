# Migration

## SQL tables (default prefix `users_`)

| Table | Purpose |
|-------|---------|
| `users_accounts` | User rows |
| `users_activation_tokens` | Hashed activation tokens |
| `users_invitations` | Invitation records |
| `users_activity` | Activity events |
| `users_schema_migrations` | Applied migration ids |

## Apply migrations

```ts
import { migrate, createMigrations } from '@aspec/users/sql';

await migrate(client);
// or customise prefix:
await migrate(client, { tablePrefix: 'app_users_' });
```

Migrations are idempotent. On PostgreSQL an advisory lock serialises concurrent
migrators.

## Upgrade notes

Version 1.0.0 is the initial schema (`0001_initial`). Future versions will add
migration ids; never edit applied SQL in place.
