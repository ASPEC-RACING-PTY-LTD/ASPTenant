# Fetch handler

Web Fetch API handler `(request: Request) => Promise<Response>`. Usable from runtimes that expose the Fetch API (for example Next.js route handlers). Those runtimes were not exercised in this module's test suite; the Fetch adapter itself was.

```ts
import { createAuth, readAuthEnv } from '@aspec/auth';
import { createMemoryAuthStore } from '@aspec/auth/memory';
import { createAuthFetchHandler } from '@aspec/auth/fetch';

const env = readAuthEnv(process.env);
const auth = createAuth({ store: createMemoryAuthStore() });
export const authHandler = createAuthFetchHandler(auth, {
  basePath: '/auth',
  allowedOrigins: env.allowedOrigins,
});

export async function GET(request: Request) {
  return authHandler(request);
}
export async function POST(request: Request) {
  return authHandler(request);
}
```
