import { UnprocessableError } from '@aspec/errors';
import type { SettingsStore } from './store.js';

/** How long one sender is left alone after an automatic reply, like Outlook (once per sender). */
export const AUTO_REPLY_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;
/** Senders remembered per mailbox for the interval above. */
const AUTO_REPLY_MEMORY = 2000;

export const READING_PANES = ['right', 'bottom', 'off'] as const;
export type ReadingPane = (typeof READING_PANES)[number];

export interface AutoReply {
  enabled: boolean;
  /** Optional window; outside it no replies are sent. Epoch milliseconds. */
  startsAt: number | null;
  endsAt: number | null;
  subject: string;
  /** Reply for senders in this organisation (its verified domains). */
  internalMessage: string;
  /** Also reply to senders outside the organisation. */
  external: boolean;
  externalMessage: string;
}

/** Per person, per organisation mail app preferences. */
export interface MailPreferences {
  signature: string;
  /** Add the signature to replies and forwards too, not only new messages. */
  signatureOnReplies: boolean;
  readingPane: ReadingPane;
  /** Mark a message read when it is opened in the reading pane. */
  markReadOnOpen: boolean;
  /** Group the list by Today, Yesterday, This week and older. */
  groupByDate: boolean;
  autoReply: AutoReply;
}

export const DEFAULT_PREFERENCES: MailPreferences = {
  signature: '',
  signatureOnReplies: false,
  readingPane: 'right',
  markReadOnOpen: true,
  groupByDate: true,
  autoReply: {
    enabled: false,
    startsAt: null,
    endsAt: null,
    subject: 'Automatic reply',
    internalMessage: '',
    external: false,
    externalMessage: '',
  },
};

const preferencesKey = (accountId: string) => `mail-preferences:${accountId}`;
const repliedKey = (mailboxId: string) => `mail-auto-replied:${mailboxId}`;

export function autoReplyActive(reply: AutoReply, now = Date.now()): boolean {
  if (!reply.enabled) return false;
  if (reply.startsAt !== null && now < reply.startsAt) return false;
  if (reply.endsAt !== null && now >= reply.endsAt) return false;
  return true;
}

export class MailPreferencesStore {
  private readonly settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async get(tenantId: string, accountId: string): Promise<MailPreferences> {
    const saved = await this.settings.get<Partial<MailPreferences>>(
      tenantId,
      preferencesKey(accountId),
    );
    return {
      ...DEFAULT_PREFERENCES,
      ...(saved ?? {}),
      autoReply: { ...DEFAULT_PREFERENCES.autoReply, ...(saved?.autoReply ?? {}) },
    };
  }

  async save(
    tenantId: string,
    accountId: string,
    patch: Partial<Omit<MailPreferences, 'autoReply'>> & { autoReply?: Partial<AutoReply> },
  ): Promise<MailPreferences> {
    const current = await this.get(tenantId, accountId);
    const next: MailPreferences = {
      ...current,
      ...patch,
      autoReply: { ...current.autoReply, ...(patch.autoReply ?? {}) },
    };
    const reply = next.autoReply;
    if (reply.startsAt !== null && reply.endsAt !== null && reply.endsAt <= reply.startsAt) {
      throw new UnprocessableError('The automatic reply must end after it starts.');
    }
    if (reply.enabled && !reply.internalMessage.trim() && !reply.externalMessage.trim()) {
      throw new UnprocessableError('Write the automatic reply before turning it on.');
    }
    await this.settings.set(tenantId, preferencesKey(accountId), next);
    return next;
  }

  /**
   * Records that the mailbox replied to the sender now. Returns false when it already did within
   * the interval, so each sender gets at most one automatic reply per interval.
   */
  async claimReply(tenantId: string, mailboxId: string, sender: string, now = Date.now()) {
    const replied =
      (await this.settings.get<Record<string, number>>(tenantId, repliedKey(mailboxId))) ?? {};
    const last = replied[sender];
    if (last !== undefined && now - last < AUTO_REPLY_INTERVAL_MS) return false;
    const kept = Object.entries(replied)
      .filter(([, at]) => now - at < AUTO_REPLY_INTERVAL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, AUTO_REPLY_MEMORY - 1);
    await this.settings.set(tenantId, repliedKey(mailboxId), {
      ...Object.fromEntries(kept),
      [sender]: now,
    });
    return true;
  }

  /** Turning the reply off or changing it starts over, so everyone is told again. */
  async forgetReplies(tenantId: string, mailboxId: string): Promise<void> {
    await this.settings.set(tenantId, repliedKey(mailboxId), {});
  }
}
