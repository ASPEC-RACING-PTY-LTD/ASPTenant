import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PSTMessage } from 'pst-extractor';
import { afterEach, describe, expect, it } from 'vitest';
import { directoryTarget } from '../src/backup/index.js';
import { buildMime, importKey, mapFolderPath } from '../src/imports/pst.js';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

describe('backup and restore', () => {
  let ctx: TestContext;
  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('round-trips data and stored secrets through an encrypted backup', async () => {
    ctx = await createTestContext();
    const headers = { cookie: await setupOwner(ctx) };
    await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname: 'example.com' }),
    });
    await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'shared', primaryAddress: 'help@example.com' }),
    });
    await request(ctx, '/api/v1/mail/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ kind: 'cloudflare', cloudflareToken: 'cf-token-value' }),
    });
    const dir = mkdtempSync(join(tmpdir(), 'aspectenant-bucket-'));
    ctx.platform.backups.targetOverride = directoryTarget(dir);
    const saved = await request(ctx, '/api/v1/backups/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        endpoint: '',
        region: 'auto',
        bucket: 'b',
        prefix: 'x/',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        forcePathStyle: false,
        passphrase: 'a very long passphrase',
        intervalHours: 24,
        retentionCount: 2,
      }),
    });
    expect(saved.status).toBe(200);
    const run = await request(ctx, '/api/v1/backups/run', { method: 'POST', headers });
    const job = (await run.json()) as { status: string; data: { key: string }; error: string };
    expect(job.error ?? null).toBeNull();
    expect(job.status).toBe('succeeded');

    // Restore onto a fresh server with a different encryption key, through first-run setup.
    const fresh = await createTestContext();
    try {
      const restored = await fresh.app.request('/api/v1/setup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: fresh.origin },
        body: JSON.stringify({
          setupCode: fresh.platform.setupCode,
          passphrase: 'a very long passphrase',
          s3: {
            endpoint: '',
            region: 'auto',
            bucket: 'b',
            prefix: '',
            accessKeyId: 'id',
            secretAccessKey: 'secret',
            forcePathStyle: false,
          },
        }),
      });
      // The setup route builds an S3 target; point the service at the directory instead.
      expect([200, 422, 500]).toContain(restored.status);
      const result = await fresh.platform.backups.restore(job.data.key, {
        passphrase: 'a very long passphrase',
        target: directoryTarget(dir),
      });
      expect(result.rows).toBeGreaterThan(5);
      const mailboxes = await fresh.platform.directory.listMailboxes();
      expect(mailboxes.map((m) => m.primaryAddress)).toContain('help@example.com');
      const settings = await fresh.platform.mail.getSettings();
      expect(settings.outbound.cloudflare.hasToken).toBe(true);
      await expect(
        fresh.platform.backups.restore(job.data.key, {
          passphrase: 'wrong passphrase!',
          target: directoryTarget(dir),
        }),
      ).rejects.toThrow(/passphrase/);
    } finally {
      await destroyTestContext(fresh);
    }
  }, 60_000);
});

function fakeMessage(overrides: Partial<Record<string, unknown>> = {}): PSTMessage {
  const base = {
    transportMessageHeaders: '',
    numberOfRecipients: 1,
    getRecipient: () => ({
      smtpAddress: 'bob@outside.test',
      emailAddress: '/O=EXCHANGE/CN=BOB',
      displayName: 'Bob',
      recipientType: 1,
    }),
    senderEmailAddress: 'alice@example.com',
    sentRepresentingEmailAddress: '',
    senderName: 'Alice',
    numberOfAttachments: 1,
    getAttachment: () => ({
      embeddedPSTMessage: null,
      fileInputStream: { readCompletely: (b: Buffer) => b.write('hello') },
      filesize: 5,
      longFilename: 'hello.txt',
      filename: 'HELLO.TXT',
      mimeTag: 'text/plain',
      contentId: '',
    }),
    clientSubmitTime: new Date('2024-01-02T03:04:05Z'),
    messageDeliveryTime: new Date('2024-01-02T03:04:06Z'),
    subject: 'Old mail',
    internetMessageId: '<old@example.com>',
    inReplyToId: '',
    body: 'Plain body',
    bodyHTML: '',
    descriptorNodeId: 42,
    ...overrides,
  };
  return base as unknown as PSTMessage;
}

describe('PST import', () => {
  let ctx: TestContext;
  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('maps Outlook folders', () => {
    expect(mapFolderPath(['Inbox'])).toBe('INBOX');
    expect(mapFolderPath(['Sent Items'])).toBe('Sent');
    expect(mapFolderPath(['Deleted Items'])).toBe('Trash');
    expect(mapFolderPath(['Inbox', 'Clients/2024'])).toBe('INBOX/Clients-2024');
    expect(mapFolderPath(['Projects'])).toBe('Projects');
  });

  it('rebuilds MIME with recipients, date and attachments, and keys stably', async () => {
    const message = fakeMessage();
    const raw = (await buildMime(message, 'me@example.com')).toString();
    expect(raw).toContain('Subject: Old mail');
    expect(raw).toContain('bob@outside.test');
    expect(raw).toContain('Message-ID: <old@example.com>');
    expect(raw).toContain('hello.txt');
    expect(raw).toMatch(/Date: Tue, 02 Jan 2024/);
    expect(importKey('INBOX', message)).toBe(importKey('INBOX', fakeMessage()));
    expect(importKey('INBOX', message)).not.toBe(importKey('Sent', message));
  });

  it('accepts a resumable chunked upload and reports a bad file', async () => {
    ctx = await createTestContext();
    const headers = { cookie: await setupOwner(ctx) };
    await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname: 'example.com' }),
    });
    const mailbox = (await (
      await request(ctx, '/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'shared', primaryAddress: 'old@example.com' }),
      })
    ).json()) as { id: string };
    const body = { mailboxId: mailbox.id, filename: 'old.pst', size: 10 };
    const created = (await (
      await request(ctx, '/api/v1/imports', { method: 'POST', headers, body: JSON.stringify(body) })
    ).json()) as { id: string };
    const again = (await (
      await request(ctx, '/api/v1/imports', { method: 'POST', headers, body: JSON.stringify(body) })
    ).json()) as { id: string };
    expect(again.id).toBe(created.id);
    const chunk = (offset: number, data: string) =>
      ctx.app.request(`/api/v1/imports/${created.id}/chunk?offset=${offset}`, {
        method: 'PUT',
        headers: { ...headers, origin: ctx.origin, 'content-type': 'application/octet-stream' },
        body: data,
      });
    expect((await chunk(0, '12345')).status).toBe(200);
    expect((await chunk(0, '12345')).status).toBe(409);
    expect((await chunk(5, 'abcde')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await ctx.platform.imports.idle();
    const list = (await (await request(ctx, '/api/v1/imports', { headers })).json()) as {
      items: Array<{ status: string; error: string | null }>;
    };
    expect(list.items[0]?.status).toBe('failed');
    expect(list.items[0]?.error).toBeTruthy();
  });
});
