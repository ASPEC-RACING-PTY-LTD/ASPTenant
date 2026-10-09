import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import { accountIdFromRequest, actorFromRequest, requirePermission } from '../access.js';
import { GROUP_KINDS } from '../directory/index.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const memberParams = z.object({ id: z.string().min(1), userId: z.string().min(1) });
const createBody = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(GROUP_KINDS),
  email: z.string().email().max(320).optional(),
  description: z.string().max(500).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  kind: z.enum(GROUP_KINDS).optional(),
  email: z.string().email().max(320).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
const memberBody = z.object({ userId: z.string().min(1) });

export function createGroupRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/groups',
      operationId: 'listGroups',
      summary: 'List security and distribution groups',
      tags: ['groups'],
      request: {},
      responses: { '200': { description: 'Groups' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:read');
        return ok({ items: await platform.directory.listGroups() });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/groups',
      operationId: 'createGroup',
      summary: 'Create a group',
      tags: ['groups'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Group body is required');
        const group = await platform.directory.createGroup(
          {
            name: body.name,
            kind: body.kind,
            ...(body.email ? { email: body.email } : {}),
            ...(body.description ? { description: body.description } : {}),
          },
          actorFromRequest(raw, accountId),
        );
        return created(group);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/groups/:id',
      operationId: 'getGroup',
      summary: 'Get a group and its members',
      tags: ['groups'],
      request: { params: idParams },
      responses: { '200': { description: 'Group' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:read');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Group not found');
        const [group, members] = await Promise.all([
          platform.directory.getGroup(id),
          platform.directory.listGroupMembers(id),
        ]);
        const hydrated = await Promise.all(
          members.map(async (member) => {
            const user = await platform.users.findUser(member.userId);
            return {
              ...member,
              email: user?.email ?? null,
              displayName: user?.profile.displayName ?? null,
            };
          }),
        );
        return ok({ ...group, members: hydrated });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/groups/:id',
      operationId: 'updateGroup',
      summary: 'Update a group',
      tags: ['groups'],
      request: { params: idParams, body: updateBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Group not found');
        const body = request.body ?? {};
        return ok(
          await platform.directory.updateGroup(
            id,
            {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.kind !== undefined ? { kind: body.kind } : {}),
              ...(body.email !== undefined ? { email: body.email } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
            },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/groups/:id',
      operationId: 'deleteGroup',
      summary: 'Delete a group',
      tags: ['groups'],
      request: { params: idParams },
      responses: { '204': { description: 'Deleted' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Group not found');
        await platform.directory.deleteGroup(id, actorFromRequest(raw, accountId));
        return noContent();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/groups/:id/members',
      operationId: 'addGroupMember',
      summary: 'Add a group member',
      tags: ['groups'],
      request: { params: idParams, body: memberBody },
      responses: { '201': { description: 'Added' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:manage');
        const id = request.params?.id;
        const userId = request.body?.userId;
        if (!id || !userId) throw new ConflictError('Group and user are required');
        return created(
          await platform.directory.addGroupMember(id, userId, actorFromRequest(raw, accountId)),
        );
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/groups/:id/members/:userId',
      operationId: 'removeGroupMember',
      summary: 'Remove a group member',
      tags: ['groups'],
      request: { params: memberParams },
      responses: { '204': { description: 'Removed' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'groups:manage');
        const id = request.params?.id;
        const userId = request.params?.userId;
        if (!id || !userId) throw new NotFoundError('Group member not found');
        await platform.directory.removeGroupMember(id, userId, actorFromRequest(raw, accountId));
        return noContent();
      },
    }),
  ];
}
