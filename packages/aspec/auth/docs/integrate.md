# Integrate

## 1. Create a store

```ts
import { createMemoryAuthStore } from '@aspec/auth/memory';
// or: import { createSqlAuthStore, migrate } from '@aspec/auth/sql';

const store = createMemoryAuthStore();
```

For SQL, apply migrations once with `await migrate(client)` then `createSqlAuthStore(client)`.

## 2. Create the auth service

```ts
import { createAuth, readAuthEnv, signingFromEnv } from '@aspec/auth';

const env = readAuthEnv(process.env);
const auth = createAuth({
  store,
  appName: 'My App',
  links: {
    passwordReset: `${env.appUrl}/reset`,
    emailVerification: `${env.appUrl}/verify`,
  },
  tokens: env.secret
    ? {
        signing: signingFromEnv(env),
        issuer: env.appUrl ?? 'https://example.com',
        audience: env.appUrl ?? 'https://example.com',
      }
    : undefined,
  mfa: env.encryptionKey ? { encryptionKey: env.encryptionKey } : undefined,
});
```

Account `id` values are application user IDs. Pass `id` into `register` / `createAccount` when you already created a row in `@aspec/users` or your users table.

## 3. Mount an HTTP adapter (optional)

See `docs/frameworks/express.md`, `fastify.md`, `hono.md` or `fetch.md`. Always set `allowedOrigins` when cookie sessions are used.

## 4. Optional providers

```ts
import { createOidc, oidcPreset } from '@aspec/auth/oidc';
import { createWebAuthn } from '@aspec/auth/webauthn';

const oidc = createOidc(auth, {
  redirectUri: (id) => `${env.appUrl}/auth/oidc/${id}/callback`,
  providers: [oidcPreset('google', { clientId: '...', clientSecret: '...' })],
});

const webauthn = createWebAuthn(auth, {
  rpID: env.webauthnRpId!,
  origins: env.webauthnOrigins,
});
```

Pass `oidc` and `webauthn` into the HTTP adapter options to expose their routes.
