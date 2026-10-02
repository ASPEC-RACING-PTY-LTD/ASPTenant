import { issueToken, parseToken, uuidv7, verifyTokenHash } from './crypto.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { OrgsError, validationError } from './errors.js';
import {
  applyFieldPatch,
  assertFieldDefinitions,
  type FieldDefinitions,
  mergeWithDefaults,
} from './fields.js';
import type {
  AuditSink,
  Clock,
  IdGenerator,
  LoggerLike,
  Mailer,
  PermissionChecker,
  ResourceRef,
  Subject,
} from './ports.js';
import type { OrgsStore } from './store.js';
import {
  currentTenant,
  generateRlsPolicySql,
  requireTenant,
  runWithTenant,
  tenantScope,
} from './tenant.js';
import type {
  ActionContext,
  Invitation,
  InvitationRecord,
  Membership,
  Organisation,
  Page,
  Team,
  TeamMembership,
  TeamRole,
  TenantContext,
  TenantRecord,
  TenantStrategy,
} from './types.js';
import {
  assertId,
  assertJsonObject,
  assertName,
  assertRole,
  assertSchemaName,
  assertSlug,
  clampLimit,
  normaliseEmail,
  positiveDuration,
  slugFromName,
} from './validation.js';

const DAY = 86_400_000;

export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  owner: [
    'orgs:read',
    'orgs:update',
    'orgs:delete',
    'orgs:members:read',
    'orgs:members:manage',
    'orgs:teams:manage',
    'orgs:invite',
    'orgs:settings',
    'orgs:billing',
  ],
  admin: [
    'orgs:read',
    'orgs:update',
    'orgs:members:read',
    'orgs:members:manage',
    'orgs:teams:manage',
    'orgs:invite',
    'orgs:settings',
  ],
  member: ['orgs:read', 'orgs:members:read'],
};

export interface InvitationEmailContext {
  invitation: Invitation;
  token: string;
  acceptUrl: string | null;
  org: Organisation;
  appName: string;
}

export interface InvitationEmailContent {
  subject: string;
  text: string;
  html?: string;
}

export interface OrgsOptions {
  mode: 'single' | 'multi';
  store: OrgsStore;
  mailer?: Mailer;
  audit?: AuditSink;
  permissions?: PermissionChecker;
  logger?: LoggerLike;
  clock?: Clock;
  generateId?: IdGenerator;
  /** Typed organisation settings. */
  settings?: FieldDefinitions;
  /** Role key to permission list. Defaults cover owner/admin/member. */
  rolePermissions?: Readonly<Record<string, readonly string[]>>;
  /** Allowed custom role keys beyond owner/admin/member. */
  customRoles?: readonly string[];
  invitations?: {
    ttlMs?: number;
    resendIntervalMs?: number;
    maxSends?: number;
    acceptUrl?: string;
    appName?: string;
    /** When true (default), accept requires the caller's email to match the invite. */
    requireEmailMatch?: boolean;
    renderEmail?: (ctx: InvitationEmailContext) => InvitationEmailContent;
  };
  tenant?: {
    defaultStrategy?: TenantStrategy;
    /** Called for strategy `schema` after CREATE SCHEMA. */
    onSchemaProvision?: (ctx: { org: Organisation; schema: string }) => void | Promise<void>;
    /** Called for strategy `database`. Must return an opaque handle. */
    onDatabaseProvision?: (ctx: { org: Organisation }) => string | Promise<string>;
    onDeprovision?: (tenant: TenantRecord, org: Organisation) => void | Promise<void>;
    /** Schema name factory. Default `tenant_<slug with underscores>`. */
    schemaName?: (org: Organisation) => string;
  };
  /** Implicit default organisation for single-tenant mode. Created lazily. */
  single?: {
    id?: string;
    name?: string;
    slug?: string;
  };
}

export interface CreateOrgInput {
  id?: string;
  name: string;
  slug?: string;
  metadata?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** Creator becomes owner. Required. */
  createdBy: string;
}

export interface UpdateOrgInput {
  name?: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface InviteInput {
  orgId: string;
  email: string;
  role?: string;
  teamIds?: string[];
}

export interface AcceptInvitationInput {
  userId: string;
  email?: string;
}

export interface InvitationResult {
  invitation: Invitation;
  token?: string;
  delivery: 'sent' | 'failed' | 'manual';
}

export interface OrgsService {
  readonly mode: 'single' | 'multi';
  readonly store: OrgsStore;

