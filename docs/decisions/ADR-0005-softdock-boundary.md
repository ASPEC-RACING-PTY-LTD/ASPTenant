# ADR-0005: SoftDock remains an external integrator

## Status
Accepted

## Date
2026-10-02

## Context
SoftDock will eventually have native integration. `D:/SoftDock` was empty when inspected, so no implementation could be reused. The products must stay separable.

## Decision
SoftDock authenticates as an external application through future service identities, versioned APIs and events. No SoftDock code, UI or data model is included here.

## Alternatives considered

### Shared database
Creates tight coupling and unclear ownership.

### Implement SoftDock features inside ASPECTenant
Out of scope.

## Consequences
Integration work waits on documented APIs. See `docs/softdock-integration.md`.
