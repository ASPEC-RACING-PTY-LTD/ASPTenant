import type { AuthVariables } from '@aspec/auth/hono';
import {
  ConflictError,
  ForbiddenError,
  isAppError,
  NotFoundError,
  UnprocessableError,
} from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  requireCanManageMailbox,
  requireCanTarget,
  requirePermission,
  requirePlatformPermission,
} from '../access.js';
import { requireTenantId } from '../directory/service.js';
import { READING_PANES } from '../mail/preferences.js';
import {
  INGEST_MAX_BYTES,
  OUTBOUND_KINDS,
  type SendInput,
  SMTP_SECURITY,
} from '../mail/service.js';
import { normaliseFolderName, SYSTEM_FOLDERS } from '../mail/store.js';
import { cloudflareWorkerScript } from '../mail/worker.js';
import type { Platform } from '../platform.js';
import { withSystemTenant } from '../tenancy.js';

type Env = { Variables: AuthVariables };

const sendBody = z.object({
  mailboxId: z.string().min(1),
  from: z.string().email().optional(),
  to: z.array(z.string()).max(500),
  cc: z.array(z.string()).max(500).optional(),
  bcc: z.array(z.string()).max(500).optional(),
  subject: z.string().max(998),
  text: z.string().max(5_000_000),
  html: z.string().max(10_000_000).optional(),
  inReplyTo: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).max(100).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.string().max(255).optional(),
        contentBase64: z.string(),
      }),
    )
    .max(50)
    .optional(),
  draftId: z.string().min(1).max(100).optional(),
});

const batchBody = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(500),
  action: z.enum(['read', 'unread', 'flag', 'unflag', 'move', 'delete']),
  folder: z.string().min(1).max(200).optional(),
});

const preferencesBody = z.object({
  signature: z.string().max(20_000).optional(),
  signatureOnReplies: z.boolean().optional(),
  readingPane: z.enum(READING_PANES).optional(),
  markReadOnOpen: z.boolean().optional(),
  groupByDate: z.boolean().optional(),
  autoReply: z
    .object({
      enabled: z.boolean().optional(),
      startsAt: z.number().int().positive().nullable().optional(),
      endsAt: z.number().int().positive().nullable().optional(),
      subject: z.string().trim().min(1).max(200).optional(),
      internalMessage: z.string().max(20_000).optional(),
      external: z.boolean().optional(),
      externalMessage: z.string().max(20_000).optional(),
    })
    .optional(),
});

/** The keys zod left undefined removed, for exactOptionalPropertyTypes. */
function defined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

const settingsBody = z.object({
  kind: z.enum(OUTBOUND_KINDS),
  cloudflareToken: z.string().max(400).optional(),
  clearCloudflareToken: z.boolean().optional(),
  clearSmtpPassword: z.boolean().optional(),
  smtp: z
    .object({
      host: z.string().max(253),
      port: z.coerce.number().int().min(1).max(65535),
      security: z.enum(SMTP_SECURITY),
      username: z.string().max(320).nullable().optional(),
      password: z.string().max(1024).optional(),
    })
    .optional(),
});

const patchBody = z.object({
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  folder: z.string().min(1).max(200).optional(),
});

function accountId(c: Context<Env>): string {
  const id = (c.get('auth') as { account?: { id: string } } | null | undefined)?.account?.id;
  if (!id) throw new ForbiddenError('Sign in required');
  return id;
}

const grantBody = z.object({
  mailboxId: z.string().min(1),
  read: z.boolean(),
  write: z.boolean(),
  send: z.boolean(),
});

const credentialBody = z.object({
  kind: z.enum(['service', 'mailbox']),
  name: z.string().max(120).optional(),
  mailboxId: z.string().min(1).optional(),
  grants: z.array(grantBody).max(200).optional(),
  allowedIps: z.array(z.string().max(64)).max(100).optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  password: z.string().min(12).max(1024).optional(),
});

