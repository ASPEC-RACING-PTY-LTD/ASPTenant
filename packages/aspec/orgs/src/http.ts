import { OrgsError } from './errors.js';
import type { LoggerLike, Subject } from './ports.js';
import type { OrgsService } from './service.js';
import type { ActionContext, Actor } from './types.js';

export type ResolveActor<Req> = (
  req: Req,
) => Subject | Actor | null | undefined | Promise<Subject | Actor | null | undefined>;

export type TenantResolution =
  | { method: 'header'; header?: string }
  | { method: 'subdomain'; rootDomain: string }
  | { method: 'path'; prefix?: string }
  | { method: 'custom'; resolve: (req: unknown) => string | null | Promise<string | null> };

export interface OrgsRouterOptions<Req> {
  resolveActor: ResolveActor<Req>;
  /** How to resolve the tenant org id or slug from the request (multi mode). */
  tenant?: TenantResolution;
  bodyLimit?: number;
  logger?: LoggerLike;
}

export interface HttpInput {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  actor: Subject | Actor | null;
  subject: Subject | null;
}

export interface HttpOutput {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteAccess = 'admin' | 'member' | 'public';

export interface OrgsRoute {
  method: string;
  path: string;
  access: RouteAccess;
  /** Permission checked via service.can for admin routes. */
  permission?: string;
  run(input: HttpInput, service: OrgsService): Promise<HttpOutput>;
}

export const DEFAULT_BODY_LIMIT = 65_536;

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function queryValue(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = query[key];
  return Array.isArray(v) ? v[0] : v;
}

function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function context(i: HttpInput): ActionContext {
  const ctx: ActionContext = {};
  if (i.actor?.id) {
    const actor: Actor = { id: i.actor.id };
    if ('type' in i.actor && i.actor.type !== undefined) actor.type = i.actor.type;
    if ('ip' in i.actor && i.actor.ip !== undefined) actor.ip = i.actor.ip;
    if ('userAgent' in i.actor && i.actor.userAgent !== undefined) {
      actor.userAgent = i.actor.userAgent;
    }
    ctx.actor = actor;
  }
  if (i.subject?.orgId) ctx.tenantId = i.subject.orgId;
  return ctx;
}

function requireUser(i: HttpInput): string {
  if (!i.actor?.id) throw new OrgsError('ORGS_UNAUTHENTICATED', 'Authentication required');
  return i.actor.id;
}

export function createAdminRoutes(): OrgsRoute[] {
  return [
    {
      method: 'GET',
      path: '/orgs',
      access: 'admin',
      permission: 'orgs:read',
      async run(i, s) {
        const q: { status?: string; search?: string; limit?: number; cursor?: string } = {
          limit: Number(queryValue(i.query, 'limit') ?? 50),
        };
        const status = queryValue(i.query, 'status');
        if (status !== undefined) q.status = status;
        const search = queryValue(i.query, 'search');
        if (search !== undefined) q.search = search;
        const cursor = queryValue(i.query, 'cursor');
        if (cursor !== undefined) q.cursor = cursor;
        return { status: 200, body: await s.listOrgs(q) };
      },
    },
    {
      method: 'POST',
      path: '/orgs',
      access: 'admin',
      async run(i, s) {
        const userId = requireUser(i);
        const body = obj(i.body);
        const input: Parameters<OrgsService['createOrg']>[0] = {
          name: body.name as string,
          createdBy: (body.createdBy as string | undefined) ?? userId,
        };
        if (typeof body.slug === 'string') input.slug = body.slug;
        if (body.metadata && typeof body.metadata === 'object') {
          input.metadata = body.metadata as Record<string, unknown>;
        }
        const org = await s.createOrg(input, context(i));
        return { status: 201, body: org };
      },
    },
    {
      method: 'GET',
      path: '/orgs/:orgId',
      access: 'admin',
      permission: 'orgs:read',
      async run(i, s) {
        return { status: 200, body: await s.getOrg(i.params.orgId!) };
      },
    },
    {
      method: 'PATCH',
      path: '/orgs/:orgId',
      access: 'admin',
      permission: 'orgs:update',
      async run(i, s) {
        return {
          status: 200,
          body: await s.updateOrg(i.params.orgId!, obj(i.body), {}, context(i)),
        };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/archive',
      access: 'admin',
      permission: 'orgs:delete',
      async run(i, s) {
        return { status: 200, body: await s.archiveOrg(i.params.orgId!, context(i)) };
      },
    },
    {
      method: 'DELETE',
      path: '/orgs/:orgId',
      access: 'admin',
      permission: 'orgs:delete',
      async run(i, s) {
        return { status: 200, body: await s.deleteOrg(i.params.orgId!, context(i)) };
      },
    },
    {
      method: 'GET',
      path: '/orgs/:orgId/members',
      access: 'admin',
      permission: 'orgs:members:read',
      async run(i, s) {
        const q: { status?: string; limit?: number; cursor?: string } = {
          limit: Number(queryValue(i.query, 'limit') ?? 50),
        };
        const status = queryValue(i.query, 'status');
        if (status !== undefined) q.status = status;
        const cursor = queryValue(i.query, 'cursor');
        if (cursor !== undefined) q.cursor = cursor;
        return { status: 200, body: await s.listMembers(i.params.orgId!, q) };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/members',
      access: 'admin',
      permission: 'orgs:members:manage',
      async run(i, s) {
        const body = obj(i.body);
        return {
          status: 201,
          body: await s.addMember(
            i.params.orgId!,
            body.userId as string,
            body.role as string | undefined,
            context(i),
          ),
        };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/invitations',
      access: 'admin',
      permission: 'orgs:invite',
      async run(i, s) {
        const body = obj(i.body);
        const input: Parameters<OrgsService['invite']>[0] = {
          orgId: i.params.orgId!,
          email: body.email as string,
        };
        if (typeof body.role === 'string') input.role = body.role;
        if (Array.isArray(body.teamIds)) input.teamIds = body.teamIds as string[];
        return { status: 201, body: await s.invite(input, context(i)) };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/teams',
      access: 'admin',
      permission: 'orgs:teams:manage',
      async run(i, s) {
        const body = obj(i.body);
        const input: { name: string; slug?: string; metadata?: Record<string, unknown> } = {
          name: body.name as string,
        };
        if (typeof body.slug === 'string') input.slug = body.slug;
        if (body.metadata && typeof body.metadata === 'object') {
          input.metadata = body.metadata as Record<string, unknown>;
        }
        return {
          status: 201,
          body: await s.createTeam(i.params.orgId!, input, context(i)),
        };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/provision',
      access: 'admin',
      permission: 'orgs:update',
      async run(i, s) {
        const body = obj(i.body);
        const opts: { strategy?: 'shared' | 'schema' | 'database' } = {};
        if (
          body.strategy === 'shared' ||
          body.strategy === 'schema' ||
          body.strategy === 'database'
        ) {
          opts.strategy = body.strategy;
        }
        return {
          status: 200,
          body: await s.provisionTenant(i.params.orgId!, opts, context(i)),
        };
      },
    },
  ];
}

export function createMemberRoutes(): OrgsRoute[] {
  return [
    {
      method: 'GET',
      path: '/me/orgs',
      access: 'member',
      async run(i, s) {
        const userId = requireUser(i);
        return { status: 200, body: await s.listMembershipsForUser(userId) };
      },
    },
    {
      method: 'GET',
      path: '/orgs/:orgId',
      access: 'member',
      async run(i, s) {
        const userId = requireUser(i);
        const ok = await s.can(userId, i.params.orgId!, 'orgs:read');
        if (!ok) throw new OrgsError('ORGS_FORBIDDEN', 'Forbidden');
        return { status: 200, body: await s.getOrg(i.params.orgId!) };
      },
    },
    {
      method: 'GET',
      path: '/orgs/:orgId/members',
      access: 'member',
      async run(i, s) {
        const userId = requireUser(i);
        const ok = await s.can(userId, i.params.orgId!, 'orgs:members:read');
        if (!ok) throw new OrgsError('ORGS_FORBIDDEN', 'Forbidden');
        const q: { limit?: number; cursor?: string } = {
          limit: Number(queryValue(i.query, 'limit') ?? 50),
        };
        const cursor = queryValue(i.query, 'cursor');
        if (cursor !== undefined) q.cursor = cursor;
        return { status: 200, body: await s.listMembers(i.params.orgId!, q) };
      },
    },
    {
      method: 'POST',
      path: '/orgs/:orgId/leave',
      access: 'member',
      async run(i, s) {
        const userId = requireUser(i);
        return { status: 200, body: await s.leaveOrg(i.params.orgId!, userId, context(i)) };
      },
    },
    {
      method: 'POST',
      path: '/invitations/accept',
      access: 'public',
      async run(i, s) {
        const body = obj(i.body);
        const userId = (body.userId as string | undefined) ?? requireUser(i);
        const input: Parameters<OrgsService['acceptInvitation']>[1] = { userId };
        if (typeof body.email === 'string') input.email = body.email;
        return {
          status: 200,
          body: await s.acceptInvitation(body.token as string, input, context(i)),
        };
      },
    },
  ];
}

export function errorOutput(err: unknown, logger: LoggerLike = noopLogger): HttpOutput {
  if (err instanceof OrgsError) {
    if (!err.expose) logger.error({ code: err.code }, err.message);
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Internal error',
          details: err.expose ? err.details : undefined,
        },
      },
    };
  }
  logger.error({ err: String(err) }, 'unhandled orgs error');
  return {
    status: 500,
    body: { error: { code: 'ORGS_INTERNAL', message: 'Internal error' } },
  };
}

export async function executeRoute(
  route: OrgsRoute,
  input: HttpInput,
  service: OrgsService,
): Promise<HttpOutput> {
  if (route.access !== 'public' && !input.actor?.id) {
    throw new OrgsError('ORGS_UNAUTHENTICATED', 'Authentication required');
  }
  if (route.access === 'admin' && route.permission && input.actor?.id && input.params.orgId) {
    const ok = await service.can(input.actor.id, input.params.orgId, route.permission);
    if (!ok) throw new OrgsError('ORGS_FORBIDDEN', 'Forbidden');
  }
  return route.run(input, service);
}

export interface RouteMatch {
  route: OrgsRoute;
  params: Record<string, string>;
}

export function matchRoute(
  routes: OrgsRoute[],
  method: string,
  path: string,
): RouteMatch | { allowed: string[] } | null {
  const normalised = path.replace(/\/+$/, '') || '/';
  const allowed: string[] = [];
  for (const route of routes) {
    const params = matchPath(route.path, normalised);
    if (!params) continue;
    if (route.method.toUpperCase() === method.toUpperCase()) return { route, params };
    allowed.push(route.method.toUpperCase());
  }
  if (allowed.length) return { allowed: [...new Set(allowed)] };
  return null;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const sp = path.split('/').filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i]!;
    const s = sp[i]!;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return params;
}

export function parseJsonBody(text: string, limit: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new OrgsError('ORGS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OrgsError('ORGS_VALIDATION_FAILED', 'Request body must be JSON');
  }
}

export function resolveBodyLimit(value: number | undefined): number {
  return value ?? DEFAULT_BODY_LIMIT;
}

export function assertRouterOptions<Req>(
  service: OrgsService,
  options: OrgsRouterOptions<Req>,
): void {
  if (!service) throw new OrgsError('ORGS_CONFIG_INVALID', 'service is required');
  if (typeof options?.resolveActor !== 'function') {
    throw new OrgsError('ORGS_CONFIG_INVALID', 'resolveActor is required');
  }
}

export async function resolveSubject<Req>(
  options: OrgsRouterOptions<Req>,
  req: Req,
): Promise<Subject | Actor | null> {
  const actor = await options.resolveActor(req);
  return actor ?? null;
}

export function toFetchResponse(out: HttpOutput): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(out.headers ?? {})) headers.set(k, v);
  if (out.body === undefined) return new Response(null, { status: out.status, headers });
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(out.body), { status: out.status, headers });
}

