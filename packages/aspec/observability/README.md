# @aspec/observability

Structured JSON logging, request correlation, Prometheus metrics, health/readiness/liveness checks, HTTP instrumentation for Express, Fastify, Hono and Fetch, plus optional OpenTelemetry tracing. The core has zero runtime dependencies.

## Install

```bash
pnpm add @aspec/observability
```

## Quick start

```ts
import { createLogger, createMetricsRegistry, createHealth } from '@aspec/observability';

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info' });
const registry = createMetricsRegistry();
const health = createHealth({ checks: { self: async () => ({ ok: true }) } });
log.info('ready');
```

See [docs/integrate.md](docs/integrate.md).

## Licence

MIT