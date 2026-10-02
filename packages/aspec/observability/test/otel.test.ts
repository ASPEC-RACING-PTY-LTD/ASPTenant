import * as api from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpInstrumentation } from '../src/http.js';
import { createOtelHttpTracing, withSpan } from '../src/otel.js';
import { formatTraceparent, generateSpanId, generateTraceId } from '../src/trace-context.js';

describe('OpenTelemetry integration', () => {
  let provider: BasicTracerProvider | undefined;
  let exporter: InMemorySpanExporter | undefined;

  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
    exporter = undefined;
    api.context.disable();
  });

  it('creates server spans with semantic attributes via in-memory exporter', async () => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    api.trace.setGlobalTracerProvider(provider);
    api.context.setGlobalContextManager(new AsyncLocalStorageContextManager());

    const tracing = await createOtelHttpTracing({
      api: api as never,
      tracerProvider: provider,
    });
    const http = createHttpInstrumentation({ tracing });
    const tid = generateTraceId();
    const sid = generateSpanId();
    const state = http.start({
      method: 'GET',
      path: '/users/1',
      header: (name) =>
        name.toLowerCase() === 'traceparent'
          ? formatTraceparent({ traceId: tid, spanId: sid, traceFlags: 1 })
          : undefined,
      host: 'localhost',
      scheme: 'http',
    });
    await state.run(async () => {
      await Promise.resolve();
    });
    state.finish({ statusCode: 200, route: '/users/:id' });

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const span = spans[0];
    expect(span).toBeDefined();
    expect(span?.attributes['http.request.method']).toBe('GET');
    expect(span?.attributes['http.route']).toBe('/users/:id');
    expect(span?.attributes['http.response.status_code']).toBe(200);
    expect(span?.attributes['url.path']).toBe('/users/1');
    expect(span?.attributes['server.address']).toBe('localhost');

    const value = await withSpan({ name: 'work', api: api as never }, async () => 7);
    expect(value).toBe(7);
  });
});
