# Examples

## Prometheus scrape

```ts
const text = await registry.metrics();
// Content-Type: text/plain; version=0.0.4; charset=utf-8
```

## OpenTelemetry HTTP spans

```ts
import { createOtelHttpTracing } from '@aspec/observability/otel';
import { createHttpInstrumentation } from '@aspec/observability';

const tracing = await createOtelHttpTracing();
const http = createHttpInstrumentation({ tracing, registry });
```

Configure a `TracerProvider` and OTLP exporter in the application SDK. OTLP export itself is untested in this module.