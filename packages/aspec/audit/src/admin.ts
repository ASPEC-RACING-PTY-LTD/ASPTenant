import { AuditError, isAuditError } from './errors.js';
import type { AuditLogger } from './logger.js';
import type { LoggerLike, PermissionChecker, Subject } from './ports.js';
import type { AuditQuery } from './query.js';
import type { AuditCategory, AuditOutcome } from './types.js';

export type AuditAdminAction = 'audit.read' | 'audit.verify';

export interface AuditAdminAuthorizeContext<Req> {
  request: Req;
  action: AuditAdminAction;
}

export interface AuditAdminPermissions<Req> {
  checker: PermissionChecker;
  /** Returns the authenticated subject, or undefined for anonymous requests (401). */
  getSubject: (request: Req) => Subject | undefined | Promise<Subject | undefined>;
  /** Default `audit:read`. */
  readPermission?: string;
  /** Default `audit:verify`. */
  verifyPermission?: string;
}

export interface AuditAdminOptions<Req> {
  /**
   * Authorisation hook. Return true to allow and false to deny (403). Throw
   * `new AuditError('AUDIT_UNAUTHENTICATED', ...)` for 401. Either this or `permissions` is required.
   */
  authorize?: (ctx: AuditAdminAuthorizeContext<Req>) => boolean | Promise<boolean>;
  /** Authorisation through the PermissionChecker port (for example @aspec/rbac). */
  permissions?: AuditAdminPermissions<Req>;
  /**
   * Restricts every query to one tenant. When it returns a tenant ID, the tenantId query
   * parameter is ignored, other tenants' events are not visible, and stream verification is denied.
   */
  tenantScope?: (request: Req) => string | undefined | Promise<string | undefined>;
  /** Maximum page size accepted by the router. Default 200. */
  maxLimit?: number;
  /** Receives unexpected errors. */
  logger?: LoggerLike;
}

export type AuditAdminRoute =
  | { name: 'events' }
  | { name: 'count' }
  | { name: 'event'; id: string }
  | { name: 'streams' }
  | { name: 'verify'; stream: string };

export interface AuditAdminResponse {
  status: number;
  body: unknown;
}

const QUERY_KEYS = new Set([
  'actorId',
  'actorType',
  'action',
  'actionPrefix',
  'resourceType',
  'resourceId',
  'tenantId',
  'outcome',
  'category',
  'requestId',
  'correlationId',
  'stream',
  'from',
  'to',
  'order',
  'limit',
  'cursor',
]);

function decode(segment: string): string | undefined {
  try {
    const v = decodeURIComponent(segment);
    return v.length > 0 && v.length <= 512 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Matches a path relative to the router mount point. */
export function matchAdminPath(path: string): AuditAdminRoute | undefined {
  const clean = path.replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'events' };
  if (parts[0] === 'events') {
    if (parts.length === 1) return { name: 'events' };
    if (parts.length === 2 && parts[1] === 'count') return { name: 'count' };
    if (parts.length === 2) {
      const id = decode(parts[1] as string);
      return id ? { name: 'event', id } : undefined;
    }
  }
  if (parts[0] === 'streams') {
    if (parts.length === 1) return { name: 'streams' };
    if (parts.length === 3 && parts[2] === 'verify') {
      const stream = decode(parts[1] as string);
      return stream ? { name: 'verify', stream } : undefined;
    }
  }
  return undefined;
}

function parseTime(name: string, v: string): number {
  const ms = /^-?\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new AuditError(
      'AUDIT_INVALID_QUERY',
      `${name} must be epoch milliseconds or an ISO 8601 date`,
    );
  }
  return ms;
}

function parseInteger(name: string, v: string): number {
  if (!/^\d{1,15}$/.test(v))
    throw new AuditError('AUDIT_INVALID_QUERY', `${name} must be a positive integer`);
  return Number(v);
}

export interface AuditAdminHandler<Req> {
  handle(route: AuditAdminRoute, query: URLSearchParams, request: Req): Promise<AuditAdminResponse>;
}

