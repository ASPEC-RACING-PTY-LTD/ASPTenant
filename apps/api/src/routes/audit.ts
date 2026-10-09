import { defineRoute, ok } from '@aspec/api';
import { z } from 'zod';
import { accountIdFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';

const querySchema = z.object({
  actionPrefix: z.string().max(120).optional(),
  category: z.enum(['security', 'data', 'admin', 'system']).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
});

export function createAuditRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/audit',
      operationId: 'listAuditEvents',
      summary: 'Query administrative and security audit events',
      tags: ['audit'],
      request: { query: querySchema },
      responses: { '200': { description: 'Audit events' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        const tenantId = await requirePermission(platform, accountId, 'audit:read');
        const query = request.query;
        const result = await platform.audit.query({
          tenantId,
          limit: query?.limit ?? 50,
          ...(query?.actionPrefix ? { actionPrefix: query.actionPrefix } : {}),
          ...(query?.category ? { category: query.category } : {}),
          ...(query?.outcome ? { outcome: query.outcome } : {}),
          ...(query?.cursor ? { cursor: query.cursor } : {}),
        });
        return ok({
          items: result.events.map((event) => ({
            id: event.id,
            time: event.time,
            timestamp: event.timestamp,
            action: event.action,
            outcome: event.outcome,
            category: event.category,
            actor: event.actor ?? null,
            resource: event.resource ?? null,
          })),
          nextCursor: result.nextCursor ?? null,
        });
      },
    }),
  ];
}
