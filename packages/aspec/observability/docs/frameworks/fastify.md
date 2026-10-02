# Fastify

```ts
import Fastify from 'fastify';
import { createMetricsRegistry, createHealth } from '@aspec/observability';
import { fastifyObservability } from '@aspec/observability/fastify';

const registry = createMetricsRegistry();
const app = Fastify();
await app.register(fastifyObservability, {
  registry,
  endpoints: { health: createHealth({ checks: { self: async () => ({ ok: true }) } }), registry },
});
```