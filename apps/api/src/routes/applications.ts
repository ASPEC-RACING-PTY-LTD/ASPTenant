import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import {
  accountIdFromRequest,
  actorFromRequest,
  requirePermission,
  requirePlatformPermission,
} from '../access.js';
import type { DirectoryApplication } from '../directory/types.js';
import { CLIENT_TYPES, signInView } from '../oidc/clients.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const createBody = z.object({
  name: z.string().min(1).max(120),
  redirectUris: z.array(z.string().url().max(2048)).min(1).max(20),
  clientType: z.enum(CLIENT_TYPES).optional(),
});
const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  redirectUris: z.array(z.string().url().max(2048)).min(1).max(20).optional(),
  clientType: z.enum(CLIENT_TYPES).optional(),
  requireAssignment: z.boolean().optional(),
  requireMfa: z.boolean().optional(),
  assignments: z
    .object({
      users: z.array(z.string().min(1)).max(500),
      groups: z.array(z.string().min(1)).max(500),
    })
    .optional(),
});

export function createApplicationRoutes(platform: Platform) {
  /** An application with its sign-in settings. */
  const view = async (application: DirectoryApplication) => ({
    ...application,
    ...signInView(await platform.oidc.clients.get(application.id)),
  });

  const providerInfo = () => {
    const issuer = platform.oidc.issuerUrl;
    return issuer ? { issuer, discovery: `${issuer}/.well-known/openid-configuration` } : null;
  };

  return [
    defineRoute({
      method: 'get',
      path: '/applications',
      operationId: 'listApplications',
      summary: 'List applications that sign people in with OpenID Connect',
      tags: ['applications'],
      request: {},
      responses: { '200': { description: 'Applications' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:read');
        const items = await platform.directory.listApplications();
        return ok({
          items: await Promise.all(items.map(view)),
          identityProvider: providerInfo(),
        });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/applications',
      operationId: 'createApplication',
      summary:
        'Register an OpenID Connect application. A confidential client gets a secret, returned only in this response.',
      tags: ['applications'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Application body is required');
        const actor = actorFromRequest(raw, accountId);
        const application = await platform.directory.createApplication(
          { name: body.name, redirectUris: body.redirectUris },
          actor,
        );
        if (body.clientType === 'public') {
          await platform.oidc.clients.update(application.id, { clientType: 'public' }, actor);
          return created(await view(application));
        }
        const clientSecret = await platform.oidc.clients.rotateSecret(application.id, actor);
        return created({ ...(await view(application)), clientSecret });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/applications/:id',
      operationId: 'updateApplication',
      summary: 'Update an application: redirect URIs, client type and who may sign in',
      tags: ['applications'],
      request: { params: idParams, body: updateBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Application not found');
        const body = request.body ?? {};
        const actor = actorFromRequest(raw, accountId);
        let application = await platform.directory.getApplication(id);
        if (body.name !== undefined || body.redirectUris !== undefined) {
          application = await platform.directory.updateApplication(
            id,
            {
              ...(body.name !== undefined ? { name: body.name } : {}),
              ...(body.redirectUris !== undefined ? { redirectUris: body.redirectUris } : {}),
            },
            actor,
          );
        }
        if (
          body.clientType !== undefined ||
          body.requireAssignment !== undefined ||
          body.requireMfa !== undefined ||
          body.assignments !== undefined
        ) {
          await platform.oidc.clients.update(
            id,
            {
              ...(body.clientType !== undefined ? { clientType: body.clientType } : {}),
              ...(body.requireAssignment !== undefined
                ? { requireAssignment: body.requireAssignment }
                : {}),
              ...(body.requireMfa !== undefined ? { requireMfa: body.requireMfa } : {}),
              ...(body.assignments !== undefined ? { assignments: body.assignments } : {}),
            },
            actor,
          );
        }
        return ok(await view(application));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/applications/:id/secret',
      operationId: 'rotateApplicationSecret',
      summary:
        'Create or replace the client secret of a confidential application. The old one stops working at once.',
      tags: ['applications'],
      request: { params: idParams },
      responses: { '200': { description: 'New secret, shown once' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'apps:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Application not found');
        const clientSecret = await platform.oidc.clients.rotateSecret(
          id,
          actorFromRequest(raw, accountId),
        );
        return ok({ clientSecret });
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
    defineRoute({
      method: 'get',
      path: '/identity/keys',
      operationId: 'listSigningKeys',
      summary: 'Platform operators: OpenID Connect token signing keys',
      tags: ['applications'],
      request: {},
      responses: { '200': { description: 'Keys' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'platform:admin');
        return ok({ items: platform.identity.keys.info, identityProvider: providerInfo() });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/identity/keys/rotate',
      operationId: 'rotateSigningKey',
      summary:
        'Platform operators: sign tokens with a new key. Earlier keys stay published so issued tokens keep verifying.',
      tags: ['applications'],
      request: {},
      responses: { '200': { description: 'Rotated' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'platform:admin');
        await platform.oidc.rotateSigningKey();
        await platform.audit.record({
          action: 'platform.identity.signing_key_rotated',
          outcome: 'success',
          category: 'security',
          actor: actorFromRequest(raw, accountId),
          resource: { type: 'signing-key', id: platform.identity.keys.info[0]?.kid ?? '' },
        });
        return ok({ items: platform.identity.keys.info });
      },
    }),
  ];
}
