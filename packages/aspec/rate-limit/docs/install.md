# Install

```bash
pnpm add @aspec/rate-limit
# or
npm install @aspec/rate-limit
```

Optional peers for adapters and Redis clients:

```bash
pnpm add express          # Express adapter
pnpm add fastify          # Fastify adapter
pnpm add hono             # Hono adapter
pnpm add ioredis          # Redis via ioredis
pnpm add redis            # Redis via node-redis
```

Requires Node.js 22.13 or newer. Vendor mode copies `src/` (or `dist/` for JavaScript) into your project; see the CLI `aspec add aspec/rate-limit --mode vendor`.
