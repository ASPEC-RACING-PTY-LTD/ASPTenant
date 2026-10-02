import { UsersError, validationError } from './errors.js';
import type { LoggerLike, Subject } from './ports.js';
import type { UsersPermission, UsersService } from './service.js';
import type { ActionContext, InvitationStatus, User, UserStatus } from './types.js';

/** Resolves the authenticated caller from a framework request. Return null when anonymous. */
export type ResolveActor<Req> = (
  req: Req,
) => Subject | null | undefined | Promise<Subject | null | undefined>;

export interface UsersRouterOptions<Req> {
  /** Maps a request to the authenticated subject using your authentication system. */
  resolveActor: ResolveActor<Req>;
  /** Maximum JSON body size in bytes. Default 65536. */
  bodyLimit?: number;
  logger?: LoggerLike;
}

export interface HttpInput {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  header(name: string): string | undefined;
  actor: Subject | null;
  ip?: string;
  userAgent?: string;
}

export interface HttpOutput {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteAccess = 'admin' | 'self' | 'public';

export interface UsersRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path relative to the mount point, with `:param` segments. */
  path: string;
  access: RouteAccess;
  permission?: UsersPermission;
  run(input: HttpInput): Promise<HttpOutput>;
}

export const DEFAULT_BODY_LIMIT = 65_536;

const noopLogger: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

function obj(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw validationError([{ path: '', message: 'request body must be a JSON object' }]);
  }
  return body as Record<string, unknown>;
}

function context(input: HttpInput): ActionContext {
  const ctx: ActionContext = {};
  if (input.actor) {
    const actor: NonNullable<ActionContext['actor']> = { id: input.actor.id };
    if (input.actor.type !== undefined) actor.type = input.actor.type;
    if (input.ip !== undefined) actor.ip = input.ip;
    if (input.userAgent !== undefined) actor.userAgent = input.userAgent;
    ctx.actor = actor;
  }
  const requestId = input.header('x-request-id');
  if (requestId && requestId.length <= 200) ctx.requestId = requestId;
  return ctx;
}

function ifMatch(input: HttpInput): number | undefined {
  const raw = input.header('if-match');
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 1) {
    throw validationError([
      { path: 'If-Match', message: 'must be a user version, for example "3"' },
    ]);
  }
  return n;
}

function userResponse(user: User, status = 200): HttpOutput {
  return { status, body: user, headers: { etag: `"${user.version}"` } };
}

function queryValue(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name);
  return v === null ? undefined : v;
}

function parseUntil(value: unknown): Date | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  throw validationError([
    { path: 'until', message: 'must be an ISO 8601 date or epoch milliseconds' },
  ]);
}

function listQuery(q: URLSearchParams) {
  const out: { cursor?: string; limit?: number } = {};
  const cursor = queryValue(q, 'cursor');
  if (cursor !== undefined) out.cursor = cursor;
  const limit = queryValue(q, 'limit');
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1)
      throw validationError([{ path: 'limit', message: 'must be a positive integer' }]);
    out.limit = n;
  }
  return out;
}

