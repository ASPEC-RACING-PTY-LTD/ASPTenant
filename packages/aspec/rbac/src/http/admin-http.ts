import type { RbacAdmin } from '../admin.js';
import type { AdminCallOptions } from '../audit.js';
import type { Rbac } from '../engine.js';
import {
  isRbacError,
  RbacError,
  RbacForbiddenError,
  RbacNotFoundError,
  RbacUnauthenticatedError,
  RbacValidationError,
} from '../errors.js';
import type { ResourceRef, Subject } from '../ports.js';
import type { RbacScope } from '../types.js';
import { Issues, isRecord, normaliseScope, readIdentifier, readLimit } from '../validate.js';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails, toProblem } from './problem.js';

export interface RbacAdminHttpOptions<TReq> {
  /** Resolves the authenticated caller. Return null/undefined for anonymous (401). */
  getSubject: (request: TReq) => Subject | null | undefined | Promise<Subject | null | undefined>;
  /** Optional request id for audit events. */
  getRequestId?: (request: TReq) => string | undefined;
  /** Optional client IP for audit events. */
  getIp?: (request: TReq) => string | undefined;
  /** Optional user agent for audit events. */
  getUserAgent?: (request: TReq) => string | undefined;
  /**
   * Scope used when evaluating admin permissions. Default: query `orgId`/`teamId`,
   * else the subject's orgId, else global.
   */
  getScope?: (request: TReq, subject: Subject) => RbacScope | Promise<RbacScope>;
  /** Maximum JSON body size in bytes. Default 1 MiB. */
  bodyLimitBytes?: number;
}

export interface AdminHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface AdminRouteInput {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  call: AdminCallOptions;
  scope: RbacScope;
}

export interface AdminRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pattern: string;
  /** `read` uses adminReadPermission; `write` uses adminPermission. */
  access: 'read' | 'write';
  body: boolean;
  run(input: AdminRouteInput): Promise<AdminHttpResponse>;
}

export interface AdminRawRequest<TReq> {
  request: TReq;
  params: Record<string, string>;
  query: URLSearchParams;
  contentType: string | undefined;
  readBody: () => Promise<unknown>;
}

export interface RbacAdminHttp<TReq> {
  readonly routes: readonly AdminRoute[];
  readonly bodyLimitBytes: number;
  match(
    method: string,
    path: string,
  ): { route: AdminRoute; params: Record<string, string> } | undefined;
  handle(route: AdminRoute, raw: AdminRawRequest<TReq>): Promise<AdminHttpResponse>;
  errorResponse(err: unknown): AdminHttpResponse;
}

function json(body: unknown, status = 200): AdminHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body,
  };
}

function noContent(): AdminHttpResponse {
  return { status: 204, headers: { 'cache-control': 'no-store' } };
}

function problemResponse(err: unknown): AdminHttpResponse {
  const problem: ProblemDetails = toProblem(err);
  return {
    status: problem.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, 'cache-control': 'no-store' },
    body: problem,
  };
}

export function parseJsonBody(text: string, limit: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new RbacError('RBAC_PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`, {
      status: 413,
      expose: true,
    });
  }
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new RbacValidationError('request body is not valid JSON', [
      { path: 'body', message: 'must be valid JSON' },
    ]);
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const pp = splitPath(pattern);
  const tp = splitPath(path);
  if (pp.length !== tp.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i] as string;
    const t = tp[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(t);
    else if (p !== t) return undefined;
  }
  return params;
}

function queryOrgScope(query: URLSearchParams, subject: Subject): RbacScope {
  const orgId = query.get('orgId') ?? undefined;
  const teamId = query.get('teamId') ?? undefined;
  if (orgId || teamId) return normaliseScope({ orgId, teamId });
  if (subject.orgId) return { orgId: subject.orgId };
  return {};
}

function pageArgs(query: URLSearchParams): { limit: number; cursor?: string } {
  const issues = new Issues();
  const limit = readLimit(query.get('limit'), 'limit', issues);
  issues.throwIfAny('Invalid query');
  const cursor = query.get('cursor') ?? undefined;
  return cursor === undefined ? { limit } : { limit, cursor };
}

