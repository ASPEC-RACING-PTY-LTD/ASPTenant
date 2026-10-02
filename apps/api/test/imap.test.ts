import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import selfsigned from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

const RAW = [
  'From: Alice <alice@outside.test>',
  'To: owner@example.com',
  'Subject: Multipart hello',
  'Message-ID: <mp1@outside.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body text here.',
  '--b1',
  'Content-Type: application/octet-stream; name="data.bin"',
  'Content-Disposition: attachment; filename="data.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  'AAECAw==',
  '--b1--',
  '',
].join('\r\n');

describe('IMAP and SMTP submission', () => {
  let ctx: TestContext;
  let client: ImapFlow;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cookie = await setupOwner(ctx);
    const headers = { cookie };
    await request(ctx, '/api/v1/domains', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hostname: 'example.com' }),
    });
    const users = (await (await request(ctx, '/api/v1/users', { headers })).json()) as {
      items: Array<{ id: string }>;
    };
    await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'user',
        userId: users.items[0]?.id,
        primaryAddress: 'owner@example.com',
      }),
    });
    const shared = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'shared', primaryAddress: 'help@example.com' }),
    });
    const sharedId = ((await shared.json()) as { id: string }).id;
    await request(ctx, `/api/v1/mail/admin/mailboxes/${sharedId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: users.items[0]?.id }),
    });
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keySize: 2048,
    });
    const saved = await request(ctx, '/api/v1/mail/clients', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        hostname: 'mail.example.com',
        certMode: 'manual',
        certPem: pems.cert,
        keyPem: pems.private,
      }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { running: boolean }).running).toBe(true);
    await ctx.platform.mail.ingest(Buffer.from(RAW), ['owner@example.com']);
    client = new ImapFlow({
      host: '127.0.0.1',
      port: 1993,
      secure: true,
      tls: { rejectUnauthorized: false },
      auth: { user: 'owner@example.com', pass: 'correct-horse-battery' },
      logger: false,
    });
    await client.connect();
  }, 30_000);

  afterAll(async () => {
    await client?.logout().catch(() => undefined);
    await ctx.platform.mailServers.stop();
    await destroyTestContext(ctx);
  });

  it('rejects a wrong password', async () => {
    const bad = new ImapFlow({
      host: '127.0.0.1',
      port: 1993,
      secure: true,
      tls: { rejectUnauthorized: false },
      auth: { user: 'owner@example.com', pass: 'wrong-password-123' },
      logger: false,
    });
    await expect(bad.connect()).rejects.toThrow();
  });

  it('lists folders including shared mailboxes', async () => {
    const list = await client.list();
    const paths = list.map((item) => item.path);
    expect(paths).toEqual(expect.arrayContaining(['INBOX', 'Sent', 'Drafts', 'Trash']));
    expect(paths).toContain('Shared/help@example.com/INBOX');
    expect(list.find((item) => item.path === 'Sent')?.specialUse).toBe('\\Sent');
  });

  it('fetches structure, parts and flags', async () => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const message = await client.fetchOne('1', {
        envelope: true,
        bodyStructure: true,
        flags: true,
        source: true,
        uid: true,
      });
      if (!message) throw new Error('missing message');
      expect(message.envelope?.subject).toBe('Multipart hello');
      expect(message.envelope?.from?.[0]?.address).toBe('alice@outside.test');
      expect(message.bodyStructure?.childNodes?.length).toBe(2);
      expect(message.flags?.has('\\Seen')).toBe(false);
      expect(message.source?.toString()).toContain('Body text here.');
      const part = await client.download('1', '2');
      const chunks: Buffer[] = [];
      for await (const chunk of part.content ?? []) chunks.push(chunk as Buffer);
      expect([...Buffer.concat(chunks)]).toEqual([0, 1, 2, 3]);
      await client.messageFlagsAdd('1', ['\\Seen']);
      const unseen = await client.search({ seen: false });
      expect(unseen).toEqual([]);
      await client.messageMove('1', 'Archive');
    } finally {
      lock.release();
    }
    const status = await client.status('Archive', { messages: true });
    expect(status && status.messages).toBe(1);
  });

  it('appends, creates folders and copies to shared mailboxes', async () => {
    await client.mailboxCreate('Projects/2026');
    const appended = await client.append('Projects/2026', RAW, ['\\Flagged']);
    expect(appended && appended.uid).toBe(1);
    const lock = await client.getMailboxLock('Projects/2026');
    try {
      await client.messageCopy('1', 'Shared/help@example.com/INBOX');
    } finally {
      lock.release();
    }
    const status = await client.status('Shared/help@example.com/INBOX', { messages: true });
    expect(status && status.messages).toBe(1);
  });

  it('accepts SMTP submission and enforces the sender', async () => {
    const transport = nodemailer.createTransport({
      host: '127.0.0.1',
      port: 1465,
      secure: true,
      tls: { rejectUnauthorized: false },
      auth: { user: 'owner@example.com', pass: 'correct-horse-battery' },
    });
    await transport.sendMail({
      from: 'help@example.com',
      to: 'owner@example.com',
      subject: 'Via submission',
      text: 'Sent by a mail client',
    });
    await expect(
      transport.sendMail({
        from: 'ceo@example.com',
        to: 'owner@example.com',
        subject: 'x',
        text: 'x',
      }),
    ).rejects.toThrow(/not allowed/);
    transport.close();
    const status = await client.status('INBOX', { messages: true });
    expect(status && status.messages).toBe(1);
  });
});
