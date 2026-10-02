import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  request,
  setupOwner,
  type TestContext,
} from './helpers.js';

const RAW = [
  'From: Alice <alice@outside.test>',
  'To: team@example.com',
  'Subject: Quarterly numbers',
  'Message-ID: <q1@outside.test>',
  'Date: Thu, 01 Oct 2026 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Numbers attached soon.',
  '',
].join('\r\n');

describe('mail', () => {
  let ctx: TestContext;

  afterEach(async () => {
    if (ctx) await destroyTestContext(ctx);
  });

  it('ingests, delivers to groups, reads and sends locally', async () => {
    ctx = await createTestContext();
    const cookie = await setupOwner(ctx);
    const headers = { cookie };

    expect(
      (
        await request(ctx, '/api/v1/domains', {
          method: 'POST',
          headers,
          body: JSON.stringify({ hostname: 'example.com' }),
        })
      ).status,
    ).toBe(201);

    const users = (await (await request(ctx, '/api/v1/users', { headers })).json()) as {
      items: Array<{ id: string }>;
    };
    const ownerId = users.items[0]?.id ?? '';
    const mailbox = await request(ctx, '/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'user', userId: ownerId, primaryAddress: 'owner@example.com' }),
    });
    expect(mailbox.status).toBe(201);
    const mailboxId = ((await mailbox.json()) as { id: string }).id;

    const group = await request(ctx, '/api/v1/groups', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Team', kind: 'distribution', email: 'team@example.com' }),
    });
    expect(group.status).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    await request(ctx, `/api/v1/groups/${groupId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: ownerId }),
    });

    const ingestNoToken = await request(ctx, '/api/v1/mail/ingest', {
      method: 'POST',
      body: RAW,
      headers: { 'content-type': 'message/rfc822', 'x-envelope-to': 'team@example.com' },
    });
    expect(ingestNoToken.status).toBe(401);

    const tokenResponse = await request(ctx, '/api/v1/mail/settings/ingest-token', {
      method: 'POST',
      headers,
    });
    const { token } = (await tokenResponse.json()) as { token: string };

    const unknown = await request(ctx, '/api/v1/mail/ingest', {
      method: 'POST',
      body: RAW,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'message/rfc822',
        'x-envelope-to': 'nobody@example.com',
      },
    });
    expect(unknown.status).toBe(404);

    const ingest = await request(ctx, '/api/v1/mail/ingest', {
      method: 'POST',
      body: RAW,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'message/rfc822',
        'x-envelope-to': 'team@example.com',
      },
    });
    expect(ingest.status).toBe(200);

    const me = (await (await request(ctx, '/api/v1/mail/me', { headers })).json()) as {
      items: Array<{ id: string; folders: Array<{ name: string; unread: number }> }>;
    };
    expect(me.items[0]?.folders.find((folder) => folder.name === 'INBOX')?.unread).toBe(1);

    const list = (await (
      await request(ctx, `/api/v1/mail/mailboxes/${mailboxId}/messages?folder=INBOX`, { headers })
    ).json()) as { items: Array<{ id: string; subject: string }> };
    expect(list.items[0]?.subject).toBe('Quarterly numbers');

    const message = (await (
      await request(ctx, `/api/v1/mail/messages/${list.items[0]?.id}`, { headers })
    ).json()) as { text: string; seen: boolean };
    expect(message.text).toContain('Numbers attached soon.');
    expect(message.seen).toBe(true);

    const external = await request(ctx, '/api/v1/mail/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mailboxId,
        to: ['someone@outside.test'],
        subject: 'Hello',
        text: 'Hi',
      }),
    });
    expect(external.status).toBe(409);

    const local = await request(ctx, '/api/v1/mail/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mailboxId,
        to: ['owner@example.com'],
        subject: 'Note to self',
        text: 'Remember the numbers.',
        attachments: [{ filename: 'n.txt', contentBase64: Buffer.from('42').toString('base64') }],
      }),
    });
    expect(local.status).toBe(201);
    const sent = (await (
      await request(ctx, `/api/v1/mail/mailboxes/${mailboxId}/messages?folder=Sent`, { headers })
    ).json()) as { items: Array<{ id: string; hasAttachments: boolean }> };
    expect(sent.items[0]?.hasAttachments).toBe(true);

    const attachment = await request(
      ctx,
      `/api/v1/mail/messages/${sent.items[0]?.id}/attachments/0`,
      { headers },
    );
    expect(await attachment.text()).toBe('42');

    const saved = await request(ctx, '/api/v1/mail/settings', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ kind: 'cloudflare', cloudflareToken: 'cf-secret-token' }),
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as {
      outbound: { kind: string; cloudflare: { hasToken: boolean } };
      workerScript: string;
    };
    expect(savedBody.outbound.cloudflare.hasToken).toBe(true);
    expect(savedBody.workerScript).toContain('/api/v1/mail/ingest');
    expect(JSON.stringify(savedBody)).not.toContain('cf-secret-token');
  });
});
