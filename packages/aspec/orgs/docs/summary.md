# Summary

`@aspec/orgs` manages organisations, teams, memberships and invitations. It
supports `mode: 'single'` (implicit default organisation) and `mode: 'multi'`
(create orgs, resolve tenants). Tenant strategies: shared rows, PostgreSQL
schema per tenant, or app-managed databases. Isolation uses AsyncLocalStorage
(`runWithTenant`) plus optional PostgreSQL RLS helpers. HTTP adapters: Express,
Fastify, Hono, Fetch.
