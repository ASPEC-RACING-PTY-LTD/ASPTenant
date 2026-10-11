import { randomBytes } from 'node:crypto';
import { createScryptHasher } from '@aspec/auth';
import type { SqlClient } from '@aspec/db';
import { NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { ALL_TENANTS_SCOPE } from '../directory/schema.js';
import { requireTenantId } from '../directory/service.js';
import type { Platform } from '../platform.js';
import { scopedClient, tenantClient } from '../tenancy.js';

export const CLIENT_TYPES = ['confidential', 'public'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export interface Assignments {
  users: string[];
  groups: string[];
}

/** How an application signs people in. */
export interface SignInSettings {
  /** Confidential clients (servers) authenticate with a secret; public clients (desktop and mobile apps) use PKCE only. */
  clientType: ClientType;
  hasSecret: boolean;
  secretCreatedAt: number | null;
  /** Only assigned users and members of assigned groups may sign in. */
  requireAssignment: boolean;
  assignments: Assignments;
  /** People must have two-step verification turned on to sign in. */
  requireMfa: boolean;
}

/** An application as the identity provider sees it, across tenants. */
export interface ClientRecord extends SignInSettings {
  id: string;
  tenantId: string;
  name: string;
  clientId: string;
  redirectUris: string[];
  secretHash: string | null;
}

type Row = Record<string, unknown>;

function toRecord(row: Row): ClientRecord {
  const assignments = JSON.parse(
    String(row.assignments ?? '{"users":[],"groups":[]}'),
  ) as Assignments;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    clientId: String(row.client_id),
    redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
    clientType: (String(row.client_type ?? 'confidential') as ClientType) ?? 'confidential',
    secretHash: row.secret_hash ? String(row.secret_hash) : null,
    hasSecret: Boolean(row.secret_hash),
    secretCreatedAt:
      row.secret_created_at === null || row.secret_created_at === undefined
        ? null
        : Number(row.secret_created_at),
    requireAssignment: Number(row.require_assignment) === 1,
    assignments: { users: assignments.users ?? [], groups: assignments.groups ?? [] },
    requireMfa: Number(row.require_mfa) === 1,
  };
}

export function signInView(record: ClientRecord): SignInSettings {
  return {
    clientType: record.clientType,
    hasSecret: record.hasSecret,
    secretCreatedAt: record.secretCreatedAt,
    requireAssignment: record.requireAssignment,
    assignments: record.assignments,
    requireMfa: record.requireMfa,
  };
}

/** Sign-in settings of applications, and the client lookups the OIDC provider needs. */
export class OidcClients {
  private readonly platform: Platform;
  private readonly db: SqlClient;
  private readonly all: SqlClient;
  private readonly hasher = createScryptHasher();

  constructor(platform: Platform) {
    this.platform = platform;
    this.db = tenantClient(platform);
    this.all = scopedClient(platform, ALL_TENANTS_SCOPE);
  }

  /** Application of the request tenant. */
  async get(applicationId: string): Promise<ClientRecord> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_applications WHERE id = $1 AND tenant_id = $2`,
      [applicationId, requireTenantId(this.platform)],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Application not found');
    return toRecord(row);
  }

  async list(): Promise<ClientRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_applications WHERE tenant_id = $1`,
      [requireTenantId(this.platform)],
    );
    return result.rows.map(toRecord);
  }

  /** Any tenant's application by client id, for the provider. */
  async findByClientId(clientId: string): Promise<ClientRecord | null> {
    const result = await this.all.query(
      `SELECT * FROM aspectenant_applications WHERE client_id = $1`,
      [clientId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async update(
    applicationId: string,
    patch: Partial<
      Pick<SignInSettings, 'clientType' | 'requireAssignment' | 'assignments' | 'requireMfa'>
    >,
    actor: Actor,
  ): Promise<SignInSettings> {
    const before = await this.get(applicationId);
    const assignments = patch.assignments
      ? await this.checkAssignments(before.tenantId, patch.assignments)
      : before.assignments;
    const next: ClientRecord = {
      ...before,
      ...(patch.clientType ? { clientType: patch.clientType } : {}),
      ...(patch.requireAssignment !== undefined
        ? { requireAssignment: patch.requireAssignment }
        : {}),
      ...(patch.requireMfa !== undefined ? { requireMfa: patch.requireMfa } : {}),
      assignments,
    };
    // A public client has no secret; switching to public removes it.
    const secretHash = next.clientType === 'public' ? null : before.secretHash;
    await this.db.query(
      `UPDATE aspectenant_applications SET client_type = $1, require_assignment = $2,
        assignments = $3, require_mfa = $4, secret_hash = $5, secret_created_at = $6,
        updated_at = $7 WHERE id = $8 AND tenant_id = $9`,
      [
        next.clientType,
        next.requireAssignment ? 1 : 0,
        JSON.stringify(next.assignments),
        next.requireMfa ? 1 : 0,
        secretHash,
        secretHash ? before.secretCreatedAt : null,
        Date.now(),
        applicationId,
        before.tenantId,
      ],
    );
    const view = signInView({ ...next, secretHash, hasSecret: Boolean(secretHash) });
    await this.platform.audit.record({
      action: 'directory.application.sign_in_updated',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'application', id: applicationId },
      tenantId: before.tenantId,
      changes: { before: signInView(before), after: view },
    });
    return view;
  }

  private async checkAssignments(tenantId: string, input: Assignments): Promise<Assignments> {
    const users = [...new Set(input.users)];
    const groups = [...new Set(input.groups)];
    for (const userId of users) {
      const membership = await this.platform.orgs.getMembership(tenantId, userId);
      if (!membership || membership.status === 'removed') {
        throw new UnprocessableError('Assign only people who belong to this organisation.');
      }
    }
    for (const groupId of groups) await this.platform.directory.getGroup(groupId);
    if (users.length + groups.length > 500) {
      throw new UnprocessableError('Assign at most 500 people and groups.');
    }
    return { users, groups };
  }

  /** Creates or replaces the client secret. It is stored hashed and returned only here. */
  async rotateSecret(applicationId: string, actor: Actor): Promise<string> {
    const record = await this.get(applicationId);
    if (record.clientType === 'public') {
      throw new UnprocessableError('Public clients use PKCE and have no secret.');
    }
    const secret = `ats_${randomBytes(32).toString('base64url')}`;
    await this.db.query(
      `UPDATE aspectenant_applications SET secret_hash = $1, secret_created_at = $2, updated_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [await this.hasher.hash(secret), Date.now(), applicationId, record.tenantId],
    );
    await this.platform.audit.record({
      action: 'directory.application.secret_rotated',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'application', id: applicationId },
      tenantId: record.tenantId,
    });
    return secret;
  }

  async verifySecret(hash: string, secret: string): Promise<boolean> {
    try {
      return await this.hasher.verify(hash, secret);
    } catch {
      return false;
    }
  }

  /**
   * Why an account may not sign in to this application, or null when it may. Runs bound to the
   * application's tenant.
   */
  async refusal(
    record: ClientRecord,
    accountId: string,
    mfaVerified: boolean,
  ): Promise<string | null> {
    const membership = await this.platform.orgs.getMembership(record.tenantId, accountId);
    if (membership?.status !== 'active') {
      return `Your account does not belong to the organisation that runs ${record.name}.`;
    }
    const user = await this.platform.users.findUser(accountId);
    if (user?.status !== 'active') return 'Your account is suspended.';
    if (record.requireAssignment && !(await this.assigned(record, accountId))) {
      return `You have not been given access to ${record.name}. Ask an administrator.`;
    }
    if (record.requireMfa && !mfaVerified) {
      const status = await this.platform.auth.getMfaStatus(accountId);
      return status.enabled
        ? 'Sign in again with your verification code to continue.'
        : `${record.name} requires two-step verification. Turn it on under Your account first.`;
    }
    return null;
  }

  private async assigned(record: ClientRecord, accountId: string): Promise<boolean> {
    if (record.assignments.users.includes(accountId)) return true;
    if (record.assignments.groups.length === 0) return false;
    const db = scopedClient(this.platform, record.tenantId);
    const result = await db.query(
      `SELECT group_id FROM aspectenant_group_members WHERE tenant_id = $1 AND user_id = $2`,
      [record.tenantId, accountId],
    );
    const groups = new Set(result.rows.map((row) => String(row.group_id)));
    return record.assignments.groups.some((id) => groups.has(id));
  }
}
