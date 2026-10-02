import { createHash } from 'node:crypto';
import { policyWindowSeconds } from './algorithms.js';
import { configError } from './errors.js';
import { AccessList, type AccessListInput, ipKey } from './ip.js';
import type { RateLimiter, RateLimitResult } from './limiter.js';
import type { LoggerLike } from './ports.js';
import {
  type ClientIpResolver,
  createClientIpResolver,
  type HeaderReader,
  type ProxyHeader,
  type TrustProxy,
} from './proxy.js';

/** Framework-neutral view of an HTTP request, built by each adapter. */
export interface RateLimitRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Resolved client IP (after trusted proxy processing), or undefined when unknown. */
  ip: string | undefined;
  /** Client IP grouped for keys (IPv6 addresses reduced to their subnet). */
  ipKey: string | undefined;
  /** Address of the directly connected peer. */
  remoteAddress: string | undefined;
  header: HeaderReader;
  /** Authenticated user when the framework exposes one (for example `req.user`). */
  user: unknown;
  /** The framework request object. */
  raw: unknown;
}

export type KeyGenerator = (
  request: RateLimitRequest,
) => string | undefined | Promise<string | undefined>;

export interface RateLimitRule {
  limiter: RateLimiter;
  /** Key for this rule. Default `keys.ip()`. Returning undefined skips the rule. */
  key?: KeyGenerator;
  /** Cost per request. Default: the policy cost. */
  cost?: number | ((request: RateLimitRequest) => number | Promise<number>);
}

export interface RateLimitHeaderOptions {
  /** IETF `RateLimit-Policy` and `RateLimit` fields. Default true. */
  standard?: boolean;
  /** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Default false. */
  legacy?: boolean;
  /** `X-RateLimit-Reset` as epoch seconds ("epoch", default) or seconds from now ("delta"). */
  legacyReset?: 'epoch' | 'delta';
  /** `Retry-After` on rejected requests. Default true. */
  retryAfter?: boolean;
}

export interface HttpRateLimitOptions {
  /** One or more rules. The most restrictive decision wins. */
  rules?: readonly RateLimitRule[];
  /** Shorthand for a single rule. */
  limiter?: RateLimiter;
  /** Key generator for the shorthand rule. */
  key?: KeyGenerator;
  trustProxy?: TrustProxy;
  proxyHeader?: ProxyHeader;
  /** Prefix length used to group IPv6 clients. Default 64. */
  ipv6Subnet?: number;
  /** Client IPs or generated keys that bypass every rule. */
  allowlist?: AccessListInput;
  /** Client IPs or generated keys that are rejected with 403. */
  denylist?: AccessListInput;
  headers?: RateLimitHeaderOptions;
  /** Return true to bypass rate limiting for a request (for example health checks). */
  skip?: (request: RateLimitRequest) => boolean | Promise<boolean>;
  /** Human readable message for 429 responses. */
  message?: string | ((retryAfterSeconds: number) => string);
  /** Problem type URI. Default "about:blank". */
  problemType?: string;
  logger?: LoggerLike;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  retryAfter?: number;
  policy?: string;
}

export interface HttpRateLimitOutcome {
  action: 'allow' | 'reject';
  /** 200 when allowed; 429, 403 or 503 when rejected. */
  status: number;
  /** Headers to add to the response (allowed or rejected). */
  headers: Record<string, string>;
  /** problem+json body for rejected requests. */
  body?: ProblemDetails;
  /** Every decision that was evaluated. */
  results: RateLimitResult[];
  /** The decision that determined the outcome (most restrictive). */
  decision?: RateLimitResult;
  retryAfterSeconds?: number;
}

export interface HttpRequestInput {
  method: string;
  path: string;
  remoteAddress: string | undefined;
  header: HeaderReader;
  user?: unknown;
  raw: unknown;
}

export interface HttpRateLimiter {
  evaluate(input: HttpRequestInput): Promise<HttpRateLimitOutcome>;
  resolveIp(remoteAddress: string | undefined, header: HeaderReader): string | undefined;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 32);
}

function userId(user: unknown): string | undefined {
  if (user === null || typeof user !== 'object') return undefined;
  const record = user as Record<string, unknown>;
  const id = record.id ?? record.sub ?? record.userId;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return undefined;
}

