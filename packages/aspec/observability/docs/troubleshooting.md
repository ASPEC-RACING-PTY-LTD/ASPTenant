# Troubleshooting

## `OBSERVABILITY_INVALID_CONFIG`

An option failed validation (level, buckets, endpoint path, token length). Check the error message path.

## `OBSERVABILITY_METRIC_CONFLICT`

A metric was re-registered with different type, help, labels or buckets. Reuse `registry.getMetric(name)` instead.

## Cardinality warnings

Label sets exceeded `maxLabelSets`. Reduce unbound label values (never use raw user IDs as labels).

## Readiness failing after deploy

`health.drain()` or graceful shutdown is active, or a critical check is failing/timing out.