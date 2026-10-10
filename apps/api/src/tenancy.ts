import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { SqlClient } from '@aspec/db';
import { ConflictError, ForbiddenError } from '@aspec/errors';
import type { Membership, Organisation, TenantContext } from '@aspec/orgs';
import type { Actor } from '@aspec/users';
import { ALL_TENANTS_SCOPE, RLS_POLICY } from './directory/schema.js';
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

/** True when the account may open mailboxes in tenants it does not belong to. */
export async function canOverseeMailboxes(platform: Platform, userId: string): Promise<boolean> {
  return platform.rbac.can({ id: userId, type: 'user' }, 'mailboxes:access', undefined, {
    scope: {},
  });
}

/** Active tenants, oldest first, for operators who may open any tenant's mailboxes. */
export async function listActiveOrgs(platform: Platform): Promise<Organisation[]> {
  const page = await platform.orgs.listOrgs({ status: 'active', limit: 100 });
  return [...page.items].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Chooses the tenant for a signed-in account. An explicit selection must be one of the
 * account's active memberships; otherwise no tenant is bound and tenant routes answer 403.
 * Operators with mailboxes:access may also select any other active tenant. They are bound
 * without a membership, so tenant permissions stay empty and only mailbox access applies.
 */
export async function resolveTenant(
  platform: Platform,
  userId: string,
  requested: string | undefined,
): Promise<{ org: Organisation; membership: Membership | null } | null> {
  const tenants = await activeTenantsFor(platform, userId);
  const selector = requested?.trim();
  if (!selector) return tenants[0] ?? null;
  const member = tenants.find((t) => t.org.id === selector || t.org.slug === selector);
  if (member) return member;
  if (!(await canOverseeMailboxes(platform, userId))) return null;
  const org = (await listActiveOrgs(platform)).find(
    (item) => item.id === selector || item.slug === selector,
  );
  return org ? { org, membership: null } : null;
}

/**
 * Sets `app.tenant_id` for the current PostgreSQL transaction so row-level security policies
 * restrict directory tables to one tenant. No-op on SQLite.
 */
export async function bindTenant(db: SqlClient, tenantId: string): Promise<void> {
  if (db.dialect !== 'postgres') return;
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}

/**
 * Runs fn in a transaction (or savepoint) bound to one row-level security scope, then restores
 * the previous binding so a nested scope cannot leak into the rest of an outer transaction.
 */
export async function inScope<T>(
  platform: Pick<Platform, 'db'>,
  scopeId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const db = platform.db;
  // Work started inside fn but still running after the transaction ends (for example a
  // background queue) must not believe it is bound, so the marker is switched off at the end.
  const marker = { scopeId, active: true };
  try {
    return await db.transaction(async () => {
      if (db.dialect !== 'postgres') return boundScope.run(marker, fn);
      const previous = await db.query<{ value: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS value`,
      );
      await bindTenant(db, scopeId);
      const result = await boundScope.run(marker, fn);
      // On failure the savepoint rolls back and PostgreSQL restores the setting itself.
      await bindTenant(db, previous.rows[0]?.value ?? '');
      return result;
    });
  } finally {
    marker.active = false;
  }
}

/** Async context captured at module load, outside any request, tenant or transaction. */
const root = new AsyncResource('aspectenant-background');

/**
 * Starts background work detached from the caller's request: it must not join the request's
 * database transaction or inherit its tenant, because it outlives both.
 */
export function runDetached(task: () => Promise<void>): void {
  root.runInAsyncScope(() => {
    void task();
  });
}

/** The row-level security scope the current transaction is bound to, if any. */
const boundScope = new AsyncLocalStorage<{ scopeId: string; active: boolean }>();

/**
 * A database client for tenant data. Inside a transaction already bound to the current
 * tenant (requests, mail sessions) it queries directly; with only a tenant context (long
 * background jobs) it binds the tenant around each query so no transaction stays open.
 */
export function tenantClient(platform: Pick<Platform, 'db' | 'orgs'>): SqlClient {
  const wanted = (): string | null => {
    const tenant = platform.orgs.currentTenant()?.orgId ?? null;
    if (!tenant) return null;
    const marker = boundScope.getStore();
    const bound = marker?.active ? marker.scopeId : undefined;
    return bound === tenant || bound === ALL_TENANTS_SCOPE ? null : tenant;
  };
  return {
    dialect: platform.db.dialect,
    query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const scope = wanted();
      return scope
        ? inScope(platform, scope, () => platform.db.query<Row>(sql, params))
        : platform.db.query<Row>(sql, params);
    },
    transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      const scope = wanted();
      return scope
        ? inScope(platform, scope, () => platform.db.transaction(fn))
        : platform.db.transaction(fn);
    },
  };
}

/**
 * Sets the tenant context without opening a transaction, for long system work such as a
 * mailbox import. Queries through `tenantClient` bind the tenant one at a time.
 */
export async function inTenantContext<T>(
  platform: Platform,
  tenantId: string,
  fn: () => Promise<T>,
  userId: string = SYSTEM_SUBJECT,
): Promise<T> {
  const org = await platform.orgs.findOrg(tenantId);
  if (org?.status !== 'active') {
    throw new ForbiddenError('That organisation is not active.');
  }
  return platform.orgs.runWithTenant(contextFor(org, userId, null), fn);
}

/**
 * A database client that binds one row-level security scope around every query and
 * transaction. Installation-level services (updates, backups, mail apps) use it for the
 * platform scope; backup and job discovery use it for all tenants.
 */
export function scopedClient(platform: Pick<Platform, 'db'>, scopeId: string): SqlClient {
  return {
    dialect: platform.db.dialect,
    query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      return inScope(platform, scopeId, () => platform.db.query<Row>(sql, params));
    },
    transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return inScope(platform, scopeId, () => platform.db.transaction(fn));
    },
  };
}

function contextFor(org: Organisation, userId: string, role: string | null): TenantContext {
  return {
    orgId: org.id,
    slug: org.slug,
    strategy: 'shared',
    handle: null,
    userId,
    roles: role ? [role] : [],
    teamIds: [],
  };
}

/** Runs fn bound to one tenant, with the tenant context set for a member's request. */
export async function withTenant<T>(
  platform: Platform,
  tenant: { org: Organisation; membership?: Membership | null },
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = contextFor(tenant.org, userId, tenant.membership?.role ?? null);
  return inScope(platform, tenant.org.id, () => platform.orgs.runWithTenant(ctx, fn));
}

/** Subject id used for work the system does inside a tenant (mail delivery, imports). */
export const SYSTEM_SUBJECT = 'system';

/**
 * Runs fn bound to a tenant for system work that has no signed-in member: inbound delivery,
 * mail app sessions after their own authentication, background jobs.
 */
export async function withSystemTenant<T>(
  platform: Platform,
  tenantId: string,
  fn: () => Promise<T>,
  userId: string = SYSTEM_SUBJECT,
): Promise<T> {
  const org = await platform.orgs.findOrg(tenantId);
  if (org?.status !== 'active') {
    throw new ForbiddenError('That organisation is not active.');
  }
  return inScope(platform, org.id, () =>
    platform.orgs.runWithTenant(contextFor(org, userId, null), fn),
  );
}

/** Active tenants, oldest first. */
export async function listActiveTenants(platform: Platform): Promise<Organisation[]> {
  const out: Organisation[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await platform.orgs.listOrgs({
      status: 'active',
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/**
 * Finds the tenant that owns an email address: the tenant that has verified its domain.
 * Each tenant is checked inside its own row-level security scope.
 */
export async function tenantForAddress(
  platform: Platform,
  address: string,
): Promise<string | null> {
  const domain = address.trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return null;
  for (const org of await listActiveTenants(platform)) {
    const found = await inScope(platform, org.id, () =>
      platform.directory.store.findDomainByHostname(org.id, domain),
    );
    if (found?.status === 'verified') return org.id;
  }
  return null;
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
    `SELECT COUNT(*) AS n FROM pg_policies WHERE policyname = '${RLS_POLICY}'
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
