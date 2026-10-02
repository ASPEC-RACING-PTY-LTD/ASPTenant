import type {
  Context,
  Meter,
  Span,
  SpanKind,
  SpanOptions,
  SpanStatusCode,
  Tracer,
  TracerProvider,
} from '@opentelemetry/api';
import type { HttpFinishInfo, HttpRequestInfo, HttpSpan, HttpTracing } from './http.js';
import { normaliseMethod } from './http.js';
import type { MetricsRegistry } from './metrics.js';
import { parseTraceparent } from './trace-context.js';

export interface OtelApi {
  context: {
    active(): Context;
    with<T>(context: Context, fn: () => T): T;
  };
  propagation: {
    extract(
      context: Context,
      carrier: unknown,
      getter: {
        get(carrier: unknown, key: string): string | undefined;
        keys(carrier: unknown): string[];
      },
    ): Context;
  };
  trace: {
    getTracer(name: string, version?: string): Tracer;
    setSpan(context: Context, span: Span): Context;
    getSpan(context: Context): Span | undefined;
  };
  SpanStatusCode: { OK: SpanStatusCode; ERROR: SpanStatusCode; UNSET: SpanStatusCode };
  SpanKind: { SERVER: SpanKind; INTERNAL: SpanKind };
}

async function loadOtelApi(): Promise<OtelApi> {
  const api = await import('@opentelemetry/api');
  return api as unknown as OtelApi;
}

export interface OtelHttpTracingOptions {
  /** Tracer name. Default `@aspec/observability`. */
  name?: string;
  /** Tracer version. Default `1.0.0`. */
  version?: string;
  tracer?: Tracer;
  /** Pre-loaded API (avoids dynamic import in tests). */
  api?: OtelApi;
  tracerProvider?: TracerProvider;
}

class OtelHttpSpan implements HttpSpan {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly traceFlags?: number;
  private readonly api: OtelApi;
  private readonly span: Span;
  private readonly parentContext: Context;

  constructor(api: OtelApi, span: Span, parentContext: Context) {
    this.api = api;
    this.span = span;
    this.parentContext = parentContext;
    const sc = span.spanContext();
    if (sc.traceId) this.traceId = sc.traceId;
    if (sc.spanId) this.spanId = sc.spanId;
    if (sc.traceFlags !== undefined) this.traceFlags = sc.traceFlags;
  }

  run<T>(fn: () => T): T {
    return this.api.context.with(this.api.trace.setSpan(this.parentContext, this.span), fn);
  }

  end(info: HttpFinishInfo): void {
    if (info.route) this.span.setAttribute('http.route', info.route);
    this.span.setAttribute('http.response.status_code', info.statusCode);
    if (info.error !== undefined) {
      if (info.error instanceof Error) this.span.recordException(info.error);
      this.span.setStatus({
        code: this.api.SpanStatusCode.ERROR,
        message: info.error instanceof Error ? info.error.message : 'request error',
      });
    } else if (info.statusCode >= 500) {
      this.span.setStatus({ code: this.api.SpanStatusCode.ERROR });
    } else {
      this.span.setStatus({ code: this.api.SpanStatusCode.OK });
    }
    this.span.end();
  }
}

/**
 * OpenTelemetry HTTP server tracing. Requires the optional peer `@opentelemetry/api` and an
 * application-configured TracerProvider (for example `@opentelemetry/sdk-node`). OTLP export is
 * configured by the application SDK; this module does not ship an exporter.
 */
