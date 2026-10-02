import {
  createRequestContext,
  type RequestContext,
  type RequestIdOptions,
  resolveRequestIdOptions,
  runWithRequestContext,
  type TraceOptions,
} from './context.js';
import { configError } from './errors.js';
import type { CaptureError } from './instrument.js';
import {
  DEFAULT_HTTP_DURATION_BUCKETS,
  DEFAULT_SIZE_BUCKETS,
  type Gauge,
  type Histogram,
  type MetricsRegistry,
} from './metrics.js';
import type { LoggerLike } from './ports.js';

/** Request information adapters extract from their framework. */
export interface HttpRequestInfo {
  method: string;
  /** Path without the query string. Used for span attributes and ignorePaths, never as a metric label. */
  path: string;
  header(name: string): string | undefined;
  scheme?: string;
  /** Host name (without port) the request was addressed to. */
  host?: string;
  port?: number;
  clientAddress?: string;
  /** Request body size from Content-Length, when known. */
  requestSize?: number;
}

export interface HttpFinishInfo {
  statusCode: number;
  /** Route template such as `/users/:id`; undefined when no route matched. */
  route?: string;
  responseSize?: number;
  error?: unknown;
  /** The client closed the connection before the response finished. */
  aborted?: boolean;
}

/** A server span started by an HttpTracing implementation (see `@aspec/observability/otel`). */
export interface HttpSpan {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly traceFlags?: number;
  /** Runs fn with the span active in the tracing library's context. */
  run<T>(fn: () => T): T;
  end(info: HttpFinishInfo): void;
}

export interface HttpTracing {
  startServerSpan(info: HttpRequestInfo): HttpSpan;
}

export interface HttpInstrumentationOptions {
  /** Records HTTP metrics when set. */
  registry?: MetricsRegistry;
  logger?: LoggerLike;
  /** Receives unhandled request errors and 5xx errors raised by handlers. */
  captureError?: CaptureError;
  requestId?: RequestIdOptions;
  trace?: TraceOptions;
  /** Distributed tracing integration, for example createOtelHttpTracing() from ./otel. */
  tracing?: HttpTracing;
  /** Duration histogram buckets in seconds. Default DEFAULT_HTTP_DURATION_BUCKETS. */
  durationBuckets?: readonly number[];
  /** Record request and response body sizes from Content-Length. Default true. */
  recordSizes?: boolean;
  sizeBuckets?: readonly number[];
  /** Exact paths that are not measured, traced or logged (request context still applies). */
  ignorePaths?: readonly string[];
  /** Access logs: every request, only 5xx (`errors`), or none. Default false. */
  logRequests?: boolean | 'errors';
  /** Route label for requests that matched no route. Default `unmatched`. */
  unmatchedRoute?: string;
  /** Echo the request ID in a response header. Default true. */
  responseHeader?: boolean;
}

export interface HttpMetrics {
  duration: Histogram;
  active: Gauge;
  requestSize?: Histogram;
  responseSize?: Histogram;
}

export interface HttpRequestState {
  readonly context: RequestContext;
  readonly requestId: string;
  /** Headers the adapter should set on the response (the request ID). */
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly ignored: boolean;
  /** Runs fn inside the request context (and the active span, when tracing). */
  run<T>(fn: () => T): T;
  /** Records an error raised while handling the request; reported when the request finishes. */
  recordError(error: unknown): void;
  /** Records metrics, ends the span and writes the access log. Only the first call has effect. */
  finish(info: HttpFinishInfo): void;
}

export interface HttpInstrumentation {
  readonly metrics: HttpMetrics | undefined;
  readonly requestIdHeader: string;
  start(info: HttpRequestInfo): HttpRequestState;
}

const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
  'QUERY',
]);

/** Upper-cases known methods and maps anything else to `_OTHER` (OpenTelemetry convention). */
export function normaliseMethod(method: string): string {
  const upper = typeof method === 'string' ? method.toUpperCase() : '';
  return KNOWN_METHODS.has(upper) ? upper : '_OTHER';
}

