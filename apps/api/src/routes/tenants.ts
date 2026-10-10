import { created, defineRoute, ok } from '@aspec/api';
import { ConflictError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Organisation } from '@aspec/orgs';
import { z } from 'zod';
import {
  accountIdFromRequest,
  actorFromRequest,
  isAuthEmailTaken,
  requirePlatformPermission,
} from '../access.js';
import { MAX_IMPORT_WORKERS } from '../limits.js';
import { ASSIGNABLE_TENANT_ROLES } from '../permissions.js';
import type { Platform } from '../platform.js';
import { assignTenantRole, createTenant, membershipRoleFor, tenantRolesFor } from '../tenancy.js';

const idParams = z.object({ id: z.string().min(1) });
const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use lowercase letters, digits and hyphens.');

const accountInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024).optional(),
  displayName: z.string().min(1).max(120).optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(120),
  slug: slug.optional(),
  owner: accountInput.optional(),
});

const memberBody = accountInput.extend({
  role: z.enum(ASSIGNABLE_TENANT_ROLES).nullable().optional(),
});

const limitsBody = z.object({
  importWorkers: z.number().int().min(0).max(MAX_IMPORT_WORKERS),
});

const listQuery = z.object({
  status: z.enum(['active', 'archived']).optional(),
  search: z.string().max(200).optional(),
});

function tenantView(org: Organisation) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
    archivedAt: org.archivedAt,
  };
}

/**
 * Installation-level tenant administration. Every route requires a platform permission held in
 * global scope; tenant owners and administrators cannot reach these routes.
 */
