# ADR-0003: Single-organisation mode with multi-tenant-ready data

## Status
Accepted

## Date
2026-10-02

## Context
The first deployment is one organisation. The long-term model must not paint the product into a single global user table.

## Decision
Run `@aspec/orgs` in `single` mode. Create the default organisation at startup. Attach the first user as owner. New product tables should include a tenant/organisation id.

## Alternatives considered

### Multi-tenant from day one
More isolation work than the first installation needs.

### No organisation record
Would force a rewrite when the second tenant appears.

## Consequences
`createOrg` is unavailable until mode changes to `multi`. `getDefaultOrg()` is the current entry point.
