import type { AuditEventInput, AuditSink, LoggerLike, Subject } from './ports.js';

/** Audit actions emitted by the module. */
export const RBAC_AUDIT_ACTIONS = [
  'rbac.permission.created',
  'rbac.permission.updated',
  'rbac.permission.deleted',
  'rbac.role.created',
  'rbac.role.updated',
  'rbac.role.deleted',
  'rbac.assignment.granted',
  'rbac.assignment.revoked',
  'rbac.grant.created',
  'rbac.grant.revoked',
  'rbac.ownership.created',
  'rbac.ownership.updated',
  'rbac.ownership.deleted',
  'rbac.policy.created',
  'rbac.policy.updated',
  'rbac.policy.deleted',
  'rbac.expired.purged',
  'rbac.access.denied',
] as const;

export type RbacAuditAction = (typeof RBAC_AUDIT_ACTIONS)[number];

/** Who performed an admin operation and request metadata recorded with audit events. */
export interface AdminCallOptions {
  actor?: Subject;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface Auditor {
  readonly enabled: boolean;
  record(event: AuditEventInput & { action: RbacAuditAction }): Promise<void>;
}

export function actorOf(
  options: AdminCallOptions | undefined,
): AuditEventInput['actor'] | undefined {
  const actor = options?.actor;
  if (!actor) return undefined;
  const out: NonNullable<AuditEventInput['actor']> = { id: actor.id };
  if (actor.type !== undefined) out.type = actor.type;
  if (options?.ip !== undefined) out.ip = options.ip;
  if (options?.userAgent !== undefined) out.userAgent = options.userAgent;
  return out;
}

export function createAuditor(
  sink: AuditSink | undefined,
  logger: LoggerLike,
  onFailure: 'log' | 'throw',
): Auditor {
  return {
    enabled: sink !== undefined,
    async record(event) {
      if (!sink) return;
      try {
        await sink.record(event);
      } catch (err) {
        logger.error(
          { action: event.action, err: err instanceof Error ? err.message : String(err) },
          'rbac: audit sink failed to record an event',
        );
        if (onFailure === 'throw') throw err;
      }
    },
  };
}
