import { type Context, Hono } from 'hono';
import { OrgsError } from '../errors.js';
import {
  assertRouterOptions,
  createAdminRoutes,
  createMemberRoutes,
  errorOutput,
  executeRoute,
  type HttpOutput,
  type OrgsRoute,
  type OrgsRouterOptions,
  parseJsonBody,
  resolveBodyLimit,
  resolveSubject,
  toFetchResponse,
} from '../http.js';
import type { OrgsService } from '../service.js';

export type HonoOrgsRouterOptions = OrgsRouterOptions<Context>;

async function readBody(c: Context, limit: number): Promise<unknown> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined;
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new OrgsError('ORGS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  return parseJsonBody(await c.req.text(), limit);
}

function queryOf(url: string): Record<string, string | string[] | undefined> {
  const params = new URL(url).searchParams;
  const out: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length <= 1 ? all[0] : all;
  }
  return out;
}

function createApp(
  service: OrgsService,
  routes: OrgsRoute[],
  options: HonoOrgsRouterOptions,
): Hono {
  const limit = resolveBodyLimit(options.bodyLimit);
  const app = new Hono();
  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      let out: HttpOutput;
      try {
        const actor = await resolveSubject(options, c);
        const headers: Record<string, string | undefined> = {};
        c.req.raw.headers.forEach((v, k) => {
          headers[k] = v;
        });
        out = await executeRoute(
          route,
          {
            method: c.req.method,
            path: route.path,
            params: c.req.param() as Record<string, string>,
            query: queryOf(c.req.url),
            body: await readBody(c, limit),
            headers,
            actor,
            subject: actor && 'orgId' in actor ? (actor as never) : null,
          },
          service,
        );
      } catch (err) {
        out = errorOutput(err, options.logger);
      }
      return toFetchResponse(out);
    });
  }
  return app;
}

export function createOrgsAdminApp(service: OrgsService, options: HonoOrgsRouterOptions): Hono {
  assertRouterOptions(service, options);
  return createApp(service, createAdminRoutes(), options);
}

export function createOrgsMemberApp(service: OrgsService, options: HonoOrgsRouterOptions): Hono {
  assertRouterOptions(service, options);
  return createApp(service, createMemberRoutes(), options);
}
