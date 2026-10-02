# Changelog

## [1.0.0] - 2026-09-29

### Added

- Structured audit logger with actor, action, resource, outcome, category, tenant and correlation fields.
- Before-and-after change metadata with field-level diffs.
- Deep, cycle-safe sensitive-data redaction before hashing and storage.
- Per-stream SHA-256 and HMAC-SHA-256 hash chains with precise verification reports.
- Optional Ed25519 signed checkpoints for retention and attestation.
- Memory and SQL (PostgreSQL, SQLite) stores with cursor querying and retention.
- Console, JSON Lines (rotation, fsync), fan-out and buffered sinks.
- Correlation middleware and admin query routers for Express 4/5, Fastify, Hono and Fetch.
