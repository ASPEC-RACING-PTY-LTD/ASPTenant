# Testing

```bash
pnpm --filter @aspec/observability test
```

Use `memoryDestination()` to assert log lines. For tracing tests, register `@opentelemetry/sdk-trace-base` `InMemorySpanExporter` with `AsyncLocalStorageContextManager`.