# Integrate

```ts
import {
  createLogger,
  createMetricsRegistry,
  createHealth,
  registerProcessMetrics,
  createErrorCapture,
  installGracefulShutdown,
} from '@aspec/observability';

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info', bindings: { service: 'api' } });
const registry = createMetricsRegistry({ prefix: 'app_' });
registerProcessMetrics(registry);
const health = createHealth({
  checks: { self: async () => ({ ok: true }) },
});
const captureError = createErrorCapture({ logger: log, registry });
installGracefulShutdown(health, {
  logger: log,
  onShutdown: async () => { /* close servers */ },
});
```

Mount a framework adapter from `frameworks/*` for HTTP metrics and `/livez`, `/readyz`, `/healthz`, `/metrics`.