import { registerCleanup } from './cleanup.js';
import { TestingAssertionError, TestingError, TestingErrorCode } from './errors.js';
import {
  describeRequest,
  type MockReply,
  type MockRequest,
  type MockRoute,
  parseBody,
  type RecordedCall,
  type ReplyInput,
  type RouteMatcher,
  RouteRegistry,
  type RouteShortcuts,
  routeShortcuts,
} from './routes.js';
import { bytesBody } from './web-body.js';

export type FetchFn = typeof globalThis.fetch;

export interface MockFetchOptions {
  /** Reject unmatched requests with TESTING_UNMATCHED_REQUEST (default true). */
  strict?: boolean;
  /** Replace globalThis.fetch (default true). When false, use `mock.fetch` directly. */
  global?: boolean;
  /** Recorded calls are capped (oldest dropped). Default 10000. */
  maxRecordedCalls?: number;
}

export interface MockFetch extends RouteShortcuts {
  /** The mock implementation (also installed as globalThis.fetch unless `global: false`). */
  readonly fetch: FetchFn;
  readonly calls: readonly RecordedCall[];
  readonly unmatched: readonly MockRequest[];
  readonly active: boolean;
  on(matcher: RouteMatcher, reply: ReplyInput): MockRoute;
  /** Removes all routes and recorded calls. */
  reset(): void;
  /** Throws if any route was never called (or still has remaining `times()` uses). */
  assertAllCalled(): void;
  /** Throws if any request did not match a route. */
  assertNoUnmatched(): void;
  /** Restores the previous globalThis.fetch. Safe to call more than once. */
  restore(): void;
  [Symbol.dispose](): void;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(abortError(signal)) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function toResponse(spec: MockReply & { kind: 'response' }, method: string): Response {
  const raw = NULL_BODY_STATUS.has(spec.status) || method === 'HEAD' ? null : spec.body;
  const body = raw instanceof Uint8Array ? bytesBody(raw) : (raw as string | null);
  return new Response(body, {
    status: spec.status,
    headers: spec.headers,
  });
}

/**
 * Replaces globalThis.fetch with a route-based mock. Strict by default: unmatched requests
 * reject. Restored by `restore()`, `Symbol.dispose` or `cleanupAll()`.
 */
export function mockFetch(options: MockFetchOptions = {}): MockFetch {
  const strict = options.strict ?? true;
  const installGlobal = options.global ?? true;
  const max = options.maxRecordedCalls ?? 10_000;
  const registry = new RouteRegistry();
  const calls: RecordedCall[] = [];
  const unmatched: MockRequest[] = [];
  const previous = globalThis.fetch;
  let active = true;

  const record = (call: RecordedCall): void => {
    calls.push(call);
    if (calls.length > max) calls.splice(0, calls.length - max);
  };

  const fetchImpl: FetchFn = async (input, init) => {
    const request = new Request(input, init);
    const text = request.body === null ? '' : await request.text();
    const base = {
      method: request.method.toUpperCase(),
      url: new URL(request.url),
      headers: request.headers,
      text,
      body: parseBody(text),
    };
    const match = registry.match(base);
    if (!match) {
      const req: MockRequest = { ...base, params: {} };
      record({ request: req, route: undefined });
      unmatched.push(req);
      if (unmatched.length > max) unmatched.splice(0, unmatched.length - max);
      if (!strict && typeof previous === 'function') return previous(input, init);
      throw new TestingError(
        TestingErrorCode.UNMATCHED_REQUEST,
        `mockFetch: no route matched ${describeRequest(req)}\nRegistered routes:\n${registry.describe()}`,
      );
    }
    const req: MockRequest = { ...base, params: match.params };
    record({ request: req, route: match.route });
    const spec = await match.route.respond(req);
    await wait(spec.delayMs, init?.signal ?? request.signal);
    if (spec.kind === 'network-error') {
      throw new TypeError('fetch failed', { cause: new Error(spec.message) });
    }
    return toResponse(spec, req.method);
  };

  const restore = (): void => {
    if (!active) return;
    active = false;
    unregister();
    if (installGlobal && globalThis.fetch === fetchImpl) globalThis.fetch = previous;
  };
  const unregister = registerCleanup(restore);
  if (installGlobal) globalThis.fetch = fetchImpl;

  const on = (matcher: RouteMatcher, input: ReplyInput): MockRoute => registry.add(matcher, input);
  return {
    ...routeShortcuts(on),
    fetch: fetchImpl,
    calls,
    unmatched,
    get active() {
      return active;
    },
    on,
    reset() {
      registry.clear();
      calls.length = 0;
      unmatched.length = 0;
    },
    assertAllCalled() {
      const pending = registry.pending();
      if (pending.length > 0) {
        throw new TestingAssertionError(
          `mockFetch: ${pending.length} route(s) not fully used:\n${pending.map((r) => `  ${r.describe()}`).join('\n')}`,
        );
      }
    },
    assertNoUnmatched() {
      if (unmatched.length > 0) {
        throw new TestingAssertionError(
          `mockFetch: ${unmatched.length} unmatched request(s):\n${unmatched.map((r) => `  ${describeRequest(r)}`).join('\n')}`,
        );
      }
    },
    restore,
    [Symbol.dispose]: restore,
  };
}
