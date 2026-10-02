# Changelog

## [1.0.1] - 2026-09-30

### Fixed

- A transaction or session client now runs one statement at a time on its connection. Callers that issued queries concurrently inside a transaction (for example `Promise.all` over several reads) relied on the `pg` driver's deprecated internal queue, which pg 9 removes.

## [1.0.0] - 2026-09-29

Initial release: PostgreSQL and SQLite clients, migrations, seeding, transactions, health checks, instrumentation, configuration validation and the `aspec-db` CLI.
