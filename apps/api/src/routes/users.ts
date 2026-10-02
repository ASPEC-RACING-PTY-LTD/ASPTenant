import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, ForbiddenError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import {
  accountIdFromRequest,
  actorFromRequest,
  isAuthEmailTaken,
  requirePermission,
} from '../access.js';
import { PLATFORM_OWNER_ROLE } from '../permissions.js';
import type { Platform } from '../platform.js';

const createBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
  displayName: z.string().min(1).max(120).optional(),
  orgRole: z.enum(['admin', 'member']).default('member'),
  platformRole: z.enum(['tenant.admin', 'tenant.auditor']).optional(),
});

const updateBody = z.object({
  displayName: z.string().min(1).max(120).nullable().optional(),
});

const suspendBody = z.object({
  reason: z.string().min(1).max(500),
});

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'deleted']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Only an organisation owner may suspend or sign out another owner. */
async function assertCanManage(platform: Platform, actorId: string, targetId: string) {
  const targetRoles = await platform.rbac.rolesFor({ id: targetId, type: 'user' });
  if (!targetRoles.includes(PLATFORM_OWNER_ROLE)) return;
  const actorRoles = await platform.rbac.rolesFor({ id: actorId, type: 'user' });
  if (!actorRoles.includes(PLATFORM_OWNER_ROLE)) {
    throw new ForbiddenError('Only an organisation owner can change another owner.');
  }
}

export function createUserRoutes(platform: Platform) {
  const listUsers = defineRoute({
    method: 'get',
    path: '/users',
    operationId: 'listUsers',
    summary: 'List organisation users',
    tags: ['users'],
    request: { query: listQuery },
    responses: { '200': { description: 'User list' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'users:read');
      const query = request.query;
      const page = await platform.users.listUsers({
        limit: query?.limit ?? 50,
        ...(query?.search ? { search: query.search } : {}),
        ...(query?.status ? { status: query.status } : {}),
      });
      const org = await platform.orgs.getDefaultOrg();
      const items = await Promise.all(
        page.items.map(async (user) => {
          const [membership, roles, mailbox] = await Promise.all([
            platform.orgs.getMembership(org.id, user.id),
            platform.rbac.rolesFor({ id: user.id, type: 'user' }),
            platform.directory.store.findMailboxByUser(org.id, user.id),
          ]);
          return {
            id: user.id,
            email: user.email,
            displayName: user.profile.displayName,
            status: user.status,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
            orgRole: membership?.role ?? null,
            platformRoles: roles,
            mailboxId: mailbox?.id ?? null,
          };
        }),
      );
      return ok({ items, nextCursor: page.nextCursor });
    },
  });

  const getUser = defineRoute({
    method: 'get',
    path: '/users/:id',
    operationId: 'getUser',
    summary: 'Get one user',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'User' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'users:read');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const user = await platform.users.findUser(id);
      if (!user) throw new NotFoundError('User not found');
      const org = await platform.orgs.getDefaultOrg();
      const [membership, roles, mailbox] = await Promise.all([
        platform.orgs.getMembership(org.id, user.id),
        platform.rbac.rolesFor({ id: user.id, type: 'user' }),
        platform.directory.store.findMailboxByUser(org.id, user.id),
      ]);
      return ok({
        id: user.id,
        email: user.email,
        displayName: user.profile.displayName,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        orgRole: membership?.role ?? null,
        platformRoles: roles,
        mailboxId: mailbox?.id ?? null,
      });
    },
  });

  const createUser = defineRoute({
    method: 'post',
    path: '/users',
    operationId: 'createUser',
    summary: 'Create a user, membership and mailbox directory record',
    tags: ['users'],
    request: { body: createBody },
    responses: { '201': { description: 'User created' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'users:invite');
      const body = request.body;
      if (!body) throw new ConflictError('User body is required');
      const actor = actorFromRequest(raw, accountId);
      const org = await platform.orgs.getDefaultOrg();

      const createdUser = await platform.db.transaction(async () => {
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
        await platform.orgs.addMember(org.id, user.id, body.orgRole, { actor });
        if (body.platformRole) {
          await platform.rbac.admin.assignRole({
            subjectId: user.id,
            roleKey: body.platformRole,
          });
        } else if (body.orgRole === 'admin') {
          await platform.rbac.admin.assignRole({
            subjectId: user.id,
            roleKey: 'tenant.admin',
          });
        }
        await platform.directory.provisionUserMailbox(
          user.id,
          user.email,
          user.profile.displayName,
          actor,
        );
        return user;
      });

      return created({
        id: createdUser.id,
        email: createdUser.email,
        displayName: createdUser.profile.displayName,
        status: createdUser.status,
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
      await requirePermission(platform, accountId, 'users:update');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const actor = actorFromRequest(raw, accountId);
      const user = await platform.users.updateProfile(
        id,
        request.body?.displayName !== undefined ? { displayName: request.body.displayName } : {},
        {},
        { actor },
      );
      return ok({
        id: user.id,
        email: user.email,
        displayName: user.profile.displayName,
        status: user.status,
      });
    },
  });

  const suspendUser = defineRoute({
    method: 'post',
    path: '/users/:id/suspend',
    operationId: 'suspendUser',
    summary: 'Suspend a user and disable sign-in',
    tags: ['users'],
    request: { params: idParams, body: suspendBody },
    responses: { '200': { description: 'User suspended' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'users:suspend');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      if (id === accountId) throw new ForbiddenError('You cannot suspend your own account.');
      await assertCanManage(platform, accountId, id);
      const actor = actorFromRequest(raw, accountId);
      const reason = request.body?.reason ?? 'Suspended by administrator';
      const user = await platform.users.suspendUser(id, { reason }, { actor });
      await platform.auth.disableAccount(id, { actorId: accountId });
      await platform.auth.revokeAllSessions(id);
      return ok({ id: user.id, status: user.status });
    },
  });

  const reinstateUser = defineRoute({
    method: 'post',
    path: '/users/:id/reinstate',
    operationId: 'reinstateUser',
    summary: 'Reinstate a suspended user',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'User reinstated' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'users:suspend');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const actor = actorFromRequest(raw, accountId);
      const user = await platform.users.reactivateUser(id, { actor });
      await platform.auth.enableAccount(id, { actorId: accountId });
      return ok({ id: user.id, status: user.status });
    },
  });

  const listUserSessions = defineRoute({
    method: 'get',
    path: '/users/:id/sessions',
    operationId: 'listUserSessions',
    summary: 'List sessions for a user',
    tags: ['users'],
    request: { params: idParams },
    responses: { '200': { description: 'Sessions' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'security:read');
      const id = request.params?.id;
      if (!id) throw new NotFoundError('User not found');
      const user = await platform.users.findUser(id);
      if (!user) throw new NotFoundError('User not found');
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
    summary: 'Revoke one user session',
    tags: ['users'],
    request: { params: z.object({ userId: z.string().min(1), sessionId: z.string().min(1) }) },
    responses: { '204': { description: 'Revoked' } },
    handler: async ({ raw, request }) => {
      const accountId = accountIdFromRequest(raw);
      await requirePermission(platform, accountId, 'security:manage');
      const userId = request.params?.userId;
      const sessionId = request.params?.sessionId;
      if (!userId || !sessionId) throw new NotFoundError('Session not found');
      await assertCanManage(platform, accountId, userId);
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
    suspendUser,
    reinstateUser,
    listUserSessions,
    revokeUserSession,
  ];
}
