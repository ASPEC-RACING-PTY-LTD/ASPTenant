import { type AuditAdminOptions, createAuditAdminHandler, matchAdminPath } from '../admin.js';
import { runWithAuditContext } from '../context.js';
import {
  buildAuditContext,
  type CorrelationOptions,
  resolveCorrelationOptions,
} from '../correlation.js';
import type { AuditLogger } from '../logger.js';

/** The parts of an Express 4 or 5 request used by the adapter. */
export interface ExpressLikeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/** The parts of an Express 4 or 5 response used by the adapter. */
export interface ExpressLikeResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  json(body: unknown): unknown;
}

export type ExpressNext = (err?: unknown) => void;

export type ExpressMiddleware<Req extends ExpressLikeRequest = ExpressLikeRequest> = (
  req: Req,
  res: ExpressLikeResponse,
  next: ExpressNext,
) => void;

function header(req: ExpressLikeRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * Captures the request ID, client IP, user agent and actor resolver into the audit context
 * so `audit.record()` calls made while handling the request are enriched automatically.
 * Mount it before your routes.
 */
export function auditContext<Req extends ExpressLikeRequest = ExpressLikeRequest>(
  options: CorrelationOptions<Req> = {},
): ExpressMiddleware<Req> {
  const resolved = resolveCorrelationOptions(options);
  return (req, res, next) => {
    let ctx: ReturnType<typeof buildAuditContext>;
    try {
      ctx = buildAuditContext(req, (n) => header(req, n), req.socket?.remoteAddress, resolved);
    } catch (err) {
      next(err);
      return;
    }
    if (resolved.responseHeader && ctx.requestId)
      res.setHeader(resolved.responseHeader, ctx.requestId);
    runWithAuditContext(ctx, () => next());
  };
}

/**
 * Read-only admin router: `GET /events`, `GET /events/count`, `GET /events/:id`,
 * `GET /streams` and `GET /streams/:stream/verify`. Mount it under a path, for example
 * `app.use('/admin/audit', auditAdminRouter(audit, { authorize }))`.
 */
export function auditAdminRouter<Req extends ExpressLikeRequest = ExpressLikeRequest>(
  logger: AuditLogger,
  options: AuditAdminOptions<Req>,
): ExpressMiddleware<Req> {
  const handler = createAuditAdminHandler<Req>(logger, options);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const route = matchAdminPath(url.pathname);
    if (!route) {
      next();
      return;
    }
    handler.handle(route, url.searchParams, req).then(
      (r) => {
        res.setHeader('cache-control', 'no-store');
        res.status(r.status);
        res.json(r.body);
      },
      (err: unknown) => next(err),
    );
  };
}