/** Framework-agnostic admin query handler used by every adapter. */
export function createAuditAdminHandler<Req>(
  logger: AuditLogger,
  options: AuditAdminOptions<Req>,
): AuditAdminHandler<Req> {
  if (!options.authorize && !options.permissions) {
    throw new AuditError(
      'AUDIT_INVALID_OPTIONS',
      'the audit admin router needs an authorize hook or permissions (it is never public)',
    );
  }
  const maxLimit = options.maxLimit ?? 200;
  if (!Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit > 1000) {
    throw new AuditError('AUDIT_INVALID_OPTIONS', 'maxLimit must be an integer from 1 to 1000');
  }

  async function authorise(request: Req, action: AuditAdminAction): Promise<void> {
    let allowed: boolean;
    if (options.authorize) {
      allowed = (await options.authorize({ request, action })) === true;
    } else {
      const perms = options.permissions as AuditAdminPermissions<Req>;
      const subject = await perms.getSubject(request);
      if (!subject) throw new AuditError('AUDIT_UNAUTHENTICATED', 'authentication required');
      const permission =
        action === 'audit.read'
          ? (perms.readPermission ?? 'audit:read')
          : (perms.verifyPermission ?? 'audit:verify');
      allowed = (await perms.checker.can(subject, permission, { type: 'audit_log' })) === true;
    }
    if (!allowed) throw new AuditError('AUDIT_FORBIDDEN', 'not allowed to access audit logs');
  }

  function buildQuery(params: URLSearchParams, scope: string | undefined): AuditQuery {
    const q: Record<string, unknown> = {};
    for (const [key, value] of params) {
      if (!QUERY_KEYS.has(key))
        throw new AuditError('AUDIT_INVALID_QUERY', `unknown query parameter ${key}`);
      if (params.getAll(key).length > 1) {
        throw new AuditError('AUDIT_INVALID_QUERY', `query parameter ${key} is repeated`);
      }
      if (value.length > 512) throw new AuditError('AUDIT_INVALID_QUERY', `${key} is too long`);
      q[key] = value;
    }
    const query: AuditQuery = {};
    for (const k of [
      'actorId',
      'actorType',
      'action',
      'actionPrefix',
      'resourceType',
      'resourceId',
      'tenantId',
      'requestId',
      'correlationId',
      'stream',
      'cursor',
    ] as const) {
      if (typeof q[k] === 'string') query[k] = q[k] as string;
    }
    if (typeof q.outcome === 'string') query.outcome = q.outcome as AuditOutcome;
    if (typeof q.category === 'string') query.category = q.category as AuditCategory;
    if (typeof q.order === 'string') query.order = q.order as 'asc' | 'desc';
    if (typeof q.from === 'string') query.from = parseTime('from', q.from);
    if (typeof q.to === 'string') query.to = parseTime('to', q.to);
    if (typeof q.limit === 'string') {
      const limit = parseInteger('limit', q.limit);
      if (limit < 1 || limit > maxLimit) {
        throw new AuditError('AUDIT_INVALID_QUERY', `limit must be from 1 to ${maxLimit}`);
      }
      query.limit = limit;
    }
    if (scope !== undefined) {
      query.tenantId = scope;
      if (query.stream !== undefined && !query.stream.endsWith(`:${scope}`)) {
        throw new AuditError('AUDIT_FORBIDDEN', 'stream is outside your tenant');
      }
    }
    return query;
  }

  async function run(
    route: AuditAdminRoute,
    params: URLSearchParams,
    request: Req,
  ): Promise<AuditAdminResponse> {
    const action: AuditAdminAction =
      route.name === 'verify' || route.name === 'streams' ? 'audit.verify' : 'audit.read';
    await authorise(request, action);
    const scope = options.tenantScope ? await options.tenantScope(request) : undefined;
    switch (route.name) {
      case 'events': {
        const result = await logger.query(buildQuery(params, scope));
        return { status: 200, body: result };
      }
      case 'count': {
        const { cursor: _c, order: _o, limit: _l, ...filter } = buildQuery(params, scope);
        return { status: 200, body: { count: await logger.count(filter) } };
      }
      case 'event': {
        const event = await logger.getEvent(route.id);
        if (!event || (scope !== undefined && event.tenantId !== scope)) {
          throw new AuditError('AUDIT_NOT_FOUND', 'audit event not found');
        }
        return { status: 200, body: { event } };
      }
      case 'streams': {
        if (scope !== undefined) {
          throw new AuditError(
            'AUDIT_FORBIDDEN',
            'stream listing requires an unscoped administrator',
          );
        }
        return { status: 200, body: { streams: await logger.listStreams() } };
      }
      case 'verify': {
        if (scope !== undefined) {
          throw new AuditError(
            'AUDIT_FORBIDDEN',
            'chain verification requires an unscoped administrator',
          );
        }
        for (const key of params.keys()) {
          if (key !== 'fromSeq' && key !== 'toSeq') {
            throw new AuditError('AUDIT_INVALID_QUERY', `unknown query parameter ${key}`);
          }
        }
        const range: { fromSeq?: number; toSeq?: number } = {};
        const from = params.get('fromSeq');
        const to = params.get('toSeq');
        if (from !== null) range.fromSeq = parseInteger('fromSeq', from);
        if (to !== null) range.toSeq = parseInteger('toSeq', to);
        return { status: 200, body: { report: await logger.verifyChain(route.stream, range) } };
      }
    }
  }

  return {
    async handle(route, query, request) {
      try {
        return await run(route, query, request);
      } catch (err) {
        if (isAuditError(err) && err.expose) {
          return { status: err.status, body: { error: { code: err.code, message: err.message } } };
        }
        options.logger?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'audit admin request failed',
        );
        const status = isAuditError(err) ? err.status : 500;
        const code = isAuditError(err) ? err.code : 'AUDIT_INTERNAL_ERROR';
        return { status, body: { error: { code, message: 'internal error' } } };
      }
    },
  };
}
