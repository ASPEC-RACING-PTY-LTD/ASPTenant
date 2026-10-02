# Testing

## Unit tests

Inject `clock` and `generateId`, use `createMemoryUsersStore()`, and fake ports:

```ts
const mailer = { sent: [] as unknown[], async send(m) { this.sent.push(m); return {}; } };
const users = createUsers({ store: createMemoryUsersStore(), mailer, clock: { now: () => 1 } });
```

## Store contract

Exercise the same assertions against memory, SQLite and PostgreSQL. Use a unique
PostgreSQL schema per file when `ASPEC_TEST_POSTGRES_URL` is set, and drop it in
`afterAll`.

## Adapter tests

Drive Express with an ephemeral `http.Server` and `fetch`, Fastify with
`app.inject()`, Hono with `app.request()`, and Fetch handlers directly.

## Verification commands

```powershell
pnpm --filter @aspec/users test
pnpm --filter @aspec/users typecheck
```
