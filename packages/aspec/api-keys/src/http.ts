import { ApiKeysError, isApiKeysError } from './errors.js';
import type { PermissionChecker, Subject } from './ports.js';
import type { ApiKeys, ApiKeysPermission } from './service.js';
import { API_KEYS_PERMISSIONS } from './service.js';
import type { VerifiedPrincipal } from './types.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  code?: string;
  retryAfter?: number;
}

export interface HttpOutput {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export function problem(
  status: number,
  title: string,
  detail: string,
  code?: string,
  extra?: Record<string, unknown>,
): HttpOutput {
  const body: ProblemBody = {
    type: 'about:blank',
    title,
    status,
    detail,
    ...(code ? { code } : {}),
    ...extra,
  };
  return {
    status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, 'cache-control': 'no-store' },
    body,
  };
}

export function errorOutput(err: unknown): HttpOutput {
  if (isApiKeysError(err)) {
    return problem(
      err.status,
      err.expose ? err.message : 'Request failed',
      err.expose ? err.message : 'An error occurred',
      err.code,
    );
  }
  return problem(500, 'Internal Server Error', 'An unexpected error occurred');
}

export function unauthorizedProblem(): HttpOutput {
  return problem(401, 'Unauthorized', 'Invalid or missing API key', 'API_KEYS_UNAUTHORIZED');
}

export function extractRawKey(header: (name: string) => string | undefined): string | undefined {
  const apiKey = header('x-api-key')?.trim();
  if (apiKey) return apiKey;
  const auth = header('authorization');
  if (!auth) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  return match?.[1];
}

export type AuthorizeFn = (subject: Subject, action: ApiKeysPermission) => Promise<boolean>;

export interface AdminRouterOptions {
  authorize?: AuthorizeFn | PermissionChecker;
  resolveActor: (input: AdminRequestInput) => Subject | Promise<Subject | undefined> | undefined;
  logger?: { error(obj: Record<string, unknown>, msg?: string): void };
  bodyLimit?: number;
}

export interface AdminRequestInput {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  header: (name: string) => string | undefined;
  ip?: string;
  userAgent?: string;
}

export interface AdminRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  permission: ApiKeysPermission;
  handler: (
    api: ApiKeys,
    input: AdminRequestInput,
    params: Record<string, string>,
  ) => Promise<HttpOutput>;
}

function matchPath(
  pattern: RegExp,
  paramNames: string[],
  path: string,
): Record<string, string> | undefined {
  const m = pattern.exec(path);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]!] = decodeURIComponent(m[i + 1]!);
  }
  return params;
}

async function checkAuth(
  options: AdminRouterOptions,
  input: AdminRequestInput,
  permission: ApiKeysPermission,
): Promise<Subject | HttpOutput> {
  const actor = await options.resolveActor(input);
  if (!actor) return unauthorizedProblem();
  if (!options.authorize) return actor;
  const auth = options.authorize;
  const allowed =
    typeof (auth as PermissionChecker).can === 'function'
      ? await (auth as PermissionChecker).can(actor, permission)
      : await (auth as AuthorizeFn)(actor, permission);
  if (!allowed) {
    return problem(403, 'Forbidden', 'Permission denied', 'API_KEYS_FORBIDDEN');
  }
  return actor;
}

function jsonBody(input: AdminRequestInput): Record<string, unknown> {
  if (input.body === undefined || input.body === null) return {};
  if (typeof input.body !== 'object' || Array.isArray(input.body)) {
    throw new ApiKeysError('API_KEYS_VALIDATION', 'JSON object body required', {
      status: 400,
      expose: true,
    });
  }
  return input.body as Record<string, unknown>;
}

function optStr(v: string | null): string | undefined {
  return v === null || v === '' ? undefined : v;
}

