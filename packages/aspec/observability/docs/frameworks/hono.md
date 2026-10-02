# Hono

```ts
import { Hono } from 'hono';
import { createMetricsRegistry, createHealth } from '@aspec/observability';
import { observability } from '@aspec/observability/hono';

const registry = createMetricsRegistry();
const app = new Hono();
app.use('*', observability({
  registry,
  endpoints: { health: createHealth({ checks: { self: async () => ({ ok: true }) } }), registry },
}));
```