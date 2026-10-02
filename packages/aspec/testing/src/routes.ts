import { formatValue, matchesPartial } from './diff.js';
import { invalidOption } from './errors.js';

/** A request seen by mockFetch or a mock server. */
export interface MockRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** Raw body text ("" when there is no body). */
  text: string;
  /** Parsed JSON body when the body is valid JSON, otherwise undefined. */
  body: unknown;
  /** Path parameters captured by `:name` segments. */
  params: Record<string, string>;
}

export type QueryMatcher =
  | Record<string, string | number | boolean | RegExp | readonly string[]>
  | ((query: URLSearchParams) => boolean);

export type HeaderMatcher = Record<string, string | RegExp | ((value: string | null) => boolean)>;

export interface RouteMatcher {
  /** HTTP method (case-insensitive) or `*`. Default `*`. */
  method?: string;
  /**
   * Absolute URL (`https://api.test/users/:id`), path (`/users/*`) or RegExp tested against the
   * full URL. Path patterns support `:name` segments and a trailing `*`.
   */
  url: string | RegExp;
  /** Subset match on query parameters (or a predicate). */
  query?: QueryMatcher;
  /** Subset match on headers (case-insensitive names). */
  headers?: HeaderMatcher;
  /** Partial match on the parsed JSON body, exact string match on text, or a predicate. */
  body?: unknown;
}

export interface MockResponseSpec {
  readonly kind: 'response';
  status: number;
  headers: [string, string][];
  body: string | Uint8Array | null;
  delayMs: number;
}

export interface MockNetworkErrorSpec {
  readonly kind: 'network-error';
  message: string;
  delayMs: number;
}

export type MockReply = MockResponseSpec | MockNetworkErrorSpec;
export type MockHandler = (request: MockRequest) => MockReply | Promise<MockReply>;
export type ReplyInput = MockReply | MockHandler;

export interface ReplyInit {
  status?: number;
  headers?: Record<string, string> | [string, string][];
}

function headerList(headers: ReplyInit['headers']): [string, string][] {
  if (!headers) return [];
  return Array.isArray(headers)
    ? headers.map(([k, v]) => [k, v] as [string, string])
    : Object.entries(headers);
}

function checkStatus(status: number): number {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw invalidOption('status', 'must be an integer between 200 and 599');
  }
  return status;
}

function withDefaultType(headers: [string, string][], type: string): [string, string][] {
  return headers.some(([k]) => k.toLowerCase() === 'content-type')
    ? headers
    : [['content-type', type], ...headers];
}

/** Response builders shared by mockFetch and createMockServer. */
export const reply = {
  json(body: unknown, init: ReplyInit = {}): MockResponseSpec {
    return {
      kind: 'response',
      status: checkStatus(init.status ?? 200),
      headers: withDefaultType(headerList(init.headers), 'application/json'),
      body: JSON.stringify(body),
      delayMs: 0,
    };
  },
  text(body: string, init: ReplyInit = {}): MockResponseSpec {
    return {
      kind: 'response',
      status: checkStatus(init.status ?? 200),
      headers: withDefaultType(headerList(init.headers), 'text/plain; charset=utf-8'),
      body,
      delayMs: 0,
    };
  },
  /** Status with an empty body. */
  status(status: number, init: Omit<ReplyInit, 'status'> = {}): MockResponseSpec {
    return {
      kind: 'response',
      status: checkStatus(status),
      headers: headerList(init.headers),
      body: null,
      delayMs: 0,
    };
  },
  /** Raw bytes or text with explicit headers. */
  body(body: string | Uint8Array, init: ReplyInit = {}): MockResponseSpec {
    return {
      kind: 'response',
      status: checkStatus(init.status ?? 200),
      headers: headerList(init.headers),
      body,
      delayMs: 0,
    };
  },
  /** Connection failure: fetch rejects with TypeError("fetch failed"); a mock server resets the socket. */
  networkError(message = 'mock network error'): MockNetworkErrorSpec {
    return { kind: 'network-error', message, delayMs: 0 };
  },
  /** Delays another reply by `ms` milliseconds. */
  delay<R extends MockReply>(ms: number, spec: R): R {
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000)
      throw invalidOption('delay', 'must be between 0 and 600000 ms');
    return { ...spec, delayMs: ms };
  },
};

