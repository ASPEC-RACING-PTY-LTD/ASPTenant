# @aspec/auth

Reusable authentication for Node.js applications: email and password, sessions, refresh tokens, password reset, email verification, lockout, TOTP MFA, OAuth 2.0 / OpenID Connect, and WebAuthn passkeys.

Install with the ASPEC CLI or npm, then wire a store and optional HTTP adapter. Full documentation is in `docs/`.

## Quick start

```ts
import { createAuth } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';

const auth = createAuth({
  store: createMemoryAuthStore(),
  appName: 'My App',
});

await auth.register({ email: 'user@example.com', password: 'correct-horse-battery' });
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
