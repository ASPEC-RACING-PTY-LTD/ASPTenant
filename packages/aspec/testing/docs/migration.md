# Migration

This module has no application persistent state and no production migrations.

Test SQL helpers expose `migrate(client, migrations)` for **your** test schemas. Migration IDs are recorded in `testing_schema_migrations` by default (configurable via `MigrateOptions.table`). PostgreSQL fixtures create a random schema and drop it on `close()` / `cleanupAll()`.

When upgrading `@aspec/testing`, regenerate scaffolded example files only if you want the latest templates; existing project files are never overwritten by `aspec-testing init`.