/** Resolve org id or slug from a request URL and headers using TenantResolution. */
export async function resolveTenantRef(
  tenant: TenantResolution | undefined,
  req: {
    headers: Record<string, string | string[] | undefined> | Headers;
    url?: string;
    host?: string;
  },
): Promise<{ orgId?: string; slug?: string } | null> {
  if (!tenant) return null;
  if (tenant.method === 'header') {
    const name = (tenant.header ?? 'x-tenant-id').toLowerCase();
    const headers = req.headers;
    let raw: string | undefined;
    if (headers instanceof Headers) raw = headers.get(name) ?? undefined;
    else {
      const v = headers[name] ?? headers[tenant.header ?? 'x-tenant-id'];
      raw = Array.isArray(v) ? v[0] : v;
    }
    return raw ? { orgId: raw } : null;
  }
  if (tenant.method === 'subdomain') {
    const host = req.host ?? '';
    const root = tenant.rootDomain.replace(/^\./, '');
    if (host.endsWith(`.${root}`)) {
      const sub = host.slice(0, -(root.length + 1)).split('.')[0];
      return sub ? { slug: sub } : null;
    }
    return null;
  }
  if (tenant.method === 'path') {
    const prefix = tenant.prefix ?? '/t/';
    const path = req.url ? new URL(req.url, 'http://local').pathname : '';
    if (path.startsWith(prefix)) {
      const slug = path.slice(prefix.length).split('/')[0];
      return slug ? { slug } : null;
    }
    return null;
  }
  const custom = await tenant.resolve(req);
  return custom ? { orgId: custom } : null;
}
