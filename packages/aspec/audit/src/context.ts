import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActor } from './types.js';

export type ActorResolverResult = AuditActor | undefined | null;

/** Request-scoped data used to enrich audit events recorded during a request. */
export interface AuditContext {
  requestId?: string;
  correlationId?: string;
  /** W3C trace ID from an incoming traceparent header. */
  traceId?: string;
  ip?: string;
  userAgent?: string;
  tenantId?: string;
  actor?: AuditActor;
  /** Lazily resolves the actor when an event is recorded (after authentication has run). */
  resolveActor?: () => ActorResolverResult | Promise<ActorResolverResult>;
}

const storage = new AsyncLocalStorage<AuditContext>();

/** Runs fn with ctx as the current audit context. */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The audit context of the current request, if any. */
export function getAuditContext(): AuditContext | undefined {
  return storage.getStore();
}

/**
 * Updates the current audit context in place (for example to set the actor once
 * authentication has run). Returns false when there is no current context.
 */
export function updateAuditContext(patch: Partial<AuditContext>): boolean {
  const ctx = storage.getStore();
  if (!ctx) return false;
  Object.assign(ctx, patch);
  return true;
}

/** Sets the actor of the current audit context. */
export function setAuditActor(actor: AuditActor): boolean {
  return updateAuditContext({ actor });
}
