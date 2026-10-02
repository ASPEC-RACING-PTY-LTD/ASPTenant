# Uninstall

1. Remove Express/Fastify/Hono/Fetch mounts that use `@aspec/users` adapters.
2. Unregister `users.purge` and `users.maintenance` job handlers.
3. Remove `createUsers` setup from the application.
4. Uninstall the package: `pnpm remove @aspec/users`.
5. If you used SQL and no longer need the data:

```sql
DROP TABLE IF EXISTS users_activity;
DROP TABLE IF EXISTS users_invitations;
DROP TABLE IF EXISTS users_activation_tokens;
DROP TABLE IF EXISTS users_accounts;
DROP TABLE IF EXISTS users_schema_migrations;
```

Adjust names if you configured a custom `tablePrefix`.