interface CompiledUrl {
  test(url: URL): Record<string, string> | undefined;
  query: Record<string, string> | undefined;
}

function compilePath(pattern: string): (pathname: string) => Record<string, string> | undefined {
  const wildcard = pattern.endsWith('*');
  const segments = (wildcard ? pattern.slice(0, -1) : pattern).split('/');
  return (pathname) => {
    const actual = pathname.split('/');
    if (wildcard ? actual.length < segments.length : actual.length !== segments.length)
      return undefined;
    const params: Record<string, string> = {};
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const act = actual[i] as string;
      if (wildcard && i === segments.length - 1) {
        if (!act.startsWith(seg)) return undefined;
        continue;
      }
      if (seg.startsWith(':') && seg.length > 1) {
        if (act === '') return undefined;
        try {
          params[seg.slice(1)] = decodeURIComponent(act);
        } catch {
          return undefined;
        }
      } else if (seg !== act) return undefined;
    }
    return params;
  };
}

function compileUrl(url: string | RegExp): CompiledUrl {
  if (url instanceof RegExp) {
    return {
      test: (u) => {
        url.lastIndex = 0;
        const m = url.exec(u.href);
        return m ? { ...(m.groups ?? {}) } : undefined;
      },
      query: undefined,
    };
  }
  if (url.startsWith('/')) {
    const q = url.indexOf('?');
    const path = compilePath(q === -1 ? url : url.slice(0, q));
    const query = q === -1 ? undefined : Object.fromEntries(new URLSearchParams(url.slice(q + 1)));
    return { test: (u) => path(u.pathname), query };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidOption(
      'url',
      `"${url}" is neither an absolute URL, a path starting with "/" nor a RegExp`,
    );
  }
  // Read the raw path back from the pattern so ":name" and "*" survive URL normalisation.
  const slash = url.indexOf('/', url.indexOf('//') + 2);
  const rawPath = (slash === -1 ? '/' : url.slice(slash)).split('?')[0]?.split('#')[0] || '/';
  const path = compilePath(rawPath);
  const query = parsed.search ? Object.fromEntries(parsed.searchParams) : undefined;
  return { test: (u) => (u.origin === parsed.origin ? path(u.pathname) : undefined), query };
}

function queryMatches(
  matcher: QueryMatcher | undefined,
  extra: Record<string, string> | undefined,
  query: URLSearchParams,
): boolean {
  if (extra) {
    for (const [k, v] of Object.entries(extra)) if (query.get(k) !== v) return false;
  }
  if (matcher === undefined) return true;
  if (typeof matcher === 'function') return matcher(query);
  for (const [k, expected] of Object.entries(matcher)) {
    const values = query.getAll(k);
    if (expected instanceof RegExp) {
      if (!values.some((v) => expected.test(v))) return false;
    } else if (Array.isArray(expected)) {
      if (values.length !== expected.length || !expected.every((e, i) => values[i] === e))
        return false;
    } else if (!values.includes(String(expected))) return false;
  }
  return true;
}

function headersMatch(matcher: HeaderMatcher | undefined, headers: Headers): boolean {
  if (!matcher) return true;
  for (const [name, expected] of Object.entries(matcher)) {
    const value = headers.get(name);
    if (typeof expected === 'function') {
      if (!expected(value)) return false;
    } else if (value === null) return false;
    else if (expected instanceof RegExp ? !expected.test(value) : value !== expected) return false;
  }
  return true;
}

function bodyMatches(matcher: unknown, request: MockRequest): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === 'function')
    return Boolean((matcher as (r: MockRequest) => unknown)(request));
  if (typeof matcher === 'string') return request.text === matcher;
  if (matcher instanceof RegExp) return matcher.test(request.text);
  return request.body !== undefined && matchesPartial(request.body, matcher);
}

export interface RecordedCall {
  request: MockRequest;
  /** The route that answered, or undefined when unmatched. */
  route: MockRoute | undefined;
}

export interface MockRoute {
  readonly matcher: RouteMatcher;
  /** Number of requests this route answered. */
  readonly callCount: number;
  readonly calls: readonly MockRequest[];
  readonly called: boolean;
  /** Limits how many requests the route answers (default unlimited). */
  times(count: number): this;
  once(): this;
  /** Replaces the reply. */
  reply(input: ReplyInput): this;
  describe(): string;
}

export class RouteRegistry {
  readonly routes: RouteImpl[] = [];

