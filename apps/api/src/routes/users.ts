import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, ForbiddenError, NotFoundError } from '@aspec/errors';
import type { Membership } from '@aspec/orgs';
import type { User } from '@aspec/users';
import { z } from 'zod';
import {
  accountIdFromRequest,
  actorFromRequest,
  isAuthEmailTaken,
  requireExclusiveMember,
  requirePermission,
  requireTenantMember,
} from '../access.js';
import { ASSIGNABLE_TENANT_ROLES } from '../permissions.js';
import type { Platform } from '../platform.js';
import {
  assignTenantRole,
  membershipRoleFor,
  revokeTenantRoles,
  tenantRolesFor,
} from '../tenancy.js';

const createBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
  displayName: z.string().min(1).max(120).optional(),
  role: z.enum(ASSIGNABLE_TENANT_ROLES).nullable().optional(),
});

const updateBody = z.object({
  displayName: z.string().min(1).max(120).nullable().optional(),
});

const roleBody = z.object({
  role: z.enum(ASSIGNABLE_TENANT_ROLES).nullable(),
});

const suspendBody = z.object({
  reason: z.string().min(1).max(500),
});

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
});

/** Membership states that make a user part of a tenant's directory. */
function isListed(membership: Membership): boolean {
  return membership.status === 'active' || membership.status === 'suspended';
}

/** A user is suspended in a tenant when either the account or the membership is suspended. */
function tenantStatus(user: User, membership: Membership): string {
  return membership.status === 'suspended' ? 'suspended' : user.status;
}

