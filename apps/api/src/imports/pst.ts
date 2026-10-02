import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictError, NotFoundError, UnprocessableError } from '@aspec/errors';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { PSTFile, type PSTFolder, type PSTMessage } from 'pst-extractor';
import type { DirectoryMailbox } from '../directory/index.js';
import { type Job, JobStore } from '../jobs/store.js';
import type { Platform } from '../platform.js';

export const IMPORT_KIND = 'pst-import';
export const MAX_CHUNK = 32 * 1024 * 1024;

export interface ImportData {
  mailboxId: string;
  filename: string;
  size: number;
  received: number;
  path: string;
}

export interface ImportProgress {
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  folder: string | null;
}

const EMPTY_PROGRESS: ImportProgress = {
  total: 0,
  processed: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  folder: null,
};

const FOLDER_MAP: Record<string, string> = {
  inbox: 'INBOX',
  'sent items': 'Sent',
  'sent mail': 'Sent',
  sent: 'Sent',
  'deleted items': 'Trash',
  trash: 'Trash',
  'junk email': 'Junk',
  'junk e-mail': 'Junk',
  junk: 'Junk',
  drafts: 'Drafts',
  archive: 'Archive',
};

const SKIP_CLASSES = [
  'IPM.Contact',
  'IPM.Appointment',
  'IPM.Task',
  'IPM.StickyNote',
  'IPM.Activity',
  'IPM.DistList',
];