/** Admin API routes. Every route is authorised through the PermissionChecker. */
export function createAdminRoutes(service: UsersService): UsersRoute[] {
  const id = (i: HttpInput) => i.params.id as string;
  return [
    {
      method: 'GET',
      path: '/users',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        const q: Parameters<UsersService['listUsers']>[0] = listQuery(i.query);
        const status = queryValue(i.query, 'status');
        if (status !== undefined) q.status = status as UserStatus;
        const search = queryValue(i.query, 'search');
        if (search !== undefined) q.search = search;
        return { status: 200, body: await service.listUsers(q) };
      },
    },
    {
      method: 'POST',
      path: '/users',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        const body = obj(i.body) as unknown as Parameters<UsersService['createUser']>[0];
        return userResponse(await service.createUser(body, context(i)), 201);
      },
    },
    {
      method: 'GET',
      path: '/users/:id',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        return userResponse(await service.getUser(id(i)));
      },
    },
    {
      method: 'PATCH',
      path: '/users/:id/profile',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const opts: { expectedVersion?: number } = {};
        const v = ifMatch(i);
        if (v !== undefined) opts.expectedVersion = v;
        return userResponse(await service.updateProfile(id(i), obj(i.body), opts, context(i)));
      },
    },
    {
      method: 'PUT',
      path: '/users/:id/email',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const opts: { expectedVersion?: number } = {};
        const v = ifMatch(i);
        if (v !== undefined) opts.expectedVersion = v;
        const email = obj(i.body).email as string;
        return userResponse(await service.changeEmail(id(i), email, opts, context(i)));
      },
    },
    {
      method: 'PUT',
      path: '/users/:id/identity',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const b = obj(i.body);
        const identity = {
          authProvider: b.authProvider as string,
          externalId: b.externalId as string,
        };
        return userResponse(await service.linkIdentity(id(i), identity, {}, context(i)));
      },
    },
    {
      method: 'DELETE',
      path: '/users/:id/identity',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        return userResponse(await service.linkIdentity(id(i), null, {}, context(i)));
      },
    },
    {
      method: 'PUT',
      path: '/users/:id/metadata',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const opts: { expectedVersion?: number } = {};
        const v = ifMatch(i);
        if (v !== undefined) opts.expectedVersion = v;
        return userResponse(await service.updateMetadata(id(i), obj(i.body), opts, context(i)));
      },
    },
    {
      method: 'GET',
      path: '/users/:id/settings',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        return { status: 200, body: await service.getSettings(id(i)) };
      },
    },
    {
      method: 'PATCH',
      path: '/users/:id/settings',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const opts: { expectedVersion?: number } = {};
        const v = ifMatch(i);
        if (v !== undefined) opts.expectedVersion = v;
        const user = await service.updateSettings(id(i), obj(i.body), opts, context(i));
        return {
          status: 200,
          body: await service.getSettings(user.id),
          headers: { etag: `"${user.version}"` },
        };
      },
    },
    {
      method: 'GET',
      path: '/users/:id/preferences',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        return { status: 200, body: await service.getPreferences(id(i)) };
      },
    },
    {
      method: 'PATCH',
      path: '/users/:id/preferences',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        const opts: { expectedVersion?: number } = {};
        const v = ifMatch(i);
        if (v !== undefined) opts.expectedVersion = v;
        const user = await service.updatePreferences(id(i), obj(i.body), opts, context(i));
        return {
          status: 200,
          body: await service.getPreferences(user.id),
          headers: { etag: `"${user.version}"` },
        };
      },
    },
    {
      method: 'POST',
      path: '/users/:id/suspend',
      access: 'admin',
      permission: 'users:suspend',
      async run(i) {
        const b = obj(i.body);
        const input: Parameters<UsersService['suspendUser']>[1] = { reason: b.reason as string };
        const until = parseUntil(b.until);
        if (until !== undefined) input.until = until;
        return userResponse(await service.suspendUser(id(i), input, context(i)));
      },
    },
    {
      method: 'POST',
      path: '/users/:id/reactivate',
      access: 'admin',
      permission: 'users:suspend',
      async run(i) {
        return userResponse(await service.reactivateUser(id(i), context(i)));
      },
    },
    {
      method: 'POST',
      path: '/users/:id/activate',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        return userResponse(await service.activateUser(id(i), context(i)));
      },
    },
    {
      method: 'POST',
      path: '/users/:id/activation-token',
      access: 'admin',
      permission: 'users:update',
      async run(i) {
        return { status: 201, body: await service.createActivationToken(id(i), context(i)) };
      },
    },
    {
      method: 'POST',
      path: '/users/:id/deletion',
      access: 'admin',
      permission: 'users:delete',
      async run(i) {
        const b = obj(i.body);
        const input: Parameters<UsersService['requestDeletion']>[1] = {};
        if (b.reason !== undefined) input.reason = b.reason as string;
        if (b.gracePeriodMs !== undefined) input.gracePeriodMs = b.gracePeriodMs as number;
        return userResponse(await service.requestDeletion(id(i), input, context(i)));
      },
    },
    {
      method: 'DELETE',
      path: '/users/:id/deletion',
      access: 'admin',
      permission: 'users:delete',
      async run(i) {
        return userResponse(await service.cancelDeletion(id(i), context(i)));
      },
    },
    {
      method: 'POST',
      path: '/users/:id/purge',
      access: 'admin',
      permission: 'users:delete',
      async run(i) {
        const force = obj(i.body).force === true;
        return { status: 200, body: await service.purgeUser(id(i), { force }, context(i)) };
      },
    },
    {
      method: 'GET',
      path: '/users/:id/export',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        return { status: 200, body: await service.exportUserData(id(i), context(i)) };
      },
    },
    {
      method: 'GET',
      path: '/users/:id/activity',
      access: 'admin',
      permission: 'users:read',
      async run(i) {
        const q: Parameters<UsersService['listActivity']>[1] = listQuery(i.query);
        const type = queryValue(i.query, 'type');
        if (type !== undefined) q.type = type;
        return { status: 200, body: await service.listActivity(id(i), q) };
      },
    },
    {
      method: 'GET',
      path: '/invitations',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        const q: Parameters<UsersService['listInvitations']>[0] = listQuery(i.query);
        const status = queryValue(i.query, 'status');
        if (status !== undefined) q.status = status as InvitationStatus;
        const email = queryValue(i.query, 'email');
        if (email !== undefined) q.email = email;
        return { status: 200, body: await service.listInvitations(q) };
      },
    },
    {
      method: 'POST',
      path: '/invitations',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        const b = obj(i.body) as unknown as Parameters<UsersService['inviteUser']>[0];
        return { status: 201, body: await service.inviteUser(b, context(i)) };
      },
    },
    {
      method: 'GET',
      path: '/invitations/:id',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        return { status: 200, body: await service.getInvitation(id(i)) };
      },
    },
    {
      method: 'POST',
      path: '/invitations/:id/resend',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        return { status: 200, body: await service.resendInvitation(id(i), context(i)) };
      },
    },
    {
      method: 'POST',
      path: '/invitations/:id/revoke',
      access: 'admin',
      permission: 'users:invite',
      async run(i) {
        return { status: 200, body: await service.revokeInvitation(id(i), context(i)) };
      },
    },
  ];
}

