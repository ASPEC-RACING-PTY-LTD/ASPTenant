# Uninstall

1. Remove imports of the generated setup file and stop calling `migrator.up()` on startup.
2. Remove `aspec-db` from npm scripts.
3. Uninstall the package: `pnpm remove @aspec/db` (and unused drivers).
4. Optionally drop `db_schema_migrations` and `db_seeds` (or your configured prefix). Application tables are left intact.
