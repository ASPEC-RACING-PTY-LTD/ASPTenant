# AI integration

## Purpose

Structured logs, metrics, health probes and HTTP instrumentation.

## Use when

You need JSON logs, Prometheus metrics, Kubernetes probes or OTel-compatible spans without a mandatory full monitoring stack.

## Avoid when

You already run a complete Observability SDK and only need a thin glue layer.

## Prerequisites

Node.js >= 22.13. Optional framework peers and `@opentelemetry/api`.

## Integration steps

1. `pnpm add @aspec/observability`
2. `createLogger`, `createMetricsRegistry`, `createHealth`
3. Mount the framework adapter and endpoints
4. Optionally `createOtelHttpTracing` after configuring a TracerProvider

## Verification

```bash
pnpm --filter @aspec/observability test
curl -s localhost:3000/readyz
curl -s localhost:3000/metrics | head
```

## Common mistakes

- Using raw URLs as metric routes instead of route templates.
- Exposing `/metrics` publicly without a token.
- Logging passwords because custom fields bypass default key names (add redact paths).

## Uninstall

See `uninstall.md`.