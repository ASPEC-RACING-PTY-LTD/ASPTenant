import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { registerCleanup } from './cleanup.js';
import { CookieJar, parseSetCookie } from './cookies.js';
import { formatMismatches, formatValue, partialMismatches, projectToExpected } from './diff.js';
import { invalidOption, TestingAssertionError, TestingError, TestingErrorCode } from './errors.js';
import type { Clock } from './ports.js';
import { bytesBody } from './web-body.js';

/** A Node.js request listener: Express 4 and 5 apps, Koa's `app.callback()`, connect, plain handlers. */
export type NodeRequestListener = (req: IncomingMessage, res: ServerResponse) => unknown;

/** A Web Fetch API handler. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface InjectLikeResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  rawPayload: Buffer;
}

/** Structural shape of a Fastify instance (uses `inject`, no network). */
export interface FastifyLike {
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: Buffer;
  }): PromiseLike<InjectLikeResponse>;
}

/** Structural shape of a Hono app (uses `app.request`, no network). */
export interface HonoLike {
  request(
    input: string,
    init?: RequestInit,
    env?: unknown,
    executionCtx?: unknown,
  ): Response | Promise<Response>;
  fetch(request: Request, ...rest: never[]): Response | Promise<Response>;
}

export type TestTarget =
  | NodeRequestListener
  | FastifyLike
  | HonoLike
  | FetchHandler
  | { fetch: FetchHandler }
  | string
  | URL;

export type TargetKind = 'node' | 'fastify' | 'hono' | 'fetch' | 'url';

export interface TestClientOptions {
  /** Force the target kind instead of detecting it. */
  kind?: TargetKind;
  /** Origin used to build request URLs for in-memory targets. Default http://localhost */
  origin?: string;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  jar?: CookieJar;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Clock for cookie expiry. */
  clock?: Clock;
  /** Hono only: `env` bindings and execution context passed to `app.request`. */
  hono?: { env?: unknown; executionCtx?: unknown };
}

interface RawRequest {
  method: string;
  path: string;
  headers: [string, string][];
  body: Uint8Array | undefined;
  timeoutMs: number;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

interface Transport {
  readonly kind: TargetKind;
  readonly origin: string;
  dispatch(req: RawRequest): Promise<RawResponse>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT = 10_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

function requestFailed(message: string, cause?: unknown): TestingError {
  return new TestingError(
    TestingErrorCode.REQUEST_FAILED,
    message,
    cause === undefined ? {} : { cause },
  );
}

function nodeHeadersToFetch(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i] as string, raw[i + 1] as string);
    } catch {
      // Skip header names the Fetch Headers class rejects.
    }
  }
  return headers;
}

function outgoing(headers: [string, string][]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of headers) {
    const key = k.toLowerCase();
    const prev = out[key];
    if (prev === undefined) out[key] = v;
    else if (key === 'cookie') out[key] = `${String(prev)}; ${v}`;
    else out[key] = Array.isArray(prev) ? [...prev, v] : [String(prev), v];
  }
  return out;
}

