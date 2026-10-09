import { created, defineRoute, noContent, ok } from '@aspec/api';
import { ConflictError, NotFoundError } from '@aspec/errors';
import { z } from 'zod';
import {
  accountIdFromRequest,
  actorFromRequest,
  hasPlatformPermission,
  requirePermission,
  requirePlatformPermission,
} from '../access.js';
import type { DirectoryDomain } from '../directory/index.js';
import type { Platform } from '../platform.js';

const idParams = z.object({ id: z.string().min(1) });
const createBody = z.object({
  hostname: z.string().min(3).max(253),
  primary: z.boolean().optional(),
});

export function createDomainRoutes(platform: Platform) {
  /** A domain with the TXT record that proves ownership while it is still pending. */
  const domainView = (domain: DirectoryDomain) => ({
    ...domain,
    verification:
      domain.status === 'verified'
        ? null
        : { type: 'TXT' as const, ...platform.directory.domainVerification(domain) },
  });

  return [
    defineRoute({
      method: 'get',
      path: '/domains',
      operationId: 'listDomains',
      summary: 'List the custom domains of the current organisation',
      tags: ['domains'],
      request: {},
      responses: { '200': { description: 'Domains' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:read');
        const domains = await platform.directory.listDomains();
        return ok({
          items: domains.map(domainView),
          canOverride: await hasPlatformPermission(platform, accountId, 'domains:override'),
        });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains',
      operationId: 'createDomain',
      summary:
        'Register a custom domain. It stays pending until the DNS TXT record proves ownership.',
      tags: ['domains'],
      request: { body: createBody },
      responses: { '201': { description: 'Created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Domain body is required');
        return created(
          domainView(
            await platform.directory.createDomain(
              {
                hostname: body.hostname,
                ...(body.primary !== undefined ? { primary: body.primary } : {}),
              },
              actorFromRequest(raw, accountId),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains/:id/verify',
      operationId: 'verifyDomain',
      summary: 'Verify domain ownership by looking up the TXT record in DNS',
      tags: ['domains'],
      request: { params: idParams },
      responses: {
        '200': { description: 'Verified' },
        '409': { description: 'Verified by another organisation' },
        '422': { description: 'TXT record not found' },
      },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Domain not found');
        return ok(
          domainView(await platform.directory.verifyDomain(id, actorFromRequest(raw, accountId))),
        );
      },
    }),
    defineRoute({
      method: 'post',
      path: '/domains/:id/confirm',
      operationId: 'confirmDomain',
      summary:
        'Platform operators only: mark a domain verified without a DNS check, for example on a private network.',
      tags: ['domains'],
      request: { params: idParams },
      responses: { '200': { description: 'Verified' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'domains:manage');
        await requirePlatformPermission(platform, accountId, 'domains:override');
        const id = request.params?.id;
        if (!id) throw new NotFoundError('Domain not found');
        return ok(
          domainView(await platform.directory.confirmDomain(id, actorFromRequest(raw, accountId))),
        );
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
        return ok(
          domainView(
            await platform.directory.setPrimaryDomain(id, actorFromRequest(raw, accountId)),
          ),
        );
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/domains/:id',
      operationId: 'deleteDomain',
      summary: 'Remove a domain record that no mailbox or alias uses',
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
