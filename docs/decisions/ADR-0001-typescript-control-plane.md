# ADR-0001: TypeScript control plane on Node.js 22

## Status
Accepted

## Date
2026-10-02

## Context
ASPECTenant needs a self-hosted API and admin UI. ASPEC Dev Modules already implement identity, RBAC, audit, SQL and HTTP adapters in TypeScript for Node.js 22.13+.

## Decision
Use Node.js 22+, TypeScript ESM, Hono for the API, React for the admin UI, and PostgreSQL as the system of record.

## Alternatives considered

### Go control plane
Matches some other ASPEC products. Rejected for this repo because it cannot reuse the existing TypeScript modules without a rewrite.

### Next.js monolith
Heavier than needed for a Docker-first admin UI and would blur API/UI boundaries.

## Consequences
The team must keep Node 22 as the minimum. Modules compile to `dist/` and are consumed as workspace packages.