  createOrg(input: CreateOrgInput, context?: ActionContext): Promise<Organisation>;
  getOrg(id: string): Promise<Organisation>;
  findOrg(id: string): Promise<Organisation | null>;
  getOrgBySlug(slug: string): Promise<Organisation>;
  listOrgs(query?: {
    status?: string;
    search?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Page<Organisation>>;
  updateOrg(
    id: string,
    patch: UpdateOrgInput,
    options?: { expectedVersion?: number },
    context?: ActionContext,
  ): Promise<Organisation>;
  archiveOrg(id: string, context?: ActionContext): Promise<Organisation>;
  deleteOrg(id: string, context?: ActionContext): Promise<Organisation>;
  /** Single-tenant: returns (and creates if needed) the default organisation. */
  getDefaultOrg(): Promise<Organisation>;

  getSettings(orgId: string): Promise<Record<string, unknown>>;
  updateSettings(
    orgId: string,
    patch: Record<string, unknown>,
    options?: { expectedVersion?: number },
    context?: ActionContext,
  ): Promise<Organisation>;

  addMember(
    orgId: string,
    userId: string,
    role?: string,
    context?: ActionContext,
  ): Promise<Membership>;
  changeMemberRole(
    orgId: string,
    userId: string,
    role: string,
    context?: ActionContext,
  ): Promise<Membership>;
  suspendMember(orgId: string, userId: string, context?: ActionContext): Promise<Membership>;
  reactivateMember(orgId: string, userId: string, context?: ActionContext): Promise<Membership>;
  removeMember(orgId: string, userId: string, context?: ActionContext): Promise<Membership>;
  leaveOrg(orgId: string, userId: string, context?: ActionContext): Promise<Membership>;
  transferOwnership(
    orgId: string,
    fromUserId: string,
    toUserId: string,
    context?: ActionContext,
  ): Promise<{ previous: Membership; next: Membership }>;
  getMembership(orgId: string, userId: string): Promise<Membership | null>;
  listMembers(
    orgId: string,
    query?: { status?: string; limit?: number; cursor?: string },
  ): Promise<Page<Membership>>;
  listMembershipsForUser(userId: string): Promise<Membership[]>;

  createTeam(
    orgId: string,
    input: { name: string; slug?: string; metadata?: Record<string, unknown> },
    context?: ActionContext,
  ): Promise<Team>;
  updateTeam(
    teamId: string,
    patch: { name?: string; slug?: string; metadata?: Record<string, unknown> },
    options?: { expectedVersion?: number },
    context?: ActionContext,
  ): Promise<Team>;
  archiveTeam(teamId: string, context?: ActionContext): Promise<Team>;
  getTeam(teamId: string): Promise<Team>;
  listTeams(orgId: string): Promise<Team[]>;
  addTeamMember(
    teamId: string,
    userId: string,
    role?: TeamRole,
    context?: ActionContext,
  ): Promise<TeamMembership>;
  removeTeamMember(teamId: string, userId: string, context?: ActionContext): Promise<boolean>;
  listTeamMembers(teamId: string): Promise<TeamMembership[]>;

  invite(input: InviteInput, context?: ActionContext): Promise<InvitationResult>;
  resendInvitation(id: string, context?: ActionContext): Promise<InvitationResult>;
  revokeInvitation(id: string, context?: ActionContext): Promise<Invitation>;
  acceptInvitation(
    token: string,
    input: AcceptInvitationInput,
    context?: ActionContext,
  ): Promise<{ invitation: Invitation; membership: Membership; created: boolean }>;
  getInvitation(id: string): Promise<Invitation>;
  listInvitations(
    orgId: string,
    query?: { status?: string; limit?: number; cursor?: string },
  ): Promise<Page<Invitation>>;

  /** Org-scoped permission check using role mapping, optionally delegating to PermissionChecker. */
  can(userId: string, orgId: string, permission: string): Promise<boolean>;
  /** Builds a Subject bridge for @aspec/rbac or any PermissionChecker. */
  toSubject(userId: string, orgId: string): Promise<Subject>;
  permissionsForRole(role: string): readonly string[];

  provisionTenant(
    orgId: string,
    options?: { strategy?: TenantStrategy; force?: boolean },
    context?: ActionContext,
  ): Promise<TenantRecord>;
  deprovisionTenant(orgId: string, context?: ActionContext): Promise<TenantRecord | null>;
  getTenant(orgId: string): Promise<TenantRecord | null>;

  runWithTenant: typeof runWithTenant;
  currentTenant: typeof currentTenant;
  requireTenant: typeof requireTenant;
  tenantScope: typeof tenantScope;
  generateRlsPolicySql: typeof generateRlsPolicySql;
  /**
   * Resolves tenant from slug/header/path and verifies membership, then runs `fn`
   * inside `runWithTenant`.
   */
  enterTenant(
    input: { orgId?: string; slug?: string; userId: string },
    fn: (ctx: TenantContext) => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function publicInvitation(inv: InvitationRecord): Invitation {
  const { tokenHash: _, ...rest } = inv;
  return rest;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function acceptLink(base: string | undefined, token: string): string | null {
  if (!base) return null;
  if (base.includes('{token}')) return base.replaceAll('{token}', encodeURIComponent(token));
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

/** Creates the organisations and multi-tenancy service. */
export function createOrgs(options: OrgsOptions): OrgsService {
  if (!options || typeof options !== 'object') {
    throw new OrgsError('ORGS_CONFIG_INVALID', 'createOrgs(options) requires an options object');
  }
  if (options.mode !== 'single' && options.mode !== 'multi') {
    throw new OrgsError('ORGS_CONFIG_INVALID', 'options.mode must be "single" or "multi"');
  }
  if (!options.store || typeof options.store.insertOrg !== 'function') {
    throw new OrgsError('ORGS_CONFIG_INVALID', 'options.store must implement OrgsStore');
  }
  assertFieldDefinitions('settings', options.settings);

  const store = options.store;
  const mode = options.mode;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const generateId: IdGenerator = options.generateId ?? (() => uuidv7(clock.now()));
  const logger = options.logger ?? noopLogger;
  const rolePermissions = { ...DEFAULT_ROLE_PERMISSIONS, ...options.rolePermissions };
  const customRoles = new Set(options.customRoles ?? []);
  const settingDefs = options.settings ?? {};
  const inviteTtl = positiveDuration('invitations.ttlMs', options.invitations?.ttlMs, 7 * DAY);
  const resendInterval = positiveDuration(
    'invitations.resendIntervalMs',
    options.invitations?.resendIntervalMs,
    60_000,
  );
  const maxSends = options.invitations?.maxSends ?? 5;
  const requireEmailMatch = options.invitations?.requireEmailMatch !== false;
  const defaultStrategy: TenantStrategy = options.tenant?.defaultStrategy ?? 'shared';

  function assertKnownRole(role: string): string {
    const r = assertRole(role);
    if (
      r === 'owner' ||
      r === 'admin' ||
      r === 'member' ||
      customRoles.has(r) ||
      rolePermissions[r]
    ) {
      return r;
    }
    throw validationError([{ path: 'role', message: `unknown role "${r}"` }]);
  }

  async function audit(
    action: string,
    ctx: ActionContext | undefined,
    resource: { type: string; id?: string },
    changes?: { before?: unknown; after?: unknown },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!options.audit) return;
    try {
      const event: Parameters<AuditSink['record']>[0] = {
        action,
        outcome: 'success',
        resource,
        category: 'admin',
      };
      if (ctx?.actor) event.actor = ctx.actor;
      if (ctx?.tenantId) event.tenantId = ctx.tenantId;
      if (ctx?.requestId) event.requestId = ctx.requestId;
      if (changes) event.changes = changes;
      if (metadata) event.metadata = metadata;
      await options.audit.record(event);
    } catch (err) {
      logger.warn({ err: String(err), action }, 'audit sink failed');
    }
  }

  async function requireOrg(id: string): Promise<Organisation> {
    const org = await store.getOrg(assertId(id, 'orgId'));
    if (!org || org.status === 'deleted') {
      throw new OrgsError('ORGS_NOT_FOUND', 'Organisation not found');
    }
    return org;
  }

  async function requireActiveMember(orgId: string, userId: string): Promise<Membership> {
    const m = await store.getMembership(orgId, assertId(userId, 'userId'));
    if (!m || m.status !== 'active') {
      throw new OrgsError('ORGS_NOT_ORG_MEMBER', 'User is not an active organisation member');
    }
    return m;
  }

  let defaultOrgPromise: Promise<Organisation> | undefined;

  async function getDefaultOrg(): Promise<Organisation> {
    if (mode !== 'single') {
      throw new OrgsError('ORGS_INVALID_STATE', 'getDefaultOrg is only available in single mode');
    }
    if (!defaultOrgPromise) {
      defaultOrgPromise = (async () => {
        const id = options.single?.id ?? 'default';
        const existing = await store.getOrg(id);
        if (existing && existing.status !== 'deleted') return existing;
        const name = options.single?.name ?? 'Default';
        const slug = options.single?.slug ?? 'default';
        // Allow reserved slug "default" only for the built-in single-tenant org.
        const now = clock.now();
        const org: Organisation = {
          id,
          name,
          slug,
          status: 'active',
          metadata: {},
          settings: {},
          createdBy: 'system',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          version: 1,
        };
        try {
          // Bypass reserved-slug check for the single-tenant default.
          if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
            throw validationError([{ path: 'slug', message: 'invalid single.slug' }]);
          }
          return await store.insertOrg(org);
        } catch (err) {
          if (
            err instanceof OrgsError &&
            (err.code === 'ORGS_ID_TAKEN' || err.code === 'ORGS_SLUG_TAKEN')
          ) {
            const again = await store.getOrg(id);
            if (again) return again;
          }
          throw err;
        }
      })();
    }
    return defaultOrgPromise;
  }

  const service: OrgsService = {
    mode,
    store,
    runWithTenant,
    currentTenant,
    requireTenant,
    tenantScope,
    generateRlsPolicySql,
    getDefaultOrg,

    async createOrg(input, context) {
      if (mode === 'single') {
        throw new OrgsError(
          'ORGS_INVALID_STATE',
          'createOrg is not available in single-tenant mode; use getDefaultOrg()',
        );
      }
      const name = assertName(input.name);
      const slug = input.slug !== undefined ? assertSlug(input.slug) : slugFromName(name);
      const createdBy = assertId(input.createdBy, 'createdBy');
      const now = clock.now();
      const org: Organisation = {
        id: input.id !== undefined ? assertId(input.id) : generateId(),
        name,
        slug,
        status: 'active',
        metadata: assertJsonObject(input.metadata, 'metadata'),
        settings: assertJsonObject(input.settings, 'settings'),
        createdBy,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        version: 1,
      };
      const created = await store.insertOrg(org);
      const member: Membership = {
        id: generateId(),
        orgId: created.id,
        userId: createdBy,
        role: 'owner',
        status: 'active',
        invitedAt: null,
        joinedAt: now,
        suspendedAt: null,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await store.insertMembership(member);
      await audit('orgs.created', context, { type: 'organisation', id: created.id }, undefined, {
        slug: created.slug,
      });
      await audit(
        'orgs.member.added',
        context,
        { type: 'membership', id: member.id },
        { after: { orgId: created.id, userId: createdBy, role: 'owner' } },
      );
      return created;
    },

    async getOrg(id) {
      return requireOrg(id);
    },
    async findOrg(id) {
      const org = await store.getOrg(assertId(id));
      return org && org.status !== 'deleted' ? org : null;
    },
    async getOrgBySlug(slug) {
      const org = await store.getOrgBySlug(assertSlug(slug));
      if (!org || org.status === 'deleted') {
        throw new OrgsError('ORGS_NOT_FOUND', 'Organisation not found');
      }
      return org;
    },
    async listOrgs(query = {}) {
      const limit = clampLimit(query.limit);
      const decoded = decodeCursor(query.cursor);
      const listQuery: Parameters<OrgsStore['listOrgs']>[0] = { limit: limit + 1 };
      if (query.status !== undefined) listQuery.status = query.status;
      if (query.search !== undefined) listQuery.search = query.search;
      if (decoded) listQuery.after = { createdAt: decoded.time, id: decoded.id };
      const items = await store.listOrgs(listQuery);
      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: items.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
    async updateOrg(id, patch, opts, context) {
      const org = await requireOrg(id);
      if (org.status !== 'active') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Only active organisations can be updated');
      }
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== org.version) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Organisation version conflict');
      }
      const next: Organisation = {
        ...org,
        name: patch.name !== undefined ? assertName(patch.name) : org.name,
        slug: patch.slug !== undefined ? assertSlug(patch.slug) : org.slug,
        metadata:
          patch.metadata !== undefined
            ? assertJsonObject(patch.metadata, 'metadata')
            : org.metadata,
        updatedAt: clock.now(),
      };
      const updated = await store.updateOrg(next, org.version);
      if (mode === 'single' && id === (options.single?.id ?? 'default')) {
        defaultOrgPromise = Promise.resolve(updated);
      }
      await audit(
        'orgs.updated',
        context,
        { type: 'organisation', id },
        {
          before: { name: org.name, slug: org.slug },
          after: { name: updated.name, slug: updated.slug },
        },
      );
      return updated;
    },
    async archiveOrg(id, context) {
      const org = await requireOrg(id);
      if (org.status !== 'active') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Only active organisations can be archived');
      }
      const now = clock.now();
      const updated = await store.updateOrg(
        { ...org, status: 'archived', archivedAt: now, updatedAt: now },
        org.version,
      );
      await audit('orgs.archived', context, { type: 'organisation', id });
      return updated;
    },
    async deleteOrg(id, context) {
      if (mode === 'single') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Cannot delete the organisation in single mode');
      }
      const org = await requireOrg(id);
      if (org.status === 'deleted') return org;
      if (org.status === 'active') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Archive the organisation before deleting it');
      }
      const now = clock.now();
      const updated = await store.updateOrg(
        { ...org, status: 'deleted', deletedAt: now, updatedAt: now },
        org.version,
      );
      await audit('orgs.deleted', context, { type: 'organisation', id });
      return updated;
    },

    async getSettings(orgId) {
      const org = await requireOrg(orgId);
      return mergeWithDefaults(settingDefs, org.settings);
    },
    async updateSettings(orgId, patch, opts, context) {
      const org = await requireOrg(orgId);
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== org.version) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Organisation version conflict');
      }
      const settings = await applyFieldPatch(settingDefs, org.settings, patch);
      const updated = await store.updateOrg(
        { ...org, settings, updatedAt: clock.now() },
        org.version,
      );
      await audit('orgs.settings.updated', context, { type: 'organisation', id: orgId });
      return updated;
    },

