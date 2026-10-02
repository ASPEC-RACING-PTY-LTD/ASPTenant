# Migration

## SQL tables (prefix `audit_` by default)

| Table | Purpose |
|-------|---------|
| `audit_events` | Append-only events (JSON record plus indexed columns) |
| `audit_stream_heads` | Per-stream sequence and hash head |
| `audit_checkpoints` | Retention, eviction and manual checkpoints |
| `audit_schema_migrations` | Applied migration IDs |

## Apply

```ts
import { migrate, createSqlAuditStore } from '@aspec/audit/sql';

await migrate(client, { tablePrefix: 'audit_' });
const store = createSqlAuditStore(client, { tablePrefix: 'audit_' });
```

Migrations are idempotent. Changing `tablePrefix` creates a separate schema;
data is not moved automatically.

## PostgreSQL append-only trigger (optional)

```ts
import { installAppendOnlyTrigger } from '@aspec/audit/sql';

await installAppendOnlyTrigger(client);
const store = createSqlAuditStore(client, { useRetentionFunction: true });
```

After installing the trigger, set `useRetentionFunction: true` so retention uses
the `audit_purge_stream` function.

## No SQL

The memory and JSON Lines sinks need no migrations. Retention on memory writes
an eviction or retention checkpoint in process memory only.
