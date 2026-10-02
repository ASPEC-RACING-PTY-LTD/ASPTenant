# @aspec/audit

Structured, tamper-evident audit logging for Node.js applications.

Record actors, actions, resources, outcomes, before-and-after changes and
request correlation. Events are redacted before hashing and storage. Hash chains
(optional HMAC) and signed checkpoints keep streams verifiable through retention.

## Install

```bash
aspec add aspec/audit
# or
pnpm add @aspec/audit
```

## Quick start

```ts
import { createAuditLogger, createMemoryAuditStore } from '@aspec/audit';

const audit = createAuditLogger({
  sink: createMemoryAuditStore(),
  retention: { defaultDays: 90, categories: { security: 365 } },
});

await audit.record({
  action: 'users.profile.update',
  actor: { id: 'user_1', type: 'user' },
  resource: { type: 'user', id: 'user_1' },
  changes: { before: { name: 'Ada' }, after: { name: 'Ada Lovelace' } },
});
```

## Docs

- [Summary](docs/summary.md)
- [Install](docs/install.md)
- [Configure](docs/configure.md)
- [Integrate](docs/integrate.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [AI agents](docs/ai.md)

## Licence

MIT
