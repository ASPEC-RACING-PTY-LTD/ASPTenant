# Uninstall

1. Remove middleware and admin router registrations from your application.
2. Stop calling `createAuditLogger` and delete the generated setup file
   (`src/aspec/audit.setup.ts` or similar).
3. Remove the `@aspec/audit` dependency (and unused peers).
4. Drop SQL tables if you no longer need the history:

```sql
DROP TABLE IF EXISTS audit_events CASCADE;
DROP TABLE IF EXISTS audit_stream_heads CASCADE;
DROP TABLE IF EXISTS audit_checkpoints CASCADE;
DROP TABLE IF EXISTS audit_schema_migrations CASCADE;
```

Adjust names if you used a custom `tablePrefix`. JSON Lines files are not deleted
automatically; remove them from disk yourself. Retention policies do not run after
uninstall.
