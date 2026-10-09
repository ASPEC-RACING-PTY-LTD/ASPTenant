import { randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import type { Platform } from '../platform.js';
import { tenantClient } from '../tenancy.js';
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

/** PostgreSQL 23505 or SQLite UNIQUE constraint failure. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

/** Tenant bound to the current request, job or mail session. */
export function requireTenantId(platform: Platform): string {
  const ctx = platform.orgs.currentTenant();
  if (!ctx) throw new ForbiddenError('You are not an active member of this organisation.');
  return ctx.orgId;
}

async function audit(
  platform: Platform,
  actor: Actor,
  action: string,
  resource: { type: string; id: string },
  changes?: { before?: unknown; after?: unknown },
): Promise<void> {
  await platform.audit.record({
    action,
    outcome: 'success',
    category: 'admin',
    actor,
    resource,
    tenantId: requireTenantId(platform),
    ...(changes ? { changes } : {}),
  });
}

export class DirectoryService {
  readonly store: DirectoryStore;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = new DirectoryStore(tenantClient(platform));
  }

  /** Tenant bound to the current request. Directory data is never read without one. */
  async tenantId(): Promise<string> {
    return requireTenantId(this.platform);
  }

  /** Runs a write that may hit a unique index inside a savepoint so the transaction survives. */
  private async guardUnique<T>(message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.platform.db.transaction(() => fn());
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError(message);
      throw error;
    }
  }

  /** Users of other tenants are reported as not found so their existence is not disclosed. */
  private async requireMember(tenantId: string, userId: string): Promise<void> {
    const membership = await this.platform.orgs.getMembership(tenantId, userId);
    if (!membership || membership.status === 'removed' || membership.status === 'invited') {
      throw new NotFoundError('User not found');
    }
  }

  /** The domain of an address must be a domain this tenant has verified. */
  private async requireVerifiedDomain(tenantId: string, domain: string): Promise<void> {
    const found = await this.store.findDomainByHostname(tenantId, domain);
    if (!found) {
      throw new UnprocessableError(
        `${domain} is not one of your domains. Add it on the Domains page first.`,
      );
    }
    if (found.status !== 'verified') {
      throw new UnprocessableError(
        `${domain} is not verified yet. Verify it on the Domains page before using it for mail.`,
      );
    }
  }

  async counts(): Promise<DirectoryCounts> {
    return this.store.counts(await this.tenantId());
  }

  /** Validates that an address is well formed, on a registered domain and unused. */
  async claimAddress(tenantId: string, value: string): Promise<string> {
    const address = normaliseEmail(value);
    if (!EMAIL.test(address)) throw new UnprocessableError('Enter a valid email address.');
    const domain = address.split('@')[1] ?? '';
    await this.requireVerifiedDomain(tenantId, domain);
    if (
      (await this.store.findMailboxByAddress(tenantId, address)) ||
      (await this.store.findGroupByEmail(tenantId, address))
    ) {
      throw new ConflictError('That address is already in use.');
    }
    return address;
  }

  /** True when the address is on a domain this tenant has verified. */
  async isOwnedDomain(address: string): Promise<boolean> {
    const domain = normaliseEmail(address).split('@')[1] ?? '';
    const found = await this.store.findDomainByHostname(await this.tenantId(), domain);
    return found?.status === 'verified';
  }

  async findGroupByEmail(address: string): Promise<DirectoryGroup | null> {
    return this.store.findGroupByEmail(await this.tenantId(), normaliseEmail(address));
  }

  async findMailboxByAddress(address: string): Promise<DirectoryMailbox | null> {
    return this.store.findMailboxByAddress(await this.tenantId(), normaliseEmail(address));
  }

  domainVerification(domain: DirectoryDomain): { name: string; value: string } {
    return {
      name: domain.hostname,
      value: `aspectenant-verification=${this.platform.secrets.derive(`domain:${domain.id}`)}`,
    };
  }

  async domainDns(id: string): Promise<{
    verification: { name: string; value: string; found: boolean };
    mx: { exchange: string; priority: number }[];
    mxOnCloudflare: boolean;
    spf: string | null;
    spfIncludesCloudflare: boolean;
    dmarc: string | null;
  }> {
    const domain = await this.store.getDomain(await this.tenantId(), id);
    if (!domain) throw new NotFoundError('Domain not found');
    const dns = this.platform.dns;
    const resolveMx = (name: string) => dns.resolveMx(name);
    const txt = async (name: string) => {
      try {
        return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
      } catch {
        return [];
      }
    };
    const [rootTxt, dmarcTxt, mx] = await Promise.all([
      txt(domain.hostname),
      txt(`_dmarc.${domain.hostname}`),
      resolveMx(domain.hostname).catch(() => []),
    ]);
    const verification = this.domainVerification(domain);
    const spf = rootTxt.find((value) => value.toLowerCase().startsWith('v=spf1')) ?? null;
    return {
      verification: { ...verification, found: rootTxt.includes(verification.value) },
      mx: mx.map((record) => ({ exchange: record.exchange, priority: record.priority })),
      mxOnCloudflare: mx.some((record) => record.exchange.endsWith('mx.cloudflare.net')),
      spf,
      spfIncludesCloudflare: spf?.includes('_spf.mx.cloudflare.net') ?? false,
      dmarc: dmarcTxt.find((value) => value.toLowerCase().startsWith('v=dmarc1')) ?? null,
    };
  }

  async listMailboxMembers(mailboxId: string) {
    await this.getMailbox(mailboxId);
    const members = await this.store.listMailboxMembers(await this.tenantId(), mailboxId);
    return Promise.all(
      members.map(async (member) => {
        const user = await this.platform.users.findUser(member.userId);
        return {
          ...member,
          email: user?.email ?? null,
          displayName: user?.profile.displayName ?? null,
        };
      }),
    );
  }

  async addMailboxMember(mailboxId: string, userId: string, actor: Actor): Promise<void> {
    const mailbox = await this.getMailbox(mailboxId);
    if (mailbox.userId === userId) throw new ConflictError('That user already owns this mailbox.');
    await this.requireMember(mailbox.tenantId, userId);
    const existing = await this.store.listMailboxMembers(mailbox.tenantId, mailboxId);
    if (existing.some((member) => member.userId === userId)) {
      throw new ConflictError('That user already has access.');
    }
    await this.store.addMailboxMember(await this.tenantId(), mailboxId, userId);
    await audit(
      this.platform,
      actor,
      'directory.mailbox.member_added',
      {
        type: 'mailbox',
        id: mailboxId,
      },
      { after: { userId } },
    );
  }

  async removeMailboxMember(mailboxId: string, userId: string, actor: Actor): Promise<void> {
    await this.getMailbox(mailboxId);
    if (!(await this.store.removeMailboxMember(await this.tenantId(), mailboxId, userId))) {
      throw new NotFoundError('Member not found');
    }
    await audit(
      this.platform,
      actor,
      'directory.mailbox.member_removed',
      {
        type: 'mailbox',
        id: mailboxId,
      },
      { before: { userId } },
    );
  }

  async listAccessibleMailboxes(userId: string): Promise<DirectoryMailbox[]> {
    return this.store.listAccessibleMailboxes(await this.tenantId(), userId);
  }

  async listGroups(): Promise<DirectoryGroup[]> {
    return this.store.listGroups(await this.tenantId());
  }

  async getGroup(id: string): Promise<DirectoryGroup> {
    const group = await this.store.getGroup(await this.tenantId(), id);
    if (!group) throw new NotFoundError('Group not found');
    return group;
  }

  async createGroup(
    input: { name: string; kind: GroupKind; description?: string; email?: string | null },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = await this.tenantId();
    const email = input.email ? await this.claimAddress(tenantId, input.email) : null;
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
      email,
      description: input.description?.trim() ? input.description.trim() : null,
    });
    await audit(
      this.platform,
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
    patch: { name?: string; description?: string | null; kind?: GroupKind; email?: string | null },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = await this.tenantId();
    let email: string | null | undefined;
    if (patch.email !== undefined) {
      const current = await this.getGroup(id);
      const wanted = patch.email ? normaliseEmail(patch.email) : null;
      email =
        wanted && wanted !== current.email ? await this.claimAddress(tenantId, wanted) : wanted;
    }
    const updated = await this.store.updateGroup(tenantId, id, {
      ...(email !== undefined ? { email } : {}),
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description === null ? null : patch.description.trim() || null }
        : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    });
    if (!updated) throw new NotFoundError('Group not found');
    await audit(
      this.platform,
      actor,
      'directory.group.updated',
      { type: 'group', id },
      {
        after: updated,
      },
    );
    return updated;
  }

  async deleteGroup(id: string, actor: Actor): Promise<void> {
    const tenantId = await this.tenantId();
    const current = await this.store.getGroup(tenantId, id);
    if (!current) throw new NotFoundError('Group not found');
    await this.store.deleteGroup(tenantId, id);
    await audit(
      this.platform,
      actor,
      'directory.group.deleted',
      { type: 'group', id },
      {
        before: current,
      },
    );
  }

  async listGroupMembers(id: string): Promise<DirectoryGroupMember[]> {
    await this.getGroup(id);
    return this.store.listGroupMembers(await this.tenantId(), id);
  }

  async addGroupMember(
    groupId: string,
    userId: string,
    actor: Actor,
  ): Promise<DirectoryGroupMember> {
    const tenantId = await this.tenantId();
    await this.getGroup(groupId);
    await this.requireMember(tenantId, userId);
    if (await this.store.hasGroupMember(tenantId, groupId, userId)) {
      throw new ConflictError('That user is already a member of this group.');
    }
    const member = await this.store.addGroupMember(tenantId, groupId, userId);
    await audit(
      this.platform,
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
    await this.getGroup(groupId);
    const removed = await this.store.removeGroupMember(await this.tenantId(), groupId, userId);
    if (!removed) throw new NotFoundError('Group member not found');
    await audit(
      this.platform,
      actor,
      'directory.group.member_removed',
      { type: 'group', id: groupId },
      { before: { userId } },
    );
  }

  async listDomains(): Promise<DirectoryDomain[]> {
    return this.store.listDomains(await this.tenantId());
  }

  async createDomain(
    input: { hostname: string; primary?: boolean },
    actor: Actor,
  ): Promise<DirectoryDomain> {
    const tenantId = await this.tenantId();
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
    const domain = await this.store.insertDomain({ tenantId, hostname, primary });
    await audit(
      this.platform,
      actor,
      'directory.domain.created',
      { type: 'domain', id: domain.id },
      {
        after: domain,
      },
    );
    return domain;
  }

  async verifyDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    const tenantId = await this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    const dns = await this.domainDns(id);
    if (!dns.verification.found) {
      throw new UnprocessableError(
        `TXT record not found yet. Add ${dns.verification.value} as a TXT record on ${dns.verification.name}, wait a few minutes for DNS to update, then try again.`,
      );
    }
    return this.markVerified(id, actor, 'dns-txt');
  }

  /**
   * Marks a domain verified. A hostname can be verified by one tenant only: the check below
   * covers what this connection can see, the partial unique index covers the rest.
   */
  async markVerified(id: string, actor: Actor, method: string): Promise<DirectoryDomain> {
    const tenantId = await this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    if (current.status === 'verified') return current;
    const owner = await this.store.findVerifiedDomain(current.hostname);
    if (owner && owner.tenantId !== tenantId) {
      throw new ConflictError('That domain is verified by another organisation.');
    }
    const updated = await this.guardUnique('That domain is verified by another organisation.', () =>
      this.store.updateDomain(tenantId, id, {
        status: 'verified',
        verifiedAt: Date.now(),
      }),
    );
    if (!updated) throw new NotFoundError('Domain not found');
    await audit(
      this.platform,
      actor,
      'directory.domain.verified',
      { type: 'domain', id },
      { after: { ...updated, method } },
    );
    return updated;
  }

  /** Marks a domain verified without DNS. Platform operators only; checked by the route. */
  async confirmDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    return this.markVerified(id, actor, 'operator');
  }

  /** Ends a user's presence in this tenant: group memberships and mailbox delegations. */
  async detachUser(userId: string): Promise<void> {
    await this.store.detachUser(await this.tenantId(), userId);
  }

  async setPrimaryDomain(id: string, actor: Actor): Promise<DirectoryDomain> {
    const tenantId = await this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    await this.store.clearPrimaryDomain(tenantId);
    const updated = await this.store.updateDomain(tenantId, id, { primary: true });
    if (!updated) throw new NotFoundError('Domain not found');
    await audit(
      this.platform,
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
    const tenantId = await this.tenantId();
    const current = await this.store.getDomain(tenantId, id);
    if (!current) throw new NotFoundError('Domain not found');
    if ((await this.store.countAddressesOnDomain(tenantId, current.hostname)) > 0) {
      throw new ConflictError(
        'Mailboxes, aliases or groups still use this domain. Remove them before removing the domain.',
      );
    }
    await this.store.deleteDomain(tenantId, id);
    await audit(
      this.platform,
      actor,
      'directory.domain.deleted',
      { type: 'domain', id },
      {
        before: current,
      },
    );
  }

  async listMailboxes(): Promise<DirectoryMailbox[]> {
    return this.store.listMailboxes(await this.tenantId());
  }

  async getMailbox(id: string): Promise<DirectoryMailbox> {
    const mailbox = await this.store.getMailbox(await this.tenantId(), id);
    if (!mailbox) throw new NotFoundError('Mailbox not found');
    return mailbox;
  }

  async provisionUserMailbox(
    userId: string,
    primaryAddress: string,
    displayName: string | null,
    actor?: Actor,
  ): Promise<DirectoryMailbox | null> {
    const tenantId = await this.tenantId();
    const existing = await this.store.findMailboxByUser(tenantId, userId);
    if (existing) return existing;
    if (!(await this.isOwnedDomain(primaryAddress))) return null;
    if (await this.findMailboxByAddress(primaryAddress)) return null;
    return this.createMailbox(
      {
        kind: 'user',
        userId,
        primaryAddress,
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
    const tenantId = await this.tenantId();
    if (input.kind === 'user') {
      if (!input.userId) throw new UnprocessableError('A user mailbox must be linked to a user.');
      await this.requireMember(tenantId, input.userId);
      if (await this.store.findMailboxByUser(tenantId, input.userId)) {
        throw new ConflictError('That user already has a mailbox.');
      }
    }
    const primaryAddress = await this.claimAddress(tenantId, input.primaryAddress);
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
      await audit(
        this.platform,
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
    const tenantId = await this.tenantId();
    const updated = await this.store.updateMailbox(tenantId, id, patch);
    if (!updated) throw new NotFoundError('Mailbox not found');
    await audit(
      this.platform,
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
    const tenantId = await this.tenantId();
    const current = await this.store.getMailbox(tenantId, id);
    if (!current) throw new NotFoundError('Mailbox not found');
    await this.store.deleteMailbox(tenantId, id);
    await audit(
      this.platform,
      actor,
      'directory.mailbox.deleted',
      { type: 'mailbox', id },
      {
        before: current,
      },
    );
  }

  async addAlias(mailboxId: string, alias: string, actor: Actor): Promise<DirectoryMailbox> {
    const tenantId = await this.tenantId();
    const mailbox = await this.store.getMailbox(tenantId, mailboxId);
    if (!mailbox) throw new NotFoundError('Mailbox not found');
    const address = await this.claimAddress(tenantId, alias);
    await this.guardUnique('That address is already in use.', () =>
      this.store.addAlias(tenantId, mailboxId, address),
    );
    const updated = await this.getMailbox(mailboxId);
    await audit(
      this.platform,
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
    await this.getMailbox(mailboxId);
    const removed = await this.store.removeAlias(
      await this.tenantId(),
      mailboxId,
      normaliseEmail(alias),
    );
    if (!removed) throw new NotFoundError('Alias not found');
    const updated = await this.getMailbox(mailboxId);
    await audit(
      this.platform,
      actor,
      'directory.mailbox.alias_removed',
      { type: 'mailbox', id: mailboxId },
      { before: { alias } },
    );
    return updated;
  }

  async listApplications(): Promise<DirectoryApplication[]> {
    return this.store.listApplications(await this.tenantId());
  }

  async createApplication(
    input: { name: string; redirectUris: string[] },
    actor: Actor,
  ): Promise<DirectoryApplication> {
    const tenantId = await this.tenantId();
    const name = input.name.trim();
    if (!name) throw new UnprocessableError('Application name is required');
    const redirectUris = uniqueRedirects(input.redirectUris);
    const application = await this.store.insertApplication({
      tenantId,
      name,
      clientId: `at_${randomBytes(16).toString('hex')}`,
      redirectUris,
    });
    await audit(
      this.platform,
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
    const tenantId = await this.tenantId();
    const updated = await this.store.updateApplication(tenantId, id, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.redirectUris !== undefined
        ? { redirectUris: uniqueRedirects(patch.redirectUris) }
        : {}),
    });
    if (!updated) throw new NotFoundError('Application not found');
    await audit(
      this.platform,
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
    const tenantId = await this.tenantId();
    const current = await this.store.getApplication(tenantId, id);
    if (!current) throw new NotFoundError('Application not found');
    await this.store.deleteApplication(tenantId, id);
    await audit(
      this.platform,
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