function httpDispatch(base: URL, req: RawRequest): Promise<RawResponse> {
  const doRequest = base.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = doRequest(
      {
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port,
        path: req.path,
        method: req.method,
        headers: outgoing(req.headers),
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy(requestFailed(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: nodeHeadersToFetch(res.rawHeaders),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    r.setTimeout(req.timeoutMs, () =>
      r.destroy(requestFailed(`${req.method} ${req.path} timed out after ${req.timeoutMs} ms`)),
    );
    r.on('error', (err) =>
      reject(
        err instanceof TestingError
          ? err
          : requestFailed(`${req.method} ${req.path} failed: ${err.message}`, err),
      ),
    );
    if (req.body) r.write(req.body);
    r.end();
  });
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(requestFailed(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fromFetchResponse(res: Response): Promise<RawResponse> {
  return {
    status: res.status,
    headers: res.headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
}

function nodeTransport(listener: NodeRequestListener): Transport {
  let server: Server | undefined;
  let base: Promise<URL> | undefined;
  let unregister: (() => void) | undefined;
  const start = (): Promise<URL> => {
    base ??= new Promise<URL>((resolve, reject) => {
      const s = createServer((req, res) => {
        listener(req, res);
      });
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        s.off('error', reject);
        s.unref();
        server = s;
        unregister = registerCleanup(close);
        resolve(new URL(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
      });
    });
    return base;
  };
  const close = async (): Promise<void> => {
    const s = server;
    server = undefined;
    base = undefined;
    unregister?.();
    unregister = undefined;
    if (!s) return;
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
      s.closeAllConnections();
    });
  };
  return {
    kind: 'node',
    origin: 'http://127.0.0.1',
    async dispatch(req) {
      return httpDispatch(await start(), req);
    },
    close,
  };
}

function urlTransport(url: string | URL): Transport {
  const base = new URL(String(url));
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    throw invalidOption('target', 'URL targets must use http or https');
  const prefix = base.pathname.replace(/\/$/, '');
  return {
    kind: 'url',
    origin: base.origin,
    dispatch: (req) => httpDispatch(base, { ...req, path: `${prefix}${req.path}` }),
    close: async () => undefined,
  };
}

function fetchInit(req: RawRequest): RequestInit {
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.body !== undefined) init.body = bytesBody(req.body);
  return init;
}

function fetchTransport(handler: FetchHandler, origin: string): Transport {
  return {
    kind: 'fetch',
    origin,
    async dispatch(req) {
      const res = await withTimeout(
        Promise.resolve(handler(new Request(`${origin}${req.path}`, fetchInit(req)))),
        req.timeoutMs,
        `${req.method} ${req.path}`,
      );
      return fromFetchResponse(res);
    },
    close: async () => undefined,
  };
}

function honoTransport(app: HonoLike, origin: string, opts: TestClientOptions['hono']): Transport {
  return {
    kind: 'hono',
    origin,
    async dispatch(req) {
      const res = await withTimeout(
        Promise.resolve(
          app.request(`${origin}${req.path}`, fetchInit(req), opts?.env, opts?.executionCtx),
        ),
        req.timeoutMs,
        `${req.method} ${req.path}`,
      );
      return fromFetchResponse(res);
    },
    close: async () => undefined,
  };
}

function fastifyTransport(app: FastifyLike, origin: string): Transport {
  return {
    kind: 'fastify',
    origin,
    async dispatch(req) {
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) {
        const key = k.toLowerCase();
        headers[key] =
          headers[key] === undefined ? v : `${headers[key]}${key === 'cookie' ? '; ' : ', '}${v}`;
      }
      const opts: {
        method: string;
        url: string;
        headers: Record<string, string>;
        payload?: Buffer;
      } = { method: req.method, url: req.path, headers };
      if (req.body !== undefined) opts.payload = Buffer.from(req.body);
      const res = await withTimeout(app.inject(opts), req.timeoutMs, `${req.method} ${req.path}`);
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const item of Array.isArray(v) ? v : [String(v)]) out.append(k, item);
      }
      return { status: res.statusCode, headers: out, body: new Uint8Array(res.rawPayload) };
    },
    close: async () => undefined,
  };
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

/** Detects which transport a target needs. */
export function detectTargetKind(target: TestTarget): TargetKind {
  if (typeof target === 'string' || target instanceof URL) return 'url';
  const t = target as unknown as Record<string, unknown>;
  if (isFunction(t.inject)) return 'fastify';
  if (isFunction(t.request) && isFunction(t.fetch)) return 'hono';
  if (typeof target === 'function') {
    if (isFunction(t.handle) || isFunction(t.listen) || target.length >= 2) return 'node';
    return 'fetch';
  }
  if (isFunction(t.fetch)) return 'fetch';
  throw new TestingError(
    TestingErrorCode.UNSUPPORTED_APP,
    'createTestClient: unsupported target. Pass an Express app or Node request listener, a Fastify instance, a Hono app, a Fetch handler, or a base URL.',
    { expose: true },
  );
}

function createTransport(target: TestTarget, options: TestClientOptions): Transport {
  const kind = options.kind ?? detectTargetKind(target);
  const origin = (options.origin ?? 'http://localhost').replace(/\/$/, '');
  switch (kind) {
    case 'url':
      return urlTransport(target as string | URL);
    case 'node':
      return nodeTransport(target as NodeRequestListener);
    case 'fastify':
      return fastifyTransport(target as FastifyLike, origin);
    case 'hono':
      return honoTransport(target as HonoLike, origin, options.hono);
    case 'fetch': {
      const handler =
        typeof target === 'function'
          ? (target as FetchHandler)
          : (target as { fetch: FetchHandler }).fetch.bind(target);
      return fetchTransport(handler, origin);
    }
    default:
      throw invalidOption('kind', 'use node, fastify, hono, fetch or url');
  }
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Body decoded as UTF-8. */
  readonly text: string;
  readonly raw: Uint8Array;
  /** Parsed JSON body when the response is JSON, otherwise undefined. */
  readonly body: unknown;
  /** Cookies set by this response (name to raw value). */
  readonly cookies: Record<string, string>;
  readonly request: { method: string; path: string };
  header(name: string): string | null;
  /** Parses the body as JSON; throws an assertion error when it is not JSON. */
  json<T = unknown>(): T;
}

type Expectation = (res: TestResponse) => void | Promise<void>;
type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

function buildResponse(raw: RawResponse, method: string, path: string): TestResponse {
  const text = new TextDecoder().decode(raw.body);
  const contentType = raw.headers.get('content-type') ?? '';
  let parsed: unknown;
  let parseError: unknown;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parseError = err;
    }
  }
  const cookies: Record<string, string> = {};
  for (const h of raw.headers.getSetCookie()) {
    const c = parseSetCookie(h, path.split('?')[0]);
    if (c) cookies[c.name] = c.value;
  }
  return {
    status: raw.status,
    headers: raw.headers,
    text,
    raw: raw.body,
    body: /[/+]json\b/i.test(contentType) ? parsed : undefined,
    cookies,
    request: { method, path },
    header: (name) => raw.headers.get(name),
    json<T>(): T {
      if (text === '' || parseError !== undefined) {
        throw new TestingAssertionError(
          `Expected a JSON body${parseError instanceof Error ? ` (${parseError.message})` : ' but the body is empty'}`,
        );
      }
      return parsed as T;
    },
  };
}

