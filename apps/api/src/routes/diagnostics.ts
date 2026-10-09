import { defineRoute, ok } from '@aspec/api';
import { accountIdFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';
import { rowLevelSecurityStatus } from '../tenancy.js';

export function createDiagnosticsRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/system',
      operationId: 'getSystemDiagnostics',
      summary: 'Control-plane diagnostics and counts for the current organisation',
      tags: ['system'],
      request: {},
      responses: { '200': { description: 'Diagnostics' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        const tenantId = await requirePermission(platform, accountId, 'system:read');
        const counts = await platform.directory.counts();
        const users = await countMembers(platform, tenantId);
        const auditCount = await platform.audit.count({ tenantId });
        const health = await platform.db.checkHealth();
        const rls = await rowLevelSecurityStatus(platform.db);
        return ok({
          uptimeMs: Date.now() - platform.startedAt,
          database: {
            ok: health.ok,
            latencyMs: health.latencyMs ?? null,
            dialect: platform.db.dialect,
          },
          isolation: {
            tenantId,
            rowLevelSecurity: rls,
          },
          counts: {
            users,
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

async function countMembers(platform: Platform, tenantId: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await platform.orgs.listMembers(tenantId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    total += page.items.filter((m) => m.status === 'active' || m.status === 'suspended').length;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return total;
}
