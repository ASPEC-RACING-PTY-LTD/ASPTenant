import { randomBytes } from 'node:crypto';
import type { SqlClient } from '@aspec/db';
import { ConflictError } from '@aspec/errors';
import type { Membership, Organisation, TenantContext } from '@aspec/orgs';
import type { Actor } from '@aspec/users';
import {
  PLATFORM_OPERATOR_ROLE,
  TENANT_ADMIN_ROLE,
  TENANT_AUDITOR_ROLE,
  TENANT_OWNER_ROLE,
  TENANT_ROLES,
} from './permissions.js';
import type { Platform } from './platform.js';

/** Header the admin UI sends to choose the tenant for a request (organisation id or slug). */
export const TENANT_HEADER = 'x-aspectenant-tenant';

/** Headers the HTTP layer sets for the API. Never trusted from the client. */
export const INTERNAL_HEADERS = ['x-aspectenant-account-id', 'x-aspectenant-client-ip'] as const;

export interface TenantMembership {
  org: Organisation;
  membership: Membership;
}

/** Active memberships in active tenants, oldest first. */
export async function activeTenantsFor(
  platform: Platform,
  userId: string,
): Promise<TenantMembership[]> {
  const memberships = await platform.orgs.listMembershipsForUser(userId);
  const out: TenantMembership[] = [];
  for (const membership of memberships) {
    if (membership.status !== 'active') continue;
    const org = await platform.orgs.findOrg(membership.orgId);
    if (org?.status !== 'active') continue;
    out.push({ org, membership });
  }
  out.sort((a, b) => a.membership.createdAt - b.membership.createdAt);
  return out;
}

/**
 * Chooses the tenant for a signed-in account. An explicit selection must be one of the
 * account's active memberships; otherwise no tenant is bound and tenant routes answer 403.
 */
export async function resolveTenant(
  platform: Platform,
  userId: string,
  requested: string | undefined,
): Promise<TenantMembership | null> {
  const tenants = await activeTenantsFor(platform, userId);
  const selector = requested?.trim();
  if (selector) {
    return tenants.find((t) => t.org.id === selector || t.org.slug === selector) ?? null;
  }
  return tenants[0] ?? null;
}

/**
 * Sets `app.tenant_id` for the current PostgreSQL transaction so row-level security policies
 * restrict directory tables to one tenant. No-op on SQLite.
 */
export async function bindTenant(db: SqlClient, tenantId: string): Promise<void> {
  if (db.dialect !== 'postgres') return;
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}

/** Runs fn in a transaction bound to one tenant, with the tenant context set. */
export async function withTenant<T>(
  platform: Platform,
  tenant: { org: Organisation; membership?: Membership | null },
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: TenantContext = {
    orgId: tenant.org.id,
    slug: tenant.org.slug,
    strategy: 'shared',
    handle: null,
    userId,
    roles: tenant.membership ? [tenant.membership.role] : [],
    teamIds: [],
  };
  return platform.db.transaction(async () => {
    await bindTenant(platform.db, tenant.org.id);
    return platform.orgs.runWithTenant(ctx, fn);
  });
}

/** Assigns a tenant role in organisation scope. */
export async function assignTenantRole(
  platform: Platform,
  userId: string,
  tenantId: string,
  roleKey: string,
): Promise<void> {
  await platform.rbac.admin.assignRole({ subjectId: userId, roleKey, scope: { orgId: tenantId } });
}

/** Removes every tenant role a user holds in one tenant. */
export async function revokeTenantRoles(
  platform: Platform,
  userId: string,
  tenantId: string,
): Promise<void> {
  const page = await platform.rbac.admin.listAssignments({
    subjectId: userId,
    orgId: tenantId,
    limit: 100,
  });
  for (const assignment of page.items) {
    if ((TENANT_ROLES as readonly string[]).includes(assignment.roleKey)) {
      await platform.rbac.admin.revokeRole({ id: assignment.id });
    }
  }
}

/** Tenant role keys a user holds inside one tenant. */
export async function tenantRolesFor(
  platform: Platform,
  userId: string,
  tenantId: string,
): Promise<string[]> {
  const roles = await platform.rbac.rolesFor(
    { id: userId, type: 'user', orgId: tenantId },
    {
      orgId: tenantId,
    },
  );
  return roles.filter((role) => (TENANT_ROLES as readonly string[]).includes(role));
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code
    : undefined;
}

function baseSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : 'org';
}

/**
 * Creates a tenant with `ownerId` as its owner (membership role `owner`, RBAC `tenant.owner`
 * in that tenant only). Without an explicit slug, one is derived from the name and suffixed
 * when taken or reserved.
 */
export async function createTenant(
  platform: Platform,
  input: { name: string; slug?: string; ownerId: string; actor?: Actor },
): Promise<Organisation> {
  const context = input.actor ? { actor: input.actor } : {};
  const attempt = (slug: string) =>
    platform.db.transaction(() =>
      platform.orgs.createOrg({ name: input.name.trim(), slug, createdBy: input.ownerId }, context),
    );
  let org: Organisation | undefined;
  if (input.slug !== undefined) {
    org = await attempt(input.slug);
  } else {
    const base = baseSlug(input.name);
    const candidates = [base, ...[1, 2, 3].map(() => `${base}-${randomBytes(3).toString('hex')}`)];
    for (const candidate of candidates) {
      try {
        org = await attempt(candidate);
        break;
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ORGS_SLUG_TAKEN' && code !== 'ORGS_VALIDATION_FAILED') throw error;
      }
    }
  }
  if (!org) throw new ConflictError('Could not choose a unique organisation slug. Provide one.');
  await assignTenantRole(platform, input.ownerId, org.id, TENANT_OWNER_ROLE);
  return org;
}

/** Maps a tenant RBAC role to the organisation membership role. */
export function membershipRoleFor(roleKey: string | null): 'admin' | 'member' {
  return roleKey === TENANT_ADMIN_ROLE ? 'admin' : 'member';
}

/**
 * Earlier releases assigned tenant roles globally. Moves each global tenant role into the
 * scope of every organisation the subject belongs to and makes former owners platform
 * operators, then revokes the global assignment. Safe to run on every start.
 */
export async function reconcileLegacyRoleAssignments(platform: Platform): Promise<number> {
  let moved = 0;
  for (const roleKey of [TENANT_OWNER_ROLE, TENANT_ADMIN_ROLE, TENANT_AUDITOR_ROLE]) {
    for (;;) {
      const page = await platform.rbac.admin.listAssignments({ roleKey, orgId: null, limit: 100 });
      const legacy = page.items.filter((item) => item.orgId === undefined);
      if (legacy.length === 0) break;
      for (const assignment of legacy) {
        const memberships = await platform.orgs.listMembershipsForUser(assignment.subjectId);
        for (const membership of memberships) {
          if (membership.status === 'removed') continue;
          await assignTenantRole(platform, assignment.subjectId, membership.orgId, roleKey);
        }
        if (roleKey === TENANT_OWNER_ROLE) {
          await platform.rbac.admin.assignRole({
            subjectId: assignment.subjectId,
            roleKey: PLATFORM_OPERATOR_ROLE,
          });
        }
        await platform.rbac.admin.revokeRole({ id: assignment.id });
        moved += 1;
      }
    }
  }
  if (moved > 0) {
    platform.logger.info({ moved }, 'moved global tenant role assignments into tenant scope');
  }
  return moved;
}

export interface RowLevelSecurityStatus {
  /** Policies exist on the directory tables. */
  policies: boolean;
  /** The connected role is subject to those policies (not a superuser, no BYPASSRLS). */
  enforced: boolean;
  detail: string;
}

export async function rowLevelSecurityStatus(db: SqlClient): Promise<RowLevelSecurityStatus> {
  if (db.dialect !== 'postgres') {
    return {
      policies: false,
      enforced: false,
      detail: 'SQLite has no row-level security. Isolation relies on tenant-scoped queries.',
    };
  }
  const role = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const policies = await db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM pg_policies WHERE policyname = 'orgs_tenant_isolation'
       AND tablename LIKE 'aspectenant_%'`,
  );
  const row = role.rows[0];
  const hasPolicies = Number(policies.rows[0]?.n ?? 0) > 0;
  const bypass = row ? row.rolsuper === true || row.rolbypassrls === true : true;
  return {
    policies: hasPolicies,
    enforced: hasPolicies && !bypass,
    detail: !hasPolicies
      ? 'Row-level security policies are missing.'
      : bypass
        ? 'Connected as a superuser or BYPASSRLS role. Policies exist but PostgreSQL does not apply them. Connect as the non-superuser application role.'
        : 'Row-level security is enforced for directory tables.',
  };
}
