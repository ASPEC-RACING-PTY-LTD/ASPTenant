# Testing

Use the memory store with a fixed clock and ID generator (see frameworks/vitest).

For SQL contract tests, create an isolated SQLite client or a PostgreSQL schema
with a random suffix and drop it afterwards. The module's own suite uses
`ASPEC_TEST_POSTGRES_URL` and skips PostgreSQL when unset.

```ts
import { createSqliteClient } from './helpers/sql.js'; // your test helper
import { createSqlAuditStore, migrate, createAuditLogger } from '@aspec/audit';

const client = createSqliteClient();
await migrate(client);
const audit = createAuditLogger({ sink: createSqlAuditStore(client) });
```

Assert redaction by placing secrets in `changes` or `metadata` and checking they
become `[REDACTED]` before you inspect hashes. Assert chain integrity with
`verifyChain` after deliberate mutations in a cloned event list.
