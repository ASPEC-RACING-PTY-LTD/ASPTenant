# Fetch

```ts
import { createMetricsRegistry, createHealth } from '@aspec/observability';
import { withObservability } from '@aspec/observability/fetch';

const registry = createMetricsRegistry();
export const handler = withObservability(async (req) => Response.json({ ok: true }), {
  registry,
  getRoute: () => '/api',
  endpoints: { health: createHealth({ checks: { self: async () => ({ ok: true }) } }), registry },
});
```