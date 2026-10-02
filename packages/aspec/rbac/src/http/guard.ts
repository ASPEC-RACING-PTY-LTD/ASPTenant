import type { Rbac } from '../engine.js';
import { RbacForbiddenError, RbacUnauthenticatedError } from '../errors.js';
import type { ResourceRef, Subject } from '../ports.js';
import type { RbacScope } from '../types.js';
import { normaliseScope } from '../validate.js';

export type ResourceResolver<TReq> = (
  request: TReq,
) => ResourceRef | undefined | Promise<ResourceRef | undefined>;

export type ScopeResolver<TReq> = (
  request: TReq,
) => RbacScope | undefined | Promise<RbacScope | undefined>;

export interface GuardOptions<TReq> {
  /** Resolves the authenticated subject. Required. */
  getSubject: (request: TReq) => Subject | null | undefined | Promise<Subject | null | undefined>;
  /** Static resource, or a function of the request. */
  resource?: ResourceRef | ResourceResolver<TReq>;
  /** Static scope, or a function of the request. */
  scope?: RbacScope | ScopeResolver<TReq>;
}

export interface GuardDecision {
  subject: Subject;
  allowed: boolean;
}

async function resolveSubject<TReq>(
  getSubject: GuardOptions<TReq>['getSubject'],
  request: TReq,
): Promise<Subject> {
  const subject = await getSubject(request);
  if (!subject) throw new RbacUnauthenticatedError();
  return subject;
}

async function resolveResource<TReq>(
  resource: GuardOptions<TReq>['resource'],
  request: TReq,
): Promise<ResourceRef | undefined> {
  if (resource === undefined) return undefined;
  if (typeof resource === 'function') return resource(request);
  return resource;
}

async function resolveScope<TReq>(
  scope: GuardOptions<TReq>['scope'],
  request: TReq,
): Promise<RbacScope | undefined> {
  if (scope === undefined) return undefined;
  if (typeof scope === 'function') return scope(request);
  return normaliseScope(scope);
}

/** Shared authorisation checks used by every framework adapter. */
export function createGuards(rbac: Rbac) {
  return {
    async requirePermission<TReq>(
      permission: string,
      request: TReq,
      options: GuardOptions<TReq>,
    ): Promise<Subject> {
      const subject = await resolveSubject(options.getSubject, request);
      const resource = await resolveResource(options.resource, request);
      const scope = await resolveScope(options.scope, request);
      const context = scope === undefined ? undefined : { scope };
      const allowed = await rbac.can(subject, permission, resource, context);
      if (!allowed) throw new RbacForbiddenError('Forbidden', permission);
      return subject;
    },

    async requireAny<TReq>(
      permissions: readonly string[],
      request: TReq,
      options: GuardOptions<TReq>,
    ): Promise<Subject> {
      const subject = await resolveSubject(options.getSubject, request);
      const resource = await resolveResource(options.resource, request);
      const scope = await resolveScope(options.scope, request);
      const context = scope === undefined ? undefined : { scope };
      const allowed = await rbac.canAny(subject, permissions, resource, context);
      if (!allowed) throw new RbacForbiddenError('Forbidden');
      return subject;
    },

    async requireAll<TReq>(
      permissions: readonly string[],
      request: TReq,
      options: GuardOptions<TReq>,
    ): Promise<Subject> {
      const subject = await resolveSubject(options.getSubject, request);
      const resource = await resolveResource(options.resource, request);
      const scope = await resolveScope(options.scope, request);
      const context = scope === undefined ? undefined : { scope };
      const allowed = await rbac.canAll(subject, permissions, resource, context);
      if (!allowed) throw new RbacForbiddenError('Forbidden');
      return subject;
    },

    async requireRole<TReq>(
      role: string,
      request: TReq,
      options: GuardOptions<TReq>,
    ): Promise<Subject> {
      const subject = await resolveSubject(options.getSubject, request);
      const scope = await resolveScope(options.scope, request);
      const allowed = await rbac.hasRole(subject, role, scope);
      if (!allowed) throw new RbacForbiddenError('Forbidden');
      return subject;
    },
  };
}

export type RbacGuards = ReturnType<typeof createGuards>;
