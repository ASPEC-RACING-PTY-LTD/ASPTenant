# Testing

```bash
pnpm --filter @aspec/rate-limit test
```

With Redis-compatible services:

```powershell
$env:ASPEC_TEST_REDIS_URL='redis://127.0.0.1:56379'
pnpm --filter @aspec/rate-limit test
```

Redis store tests are skipped when `ASPEC_TEST_REDIS_URL` is unset. Inject a fake clock for deterministic algorithm tests:

```ts
const clock = { now: () => 1_000_000 };
const store = createMemoryStore({ clock });
const limiter = createRateLimiter({ store, policy: { name: 't', limit: 2, windowMs: 1000 }, clock });
```
