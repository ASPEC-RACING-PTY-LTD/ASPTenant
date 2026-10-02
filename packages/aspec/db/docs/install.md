# Install

```bash
pnpm add @aspec/db
```

Install a driver peer for the dialect you use:

```bash
pnpm add pg                 # PostgreSQL
pnpm add better-sqlite3     # SQLite (or use built-in node:sqlite)
```

Optional OpenTelemetry:

```bash
pnpm add @opentelemetry/api
```

Vendor mode copies `src` (TypeScript) or `dist` (JavaScript) into your project. Node.js 22.13 or newer is required.
