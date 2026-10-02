import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { type AddressObject, simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { DirectoryMailbox } from '../directory/index.js';
import type { Platform } from '../platform.js';
import { type MailAddress, MessageStore, SettingsStore, type StoredMessage } from './store.js';

export const OUTBOUND_KINDS = ['none', 'cloudflare', 'smtp'] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];
export const SMTP_SECURITY = ['tls', 'starttls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

/** Cloudflare Email Sending SMTP endpoint (developers.cloudflare.com/email-service). */
export const CLOUDFLARE_SMTP = { host: 'smtp.mx.cloudflare.net', port: 465, user: 'api_token' };
export const CLOUDFLARE_MAX_BYTES = 5 * 1024 * 1024;
export const CLOUDFLARE_MAX_RECIPIENTS = 50;
export const INGEST_MAX_BYTES = 30 * 1024 * 1024;

interface StoredMailSettings {
  outbound: {
    kind: OutboundKind;
    fromOverride?: string | null;
    cloudflareToken?: string | null;
    smtp?: {
      host: string;
      port: number;
      security: SmtpSecurity;
      username: string | null;
      password: string | null;
    } | null;
  };
  ingestTokenHash?: string | null;
}

export interface MailSettingsView {
  outbound: {
    kind: OutboundKind;
    cloudflare: { hasToken: boolean };
    smtp: {
      host: string;
      port: number;
      security: SmtpSecurity;
      username: string | null;
      hasPassword: boolean;
    };
  };
  ingest: { configured: boolean; url: string };
}

export interface MailSettingsInput {
  kind: OutboundKind;
  cloudflareToken?: string;
  smtp?: {
    host: string;
    port: number;
    security: SmtpSecurity;
    username?: string | null;
    password?: string;
  };
}

export interface OutgoingAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface SendInput {
  mailboxId: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
}

const SETTINGS_KEY = 'mail';
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((item) =>
    item.value
      .filter((entry) => entry.address)
      .map((entry) => ({ address: String(entry.address).toLowerCase(), name: entry.name || null })),
  );
}

function snippetOf(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function cleanList(values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    for (const part of value.split(/[,;]/)) {
      const address = part.trim().toLowerCase();
      if (!address) continue;
      if (!EMAIL.test(address)) throw new UnprocessableError(`Invalid address: ${address}`);
      if (!out.includes(address)) out.push(address);
    }
  }
  return out;
}