    async addMember(orgId, userId, role = 'member', context) {
      const org = await requireOrg(orgId);
      const r = assertKnownRole(role);
      if (r === 'owner') {
        throw validationError([{ path: 'role', message: 'use transferOwnership to add an owner' }]);
      }
      const existing = await store.getMembership(org.id, assertId(userId, 'userId'));
      const now = clock.now();
      if (existing) {
        if (existing.status === 'active') {
          throw new OrgsError('ORGS_MEMBER_EXISTS', 'User is already a member');
        }
        const revived = await store.updateMembership(
          {
            ...existing,
            role: r,
            status: 'active',
            joinedAt: existing.joinedAt ?? now,
            suspendedAt: null,
            removedAt: null,
            updatedAt: now,
          },
          existing.version,
        );
        await audit('orgs.member.added', context, { type: 'membership', id: revived.id });
        return revived;
      }
      const member: Membership = {
        id: generateId(),
        orgId: org.id,
        userId: assertId(userId, 'userId'),
        role: r,
        status: 'active',
        invitedAt: null,
        joinedAt: now,
        suspendedAt: null,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      const created = await store.insertMembership(member);
      await audit('orgs.member.added', context, { type: 'membership', id: created.id });
      return created;
    },

    async changeMemberRole(orgId, userId, role, context) {
      const m = await requireActiveMember(orgId, userId);
      const r = assertKnownRole(role);
      if (m.role === 'owner' && r !== 'owner') {
        const owners = await store.countOwners(orgId);
        if (owners <= 1) {
          throw new OrgsError('ORGS_LAST_OWNER', 'Cannot demote the last owner');
        }
      }
      if (r === 'owner' && m.role !== 'owner') {
        throw validationError([
          { path: 'role', message: 'use transferOwnership to promote to owner' },
        ]);
      }
      const updated = await store.updateMembership(
        { ...m, role: r, updatedAt: clock.now() },
        m.version,
      );
      await audit(
        'orgs.member.role_changed',
        context,
        { type: 'membership', id: m.id },
        { before: { role: m.role }, after: { role: r } },
      );
      return updated;
    },

    async suspendMember(orgId, userId, context) {
      const m = await requireActiveMember(orgId, userId);
      if (m.role === 'owner') {
        const owners = await store.countOwners(orgId);
        if (owners <= 1) throw new OrgsError('ORGS_LAST_OWNER', 'Cannot suspend the last owner');
      }
      const now = clock.now();
      const updated = await store.updateMembership(
        { ...m, status: 'suspended', suspendedAt: now, updatedAt: now },
        m.version,
      );
      await audit('orgs.member.suspended', context, { type: 'membership', id: m.id });
      return updated;
    },

    async reactivateMember(orgId, userId, context) {
      const m = await store.getMembership(orgId, assertId(userId, 'userId'));
      if (!m || m.status !== 'suspended') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Member is not suspended');
      }
      const updated = await store.updateMembership(
        { ...m, status: 'active', suspendedAt: null, updatedAt: clock.now() },
        m.version,
      );
      await audit('orgs.member.reactivated', context, { type: 'membership', id: m.id });
      return updated;
    },

