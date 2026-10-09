import { defineRoute, ok } from '@aspec/api';
import { accountIdFromRequest, requirePermission } from '../access.js';
import type { Platform } from '../platform.js';

export function createSecurityRoutes(platform: Platform) {
  return [
    defineRoute({
      method: 'get',
      path: '/security/roles',
      operationId: 'listSecurityRoles',
      summary: 'List seeded control-plane roles and the scope each applies in',
      tags: ['security'],
      request: {},
      responses: { '200': { description: 'Roles' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePermission(platform, accountId, 'security:read');
        const roles = await platform.rbac.admin.listRoles();
        const items = await Promise.all(
          roles.map(async (role) => ({
            key: role.key,
            name: role.name,
            description: role.description ?? null,
            scope: role.assignableScopes.includes('global') ? 'platform' : 'organisation',
            permissions: await platform.rbac.admin.effectivePermissions(role.key),
          })),
        );
        return ok({ items });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/security/me',
      operationId: 'getSecurityProfile',
      summary: 'Current administrator security profile in this organisation',
      tags: ['security'],
      request: {},
      responses: { '200': { description: 'Profile' } },
      handler: async ({ raw }) => {
        const accountId = accountIdFromRequest(raw);
        const tenantId = await requirePermission(platform, accountId, 'security:read');
        const subject = { id: accountId, type: 'user', orgId: tenantId };
        const scope = { orgId: tenantId };
        const [account, roles, permissions] = await Promise.all([
          platform.auth.getAccount(accountId),
          platform.rbac.rolesFor(subject, scope),
          platform.rbac.permissionsFor(subject, scope),
        ]);
        return ok({
          account: account
            ? {
                id: account.id,
                email: account.email,
                emailVerified: account.emailVerified,
                mfaEnabled: account.mfaEnabled,
                disabled: account.disabled,
              }
            : null,
          roles,
          permissions: permissions.permissions,
        });
      },
    }),
  ];
}