function responseContext(res: TestResponse): string {
  const ct = res.header('content-type');
  const body =
    res.text.length > 2000
      ? `${res.text.slice(0, 2000)}... (${res.text.length - 2000} more characters)`
      : res.text;
  return `\n\nRequest: ${res.request.method} ${res.request.path}\nResponse: ${res.status}${ct ? ` ${ct}` : ''}\nBody: ${body || '(empty)'}`;
}

interface RequestContext {
  transport: Transport;
  jar: CookieJar;
  defaults: Record<string, string>;
  timeoutMs: number;
}

/** A pending request. Configure it fluently, then `await` it to send and run the expectations. */
export class TestRequest implements PromiseLike<TestResponse> {
  private readonly headerList: [string, string][] = [];
  private readonly expectations: Expectation[] = [];
  private readonly search = new URLSearchParams();
  private payload: Uint8Array | undefined;
  private timeoutMs: number;
  private promise: Promise<TestResponse> | undefined;
  private readonly path: string;
  private readonly ctx: RequestContext;
  private readonly method: string;

  constructor(ctx: RequestContext, method: string, path: string) {
    this.ctx = ctx;
    this.method = method;
    if (!path.startsWith('/'))
      throw invalidOption('path', `must start with "/", received "${path}"`);
    const q = path.indexOf('?');
    this.path = q === -1 ? path : path.slice(0, q);
    if (q !== -1)
      for (const [k, v] of new URLSearchParams(path.slice(q + 1))) this.search.append(k, v);
    this.timeoutMs = ctx.timeoutMs;
  }

  /** Adds query parameters (arrays repeat the key; null and undefined are skipped). */
  query(params: Record<string, QueryValue> | URLSearchParams | string): this {
    const entries =
      typeof params === 'string' || params instanceof URLSearchParams
        ? [...new URLSearchParams(params)]
        : Object.entries(params);
    for (const [k, v] of entries) {
      if (v === null || v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) this.search.append(k, String(item));
    }
    return this;
  }

