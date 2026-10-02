import { defineRoute, ok } from '@aspec/api';
import { ConflictError, UnprocessableError } from '@aspec/errors';
import { z } from 'zod';
import { accountIdFromRequest, actorFromRequest, requirePermission } from '../access.js';
import { SettingsStore } from '../mail/store.js';
import type { Platform } from '../platform.js';

const updateBody = z.object({
  name: z.string().min(1).max(120),
  publicUrl: z.string().max(300).nullable().optional(),
});

export function createSettingsRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/settings',
      operationId: 'getSettings',
      summary: 'Organisation settings',
      tags: ['settings'],
      request: {},
      responses: { '200': { description: 'Settings' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'orgs:read');
        const org = await platform.orgs.getDefaultOrg();
        return ok({
          organisation: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            status: org.status,
            createdAt: org.createdAt,
            updatedAt: org.updatedAt,
          },
          tenantMode: 'single',
          appName: platform.config.appName,
          publicUrl: platform.publicUrl,
        });
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/settings',
      operationId: 'updateSettings',
      summary: 'Update organisation settings',
      tags: ['settings'],
      request: { body: updateBody },
      responses: { '200': { description: 'Updated' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'orgs:settings');
        const body = request.body;
        if (!body) throw new ConflictError('Settings body is required');
        const org = await platform.orgs.getDefaultOrg();
        let restarting = false;
        if (body.publicUrl !== undefined) {
          let next: string | null = null;
          if (body.publicUrl?.trim()) {
            try {
              const url = new URL(body.publicUrl.trim());
              if (url.protocol !== 'https:' && url.protocol !== 'http:')
                throw new Error('protocol');
              next = url.origin;
            } catch {
              throw new UnprocessableError('Enter a URL like https://mail.example.com');
            }
          }
          if (next !== platform.publicUrl) {
            await new SettingsStore(platform.db).set(org.id, 'general', { publicUrl: next });
            platform.publicUrl = next;
            restarting = true;
            platform.restart();
          }
        }
        const updated = await platform.orgs.updateOrg(
          org.id,
          { name: body.name.trim() },
          {},
          { actor: actorFromRequest(raw, accountId) },
        );
        await platform.audit.record({
          action: 'organisation.settings.updated',
          outcome: 'success',
          category: 'admin',
          actor: actorFromRequest(raw, accountId),
          resource: { type: 'organisation', id: org.id },
          tenantId: org.id,
          changes: { after: { name: updated.name } },
        });
        return ok({
          restarting,
          publicUrl: platform.publicUrl,
          organisation: {
            id: updated.id,
            name: updated.name,
            slug: updated.slug,
            status: updated.status,
            createdAt: updated.createdAt,
            updatedAt: updated.updatedAt,
          },
        });
      },
    }),
  ];
}
