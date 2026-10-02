# API

## Core (`@aspec/observability`)

- Logging: `createLogger`, `createNoopLogger`, destinations, redaction helpers.
- Context: `runWithRequestContext`, `getRequestId`, `injectTraceHeaders`, traceparent helpers.
- Metrics: `createMetricsRegistry`, `exponentialBuckets`, `linearBuckets`, `registerProcessMetrics`.
- Health: `createHealth`, `createObservabilityEndpoints`.
- Instrumentation: `createErrorCapture`, `createPerformance`, `startTimer`, `createHttpInstrumentation`, `installProcessErrorHandlers`, `installGracefulShutdown`.
- Errors: `ObservabilityError`, `ObservabilityConfigError`.

## Adapters

- `@aspec/observability/express`: `httpInstrumentation`, `observabilityEndpoints`, `errorHandler`
- `@aspec/observability/fastify`: `fastifyObservability`
- `@aspec/observability/hono`: `observability`
- `@aspec/observability/fetch`: `withObservability`, `createFetchObservability`
- `@aspec/observability/otel`: `createOtelHttpTracing`, `withSpan`, `createOtelLogMixin`, `bridgeMetricsToOtel`