export class MailService {
  readonly messages: MessageStore;
  private readonly settings: SettingsStore;
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
    this.messages = new MessageStore(platform.db);
    this.settings = new SettingsStore(platform.db);
  }

  private async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  ingestUrl(fallbackOrigin?: string): string {
    const origin = this.platform.publicUrl ?? fallbackOrigin ?? 'https://YOUR-PANEL-HOSTNAME';
    return `${origin}/api/v1/mail/ingest`;
  }

  private async load(): Promise<StoredMailSettings> {
    return (
      (await this.settings.get<StoredMailSettings>(await this.tenantId(), SETTINGS_KEY)) ?? {
        outbound: { kind: 'none' },
      }
    );
  }

  async getSettings(fallbackOrigin?: string): Promise<MailSettingsView> {
    const stored = await this.load();
    const smtp = stored.outbound.smtp;
    return {
      outbound: {
        kind: stored.outbound.kind,
        cloudflare: { hasToken: Boolean(stored.outbound.cloudflareToken) },
        smtp: {
          host: smtp?.host ?? '',
          port: smtp?.port ?? 587,
          security: smtp?.security ?? 'starttls',
          username: smtp?.username ?? null,
          hasPassword: Boolean(smtp?.password),
        },
      },
      ingest: { configured: Boolean(stored.ingestTokenHash), url: this.ingestUrl(fallbackOrigin) },
    };
  }

  async saveSettings(input: MailSettingsInput, actor: Actor): Promise<MailSettingsView> {
    const stored = await this.load();
    const secrets = this.platform.secrets;
    const outbound: StoredMailSettings['outbound'] = { ...stored.outbound, kind: input.kind };
    if (input.cloudflareToken?.trim()) {
      outbound.cloudflareToken = secrets.encrypt(input.cloudflareToken.trim());
    }
    if (input.smtp) {
      const host = input.smtp.host.trim();
      if (input.kind === 'smtp' && !host) throw new UnprocessableError('SMTP host is required.');
      outbound.smtp = {
        host,
        port: input.smtp.port,
        security: input.smtp.security,
        username: input.smtp.username?.trim() || null,
        password: input.smtp.password
          ? secrets.encrypt(input.smtp.password)
          : (stored.outbound.smtp?.password ?? null),
      };
    }
    if (input.kind === 'cloudflare' && !outbound.cloudflareToken) {
      throw new UnprocessableError('Enter a Cloudflare API token with Email Sending: Edit.');
    }
    await this.settings.set(await this.tenantId(), SETTINGS_KEY, { ...stored, outbound });
    await this.platform.audit.record({
      action: 'mail.settings.updated',
      outcome: 'success',
      category: 'admin',
      actor,
      resource: { type: 'mail-settings', id: SETTINGS_KEY },
      changes: { after: { kind: input.kind } },
    });
    return this.getSettings();
  }

  async rotateIngestToken(actor: Actor): Promise<string> {
    const token = `ati_${randomBytes(32).toString('base64url')}`;
    const stored = await this.load();
    await this.settings.set(await this.tenantId(), SETTINGS_KEY, {
      ...stored,
      ingestTokenHash: sha256(token),
    });
    await this.platform.audit.record({
      action: 'mail.ingest_token.rotated',
      outcome: 'success',
      category: 'security',
      actor,
      resource: { type: 'mail-settings', id: SETTINGS_KEY },
    });
    return token;
  }

  async checkIngestToken(token: string | null): Promise<boolean> {
    if (!token) return false;
    const stored = await this.load();
    if (!stored.ingestTokenHash) return false;
    const a = Buffer.from(sha256(token), 'hex');
    const b = Buffer.from(stored.ingestTokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async transport(): Promise<{
    kind: OutboundKind;
    transporter: nodemailer.Transporter | null;
  }> {
    const stored = await this.load();
    const { kind } = stored.outbound;
    const secrets = this.platform.secrets;
    if (kind === 'cloudflare' && stored.outbound.cloudflareToken) {
      return {
        kind,
        transporter: nodemailer.createTransport({
          host: CLOUDFLARE_SMTP.host,
          port: CLOUDFLARE_SMTP.port,
          secure: true,
          auth: {
            user: CLOUDFLARE_SMTP.user,
            pass: secrets.decrypt(stored.outbound.cloudflareToken),
          },
        }),
      };
    }
    if (kind === 'smtp' && stored.outbound.smtp?.host) {
      const smtp = stored.outbound.smtp;
      return {
        kind,
        transporter: nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.security === 'tls',
          requireTLS: smtp.security === 'starttls',
          ignoreTLS: smtp.security === 'none',
          ...(smtp.username
            ? {
                auth: {
                  user: smtp.username,
                  pass: smtp.password ? secrets.decrypt(smtp.password) : '',
                },
              }
            : {}),
        }),
      };
    }
    return { kind: 'none', transporter: null };
  }

  /** Verifies the outbound connection and optionally sends a test message. */
  async testOutbound(to: string | undefined, fromAddress: string): Promise<{ detail: string }> {
    const { kind, transporter } = await this.transport();
    if (!transporter) throw new UnprocessableError('Outbound sending is not configured.');
    try {
      await transporter.verify();
      if (to) {
        const recipient = cleanList([to])[0];
        if (!recipient) throw new UnprocessableError('Enter a test recipient.');
        await transporter.sendMail({
          from: fromAddress,
          to: recipient,
          subject: 'ASPECTenant test message',
          text: `This message confirms that ASPECTenant can send mail through the ${kind} transport.`,
        });
        return { detail: `Connected and sent a test message to ${recipient}.` };
      }
      return { detail: 'Connected and authenticated.' };
    } catch (error) {
      if (error instanceof UnprocessableError) throw error;
      throw new UnprocessableError(
        `Outbound test failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      transporter.close();
    }
  }

  /** Resolves a recipient address to mailboxes (direct, alias or distribution group). */
  async resolveRecipient(address: string): Promise<DirectoryMailbox[]> {
    const directory = this.platform.directory;
    const mailbox = await directory.findMailboxByAddress(address);
    if (mailbox) return [mailbox];
    const group = await directory.findGroupByEmail(address);
    if (!group) return [];
    const members = await directory.listGroupMembers(group.id);
    const tenantId = await this.tenantId();
    const found = await Promise.all(
      members.map((member) => directory.store.findMailboxByUser(tenantId, member.userId)),
    );
    return found.filter((item): item is DirectoryMailbox => item !== null);
  }

  private async deliver(
    raw: Buffer,
    mailboxes: DirectoryMailbox[],
    folder: string,
    seen: boolean,
  ): Promise<StoredMessage[]> {
    const parsed = await simpleParser(raw, { skipHtmlToText: false });
    const from = addresses(parsed.from)[0] ?? { address: 'unknown', name: null };
    const tenantId = await this.tenantId();
    const stored: StoredMessage[] = [];
    const seenIds = new Set<string>();
    for (const mailbox of mailboxes) {
      if (seenIds.has(mailbox.id)) continue;
      seenIds.add(mailbox.id);
      if (
        folder === 'INBOX' &&
        parsed.messageId &&
        (await this.messages.exists(mailbox.id, parsed.messageId))
      ) {
        continue;
      }
      stored.push(
        await this.messages.insert({
          tenantId,
          mailboxId: mailbox.id,
          folder,
          messageId: parsed.messageId ?? null,
          subject: parsed.subject ?? '(no subject)',
          from,
          to: addresses(parsed.to),
          cc: addresses(parsed.cc),
          sentAt: parsed.date ? parsed.date.getTime() : null,
          seen,
          flagged: false,
          hasAttachments: parsed.attachments.length > 0,
          snippet: snippetOf(parsed.text),
          raw,
        }),
      );
    }
    return stored;
  }

  /** Inbound entry point used by the Cloudflare Worker or any other inbound transport. */
  async ingest(
    raw: Buffer,
    envelopeTo: string[],
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    const accepted: string[] = [];
    const rejected: string[] = [];
    const targets: DirectoryMailbox[] = [];
    for (const recipient of envelopeTo) {
      const address = recipient.trim().toLowerCase();
      if (!address) continue;
      const found = await this.resolveRecipient(address);
      if (found.length === 0) rejected.push(address);
      else {
        accepted.push(address);
        targets.push(...found);
      }
    }
    if (targets.length > 0) await this.deliver(raw, targets, 'INBOX', false);
    return { accepted, rejected };
  }

  async canAccess(accountId: string, mailboxId: string): Promise<DirectoryMailbox> {
    const mailboxes = await this.platform.directory.listAccessibleMailboxes(accountId);
    const mailbox = mailboxes.find((item) => item.id === mailboxId);
    if (!mailbox) throw new ForbiddenError('You do not have access to this mailbox.');
    return mailbox;
  }

  async messageFor(accountId: string, messageId: string): Promise<StoredMessage> {
    const message = await this.messages.get(messageId);
    if (!message) throw new NotFoundError('Message not found');
    await this.canAccess(accountId, message.mailboxId);
    return message;
  }

  async send(accountId: string, input: SendInput): Promise<StoredMessage> {
    const mailbox = await this.canAccess(accountId, input.mailboxId);
    const fromAddress = (input.from ?? mailbox.primaryAddress).toLowerCase();
    if (fromAddress !== mailbox.primaryAddress && !mailbox.aliases.includes(fromAddress)) {
      throw new ForbiddenError('You can only send from this mailbox address or its aliases.');
    }
    const to = cleanList(input.to);
    const cc = cleanList(input.cc);
    const bcc = cleanList(input.bcc);
    const all = [...new Set([...to, ...cc, ...bcc])];
    if (all.length === 0) throw new UnprocessableError('Add at least one recipient.');

    const composer = new MailComposer({
      from: mailbox.displayName ? { name: mailbox.displayName, address: fromAddress } : fromAddress,
      to,
      cc,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      attachments: (input.attachments ?? []).map((item) => ({
        filename: item.filename,
        content: Buffer.from(item.contentBase64, 'base64'),
        ...(item.contentType ? { contentType: item.contentType } : {}),
      })),
    });
    const raw = await composer.compile().build();

    await this.dispatch(raw, fromAddress, all);
    const [sent] = await this.deliver(raw, [mailbox], 'Sent', true);
    if (!sent) throw new Error('Sent copy was not stored');
    return sent;
  }

  /** Every address the account may send as (own and delegated mailboxes, with aliases). */
  async sendableAddresses(accountId: string): Promise<Map<string, DirectoryMailbox>> {
    const out = new Map<string, DirectoryMailbox>();
    for (const mailbox of await this.platform.directory.listAccessibleMailboxes(accountId)) {
      out.set(mailbox.primaryAddress, mailbox);
      for (const alias of mailbox.aliases) out.set(alias, mailbox);
    }
    return out;
  }

  /**
   * Delivers a finished MIME message: local recipients go straight into their
   * mailboxes, everyone else through the configured outbound transport.
   */
  async dispatch(raw: Buffer, fromAddress: string, recipients: string[]): Promise<void> {
    const all = cleanList(recipients);
    if (all.length === 0) throw new UnprocessableError('Add at least one recipient.');
    const local: DirectoryMailbox[] = [];
    const external: string[] = [];
    for (const recipient of all) {
      const found = await this.resolveRecipient(recipient);
      if (found.length > 0) local.push(...found);
      else if (await this.platform.directory.isOwnedDomain(recipient)) {
        throw new UnprocessableError(`${recipient} does not exist in this organisation.`);
      } else external.push(recipient);
    }

    if (external.length > 0) {
      const { kind, transporter } = await this.transport();
      if (!transporter) {
        throw new ConflictError(
          'Outbound sending is not configured. An administrator can set it up under Mail settings.',
        );
      }
      if (kind === 'cloudflare') {
        if (raw.byteLength > CLOUDFLARE_MAX_BYTES) {
          throw new UnprocessableError(
            'Cloudflare Email Sending accepts messages up to 5 MiB. Remove attachments or use an SMTP relay.',
          );
        }
        if (external.length > CLOUDFLARE_MAX_RECIPIENTS) {
          throw new UnprocessableError('Cloudflare Email Sending accepts at most 50 recipients.');
        }
      }
      try {
        await transporter.sendMail({ envelope: { from: fromAddress, to: external }, raw });
      } catch (error) {
        throw new UnprocessableError(
          `The outbound transport refused the message: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        transporter.close();
      }
    }
    if (local.length > 0) await this.deliver(raw, local, 'INBOX', false);
  }

  /** Stores an existing MIME message in a folder (IMAP APPEND, imports). */
  async append(
    mailbox: DirectoryMailbox,
    folder: string,
    raw: Buffer,
    options: {
      seen?: boolean;
      flagged?: boolean;
      answered?: boolean;
      draft?: boolean;
      receivedAt?: number;
      importKey?: string;
    } = {},
  ): Promise<StoredMessage> {
    const parsed = await simpleParser(raw);
    return this.messages.insert({
      tenantId: mailbox.tenantId,
      mailboxId: mailbox.id,
      folder,
      messageId: parsed.messageId ?? null,
      subject: parsed.subject ?? '(no subject)',
      from: addresses(parsed.from)[0] ?? { address: 'unknown', name: null },
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      sentAt: parsed.date ? parsed.date.getTime() : null,
      receivedAt: options.receivedAt ?? Date.now(),
      seen: options.seen ?? false,
      flagged: options.flagged ?? false,
      answered: options.answered ?? false,
      draft: options.draft ?? false,
      hasAttachments: parsed.attachments.length > 0,
      snippet: snippetOf(parsed.text),
      importKey: options.importKey ?? null,
      raw,
    });
  }

  async parsed(accountId: string, messageId: string) {
    const message = await this.messageFor(accountId, messageId);
    const raw = await this.messages.raw(messageId);
    if (!raw) throw new NotFoundError('Message not found');
    const parsed = await simpleParser(raw);
    if (!message.seen) await this.messages.setFlags(messageId, { seen: true });
    const references = parsed.references
      ? Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references]
      : [];
    return {
      ...message,
      seen: true,
      replyTo: addresses(parsed.replyTo),
      references,
      text: parsed.text ?? '',
      html: typeof parsed.html === 'string' ? parsed.html : null,
      attachments: parsed.attachments.map((item, index) => ({
        index,
        filename: item.filename ?? `attachment-${index + 1}`,
        contentType: item.contentType,
        size: item.size,
      })),
    };
  }

  async attachment(accountId: string, messageId: string, index: number) {
    await this.messageFor(accountId, messageId);
    const raw = await this.messages.raw(messageId);
    if (!raw) throw new NotFoundError('Message not found');
    const parsed = await simpleParser(raw);
    const item = parsed.attachments[index];
    if (!item) throw new NotFoundError('Attachment not found');
    return {
      filename: item.filename ?? `attachment-${index + 1}`,
      contentType: item.contentType || 'application/octet-stream',
      content: item.content,
    };
  }
}
