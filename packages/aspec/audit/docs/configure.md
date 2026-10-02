# Configure

## Factory options (`createAuditLogger`)

| Option | Default | Description |
|--------|---------|-------------|
| `sink` / `sinks` | required | One or more sinks. The first store (memory or SQL) is the chain authority. |
| `redact` | built-in | `RedactorOptions` or a `Redactor` from `createRedactor()`. |
| `clock` | `Date.now` | Epoch-ms clock for tests. |
| `generateId` | UUID v7 | Event and checkpoint IDs. |
| `chain.hmacKey` | unset | HMAC key (≥32 bytes). Prefer reading from env. |
| `chain.hmacKeyId` | `k1` | Key identifier stored on events. |
| `chain.signingKey` / `verifyKey` | unset | Ed25519 keys for checkpoint signatures. |
| `streamOf` | `category` (+ `:tenantId`) | Maps an event to its hash chain stream. |
| `retention.defaultDays` | `90` | Days to keep events without a category override. |
| `retention.categories` | `{}` | Per-category days, for example `{ security: 365 }`. |
| `defaultCategory` | `system` | Used when category is omitted. |
| `securityActionPrefixes` | `['auth.','security.']` | Actions that default to security. |
| `useContext` | `true` | Enrich from AsyncLocalStorage. |
| `maxEventBytes` | `65536` | Canonical JSON size limit. |
| `maxDiffEntries` | `200` | Max field diffs per event. |
| `logger` | no-op | Receives secondary sink failures. |

## Environment variables (typical wiring)

| Name | Secret | Description |
|------|--------|-------------|
| `AUDIT_HMAC_KEY` | yes | HMAC key for the hash chain (≥32 bytes). |
| `AUDIT_JSONL_PATH` | no | Path for the JSON Lines sink. |
| `DATABASE_URL` | yes | PostgreSQL URL when using the SQL store. |

Never log `AUDIT_HMAC_KEY`. Pass it as `chain: { hmacKey: process.env.AUDIT_HMAC_KEY }` only after validating length.
