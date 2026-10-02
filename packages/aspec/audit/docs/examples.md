# Examples

## Security login failure

```ts
await audit.record({
  action: 'auth.login.failed',
  outcome: 'failure',
  actor: { id: email, type: 'user', ip: req.ip },
  metadata: { reason: 'invalid_password' },
});
```

## Data change with diff

```ts
await audit.record({
  action: 'orgs.member.role.change',
  actor: { id: adminId, type: 'user' },
  resource: { type: 'membership', id: membershipId },
  tenantId: orgId,
  category: 'admin',
  changes: { before: { role: 'member' }, after: { role: 'owner' } },
});
```

## Fan-out to SQL and JSONL

```ts
import { createAuditLogger, createSqlAuditStore, migrate } from '@aspec/audit';
import { createJsonlFileSink } from '@aspec/audit/jsonl';

await migrate(client);
const audit = createAuditLogger({
  sinks: [
    createSqlAuditStore(client),
    createJsonlFileSink({ path: process.env.AUDIT_JSONL_PATH!, fsync: true }),
  ],
  chain: { hmacKey: process.env.AUDIT_HMAC_KEY },
});
```

## Buffered SQL writes

```ts
import { createBufferedSink } from '@aspec/audit/buffered';
import { createSqlAuditStore } from '@aspec/audit/sql';

const store = createSqlAuditStore(client);
const audit = createAuditLogger({
  sinks: [store, createBufferedSink(createJsonlFileSink({ path: './audit.jsonl' }), {
    maxQueue: 10_000,
    overflow: 'block',
  })],
});
```
