import type { AuthVariables } from '@aspec/auth/hono';
import { ForbiddenError, isAppError, NotFoundError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../access.js';
import { INGEST_MAX_BYTES, OUTBOUND_KINDS, SMTP_SECURITY } from '../mail/service.js';
import { normaliseFolderName } from '../mail/store.js';
import { cloudflareWorkerScript } from '../mail/worker.js';
import type { Platform } from '../platform.js';

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
});

const settingsBody = z.object({
  kind: z.enum(OUTBOUND_KINDS),
  cloudflareToken: z.string().max(400).optional(),
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
    if (!(await platform.mail.checkIngestToken(token))) {
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
    const result = await platform.mail.ingest(raw, to);
    if (result.accepted.length === 0) {
      return c.json({ ok: false, reason: 'Unknown recipient', rejected: result.rejected }, 404);
    }
    return c.json({ ok: true, ...result });
  });

  // Webmail
  app.get('/mail/me', async (c) => {
    const mailboxes = await platform.directory.listAccessibleMailboxes(accountId(c));
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
    const items = await platform.mail.messages.list(mailboxId, folderParam(c.req.query('folder')), {
      limit: Math.min(Number(c.req.query('limit') ?? 50) || 50, 200),
      ...(before ? { before: Number(before) } : {}),
      ...(search ? { search } : {}),
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

  app.get('/mail/messages/:id', async (c) => {
    return c.json(await platform.mail.parsed(accountId(c), c.req.param('id')));
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

  app.post('/mail/send', async (c) => {
    const body = await json(c, sendBody);
    const sent = await platform.mail.send(accountId(c), {
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
    });
    return c.json(sent, 201);
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
    await requirePermission(platform, id, 'mail:manage');
    const body = await json(
      c,
      z.object({ to: z.string().optional(), from: z.string().optional() }),
    );
    const mailboxes = await platform.directory.listMailboxes();
    const from = body.from ?? mailboxes[0]?.primaryAddress;
    if (!from) throw new UnprocessableError('Create a mailbox first so the test has a sender.');
    return c.json(await platform.mail.testOutbound(body.to || undefined, from));
  });

  app.post('/mail/settings/ingest-token', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    return c.json({ token: await platform.mail.rotateIngestToken(actor(c)) });
  });

  app.get('/mail/admin/mailboxes/:id/members', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:read');
    return c.json({ items: await platform.directory.listMailboxMembers(c.req.param('id')) });
  });

  app.post('/mail/admin/mailboxes/:id/members', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(c, z.object({ userId: z.string().min(1) }));
    await platform.directory.addMailboxMember(c.req.param('id'), body.userId, actor(c));
    return c.json({ ok: true }, 201);
  });

  app.delete('/mail/admin/mailboxes/:id/members/:userId', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    await platform.directory.removeMailboxMember(
      c.req.param('id'),
      c.req.param('userId'),
      actor(c),
    );
    return c.json({ ok: true });
  });

  // Mail clients (IMAP and SMTP submission)
  app.get('/mail/clients', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    return c.json(await platform.mailServers.view());
  });

  app.put('/mail/clients', async (c) => {
    await requirePermission(platform, accountId(c), 'mail:manage');
    const body = await json(
      c,
      z.object({
        enabled: z.boolean(),
        hostname: z.string().max(253),
        certMode: z.enum(['acme', 'manual']),
        acmeEmail: z.string().max(320).nullable().optional(),
        cloudflareDnsToken: z.string().max(400).optional(),
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
    await requirePermission(platform, accountId(c), 'mail:manage');
    return c.json(await platform.mailServers.issueCertificate());
  });

  // Cloudflare integration and guided domain setup
  app.get('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:read');
    return c.json(await platform.domainSetup.status());
  });

  app.put('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    const body = await json(c, z.object({ token: z.string().min(10).max(400) }));
    return c.json(await platform.domainSetup.connectCloudflare(body.token, actor(c)));
  });

  app.delete('/integrations/cloudflare', async (c) => {
    await requirePermission(platform, accountId(c), 'domains:manage');
    await platform.domainSetup.disconnectCloudflare();
    return c.json({ ok: true });
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
    await requirePermission(platform, accountId(c), 'platform:admin');
    return c.json(await platform.updates.check());
  });

  app.post('/updates/apply', async (c) => {
    await requirePermission(platform, accountId(c), 'platform:admin');
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
    await requirePermission(platform, accountId(c), 'platform:admin');
    const body = await json(c, z.object({ autoUpdate: z.boolean() }));
    return c.json(await platform.updates.setAutoUpdate(body.autoUpdate));
  });

  return app;
}