/** Built-in key generators. */
export const keys = {
  /** Client IP (IPv6 grouped by subnet). Unknown clients share the "ip:unknown" bucket. */
  ip(): KeyGenerator {
    return (req) => `ip:${req.ipKey ?? 'unknown'}`;
  },
  /** Authenticated user ID. Skips the rule for anonymous requests. */
  user(getId?: (request: RateLimitRequest) => string | undefined): KeyGenerator {
    return (req) => {
      const id = getId ? getId(req) : userId(req.user);
      return id ? `user:${id}` : undefined;
    };
  },
  /**
   * API key from `X-API-Key` (or a custom header) or an `Authorization: Bearer` token. The key
   * is hashed so that raw secrets never reach the store. Skips the rule when absent.
   */
  apiKey(options: { header?: string; bearer?: boolean } = {}): KeyGenerator {
    const header = (options.header ?? 'x-api-key').toLowerCase();
    const bearer = options.bearer ?? true;
    return (req) => {
      let value = req.header(header)?.trim();
      if (!value && bearer) {
        const auth = req.header('authorization');
        const match = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth) : null;
        value = match?.[1];
      }
      return value ? `apikey:${hashKey(value)}` : undefined;
    };
  },
  /** Method and path, optionally combined with another key (per-route per-client limits). */
  route(inner?: KeyGenerator): KeyGenerator {
    return async (req) => {
      const base = `route:${req.method.toUpperCase()} ${req.path}`;
      if (!inner) return base;
      const innerKey = await inner(req);
      return innerKey === undefined ? undefined : `${base}|${innerKey}`;
    };
  },
  /** Wraps a custom function and prefixes its result. */
  custom(prefix: string, fn: KeyGenerator): KeyGenerator {
    return async (req) => {
      const value = await fn(req);
      return value === undefined ? undefined : `${prefix}:${value}`;
    };
  },
};

const seconds = (ms: number | undefined): number => Math.max(0, Math.ceil((ms ?? 0) / 1000));

/** Formats `RateLimit-Policy` and `RateLimit` structured field values. */
export function formatStandardHeaders(
  results: readonly RateLimitResult[],
  limiters: ReadonlyMap<string, RateLimiter>,
): { policy: string; limit: string } {
  const policies: string[] = [];
  const limits: string[] = [];
  for (const r of results) {
    const limiter = limiters.get(r.policy);
    const window = limiter ? policyWindowSeconds(limiter.policy) : 1;
    policies.push(`"${r.policy}";q=${r.limit};w=${window}`);
    limits.push(`"${r.policy}";r=${r.remaining};t=${seconds(r.resetAfterMs)}`);
  }
  return { policy: policies.join(', '), limit: limits.join(', ') };
}

/** Picks the decision that restricts the client most. */
export function mostRestrictive(results: readonly RateLimitResult[]): RateLimitResult | undefined {
  let best: RateLimitResult | undefined;
  for (const r of results) {
    if (!best) {
      best = r;
      continue;
    }
    if (!r.allowed && best.allowed) best = r;
    else if (r.allowed === best.allowed) {
      if (!r.allowed) {
        if ((r.retryAfterMs ?? 0) > (best.retryAfterMs ?? 0)) best = r;
      } else if (r.remaining / r.limit < best.remaining / best.limit) {
        best = r;
      }
    }
  }
  return best;
}

