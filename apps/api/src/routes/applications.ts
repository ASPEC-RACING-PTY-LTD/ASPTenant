import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import { accountIdFromRequest, actorFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const createBody = z.object({
  name: z.string().min(1).max(120),
  redirectUris: z.array(z.string().url().max(2048)).min(1).max(20),
});
const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  redirectUris: z.array(z.string().url().max(2048)).min(1).max(20).optional(),
});

export function createApplicationRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/applications',
      operationId: 'listApplications',
      summary: 'List application registrations. No IdP is running.',
      tags: ['applications'],
      request: {},
      responses: { '200': { description: 'Applications' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:read');
        return ok({
          items: await platform.directory.listApplications(),
          identityProvider: false,
        });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/applications',
      operationId: 'createApplication',
      summary: 'Register an application. This does not enable OIDC or SAML.',
      tags: ['applications'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Application body is required');
        return created(
          await platform.directory.createApplication(
            { name: body.name, redirectUris: body.redirectUris },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/applications/:id',
      operationId: 'updateApplication',
      summary: 'Update an application registration',
      tags: ['applications'],
      request: { params: idParams, body: updateBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Application not found');
        const body = request.body ?? {};
        return ok(
          await platform.directory.updateApplication(
            id,
            {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.redirectUris !== undefined ? { redirectUris: body.redirectUris } : {}),
            },
            actorFromRequest(raw, accountId),
          ),
        );
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/applications/:id',
      operationId: 'deleteApplication',
      summary: 'Delete an application registration',
      tags: ['applications'],
      request: { params: idParams },
      responses: { '204': { description: 'Deleted' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Application not found');
        await platform.directory.deleteApplication(id, actorFromRequest(raw, accountId));
        return noContent();
      },
    }),
  ];
}
