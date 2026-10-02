import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { Rbac } from '../engine.js';
import { isRbacError } from '../errors.js';
import {
  createRbacAdminHttp,
  parseJsonBody,
  type RbacAdminHttpOptions,
} from '../http/admin-http.js';
import { createGuards, type GuardOptions } from '../http/guard.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from '../http/problem.js';
import type { Subject } from '../ports.js';

export type { GuardOptions } from '../http/guard.js';
export type FastifyRbacAdminOptions = RbacAdminHttpOptions<FastifyRequest>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Subject attached by @aspec/rbac/fastify hooks after a successful check. */
    rbac?: { subject: Subject };
  }
}

function sendProblem(reply: FastifyReply, err: unknown): void {
  const problem = toProblem(err);
  reply
    .code(problem.status)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .header('cache-control', 'no-store')
    .send(problem);
}

function wrap(run: (req: FastifyRequest) => Promise<Subject>): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      const subject = await run(req);
      req.rbac = { subject };
    } catch (err) {
      if (isRbacError(err) && err.expose) {
        sendProblem(reply, err);
        return reply;
      }
      throw err;
    }
  };
}

/** Fastify preHandler hooks for permission and role guards. */
export function createRbacHooks(rbac: Rbac) {
  const guards = createGuards(rbac);
  return {
    requirePermission(
      permission: string,
      options: GuardOptions<FastifyRequest>,
    ): preHandlerHookHandler {
      return wrap((req) => guards.requirePermission(permission, req, options));
    },
    requireRole(role: string, options: GuardOptions<FastifyRequest>): preHandlerHookHandler {
      return wrap((req) => guards.requireRole(role, req, options));
    },
    requireAny(
      permissions: readonly string[],
      options: GuardOptions<FastifyRequest>,
    ): preHandlerHookHandler {
      return wrap((req) => guards.requireAny(permissions, req, options));
    },
    requireAll(
      permissions: readonly string[],
      options: GuardOptions<FastifyRequest>,
    ): preHandlerHookHandler {
      return wrap((req) => guards.requireAll(permissions, req, options));
    },
  };
}

/**
 * Fastify plugin registering the RBAC admin API under `prefix` (default `/`).
 * Register with `app.register(createRbacAdminPlugin(rbac, options), { prefix: '/admin/rbac' })`.
 */
export function createRbacAdminPlugin(
  rbac: Rbac,
  options: FastifyRbacAdminOptions,
): FastifyPluginAsync {
  const http = createRbacAdminHttp<FastifyRequest>(rbac, options);
  return async (app) => {
    for (const route of http.routes) {
      app.route({
        method: route.method,
        url: route.pattern,
        handler: async (req, reply) => {
          try {
            const url = new URL(req.url, 'http://localhost');
            const r = await http.handle(route, {
              request: req,
              params: req.params as Record<string, string>,
              query: url.searchParams,
              contentType: req.headers['content-type'],
              readBody: async () => {
                if (req.body !== undefined && req.body !== null) return req.body;
                const raw = (req as { rawBody?: Buffer | string }).rawBody;
                if (typeof raw === 'string') return parseJsonBody(raw, http.bodyLimitBytes);
                if (Buffer.isBuffer(raw))
                  return parseJsonBody(raw.toString('utf8'), http.bodyLimitBytes);
                return undefined;
              },
            });
            for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
            return reply.code(r.status).send(r.body);
          } catch (err) {
            if (isRbacError(err) && err.expose) {
              sendProblem(reply, err);
              return;
            }
            throw err;
          }
        },
      });
    }
  };
}