const credentialPatchBody = z.object({
  name: z.string().max(120).optional(),
  grants: z.array(grantBody).max(200).optional(),
  allowedIps: z.array(z.string().max(64)).max(100).optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

async function json<T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new UnprocessableError('Request body must be JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new UnprocessableError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

function folderParam(value: string | undefined): string {
  const folder = normaliseFolderName(value ?? 'INBOX');
  if (!folder || folder.length > 200) throw new UnprocessableError('Unknown folder');
  return folder;
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'download';
}

/**
 * Mail, domain DNS and update endpoints. These need raw bodies (MIME, attachments)
 * larger than the JSON API's 1 MiB limit, so they are plain Hono routes.
 */
export function createMailHttp(
  platform: Platform,
  clientIp: (c: Context<Env>) => string | undefined,
): Hono<Env> {
  const app = new Hono<Env>();
  const actor = (c: Context<Env>): Actor => {
    const ip = clientIp(c);
    const userAgent = c.req.header('user-agent')?.slice(0, 200);
    return {
      id: accountId(c),
      type: 'user',
      ...(ip ? { ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
  };

  app.onError((err, c) => {
    if (isAppError(err)) {
      return c.json(
        { type: 'about:blank', title: err.message, status: err.status, detail: err.message },
        err.status as 400,
      );
    }
    platform.logger.error({ err }, 'mail route failed');
    const detail = err instanceof Error ? err.message : 'Unexpected error';
    return c.json({ type: 'about:blank', title: 'Error', status: 500, detail }, 500);
  });

  // Inbound transport (Cloudflare Worker or any MTA hook). Bearer token, no session.
  app.post('/mail/ingest', async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
    // The token identifies the tenant; delivery is limited to that tenant's mailboxes.
    const tenantId = await platform.mail.tenantForIngestToken(token);
    if (!tenantId) {
      return c.json({ accepted: false, reason: 'Invalid ingest token' }, 401);
    }
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > INGEST_MAX_BYTES) {
      return c.json({ accepted: false, reason: 'Message too large' }, 413);
    }
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength === 0 || raw.byteLength > INGEST_MAX_BYTES) {
      return c.json({ accepted: false, reason: 'Empty or oversized message' }, 413);
    }
    const to = (c.req.header('x-envelope-to') ?? '').split(',');
    const result = await withSystemTenant(platform, tenantId, () => platform.mail.ingest(raw, to));
    if (result.accepted.length === 0) {
      return c.json({ ok: false, reason: 'Unknown recipient', rejected: result.rejected }, 404);
    }
    return c.json({ ok: true, ...result });
  });

  // Webmail
  app.get('/mail/me', async (c) => {
    // Operators with mailboxes:access also get every other mailbox of the tenant.
    const mailboxes = await platform.mail.mailboxesFor(accountId(c));
    const items = await Promise.all(
      mailboxes.map(async (mailbox) => {
        await platform.mail.messages.ensureFolders(mailbox.tenantId, mailbox.id);
        const [folders, counts] = await Promise.all([
          platform.mail.messages.listFolders(mailbox.id),
          platform.mail.messages.folderCounts(mailbox.id),
        ]);
        return {
          ...mailbox,
          folders: folders.map((folder) => ({
            name: folder.name,
            specialUse: folder.specialUse,
            total: counts[folder.name]?.total ?? 0,
            unread: counts[folder.name]?.unread ?? 0,
          })),
        };
      }),
    );
    return c.json({ items });
  });

  app.get('/mail/mailboxes/:id/messages', async (c) => {
    const mailboxId = c.req.param('id');
    await platform.mail.canAccess(accountId(c), mailboxId);
    const before = c.req.query('before');
    const search = c.req.query('search')?.trim().slice(0, 200);
    const filter = c.req.query('filter');
    const items = await platform.mail.messages.list(mailboxId, folderParam(c.req.query('folder')), {
      limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 200),
      ...(before ? { before: Number(before) } : {}),
      ...(search ? { search } : {}),
      ...(filter === 'unread' || filter === 'flagged' ? { filter } : {}),
    });
    return c.json({ items });
  });

  app.post('/mail/mailboxes/:id/empty', async (c) => {
    const mailboxId = c.req.param('id');
    await platform.mail.canAccess(accountId(c), mailboxId);
    const folder = folderParam(c.req.query('folder'));
    if (folder !== 'Trash' && folder !== 'Junk') {
      throw new UnprocessableError('Only Trash and Junk can be emptied.');
    }
    return c.json({ deleted: await platform.mail.messages.emptyFolder(mailboxId, folder) });
  });

  app.post('/mail/mailboxes/:id/folders', async (c) => {
    const mailbox = await platform.mail.canAccess(accountId(c), c.req.param('id'));
    const body = await json(c, z.object({ name: z.string().min(1).max(200) }));
    await platform.mail.messages.ensureFolders(mailbox.tenantId, mailbox.id);
    return c.json(
      await platform.mail.messages.createFolder(mailbox.tenantId, mailbox.id, body.name),
      201,
    );
  });

  // Rename or delete a folder the person created. System folders stay as they are.
  const customFolder = async (mailboxId: string, name: string) => {
    const folder = await platform.mail.messages.getFolder(mailboxId, folderParam(name));
    if (!folder) throw new NotFoundError('Folder not found');
    if (folder.specialUse || SYSTEM_FOLDERS.some((item) => item.name === folder.name)) {
      throw new UnprocessableError(
        'Inbox, Drafts, Sent, Archive, Junk and Trash cannot be changed.',
      );
    }
    return folder;
  };

  app.patch('/mail/mailboxes/:id/folders', async (c) => {
    const mailbox = await platform.mail.canAccess(accountId(c), c.req.param('id'));
    const body = await json(
      c,
      z.object({ from: z.string().min(1).max(200), to: z.string().min(1).max(200) }),
    );
    const folder = await customFolder(mailbox.id, body.from);
    const target = folderParam(body.to);
    if (target === folder.name) return c.json({ ok: true });
    if (target.startsWith(`${folder.name}/`)) {
      throw new UnprocessableError('A folder cannot be moved into itself.');
    }
    if (await platform.mail.messages.getFolder(mailbox.id, target)) {
      throw new ConflictError('A folder with that name already exists.');
    }
    const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : null;
    if (parent) await platform.mail.messages.createFolder(mailbox.tenantId, mailbox.id, parent);
    await platform.mail.messages.renameFolder(mailbox.id, folder.name, target);
    return c.json({ ok: true });
  });

  app.delete('/mail/mailboxes/:id/folders', async (c) => {
    const mailbox = await platform.mail.canAccess(accountId(c), c.req.param('id'));
    const folder = await customFolder(mailbox.id, c.req.query('name') ?? '');
    // Messages go to Trash first, like Outlook, so nothing in a deleted folder is lost at once.
    const doomed = (await platform.mail.messages.listFolders(mailbox.id))
      .filter((item) => item.name === folder.name || item.name.startsWith(`${folder.name}/`))
      .sort((a, b) => b.name.length - a.name.length);
    let moved = 0;
    for (const child of doomed) {
      for (;;) {
        const batch = await platform.mail.messages.list(mailbox.id, child.name, { limit: 200 });
        if (batch.length === 0) break;
        for (const message of batch) await platform.mail.messages.move(message.id, 'Trash');
        moved += batch.length;
      }
      await platform.mail.messages.deleteFolder(mailbox.id, child.name);
    }
    return c.json({ ok: true, movedToTrash: moved });
  });

  app.get('/mail/messages/:id', async (c) => {
    const markSeen = c.req.query('markRead') !== '0';
    return c.json(await platform.mail.parsed(accountId(c), c.req.param('id'), markSeen));
  });

  // Several messages at once (the list's selection). Every id is checked like a single change.
  app.post('/mail/messages/batch', async (c) => {
    const account = accountId(c);
    const body = await json(c, batchBody);
    if (body.action === 'move' && !body.folder) throw new UnprocessableError('Choose a folder.');
    const target = body.folder ? folderParam(body.folder) : null;
    const store = platform.mail.messages;
    let changed = 0;
    for (const id of [...new Set(body.ids)]) {
      const message = await platform.mail.messageFor(account, id);
      if (body.action === 'read' || body.action === 'unread') {
        await store.setFlags(message.id, { seen: body.action === 'read' });
      } else if (body.action === 'flag' || body.action === 'unflag') {
        await store.setFlags(message.id, { flagged: body.action === 'flag' });
      } else if (body.action === 'move' && target) {
        if (target === message.folder) continue;
        if (!(await store.getFolder(message.mailboxId, target))) {
          throw new NotFoundError('Folder not found');
        }
        await store.move(message.id, target);
      } else if (body.action === 'delete') {
        if (message.folder === 'Trash') await store.delete(message.id);
        else await store.move(message.id, 'Trash');
      }
      changed += 1;
    }
    return c.json({ changed });
  });

  app.get('/mail/messages/:id/raw', async (c) => {
    const message = await platform.mail.messageFor(accountId(c), c.req.param('id'));
    const raw = await platform.mail.messages.raw(message.id);
    if (!raw) throw new NotFoundError('Message not found');
    return c.body(new Uint8Array(raw), 200, {
      'content-type': 'message/rfc822',
      'content-disposition': `attachment; filename="${safeFilename(message.subject)}.eml"`,
    });
  });

  app.get('/mail/messages/:id/attachments/:index', async (c) => {
    const item = await platform.mail.attachment(
      accountId(c),
      c.req.param('id'),
      Number(c.req.param('index')),
    );
    return c.body(new Uint8Array(item.content), 200, {
      'content-type': item.contentType,
      'content-disposition': `attachment; filename="${safeFilename(item.filename)}"`,
      'x-content-type-options': 'nosniff',
    });
  });

  app.patch('/mail/messages/:id', async (c) => {
    const message = await platform.mail.messageFor(accountId(c), c.req.param('id'));
    const body = await json(c, patchBody);
    await platform.mail.messages.setFlags(message.id, {
      ...(body.seen !== undefined ? { seen: body.seen } : {}),
      ...(body.flagged !== undefined ? { flagged: body.flagged } : {}),
    });
    if (body.folder !== undefined && normaliseFolderName(body.folder) !== message.folder) {
      await platform.mail.messages.move(message.id, body.folder);
    }
    return c.json({ ok: true });
  });

  app.delete('/mail/messages/:id', async (c) => {
    const message = await platform.mail.messageFor(accountId(c), c.req.param('id'));
    if (message.folder === 'Trash') await platform.mail.messages.delete(message.id);
    else await platform.mail.messages.move(message.id, 'Trash');
    return c.json({ ok: true });
  });

  const sendInput = (body: z.infer<typeof sendBody>): SendInput => ({
    mailboxId: body.mailboxId,
    to: body.to,
    subject: body.subject,
    text: body.text,
    ...(body.from ? { from: body.from } : {}),
    ...(body.cc ? { cc: body.cc } : {}),
    ...(body.bcc ? { bcc: body.bcc } : {}),
    ...(body.html ? { html: body.html } : {}),
    ...(body.inReplyTo ? { inReplyTo: body.inReplyTo } : {}),
    ...(body.references ? { references: body.references } : {}),
    ...(body.attachments
      ? {
          attachments: body.attachments.map((item) => ({
            filename: item.filename,
            contentBase64: item.contentBase64,
            ...(item.contentType ? { contentType: item.contentType } : {}),
          })),
        }
      : {}),
    ...(body.draftId ? { draftId: body.draftId } : {}),
  });

  app.post('/mail/send', async (c) => {
    const body = await json(c, sendBody);
    return c.json(await platform.mail.send(accountId(c), sendInput(body)), 201);
  });

  // Saves a draft in Drafts; pass draftId to replace the earlier version.
  app.put('/mail/drafts', async (c) => {
    const body = await json(c, sendBody);
    return c.json(await platform.mail.saveDraft(accountId(c), sendInput(body)));
  });

  // Address book: people, shared mailboxes and groups with an address in this organisation.
  app.get('/mail/people', async (c) => {
    await platform.mail.mailboxesFor(accountId(c));
    const query = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100);
    const [mailboxes, groups] = await Promise.all([
      platform.directory.listMailboxes(),
      platform.directory.listGroups(),
    ]);
    const people = [
      ...mailboxes.map((item) => ({
        name: item.displayName ?? item.primaryAddress,
        address: item.primaryAddress,
        kind: item.kind,
      })),
      ...groups
        .filter((item) => item.email)
        .map((item) => ({ name: item.name, address: String(item.email), kind: 'group' as const })),
    ]
      .filter(
        (item) => !query || item.name.toLowerCase().includes(query) || item.address.includes(query),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50);
    return c.json({ items: people });
  });

  // The signed-in person's mail app preferences in this organisation, including automatic replies.
  app.get('/mail/preferences', async (c) => {
    const tenantId = requireTenantId(platform);
    return c.json(await platform.mail.preferences.get(tenantId, accountId(c)));
  });

  app.put('/mail/preferences', async (c) => {
    const tenantId = requireTenantId(platform);
    const account = accountId(c);
    const body = await json(c, preferencesBody);
    const before = await platform.mail.preferences.get(tenantId, account);
    const saved = await platform.mail.preferences.save(tenantId, account, {
      ...defined({ ...body, autoReply: undefined }),
      ...(body.autoReply ? { autoReply: defined(body.autoReply) } : {}),
    });
    const reply = saved.autoReply;
    const replyChanged = JSON.stringify(before.autoReply) !== JSON.stringify(reply);
    if (replyChanged) {
      // A new or changed reply is sent again to people who already got the old one.
      const own = await platform.directory.listAccessibleMailboxes(account);
      for (const mailbox of own.filter((item) => item.userId === account)) {
        await platform.mail.preferences.forgetReplies(tenantId, mailbox.id);
      }
      await platform.audit.record({
        action: reply.enabled ? 'mail.auto_reply.updated' : 'mail.auto_reply.disabled',
        outcome: 'success',
        category: 'data',
        actor: actor(c),
        resource: { type: 'user', id: account },
        tenantId,
        changes: {
          after: {
            enabled: reply.enabled,
            startsAt: reply.startsAt,
            endsAt: reply.endsAt,
            external: reply.external,
          },
        },
      });
    }
    return c.json(saved);
  });

  // Mail administration
  app.get('/mail/settings', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const settings = await platform.mail.getSettings(`${proto}://${host}`);
    return c.json({ ...settings, workerScript: cloudflareWorkerScript(settings.ingest.url) });
  });

  app.put('/mail/settings', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(c, settingsBody);
    const saved = await platform.mail.saveSettings(
      {
        kind: body.kind,
        ...(body.cloudflareToken ? { cloudflareToken: body.cloudflareToken } : {}),
        ...(body.clearCloudflareToken ? { clearCloudflareToken: true } : {}),
        ...(body.clearSmtpPassword ? { clearSmtpPassword: true } : {}),
        ...(body.smtp
          ? {
              smtp: {
                host: body.smtp.host,
                port: body.smtp.port,
                security: body.smtp.security,
                username: body.smtp.username ?? null,
                ...(body.smtp.password ? { password: body.smtp.password } : {}),
              },
            }
          : {}),
      },
      actor(c),
    );
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const view = await platform.mail.getSettings(`${proto}://${host}`);
    return c.json({
      ...view,
      outbound: saved.outbound,
      workerScript: cloudflareWorkerScript(view.ingest.url),
    });
  });

  app.post('/mail/settings/test', async (c) => {
    const id = accountId(c);
    const tenantId = await requirePermission(platform, id, 'mail:manage');
    const body = await json(
      c,
      z.object({ to: z.string().optional(), from: z.string().optional() }),
    );
    // Send as the administrator's own mailbox, or a shared one, never someone else's.
    const mailboxes = await platform.directory.listMailboxes();
    const own = await platform.directory.store.findMailboxByUser(tenantId, id);
    const from =
      body.from ??
      own?.primaryAddress ??
      mailboxes.find((mailbox) => mailbox.kind === 'shared')?.primaryAddress ??
      mailboxes[0]?.primaryAddress;
    if (!from) throw new UnprocessableError('Create a mailbox first so the test has a sender.');
    return c.json(await platform.mail.testOutbound(body.to || undefined, from));
  });

  app.post('/mail/settings/ingest-token', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    return c.json({ token: await platform.mail.rotateIngestToken(actor(c)) });
  });

  // Turns inbound delivery off: the Worker's token stops working until a new one is made.
  app.delete('/mail/settings/ingest-token', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    await platform.mail.revokeIngestToken(actor(c));
    return c.json({ ok: true });
  });

  app.get('/mail/admin/mailboxes/:id/members', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:read');
    return c.json({ items: await platform.directory.listMailboxMembers(c.req.param('id')) });
  });

  app.post('/mail/admin/mailboxes/:id/members', async (c) => {
    const id = accountId(c);
    const tenantId = await requirePermission(platform, id, 'mail:manage');
    await requireCanManageMailbox(platform, tenantId, id, c.req.param('id'));
    const body = await json(c, z.object({ userId: z.string().min(1) }));
    await platform.directory.addMailboxMember(c.req.param('id'), body.userId, actor(c));
    return c.json({ ok: true }, 201);
  });

  app.delete('/mail/admin/mailboxes/:id/members/:userId', async (c) => {
    const id = accountId(c);
    const tenantId = await requirePermission(platform, id, 'mail:manage');
    await requireCanManageMailbox(platform, tenantId, id, c.req.param('id'));
    // Taking an owner's access away is changing the owner.
    await requireCanTarget(platform, tenantId, id, c.req.param('userId'));
    await platform.directory.removeMailboxMember(
      c.req.param('id'),
      c.req.param('userId'),
      actor(c),
    );
    return c.json({ ok: true });
  });

  // Service credentials: IMAP and SMTP logins for applications and shared mailboxes
  app.get('/mail/credentials', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:read');
    return c.json({ items: await platform.credentials.list() });
  });

  app.post('/mail/credentials', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(c, credentialBody);
    const created = await platform.credentials.create(
      {
        kind: body.kind,
        ...(body.name ? { name: body.name } : {}),
        ...(body.mailboxId ? { mailboxId: body.mailboxId } : {}),
        ...(body.grants ? { grants: body.grants } : {}),
        ...(body.allowedIps ? { allowedIps: body.allowedIps } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.password ? { password: body.password } : {}),
      },
      actor(c),
    );
    return c.json(created, 201);
  });

  app.patch('/mail/credentials/:id', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(c, credentialPatchBody);
    return c.json(
      await platform.credentials.update(
        c.req.param('id'),
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.grants ? { grants: body.grants } : {}),
          ...(body.allowedIps ? { allowedIps: body.allowedIps } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        },
        actor(c),
      ),
    );
  });

  app.post('/mail/credentials/:id/rotate', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(c, z.object({ password: z.string().min(12).max(1024).optional() }));
    const password = await platform.credentials.rotate(c.req.param('id'), actor(c), body.password);
    return c.json({ password });
  });

  app.delete('/mail/credentials/:id', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    await platform.credentials.remove(c.req.param('id'), actor(c));
    return c.json({ ok: true });
  });

  // Mail clients (IMAP and SMTP submission)
  app.get('/mail/clients', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:read');
    return c.json(await platform.mailServers.view());
  });

  app.put('/mail/clients', async (c) => {
    // Mail app listeners serve every tenant, so changing them is a platform task.
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const body = await json(
      c,
      z.object({
        enabled: z.boolean(),
        hostname: z.string().max(253),
        certMode: z.enum(['acme', 'manual']),
        acmeEmail: z.string().max(320).nullable().optional(),
        cloudflareDnsToken: z.string().max(400).optional(),
        clearCloudflareDnsToken: z.boolean().optional(),
        certPem: z.string().max(100_000).optional(),
        keyPem: z.string().max(100_000).optional(),
      }),
    );
    try {
      return c.json(
        await platform.mailServers.update(
          {
            enabled: body.enabled,
            hostname: body.hostname,
            certMode: body.certMode,
            acmeEmail: body.acmeEmail ?? null,
            ...(body.cloudflareDnsToken ? { cloudflareDnsToken: body.cloudflareDnsToken } : {}),
            ...(body.clearCloudflareDnsToken ? { clearCloudflareDnsToken: true } : {}),
            ...(body.certPem ? { certPem: body.certPem } : {}),
            ...(body.keyPem ? { keyPem: body.keyPem } : {}),
          },
          actor(c),
        ),
      );
    } catch (error) {
      if (isAppError(error)) throw error;
      throw new UnprocessableError(error instanceof Error ? error.message : String(error));
    }
  });

  app.post('/mail/clients/certificate', async (c) => {
    // Mail app listeners serve every tenant, so changing them is a platform task.
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json(await platform.mailServers.issueCertificate());
  });

  // Cloudflare integration and guided domain setup
  app.get('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:read');
    return c.json(await platform.domainSetup.status(c.req.query('check') === '1'));
  });

  app.put('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    const body = await json(c, z.object({ token: z.string().min(10).max(400) }));
    return c.json(await platform.domainSetup.connectCloudflare(body.token, actor(c)));
  });

  app.delete('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    await platform.domainSetup.disconnectCloudflare(actor(c));
    return c.json({ ok: true });
  });

  // Domain Connect: one-click DNS setup at the domain's own DNS provider.
  app.get('/integrations/domain-connect', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json(await platform.domainConnect.view());
  });

  app.put('/integrations/domain-connect', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const body = await json(
      c,
      z.object({
        providerId: z.string().min(1).max(253),
        serviceId: z.string().min(1).max(100),
        keyId: z.string().min(1).max(63),
        privateKey: z.string().max(20_000).optional(),
        generateKey: z.boolean().optional(),
        removeKey: z.boolean().optional(),
      }),
    );
    return c.json(
      await platform.domainConnect.update(
        {
          providerId: body.providerId,
          serviceId: body.serviceId,
          keyId: body.keyId,
          ...(body.privateKey ? { privateKey: body.privateKey } : {}),
          ...(body.generateKey ? { generateKey: true } : {}),
          ...(body.removeKey ? { removeKey: true } : {}),
        },
        actor(c),
      ),
    );
  });

  app.post('/domains/:id/domain-connect', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    const domain = await platform.directory.store.getDomain(
      requireTenantId(platform),
      c.req.param('id'),
    );
    if (!domain) throw new NotFoundError('Domain not found');
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    const origin = platform.publicUrl ?? `${proto}://${host}`;
    const verification = platform.directory.domainVerification(domain);
    return c.json(
      await platform.domainConnect.applyUrl(
        domain.hostname,
        { verification: verification.value },
        `${origin}/domain-connect/done`,
      ),
    );
  });

  app.get('/domains/:id/setup', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:read');
    return c.json(await platform.domainSetup.view(c.req.param('id')));
  });

  app.post('/domains/:id/verify/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    return c.json(await platform.domainSetup.verifyWithCloudflare(c.req.param('id'), actor(c)));
  });

  app.post('/domains/:id/records/apply', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    return c.json(await platform.domainSetup.applyRecords(c.req.param('id'), actor(c)));
  });

  // Domains
  app.get('/domains/:id/dns', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:read');
    return c.json(await platform.directory.domainDns(c.req.param('id')));
  });

  // Updates
  app.get('/updates', async (c) => {
    await requirePermission(platform, accountId(c), 'system:read');
    return c.json(await platform.updates.status());
  });

  app.post('/updates/check', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json(await platform.updates.check());
  });

  app.post('/updates/apply', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    try {
      const status = await platform.updates.apply();
      await platform.audit.record({
        action: 'platform.update.requested',
        outcome: 'success',
        category: 'admin',
        actor: actor(c),
        resource: { type: 'platform', id: 'updates' },
      });
      return c.json(status);
    } catch (error) {
      throw new UnprocessableError(error instanceof Error ? error.message : String(error));
    }
  });

  app.put('/updates/settings', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const body = await json(c, z.object({ autoUpdate: z.boolean() }));
    return c.json(await platform.updates.setAutoUpdate(body.autoUpdate));
  });

  return app;
}
