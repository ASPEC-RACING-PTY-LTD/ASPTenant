# Summary

`@aspec/rbac` is a standalone authorisation engine. Define permissions (`resource:action`) and roles with hierarchy, assign subjects in global, organisation or team scopes, grant resource-level and ownership permissions, and optionally attach attribute policies. Evaluate with `can`, `check`, `explain` and permission snapshots. HTTP middleware and an admin API cover Express, Fastify, Hono and Fetch; React guards consume a server snapshot for UX only. Authentication is external: pass a `Subject` from your session, JWT or Passport user.
