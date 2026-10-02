# ADR-0002: Vendor selected ASPEC Dev Modules

## Status
Accepted

## Date
2026-10-02

## Context
Generic foundations (auth, users, orgs, RBAC, audit, SQL, config, errors, validation, API, rate limit, observability, testing, API keys) already exist as MIT packages in ASPEC Dev Modules.

## Decision
Copy the modules ASPECTenant needs into `packages/aspec` and depend on them through the workspace. Do not require `D:/ASPEC Dev Modules` at runtime.

## Alternatives considered

### npm / registry dependency
The catalogue is real, but a self-contained repository is required and the registry is a separate product.

### Reimplement the same services
Rejected. That duplicates security-sensitive code.

## Consequences
Upstream fixes must be copied deliberately. Application policy stays in `apps/api`, not inside the vendored cores.
