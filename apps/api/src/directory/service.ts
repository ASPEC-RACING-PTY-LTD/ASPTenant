import { randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError, UnprocessableError } from '@aspec/errors';
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
    tenantId: (await platform.orgs.getDefaultOrg()).id,
    ...(changes ? { changes } : {}),
  });
}

export class DirectoryService {
  readonly store: DirectoryStore;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = new DirectoryStore(platform.db);
  }

  async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  async counts(): Promise<DirectoryCounts> {
    return this.store.counts(await this.tenantId());
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
    input: { name: string; kind: GroupKind; description?: string },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = await this.tenantId();
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
    patch: { name?: string; description?: string | null; kind?: GroupKind },
    actor: Actor,
  ): Promise<DirectoryGroup> {
    const tenantId = await this.tenantId();
    const updated = await this.store.updateGroup(tenantId, id, {
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
    return this.store.listGroupMembers(id);
  }

  async addGroupMember(
    groupId: string,
    userId: string,
    actor: Actor,
  ): Promise<DirectoryGroupMember> {
    await this.getGroup(groupId);
    const user = await this.platform.users.findUser(userId);
    if (!user) throw new NotFoundError('User not found');
    if (await this.store.hasGroupMember(groupId, userId)) {
      throw new ConflictError('That user is already a member of this group.');
    }
    const member = await this.store.addGroupMember(groupId, userId);
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
    const removed = await this.store.removeGroupMember(groupId, userId);
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
    const updated = await this.store.updateDomain(tenantId, id, {
      status: 'verified',
      verifiedAt: Date.now(),
    });
    if (!updated) throw new NotFoundError('Domain not found');
    await audit(
      this.platform,
      actor,
      'directory.domain.verified',
      { type: 'domain', id },
      {
        after: updated,
      },
    );
    return updated;
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
  ): Promise<DirectoryMailbox> {
    const tenantId = await this.tenantId();
    const existing = await this.store.findMailboxByUser(tenantId, userId);
    if (existing) return existing;
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
    const primaryAddress = normaliseEmail(input.primaryAddress);
    if (!EMAIL.test(primaryAddress)) throw new UnprocessableError('Enter a valid mailbox address.');
    if (input.kind === 'user') {
      if (!input.userId) throw new UnprocessableError('A user mailbox must be linked to a user.');
      if (await this.store.findMailboxByUser(tenantId, input.userId)) {
        throw new ConflictError('That user already has a mailbox.');
      }
    }
    if (await this.store.findMailboxByAddress(tenantId, primaryAddress)) {
      throw new ConflictError('That mailbox address is already in use.');
    }
    const mailbox = await this.store.insertMailbox({
      tenantId,
      userId: input.kind === 'user' ? (input.userId ?? null) : null,
      primaryAddress,
      kind: input.kind,
      displayName: input.displayName?.trim() ? input.displayName.trim() : null,
      quotaBytes: input.quotaBytes ?? null,
    });
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
    const address = normaliseEmail(alias);
    if (!EMAIL.test(address)) throw new UnprocessableError('Enter a valid alias address.');
    if (await this.store.findMailboxByAddress(tenantId, address)) {
      throw new ConflictError('That address is already in use.');
    }
    await this.store.addAlias(mailboxId, address);
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
    const removed = await this.store.removeAlias(mailboxId, normaliseEmail(alias));
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
