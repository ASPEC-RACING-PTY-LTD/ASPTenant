import type { AuthVariables } from '@aspec/auth/hono';
import { isAppError, UnprocessableError } from '@aspec/errors';
import type { Actor } from '@aspec/users';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission, requirePlatformPermission } from '../access.js';
import { s3Target } from '../backup/index.js';
import { IMPORT_KIND, MAX_CHUNK } from '../imports/pst.js';
import type { Platform } from '../platform.js';

type Env = { Variables: AuthVariables };

async function json<T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

const s3Body = z.object({
  endpoint: z.string().max(500),
  region: z.string().max(100),
  bucket: z.string().min(1).max(255),
  prefix: z.string().max(255),
  accessKeyId: z.string().min(1).max(255),
  secretAccessKey: z.string().min(1).max(500),
  forcePathStyle: z.boolean(),
});

/** PST imports, backups and the first-run restore. */
export function createAdminHttp(
  platform: Platform,
  clientIp: (c: Context<Env>) => string | undefined,
): Hono<Env> {
  const app = new Hono<Env>();
  const accountId = (c: Context<Env>) => {
    const id = (c.get('auth') as { account?: { id: string } } | null | undefined)?.account?.id;
    if (!id) throw new UnprocessableError('Sign in required');
    return id;
  };
  const actor = (c: Context<Env>): Actor => {
    const ip = clientIp(c);
    return { id: accountId(c), type: 'user', ...(ip ? { ip } : {}) };
  };

  app.onError((err, c) => {
    if (isAppError(err)) {
      return c.json(
        { title: err.message, status: err.status, detail: err.message },
        err.status as 400,
      );
    }
    platform.logger.error({ err }, 'admin route failed');
    return c.json({ status: 500, detail: err instanceof Error ? err.message : 'Error' }, 500);
  });

  // First-run disaster recovery: restore a backup before any account exists.
  app.post('/setup/restore', async (c) => {
    const body = await json(
      c,
      z.object({
        setupCode: z.string().min(1),
        key: z.string().max(500).optional(),
        passphrase: z.string().min(1),
        s3: s3Body,
      }),
    );
    if (!platform.setupCode || body.setupCode.trim().toUpperCase() !== platform.setupCode) {
      return c.json({ detail: 'The setup code is not correct.' }, 403);
    }
    const target = s3Target({
      ...body.s3,
      prefix:
        body.s3.prefix && !body.s3.prefix.endsWith('/') ? `${body.s3.prefix}/` : body.s3.prefix,
    });
    const items = await target.list();
    const key = body.key || items.at(-1)?.key;
    if (!key) throw new UnprocessableError('No backups found in that bucket and prefix.');
    const result = await platform.backups.restore(key, { passphrase: body.passphrase, target });
    platform.setupCode = null;
    return c.json({ key, ...result, restarting: platform.backups.exitAfterRestore });
  });

  // PST imports
  app.get('/imports', async (c) => {
    await requirePermission(platform, accountId(c), 'migration:read');
    return c.json({ items: await platform.imports.jobs.list(IMPORT_KIND) });
  });

  app.post('/imports', async (c) => {
    await requirePermission(platform, accountId(c), 'migration:manage');
    const body = await json(
      c,
      z.object({
        mailboxId: z.string().min(1),
        filename: z.string().min(1).max(255),
        size: z.number().int().positive(),
      }),
    );
    return c.json(await platform.imports.create(body, accountId(c)), 201);
  });

  app.put('/imports/:id/chunk', async (c) => {
    await requirePermission(platform, accountId(c), 'migration:manage');
    const offset = Number(c.req.query('offset'));
    if (!Number.isInteger(offset) || offset < 0) throw new UnprocessableError('offset is required');
    const body = Buffer.from(await c.req.arrayBuffer());
    if (body.length === 0 || body.length > MAX_CHUNK)
      throw new UnprocessableError('Bad chunk size');
    return c.json(await platform.imports.chunk(c.req.param('id'), offset, body));
  });

  app.post('/imports/:id/retry', async (c) => {
    await requirePermission(platform, accountId(c), 'migration:manage');
    await platform.imports.retry(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.delete('/imports/:id', async (c) => {
    await requirePermission(platform, accountId(c), 'migration:manage');
    await platform.imports.remove(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Backups
  app.get('/backups', async (c) => {
    // Backups cover every tenant, so only platform operators see them.
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json({
      settings: await platform.backups.view(),
      history: await platform.backups.history(),
    });
  });

  app.put('/backups/settings', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const body = await json(
      c,
      z.object({
        enabled: z.boolean(),
        endpoint: z.string().max(500),
        region: z.string().max(100),
        bucket: z.string().max(255),
        prefix: z.string().max(255),
        accessKeyId: z.string().max(255),
        secretAccessKey: z.string().max(500).optional(),
        forcePathStyle: z.boolean(),
        passphrase: z.string().max(500).optional(),
        intervalHours: z.number().int().min(1).max(720),
        retentionCount: z.number().int().min(1).max(1000),
      }),
    );
    const { secretAccessKey, passphrase, ...rest } = body;
    return c.json(
      await platform.backups.update(
        {
          ...rest,
          ...(secretAccessKey ? { secretAccessKey } : {}),
          ...(passphrase ? { passphrase } : {}),
        },
        actor(c),
      ),
    );
  });

  app.post('/backups/test', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json(await platform.backups.test());
  });

  app.get('/backups/remote', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    return c.json({ items: await platform.backups.listRemote() });
  });

  app.post('/backups/run', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const job = await platform.backups.run('manual', actor(c));
    return c.json(job, job.status === 'failed' ? 422 : 200);
  });

  app.post('/backups/restore', async (c) => {
    await requirePlatformPermission(platform, accountId(c), 'platform:admin');
    const body = await json(c, z.object({ key: z.string().min(1), confirm: z.literal('RESTORE') }));
    const who = actor(c);
    const result = await platform.backups.restore(body.key, { actor: who });
    await platform.backups.recordRestore(body.key, result, who);
    return c.json({ ...result, restarting: platform.backups.exitAfterRestore });
  });

  return app;
}
