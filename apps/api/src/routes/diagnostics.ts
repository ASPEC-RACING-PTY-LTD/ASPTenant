import { defineRoute, ok } from '@aspec/api';
import { accountIdFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';

export function createDiagnosticsRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/system',
      operationId: 'getSystemDiagnostics',
      summary: 'Control-plane diagnostics for administrators',
      tags: ['system'],
      request: {},
      responses: { '200': { description: 'Diagnostics' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'system:read');
        const [users, counts, auditCount, health] = await Promise.all([
          platform.users.listUsers({ limit: 1 }),
          platform.directory.counts(),
          platform.audit.count(),
          platform.db.checkHealth(),
        ]);
        return ok({
          uptimeMs: Date.now() - platform.startedAt,
          database: {
            ok: health.ok,
            latencyMs: health.latencyMs ?? null,
            dialect: platform.db.dialect,
          },
          counts: {
            users: users.items.length > 0 ? await countUsers(platform) : 0,
            groups: counts.groups,
            domains: counts.domains,
            mailboxes: counts.mailboxes,
            applications: counts.applications,
            auditEvents: auditCount,
          },
        });
      },
    }),
  ];
}

async function countUsers(platform: Platform): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await platform.users.listUsers({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    total += page.items.length;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return total;
}
