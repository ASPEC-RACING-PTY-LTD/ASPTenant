import { UsersError } from './errors.js';
import type { UsersService } from './service.js';

export interface JobContext {
  signal: AbortSignal;
  attempt: number;
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<void>;

/** Job name used when a deletion request schedules its purge. */
export const PURGE_JOB_NAME = 'users.purge';
/** Suggested job name for `createMaintenanceJobHandler`. */
export const MAINTENANCE_JOB_NAME = 'users.maintenance';

/**
 * Handler for `users.purge` jobs. Payload `{ userId }` purges that account if its grace
 * period has ended (a cancelled deletion is a no-op). Payload `{}` runs `purgeExpired()`.
 * Hook failures throw so the job is retried.
 */
export function createPurgeJobHandler(service: UsersService): JobHandler {
  return async (payload, ctx) => {
    if (ctx.signal.aborted) return;
    const userId =
      typeof payload === 'object' && payload !== null
        ? (payload as { userId?: unknown }).userId
        : undefined;
    if (userId === undefined) {
      const { failed } = await service.purgeExpired();
      if (failed.length > 0) {
        throw new UsersError('USERS_HOOK_FAILED', `Purge failed for ${failed.length} account(s)`, {
          details: { failed },
        });
      }
      return;
    }
    if (typeof userId !== 'string') {
      throw new UsersError(
        'USERS_VALIDATION_FAILED',
        'users.purge payload.userId must be a string',
      );
    }
    const user = await service.findUser(userId);
    if (!user || user.purgedAt !== null || user.status !== 'deleted' || !user.deletion) return;
    await service.purgeUser(userId, {}, { actor: { id: 'system', type: 'system' } });
  };
}

/** Handler that runs purges, suspension reinstatement and activity retention pruning. */
export function createMaintenanceJobHandler(service: UsersService): JobHandler {
  return async (_payload, ctx) => {
    if (ctx.signal.aborted) return;
    await service.runMaintenance();
  };
}