export function parseContentLength(value: string | number | undefined | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * Framework-agnostic HTTP server instrumentation used by every adapter: request context
 * (request ID, trace context), duration histogram by method, route template and status
 * code, in-flight gauge, body sizes, tracing spans, error capture and access logs.
 */
export function createHttpInstrumentation(
  options: HttpInstrumentationOptions = {},
): HttpInstrumentation {
  const requestId = resolveRequestIdOptions(options.requestId);
  const trace = options.trace ?? {};
  const unmatched = options.unmatchedRoute ?? 'unmatched';
  if (typeof unmatched !== 'string' || unmatched.length === 0)
    throw configError('http.unmatchedRoute', 'must be a non-empty string');
  const logRequests = options.logRequests ?? false;
  if (logRequests !== true && logRequests !== false && logRequests !== 'errors') {
    throw configError('http.logRequests', 'must be true, false or "errors"');
  }
  const ignore = new Set(options.ignorePaths ?? []);
  const responseHeader = options.responseHeader ?? true;
  const logger = options.logger;
  const registry = options.registry;

  let metrics: HttpMetrics | undefined;
  if (registry) {
    metrics = {
      duration: registry.histogram({
        name: 'http_server_request_duration_seconds',
        help: 'Duration of HTTP server requests in seconds.',
        labelNames: ['method', 'route', 'status_code'],
        buckets: options.durationBuckets ?? DEFAULT_HTTP_DURATION_BUCKETS,
      }),
      active: registry.gauge({
        name: 'http_server_active_requests',
        help: 'Number of HTTP server requests in flight.',
        labelNames: ['method'],
      }),
    };
    if (options.recordSizes !== false) {
      const buckets = options.sizeBuckets ?? DEFAULT_SIZE_BUCKETS;
      metrics.requestSize = registry.histogram({
        name: 'http_server_request_body_size_bytes',
        help: 'Size of HTTP server request bodies in bytes (from Content-Length).',
        labelNames: ['method', 'route'],
        buckets,
      });
      metrics.responseSize = registry.histogram({
        name: 'http_server_response_body_size_bytes',
        help: 'Size of HTTP server response bodies in bytes (from Content-Length).',
        labelNames: ['method', 'route'],
        buckets,
      });
    }
  }

  return {
    metrics,
    requestIdHeader: requestId.header,
    start(info) {
      const context = createRequestContext(
        {
          requestIdHeader: info.header(requestId.header),
          traceparent: info.header('traceparent'),
          tracestate: info.header('tracestate'),
        },
        requestId,
        trace,
      );
      const ignored = ignore.has(info.path);
      const method = normaliseMethod(info.method);
      const startedAt = process.hrtime.bigint();
      let span: HttpSpan | undefined;
      if (!ignored && options.tracing) {
        try {
          span = options.tracing.startServerSpan(info);
        } catch (error) {
          logger?.warn({ err: error }, 'tracing failed to start a server span');
        }
        if (span?.traceId && span.spanId) {
          context.traceId = span.traceId;
          context.spanId = span.spanId;
          if (span.traceFlags !== undefined) context.traceFlags = span.traceFlags;
        }
      }
      if (!ignored) metrics?.active.inc({ method });
      let recorded: unknown;
      let finished = false;
      const responseHeaders: Record<string, string> = responseHeader
        ? { [requestId.header]: context.requestId }
        : {};

      return {
        context,
        requestId: context.requestId,
        responseHeaders,
        ignored,
        run: (fn) => runWithRequestContext(context, span ? () => span.run(fn) : fn),
        recordError(error) {
          recorded ??= error;
        },
        finish(result) {
          if (finished) return;
          finished = true;
          const error = result.error ?? recorded;
          const route = result.route && result.route.length > 0 ? result.route : unmatched;
          const status = Number.isInteger(result.statusCode) ? result.statusCode : 0;
          const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
          if (!ignored) {
            metrics?.active.dec({ method });
            metrics?.duration.observe({ method, route, status_code: String(status) }, seconds);
            if (info.requestSize !== undefined)
              metrics?.requestSize?.observe({ method, route }, info.requestSize);
            if (result.responseSize !== undefined)
              metrics?.responseSize?.observe({ method, route }, result.responseSize);
            try {
              span?.end(error === undefined ? result : { ...result, error });
            } catch (spanError) {
              logger?.warn({ err: spanError }, 'tracing failed to end a server span');
            }
          }
          runWithRequestContext(context, () => {
            if (error !== undefined && options.captureError) {
              options.captureError(error, { source: 'http', method, route, statusCode: status });
            }
            if (ignored || !logger || logRequests === false) return;
            if (logRequests === 'errors' && status < 500) return;
            const fields = {
              req: { method, path: info.path },
              res: { statusCode: status },
              route,
              durationMs: Math.round(seconds * 1e6) / 1000,
              ...(result.aborted ? { aborted: true } : {}),
            };
            if (status >= 500) logger.error(fields, 'request failed');
            else logger.info(fields, 'request completed');
          });
        },
      };
    },
  };
}
