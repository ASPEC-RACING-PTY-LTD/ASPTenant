import { type AuditAdminOptions, createAuditAdminHandler, matchAdminPath } from '../admin.js';
import { runWithAuditContext } from '../context.js';
import {
  buildAuditContext,
  type CorrelationOptions,
  resolveCorrelationOptions,
} from '../correlation.js';
import type { AuditLogger } from '../logger.js';

export type FetchHandler = (request: Request) => Promise<Response>;

export interface FetchAuditContextOptions extends CorrelationOptions<Request> {
  /**
   * Returns the remote address. Fetch has no socket; supply one from your runtime
   * (for example a reverse-proxy header already validated by the edge).
   */
  getRemoteAddress?: (request: Request) => string | undefined;
}

/**
 * Wraps a Fetch handler so every request runs inside an audit context. The wrapped
 * handler can call `audit.record()` and receive requestId, IP, user agent and actor.
 */
export function withAuditContext(
  handler: FetchHandler,
  options: FetchAuditContextOptions = {},
): FetchHandler {
  const { getRemoteAddress, ...rest } = options;
  const resolved = resolveCorrelationOptions<Request>(rest);
  return async (request) => {
    const ctx = buildAuditContext(
      request,
      (n) => request.headers.get(n) ?? undefined,
      getRemoteAddress?.(request),
      resolved,
    );
    return runWithAuditContext(ctx, async () => {
      const response = await handler(request);
      if (!resolved.responseHeader || !ctx.requestId) return response;
      const headers = new Headers(response.headers);
      headers.set(resolved.responseHeader, ctx.requestId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  };
}

export interface FetchAuditAdminOptions extends AuditAdminOptions<Request> {
  /** Path prefix of the admin router, for example `/admin/audit`. Default `/`. */
  basePath?: string;
}

/**
 * Read-only admin Fetch handler: `GET {basePath}/events`, `/events/count`,
 * `/events/:id`, `/streams` and `/streams/:stream/verify`.
 */
export function createAuditAdminFetchHandler(
  logger: AuditLogger,
  options: FetchAuditAdminOptions,
): FetchHandler {
  const { basePath = '/', ...adminOptions } = options;
  const handler = createAuditAdminHandler<Request>(logger, adminOptions);
  const prefix = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(
        JSON.stringify({ error: { code: 'AUDIT_NOT_FOUND', message: 'not found' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      );
    }
    const url = new URL(request.url);
    let path = url.pathname;
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
    const route = matchAdminPath(path);
    if (!route) {
      return new Response(
        JSON.stringify({ error: { code: 'AUDIT_NOT_FOUND', message: 'not found' } }),
        {
          status: 404,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      );
    }
    const r = await handler.handle(route, url.searchParams, request);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
}
