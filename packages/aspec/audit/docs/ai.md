# AI agent contract

## Purpose

Structured, tamper-evident audit logging with redaction, querying and retention.

## Use when

- You need immutable-ish records of who did what to which resource.
- Security events, admin changes or data mutations must be queryable later.

## Avoid when

- You only need application debug logs (use a logger).
- You need full SIEM ingestion without local storage (export via JSONL/console).

## Prerequisites

Node.js ≥22.13.0. Optional: Express/Fastify/Hono, a `SqlClient`, HMAC key env.

## Integration steps

1. Install `@aspec/audit`.
2. Create a store: `createMemoryAuditStore()` or `migrate(client)` then
   `createSqlAuditStore(client)`.
3. `const audit = createAuditLogger({ sink: store, chain: { hmacKey: process.env.AUDIT_HMAC_KEY }, retention: { defaultDays: 90, categories: { security: 365 } } })`.
4. Mount `auditContext` (or equivalent) before routes.
5. Call `audit.record({ action: 'resource.verb', ... })` from handlers.
6. Mount admin router with `authorize` or `permissions`.
7. On shutdown: `await audit.flush(); await audit.close()`.

## Configuration

See configure.md. Required secret in production: `AUDIT_HMAC_KEY`.

## Verification

```bash
pnpm --filter @aspec/audit test
# or in the app:
node -e "import('@aspec/audit').then(m => m.createAuditLogger({ sink: m.createMemoryAuditStore() }).record({ action: 'app.boot' }))"
```

Expect a stored event with `hash` and `seq: 1`.

## Common mistakes

- Omitting authorisation on the admin router (constructor throws).
- Using only console/JSONL and calling `query` (`AUDIT_NOT_QUERYABLE`).
- Putting passwords in metadata and assuming redaction covers every custom key
  (extend `redact.keys` for domain-specific names).

## Uninstall

See uninstall.md.
