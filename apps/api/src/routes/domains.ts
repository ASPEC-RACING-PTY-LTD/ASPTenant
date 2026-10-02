import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import { accountIdFromRequest, actorFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const createBody = z.object({
  hostname: z.string().min(3).max(253),
  primary: z.boolean().optional(),
});

export function createDomainRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/domains',
      operationId: 'listDomains',
      summary: 'List custom domains',
      tags: ['domains'],
      request: {},
      responses: { '200': { description: 'Domains' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:read');
        return ok({ items: await platform.directory.listDomains() });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains',
      operationId: 'createDomain',
      summary:
        'Register a custom domain. Verification is operator-confirmed, not an automatic DNS check.',
      tags: ['domains'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Domain body is required');
        return created(
          await platform.directory.createDomain(
            {
              hostname: body.hostname,
              ...(body.primary !== undefined ? { primary: body.primary } : {}),
            },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains/:id/verify',
      operationId: 'verifyDomain',
      summary: 'Mark a domain as verified after the operator confirms DNS ownership',
      tags: ['domains'],
      request: { params: idParams },
      responses: { '200': { description: 'Verified' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Domain not found');
        return ok(await platform.directory.verifyDomain(id, actorFromRequest(raw, accountId)));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains/:id/primary',
      operationId: 'setPrimaryDomain',
      summary: 'Set the primary organisation domain',
      tags: ['domains'],
      request: { params: idParams },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Domain not found');
        return ok(await platform.directory.setPrimaryDomain(id, actorFromRequest(raw, accountId)));
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/domains/:id',
      operationId: 'deleteDomain',
      summary: 'Remove a domain record',
      tags: ['domains'],
      request: { params: idParams },
      responses: { '204': { description: 'Deleted' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Domain not found');
        await platform.directory.deleteDomain(id, actorFromRequest(raw, accountId));
        return noContent();
      },
    }),
  ];
}
