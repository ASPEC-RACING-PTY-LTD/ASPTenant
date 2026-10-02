import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertRouterOptions,
  createAdminRoutes,
  createMemberRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  type OrgsRoute,
  type OrgsRouterOptions,
  resolveBodyLimit,
  resolveSubject,
} from '../http.js';
import type { OrgsService } from '../service.js';

export type FastifyOrgsRouterOptions = OrgsRouterOptions<FastifyRequest>;
export type OrgsFastifyPlugin = (instance: FastifyInstance) => Promise<void>;

function send(reply: FastifyReply, out: HttpOutput): FastifyReply {
  reply.code(out.status);
  reply.header('cache-control', 'no-store');
  for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
  if (out.body === undefined) return reply.send();
  return reply.type('application/json; charset=utf-8').send(JSON.stringify(out.body));
}

function queryOf(url: string): Record<string, string | string[] | undefined> {
  const qIndex = url.indexOf('?');
  const out: Record<string, string | string[] | undefined> = {};
  if (qIndex < 0) return out;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length <= 1 ? all[0] : all;
  }
  return out;
}

function createPlugin(
  service: OrgsService,
  routes: OrgsRoute[],
  options: FastifyOrgsRouterOptions,
): OrgsFastifyPlugin {
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
            const actor = await resolveSubject(options, request);
            out = await executeRoute(
              route,
              {
                method: request.method,
                path: route.path,
                params: (request.params ?? {}) as Record<string, string>,
                query: queryOf(request.url),
                body: request.body,
                headers: request.headers as Record<string, string | string[] | undefined>,
                actor,
                subject: actor && 'orgId' in actor ? (actor as never) : null,
              },
              service,
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

export function createOrgsAdminPlugin(
  service: OrgsService,
  options: FastifyOrgsRouterOptions,
): OrgsFastifyPlugin {
  assertRouterOptions(service, options);
  return createPlugin(service, createAdminRoutes(), options);
}

export function createOrgsMemberPlugin(
  service: OrgsService,
  options: FastifyOrgsRouterOptions,
): OrgsFastifyPlugin {
  assertRouterOptions(service, options);
  return createPlugin(service, createMemberRoutes(), options);
}