export function createTenantRoutes(platform: Platform) {
  /** Finds an account by email, creating it when a password is supplied. */
  async function accountFor(
    input: z.infer<typeof accountInput>,
    actor: ReturnType<typeof actorFromRequest>,
  ): Promise<string> {
    const existing = await platform.users.findUserByEmail(input.email);
    if (existing) return existing.id;
    if (!input.password) {
      throw new UnprocessableError(
        'No account uses that email address. Provide a password to create it.',
      );
    }
    let registered: Awaited<ReturnType<Platform['auth']['register']>>;
    try {
      registered = await platform.auth.register({
        email: input.email,
        password: input.password,
        context: {
          ...(actor.ip ? { ip: actor.ip } : {}),
          ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
        },
      });
    } catch (error) {
      if (isAuthEmailTaken(error)) throw new ConflictError('That email address is already in use.');
      throw error;
    }
    await platform.users.createUser(
      {
        id: registered.account.id,
        email: registered.account.email,
        status: 'active',
        ...(input.displayName ? { profile: { displayName: input.displayName } } : {}),
      },
      { actor },
    );
    return registered.account.id;
  }

  async function memberCount(tenantId: string): Promise<number> {
    const page = await platform.orgs.listMembers(tenantId, { status: 'active', limit: 100 });
    return page.items.length;
  }

  async function requireOrg(id: string): Promise<Organisation> {
    const org = await platform.orgs.findOrg(id);
    if (!org) throw new NotFoundError('Organisation not found');
    return org;
  }

  return [
    defineRoute({
      method: 'get',
      path: '/tenants',
      operationId: 'listTenants',
      summary: 'Platform operators: list every tenant on this installation',
      tags: ['tenants'],
      request: { query: listQuery },
      responses: { '200': { description: 'Tenants' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:read');
        const page = await platform.orgs.listOrgs({
          limit: 100,
          ...(request.query?.status ? { status: request.query.status } : {}),
          ...(request.query?.search ? { search: request.query.search } : {}),
        });
        const items = await Promise.all(
          page.items.map(async (org) => {
            const membership = await platform.orgs.getMembership(org.id, accountId);
            return {
              ...tenantView(org),
              members: await memberCount(org.id),
              joined: membership?.status === 'active',
              limits: await platform.limits.get(org.id),
            };
          }),
        );
        return ok({ items, nextCursor: page.nextCursor });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tenants',
      operationId: 'createTenant',
      summary:
        'Platform operators: create a tenant. The owner is an existing or new account; without one the operator becomes owner.',
      tags: ['tenants'],
      request: { body: createBody },
      responses: { '201': { description: 'Tenant created' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:manage');
        const body = request.body;
        if (!body) throw new ConflictError('Tenant body is required');
        const actor = actorFromRequest(raw, accountId);
        const org = await platform.db.transaction(async () => {
          const ownerId = body.owner ? await accountFor(body.owner, actor) : accountId;
          const tenant = await createTenant(platform, {
            name: body.name,
            ...(body.slug ? { slug: body.slug } : {}),
            ownerId,
            actor,
          });
          await platform.audit.record({
            action: 'platform.tenant.created',
            outcome: 'success',
            category: 'admin',
            actor,
            resource: { type: 'organisation', id: tenant.id },
            tenantId: tenant.id,
            changes: { after: { name: tenant.name, slug: tenant.slug, ownerId } },
          });
          return tenant;
        });
        return created(tenantView(org));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/:id',
      operationId: 'getTenant',
      summary: 'Platform operators: one tenant and its members',
      tags: ['tenants'],
      request: { params: idParams },
      responses: { '200': { description: 'Tenant' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:read');
        const org = await requireOrg(request.params?.id ?? '');
        const page = await platform.orgs.listMembers(org.id, { limit: 100 });
        const members = [];
        for (const membership of page.items) {
          if (membership.status === 'removed') continue;
          const user = await platform.users.findUser(membership.userId);
          members.push({
            userId: membership.userId,
            email: user?.email ?? null,
            displayName: user?.profile.displayName ?? null,
            role: membership.role,
            status: membership.status,
            roles: await tenantRolesFor(platform, membership.userId, org.id),
          });
        }
        return ok({ ...tenantView(org), members, limits: await platform.limits.get(org.id) });
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/:id/members',
      operationId: 'addTenantMember',
      summary:
        'Platform operators: add an existing account (or a new one) to a tenant with an optional administrative role',
      tags: ['tenants'],
      request: { params: idParams, body: memberBody },
      responses: { '201': { description: 'Member added' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:manage');
        const org = await requireOrg(request.params?.id ?? '');
        if (org.status !== 'active') {
          throw new ConflictError('Restore the organisation before adding members.');
        }
        const body = request.body;
        if (!body) throw new ConflictError('Member body is required');
        const actor = actorFromRequest(raw, accountId);
        const role = body.role ?? null;
        const result = await platform.db.transaction(async () => {
          const userId = await accountFor(body, actor);
          const existing = await platform.orgs.getMembership(org.id, userId);
          if (existing && existing.status !== 'removed') {
            throw new ConflictError('That account is already a member of this organisation.');
          }
          const membership = await platform.orgs.addMember(
            org.id,
            userId,
            membershipRoleFor(role),
            {
              actor,
              tenantId: org.id,
            },
          );
          if (role) await assignTenantRole(platform, userId, org.id, role);
          await platform.audit.record({
            action: 'platform.tenant.member_added',
            outcome: 'success',
            category: 'admin',
            actor,
            resource: { type: 'user', id: userId },
            tenantId: org.id,
            changes: { after: { role } },
          });
          return membership;
        });
        return created({
          userId: result.userId,
          role: result.role,
          status: result.status,
          roles: role ? [role] : [],
        });
      },
    }),
    defineRoute({
      method: 'put',
      path: '/tenants/:id/limits',
      operationId: 'setTenantLimits',
      summary:
        'Platform operators: set resource limits for a tenant, such as how many mailbox imports it may run at once (0 pauses them)',
      tags: ['tenants'],
      request: { params: idParams, body: limitsBody },
      responses: { '200': { description: 'Limits' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:manage');
        const org = await requireOrg(request.params?.id ?? '');
        const body = request.body;
        if (!body) throw new UnprocessableError('Limits body is required');
        const before = await platform.limits.get(org.id);
        const after = await platform.limits.set(org.id, body);
        await platform.audit.record({
          action: 'platform.tenant.limits_changed',
          outcome: 'success',
          category: 'admin',
          actor: actorFromRequest(raw, accountId),
          resource: { type: 'organisation', id: org.id },
          tenantId: org.id,
          changes: { before, after },
        });
        // A raised limit can start waiting imports straight away.
        platform.imports.kick();
        return ok(after);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/:id/archive',
      operationId: 'archiveTenant',
      summary:
        'Platform operators: archive a tenant. Its members lose access until it is restored.',
      tags: ['tenants'],
      request: { params: idParams },
      responses: { '200': { description: 'Archived' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:manage');
        const org = await requireOrg(request.params?.id ?? '');
        const actor = actorFromRequest(raw, accountId);
        const archived = await platform.orgs.archiveOrg(org.id, { actor, tenantId: org.id });
        await platform.audit.record({
          action: 'platform.tenant.archived',
          outcome: 'success',
          category: 'admin',
          actor,
          resource: { type: 'organisation', id: org.id },
          tenantId: org.id,
        });
        return ok(tenantView(archived));
      },
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/:id/restore',
      operationId: 'restoreTenant',
      summary: 'Platform operators: restore an archived tenant',
      tags: ['tenants'],
      request: { params: idParams },
      responses: { '200': { description: 'Restored' } },
      handler: async ({ raw, request }) => {
        const accountId = accountIdFromRequest(raw);
        await requirePlatformPermission(platform, accountId, 'tenants:manage');
        const org = await requireOrg(request.params?.id ?? '');
        if (org.status !== 'archived') {
          throw new ConflictError('Only archived organisations can be restored.');
        }
        const actor = actorFromRequest(raw, accountId);
        const restored = await platform.orgs.store.updateOrg(
          { ...org, status: 'active', archivedAt: null, updatedAt: Date.now() },
          org.version,
        );
        await platform.audit.record({
          action: 'platform.tenant.restored',
          outcome: 'success',
          category: 'admin',
          actor,
          resource: { type: 'organisation', id: org.id },
          tenantId: org.id,
        });
        return ok(tenantView(restored));
      },
    }),
  ];
}