export function createAdminRoutes(_api: ApiKeys): AdminRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/keys\/?$/,
      paramNames: [],
      permission: 'api_keys:read',
      async handler(api, input) {
        const q = input.query;
        const query: Parameters<ApiKeys['list']>[0] = {};
        const cursor = optStr(q.get('cursor'));
        if (cursor) query.cursor = cursor;
        if (q.get('limit')) query.limit = Number(q.get('limit'));
        const status = optStr(q.get('status'));
        if (status === 'active' || status === 'revoked' || status === 'expired')
          query.status = status;
        const ownerType = optStr(q.get('ownerType'));
        if (ownerType === 'user' || ownerType === 'service_account') query.ownerType = ownerType;
        const ownerId = optStr(q.get('ownerId'));
        if (ownerId) query.ownerId = ownerId;
        const orgId = optStr(q.get('orgId'));
        if (orgId) query.orgId = orgId;
        const scope = optStr(q.get('scope'));
        if (scope) query.scope = scope;
        if (q.get('expiringWithinDays'))
          query.expiringWithinDays = Number(q.get('expiringWithinDays'));
        const search = optStr(q.get('q'));
        if (search) query.q = search;
        return { status: 200, body: await api.list(query) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/keys\/?$/,
      paramNames: [],
      permission: 'api_keys:create',
      async handler(api, input) {
        const body = jsonBody(input);
        const created = await api.create({
          name: String(body.name ?? ''),
          scopes: (body.scopes as string[]) ?? [],
          ownerType: body.ownerType as 'user' | 'service_account',
          ownerId: String(body.ownerId ?? ''),
          orgId: (body.orgId as string | null | undefined) ?? null,
          ...(body.metadata !== undefined
            ? { metadata: body.metadata as Record<string, unknown> }
            : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt as number | null } : {}),
          ...(body.ttlMs !== undefined ? { ttlMs: Number(body.ttlMs) } : {}),
          neverExpires: body.neverExpires === true,
          ...(body.rateLimit !== undefined ? { rateLimit: body.rateLimit as number | null } : {}),
          ...(body.rateLimitWindowMs !== undefined
            ? { rateLimitWindowMs: body.rateLimitWindowMs as number | null }
            : {}),
        });
        return { status: 201, body: created };
      },
    },
    {
      method: 'GET',
      pattern: /^\/keys\/([^/]+)\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:read',
      async handler(api, _input, params) {
        return { status: 200, body: await api.get(params.id!) };
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/keys\/([^/]+)\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:update',
      async handler(api, input, params) {
        const body = jsonBody(input);
        const updated = await api.update(params.id!, {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(body.scopes !== undefined ? { scopes: body.scopes as string[] } : {}),
          ...(body.metadata !== undefined
            ? { metadata: body.metadata as Record<string, unknown> }
            : {}),
          ...(body.rateLimit !== undefined ? { rateLimit: body.rateLimit as number | null } : {}),
          ...(body.rateLimitWindowMs !== undefined
            ? { rateLimitWindowMs: body.rateLimitWindowMs as number | null }
            : {}),
          allowEscalation: body.allowEscalation === true,
        });
        return { status: 200, body: updated };
      },
    },
    {
      method: 'POST',
      pattern: /^\/keys\/([^/]+)\/rotate\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:rotate',
      async handler(api, input, params) {
        const body = jsonBody(input);
        const rotated = await api.rotate(
          params.id!,
          body.gracePeriodMs === undefined ? {} : { gracePeriodMs: Number(body.gracePeriodMs) },
        );
        return { status: 200, body: rotated };
      },
    },
    {
      method: 'POST',
      pattern: /^\/keys\/([^/]+)\/revoke\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:revoke',
      async handler(api, input, params) {
        const body = jsonBody(input);
        const revoked = await api.revoke(params.id!, {
          ...(body.reason !== undefined ? { reason: String(body.reason) } : {}),
          ...(body.actor !== undefined ? { actor: String(body.actor) } : {}),
        });
        return { status: 200, body: revoked };
      },
    },
    {
      method: 'GET',
      pattern: /^\/service-accounts\/?$/,
      paramNames: [],
      permission: 'api_keys:service_accounts',
      async handler(api, input) {
        const q = input.query;
        const query: Parameters<ApiKeys['listServiceAccounts']>[0] = {};
        const cursor = optStr(q.get('cursor'));
        if (cursor) query.cursor = cursor;
        if (q.get('limit')) query.limit = Number(q.get('limit'));
        const orgId = optStr(q.get('orgId'));
        if (orgId) query.orgId = orgId;
        if (q.get('enabled') !== null) query.enabled = q.get('enabled') === 'true';
        const search = optStr(q.get('q'));
        if (search) query.q = search;
        return { status: 200, body: await api.listServiceAccounts(query) };
      },
    },
    {
      method: 'POST',
      pattern: /^\/service-accounts\/?$/,
      paramNames: [],
      permission: 'api_keys:service_accounts',
      async handler(api, input) {
        const body = jsonBody(input);
        const created = await api.createServiceAccount({
          name: String(body.name ?? ''),
          description: (body.description as string | null | undefined) ?? null,
          orgId: (body.orgId as string | null | undefined) ?? null,
          ...(body.metadata !== undefined
            ? { metadata: body.metadata as Record<string, unknown> }
            : {}),
        });
        return { status: 201, body: created };
      },
    },
    {
      method: 'GET',
      pattern: /^\/service-accounts\/([^/]+)\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:service_accounts',
      async handler(api, _input, params) {
        return { status: 200, body: await api.getServiceAccount(params.id!) };
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/service-accounts\/([^/]+)\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:service_accounts',
      async handler(api, input, params) {
        const body = jsonBody(input);
        const updated = await api.updateServiceAccount(params.id!, {
          ...(body.name !== undefined ? { name: String(body.name) } : {}),
          ...(body.description !== undefined
            ? { description: body.description as string | null }
            : {}),
          ...(body.metadata !== undefined
            ? { metadata: body.metadata as Record<string, unknown> }
            : {}),
          ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
        });
        return { status: 200, body: updated };
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/service-accounts\/([^/]+)\/?$/,
      paramNames: ['id'],
      permission: 'api_keys:service_accounts',
      async handler(api, _input, params) {
        await api.deleteServiceAccount(params.id!);
        return { status: 204 };
      },
    },
  ];
}

export async function executeAdminRoute(
  api: ApiKeys,
  routes: AdminRoute[],
  input: AdminRequestInput,
  options: AdminRouterOptions,
): Promise<HttpOutput> {
  const path = input.path.replace(/\/+$/, '') || '/';
  const normalised = path.startsWith('/') ? path : `/${path}`;
  const candidates = routes.filter((r) => r.method === input.method.toUpperCase());
  for (const route of candidates) {
    const params = matchPath(route.pattern, route.paramNames, normalised);
    if (!params) continue;
    const auth = await checkAuth(options, input, route.permission);
    if (typeof (auth as HttpOutput).status === 'number' && !('id' in auth)) {
      return auth as HttpOutput;
    }
    try {
      return await route.handler(api, input, params);
    } catch (err) {
      return errorOutput(err);
    }
  }
  const methods = [
    ...new Set(
      routes.filter((r) => matchPath(r.pattern, r.paramNames, normalised)).map((r) => r.method),
    ),
  ];
  if (methods.length > 0) {
    return {
      status: 405,
      headers: { allow: methods.join(', ') },
      body: {
        type: 'about:blank',
        title: 'Method Not Allowed',
        status: 405,
        detail: 'Method not allowed',
        code: 'API_KEYS_METHOD_NOT_ALLOWED',
      },
    };
  }
  return problem(404, 'Not Found', 'No matching route', 'API_KEYS_NOT_FOUND');
}

export interface VerifyMiddlewareOptions {
  scopes?: readonly string[];
  property?: string;
}

export type VerifyOutcome =
  | { ok: true; principal: VerifiedPrincipal; status: 200 }
  | { ok: false; output: HttpOutput };

export async function verifyRequest(
  api: ApiKeys,
  header: (name: string) => string | undefined,
  options: VerifyMiddlewareOptions & { ip?: string | null } = {},
): Promise<VerifyOutcome> {
  const raw = extractRawKey(header);
  if (!raw) return { ok: false, output: unauthorizedProblem() };
  const verifyOpts: Parameters<ApiKeys['verify']>[1] = {};
  if (options.scopes) verifyOpts.scopes = options.scopes;
  if (options.ip !== undefined) verifyOpts.ip = options.ip;
  const result = await api.verify(raw, verifyOpts);
  if (!result.ok) {
    if (result.code === 'API_KEYS_SCOPE_DENIED') {
      return {
        ok: false,
        output: problem(403, 'Forbidden', 'Insufficient scope', result.code),
      };
    }
    if (result.code === 'API_KEYS_RATE_LIMITED') {
      const retry = result.retryAfterMs ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : 1;
      return {
        ok: false,
        output: {
          ...problem(429, 'Too Many Requests', 'Rate limit exceeded', result.code, {
            retryAfter: retry,
          }),
          headers: {
            'content-type': PROBLEM_CONTENT_TYPE,
            'cache-control': 'no-store',
            'retry-after': String(retry),
          },
        },
      };
    }
    return { ok: false, output: unauthorizedProblem() };
  }
  return { ok: true, principal: result.principal, status: 200 };
}

export { API_KEYS_PERMISSIONS };
