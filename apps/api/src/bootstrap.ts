import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ConflictError, ForbiddenError, UnprocessableError } from '@aspec/errors';
import type { Organisation } from '@aspec/orgs';
import { PLATFORM_OPERATOR_ROLE, TENANT_OWNER_ROLE } from './permissions.js';
import type { Platform } from './platform.js';
import { assignTenantRole, createTenant } from './tenancy.js';

export interface SetupInput {
  email: string;
  password: string;
  setupCode: string;
  displayName?: string;
  organisationName?: string;
  ip?: string;
  userAgent?: string;
}

export interface SetupState {
  required: boolean;
}

/** Organisation id created by releases that ran in single-tenant mode. */
const LEGACY_DEFAULT_ORG_ID = 'default';

export async function getSetupState(platform: Platform): Promise<SetupState> {
  const existing = await platform.users.listUsers({ limit: 1 });
  return { required: existing.items.length === 0 };
}

/**
 * Creates the first account. It becomes the platform operator (global scope) and the owner of
 * the first tenant (scoped to that tenant only).
 */
export async function completeSetup(
  platform: Platform,
  input: SetupInput,
): Promise<{ accountId: string; tenantId: string }> {
  const expected = Buffer.from(platform.setupCode ?? '');
  const given = Buffer.from(input.setupCode.trim().toUpperCase());
  if (
    expected.length === 0 ||
    expected.length !== given.length ||
    !timingSafeEqual(expected, given)
  ) {
    throw new ForbiddenError(
      'The setup code is not correct. Find it in the API container log (docker compose logs api).',
    );
  }
  const email = input.email.trim();
  if (!email || !input.password) {
    throw new UnprocessableError('Email and password are required');
  }

  const result = await platform.db.transaction(async () => {
    const existing = await platform.users.listUsers({ limit: 1 });
    if (existing.items.length > 0) {
      throw new ConflictError('Setup is already complete. Sign in instead.');
    }

    const registered = await platform.auth.register({
      email,
      password: input.password,
      context: {
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      },
    });

    await platform.users.createUser({
      id: registered.account.id,
      email: registered.account.email,
      status: 'active',
      ...(input.displayName ? { profile: { displayName: input.displayName } } : {}),
    });

    const actor = {
      id: registered.account.id,
      type: 'user',
      ...(input.ip ? { ip: input.ip } : {}),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    };
    const organisationName = input.organisationName?.trim() || platform.config.appName;

    let org: Organisation;
    const legacy = await platform.orgs.findOrg(LEGACY_DEFAULT_ORG_ID);
    if (legacy) {
      // An earlier single-tenant release created this organisation before setup ran.
      org =
        organisationName !== legacy.name
          ? await platform.orgs.updateOrg(legacy.id, { name: organisationName }, {}, { actor })
          : legacy;
      const now = Date.now();
      await platform.orgs.store.insertMembership({
        id: randomUUID(),
        orgId: org.id,
        userId: registered.account.id,
        role: 'owner',
        status: 'active',
        invitedAt: null,
        joinedAt: now,
        suspendedAt: null,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await assignTenantRole(platform, registered.account.id, org.id, TENANT_OWNER_ROLE);
    } else {
      org = await createTenant(platform, {
        name: organisationName,
        ownerId: registered.account.id,
        actor,
      });
    }

    await platform.rbac.admin.assignRole({
      subjectId: registered.account.id,
      roleKey: PLATFORM_OPERATOR_ROLE,
    });

    await platform.audit.record({
      action: 'platform.setup.completed',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'organisation', id: org.id },
      tenantId: org.id,
    });

    return { accountId: registered.account.id, tenantId: org.id };
  });
  platform.setupCode = null;
  return result;
}