export function createUserRoutes(platform: Platform) {
  async function view(tenantId: string, user: User, membership: Membership) {
    const [roles, mailbox] = await Promise.all([
      tenantRolesFor(platform, user.id, tenantId),
      platform.directory.store.findMailboxByUser(tenantId, user.id),
    ]);
    return {
      id: user.id,
      email: user.email,
      displayName: user.profile.displayName,
      status: tenantStatus(user, membership),
      accountStatus: user.status,
      membershipStatus: membership.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      orgRole: membership.role,
      roles,
      mailboxId: mailbox?.id ?? null,
    };
  }

  async function loadMember(tenantId: string, id: string) {
    const membership = await requireTenantMember(platform, tenantId, id);
    const user = await platform.users.findUser(id);
    if (!user) throw new NotFoundError('User not found');
    return { membership, user };
  }

  /** Only an owner may act on another owner. */
  async function assertCanActOn(tenantId: string, accountId: string, target: Membership) {
    if (target.role !== 'owner') return;
    const own = await platform.orgs.getMembership(tenantId, accountId);
    if (own?.role !== 'owner') {
      throw new ForbiddenError('Only an organisation owner can change another owner.');
    }
  }

  async function belongsElsewhere(tenantId: string, userId: string): Promise<boolean> {
    const memberships = await platform.orgs.listMembershipsForUser(userId);
    return memberships.some((m) => m.orgId !== tenantId && m.status !== 'removed');
  }

  const listUsers = defineRoute({
    method: 'get',
    path: '/users',
    operationId: 'listUsers',
    summary: 'List users who belong to the current organisation',
    tags: ['users'],
    request: { query: listQuery },
    responses: { '200': { description: 'User list' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:read');
      const query = request.query;
      const page = await platform.orgs.listMembers(tenantId, {
        limit: query?.limit ?? 50,
        ...(query?.cursor ? { cursor: query.cursor } : {}),
      });
      const search = query?.search?.trim().toLowerCase();
      const items = [];
      for (const membership of page.items) {
        if (!isListed(membership)) continue;
        const user = await platform.users.findUser(membership.userId);
        if (!user) continue;
        if (query?.status && tenantStatus(user, membership) !== query.status) continue;
        if (
          search &&
          !user.email.toLowerCase().includes(search) &&
          !(user.profile.displayName ?? '').toLowerCase().includes(search)
        ) {
          continue;
        }
        items.push(await view(tenantId, user, membership));
      }
      return ok({ items, nextCursor: page.nextCursor });
    },
  });

  const getUser = defineRoute({
    method: 'get',
    path: '/users/:id',
    operationId: 'getUser',
    summary: 'Get one user of the current organisation',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'User' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:read');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const { user, membership } = await loadMember(tenantId, id);
      return ok(await view(tenantId, user, membership));
    },
  });

  const createUser = defineRoute({
    method: 'post',
    path: '/users',
    operationId: 'createUser',
    summary:
      'Create an account in the current organisation. A mailbox record is created when the address is on a verified domain.',
    tags: ['users'],
    request: { body: createBody },
    responses: { '201': { description: 'User created' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:invite');
      const body = request.body;
      if (!body) throw new ConflictError('User body is required');
      const role = body.role ?? null;
      if (role) await requirePermission(platform, accountId, 'orgs.members:manage');
      const actor = actorFromRequest(raw, accountId);

      const result = await platform.db.transaction(async () => {
        let registered: Awaited<ReturnType<Platform['auth']['register']>>;
        try {
          registered = await platform.auth.register({
            email: body.email,
            password: body.password,
            context: {
              ...(actor.ip ? { ip: actor.ip } : {}),
              ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
            },
          });
        } catch (error) {
          if (isAuthEmailTaken(error)) {
            throw new ConflictError('That email address is already in use.');
          }
          throw error;
        }

        const user = await platform.users.createUser(
          {
            id: registered.account.id,
            email: registered.account.email,
            status: 'active',
            ...(body.displayName ? { profile: { displayName: body.displayName } } : {}),
          },
          { actor },
        );
        await platform.orgs.addMember(tenantId, user.id, membershipRoleFor(role), {
          actor,
          tenantId,
        });
        if (role) await assignTenantRole(platform, user.id, tenantId, role);
        const mailbox = await platform.directory.provisionUserMailbox(
          user.id,
          user.email,
          user.profile.displayName,
          actor,
        );
        return { user, mailbox };
      });

      return created({
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.profile.displayName,
        status: result.user.status,
        roles: role ? [role] : [],
        mailboxId: result.mailbox?.id ?? null,
      });
    },
  });

  const updateUser = defineRoute({
    method: 'patch',
    path: '/users/:id',
    operationId: 'updateUser',
    summary: 'Update a user profile',
    tags: ['users'],
    request: { params: idParams, body: updateBody },
    responses: { '200': { description: 'User updated' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:update');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const { membership } = await loadMember(tenantId, id);
      if (id !== accountId) await requireExclusiveMember(platform, tenantId, id);
      const actor = actorFromRequest(raw, accountId);
      const user = await platform.users.updateProfile(
        id,
        { displayName: request.body?.displayName ?? null },
        {},
        { actor },
      );
      return ok(await view(tenantId, user, membership));
    },
  });

  const setUserRole = defineRoute({
    method: 'put',
    path: '/users/:id/role',
    operationId: 'setUserRole',
    summary: 'Set the administrative role a user holds in the current organisation',
    tags: ['users'],
    request: { params: idParams, body: roleBody },
    responses: { '200': { description: 'Role updated' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'orgs.members:manage');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      if (id === accountId) throw new ForbiddenError('You cannot change your own role.');
      const { membership } = await loadMember(tenantId, id);
      if (membership.role === 'owner') {
        throw new ForbiddenError('Owners keep the owner role. Transfer ownership first.');
      }
      const role = request.body?.role ?? null;
      const actor = actorFromRequest(raw, accountId);
      await revokeTenantRoles(platform, id, tenantId);
      if (role) await assignTenantRole(platform, id, tenantId, role);
      const nextRole = membershipRoleFor(role);
      const next =
        membership.role === nextRole
          ? membership
          : await platform.orgs.changeMemberRole(tenantId, id, nextRole, { actor, tenantId });
      await platform.audit.record({
        action: 'organisation.member.role_changed',
        outcome: 'success',
        category: 'security',
        actor,
        resource: { type: 'user', id },
        tenantId,
        changes: { after: { role } },
      });
      const user = await platform.users.findUser(id);
      if (!user) throw new NotFoundError('User not found');
      return ok(await view(tenantId, user, next));
    },
  });

  const suspendUser = defineRoute({
    method: 'post',
    path: '/users/:id/suspend',
    operationId: 'suspendUser',
    summary:
      'Suspend a user in this organisation. Accounts that belong to no other organisation also lose sign-in.',
    tags: ['users'],
    request: { params: idParams, body: suspendBody },
    responses: { '200': { description: 'User suspended' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:suspend');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      if (id === accountId) throw new ForbiddenError('You cannot suspend your own account.');
      const { membership } = await loadMember(tenantId, id);
      await assertCanActOn(tenantId, accountId, membership);
      const actor = actorFromRequest(raw, accountId);
      const reason = request.body?.reason ?? 'Suspended by administrator';
      const next =
        membership.status === 'suspended'
          ? membership
          : await platform.orgs.suspendMember(tenantId, id, { actor, tenantId });
      let user = await platform.users.findUser(id);
      if (!user) throw new NotFoundError('User not found');
      if (!(await belongsElsewhere(tenantId, id))) {
        if (user.status !== 'suspended') {
          user = await platform.users.suspendUser(id, { reason }, { actor });
        }
        await platform.auth.disableAccount(id, { actorId: accountId });
        await platform.auth.revokeAllSessions(id);
      }
      await platform.audit.record({
        action: 'organisation.member.suspended',
        outcome: 'success',
        category: 'security',
        actor,
        resource: { type: 'user', id },
        tenantId,
        changes: { after: { reason } },
      });
      return ok({ id: user.id, status: tenantStatus(user, next) });
    },
  });

  const reinstateUser = defineRoute({
    method: 'post',
    path: '/users/:id/reinstate',
    operationId: 'reinstateUser',
    summary: 'Reinstate a suspended user in this organisation',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'User reinstated' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'users:suspend');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const { membership } = await loadMember(tenantId, id);
      await assertCanActOn(tenantId, accountId, membership);
      const actor = actorFromRequest(raw, accountId);
      const next =
        membership.status === 'suspended'
          ? await platform.orgs.reactivateMember(tenantId, id, { actor, tenantId })
          : membership;
      let user = await platform.users.findUser(id);
      if (!user) throw new NotFoundError('User not found');
      if (user.status === 'suspended' && !(await belongsElsewhere(tenantId, id))) {
        user = await platform.users.reactivateUser(id, { actor });
        await platform.auth.enableAccount(id, { actorId: accountId });
      }
      await platform.audit.record({
        action: 'organisation.member.reinstated',
        outcome: 'success',
        category: 'security',
        actor,
        resource: { type: 'user', id },
        tenantId,
      });
      return ok({ id: user.id, status: tenantStatus(user, next) });
    },
  });

  const removeUser = defineRoute({
    method: 'delete',
    path: '/users/:id',
    operationId: 'removeUser',
    summary:
      'Remove a user from this organisation. Accounts that belong to no other organisation are also disabled.',
    tags: ['users'],
    request: { params: idParams },
    responses: { '204': { description: 'Removed' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'orgs.members:manage');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      if (id === accountId) throw new ForbiddenError('You cannot remove yourself.');
      const { membership } = await loadMember(tenantId, id);
      await assertCanActOn(tenantId, accountId, membership);
      const actor = actorFromRequest(raw, accountId);
      await platform.orgs.removeMember(tenantId, id, { actor, tenantId });
      await revokeTenantRoles(platform, id, tenantId);
      await platform.directory.detachUser(id);
      if (!(await belongsElsewhere(tenantId, id))) {
        await platform.auth.disableAccount(id, { actorId: accountId });
        await platform.auth.revokeAllSessions(id);
      }
      await platform.audit.record({
        action: 'organisation.member.removed',
        outcome: 'success',
        category: 'security',
        actor,
        resource: { type: 'user', id },
        tenantId,
      });
      return noContent();
    },
  });

  const listUserSessions = defineRoute({
    method: 'get',
    path: '/users/:id/sessions',
    operationId: 'listUserSessions',
    summary: 'List sessions for a user who belongs only to this organisation',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'Sessions' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'security:read');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      await loadMember(tenantId, id);
      if (id !== accountId) await requireExclusiveMember(platform, tenantId, id);
      const sessions = await platform.auth.listSessions(id);
      return ok({
        items: sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          ip: session.ip,
          userAgent: session.userAgent,
          current: session.current === true,
        })),
      });
    },
  });

  const revokeUserSession = defineRoute({
    method: 'delete',
    path: '/users/:userId/sessions/:sessionId',
    operationId: 'revokeUserSession',
    summary: 'Revoke one session of a user who belongs only to this organisation',
    tags: ['users'],
    request: { params: z.object({ userId: z.string().min(1), sessionId: z.string().min(1) }) },
    responses: { '204': { description: 'Revoked' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      const tenantId = await requirePermission(platform, accountId, 'security:manage');
      const userId = request.params?.userId;
      const sessionId = request.params?.sessionId;
      if (!userId || !sessionId) throw new NotFoundError('Session not found');
      await loadMember(tenantId, userId);
      if (userId !== accountId) await requireExclusiveMember(platform, tenantId, userId);
      const revoked = await platform.auth.revokeSession(userId, sessionId);
      if (!revoked) throw new NotFoundError('Session not found');
      return noContent();
    },
  });

  return [
    listUsers,
    getUser,
    createUser,
    updateUser,
    setUserRole,
    suspendUser,
    reinstateUser,
    removeUser,
    listUserSessions,
    revokeUserSession,
  ];
}