export async function createOtelHttpTracing(
  options: OtelHttpTracingOptions = {},
): Promise<HttpTracing> {
  const api = options.api ?? (await loadOtelApi());
  const tracer =
    options.tracer ??
    options.tracerProvider?.getTracer(
      options.name ?? '@aspec/observability',
      options.version ?? '1.0.0',
    ) ??
    api.trace.getTracer(options.name ?? '@aspec/observability', options.version ?? '1.0.0');

  const getter = {
    get(carrier: unknown, key: string): string | undefined {
      if (!carrier || typeof carrier !== 'object') return undefined;
      return (carrier as HttpRequestInfo).header?.(key);
    },
    keys(carrier: unknown): string[] {
      if (!carrier || typeof carrier !== 'object') return [];
      const info = carrier as HttpRequestInfo;
      const keys: string[] = [];
      if (info.header('traceparent')) keys.push('traceparent');
      if (info.header('tracestate')) keys.push('tracestate');
      return keys;
    },
  };

  return {
    startServerSpan(info: HttpRequestInfo): HttpSpan {
      const parent = api.propagation.extract(api.context.active(), info, getter);
      const method = normaliseMethod(info.method);
      const attributes: Record<string, string | number> = {
        'http.request.method': method,
        'url.path': info.path,
      };
      if (info.scheme) attributes['url.scheme'] = info.scheme;
      if (info.host) attributes['server.address'] = info.host;
      if (info.port !== undefined) attributes['server.port'] = info.port;
      if (info.clientAddress) attributes['client.address'] = info.clientAddress;
      const spanOptions: SpanOptions = {
        kind: api.SpanKind.SERVER,
        attributes,
      };
      // Ensure invalid traceparent does not break span creation (parse for validation only).
      parseTraceparent(info.header('traceparent'));
      const span = tracer.startSpan(method, spanOptions, parent);
      return new OtelHttpSpan(api, span, parent);
    },
  };
}

export interface WithSpanOptions {
  name: string;
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  tracer?: Tracer;
  api?: OtelApi;
}

/**
 * Runs fn inside an INTERNAL span. Requires `@opentelemetry/api` and a registered TracerProvider.
 */
export async function withSpan<T>(options: WithSpanOptions, fn: () => T | Promise<T>): Promise<T> {
  const api = options.api ?? (await loadOtelApi());
  const tracer = options.tracer ?? api.trace.getTracer('@aspec/observability', '1.0.0');
  const spanOptions: SpanOptions = {
    kind: options.kind ?? api.SpanKind.INTERNAL,
  };
  if (options.attributes !== undefined) spanOptions.attributes = options.attributes;
  const span = tracer.startSpan(options.name, spanOptions);
  try {
    const result = await api.context.with(api.trace.setSpan(api.context.active(), span), fn);
    span.setStatus({ code: api.SpanStatusCode.OK });
    return result;
  } catch (error) {
    if (error instanceof Error) span.recordException(error);
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : 'error',
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Returns a logger mixin that adds `traceId` and `spanId` from the active OpenTelemetry span.
 */
export async function createOtelLogMixin(
  options: { api?: OtelApi } = {},
): Promise<() => Record<string, unknown> | undefined> {
  const api = options.api ?? (await loadOtelApi());
  return () => {
    const span = api.trace.getSpan(api.context.active());
    if (!span) return undefined;
    const sc = span.spanContext();
    if (!sc.traceId || !sc.spanId) return undefined;
    return { traceId: sc.traceId, spanId: sc.spanId };
  };
}

export interface MetricsBridgeOptions {
  registry: MetricsRegistry;
  meter?: Meter;
  /** Meter name. Default `@aspec/observability`. */
  name?: string;
  api?: OtelApi & { metrics: { getMeter(name: string, version?: string): Meter } };
}

/**
 * Optional bridge: prepares observable instruments for registry metrics. Prefer Prometheus
 * exposition for scraping; use this when the app already exports metrics via OTLP. Call the
 * returned function after collect if you wire custom callbacks.
 */
export async function bridgeMetricsToOtel(
  options: MetricsBridgeOptions,
): Promise<() => Promise<void>> {
  const api = options.api ?? ((await loadOtelApi()) as MetricsBridgeOptions['api']);
  if (!api?.metrics) {
    throw new Error('@opentelemetry/api metrics API is not available');
  }
  const meter =
    options.meter ?? api.metrics.getMeter(options.name ?? '@aspec/observability', '1.0.0');
  const counters = new Map<string, ReturnType<Meter['createObservableCounter']>>();
  const gauges = new Map<string, ReturnType<Meter['createObservableGauge']>>();

  return async () => {
    const snap = await options.registry.snapshot();
    for (const metric of snap.metrics) {
      if (metric.type === 'counter') {
        if (!counters.has(metric.name)) {
          counters.set(
            metric.name,
            meter.createObservableCounter(metric.name, { description: metric.help }),
          );
        }
      } else if (metric.type === 'gauge') {
        if (!gauges.has(metric.name)) {
          gauges.set(
            metric.name,
            meter.createObservableGauge(metric.name, { description: metric.help }),
          );
        }
      }
    }
  };
}