  /** Sets a request header (or several). */
  set(name: string | Record<string, string>, value?: string): this {
    const entries =
      typeof name === 'string' ? [[name, value ?? ''] as const] : Object.entries(name);
    for (const [k, v] of entries) {
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v))
        throw invalidOption('header', 'names and values must not contain line breaks');
      const lower = k.toLowerCase();
      for (let i = this.headerList.length - 1; i >= 0; i--)
        if (this.headerList[i]?.[0].toLowerCase() === lower) this.headerList.splice(i, 1);
      this.headerList.push([k, v]);
    }
    return this;
  }

  type(contentType: string): this {
    return this.set('content-type', contentType);
  }

  accept(contentType: string): this {
    return this.set('accept', contentType);
  }

  /** Sets `Authorization: <scheme> <token>` (default scheme Bearer). */
  auth(token: string, scheme = 'Bearer'): this {
    return this.set('authorization', `${scheme} ${token}`);
  }

  /** Adds a cookie to this request only (the jar is not modified). */
  cookie(name: string, value: string): this {
    this.headerList.push(['cookie', `${name}=${value}`]);
    return this;
  }

  /**
   * Sets the body. Plain objects and arrays are sent as JSON, URLSearchParams as a form, strings
   * as text, bytes as application/octet-stream (unless a content-type was set).
   */
  send(body: unknown): this {
    const hasType = this.headerList.some(([k]) => k.toLowerCase() === 'content-type');
    let bytes: Uint8Array;
    let type: string;
    if (body instanceof Uint8Array) {
      bytes = body;
      type = 'application/octet-stream';
    } else if (body instanceof URLSearchParams) {
      bytes = Buffer.from(body.toString());
      type = 'application/x-www-form-urlencoded';
    } else if (typeof body === 'string') {
      bytes = Buffer.from(body);
      type = 'text/plain; charset=utf-8';
    } else {
      bytes = Buffer.from(JSON.stringify(body));
      type = 'application/json';
    }
    this.payload = bytes;
    if (!hasType) this.headerList.push(['content-type', type]);
    return this;
  }

  timeout(ms: number): this {
    if (!Number.isFinite(ms) || ms <= 0)
      throw invalidOption('timeout', 'must be a positive number of ms');
    this.timeoutMs = ms;
    return this;
  }

  /** Expects a status code (or one of several), or runs a custom assertion. */
  expect(statusOrFn: number | readonly number[] | Expectation): this {
    if (typeof statusOrFn === 'function') {
      this.expectations.push(statusOrFn);
      return this;
    }
    const allowed = typeof statusOrFn === 'number' ? [statusOrFn] : statusOrFn;
    this.expectations.push((res) => {
      if (!allowed.includes(res.status)) {
        throw new TestingAssertionError(
          `Expected status ${allowed.join(' or ')}, received ${res.status}`,
          res.status,
          allowed.length === 1 ? allowed[0] : allowed,
        );
      }
    });
    return this;
  }

  /** Expects the JSON body to match a partial structure (see partialMismatches for the rules). */
  expectJson(partial: unknown): this {
    this.expectations.push((res) => {
      let actual: unknown;
      try {
        actual = res.json();
      } catch {
        throw new TestingAssertionError(
          `Expected a JSON body matching ${formatValue(partial, 500)}, received a non-JSON body`,
        );
      }
      const mismatches = partialMismatches(actual, partial);
      if (mismatches.length > 0) {
        throw new TestingAssertionError(
          `Expected JSON body to match (partial):\n${formatMismatches(mismatches)}`,
          projectToExpected(actual, partial),
          partial,
        );
      }
    });
    return this;
  }

  /** Expects the text body to equal a string or match a RegExp. */
  expectText(expected: string | RegExp): this {
    this.expectations.push((res) => {
      const ok = typeof expected === 'string' ? res.text === expected : expected.test(res.text);
      if (!ok)
        throw new TestingAssertionError(
          `Expected body ${typeof expected === 'string' ? 'to equal' : 'to match'} ${formatValue(expected, 500)}`,
          res.text,
          typeof expected === 'string' ? expected : String(expected),
        );
    });
    return this;
  }

  /** Expects a header to be present, equal to a string, or match a RegExp. */
  expectHeader(name: string, expected?: string | RegExp): this {
    this.expectations.push((res) => {
      const value = res.header(name);
      if (value === null)
        throw new TestingAssertionError(`Expected header "${name}" to be present`);
      if (expected === undefined) return;
      const ok = typeof expected === 'string' ? value === expected : expected.test(value);
      if (!ok)
        throw new TestingAssertionError(
          `Expected header "${name}" ${typeof expected === 'string' ? 'to equal' : 'to match'} ${formatValue(expected)}, received ${formatValue(value)}`,
          value,
          typeof expected === 'string' ? expected : String(expected),
        );
    });
    return this;
  }

  expectNoHeader(name: string): this {
    this.expectations.push((res) => {
      const value = res.header(name);
      if (value !== null)
        throw new TestingAssertionError(
          `Expected no "${name}" header, received ${formatValue(value)}`,
        );
    });
    return this;
  }

  /** Expects the response to set a cookie (optionally with a value or matching a RegExp). */
  expectCookie(name: string, expected?: string | RegExp): this {
    this.expectations.push((res) => {
      const value = res.cookies[name];
      if (value === undefined)
        throw new TestingAssertionError(
          `Expected a Set-Cookie for "${name}", received: ${Object.keys(res.cookies).join(', ') || '(none)'}`,
        );
      if (
        expected !== undefined &&
        !(typeof expected === 'string' ? value === expected : expected.test(value))
      ) {
        throw new TestingAssertionError(
          `Expected cookie "${name}" to ${typeof expected === 'string' ? 'equal' : 'match'} ${formatValue(expected)}, received ${formatValue(value)}`,
        );
      }
    });
    return this;
  }

  private async execute(): Promise<TestResponse> {
    const qs = this.search.toString();
    const fullPath = qs ? `${this.path}?${qs}` : this.path;
    const headers: [string, string][] = [];
    const explicit = new Set(this.headerList.map(([k]) => k.toLowerCase()));
    for (const [k, v] of Object.entries(this.ctx.defaults))
      if (!explicit.has(k.toLowerCase())) headers.push([k, v]);
    const jarCookie = this.ctx.jar.header(this.path);
    if (jarCookie) headers.push(['cookie', jarCookie]);
    headers.push(...this.headerList);
    const raw = await this.ctx.transport.dispatch({
      method: this.method,
      path: fullPath,
      headers,
      body: this.payload,
      timeoutMs: this.timeoutMs,
    });
    this.ctx.jar.storeFromHeaders(raw.headers.getSetCookie(), this.path);
    const res = buildResponse(raw, this.method, fullPath);
    for (const expectation of this.expectations) {
      try {
        await expectation(res);
      } catch (err) {
        if (err instanceof TestingAssertionError) {
          const wrapped = new TestingAssertionError(
            `${err.message}${responseContext(res)}`,
            err.actual,
            err.expected,
            err.showDiff,
          );
          throw wrapped;
        }
        throw err;
      }
    }
    return res;
  }

  // biome-ignore lint/suspicious/noThenProperty: TestRequest is intentionally thenable so await runs expectations.
  then<R1 = TestResponse, R2 = never>(
    onfulfilled?: ((value: TestResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    this.promise ??= this.execute();
    return this.promise.then(onfulfilled, onrejected);
  }
}

export interface TestClient {
  readonly kind: TargetKind;
  readonly jar: CookieJar;
  request(method: string, path: string): TestRequest;
  get(path: string): TestRequest;
  post(path: string): TestRequest;
  put(path: string): TestRequest;
  patch(path: string): TestRequest;
  delete(path: string): TestRequest;
  head(path: string): TestRequest;
  options(path: string): TestRequest;
  /** A view that adds headers to every request (shares the transport and cookie jar). */
  withHeaders(headers: Record<string, string>): TestClient;
  /** A view that sends `Authorization: Bearer <token>`. */
  withBearer(token: string): TestClient;
  /** A view with its own cookie jar (default: a new empty jar). */
  withJar(jar?: CookieJar): TestClient;
  /** Stops the ephemeral server (Node listeners). Also run by cleanupAll(). */
  close(): Promise<void>;
}

/**
 * Creates an API test client for an Express app (4 or 5) or any Node request listener
 * (ephemeral loopback server, closed automatically), a Fastify instance (`inject`), a Hono app
 * (`app.request`), a Fetch handler, or a base URL of a running server.
 */
export function createTestClient(target: TestTarget, options: TestClientOptions = {}): TestClient {
  const transport = createTransport(target, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw invalidOption('timeoutMs', 'must be a positive number');
  const jarOptions = options.clock ? { clock: options.clock } : {};
  const view = (jar: CookieJar, defaults: Record<string, string>): TestClient => {
    const ctx = { transport, jar, defaults, timeoutMs };
    const request = (method: string, path: string): TestRequest =>
      new TestRequest(ctx, method.toUpperCase(), path);
    return {
      kind: transport.kind,
      jar,
      request,
      get: (p) => request('GET', p),
      post: (p) => request('POST', p),
      put: (p) => request('PUT', p),
      patch: (p) => request('PATCH', p),
      delete: (p) => request('DELETE', p),
      head: (p) => request('HEAD', p),
      options: (p) => request('OPTIONS', p),
      withHeaders: (headers) => view(jar, { ...defaults, ...headers }),
      withBearer: (token) => view(jar, { ...defaults, authorization: `Bearer ${token}` }),
      withJar: (next) => view(next ?? new CookieJar(jarOptions), defaults),
      close: () => transport.close(),
    };
  };
  return view(options.jar ?? new CookieJar(jarOptions), { ...options.headers });
}
