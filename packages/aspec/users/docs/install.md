# Install

## CLI

```bash
aspec add aspec/users
```

## npm / pnpm / yarn

```bash
pnpm add @aspec/users
```

## Peer dependencies per adapter

| Adapter | Peer |
|---------|------|
| `@aspec/users/express` | `express` `^4.18.0 \|\| ^5.0.0` |
| `@aspec/users/fastify` | `fastify` `^5.0.0` |
| `@aspec/users/hono` | `hono` `^4.0.0` |
| `@aspec/users/fetch` | none (Web Fetch API) |
| `@aspec/users/memory` | none |
| `@aspec/users/sql` | a `SqlClient` (from `@aspec/db` or an inline adapter) |

Node.js `>=22.13.0` is required.
