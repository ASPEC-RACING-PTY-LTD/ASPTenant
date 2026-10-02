import { createApi, created, defineRoute, ok } from '@aspec/api';
import { ConflictError, UnauthorizedError } from '@aspec/errors';
import { z } from 'zod';
import { completeSetup, getSetupState } from '../bootstrap.js';
import { MAIL_TRANSPORT_CATALOGUE, mailCapabilityStatus } from '../mail/index.js';
import type { Platform } from '../platform.js';
import { createApplicationRoutes } from './applications.js';
import { createAuditRoutes } from './audit.js';
import { createDiagnosticsRoutes } from './diagnostics.js';
import { createDomainRoutes } from './domains.js';
import { createGroupRoutes } from './groups.js';
import { createMailboxRoutes } from './mailboxes.js';
import { createSecurityRoutes } from './security.js';
import { createSettingsRoutes } from './settings.js';
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
    summary: 'Create the first super administrator. Closed after the first account exists.',
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
      const [account, user, org] = await Promise.all([
        platform.auth.getAccount(accountId),
        platform.users.findUser(accountId),
        platform.orgs.getDefaultOrg(),
      ]);
      if (!account || !user) throw new UnauthorizedError('Sign in required');
      const [membership, permissions] = await Promise.all([
        platform.orgs.getMembership(org.id, account.id),
        platform.rbac.permissionsFor({ id: account.id, type: 'user' }),
      ]);
      return ok({
        permissions: permissions.permissions,
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
        organisation: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          status: org.status,
        },
        membership: membership ? { role: membership.role, status: membership.status } : null,
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
        tenantMode: 'single',
        capabilities: {
          identity: { implemented: true, notes: ['Email and password sessions are available.'] },
          organisations: {
            implemented: true,
            notes: ['Single-organisation mode. Multi-tenant isolation remains in the data model.'],
          },
          rbac: {
            implemented: true,
            notes: ['Seeded tenant.owner, tenant.admin and tenant.auditor.'],
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
              'Domain records with operator-confirmed verification. Automatic DNS checks are not implemented.',
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
      ...createSecurityRoutes(platform),
      ...createDomainRoutes(platform),
      ...createMailboxRoutes(platform),
      ...createApplicationRoutes(platform),
      ...createDiagnosticsRoutes(platform),
    ],
  });
}
