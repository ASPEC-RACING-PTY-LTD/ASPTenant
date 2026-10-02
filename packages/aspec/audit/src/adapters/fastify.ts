import { AsyncResource } from 'node:async_hooks';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { type AuditAdminOptions, createAuditAdminHandler, matchAdminPath } from '../admin.js';
import { runWithAuditContext } from '../context.js';
import {
  buildAuditContext,
  type CorrelationOptions,
  resolveCorrelationOptions,
} from '../correlation.js';
import type { AuditLogger } from '../logger.js';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

const resources = new WeakMap<FastifyRequest, AsyncResource>();

/**
 * Registers hooks that capture the request audit context on every route of the instance.
 * Body parsing runs outside the original async context, so the context is re-entered before
 * validation and the handler.
 */
export function registerAuditContext(
  app: FastifyInstance,
  options: CorrelationOptions<FastifyRequest> = {},
): void {
  const resolved = resolveCorrelationOptions(options);
  app.addHook('onRequest', (request, reply, done) => {
    const ctx = buildAuditContext(
      request,
      (n) => header(request, n),
      request.raw.socket?.remoteAddress,
      resolved,
    );
    if (resolved.responseHeader && ctx.requestId)
      reply.header(resolved.responseHeader, ctx.requestId);
    runWithAuditContext(ctx, () => {
      const resource = new AsyncResource('aspec-audit-context');
      resources.set(request, resource);
      resource.runInAsyncScope(done, request.raw);
    });
  });
  app.addHook('preValidation', (request, _reply, done) => {
    const resource = resources.get(request);
    if (resource) resource.runInAsyncScope(done, request.raw);
    else done();
  });
}

/** Fastify plugin form of registerAuditContext (applies to the whole instance, not encapsulated). */
export const auditContextPlugin: FastifyPluginCallback<CorrelationOptions<FastifyRequest>> =
  Object.assign(
    (
      app: FastifyInstance,
      options: CorrelationOptions<FastifyRequest>,
      done: (err?: Error) => void,
    ) => {
      try {
        registerAuditContext(app, options);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    {
      [Symbol.for('skip-override')]: true,
      [Symbol.for('fastify.display-name')]: 'aspec-audit-context',
    },
  );

export interface AuditAdminPluginOptions extends AuditAdminOptions<FastifyRequest> {
  /** Audit logger that serves queries. */
  audit: AuditLogger;
}

/**
 * Read-only admin routes. Register with a prefix:
 * `app.register(auditAdminPlugin, { prefix: '/admin/audit', audit, authorize })`.
 */
export const auditAdminPlugin: FastifyPluginCallback<AuditAdminPluginOptions> = (
  app,
  options,
  done,
) => {
  const { audit, ...adminOptions } = options;
  let handler: ReturnType<typeof createAuditAdminHandler<FastifyRequest>>;
  try {
    handler = createAuditAdminHandler<FastifyRequest>(audit, adminOptions);
  } catch (err) {
    done(err as Error);
    return;
  }
  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(request.url, 'http://localhost');
    const prefix = app.prefix ?? '';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const route = matchAdminPath(path);
    if (!route) {
      reply.code(404).send({ error: { code: 'AUDIT_NOT_FOUND', message: 'route not found' } });
      return reply;
    }
    const r = await handler.handle(route, url.searchParams, request);
    reply.header('cache-control', 'no-store').code(r.status).send(r.body);
    return reply;
  };
  app.get('/', serve);
  app.get('/*', serve);
  done();
};