export function createHttpRateLimiter(options: HttpRateLimitOptions): HttpRateLimiter {
  if (!options || typeof options !== 'object') throw configError('options', 'must be an object');
  const rules: RateLimitRule[] = [...(options.rules ?? [])];
  if (options.limiter) {
    const rule: RateLimitRule = { limiter: options.limiter };
    if (options.key) rule.key = options.key;
    rules.push(rule);
  }
  if (rules.length === 0) throw configError('rules', 'at least one rule or limiter is required');
  const limiters = new Map<string, RateLimiter>();
  for (const [index, rule] of rules.entries()) {
    if (!rule?.limiter || typeof rule.limiter.consume !== 'function') {
      throw configError(`rules[${index}].limiter`, 'must be a limiter from createRateLimiter');
    }
    limiters.set(rule.limiter.policy.name, rule.limiter);
  }
  const ipv6Subnet = options.ipv6Subnet ?? 64;
  if (!Number.isInteger(ipv6Subnet) || ipv6Subnet < 1 || ipv6Subnet > 128) {
    throw configError('ipv6Subnet', 'must be an integer between 1 and 128');
  }
  const headerOptions = {
    standard: options.headers?.standard ?? true,
    legacy: options.headers?.legacy ?? false,
    legacyReset: options.headers?.legacyReset ?? 'epoch',
    retryAfter: options.headers?.retryAfter ?? true,
  };
  if (headerOptions.legacyReset !== 'epoch' && headerOptions.legacyReset !== 'delta') {
    throw configError('headers.legacyReset', 'must be "epoch" or "delta"');
  }
  const allowlist = new AccessList(options.allowlist, 'allowlist');
  const denylist = new AccessList(options.denylist, 'denylist');
  const resolveIp: ClientIpResolver = createClientIpResolver({
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    ...(options.proxyHeader === undefined ? {} : { proxyHeader: options.proxyHeader }),
  });
  const problemType = options.problemType ?? 'about:blank';
  const message = (retryAfter: number, policy: string): string => {
    if (typeof options.message === 'function') return options.message(retryAfter);
    if (typeof options.message === 'string') return options.message;
    return `Rate limit exceeded for policy "${policy}". Retry after ${retryAfter} seconds.`;
  };

  const forbidden = (results: RateLimitResult[]): HttpRateLimitOutcome => ({
    action: 'reject',
    status: 403,
    headers: {},
    body: {
      type: problemType,
      title: 'Forbidden',
      status: 403,
      detail: 'Requests from this client are not allowed.',
    },
    results,
  });

  const build = (results: RateLimitResult[]): HttpRateLimitOutcome => {
    const decision = mostRestrictive(results);
    const headers: Record<string, string> = {};
    if (!decision) return { action: 'allow', status: 200, headers, results };
    const counted = results.filter((r) => r.reason !== 'allowlist');
    if (headerOptions.standard && counted.length > 0) {
      const formatted = formatStandardHeaders(counted, limiters);
      headers['RateLimit-Policy'] = formatted.policy;
      headers.RateLimit = formatted.limit;
    }
    if (headerOptions.legacy && decision.reason !== 'allowlist') {
      headers['X-RateLimit-Limit'] = String(decision.limit);
      headers['X-RateLimit-Remaining'] = String(decision.remaining);
      headers['X-RateLimit-Reset'] =
        headerOptions.legacyReset === 'epoch'
          ? String(Math.ceil(decision.resetAt / 1000))
          : String(seconds(decision.resetAfterMs));
    }
    if (decision.allowed) return { action: 'allow', status: 200, headers, results, decision };
    if (decision.reason === 'denylist') return { ...forbidden(results), decision };
    const retryAfterSeconds = Math.max(1, seconds(decision.retryAfterMs));
    if (headerOptions.retryAfter) headers['Retry-After'] = String(retryAfterSeconds);
    const unavailable = decision.reason === 'store_unavailable';
    return {
      action: 'reject',
      status: unavailable ? 503 : 429,
      headers,
      body: unavailable
        ? {
            type: problemType,
            title: 'Service Unavailable',
            status: 503,
            detail: `Rate limiting is temporarily unavailable. Retry after ${retryAfterSeconds} seconds.`,
            retryAfter: retryAfterSeconds,
            policy: decision.policy,
          }
        : {
            type: problemType,
            title: 'Too Many Requests',
            status: 429,
            detail: message(retryAfterSeconds, decision.policy),
            retryAfter: retryAfterSeconds,
            policy: decision.policy,
          },
      results,
      decision,
      retryAfterSeconds,
    };
  };

  return {
    resolveIp,
    async evaluate(input) {
      const ip = resolveIp(input.remoteAddress, input.header);
      const request: RateLimitRequest = {
        method: input.method,
        path: input.path,
        ip,
        ipKey: ip === undefined ? undefined : ipKey(ip, ipv6Subnet),
        remoteAddress: input.remoteAddress,
        header: input.header,
        user: input.user,
        raw: input.raw,
      };
      if (options.skip && (await options.skip(request))) {
        return { action: 'allow', status: 200, headers: {}, results: [] };
      }
      if (denylist.hasIp(ip)) return forbidden([]);
      if (allowlist.hasIp(ip)) return { action: 'allow', status: 200, headers: {}, results: [] };
      const results: RateLimitResult[] = [];
      for (const rule of rules) {
        const key = await (rule.key ?? keys.ip())(request);
        if (key === undefined) continue;
        if (denylist.hasKey(key)) return forbidden(results);
        if (allowlist.hasKey(key)) continue;
        const cost = typeof rule.cost === 'function' ? await rule.cost(request) : rule.cost;
        const result = await rule.limiter.consume(key, cost);
        results.push(result);
        if (!result.allowed) break;
      }
      return build(results);
    },
  };
}

/** Serialises a problem body. */
export function problemBody(outcome: HttpRateLimitOutcome): string {
  return JSON.stringify(outcome.body ?? {});
}

/** Reads a header from a Node.js style header record. */
export function nodeHeaderReader(
  headers: Record<string, string | string[] | undefined>,
): HeaderReader {
  return (name) => {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) return value.join(', ');
    return value;
  };
}

/** Removes the query string from a URL path. */
export function pathOf(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
