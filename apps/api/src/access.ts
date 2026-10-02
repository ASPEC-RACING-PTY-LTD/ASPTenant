import { ForbiddenError, UnauthorizedError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import type { Platform } from './platform.js';

export function accountIdFromRequest(raw: Request | undefined): string {
  const accountId = raw?.headers.get('x-aspectenant-account-id');
  if (!accountId) throw new UnauthorizedError('Sign in required');
  return accountId;
}

export function actorFromRequest(raw: Request | undefined, accountId: string): Actor {
  const ip = raw?.headers.get('x-aspectenant-client-ip') ?? undefined;
  const userAgent = raw?.headers.get('user-agent')?.slice(0, 200) ?? undefined;
  return {
    id: accountId,
    type: 'user',
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

export async function requirePermission(
  platform: Platform,
  accountId: string,
  permission: string,
): Promise<void> {
  const allowed = await platform.rbac.can({ id: accountId, type: 'user' }, permission);
  if (!allowed) throw new ForbiddenError('You do not have permission to perform this action.');
}

export function isAuthEmailTaken(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'AUTH_EMAIL_TAKEN'
  );
}
