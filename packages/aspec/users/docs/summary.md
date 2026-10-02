# Summary

`@aspec/users` manages user accounts for Node.js apps: creation, profiles, typed
settings and preferences, suspension with optional expiry, activation tokens,
invitations, soft deletion with a grace period and purge, and append-only activity
history.

Use it when you need account lifecycle beyond authentication. Pair it with
`@aspec/auth` for sign-in and `@aspec/rbac` for permissions through structural
ports. Stores: memory or SQL (PostgreSQL, SQLite). HTTP adapters: Express,
Fastify, Hono, and Fetch.
