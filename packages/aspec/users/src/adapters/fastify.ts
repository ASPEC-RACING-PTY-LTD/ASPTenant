import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertRouterOptions,
  createAdminRoutes,
  createSelfServiceRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  resolveBodyLimit,
  resolveSubject,
  type UsersRoute,
  type UsersRouterOptions,
} from '../http.js';
import type { UsersService } from '../service.js';

export type FastifyUsersRouterOptions = UsersRouterOptions<FastifyRequest>;

/** Fastify plugin signature returned by the factories below. */
export type UsersFastifyPlugin = (instance: FastifyInstance) => Promise<void>;

function send(reply: FastifyReply, out: HttpOutput): FastifyReply {
  reply.code(out.status);
  reply.header('cache-control', 'no-store');
  for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
  if (out.body === undefined) return reply.send();
  return reply.type('application/json; charset=utf-8').send(JSON.stringify(out.body));
}

function createPlugin(
  service: UsersService,
  routes: UsersRoute[],
  options: FastifyUsersRouterOptions,
): UsersFastifyPlugin {
  const bodyLimit = resolveBodyLimit(options.bodyLimit);
  return async (instance) => {
    for (const route of routes) {
      instance.route({
        method: route.method,
        url: route.path,
        bodyLimit,
        handler: async (request, reply) => {
          let out: HttpOutput;
          try {
            const qIndex = request.url.indexOf('?');
            const ua = request.headers['user-agent'];
            out = await executeRoute(
              service,
              route,
              {
                method: request.method,
                params: (request.params ?? {}) as Record<string, string>,
                query: new URLSearchParams(qIndex >= 0 ? request.url.slice(qIndex + 1) : ''),
                body: request.body,
                header: (name) => {
                  const v = request.headers[name.toLowerCase()];
                  return Array.isArray(v) ? v[0] : v;
                },
                actor: await resolveSubject(options.resolveActor, request),
                ip: request.ip,
                ...(ua === undefined ? {} : { userAgent: ua }),
              },
              options.logger,
            );
          } catch (err) {
            out = errorOutput(err, options.logger);
          }
          return send(reply, out);
        },
      });
    }
  };
}

/**
 * Fastify 5 plugin serving the admin API:
 * `app.register(createUsersAdminPlugin(users, { resolveActor }), { prefix: '/admin' })`.
 */
export function createUsersAdminPlugin(
  service: UsersService,
  options: FastifyUsersRouterOptions,
): UsersFastifyPlugin {
  assertRouterOptions(service, options, 'admin');
  return createPlugin(service, createAdminRoutes(service), options);
}

/** Fastify 5 plugin serving the self-service API. */
export function createUsersSelfServicePlugin(
  service: UsersService,
  options: FastifyUsersRouterOptions,
): UsersFastifyPlugin {
  assertRouterOptions(service, options, 'self');
  return createPlugin(service, createSelfServiceRoutes(service), options);
}
