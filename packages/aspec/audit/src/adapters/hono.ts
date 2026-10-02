import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type AuditAdminOptions, type AuditAdminRoute, createAuditAdminHandler } from '../admin.js';
import { runWithAuditContext } from '../context.js';
import {
  buildAuditContext,
  type CorrelationOptions,
  resolveCorrelationOptions,
} from '../correlation.js';
import type { AuditLogger } from '../logger.js';

export interface HonoAuditContextOptions extends CorrelationOptions<Context> {
  /**
   * Returns the socket address. Default: `c.env.incoming.socket.remoteAddress` when running on
   * @hono/node-server, otherwise undefined.
   */
  getRemoteAddress?: (c: Context) => string | undefined;
}

function nodeRemoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return typeof addr === 'string' ? addr : undefined;
}

/** Hono middleware that captures the request audit context. */
export function auditContext(options: HonoAuditContextOptions = {}): MiddlewareHandler {
  const { getRemoteAddress = nodeRemoteAddress, ...rest } = options;
  const resolved = resolveCorrelationOptions<Context>(rest);
  return async (c, next) => {
    const ctx = buildAuditContext(c, (n) => c.req.header(n), getRemoteAddress(c), resolved);
    if (resolved.responseHeader && ctx.requestId) c.header(resolved.responseHeader, ctx.requestId);
    await runWithAuditContext(ctx, () => next());
  };
}

/**
 * Read-only admin sub-application. Mount it with `app.route('/admin/audit', createAuditAdminApp(audit, { authorize }))`.
 */
export function createAuditAdminApp(
  logger: AuditLogger,
  options: AuditAdminOptions<Context>,
): Hono {
  const handler = createAuditAdminHandler<Context>(logger, options);
  const app = new Hono();
  const serve = (route: (c: Context) => AuditAdminRoute) => async (c: Context) => {
    const url = new URL(c.req.url);
    const r = await handler.handle(route(c), url.searchParams, c);
    c.header('cache-control', 'no-store');
    return c.json(r.body as object, r.status as 200);
  };
  app.get(
    '/',
    serve(() => ({ name: 'events' })),
  );
  app.get(
    '/events',
    serve(() => ({ name: 'events' })),
  );
  app.get(
    '/events/count',
    serve(() => ({ name: 'count' })),
  );
  app.get(
    '/events/:id',
    serve((c) => ({ name: 'event', id: c.req.param('id') ?? '' })),
  );
  app.get(
    '/streams',
    serve(() => ({ name: 'streams' })),
  );
  app.get(
    '/streams/:stream/verify',
    serve((c) => ({ name: 'verify', stream: c.req.param('stream') ?? '' })),
  );
  return app;
}
