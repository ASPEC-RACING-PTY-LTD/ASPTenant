# Examples

## Per-user login throttle (fail closed)

```ts
const loginLimiter = createRateLimiter({
  store,
  policy: { name: 'login', limit: 5, windowMs: 15 * 60_000, algorithm: 'fixed-window' },
  failureMode: 'closed',
  penalty: { threshold: 3, banMs: 15 * 60_000, maxBanMs: 24 * 60_000 * 60 },
});

app.post('/login', rateLimit({ limiter: loginLimiter, key: keys.ip(), trustProxy: 1 }), handler);
```

## Combined IP and API-key limits

```ts
app.use(
  rateLimit({
    trustProxy: 1,
    rules: [
      { limiter: ipLimiter, key: keys.ip() },
      { limiter: keyLimiter, key: keys.apiKey() },
    ],
  }),
);
```

## Skip health checks

```ts
rateLimit({
  limiter,
  skip: (req) => req.path === '/healthz',
});
```

## Manual consume in a job

```ts
await limiter.limit(`job:${jobName}`);
```
