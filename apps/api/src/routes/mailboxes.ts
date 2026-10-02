import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import { accountIdFromRequest, actorFromRequest, requirePermission } from '../access.js';
import { MAILBOX_KINDS } from '../directory/index.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const aliasParams = z.object({ id: z.string().min(1), alias: z.string().min(3) });
const createBody = z.object({
  kind: z.enum(MAILBOX_KINDS),
  primaryAddress: z.string().email().max(320),
  userId: z.string().min(1).optional(),
  displayName: z.string().max(120).optional(),
});
const updateBody = z.object({
  displayName: z.string().max(120).nullable().optional(),
});
const aliasBody = z.object({
  alias: z.string().email().max(320),
});

export function createMailboxRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/mailboxes',
      operationId: 'listMailboxes',
      summary: 'List mailboxes',
      tags: ['mail'],
      request: {},
      responses: { '200': { description: 'Mailboxes' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:read');
        return ok({
          items: await platform.directory.listMailboxes(),
        });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/mailboxes',
      operationId: 'createMailbox',
      summary: 'Provision a mailbox on a registered domain',
      tags: ['mail'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Mailbox body is required');
        return created(
          await platform.directory.createMailbox(
            {
              kind: body.kind,
              primaryAddress: body.primaryAddress,
              ...(body.userId ? { userId: body.userId } : {}),
              ...(body.displayName ? { displayName: body.displayName } : {}),
            },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/mailboxes/:id',
      operationId: 'updateMailbox',
      summary: 'Update mailbox directory metadata',
      tags: ['mail'],
      request: { params: idParams, body: updateBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Mailbox not found');
        return ok(
          await platform.directory.updateMailbox(
            id,
            {
              ...(request.body?.displayName !== undefined
                ? { displayName: request.body.displayName }
                : {}),
            },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/mailboxes/:id',
      operationId: 'deleteMailbox',
      summary: 'Delete a mailbox and all of its messages',
      tags: ['mail'],
      request: { params: idParams },
      responses: { '204': { description: 'Deleted' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Mailbox not found');
        await platform.directory.deleteMailbox(id, actorFromRequest(raw, accountId));
        return noContent();
      },
    }),
    defineRoute({
      method: 'post',
      path: '/mailboxes/:id/aliases',
      operationId: 'addMailboxAlias',
      summary: 'Add a mailbox alias',
      tags: ['mail'],
      request: { params: idParams, body: aliasBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:manage');
        const id = request.params?.id;
        const alias = request.body?.alias;
        if (!id || !alias) throw new ConflictError('Mailbox and alias are required');
        return ok(await platform.directory.addAlias(id, alias, actorFromRequest(raw, accountId)));
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/mailboxes/:id/aliases/:alias',
      operationId: 'removeMailboxAlias',
      summary: 'Remove a mailbox alias',
      tags: ['mail'],
      request: { params: aliasParams },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'mail:manage');
        const id = request.params?.id;
        const alias = request.params?.alias;
        if (!id || !alias) throw new NotFoundError('Alias not found');
        return ok(
          await platform.directory.removeAlias(
            id,
            decodeURIComponent(alias),
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
  ];
}
