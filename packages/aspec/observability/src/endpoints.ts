import { createHash, timingSafeEqual } from 'node:crypto';
import { configError } from './errors.js';
import type { Health, HealthDetailLevel, HealthResponse } from './health.js';
import type { MetricsRegistry } from './metrics.js';

export interface EndpointPaths {
  /** Liveness path. Default `/livez`. `false` disables it. */
  live?: string | false;
  /** Readiness path. Default `/readyz`. */
  ready?: string | false;
  /** Detailed health path. Default `/healthz`. */
  health?: string | false;
  /** Prometheus metrics path. Default `/metrics`. */
  metrics?: string | false;
}

export interface EndpointOptions {
  health?: Health;
  registry?: MetricsRegistry;
  paths?: EndpointPaths;
  /**
   * Requests presenting `Authorization: Bearer <detailToken>` receive `full` health detail.
   * Other requests get the health detail level. Compared in constant time.
   */
  detailToken?: string;
  /** When set, /metrics requires `Authorization: Bearer <metricsToken>` (401 otherwise). */
  metricsToken?: string;
}

export interface EndpointRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Header lookup by lowercase name. */
  header(name: string): string | undefined;
}

export interface EndpointResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ObservabilityEndpoints {
  readonly paths: Readonly<{ live?: string; ready?: string; health?: string; metrics?: string }>;
  /** True when the path is served by these endpoints. */
  matches(path: string): boolean;
  /** Serves the request, or returns undefined when the path is not an endpoint. */
  handle(request: EndpointRequest): Promise<EndpointResponse | undefined>;
}

const MIN_TOKEN_LENGTH = 16;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of a presented bearer token against the configured secret. */
function bearerMatches(header: string | undefined, expected: Buffer | undefined): boolean {
  if (!expected || !header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), expected);
}

function validatePath(
  value: string | false | undefined,
  fallback: string,
  option: string,
): string | undefined {
  if (value === false) return undefined;
  const path = value ?? fallback;
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9._~\-/]*$/.test(path)) {
    throw configError(option, 'must be an absolute path such as /healthz');
  }
  return path;
}

function validateToken(value: string | undefined, option: string): Buffer | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length < MIN_TOKEN_LENGTH) {
    throw configError(option, `must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return digest(value);
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * Framework-agnostic handler for /livez, /readyz, /healthz and /metrics. Adapters translate
 * their request into EndpointRequest and write the EndpointResponse. Only GET and HEAD are
 * accepted; HEAD responses have an empty body.
 */
export function createObservabilityEndpoints(options: EndpointOptions): ObservabilityEndpoints {
  const p = options.paths ?? {};
  const live = options.health ? validatePath(p.live, '/livez', 'endpoints.paths.live') : undefined;
  const ready = options.health
    ? validatePath(p.ready, '/readyz', 'endpoints.paths.ready')
    : undefined;
  const healthPath = options.health
    ? validatePath(p.health, '/healthz', 'endpoints.paths.health')
    : undefined;
  const metrics = options.registry
    ? validatePath(p.metrics, '/metrics', 'endpoints.paths.metrics')
    : undefined;
  const detailToken = validateToken(options.detailToken, 'endpoints.detailToken');
  const metricsToken = validateToken(options.metricsToken, 'endpoints.metricsToken');
  const all = [live, ready, healthPath, metrics].filter((v): v is string => v !== undefined);
  if (new Set(all).size !== all.length)
    throw configError('endpoints.paths', 'paths must be distinct');
  const served = new Set(all);
  const paths: { live?: string; ready?: string; health?: string; metrics?: string } = {};
  if (live) paths.live = live;
  if (ready) paths.ready = ready;
  if (healthPath) paths.health = healthPath;
  if (metrics) paths.metrics = metrics;

  const fromHealth = (r: HealthResponse, head: boolean): EndpointResponse => ({
    status: r.statusCode,
    headers: { ...JSON_HEADERS },
    body: head ? '' : JSON.stringify(r.body),
  });

  return {
    paths,
    matches: (path) => served.has(path),
    async handle(req) {
      if (!served.has(req.path)) return undefined;
      const method = req.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return {
          status: 405,
          headers: { allow: 'GET, HEAD', ...JSON_HEADERS },
          body: JSON.stringify({ error: 'Method Not Allowed' }),
        };
      }
      const head = method === 'HEAD';
      const health = options.health;
      if (health) {
        const level: HealthDetailLevel | undefined = bearerMatches(
          req.header('authorization'),
          detailToken,
        )
          ? 'full'
          : undefined;
        const opts = level ? { detail: level } : {};
        if (req.path === live) return fromHealth(await health.liveness(opts), head);
        if (req.path === ready) return fromHealth(await health.readiness(opts), head);
        if (req.path === healthPath) return fromHealth(await health.health(opts), head);
      }
      const registry = options.registry;
      if (registry && req.path === metrics) {
        if (metricsToken && !bearerMatches(req.header('authorization'), metricsToken)) {
          return {
            status: 401,
            headers: { 'www-authenticate': 'Bearer', ...JSON_HEADERS },
            body: JSON.stringify({ error: 'Unauthorized' }),
          };
        }
        const accept = req.header('accept') ?? '';
        if (/\bapplication\/json\b/i.test(accept) && !/\btext\/plain\b/i.test(accept)) {
          return {
            status: 200,
            headers: { ...JSON_HEADERS },
            body: head ? '' : JSON.stringify(await registry.snapshot()),
          };
        }
        return {
          status: 200,
          headers: { 'content-type': registry.contentType, 'cache-control': 'no-store' },
          body: head ? '' : await registry.metrics(),
        };
      }
      return undefined;
    },
  };
}
