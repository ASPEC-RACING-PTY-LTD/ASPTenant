import { createApi, created, defineRoute, ok } from '@aspec/api';
import { ConflictError, UnauthorizedError } from '@aspec/errors';
import { z } from 'zod';
import { hasPlatformPermission } from '../access.js';
import { completeSetup, getSetupState } from '../bootstrap.js';
import { MAIL_TRANSPORT_CATALOGUE, mailCapabilityStatus } from '../mail/index.js';
import { PLATFORM_PERMISSIONS } from '../permissions.js';
import type { Platform } from '../platform.js';
import {
  activeTenantsFor,
  canOverseeMailboxes,
  listActiveOrgs,
  tenantRolesFor,
} from '../tenancy.js';
import { createApplicationRoutes } from './applications.js';
import { createAuditRoutes } from './audit.js';
import { createDiagnosticsRoutes } from './diagnostics.js';
import { createDomainRoutes } from './domains.js';
import { createGroupRoutes } from './groups.js';
import { createMailboxRoutes } from './mailboxes.js';
import { createSecurityRoutes } from './security.js';
import { createSettingsRoutes } from './settings.js';
import { createTenantRoutes } from './tenants.js';
import { createUserRoutes } from './users.js';

const setupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
  setupCode: z.string().min(1).max(32),
  displayName: z.string().min(1).max(120).optional(),
  organisationName: z.string().min(1).max(120).optional(),
});

