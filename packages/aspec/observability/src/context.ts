import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { configError } from './errors.js';
import {
  formatTraceparent,
  formatTracestate,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  parseTracestate,
  type TraceStateEntry,
} from './trace-context.js';

/**
 * Per-request correlation data carried through async boundaries with AsyncLocalStorage.
 * `bindings` is mutable so application code can add fields (for example a user ID) that are
 * then attached to every log line written during the request.
 */
export interface RequestContext {
  requestId: string;
  traceId?: string;
  /** The span ID of the current hop (used as parent-id when propagating). */
  spanId?: string;
  /** The span ID received from the caller, when a valid traceparent arrived. */
  parentSpanId?: string;
  traceFlags?: number;
  traceState?: readonly TraceStateEntry[];
  bindings: Record<string, unknown>;
}

/**
 * One storage instance per loaded copy of the module. It holds no configuration, only the
 * correlation data for the async execution that is currently running.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/** Runs fn with ctx as the active request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the active request context, if any. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Returns the active request ID, if any. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Adds fields to the active request context; they are attached to every subsequent log line
 * written within the request. Returns false when no request context is active.
 */
export function addRequestBindings(bindings: Record<string, unknown>): boolean {
  const ctx = storage.getStore();
  if (!ctx) return false;
  Object.assign(ctx.bindings, bindings);
  return true;
}

export interface RequestIdOptions {
  /** Header carrying the request ID. Default `x-request-id`. */
  header?: string;
  /** Accept a valid incoming request ID. Default true. Set false at untrusted edges. */
  trustIncoming?: boolean;
  /** Maximum accepted length of an incoming ID. Default 128 (hard limit 256). */
  maxLength?: number;
  /** Generator for new IDs. Default `crypto.randomUUID`. */
  generate?: () => string;
}

export interface TraceOptions {
  /** Continue the trace from a valid incoming `traceparent`. Default true. */
  propagate?: boolean;
  /** Generate trace and span IDs when no valid traceparent arrives. Default true. */
  generate?: boolean;
  /** Trace flags for generated traces: whether to mark them sampled. Default false. */
  sampled?: boolean;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:@-]+$/;

export interface ResolvedRequestIdOptions {
  header: string;
  trustIncoming: boolean;
  maxLength: number;
  generate: () => string;
}

export function resolveRequestIdOptions(options: RequestIdOptions = {}): ResolvedRequestIdOptions {
  const header = (options.header ?? 'x-request-id').toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(header)) {
    throw configError('requestId.header', 'must be a header name of 1 to 64 characters');
  }
  const maxLength = options.maxLength ?? 128;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 256) {
    throw configError('requestId.maxLength', 'must be an integer between 1 and 256');
  }
  return {
    header,
    trustIncoming: options.trustIncoming ?? true,
    maxLength,
    generate: options.generate ?? randomUUID,
  };
}

/** True when value is an acceptable incoming request ID. */
export function isValidRequestId(value: string, maxLength = 128): boolean {
  return value.length > 0 && value.length <= maxLength && REQUEST_ID_PATTERN.test(value);
}

/**
 * Returns the incoming request ID when it is trusted and valid, otherwise a newly generated
 * one. Invalid values (control characters, spaces, overlong) are never echoed or logged.
 */
export function resolveRequestId(
  incoming: string | null | undefined,
  options: ResolvedRequestIdOptions,
): string {
  if (options.trustIncoming && typeof incoming === 'string') {
    const value = incoming.trim();
    if (isValidRequestId(value, options.maxLength)) return value;
  }
  return options.generate();
}

export interface CreateRequestContextInput {
  requestIdHeader?: string | null | undefined;
  traceparent?: string | null | undefined;
  tracestate?: string | null | undefined;
}

/** Builds a request context from incoming headers. */
export function createRequestContext(
  input: CreateRequestContextInput,
  requestId: ResolvedRequestIdOptions = resolveRequestIdOptions(),
  trace: TraceOptions = {},
): RequestContext {
  const ctx: RequestContext = {
    requestId: resolveRequestId(input.requestIdHeader, requestId),
    bindings: {},
  };
  const parent = trace.propagate === false ? undefined : parseTraceparent(input.traceparent);
  if (parent) {
    ctx.traceId = parent.traceId;
    ctx.parentSpanId = parent.parentId;
    ctx.spanId = generateSpanId();
    ctx.traceFlags = parent.traceFlags;
    const state = parseTracestate(input.tracestate);
    if (state.length > 0) ctx.traceState = state;
  } else if (trace.generate !== false) {
    ctx.traceId = generateTraceId();
    ctx.spanId = generateSpanId();
    ctx.traceFlags = trace.sampled ? 1 : 0;
  }
  return ctx;
}

export interface InjectTraceHeadersOptions {
  /** Context to propagate. Default: the active request context. */
  context?: RequestContext;
  /** Also propagate the request ID. Default true. */
  requestId?: boolean;
  /** Request ID header name. Default `x-request-id`. */
  requestIdHeader?: string;
}

/**
 * Returns a Headers object with `traceparent`, `tracestate` and the request ID of the active
 * request context added, for outgoing `fetch` calls. Existing values in `init` are replaced.
 */
export function injectTraceHeaders(
  init?: ConstructorParameters<typeof Headers>[0],
  options: InjectTraceHeadersOptions = {},
): Headers {
  const headers = new Headers(init);
  const ctx = options.context ?? storage.getStore();
  if (!ctx) return headers;
  if (ctx.traceId && ctx.spanId) {
    headers.set(
      'traceparent',
      formatTraceparent({
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        traceFlags: ctx.traceFlags ?? 0,
      }),
    );
    if (ctx.traceState && ctx.traceState.length > 0) {
      headers.set('tracestate', formatTracestate(ctx.traceState));
    } else {
      headers.delete('tracestate');
    }
  }
  if (options.requestId !== false) {
    headers.set(options.requestIdHeader ?? 'x-request-id', ctx.requestId);
  }
  return headers;
}
