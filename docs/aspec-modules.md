# ASPEC Dev Modules reuse

Copied on 2026-10-02 from `D:/ASPEC Dev Modules/modules` into `packages/aspec`. ASPECTenant does not require that repository at runtime.

## Inspected

All 20 catalogue modules: api, api-keys, audit, auth, cache, config, db, errors, flags, jobs, notifications, observability, orgs, rate-limit, rbac, storage, testing, users, validation, webhooks.

## Copied and used

| Module | Use in this scaffold |
|--------|----------------------|
| `@aspec/api` | Versioned `/api` routes, OpenAPI, problem responses |
| `@aspec/auth` | Accounts, login, logout, sessions, password policy |
| `@aspec/users` | User profile records linked to auth ids |
| `@aspec/orgs` | Tenants (organisations), memberships and tenant context |
| `@aspec/rbac` | Seeded control-plane roles |
| `@aspec/audit` | Setup and auth audit events |
| `@aspec/db` | PostgreSQL in Docker, SQLite in tests |
| `@aspec/config` | Typed environment loading and secret redaction |
| `@aspec/errors` | HTTP problem types |
| `@aspec/validation` | Request validation used by `@aspec/api` |
| `@aspec/rate-limit` | Setup throttling and trusted-proxy client IP |
| `@aspec/observability` | Logs and `/livez` `/readyz` `/healthz` |
| `@aspec/testing` | Vendored for upcoming API contract tests. Not imported yet. |
| `@aspec/api-keys` | Vendored for future SoftDock/service identities. Not wired. |

## ASPECTenant-specific changes to copies

- Added `packages/tsconfig.base.json` so existing `extends: ../../tsconfig.base.json` still resolves after the path moved from `modules/<name>` to `packages/aspec/<name>`.
- `@aspec/orgs` `updateOrg` refreshes the cached default organisation so first-run setup can rename it in the same process.

## Inspected and not copied

| Module | Why not |
|--------|---------|
| cache | No shared cache layer yet. RBAC and sessions use SQL. |
| flags | No feature-flag product surface. |
| jobs | No worker process in this scaffold. |
| notifications | No outbound mailer. Auth returns tokens instead of sending mail. |
| storage | No blob store. Mail attachments are future work. |
| webhooks | SoftDock events are specified, not implemented. |