/** Maps an Outlook folder path to an ASPECTenant folder name. */
export function mapFolderPath(parts: string[]): string {
  const clean = parts.map((part) => part.replace(/\//g, '-').trim()).filter(Boolean);
  if (clean.length === 0) return 'INBOX';
  const first = FOLDER_MAP[(clean[0] ?? '').toLowerCase()] ?? clean[0] ?? 'INBOX';
  return [first, ...clean.slice(1)].join('/');
}

function address(name: string, email: string): { name: string; address: string } | string {
  const value = email.trim();
  if (!value.includes('@'))
    return name.trim() ? `"${name.trim().replace(/"/g, '')}" <unknown@invalid>` : 'unknown@invalid';
  return name.trim() ? { name: name.trim(), address: value } : value;
}

function headerValue(headers: string, name: string): string | null {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
  return match?.[1]?.trim() || null;
}

/** Content-derived key: re-importing the same message into the same folder is a no-op. */
export function importKey(folder: string, message: PSTMessage): string {
  const parts = [
    folder,
    message.internetMessageId || '',
    String((message.clientSubmitTime ?? message.messageDeliveryTime)?.getTime() ?? ''),
    message.subject || '',
    message.senderEmailAddress || '',
  ];
  if (!message.internetMessageId) parts.push(String(message.descriptorNodeId));
  return createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

/** Rebuilds an RFC 5322 message from Outlook properties. */
export async function buildMime(
  message: PSTMessage,
  fallbackFrom: string,
  depth = 0,
): Promise<Buffer> {
  const headers = message.transportMessageHeaders || '';
  const to: ReturnType<typeof address>[] = [];
  const cc: ReturnType<typeof address>[] = [];
  const bcc: ReturnType<typeof address>[] = [];
  for (let i = 0; i < message.numberOfRecipients; i += 1) {
    const recipient = message.getRecipient(i);
    if (!recipient) continue;
    const email = recipient.smtpAddress || recipient.emailAddress || '';
    const entry = address(recipient.displayName || '', email);
    if (recipient.recipientType === 2) cc.push(entry);
    else if (recipient.recipientType === 3) bcc.push(entry);
    else to.push(entry);
  }
  const senderEmail =
    [message.senderEmailAddress, message.sentRepresentingEmailAddress].find((value) =>
      value?.includes('@'),
    ) ?? '';
  const from =
    headerValue(headers, 'From') ?? address(message.senderName || '', senderEmail || fallbackFrom);
  const attachments: { filename?: string; content: Buffer; contentType?: string; cid?: string }[] =
    [];
  for (let i = 0; i < message.numberOfAttachments; i += 1) {
    const attachment = message.getAttachment(i);
    const embedded = depth < 3 ? attachment.embeddedPSTMessage : null;
    if (embedded) {
      attachments.push({
        filename: `${(embedded.subject || 'message').replace(/[\\/:*?"<>|]/g, '_')}.eml`,
        content: await buildMime(embedded, fallbackFrom, depth + 1),
        contentType: 'message/rfc822',
      });
      continue;
    }
    const stream = attachment.fileInputStream;
    if (!stream) continue;
    const content = Buffer.alloc(attachment.filesize);
    stream.readCompletely(content);
    attachments.push({
      filename: attachment.longFilename || attachment.filename || `attachment-${i + 1}`,
      content,
      ...(attachment.mimeTag ? { contentType: attachment.mimeTag } : {}),
      ...(attachment.contentId ? { cid: attachment.contentId } : {}),
    });
  }
  const date = message.clientSubmitTime ?? message.messageDeliveryTime ?? new Date();
  const composer = new MailComposer({
    from,
    ...(to.length ? { to } : {}),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: message.subject || '',
    date,
    ...(message.internetMessageId ? { messageId: message.internetMessageId } : {}),
    ...(message.inReplyToId ? { inReplyTo: message.inReplyToId } : {}),
    text: message.body || '',
    ...(message.bodyHTML ? { html: message.bodyHTML } : {}),
    attachments,
  });
  const node = composer.compile();
  node.keepBcc = true;
  return node.build();
}

export class PstImporter {
  readonly jobs: JobStore;
  private readonly platform: Platform;
  private running = false;
  private stopped = false;

  constructor(platform: Platform) {
    this.platform = platform;
    this.jobs = new JobStore(platform.db);
  }

  private dir(): string {
    return join(this.platform.config.dataDir, 'imports');
  }

  async create(
    input: { mailboxId: string; filename: string; size: number },
    accountId: string,
  ): Promise<Job<ImportData, ImportProgress>> {
    const mailbox = await this.platform.directory.getMailbox(input.mailboxId);
    if (input.size <= 0) throw new UnprocessableError('The file is empty.');
    // Resume an unfinished upload of the same file into the same mailbox.
    const pending = (
      await this.jobs.withStatus<ImportData, ImportProgress>(IMPORT_KIND, ['uploading'])
    ).find(
      (job) =>
        job.data.mailboxId === mailbox.id &&
        job.data.filename === input.filename &&
        job.data.size === input.size,
    );
    if (pending) return pending;
    await mkdir(this.dir(), { recursive: true });
    const job = await this.jobs.create<ImportData, ImportProgress>({
      tenantId: mailbox.tenantId,
      kind: IMPORT_KIND,
      status: 'uploading',
      title: `${input.filename} to ${mailbox.primaryAddress}`,
      data: {
        mailboxId: mailbox.id,
        filename: input.filename,
        size: input.size,
        received: 0,
        path: '',
      },
      progress: EMPTY_PROGRESS,
      createdBy: accountId,
    });
    const data = { ...job.data, path: join(this.dir(), `${job.id}.pst`) };
    await this.jobs.update(job.id, { data });
    return { ...job, data };
  }

  /** Appends one upload chunk. Chunks must arrive in order; `offset` makes retries safe. */
  async chunk(id: string, offset: number, body: Buffer): Promise<Job<ImportData, ImportProgress>> {
    const job = await this.jobs.get<ImportData, ImportProgress>(id);
    if (!job || job.kind !== IMPORT_KIND) throw new NotFoundError('Import not found');
    if (job.status !== 'uploading') throw new ConflictError('This import is no longer uploading.');
    const onDisk = await stat(job.data.path)
      .then((s) => s.size)
      .catch(() => 0);
    if (offset !== onDisk) {
      throw new ConflictError(`Expected offset ${onDisk}`);
    }
    if (offset + body.length > job.data.size)
      throw new UnprocessableError('Chunk exceeds file size.');
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(job.data.path, { flags: 'a' });
      stream.on('error', reject);
      stream.end(body, () => resolve());
    });
    const received = offset + body.length;
    const done = received === job.data.size;
    await this.jobs.update(id, {
      data: { ...job.data, received },
      ...(done ? { status: 'queued' as const } : {}),
    });
    if (done) this.kick();
    return (await this.jobs.get<ImportData, ImportProgress>(id)) ?? job;
  }

  async retry(id: string): Promise<void> {
    const job = await this.jobs.get<ImportData, ImportProgress>(id);
    if (!job || job.kind !== IMPORT_KIND) throw new NotFoundError('Import not found');
    if (job.status === 'uploading' || job.status === 'running') {
      throw new ConflictError('This import is still in progress.');
    }
    const exists = await stat(job.data.path)
      .then(() => true)
      .catch(() => false);
    if (!exists) throw new ConflictError('The uploaded file was removed. Upload it again.');
    await this.jobs.update(id, { status: 'queued', error: null });
    this.kick();
  }

  async remove(id: string): Promise<void> {
    const job = await this.jobs.get<ImportData, ImportProgress>(id);
    if (!job || job.kind !== IMPORT_KIND) throw new NotFoundError('Import not found');
    if (job.status === 'running') throw new ConflictError('Wait for the import to finish.');
    await rm(job.data.path, { force: true });
    await this.jobs.delete(id);
  }

  /** Resumes queued or interrupted imports (called at startup and after uploads). */
  kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    void (async () => {
      try {
        for (;;) {
          const [next] = await this.jobs.withStatus<ImportData, ImportProgress>(IMPORT_KIND, [
            'running',
            'queued',
          ]);
          if (!next || this.stopped) break;
          await this.process(next);
        }
      } catch (error) {
        this.platform.logger.error({ err: error }, 'import loop failed');
      } finally {
        this.running = false;
      }
    })();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Waits until no import is running (tests). */
  async idle(): Promise<void> {
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  private async process(job: Job<ImportData, ImportProgress>): Promise<void> {
    await this.jobs.update(job.id, { status: 'running', error: null });
    const progress: ImportProgress = { ...EMPTY_PROGRESS };
    try {
      const mailbox = await this.platform.directory.getMailbox(job.data.mailboxId);
      const pst = new PSTFile(job.data.path);
      const root = pst.getRootFolder();
      progress.total = countMessages(root);
      let lastSave = Date.now();
      const save = async (force = false) => {
        if (force || Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await this.jobs.update(job.id, { progress });
        }
      };
      await this.walk(root, [], mailbox, progress, save);
      await this.jobs.update(job.id, {
        status:
          progress.failed > 0 && progress.imported === 0 && progress.skipped === 0
            ? 'failed'
            : 'succeeded',
        progress: { ...progress, folder: null },
        error: progress.failed > 0 ? `${progress.failed} items could not be imported.` : null,
      });
      await this.platform.audit.record({
        action: 'mail.import.completed',
        outcome: 'success',
        category: 'admin',
        actor: { id: job.createdBy ?? 'system', type: job.createdBy ? 'user' : 'system' },
        resource: { type: 'mailbox', id: mailbox.id },
        changes: { after: progress },
      });
    } catch (error) {
      await this.jobs.update(job.id, {
        status: 'failed',
        progress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async walk(
    folder: PSTFolder,
    path: string[],
    mailbox: DirectoryMailbox,
    progress: ImportProgress,
    save: (force?: boolean) => Promise<void>,
  ): Promise<void> {
    const containerClass = folder.containerClass || '';
    if (containerClass && !containerClass.startsWith('IPF.Note')) return;
    const target = mapFolderPath(path);
    if (folder.contentCount > 0) {
      progress.folder = target;
      let child = folder.getNextChild() as PSTMessage | null;
      while (child) {
        if (this.stopped) return;
        await this.importOne(child, target, mailbox, progress);
        progress.processed += 1;
        await save();
        await new Promise((resolve) => setImmediate(resolve));
        child = folder.getNextChild() as PSTMessage | null;
      }
    }
    for (const sub of folder.getSubFolders()) {
      const name = sub.displayName || 'Folder';
      // Skip the store's top container ("Top of Personal Folders" and similar).
      const nextPath = path.length === 0 && /^(top of |root - )/i.test(name) ? [] : [...path, name];
      if (
        /^(search root|spam search folder|ipm_common_views|ipm_views|finder|freebusy data)$/i.test(
          name,
        )
      )
        continue;
      await this.walk(sub, nextPath, mailbox, progress, save);
    }
  }

  private async importOne(
    message: PSTMessage,
    folder: string,
    mailbox: DirectoryMailbox,
    progress: ImportProgress,
  ): Promise<void> {
    try {
      const messageClass = message.messageClass || 'IPM.Note';
      if (SKIP_CLASSES.some((prefix) => messageClass.startsWith(prefix))) {
        progress.skipped += 1;
        return;
      }
      const key = importKey(folder, message);
      if (await this.platform.mail.messages.hasImportKey(mailbox.id, key)) {
        progress.skipped += 1;
        return;
      }
      const raw = await buildMime(message, mailbox.primaryAddress);
      const received = message.messageDeliveryTime ?? message.clientSubmitTime ?? new Date();
      await this.platform.mail.append(mailbox, folder, raw, {
        seen: message.isRead,
        draft: folder === 'Drafts',
        receivedAt: received.getTime(),
        importKey: key,
      });
      progress.imported += 1;
    } catch (error) {
      progress.failed += 1;
      this.platform.logger.warn({ err: error, folder }, 'pst message import failed');
    }
  }
}

function countMessages(folder: PSTFolder): number {
  let total = folder.contentCount;
  if (folder.hasSubfolders) for (const sub of folder.getSubFolders()) total += countMessages(sub);
  return total;
}