/** Self-service routes acting on the resolved actor, plus public activation and acceptance. */
export function createSelfServiceRoutes(service: UsersService): UsersRoute[] {
  const self = async (i: HttpInput, opts: { mutate: boolean }): Promise<User> => {
    const user = await service.getUser((i.actor as Subject).id);
    if (opts.mutate && user.status === 'suspended') {
      throw new UsersError('USERS_SUSPENDED', 'The account is suspended');
    }
    return user;
  };
  const selfUpdate = (i: HttpInput) => {
    const opts: { expectedVersion?: number; selfService: true } = { selfService: true };
    const v = ifMatch(i);
    if (v !== undefined) opts.expectedVersion = v;
    return opts;
  };
  return [
    {
      method: 'GET',
      path: '/me',
      access: 'self',
      async run(i) {
        return userResponse(await self(i, { mutate: false }));
      },
    },
    {
      method: 'PATCH',
      path: '/me/profile',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: true });
        return userResponse(
          await service.updateProfile(user.id, obj(i.body), selfUpdate(i), context(i)),
        );
      },
    },
    {
      method: 'GET',
      path: '/me/settings',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: false });
        return { status: 200, body: await service.getSettings(user.id) };
      },
    },
    {
      method: 'PATCH',
      path: '/me/settings',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: true });
        const next = await service.updateSettings(user.id, obj(i.body), selfUpdate(i), context(i));
        return {
          status: 200,
          body: await service.getSettings(next.id),
          headers: { etag: `"${next.version}"` },
        };
      },
    },
    {
      method: 'GET',
      path: '/me/preferences',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: false });
        return { status: 200, body: await service.getPreferences(user.id) };
      },
    },
    {
      method: 'PATCH',
      path: '/me/preferences',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: true });
        const next = await service.updatePreferences(
          user.id,
          obj(i.body),
          selfUpdate(i),
          context(i),
        );
        return {
          status: 200,
          body: await service.getPreferences(next.id),
          headers: { etag: `"${next.version}"` },
        };
      },
    },
    {
      method: 'GET',
      path: '/me/activity',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: false });
        const q: Parameters<UsersService['listActivity']>[1] = listQuery(i.query);
        const type = queryValue(i.query, 'type');
        if (type !== undefined) q.type = type;
        return { status: 200, body: await service.listActivity(user.id, q) };
      },
    },
    {
      method: 'GET',
      path: '/me/export',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: false });
        return { status: 200, body: await service.exportUserData(user.id, context(i)) };
      },
    },
    {
      method: 'POST',
      path: '/me/deletion',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: true });
        const b = obj(i.body);
        const input: Parameters<UsersService['requestDeletion']>[1] = {};
        if (b.reason !== undefined) input.reason = b.reason as string;
        return userResponse(await service.requestDeletion(user.id, input, context(i)));
      },
    },
    {
      method: 'DELETE',
      path: '/me/deletion',
      access: 'self',
      async run(i) {
        const user = await self(i, { mutate: false });
        return userResponse(await service.cancelDeletion(user.id, context(i)));
      },
    },
    {
      method: 'POST',
      path: '/activate',
      access: 'public',
      async run(i) {
        const token = obj(i.body).token;
        if (typeof token !== 'string')
          throw validationError([{ path: 'token', message: 'is required' }]);
        return userResponse(await service.activateWithToken(token, context(i)));
      },
    },
    {
      method: 'POST',
      path: '/invitations/accept',
      access: 'public',
      async run(i) {
        const b = obj(i.body);
        if (typeof b.token !== 'string')
          throw validationError([{ path: 'token', message: 'is required' }]);
        const input: Parameters<UsersService['acceptInvitation']>[1] = {};
        if (i.actor) input.userId = i.actor.id;
        if (b.profile !== undefined) input.profile = obj(b.profile);
        const result = await service.acceptInvitation(b.token, input, context(i));
        return { status: result.created ? 201 : 200, body: result };
      },
    },
  ];
}

