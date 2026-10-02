# Express

```ts
import express from 'express';
import { createMetricsRegistry, createHealth } from '@aspec/observability';
import { httpInstrumentation, observabilityEndpoints } from '@aspec/observability/express';

const registry = createMetricsRegistry();
const health = createHealth({ checks: { self: async () => ({ ok: true }) } });
const app = express();
app.use(observabilityEndpoints({ health, registry }));
app.use(httpInstrumentation({ registry, ignorePaths: ['/livez', '/readyz', '/healthz', '/metrics'] }));
```

Tested with Express 4.22.3 and 5.2.1.