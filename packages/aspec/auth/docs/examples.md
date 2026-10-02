# Examples

## Password login without HTTP

```ts
const reg = await auth.register({ email: 'a@example.com', password: 'correct-horse-battery' });
if (reg.verificationToken) await auth.verifyEmail({ token: reg.verificationToken });
const result = await auth.login({ email: 'a@example.com', password: 'correct-horse-battery' });
if (result.status === 'authenticated') {
  // store result.sessionToken in a cookie via sessionCookie()
}
```

## API tokens

```ts
const auth = createAuth({
  store,
  tokens: {
    signing: { alg: 'HS256', secret: process.env.AUTH_SECRET! },
    issuer: 'https://app.example',
    audience: 'https://api.example',
  },
});
const login = await auth.login({ email, password, issueTokens: true });
if (login.status === 'authenticated' && login.tokens) {
  const refreshed = await auth.refresh(login.tokens.refreshToken);
}
```

## SQL store

```ts
import { createSqlAuthStore, migrate } from '@aspec/auth/sql';
import type { SqlClient } from '@aspec/auth';

await migrate(client);
const store = createSqlAuthStore(client, { tablePrefix: 'auth_' });
```