export function createControlPlaneApi(platform: Platform) {
  const setupStatus = defineRoute({
    method: 'get',
    path: '/setup',
    operationId: 'getSetupStatus',
    summary: 'Whether first-time setup is still required',
    tags: ['setup'],
    request: {},
    responses: {
      '200': { description: 'Setup status' },
    },
    handler: async () => ok(await getSetupState(platform)),
  });

  const setup = defineRoute({
    method: 'post',
    path: '/setup',
    operationId: 'completeSetup',
    summary:
      'Create the first account: platform operator and owner of the first tenant. Closed after the first account exists.',
    tags: ['setup'],
    request: { body: setupBody },
    responses: {
      '201': { description: 'Administrator created' },
      '409': { description: 'Setup already completed' },
    },
    handler: async ({ request, raw }) => {
      const state = await getSetupState(platform);
      if (!state.required) {
        throw new ConflictError('Setup is already complete. Sign in instead.');
      }
      const body = request.body;
      if (!body) throw new ConflictError('Setup body is required');
      const ip = raw?.headers.get('x-aspectenant-client-ip') ?? undefined;
      const userAgent = raw?.headers.get('user-agent')?.slice(0, 200) ?? undefined;
      const result = await completeSetup(platform, {
        email: body.email,
        password: body.password,
        setupCode: body.setupCode,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.organisationName ? { organisationName: body.organisationName } : {}),
        ...(ip ? { ip } : {}),
        ...(userAgent ? { userAgent } : {}),
      });
      return created({
        accountId: result.accountId,
        tenantId: result.tenantId,
        setupRequired: false,
      });
    },
  });

  const session = defineRoute({
    method: 'get',
    path: '/session',
    operationId: 'getCurrentSession',
    summary: 'Current signed-in administrator, organisation and capabilities',
    tags: ['session'],
    request: {},
    responses: {
      '200': { description: 'Current session' },
      '401': { description: 'Not signed in' },
    },
    handler: async ({ raw }) => {
      const accountId = raw?.headers.get('x-aspectenant-account-id');
      if (!accountId) throw new UnauthorizedError('Sign in required');
      const [account, user, tenants] = await Promise.all([
        platform.auth.getAccount(accountId),
        platform.users.findUser(accountId),
        activeTenantsFor(platform, accountId),
      ]);
      if (!account || !user) throw new UnauthorizedError('Sign in required');
      const current = platform.orgs.currentTenant();
      // Operators who may open any mailbox can switch to tenants they are not a member of.
      const others = (await canOverseeMailboxes(platform, accountId))
        ? (await listActiveOrgs(platform))
            .filter((org) => !tenants.some((t) => t.org.id === org.id))
            .map((org) => ({ org, membership: null }))
        : [];
      const available = [...tenants, ...others];
      const selected = current ? available.find((t) => t.org.id === current.orgId) : undefined;
      const scope = selected ? { orgId: selected.org.id } : undefined;
      const [roles, permissions, platformPermissions] = await Promise.all([
        selected ? tenantRolesFor(platform, accountId, selected.org.id) : Promise.resolve([]),
        scope
          ? platform.rbac
              .permissionsFor({ id: accountId, type: 'user', orgId: scope.orgId }, scope)
              .then((result) => result.permissions)
          : Promise.resolve([] as string[]),
        Promise.all(
          PLATFORM_PERMISSIONS.map(async (permission) =>
            (await hasPlatformPermission(platform, accountId, permission.key))
              ? permission.key
              : null,
          ),
        ),
      ]);
      const granted: string[] = platformPermissions.filter((key) => key !== null);
      return ok({
        account: {
          id: account.id,
          email: account.email,
          emailVerified: account.emailVerified,
          mfaEnabled: account.mfaEnabled,
        },
        user: {
          id: user.id,
          email: user.email,
          displayName: user.profile.displayName ?? null,
          status: user.status,
        },
        organisation: selected
          ? {
              id: selected.org.id,
              name: selected.org.name,
              slug: selected.org.slug,
              status: selected.org.status,
            }
          : null,
        membership: selected?.membership
          ? { role: selected.membership.role, status: selected.membership.status }
          : null,
        roles,
        // Tenant permissions in the current organisation plus platform permissions.
        permissions: [...permissions.filter((key) => !granted.includes(key)), ...granted],
        tenants: available.map((t) => ({
          id: t.org.id,
          name: t.org.name,
          slug: t.org.slug,
          role: t.membership?.role ?? 'operator',
        })),
        platform: {
          operator: granted.includes('tenants:read'),
          permissions: granted,
        },
      });
    },
  });

  const platformStatus = defineRoute({
    method: 'get',
    path: '/platform',
    operationId: 'getPlatform',
    summary: 'Public platform identity and capability map',
    tags: ['platform'],
    request: {},
    responses: { '200': { description: 'Platform description' } },
    handler: async () => {
      const setupState = await getSetupState(platform);
      return ok({
        name: platform.config.appName,
        product: 'ASPECTenant',
        version: platform.config.appVersion,
        setupRequired: setupState.required,
        tenantMode: 'multi',
        capabilities: {
          identity: { implemented: true, notes: ['Email and password sessions are available.'] },
          organisations: {
            implemented: true,
            notes: [
              'Multiple tenants on one installation. Each request is bound to one tenant the account belongs to.',
              'PostgreSQL row-level security on directory and mail tables when connected as the non-superuser application role.',
            ],
          },
          rbac: {
            implemented: true,
            notes: [
              'tenant.owner, tenant.admin and tenant.auditor are assigned per tenant.',
              'platform.operator manages tenants and holds no tenant data access by itself.',
            ],
          },
          users: {
            implemented: true,
            notes: ['Directory create, profile, suspend and reinstate.'],
          },
          groups: {
            implemented: true,
            notes: ['Security and distribution groups with membership.'],
          },
          audit: {
            implemented: true,
            notes: ['Append-only audit events are recorded and searchable.'],
          },
          settings: {
            implemented: true,
            notes: ['Organisation name and tenant mode.'],
          },
          security: {
            implemented: true,
            notes: [
              'Session list/revoke and password change. MFA and passkeys are not exposed yet.',
            ],
          },
          mail: mailCapabilityStatus(),
          applications: {
            implemented: true,
            notes: ['Application registrations are stored. OIDC and SAML are not running.'],
          },
          domains: {
            implemented: true,
            notes: [
              'Ownership is proved with a DNS TXT record. A verified domain belongs to exactly one tenant.',
              'Mailbox addresses and aliases must use a verified domain of their tenant.',
            ],
          },
          migration: { implemented: false },
          softdock: {
            implemented: false,
            notes: [
              'SoftDock is an external platform. Integration will use stable APIs and service identities.',
            ],
          },
        },
        mailTransports: MAIL_TRANSPORT_CATALOGUE,
      });
    },
  });

  return createApi({
    info: {
      title: 'ASPECTenant Control Plane',
      version: platform.config.appVersion,
      description:
        'Self-hosted identity and administration API. Mailbox message storage, IMAP and SoftDock are documented but not implemented.',
    },
    basePath: '/api',
    versioning: { versions: ['1'] },
    routes: [
      setupStatus,
      setup,
      session,
      platformStatus,
      ...createUserRoutes(platform),
      ...createGroupRoutes(platform),
      ...createAuditRoutes(platform),
      ...createSettingsRoutes(platform),
      ...createTenantRoutes(platform),
      ...createSecurityRoutes(platform),
      ...createDomainRoutes(platform),
      ...createMailboxRoutes(platform),
      ...createApplicationRoutes(platform),
      ...createDiagnosticsRoutes(platform),
    ],
  });
}
