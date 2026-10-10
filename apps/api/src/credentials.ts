import { randomBytes, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { createScryptHasher } from '@aspec/auth';
import type { SqlClient } from '@aspec/db';
import { ConflictError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { ALL_TENANTS_SCOPE } from './directory/index.js';
import { isUniqueViolation, requireTenantId } from './directory/service.js';
import type { DirectoryMailbox } from './directory/types.js';
import type { MailboxGrant, MailLogin } from './imap/session.js';
import type { Platform } from './platform.js';
import { scopedClient, tenantClient, withSystemTenant } from './tenancy.js';

export type CredentialKind = 'service' | 'mailbox';

/**
 * An IMAP and SMTP login that is not a person: an application (kind `service`, generated
 * username, any mailboxes) or a shared mailbox signing in with its own address (kind `mailbox`).
 */
export interface ServiceCredential {
  id: string;
  tenantId: string;
  kind: CredentialKind;
  name: string;
  username: string;
  grants: MailboxGrant[];
  /** IP addresses and CIDR ranges allowed to log in. Empty allows any address. */
  allowedIps: string[];
  enabled: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialInput {
  kind: CredentialKind;
  name?: string;
  /** Required for kind `mailbox`: the shared mailbox that signs in with its own address. */
  mailboxId?: string;
  grants?: MailboxGrant[];
  allowedIps?: string[];
  expiresAt?: number | null;
  /** Chosen password. A random one is generated when omitted. */
  password?: string;
}

export interface CredentialPatch {
  name?: string;
  grants?: MailboxGrant[];
  allowedIps?: string[];
  enabled?: boolean;
  expiresAt?: number | null;
}

/** Outcome of a login attempt with a credential username. */
export type CredentialCheck = { login: MailLogin } | { failure: string };

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function toCredential(row: Row): ServiceCredential {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    kind: String(row.kind) as CredentialKind,
    name: String(row.name),
    username: String(row.username),
    grants: JSON.parse(String(row.grants)) as MailboxGrant[],
    allowedIps: JSON.parse(String(row.allowed_ips)) as string[],
    enabled: Number(row.enabled) === 1 || row.enabled === true,
    expiresAt: num(row.expires_at),
    lastUsedAt: num(row.last_used_at),
    lastUsedIp: row.last_used_ip ? String(row.last_used_ip) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Strips the IPv6 prefix from IPv4 addresses on dual-stack sockets. */
export function plainIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4
    ? trimmed.slice(7)
    : trimmed;
}

/** Validates and normalises allowlist entries (single addresses or CIDR ranges). */
export function normaliseAllowlist(entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const [address = '', bits, extra] = entry.split('/');
    const family = isIP(address);
    const prefix = bits === undefined ? null : Number(bits);
    const max = family === 6 ? 128 : 32;
    if (
      !family ||
      extra !== undefined ||
      (prefix !== null && (!Number.isInteger(prefix) || prefix < 0 || prefix > max))
    ) {
      throw new UnprocessableError(`${entry} is not an IP address or CIDR range.`);
    }
    const normal = prefix === null ? address.toLowerCase() : `${address.toLowerCase()}/${prefix}`;
    if (!out.includes(normal)) out.push(normal);
  }
  if (out.length > 100) throw new UnprocessableError('Use at most 100 allowed addresses.');
  return out;
}

/** True when the address is allowed. An empty list allows every address. */
export function ipAllowed(allowlist: string[], ip: string): boolean {
  if (allowlist.length === 0) return true;
  const address = plainIp(ip);
  const family = isIP(address);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const [base = '', bits] = entry.split('/');
    const type = isIP(base) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(base, type);
    else list.addSubnet(base, Number(bits), type);
  }
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

function checkPassword(password: string): void {
  if (password.length < 12 || password.length > 1024) {
    throw new UnprocessableError('Use a password of at least 12 characters.');
  }
}

/** Subject id that service credential sessions act as in logs and tenant context. */
export function credentialSubject(id: string): string {
  return `svc:${id}`;
}

export class ServiceCredentials {
  private readonly platform: Platform;
  /** Bound to the request tenant. */
  private readonly db: SqlClient;
  /** Every tenant, for finding a credential by username at login. */
  private readonly all: SqlClient;
  private readonly hasher = createScryptHasher();

  constructor(platform: Platform) {
    this.platform = platform;
    this.db = tenantClient(platform);
    this.all = scopedClient(platform, ALL_TENANTS_SCOPE);
  }

  async list(): Promise<ServiceCredential[]> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_service_credentials WHERE tenant_id = $1 ORDER BY created_at`,
      [requireTenantId(this.platform)],
    );
    return result.rows.map(toCredential);
  }

  async get(id: string): Promise<ServiceCredential> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_service_credentials WHERE id = $1 AND tenant_id = $2`,
      [id, requireTenantId(this.platform)],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Credential not found');
    return toCredential(row);
  }

  /** Checks that every grant names a mailbox of this tenant and allows something. */
  private async checkGrants(grants: MailboxGrant[]): Promise<MailboxGrant[]> {
    const out: MailboxGrant[] = [];
    for (const grant of grants) {
      await this.platform.directory.getMailbox(grant.mailboxId);
      if (!grant.read && !grant.write && !grant.send) continue;
      if (out.some((item) => item.mailboxId === grant.mailboxId)) {
        throw new UnprocessableError('Each mailbox can be listed only once.');
      }
      // Changing a mailbox over IMAP needs reading it.
      out.push({ ...grant, read: grant.read || grant.write });
    }
    if (out.length === 0) throw new UnprocessableError('Give the credential at least one mailbox.');
    if (out.length > 200) throw new UnprocessableError('Use at most 200 mailboxes.');
    return out;
  }

  /** Creates a credential and returns it with its password, which is shown only once. */
  async create(
    input: CredentialInput,
    actor: Actor,
  ): Promise<{ credential: ServiceCredential; password: string }> {
    const tenantId = requireTenantId(this.platform);
    const password = input.password ?? generatePassword();
    checkPassword(password);
    let username: string;
    let name: string;
    let grants: MailboxGrant[];
    if (input.kind === 'mailbox') {
      const mailbox = await this.platform.directory.getMailbox(input.mailboxId ?? '');
      if (mailbox.kind !== 'shared') {
        throw new UnprocessableError(
          'Only shared mailboxes sign in with their own address. People sign in with their account.',
        );
      }
      if (await this.platform.users.findUserByEmail(mailbox.primaryAddress)) {
        throw new ConflictError(
          `An account already signs in as ${mailbox.primaryAddress}, so the mailbox cannot.`,
        );
      }
      await this.removeOrphanedLogin(mailbox);
      username = mailbox.primaryAddress;
      name = input.name?.trim() || mailbox.primaryAddress;
      grants = [{ mailboxId: mailbox.id, read: true, write: true, send: true }];
    } else {
      username = `svc-${randomBytes(6).toString('hex')}`;
      name = input.name?.trim() || username;
      grants = await this.checkGrants(input.grants ?? []);
    }
    const now = Date.now();
    const credential: ServiceCredential = {
      id: randomUUID(),
      tenantId,
      kind: input.kind,
      name: name.slice(0, 120),
      username,
      grants,
      allowedIps: normaliseAllowlist(input.allowedIps ?? []),
      enabled: true,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdBy: actor.id,
      createdAt: now,
      updatedAt: now,
    };
    const secretHash = await this.hasher.hash(password);
    try {
      // A savepoint keeps the request transaction usable when the username is taken.
      await this.platform.db.transaction(() =>
        this.db.query(
          `INSERT INTO aspectenant_service_credentials (id, tenant_id, kind, name, username,
            secret_hash, grants, allowed_ips, enabled, expires_at, last_used_at, last_used_ip,
            created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, NULL, NULL, $10, $11, $11)`,
          [
            credential.id,
            tenantId,
            credential.kind,
            credential.name,
            username,
            secretHash,
            JSON.stringify(grants),
            JSON.stringify(credential.allowedIps),
            credential.expiresAt,
            actor.id,
            now,
          ],
        ),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(`${username} already has a login.`);
      throw error;
    }
    await this.audit('mail.credential.created', credential, actor, {
      after: this.summary(credential),
    });
    return { credential, password };
  }

  /** A mailbox login left behind by a deleted mailbox would block the address forever. */
  private async removeOrphanedLogin(mailbox: DirectoryMailbox): Promise<void> {
    const result = await this.db.query(
      `SELECT * FROM aspectenant_service_credentials WHERE username = $1 AND tenant_id = $2`,
      [mailbox.primaryAddress, mailbox.tenantId],
    );
    const row = result.rows[0];
    if (!row) return;
    const existing = toCredential(row);
    if (existing.grants.some((grant) => grant.mailboxId === mailbox.id)) return;
    await this.db.query(`DELETE FROM aspectenant_service_credentials WHERE id = $1`, [existing.id]);
  }

  async update(id: string, patch: CredentialPatch, actor: Actor): Promise<ServiceCredential> {
    const before = await this.get(id);
    if (patch.grants && before.kind === 'mailbox') {
      throw new UnprocessableError('A shared mailbox login always has full access to its mailbox.');
    }
    const next: ServiceCredential = {
      ...before,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || before.name } : {}),
      ...(patch.grants ? { grants: await this.checkGrants(patch.grants) } : {}),
      ...(patch.allowedIps ? { allowedIps: normaliseAllowlist(patch.allowedIps) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      updatedAt: Date.now(),
    };
    await this.db.query(
      `UPDATE aspectenant_service_credentials SET name = $1, grants = $2, allowed_ips = $3,
        enabled = $4, expires_at = $5, updated_at = $6 WHERE id = $7 AND tenant_id = $8`,
      [
        next.name,
        JSON.stringify(next.grants),
        JSON.stringify(next.allowedIps),
        next.enabled ? 1 : 0,
        next.expiresAt,
        next.updatedAt,
        id,
        before.tenantId,
      ],
    );
    await this.audit('mail.credential.updated', next, actor, {
      before: this.summary(before),
      after: this.summary(next),
    });
    return next;
  }

  /** Replaces the password and returns the new one, shown only once. */
  async rotate(id: string, actor: Actor, password?: string): Promise<string> {
    const credential = await this.get(id);
    const secret = password ?? generatePassword();
    checkPassword(secret);
    await this.db.query(
      `UPDATE aspectenant_service_credentials SET secret_hash = $1, updated_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [await this.hasher.hash(secret), Date.now(), id, credential.tenantId],
    );
    await this.audit('mail.credential.rotated', credential, actor);
    return secret;
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const credential = await this.get(id);
    await this.db.query(
      `DELETE FROM aspectenant_service_credentials WHERE id = $1 AND tenant_id = $2`,
      [id, credential.tenantId],
    );
    await this.audit('mail.credential.deleted', credential, actor, {
      before: this.summary(credential),
    });
  }

  /**
   * Checks a mail app login against service credentials. Returns null when no credential has
   * this username, so the caller falls back to account logins.
   */
  async authenticate(
    username: string,
    password: string,
    ip: string,
  ): Promise<CredentialCheck | null> {
    const result = await this.all.query(
      `SELECT * FROM aspectenant_service_credentials WHERE username = $1`,
      [username],
    );
    const row = result.rows[0];
    if (!row) return null;
    const credential = toCredential(row);
    const hash = String(row.secret_hash);
    if (!(await this.hasher.verify(hash, password))) return { failure: 'wrong password' };
    if (!credential.enabled) return { failure: 'credential is disabled' };
    if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) {
      return { failure: 'credential has expired' };
    }
    if (!ipAllowed(credential.allowedIps, ip)) {
      return { failure: `address ${plainIp(ip)} is not on the credential's allowlist` };
    }
    const org = await this.platform.orgs.findOrg(credential.tenantId);
    if (org?.status !== 'active') return { failure: 'organisation is not active' };
    const subject = credentialSubject(credential.id);
    const reachable = await withSystemTenant(
      this.platform,
      credential.tenantId,
      async () => {
        const out: MailboxGrant[] = [];
        for (const grant of credential.grants) {
          const mailbox = await this.platform.directory
            .getMailbox(grant.mailboxId)
            .catch(() => null);
          if (mailbox) out.push(grant);
        }
        await this.all.query(
          `UPDATE aspectenant_service_credentials SET last_used_at = $1, last_used_ip = $2
           WHERE id = $3`,
          [Date.now(), plainIp(ip), credential.id],
        );
        return out;
      },
      subject,
    );
    if (reachable.length === 0) return { failure: 'credential has no mailbox left' };
    return { login: { accountId: subject, tenantId: credential.tenantId, grants: reachable } };
  }

  /** Addresses a credential may send as: each mailbox with the send grant, with its aliases. */
  async sendableAddresses(grants: MailboxGrant[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const grant of grants) {
      if (!grant.send) continue;
      const mailbox = await this.platform.directory.getMailbox(grant.mailboxId).catch(() => null);
      if (!mailbox) continue;
      out.add(mailbox.primaryAddress);
      for (const alias of mailbox.aliases) out.add(alias);
    }
    return out;
  }

  private summary(credential: ServiceCredential) {
    return {
      kind: credential.kind,
      name: credential.name,
      username: credential.username,
      grants: credential.grants,
      allowedIps: credential.allowedIps,
      enabled: credential.enabled,
      expiresAt: credential.expiresAt,
    };
  }

  private async audit(
    action: string,
    credential: ServiceCredential,
    actor: Actor,
    changes?: { before?: unknown; after?: unknown },
  ): Promise<void> {
    await this.platform.audit.record({
      action,
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'service-credential', id: credential.id },
      tenantId: credential.tenantId,
      ...(changes ? { changes } : {}),
    });
  }
}