    async removeMember(orgId, userId, context) {
      const m = await store.getMembership(orgId, assertId(userId, 'userId'));
      if (!m || m.status === 'removed') {
        throw new OrgsError('ORGS_MEMBER_NOT_FOUND', 'Membership not found');
      }
      if (m.role === 'owner' && m.status === 'active') {
        const owners = await store.countOwners(orgId);
        if (owners <= 1) throw new OrgsError('ORGS_LAST_OWNER', 'Cannot remove the last owner');
      }
      const now = clock.now();
      const updated = await store.updateMembership(
        { ...m, status: 'removed', removedAt: now, updatedAt: now },
        m.version,
      );
      const teams = await store.listTeamMembershipsForUser(orgId, userId);
      for (const tm of teams) await store.deleteTeamMembership(tm.teamId, userId);
      await audit('orgs.member.removed', context, { type: 'membership', id: m.id });
      return updated;
    },

    async leaveOrg(orgId, userId, context) {
      return service.removeMember(orgId, userId, context);
    },

    async transferOwnership(orgId, fromUserId, toUserId, context) {
      const from = await requireActiveMember(orgId, fromUserId);
      if (from.role !== 'owner') {
        throw new OrgsError('ORGS_FORBIDDEN', 'Only an owner can transfer ownership');
      }
      const to = await requireActiveMember(orgId, toUserId);
      const now = clock.now();
      const nextOwner = await store.updateMembership(
        { ...to, role: 'owner', updatedAt: now },
        to.version,
      );
      const previous = await store.updateMembership(
        { ...from, role: 'admin', updatedAt: now },
        from.version,
      );
      await audit(
        'orgs.member.role_changed',
        context,
        { type: 'membership', id: nextOwner.id },
        { before: { role: to.role }, after: { role: 'owner' } },
      );
      return { previous, next: nextOwner };
    },

