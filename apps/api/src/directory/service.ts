import { randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import type { Platform } from '../platform.js';
import { DirectoryStore } from './store.js';
import type {
  DirectoryApplication,
  DirectoryCounts,
  DirectoryDomain,
  DirectoryGroup,
  DirectoryGroupMember,
  DirectoryMailbox,
  GroupKind,
  MailboxKind,
} from './types.js';

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** DNS label under the domain where the ownership TXT record is published. */
export const VERIFICATION_LABEL = '_aspectenant';
export const VERIFICATION_PREFIX = 'aspectenant-verification=';

export interface DomainVerificationRecord {
  type: 'TXT';
  name: string;
  value: string;
}

export function verificationRecord(domain: DirectoryDomain): DomainVerificationRecord {
  return {
    type: 'TXT',
    name: `${VERIFICATION_LABEL}.${domain.hostname}`,
    value: `${VERIFICATION_PREFIX}${domain.verificationToken}`,
  };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'group';
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normaliseHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/** PostgreSQL 23505 or SQLite UNIQUE constraint failure. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

export class DirectoryService {
  readonly store: DirectoryStore;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = new DirectoryStore(platform.db);
  }

  /** Tenant bound to the current request. Directory data is never read without one. */
  tenantId(): string {
    const ctx = this.platform.orgs.currentTenant();
    if (!ctx) throw new ForbiddenError('You are not an active member of this organisation.');
    return ctx.orgId;
  }

  private async audit(
    actor: Actor,
    action: string,
    resource: { type: string; id: string },
    changes?: { before?: unknown; after?: unknown },
  ): Promise<void> {
    await this.platform.audit.record({
      action,
      outcome: 'success',
      category: 'admin',
      actor,
      resource,
      tenantId: this.tenantId(),
      ...(changes ? { changes } : {}),
    });
  }

  /** Runs a write that may hit a unique index inside a savepoint so the request transaction survives. */
  private async guardUnique<T>(message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.platform.db.transaction(() => fn());
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(message);
      throw error;
    }
  }

  private async requireMember(tenantId: string, userId: string): Promise<void> {
    const membership = await this.platform.orgs.getMembership(tenantId, userId);
    if (!membership || membership.status === 'removed' || membership.status === 'invited') {
      throw new NotFoundError('User not found');
    }
  }

  async counts(): Promise<DirectoryCounts> {
    return this.store.counts(this.tenantId());
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    return this.store.listGroups(this.tenantId());
  }

  async getGroup(id: string): Promise<DirectoryGroup> {
    const group = await this.store.getGroup(this.tenantId(), id);
    if (!group) throw new NotFoundError('Group not found');
    return group;
  }

  async createGroup(
    input: { name: string; kind: GroupKind; description?: string },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = this.tenantId();
    const name = input.name.trim();
    if (!name) throw new UnprocessableError('Group name is required');
    let slug = slugify(name);
    if (await this.store.findGroupBySlug(tenantId, slug)) {
      slug = `${slug}-${randomBytes(3).toString('hex')}`;
    }
    const group = await this.store.insertGroup({
      tenantId,
      name,
      slug,
      kind: input.kind,
      description: input.description?.trim() ? input.description.trim() : null,
    });
    await this.audit(
      actor,
      'directory.group.created',
      { type: 'group', id: group.id },
      {
        after: group,
      },
    );
    return group;
  }

  async updateGroup(
    id: string,
    patch: { name?: string; description?: string | null; kind?: GroupKind },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = this.tenantId();
    const updated = await this.store.updateGroup(tenantId, id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description === null ? null : patch.description.trim() || null }
        : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    });
    if (!updated) throw new NotFoundError('Group not found');
    await this.audit(actor, 'directory.group.updated', { type: 'group', id }, { after: updated });
    return updated;
  }

  async deleteGroup(id: string, actor: Actor): Promise<void> {
    const tenantId = this.tenantId();
    const current = await this.store.getGroup(tenantId, id);
    if (!current) throw new NotFoundError('Group not found');
    await this.store.deleteGroup(tenantId, id);
    await this.audit(actor, 'directory.group.deleted', { type: 'group', id }, { before: current });
  }

  async listGroupMembers(id: string): Promise<DirectoryGroupMember[]> {
    await this.getGroup(id);
    return this.store.listGroupMembers(this.tenantId(), id);
  }

  async addGroupMember(
    groupId: string,
    userId: string,
    actor: Actor,
  ): Promise<DirectoryGroupMember> {
    const tenantId = this.tenantId();
    await this.getGroup(groupId);
    await this.requireMember(tenantId, userId);
    if (await this.store.hasGroupMember(tenantId, groupId, userId)) {
      throw new ConflictError('That user is already a member of this group.');
    }
    const member = await this.store.addGroupMember(tenantId, groupId, userId);
    await this.audit(
      actor,
      'directory.group.member_added',
      { type: 'group', id: groupId },
      {
        after: { userId },
      },
    );
    return member;
  }

  async removeGroupMember(groupId: string, userId: string, actor: Actor): Promise<void> {
    const tenantId = this.tenantId();
    await this.getGroup(groupId);
    const removed = await this.store.removeGroupMember(tenantId, groupId, userId);
    if (!removed) throw new NotFoundError('Group member not found');
    await this.audit(
      actor,
      'directory.group.member_removed',
      { type: 'group', id: groupId },
      {
        before: { userId },
      },
    );
  }

  async listDomains(): Promise<DirectoryDomain[]> {
    return this.store.listDomains(this.tenantId());
  }

  async createDomain(
    input: { hostname: string; primary?: boolean },
    actor: Actor,
  ): Promise<DirectoryDomain> {
    const tenantId = this.tenantId();
    const hostname = normaliseHostname(input.hostname);
    if (!HOSTNAME.test(hostname)) {
      throw new UnprocessableError(
        'Enter a fully qualified domain name, for example mail.example.com.',
      );
    }
    if (await this.store.findDomainByHostname(tenantId, hostname)) {
      throw new ConflictError('That domain is already registered.');
    }
    const owner = await this.store.findVerifiedDomain(hostname);
    if (owner && owner.tenantId !== tenantId) {
      throw new ConflictError('That domain is verified by another organisation.');
    }
    const existing = await this.store.listDomains(tenantId);
    const primary = input.primary === true || existing.length === 0;
    if (primary) await this.store.clearPrimaryDomain(tenantId);
    const domain = await this.store.insertDomain({
      tenantId,
      hostname,
      primary,
      verificationToken: randomBytes(16).toString('hex'),
    });
    await this.audit(
      actor,
      'directory.domain.created',
      { type: 'domain', id: domain.id },
      {
        after: domain,
      },
    );
    return domain;
  }

  /** Verifies ownership by looking up the tenant's TXT record in public DNS. */
  async verifyDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    const tenantId = this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    if (current.status === 'verified') return current;
    const record = verificationRecord(current);
    let values: string[];
    try {
      values = (await this.platform.resolveTxt(record.name)).map((chunks) => chunks.join(''));
    } catch {
      values = [];
    }
    if (!values.some((value) => value.trim() === record.value)) {
      await this.platform.audit.record({
        action: 'directory.domain.verification_failed',
        outcome: 'failure',
        category: 'admin',
        actor,
        resource: { type: 'domain', id },
        tenantId,
      });
      throw new UnprocessableError(
        `DNS verification failed. Publish a TXT record named ${record.name} with the value ${record.value}, wait for DNS to update, then try again.`,
      );
    }
    return this.markVerified(current, actor, 'dns');
  }

  /** Marks a domain verified without DNS. Platform operators only; checked by the route. */
  async confirmDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    const tenantId = this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    if (current.status === 'verified') return current;
    return this.markVerified(current, actor, 'operator');
  }

  private async markVerified(
    current: DirectoryDomain,
    actor: Actor,
    method: 'dns' | 'operator',
  ): Promise<DirectoryDomain> {
    const owner = await this.store.findVerifiedDomain(current.hostname);
    if (owner && owner.tenantId !== current.tenantId) {
      throw new ConflictError('That domain is verified by another organisation.');
    }
    const updated = await this.guardUnique('That domain is verified by another organisation.', () =>
      this.store.updateDomain(current.tenantId, current.id, {
        status: 'verified',
        verifiedAt: Date.now(),
      }),
    );
    if (!updated) throw new NotFoundError('Domain not found');
    await this.audit(
      actor,
      'directory.domain.verified',
      { type: 'domain', id: current.id },
      {
        after: { ...updated, method },
      },
    );
    return updated;
  }

  async setPrimaryDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    const tenantId = this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    await this.store.clearPrimaryDomain(tenantId);
    const updated = await this.store.updateDomain(tenantId, id, { primary: true });
    if (!updated) throw new NotFoundError('Domain not found');
    await this.audit(
      actor,
      'directory.domain.updated',
      { type: 'domain', id },
      {
        after: updated,
      },
    );
    return updated;
  }

  async deleteDomain(id: string, actor: Actor): Promise<void> {
    const tenantId = this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    if ((await this.store.countAddressesOnDomain(tenantId, current.hostname)) > 0) {
      throw new ConflictError(
        'Mailboxes or aliases still use this domain. Remove them before removing the domain.',
      );
    }
    await this.store.deleteDomain(tenantId, id);
    await this.audit(
      actor,
      'directory.domain.deleted',
      { type: 'domain', id },
      {
        before: current,
      },
    );
  }

  /** Address must be on a domain this tenant has verified. */
  private async requireTenantAddress(tenantId: string, address: string): Promise<void> {
    const hostname = domainOf(address);
    const domain = await this.store.findDomainByHostname(tenantId, hostname);
    if (domain?.status !== 'verified') {
      throw new UnprocessableError(
        `The domain ${hostname} is not a verified domain of this organisation. Add and verify it first.`,
      );
    }
  }

  async listMailboxes(): Promise<DirectoryMailbox[]> {
    return this.store.listMailboxes(this.tenantId());
  }

  async getMailbox(id: string): Promise<DirectoryMailbox> {
    const mailbox = await this.store.getMailbox(this.tenantId(), id);
    if (!mailbox) throw new NotFoundError('Mailbox not found');
    return mailbox;
  }

  /**
   * Creates the user's mailbox record when their sign-in address is on a verified domain of
   * this tenant. Returns null (and creates nothing) otherwise.
   */
  async provisionUserMailbox(
    userId: string,
    primaryAddress: string,
    displayName: string | null,
    actor?: Actor,
  ): Promise<DirectoryMailbox | null> {
    const tenantId = this.tenantId();
    const existing = await this.store.findMailboxByUser(tenantId, userId);
    if (existing) return existing;
    const address = normaliseEmail(primaryAddress);
    const domain = await this.store.findDomainByHostname(tenantId, domainOf(address));
    if (domain?.status !== 'verified') return null;
    if (await this.store.findMailboxByAddress(tenantId, address)) return null;
    return this.createMailbox(
      {
        kind: 'user',
        userId,
        primaryAddress: address,
        ...(displayName ? { displayName } : {}),
      },
      actor,
    );
  }

  async createMailbox(
    input: {
      kind: MailboxKind;
      primaryAddress: string;
      userId?: string;
      displayName?: string;
      quotaBytes?: number;
    },
    actor?: Actor,
  ): Promise<DirectoryMailbox> {
    const tenantId = this.tenantId();
    const primaryAddress = normaliseEmail(input.primaryAddress);
    if (!EMAIL.test(primaryAddress)) throw new UnprocessableError('Enter a valid mailbox address.');
    await this.requireTenantAddress(tenantId, primaryAddress);
    if (input.kind === 'user') {
      if (!input.userId) throw new UnprocessableError('A user mailbox must be linked to a user.');
      await this.requireMember(tenantId, input.userId);
      if (await this.store.findMailboxByUser(tenantId, input.userId)) {
        throw new ConflictError('That user already has a mailbox.');
      }
    }
    if (await this.store.findMailboxByAddress(tenantId, primaryAddress)) {
      throw new ConflictError('That mailbox address is already in use.');
    }
    const mailbox = await this.guardUnique('That mailbox address is already in use.', () =>
      this.store.insertMailbox({
        tenantId,
        userId: input.kind === 'user' ? (input.userId ?? null) : null,
        primaryAddress,
        kind: input.kind,
        displayName: input.displayName?.trim() ? input.displayName.trim() : null,
        quotaBytes: input.quotaBytes ?? null,
      }),
    );
    if (actor) {
      await this.audit(
        actor,
        'directory.mailbox.created',
        { type: 'mailbox', id: mailbox.id },
        {
          after: mailbox,
        },
      );
    }
    return mailbox;
  }

  async updateMailbox(
    id: string,
    patch: { displayName?: string | null; quotaBytes?: number | null },
    actor: Actor,
  ): Promise<DirectoryMailbox> {
    const tenantId = this.tenantId();
    const updated = await this.store.updateMailbox(tenantId, id, patch);
    if (!updated) throw new NotFoundError('Mailbox not found');
    await this.audit(
      actor,
      'directory.mailbox.updated',
      { type: 'mailbox', id },
      {
        after: updated,
      },
    );
    return updated;
  }

  async deleteMailbox(id: string, actor: Actor): Promise<void> {
    const tenantId = this.tenantId();
    const current = await this.store.getMailbox(tenantId, id);
    if (!current) throw new NotFoundError('Mailbox not found');
    await this.store.deleteMailbox(tenantId, id);
    await this.audit(
      actor,
      'directory.mailbox.deleted',
      { type: 'mailbox', id },
      {
        before: current,
      },
    );
  }

  async addAlias(mailboxId: string, alias: string, actor: Actor): Promise<DirectoryMailbox> {
    const tenantId = this.tenantId();
    const mailbox = await this.store.getMailbox(tenantId, mailboxId);
    if (!mailbox) throw new NotFoundError('Mailbox not found');
    const address = normaliseEmail(alias);
    if (!EMAIL.test(address)) throw new UnprocessableError('Enter a valid alias address.');
    await this.requireTenantAddress(tenantId, address);
    if (await this.store.findMailboxByAddress(tenantId, address)) {
      throw new ConflictError('That address is already in use.');
    }
    await this.guardUnique('That address is already in use.', () =>
      this.store.addAlias(tenantId, mailboxId, address),
    );
    const updated = await this.getMailbox(mailboxId);
    await this.audit(
      actor,
      'directory.mailbox.alias_added',
      { type: 'mailbox', id: mailboxId },
      {
        after: { alias: address },
      },
    );
    return updated;
  }

  async removeAlias(mailboxId: string, alias: string, actor: Actor): Promise<DirectoryMailbox> {
    const tenantId = this.tenantId();
    await this.getMailbox(mailboxId);
    const removed = await this.store.removeAlias(tenantId, mailboxId, normaliseEmail(alias));
    if (!removed) throw new NotFoundError('Alias not found');
    const updated = await this.getMailbox(mailboxId);
    await this.audit(
      actor,
      'directory.mailbox.alias_removed',
      { type: 'mailbox', id: mailboxId },
      {
        before: { alias },
      },
    );
    return updated;
  }

  /** Ends a user's presence in this tenant's directory: group memberships and user mailbox link. */
  async detachUser(userId: string): Promise<void> {
    const tenantId = this.tenantId();
    await this.store.removeUserFromGroups(tenantId, userId);
  }

  async listApplications(): Promise<DirectoryApplication[]> {
    return this.store.listApplications(this.tenantId());
  }

  async createApplication(
    input: { name: string; redirectUris: string[] },
    actor: Actor,
  ): Promise<DirectoryApplication> {
    const tenantId = this.tenantId();
    const name = input.name.trim();
    if (!name) throw new UnprocessableError('Application name is required');
    const redirectUris = uniqueRedirects(input.redirectUris);
    const application = await this.store.insertApplication({
      tenantId,
      name,
      clientId: `at_${randomBytes(16).toString('hex')}`,
      redirectUris,
    });
    await this.audit(
      actor,
      'directory.application.created',
      { type: 'application', id: application.id },
      { after: application },
    );
    return application;
  }

  async updateApplication(
    id: string,
    patch: { name?: string; redirectUris?: string[] },
    actor: Actor,
  ): Promise<DirectoryApplication> {
    const tenantId = this.tenantId();
    const updated = await this.store.updateApplication(tenantId, id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.redirectUris !== undefined
        ? { redirectUris: uniqueRedirects(patch.redirectUris) }
        : {}),
    });
    if (!updated) throw new NotFoundError('Application not found');
    await this.audit(
      actor,
      'directory.application.updated',
      { type: 'application', id },
      {
        after: updated,
      },
    );
    return updated;
  }

  async deleteApplication(id: string, actor: Actor): Promise<void> {
    const tenantId = this.tenantId();
    const current = await this.store.getApplication(tenantId, id);
    if (!current) throw new NotFoundError('Application not found');
    await this.store.deleteApplication(tenantId, id);
    await this.audit(
      actor,
      'directory.application.deleted',
      { type: 'application', id },
      {
        before: current,
      },
    );
  }
}

function uniqueRedirects(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new UnprocessableError(`Invalid redirect URI: ${trimmed}`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new UnprocessableError('Redirect URIs must use http or https.');
    }
    if (
      parsed.protocol === 'http:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      throw new UnprocessableError('HTTP redirect URIs are only allowed for localhost.');
    }
    if (!seen.has(parsed.href)) {
      seen.add(parsed.href);
      out.push(parsed.href);
    }
  }
  if (out.length === 0) throw new UnprocessableError('At least one redirect URI is required.');
  return out;
}
