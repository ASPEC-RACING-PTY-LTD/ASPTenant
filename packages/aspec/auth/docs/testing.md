# Testing

Use an injected clock and a fast hasher in unit tests:

```ts
import { createAuth, createScryptHasher } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';

const clock = { now: () => Date.parse('2026-01-01T00:00:00Z') };
const auth = createAuth({
  store: createMemoryAuthStore({ clock }),
  clock,
  hasher: createScryptHasher({ logN: 10 }),
});
```

Store contract tests should run against memory, SQLite (`node:sqlite` wrapped as `SqlClient`) and PostgreSQL when `ASPEC_TEST_POSTGRES_URL` is set (unique schema per file).

OIDC and HIBP tests must use local mocks; never call the public internet.

WebAuthn ceremony tests can use a software authenticator (ES256, `none` attestation) as in this module's `test/helpers/webauthn-authenticator.ts`.

Adapter tests should hit real Express 4 (`express4` package), Express 5, Fastify `inject()` and Hono `app.request()`.
