# @aspec/testing

Reusable development testing utilities for Node.js applications. Install as a **dev dependency**.

## Capabilities

- Scaffold Vitest with `aspec-testing init` / `generate`
- Fluent `createTestClient` for Express 4/5, Fastify, Hono and Fetch handlers
- SQLite and PostgreSQL `SqlClient` fixtures (migrations, truncate, rollback)
- Seeded factories and generators (no faker)
- Test JWTs (HS256/ES256 via `node:crypto`), session cookies, act-as helpers
- Mock `PermissionChecker` and `expectAllowed` / `expectDenied`
- `mockFetch` and `createMockServer`
- Environment isolation, temp dirs, controllable Clock, Vitest fake timers
- `defineAspecVitestConfig` coverage preset and `coverageSummary` CI gates

## Quick start

```bash
pnpm add -D @aspec/testing vitest
pnpm exec aspec-testing init
```

```ts
import { createTestClient, defineFactory, mockFetch } from '@aspec/testing';

const client = createTestClient(app);
await client.get('/health').expect(200).expectJson({ ok: true });
```

## Documentation

See [docs/summary.md](docs/summary.md) and the sections linked from `aspec.module.json`.

## Licence

MIT