    getMembership(orgId, userId) {
      return store.getMembership(assertId(orgId, 'orgId'), assertId(userId, 'userId'));
    },
    async listMembers(orgId, query = {}) {
      await requireOrg(orgId);
      const limit = clampLimit(query.limit);
      const decoded = decodeCursor(query.cursor);
      const listQuery: Parameters<OrgsStore['listMemberships']>[0] = {
        orgId,
        limit: limit + 1,
      };
      if (query.status !== undefined) listQuery.status = query.status;
      if (decoded) listQuery.after = { createdAt: decoded.time, id: decoded.id };
      const items = await store.listMemberships(listQuery);
      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page,
        nextCursor: items.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },
    listMembershipsForUser(userId) {
      return store.listMembershipsForUser(assertId(userId, 'userId'));
    },

    async createTeam(orgId, input, context) {
      const org = await requireOrg(orgId);
      const name = assertName(input.name);
      const slug = input.slug !== undefined ? assertSlug(input.slug) : slugFromName(name);
      const now = clock.now();
      const team: Team = {
        id: generateId(),
        orgId: org.id,
        name,
        slug,
        metadata: assertJsonObject(input.metadata, 'metadata'),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        version: 1,
      };
      const created = await store.insertTeam(team);
      await audit('orgs.team.created', context, { type: 'team', id: created.id });
      return created;
    },
    async updateTeam(teamId, patch, opts, context) {
      const team = await store.getTeam(assertId(teamId, 'teamId'));
      if (!team || team.archivedAt) throw new OrgsError('ORGS_TEAM_NOT_FOUND', 'Team not found');
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== team.version) {
        throw new OrgsError('ORGS_VERSION_CONFLICT', 'Team version conflict');
      }
      const next: Team = {
        ...team,
        name: patch.name !== undefined ? assertName(patch.name) : team.name,
        slug: patch.slug !== undefined ? assertSlug(patch.slug) : team.slug,
        metadata:
          patch.metadata !== undefined
            ? assertJsonObject(patch.metadata, 'metadata')
            : team.metadata,
        updatedAt: clock.now(),
      };
      const updated = await store.updateTeam(next, team.version);
      await audit('orgs.team.updated', context, { type: 'team', id: teamId });
      return updated;
    },
    async archiveTeam(teamId, context) {
      const team = await store.getTeam(assertId(teamId, 'teamId'));
      if (!team) throw new OrgsError('ORGS_TEAM_NOT_FOUND', 'Team not found');
      const now = clock.now();
      const updated = await store.updateTeam(
        { ...team, archivedAt: now, updatedAt: now },
        team.version,
      );
      await audit('orgs.team.archived', context, { type: 'team', id: teamId });
      return updated;
    },
    async getTeam(teamId) {
      const team = await store.getTeam(assertId(teamId, 'teamId'));
      if (!team || team.archivedAt) throw new OrgsError('ORGS_TEAM_NOT_FOUND', 'Team not found');
      return team;
    },
    listTeams(orgId) {
      return store.listTeams(assertId(orgId, 'orgId'));
    },
    async addTeamMember(teamId, userId, role = 'member', context) {
      const team = await service.getTeam(teamId);
      await requireActiveMember(team.orgId, userId);
      if (role !== 'maintainer' && role !== 'member') {
        throw validationError([{ path: 'role', message: 'must be maintainer or member' }]);
      }
      const now = clock.now();
      const m: TeamMembership = {
        id: generateId(),
        teamId: team.id,
        orgId: team.orgId,
        userId: assertId(userId, 'userId'),
        role,
        createdAt: now,
        updatedAt: now,
      };
      const created = await store.insertTeamMembership(m);
      await audit('orgs.team.member.added', context, { type: 'team_membership', id: created.id });
      return created;
    },
    async removeTeamMember(teamId, userId, context) {
      await service.getTeam(teamId);
      const ok = await store.deleteTeamMembership(teamId, assertId(userId, 'userId'));
      if (ok) {
        await audit('orgs.team.member.removed', context, {
          type: 'team_membership',
          id: `${teamId}:${userId}`,
        });
      }
      return ok;
    },
    listTeamMembers(teamId) {
      return store.listTeamMemberships(assertId(teamId, 'teamId'));
    },

    async invite(input, context) {
      const org = await requireOrg(input.orgId);
      const email = normaliseEmail(input.email);
      const role = assertKnownRole(input.role ?? 'member');
      if (role === 'owner') {
        throw validationError([{ path: 'role', message: 'cannot invite as owner' }]);
      }
      const existing = await store.getPendingInvitationByEmail(org.id, email);
      if (existing) {
        throw new OrgsError('ORGS_INVITATION_EXISTS', 'A pending invitation already exists');
      }
      const teamIds = (input.teamIds ?? []).map((id) => assertId(id, 'teamIds'));
      for (const tid of teamIds) {
        const team = await store.getTeam(tid);
        if (!team || team.orgId !== org.id || team.archivedAt) {
          throw new OrgsError('ORGS_TEAM_NOT_FOUND', `Team ${tid} not found in organisation`);
        }
      }
      const now = clock.now();
      const id = generateId();
      const { token, hash } = issueToken('orginv', id);
      const inv: InvitationRecord = {
        id,
        orgId: org.id,
        email,
        role,
        teamIds,
        status: 'pending',
        invitedBy: context?.actor?.id ?? null,
        tokenHash: hash,
        expiresAt: now + inviteTtl,
        createdAt: now,
        updatedAt: now,
        lastSentAt: null,
        sendCount: 0,
        acceptedAt: null,
        revokedAt: null,
        version: 1,
      };
      await store.insertInvitation(inv);
      const delivery = await deliverInvite(org, inv, token);
      const updated = await store.getInvitation(id);
      await audit('orgs.invitation.created', context, { type: 'invitation', id });
      const result: InvitationResult = {
        invitation: publicInvitation(updated!),
        delivery: delivery.delivery,
      };
      if (delivery.delivery === 'manual') result.token = token;
      return result;
    },

    async resendInvitation(id, context) {
      const inv = await store.getInvitation(assertId(id));
      if (!inv) throw new OrgsError('ORGS_INVITATION_NOT_FOUND', 'Invitation not found');
      if (inv.status !== 'pending') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Invitation is not pending');
      }
      const now = clock.now();
      if (inv.expiresAt <= now) {
        throw new OrgsError('ORGS_INVITATION_EXPIRED', 'Invitation has expired');
      }
      if (inv.lastSentAt !== null && now - inv.lastSentAt < resendInterval) {
        throw new OrgsError('ORGS_INVITATION_THROTTLED', 'Invitation resend throttled');
      }
      if (inv.sendCount >= maxSends) {
        throw new OrgsError('ORGS_INVITATION_THROTTLED', 'Invitation send limit reached');
      }
      const { token, hash } = issueToken('orginv', inv.id);
      const refreshed = await store.updateInvitation(
        { ...inv, tokenHash: hash, updatedAt: now },
        inv.version,
      );
      const org = await requireOrg(inv.orgId);
      const delivery = await deliverInvite(org, refreshed, token);
      const latest = await store.getInvitation(inv.id);
      await audit('orgs.invitation.resent', context, { type: 'invitation', id });
      const result: InvitationResult = {
        invitation: publicInvitation(latest!),
        delivery: delivery.delivery,
      };
      if (delivery.delivery === 'manual') result.token = token;
      return result;
    },

    async revokeInvitation(id, context) {
      const inv = await store.getInvitation(assertId(id));
      if (!inv) throw new OrgsError('ORGS_INVITATION_NOT_FOUND', 'Invitation not found');
      if (inv.status !== 'pending') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Invitation is not pending');
      }
      const now = clock.now();
      const updated = await store.updateInvitation(
        { ...inv, status: 'revoked', revokedAt: now, updatedAt: now },
        inv.version,
      );
      await audit('orgs.invitation.revoked', context, { type: 'invitation', id });
      return publicInvitation(updated);
    },

    async acceptInvitation(token, input, context) {
      const parsed = parseToken('orginv', token);
      if (!parsed) throw new OrgsError('ORGS_TOKEN_INVALID', 'Invalid invitation token');
      const inv = await store.getInvitation(parsed.recordId);
      if (!inv || !verifyTokenHash(token, inv.tokenHash)) {
        throw new OrgsError('ORGS_TOKEN_INVALID', 'Invalid invitation token');
      }
      if (inv.status === 'accepted') {
        const membership = await store.getMembership(inv.orgId, assertId(input.userId, 'userId'));
        if (membership) {
          return { invitation: publicInvitation(inv), membership, created: false };
        }
      }
      if (inv.status === 'revoked') {
        throw new OrgsError('ORGS_INVITATION_REVOKED', 'Invitation was revoked');
      }
      if (inv.status !== 'pending') {
        throw new OrgsError('ORGS_INVALID_STATE', 'Invitation cannot be accepted');
      }
      const now = clock.now();
      if (inv.expiresAt <= now) {
        throw new OrgsError('ORGS_INVITATION_EXPIRED', 'Invitation has expired');
      }
      if (requireEmailMatch) {
        if (!input.email) {
          throw validationError([{ path: 'email', message: 'email is required to accept' }]);
        }
        if (normaliseEmail(input.email) !== inv.email) {
          throw new OrgsError('ORGS_EMAIL_MISMATCH', 'Email does not match the invitation');
        }
      }
      const userId = assertId(input.userId, 'userId');
      let membership = await store.getMembership(inv.orgId, userId);
      let created = false;
      if (!membership || membership.status === 'removed' || membership.status === 'invited') {
        if (membership) {
          membership = await store.updateMembership(
            {
              ...membership,
              role: inv.role,
              status: 'active',
              joinedAt: now,
              suspendedAt: null,
              removedAt: null,
              updatedAt: now,
            },
            membership.version,
          );
        } else {
          membership = await store.insertMembership({
            id: generateId(),
            orgId: inv.orgId,
            userId,
            role: inv.role,
            status: 'active',
            invitedAt: inv.createdAt,
            joinedAt: now,
            suspendedAt: null,
            removedAt: null,
            createdAt: now,
            updatedAt: now,
            version: 1,
          });
          created = true;
        }
      }
      for (const teamId of inv.teamIds) {
        const existing = await store.getTeamMembership(teamId, userId);
        if (!existing) {
          const team = await store.getTeam(teamId);
          if (team && !team.archivedAt) {
            await store.insertTeamMembership({
              id: generateId(),
              teamId,
              orgId: inv.orgId,
              userId,
              role: 'member',
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
      const accepted = await store.updateInvitation(
        { ...inv, status: 'accepted', acceptedAt: now, updatedAt: now },
        inv.version,
      );
      await audit('orgs.invitation.accepted', context, { type: 'invitation', id: inv.id });
      return { invitation: publicInvitation(accepted), membership, created };
    },

    async getInvitation(id) {
      const inv = await store.getInvitation(assertId(id));
      if (!inv) throw new OrgsError('ORGS_INVITATION_NOT_FOUND', 'Invitation not found');
      return publicInvitation(inv);
    },
    async listInvitations(orgId, query = {}) {
      await requireOrg(orgId);
      const limit = clampLimit(query.limit);
      const decoded = decodeCursor(query.cursor);
      const listQuery: Parameters<OrgsStore['listInvitations']>[0] = {
        orgId,
        limit: limit + 1,
      };
      if (query.status !== undefined) listQuery.status = query.status;
      if (decoded) listQuery.after = { createdAt: decoded.time, id: decoded.id };
      const items = await store.listInvitations(listQuery);
      const page = items.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(publicInvitation),
        nextCursor: items.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    permissionsForRole(role) {
      return rolePermissions[role] ?? [];
    },

    async toSubject(userId, orgId) {
      const m = await requireActiveMember(orgId, userId);
      const teams = await store.listTeamMembershipsForUser(orgId, userId);
      return {
        id: userId,
        type: 'user',
        roles: [m.role],
        orgId,
        teamIds: teams.map((t) => t.teamId),
      };
    },

    async can(userId, orgId, permission) {
      const subject = await service.toSubject(userId, orgId).catch(() => null);
      if (!subject) return false;
      const mapped = service.permissionsForRole(subject.roles?.[0] ?? '');
      if (mapped.includes(permission)) {
        if (!options.permissions) return true;
      } else if (!options.permissions) {
        return false;
      }
      if (options.permissions) {
        const resource: ResourceRef = { type: 'organisation', id: orgId, orgId };
        return options.permissions.can(subject, permission, resource);
      }
      return mapped.includes(permission);
    },

    async provisionTenant(orgId, opts, context) {
      const org = await requireOrg(orgId);
      const strategy = opts?.strategy ?? defaultStrategy;
      const existing = await store.getTenant(org.id);
      if (existing && !existing.deprovisionedAt && !opts?.force) {
        throw new OrgsError('ORGS_TENANT_EXISTS', 'Tenant already provisioned');
      }
      const now = clock.now();
      let handle: string | null = null;
      if (strategy === 'schema') {
        const raw = options.tenant?.schemaName?.(org) ?? `tenant_${org.slug.replace(/-/g, '_')}`;
        handle = assertSchemaName(raw, 'schema');
        if (options.tenant?.onSchemaProvision) {
          await options.tenant.onSchemaProvision({ org, schema: handle });
        }
      } else if (strategy === 'database') {
        if (!options.tenant?.onDatabaseProvision) {
          throw new OrgsError(
            'ORGS_CONFIG_INVALID',
            'tenant.onDatabaseProvision is required for database strategy',
          );
        }
        handle = String(await options.tenant.onDatabaseProvision({ org }));
      }
      const tenant: TenantRecord = {
        orgId: org.id,
        strategy,
        handle,
        provisionedAt: now,
        deprovisionedAt: null,
        metadata: {},
      };
      const saved = await store.upsertTenant(tenant);
      await audit('orgs.tenant.provisioned', context, { type: 'tenant', id: org.id }, undefined, {
        strategy,
      });
      return saved;
    },

    async deprovisionTenant(orgId, context) {
      const org = await requireOrg(orgId);
      const tenant = await store.getTenant(org.id);
      if (!tenant || tenant.deprovisionedAt) return tenant;
      if (options.tenant?.onDeprovision) {
        await options.tenant.onDeprovision(tenant, org);
      }
      const updated: TenantRecord = {
        ...tenant,
        deprovisionedAt: clock.now(),
      };
      await store.upsertTenant(updated);
      await audit('orgs.tenant.deprovisioned', context, { type: 'tenant', id: org.id });
      return updated;
    },

    getTenant(orgId) {
      return store.getTenant(assertId(orgId, 'orgId'));
    },

    async enterTenant(input, fn) {
      const userId = assertId(input.userId, 'userId');
      let org: Organisation;
      if (input.orgId) org = await requireOrg(input.orgId);
      else if (input.slug) org = await service.getOrgBySlug(input.slug);
      else if (mode === 'single') org = await getDefaultOrg();
      else throw new OrgsError('ORGS_TENANT_REQUIRED', 'orgId or slug is required');

      const membership = await store.getMembership(org.id, userId);
      if (!membership || membership.status !== 'active') {
        throw new OrgsError('ORGS_TENANT_FORBIDDEN', 'User is not an active member of this tenant');
      }
      const teams = await store.listTeamMembershipsForUser(org.id, userId);
      const tenant = await store.getTenant(org.id);
      const ctx: TenantContext = {
        orgId: org.id,
        slug: org.slug,
        strategy: tenant?.strategy ?? 'shared',
        handle: tenant?.handle ?? null,
        userId,
        roles: [membership.role],
        teamIds: teams.map((t) => t.teamId),
      };
      return runWithTenant(ctx, () => fn(ctx));
    },
  };

  async function deliverInvite(
    org: Organisation,
    inv: InvitationRecord,
    token: string,
  ): Promise<{ delivery: 'sent' | 'failed' | 'manual' }> {
    const now = clock.now();
    if (!options.mailer) {
      await store.updateInvitation(
        {
          ...inv,
          lastSentAt: now,
          sendCount: inv.sendCount + 1,
          updatedAt: now,
        },
        inv.version,
      );
      return { delivery: 'manual' };
    }
    const acceptUrl = acceptLink(options.invitations?.acceptUrl, token);
    const appName = options.invitations?.appName ?? 'our application';
    const content = options.invitations?.renderEmail?.({
      invitation: publicInvitation(inv),
      token,
      acceptUrl,
      org,
      appName,
    }) ?? {
      subject: `Join ${org.name} on ${appName}`,
      text: `You are invited to join ${org.name} as ${inv.role}.${acceptUrl ? `\n\nAccept: ${acceptUrl}` : `\n\nToken: ${token}`}`,
      html: `<p>You are invited to join <strong>${escapeHtml(org.name)}</strong> as ${escapeHtml(inv.role)}.</p>${acceptUrl ? `<p><a href="${escapeHtml(acceptUrl)}">Accept invitation</a></p>` : ''}`,
    };
    try {
      const message: Parameters<Mailer['send']>[0] = {
        to: inv.email,
        subject: content.subject,
        text: content.text,
        category: 'orgs.invitation',
        metadata: { orgId: org.id, invitationId: inv.id },
      };
      if (content.html !== undefined) message.html = content.html;
      await options.mailer.send(message);
      await store.updateInvitation(
        {
          ...inv,
          lastSentAt: now,
          sendCount: inv.sendCount + 1,
          updatedAt: now,
        },
        inv.version,
      );
      return { delivery: 'sent' };
    } catch (err) {
      logger.warn({ err: String(err), invitationId: inv.id }, 'invitation email failed');
      return { delivery: 'failed' };
    }
  }

  return service;
}
