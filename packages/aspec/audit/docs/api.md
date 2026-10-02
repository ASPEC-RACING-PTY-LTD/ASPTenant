# API

## Core (`@aspec/audit`)

### `createAuditLogger(options): AuditLogger`

Creates a logger that implements the `AuditSink` port (`record`).

**Methods:** `record`, `recordSecurityEvent`, `query`, `count`, `getEvent`,
`listStreams`, `verifyChain`, `verifyAll`, `createCheckpoint`, `applyRetention`,
`flush`, `close`. Properties: `redactor`, `store`.

### Stores

- `createMemoryAuditStore(options?)` / `@aspec/audit/memory`
- `createSqlAuditStore(client, options?)`, `migrate(client)`, `migrations`,
  `installAppendOnlyTrigger(client)` / `@aspec/audit/sql`

### Sinks

- `createConsoleSink` / `@aspec/audit/console`
- `createJsonlFileSink`, `verifyJsonlLog` / `@aspec/audit/jsonl`
- `createBufferedSink` / `@aspec/audit/buffered`
- `createFanoutSink` / `@aspec/audit/fanout`

### Redaction and chain

- `createRedactor(options?)`, `REDACTED`
- `resolveChainKeys`, `verifyEvents`, `GENESIS_HASH`

### Context

- `runWithAuditContext`, `getAuditContext`, `setAuditActor`, `updateAuditContext`
- `createAuditAdminHandler`, `matchAdminPath`

### Errors

`AuditError` with `code`, `status`, `expose`. Codes include
`AUDIT_INVALID_EVENT`, `AUDIT_INVALID_QUERY`, `AUDIT_FORBIDDEN`,
`AUDIT_UNAUTHENTICATED`, `AUDIT_QUEUE_FULL`, `AUDIT_CHAIN_KEY_REQUIRED`.

## Adapters

| Subpath | Exports |
|---------|---------|
| `@aspec/audit/express` | `auditContext`, `auditAdminRouter` |
| `@aspec/audit/fastify` | `registerAuditContext`, `auditContextPlugin`, `auditAdminPlugin` |
| `@aspec/audit/hono` | `auditContext`, `createAuditAdminApp` |
| `@aspec/audit/fetch` | `withAuditContext`, `createAuditAdminFetchHandler` |