/**
 * Framework-agnostic admin HTTP layer: route table, authentication, authorisation,
 * body handling and error mapping. Adapters only translate requests.
 */
export function createRbacAdminHttp<TReq>(
  rbac: Rbac,
  options: RbacAdminHttpOptions<TReq>,
): RbacAdminHttp<TReq> {
  if (!rbac || typeof rbac.can !== 'function') {
    throw new RbacError('RBAC_CONFIG', 'rbac admin router: an Rbac instance is required', {
      status: 500,
      expose: false,
    });
  }
  if (!options || typeof options.getSubject !== 'function') {
    throw new RbacError('RBAC_CONFIG', 'rbac admin router: option "getSubject" is required', {
      status: 500,
      expose: false,
    });
  }
  const bodyLimitBytes = options.bodyLimitBytes ?? 1024 * 1024;
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new RbacError(
      'RBAC_CONFIG',
      'rbac admin router: option "bodyLimitBytes" must be a positive integer',
      {
        status: 500,
        expose: false,
      },
    );
  }
  const admin: RbacAdmin = rbac.admin;

  const authorize = async (subject: Subject, access: 'read' | 'write', scope: RbacScope) => {
    const permission = access === 'read' ? rbac.adminReadPermission : rbac.adminPermission;
    const allowed = await rbac.can(subject, permission, undefined, { scope });
    if (allowed) return;
    // Missing records answer 403 unless the actor is authorised globally, to avoid leaking existence.
    if (scope.orgId !== undefined) {
      const globalOk = await rbac.can(subject, permission, undefined, { scope: {} });
      if (globalOk) return;
    }
    throw new RbacForbiddenError('Forbidden', permission);
  };

  const routes: AdminRoute[] = [
    {
      method: 'GET',
      pattern: '/permissions',
      access: 'read',
      body: false,
      run: async () => json(await admin.listPermissions()),
    },
    {
      method: 'POST',
      pattern: '/permissions',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.createPermission(body as never, call), 201),
    },
    {
      method: 'PATCH',
      pattern: '/permissions/:key',
      access: 'write',
      body: true,
      run: async ({ params, body, call }) =>
        json(await admin.updatePermission(params.key as string, body as never, call)),
    },
    {
      method: 'DELETE',
      pattern: '/permissions/:key',
      access: 'write',
      body: false,
      run: async ({ params, query, call }) => {
        await admin.deletePermission(params.key as string, {
          ...call,
          force: query.get('force') === 'true',
        });
        return noContent();
      },
    },
    {
      method: 'GET',
      pattern: '/roles',
      access: 'read',
      body: false,
      run: async () => json(await admin.listRoles()),
    },
    {
      method: 'GET',
      pattern: '/roles/:key',
      access: 'read',
      body: false,
      run: async ({ params }) => json(await admin.getRole(params.key as string)),
    },
    {
      method: 'GET',
      pattern: '/roles/:key/effective-permissions',
      access: 'read',
      body: false,
      run: async ({ params }) =>
        json({
          roleKey: params.key,
          permissions: await admin.effectivePermissions(params.key as string),
        }),
    },
    {
      method: 'POST',
      pattern: '/roles',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.createRole(body as never, call), 201),
    },
    {
      method: 'PATCH',
      pattern: '/roles/:key',
      access: 'write',
      body: true,
      run: async ({ params, body, call }) =>
        json(await admin.updateRole(params.key as string, body as never, call)),
    },
    {
      method: 'DELETE',
      pattern: '/roles/:key',
      access: 'write',
      body: false,
      run: async ({ params, query, call }) => {
        await admin.deleteRole(params.key as string, {
          ...call,
          force: query.get('force') === 'true',
        });
        return noContent();
      },
    },
    {
      method: 'GET',
      pattern: '/assignments',
      access: 'read',
      body: false,
      run: async ({ query }) => {
        const page = pageArgs(query);
        const orgRaw = query.get('orgId');
        const teamRaw = query.get('teamId');
        return json(
          await admin.listAssignments({
            ...page,
            ...(query.get('subjectId') ? { subjectId: query.get('subjectId') as string } : {}),
            ...(query.get('roleKey') ? { roleKey: query.get('roleKey') as string } : {}),
            ...(orgRaw === null ? {} : { orgId: orgRaw === '' ? null : orgRaw }),
            ...(teamRaw === null ? {} : { teamId: teamRaw === '' ? null : teamRaw }),
          }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/assignments',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.assignRole(body as never, call), 201),
    },
    {
      method: 'DELETE',
      pattern: '/assignments/:id',
      access: 'write',
      body: false,
      run: async ({ params, call }) => {
        await admin.revokeRole({ id: params.id as string }, call);
        return noContent();
      },
    },
    {
      method: 'POST',
      pattern: '/assignments/revoke',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.revokeRole(body as never, call)),
    },
    {
      method: 'GET',
      pattern: '/grants',
      access: 'read',
      body: false,
      run: async ({ query }) => {
        const page = pageArgs(query);
        const orgRaw = query.get('orgId');
        return json(
          await admin.listGrants({
            ...page,
            ...(query.get('subjectId') ? { subjectId: query.get('subjectId') as string } : {}),
            ...(query.get('roleKey') ? { roleKey: query.get('roleKey') as string } : {}),
            ...(query.get('resourceType')
              ? { resourceType: query.get('resourceType') as string }
              : {}),
            ...(query.get('resourceId') ? { resourceId: query.get('resourceId') as string } : {}),
            ...(orgRaw === null ? {} : { orgId: orgRaw === '' ? null : orgRaw }),
          }),
        );
      },
    },
    {
      method: 'POST',
      pattern: '/grants',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.grant(body as never, call), 201),
    },
    {
      method: 'DELETE',
      pattern: '/grants/:id',
      access: 'write',
      body: false,
      run: async ({ params, call }) => {
        await admin.revokeGrant(params.id as string, call);
        return noContent();
      },
    },
    {
      method: 'GET',
      pattern: '/ownership-rules',
      access: 'read',
      body: false,
      run: async () => json(await admin.listOwnershipRules()),
    },
    {
      method: 'POST',
      pattern: '/ownership-rules',
      access: 'write',
      body: true,
      run: async ({ body, call }) =>
        json(await admin.createOwnershipRule(body as never, call), 201),
    },
    {
      method: 'PATCH',
      pattern: '/ownership-rules/:id',
      access: 'write',
      body: true,
      run: async ({ params, body, call }) =>
        json(await admin.updateOwnershipRule(params.id as string, body as never, call)),
    },
    {
      method: 'DELETE',
      pattern: '/ownership-rules/:id',
      access: 'write',
      body: false,
      run: async ({ params, call }) => {
        await admin.deleteOwnershipRule(params.id as string, call);
        return noContent();
      },
    },
    {
      method: 'GET',
      pattern: '/policies',
      access: 'read',
      body: false,
      run: async () => json(await admin.listPolicies()),
    },
    {
      method: 'POST',
      pattern: '/policies',
      access: 'write',
      body: true,
      run: async ({ body, call }) => json(await admin.createPolicy(body as never, call), 201),
    },
    {
      method: 'PATCH',
      pattern: '/policies/:id',
      access: 'write',
      body: true,
      run: async ({ params, body, call }) =>
        json(await admin.updatePolicy(params.id as string, body as never, call)),
    },
    {
      method: 'DELETE',
      pattern: '/policies/:id',
      access: 'write',
      body: false,
      run: async ({ params, call }) => {
        await admin.deletePolicy(params.id as string, call);
        return noContent();
      },
    },
    {
      method: 'POST',
      pattern: '/purge-expired',
      access: 'write',
      body: false,
      run: async ({ call }) => json(await admin.purgeExpired(call)),
    },
    {
      method: 'POST',
      pattern: '/explain',
      access: 'read',
      body: true,
      run: async ({ body, scope }) => {
        if (!isRecord(body)) throw new RbacValidationError('Invalid explain body');
        const issues = new Issues();
        const subjectId = readIdentifier(body.subjectId, 'subjectId', issues, true);
        const permission = typeof body.permission === 'string' ? body.permission : undefined;
        if (!permission) issues.add('permission', 'is required');
        issues.throwIfAny('Invalid explain body');
        const subject: Subject = {
          id: subjectId as string,
          ...(typeof body.orgId === 'string' ? { orgId: body.orgId } : {}),
          ...(Array.isArray(body.roles) ? { roles: body.roles as string[] } : {}),
        };
        let resource: ResourceRef | undefined;
        if (isRecord(body.resource)) {
          resource = {
            type: String(body.resource.type),
            ...(body.resource.id === undefined ? {} : { id: String(body.resource.id) }),
            ...(body.resource.ownerId === undefined
              ? {}
              : { ownerId: String(body.resource.ownerId) }),
            ...(body.resource.orgId === undefined ? {} : { orgId: String(body.resource.orgId) }),
            ...(body.resource.teamId === undefined ? {} : { teamId: String(body.resource.teamId) }),
          };
        }
        return json(
          await rbac.explain(subject, permission as string, resource, {
            scope: isRecord(body.scope) ? normaliseScope(body.scope) : scope,
            ...(isRecord(body.context) ? body.context : {}),
          }),
        );
      },
    },
    {
      method: 'GET',
      pattern: '/subjects/:id/permissions',
      access: 'read',
      body: false,
      run: async ({ params, query, scope }) => {
        const subject: Subject = { id: params.id as string };
        const orgId = query.get('orgId');
        const teamId = query.get('teamId');
        const s =
          orgId || teamId
            ? normaliseScope({ orgId: orgId ?? undefined, teamId: teamId ?? undefined })
            : scope;
        return json(await rbac.permissionsFor(subject, s));
      },
    },
  ];

  return {
    routes,
    bodyLimitBytes,
    match(method, path) {
      const normalised = path.startsWith('/') ? path : `/${path}`;
      for (const route of routes) {
        if (route.method !== method.toUpperCase()) continue;
        const params = matchPattern(route.pattern, normalised);
        if (params) return { route, params };
      }
      return undefined;
    },
    async handle(route, raw) {
      const subject = await options.getSubject(raw.request);
      if (!subject) throw new RbacUnauthenticatedError();

      const scope = options.getScope
        ? await options.getScope(raw.request, subject)
        : queryOrgScope(raw.query, subject);

      await authorize(subject, route.access, scope);

      if (route.body) {
        const ct = (raw.contentType ?? '').toLowerCase();
        if (ct && !ct.includes('application/json') && !ct.includes('+json')) {
          throw new RbacError(
            'RBAC_UNSUPPORTED_MEDIA_TYPE',
            'Content-Type must be application/json',
            {
              status: 415,
              expose: true,
            },
          );
        }
      }

      const body = route.body ? await raw.readBody() : undefined;
      const call: AdminCallOptions = { actor: subject };
      const requestId = options.getRequestId?.(raw.request);
      const ip = options.getIp?.(raw.request);
      const userAgent = options.getUserAgent?.(raw.request);
      if (requestId !== undefined) call.requestId = requestId;
      if (ip !== undefined) call.ip = ip;
      if (userAgent !== undefined) call.userAgent = userAgent;

      try {
        return await route.run({
          params: raw.params,
          query: raw.query,
          body,
          call,
          scope,
        });
      } catch (err) {
        // Hide not-found as 403 when the actor lacks global admin, to avoid leaking existence.
        if (isRbacError(err) && err.status === 404 && scope.orgId !== undefined) {
          const permission =
            route.access === 'read' ? rbac.adminReadPermission : rbac.adminPermission;
          const globalOk = await rbac.can(subject, permission, undefined, { scope: {} });
          if (!globalOk) throw new RbacForbiddenError('Forbidden', permission);
        }
        throw err;
      }
    },
    errorResponse(err) {
      if (err instanceof RbacNotFoundError && err.code === 'RBAC_ROUTE_NOT_FOUND') {
        return problemResponse(err);
      }
      return problemResponse(err);
    },
  };
}