  add(matcher: RouteMatcher, input: ReplyInput): MockRoute {
    const route = new RouteImpl(matcher, input);
    this.routes.push(route);
    return route;
  }

  /** First registered route that matches and still has remaining uses. */
  match(
    request: Omit<MockRequest, 'params'>,
  ): { route: RouteImpl; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      const params = route.test(request);
      if (params) return { route, params };
    }
    return undefined;
  }

  clear(): void {
    this.routes.length = 0;
  }

  describe(): string {
    return this.routes.length === 0
      ? '  (no routes registered)'
      : this.routes.map((r) => `  ${r.describe()}`).join('\n');
  }

  /** Routes never called, or with remaining `times()` uses. */
  pending(): RouteImpl[] {
    return this.routes.filter((r) => !r.called || (r.limit !== undefined && r.callCount < r.limit));
  }
}

class RouteImpl implements MockRoute {
  readonly matcher: RouteMatcher;
  readonly calls: MockRequest[] = [];
  limit: number | undefined;
  private handler: ReplyInput;
  private readonly method: string;
  private readonly url: CompiledUrl;

  constructor(matcher: RouteMatcher, input: ReplyInput) {
    this.matcher = matcher;
    this.handler = input;
    this.method = (matcher.method ?? '*').toUpperCase();
    this.url = compileUrl(matcher.url);
  }

  get callCount(): number {
    return this.calls.length;
  }

  get called(): boolean {
    return this.calls.length > 0;
  }

  times(count: number): this {
    if (!Number.isInteger(count) || count < 1)
      throw invalidOption('times', 'must be a positive integer');
    this.limit = count;
    return this;
  }

  once(): this {
    return this.times(1);
  }

  reply(input: ReplyInput): this {
    this.handler = input;
    return this;
  }

  test(request: Omit<MockRequest, 'params'>): Record<string, string> | undefined {
    if (this.limit !== undefined && this.calls.length >= this.limit) return undefined;
    if (this.method !== '*' && this.method !== request.method) return undefined;
    const params = this.url.test(request.url);
    if (!params) return undefined;
    if (!queryMatches(this.matcher.query, this.url.query, request.url.searchParams))
      return undefined;
    if (!headersMatch(this.matcher.headers, request.headers)) return undefined;
    if (!bodyMatches(this.matcher.body, { ...request, params })) return undefined;
    return params;
  }

  async respond(request: MockRequest): Promise<MockReply> {
    this.calls.push(request);
    return typeof this.handler === 'function' ? await this.handler(request) : this.handler;
  }

  describe(): string {
    const parts = [`${this.method} ${String(this.matcher.url)}`];
    if (this.matcher.query) parts.push(`query ${formatValue(this.matcher.query, 200)}`);
    if (this.matcher.headers) parts.push(`headers ${formatValue(this.matcher.headers, 200)}`);
    if (this.matcher.body !== undefined) parts.push(`body ${formatValue(this.matcher.body, 200)}`);
    parts.push(`called ${this.calls.length}${this.limit === undefined ? '' : `/${this.limit}`}`);
    return parts.join(', ');
  }
}

export function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function describeRequest(request: Pick<MockRequest, 'method' | 'url' | 'text'>): string {
  const body = request.text
    ? ` body ${request.text.length > 300 ? `${request.text.slice(0, 300)}...` : request.text}`
    : '';
  return `${request.method} ${request.url.href}${body}`;
}

/** Shorthand route builders keyed by HTTP method. */
export interface RouteShortcuts {
  get(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  post(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  put(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  patch(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  delete(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  head(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
  options(
    url: string | RegExp,
    reply: ReplyInput,
    match?: Omit<RouteMatcher, 'url' | 'method'>,
  ): MockRoute;
}

export function routeShortcuts(
  on: (matcher: RouteMatcher, reply: ReplyInput) => MockRoute,
): RouteShortcuts {
  const make =
    (method: string) =>
    (
      url: string | RegExp,
      input: ReplyInput,
      match: Omit<RouteMatcher, 'url' | 'method'> = {},
    ): MockRoute =>
      on({ ...match, method, url }, input);
  return {
    get: make('GET'),
    post: make('POST'),
    put: make('PUT'),
    patch: make('PATCH'),
    delete: make('DELETE'),
    head: make('HEAD'),
    options: make('OPTIONS'),
  };
}
