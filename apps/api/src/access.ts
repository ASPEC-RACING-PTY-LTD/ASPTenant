import { ForbiddenError, NotFoundError, UnauthorizedError } from '@aspec/errors';
import type { Membership } from '@aspec/orgs';
import type { Actor } from '@aspec/users';
import type { PlatformPermission, TenantPermission } from './permissions.js';
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

/**
 * Tenant bound to this request by the HTTP layer after it verified an active membership.
 * Throws 403 when the caller has no tenant (or chose one they do not belong to).
 */
export function currentTenantId(platform: Platform, accountId?: string): string {
  const ctx = platform.orgs.currentTenant();
  if (!ctx || (accountId !== undefined && ctx.userId !== accountId)) {
    throw new ForbiddenError('You are not an active member of this organisation.');
  }
  return ctx.orgId;
}

/** Checks a tenant permission in the scope of the request tenant and returns that tenant id. */
export async function requirePermission(
  platform: Platform,
  accountId: string,
  permission: TenantPermission,
): Promise<string> {
  const tenantId = currentTenantId(platform, accountId);
  const allowed = await platform.rbac.can(
    { id: accountId, type: 'user', orgId: tenantId },
    permission,
    undefined,
    { scope: { orgId: tenantId } },
  );
  if (!allowed) throw new ForbiddenError('You do not have permission to perform this action.');
  return tenantId;
}

/** Checks a platform permission in global scope. Tenant roles never satisfy it. */
export async function requirePlatformPermission(
  platform: Platform,
  accountId: string,
  permission: PlatformPermission,
): Promise<void> {
  if (!(await hasPlatformPermission(platform, accountId, permission))) {
    throw new ForbiddenError('You do not have permission to perform this action.');
  }
}

export async function hasPlatformPermission(
  platform: Platform,
  accountId: string,
  permission: PlatformPermission,
): Promise<boolean> {
  return platform.rbac.can({ id: accountId, type: 'user' }, permission, undefined, { scope: {} });
}

/**
 * Membership of a user in the request tenant. Users of other tenants are reported as not
 * found so their existence is not disclosed.
 */
export async function requireTenantMember(
  platform: Platform,
  tenantId: string,
  userId: string,
): Promise<Membership> {
  const membership = await platform.orgs.getMembership(tenantId, userId);
  if (!membership || membership.status === 'removed' || membership.status === 'invited') {
    throw new NotFoundError('User not found');
  }
  return membership;
}

/**
 * Account-wide changes (profile, sign-in, sessions) affect every tenant a user belongs to.
 * A tenant administrator may only make them for users who belong to no other tenant.
 */
export async function requireExclusiveMember(
  platform: Platform,
  tenantId: string,
  userId: string,
): Promise<void> {
  const memberships = await platform.orgs.listMembershipsForUser(userId);
  const elsewhere = memberships.some((m) => m.orgId !== tenantId && m.status !== 'removed');
  if (elsewhere) {
    throw new ForbiddenError(
      'This account also belongs to another organisation. Ask a platform operator to change it.',
    );
  }
}

export function isAuthEmailTaken(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'AUTH_EMAIL_TAKEN'
  );
}
