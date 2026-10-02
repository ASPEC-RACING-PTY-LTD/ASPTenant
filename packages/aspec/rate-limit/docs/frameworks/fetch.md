# Fetch API

```ts
import { createRateLimiter, keys } from '@aspec/rate-limit';
import { createMemoryStore } from '@aspec/rate-limit/memory';
import { createFetchRateLimiter } from '@aspec/rate-limit/fetch';

const limiter = createRateLimiter({
  store: createMemoryStore(),
  policy: { name: 'api', limit: 100, windowMs: 60_000 },
});

const rl = createFetchRateLimiter({
  limiter,
  key: keys.ip(),
  trustProxy: 1,
  getRemoteAddress: (req) => req.headers.get('x-real-ip') ?? undefined,
});

export async function handler(request: Request): Promise<Response> {
  const outcome = await rl.check(request);
  if (outcome.action === 'reject') return rl.rejection(outcome);
  const response = new Response('ok');
  return rl.applyHeaders(response, outcome);
}
```

The Fetch API does not expose the peer address. Without `getRemoteAddress` (and without trusted proxy headers) clients share the `ip:unknown` bucket. Can be used from runtimes that expose the Fetch API; only Node was tested.
