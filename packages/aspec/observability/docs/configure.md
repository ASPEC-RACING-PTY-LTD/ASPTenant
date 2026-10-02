# Configure

## Environment

| Name | Description |
|------|-------------|
| `LOG_LEVEL` | Minimum level (`trace`..`fatal` or `silent`). Default `info`. |

## Logger

`createLogger({ level, bindings, redact, destination, pretty, context, mixin, time, clock })`.

Default redaction covers password, token, authorization, cookie and similar keys.

## Metrics

`createMetricsRegistry({ prefix, defaultLabels, maxLabelSets, logger })`.

## Health

`createHealth({ checks, timeoutMs, cacheTtlMs, detail, logger, clock })`. Call `health.drain()` during shutdown so readiness fails while liveness stays up.

## Endpoints

`createObservabilityEndpoints({ health, registry, paths, detailToken, metricsToken })`. Tokens must be at least 16 characters and are compared in constant time.