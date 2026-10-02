import { randomUUID } from 'node:crypto';
import { ConflictError, UnprocessableError } from '@aspec/errors';
import { PLATFORM_OWNER_ROLE } from './permissions.js';
import type { Platform } from './platform.js';

export interface SetupInput {
  email: string;
  password: string;
  displayName?: string;
  organisationName?: string;
  ip?: string;
  userAgent?: string;
}

export interface SetupState {
  required: boolean;
}

export async function getSetupState(platform: Platform): Promise<SetupState> {
  const existing = await platform.users.listUsers({ limit: 1 });
  return { required: existing.items.length === 0 };
}

export async function completeSetup(
  platform: Platform,
  input: SetupInput,
): Promise<{ accountId: string }> {
  const email = input.email.trim();
  if (!email || !input.password) {
    throw new UnprocessableError('Email and password are required');
  }

  return platform.db.transaction(async () => {
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

    let org = await platform.orgs.getDefaultOrg();
    const organisationName = input.organisationName?.trim();
    if (organisationName && organisationName !== org.name) {
      org = await platform.orgs.updateOrg(org.id, { name: organisationName }, {}, {});
    }
    const now = Date.now();
    // addMember refuses role=owner; the first member is inserted as owner here.
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
    await platform.rbac.admin.assignRole({
      subjectId: registered.account.id,
      roleKey: PLATFORM_OWNER_ROLE,
    });

    await platform.directory.provisionUserMailbox(
      registered.account.id,
      registered.account.email,
      input.displayName ?? null,
    );

    await platform.audit.record({
      action: 'platform.setup.completed',
      outcome: 'success',
      category: 'security',
      actor: {
        id: registered.account.id,
        type: 'user',
        ...(input.ip ? { ip: input.ip } : {}),
        ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      },
      resource: { type: 'organisation', id: org.id },
    });

    return { accountId: registered.account.id };
  });
}