/** Converts an error into a safe JSON response. Internal details are never exposed. */
export function errorOutput(err: unknown, logger: LoggerLike = noopLogger): HttpOutput {
  if (err instanceof UsersError) {
    if (err.status >= 500) {
      logger.error({ code: err.code, message: err.message }, 'users request failed');
    }
    const error: Record<string, unknown> = {
      code: err.code,
      message: err.expose ? err.message : 'Internal server error',
    };
    if (err.expose && err.details !== undefined) error.details = err.details;
    const headers: Record<string, string> = {};
    const retry = (err.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    if (typeof retry === 'number') headers['retry-after'] = String(Math.ceil(retry / 1000));
    return { status: err.status, body: { error }, headers };
  }
  logger.error(
    { err: err instanceof Error ? { name: err.name, message: err.message } : String(err) },
    'users request failed',
  );
  return {
    status: 500,
    body: { error: { code: 'USERS_INTERNAL', message: 'Internal server error' } },
  };
}

/** Runs a matched route: authentication, authorisation and error mapping. */
export async function executeRoute(
  service: UsersService,
  route: UsersRoute,
  input: HttpInput,
  logger: LoggerLike = noopLogger,
): Promise<HttpOutput> {
  try {
    if (route.access !== 'public' && !input.actor) {
      throw new UsersError('USERS_UNAUTHENTICATED', 'Authentication required');
    }
    if (route.permission) {
      const actor = input.actor as Subject;
      const resource: { type: string; id?: string } = {
        type: route.path.startsWith('/invitations') ? 'invitation' : 'user',
      };
      if (input.params.id !== undefined) resource.id = input.params.id;
      const allowed = await service.can(actor, route.permission, resource);
      if (!allowed)
        throw new UsersError(
          'USERS_FORBIDDEN',
          'You do not have permission to perform this action',
        );
    }
    return await route.run(input);
  } catch (err) {
    return errorOutput(err, logger);
  }
}

export interface RouteMatch {
  route: UsersRoute;
  params: Record<string, string>;
}

/** Matches a path relative to the mount point. Returns `allowed` methods on a 405. */
export function matchRoute(
  routes: readonly UsersRoute[],
  method: string,
  path: string,
): RouteMatch | { allowed: string[] } | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  const allowed: string[] = [];
  for (const route of routes) {
    const parts = route.path.split('/').filter((s) => s.length > 0);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k] as string;
      const seg = segments[k] as string;
      if (part.startsWith(':')) {
        let value: string;
        try {
          value = decodeURIComponent(seg);
        } catch {
          ok = false;
          break;
        }
        if (value.length === 0 || value.length > 200 || value.includes('/')) {
          ok = false;
          break;
        }
        params[part.slice(1)] = value;
      } else if (part !== seg) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (route.method === method.toUpperCase()) return { route, params };
    allowed.push(route.method);
  }
  return allowed.length > 0 ? { allowed } : null;
}

/** Parses a JSON body string with a size limit. Empty bodies become undefined. */
export function parseJsonBody(text: string, limit: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new UsersError('USERS_PAYLOAD_TOO_LARGE', `Request body exceeds ${limit} bytes`);
  }
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw validationError([{ path: '', message: 'request body must be valid JSON' }]);
  }
}

export function resolveBodyLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BODY_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new UsersError('USERS_CONFIG_INVALID', 'bodyLimit must be a positive integer');
  }
  return value;
}

/** Validates router options shared by every adapter. */
export function assertRouterOptions(
  service: UsersService,
  options: { resolveActor?: unknown } | undefined,
  kind: 'admin' | 'self',
): void {
  if (!service || typeof service.getUser !== 'function') {
    throw new UsersError('USERS_CONFIG_INVALID', 'A UsersService from createUsers() is required');
  }
  if (!options || typeof options.resolveActor !== 'function') {
    throw new UsersError('USERS_CONFIG_INVALID', 'options.resolveActor(req) is required');
  }
  if (kind === 'admin' && !service.hasPermissionChecker) {
    throw new UsersError(
      'USERS_CONFIG_INVALID',
      'The admin router requires createUsers({ permissions }) so routes can be authorised',
    );
  }
}

/** Normalises a resolved actor. Invalid values are treated as anonymous. */
export async function resolveSubject<Req>(
  resolve: ResolveActor<Req>,
  req: Req,
): Promise<Subject | null> {
  const actor = await resolve(req);
  if (
    !actor ||
    typeof actor !== 'object' ||
    typeof actor.id !== 'string' ||
    actor.id.length === 0
  ) {
    return null;
  }
  return actor;
}

/** Builds a Fetch API Response from a route output. */
export function toFetchResponse(out: HttpOutput): Response {
  const headers = new Headers(out.headers ?? {});
  headers.set('cache-control', 'no-store');
  if (out.body === undefined) return new Response(null, { status: out.status, headers });
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(out.body), { status: out.status, headers });
}
